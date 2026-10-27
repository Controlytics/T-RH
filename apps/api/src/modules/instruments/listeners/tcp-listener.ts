import net from 'node:net';
import { LineFramer } from './line-framer.js';
import { resolveInstrumentByToken, reauthorizeConnection, type IngestIdentity } from '../ingest-auth.js';
import { judgeConnection, recordCertificateRefusal } from '../device-certificate.js';
import { ingestPayload } from '../ingest-core.js';
import { logger } from '../../../lib/logger.js';

/**
 * Raw-TCP ingest listener — for instruments that speak neither HTTP nor MQTT.
 *
 * Protocol (design spec §5.1): the FIRST line must be `{"token":"..."}`; every
 * line after it is one reading, handed to `ingestPayload` with
 * `transport: 'tcp'`. Authentication is in-band because a byte stream has no
 * headers — there is nowhere else to put it.
 *
 * There is NO FRAMEWORK AROUND THIS. Fastify supplies the HTTP route's body
 * cap, rate limit and connection handling; here every one of those defences is
 * written by hand, and each is load-bearing:
 *
 *   - an ABSOLUTE deadline on an unauthenticated socket, so a scanner cannot
 *     hold connections for free;
 *   - an idle timeout after authentication, so a device that unplugs its
 *     ethernet does not leak a slot until the OS notices;
 *   - a per-line byte cap, which is what keeps a gateway BATCH under
 *     Postgres's bind-parameter ceiling (see below);
 *   - a global concurrent-connection cap, refusing rather than accepting
 *     unboundedly;
 *   - `error` handled on EVERY socket. An unhandled `ECONNRESET` from a device
 *     losing power is an unhandled 'error' event on an EventEmitter, which
 *     terminates the process — the single most likely way this listener causes
 *     an outage.
 */

/**
 * Matches the HTTP route's `BODY_LIMIT_BYTES` (`ingest-routes.ts`) and for the
 * same reason, which is NOT merely "big enough for a reading". `MAX_KEYS` in
 * `ingest-core.ts` bounds the FLAT path only; on the BATCH path this size cap
 * is the only thing standing between a device and `writeBatch`'s bind ceiling
 * (5 params per reading against Postgres's 65535 per statement = 13_107
 * readings; the smallest a reading can be inside a device block is `"k":1,` =
 * 6 bytes, so 65_536 bytes buys at most ~10_922). Raise it and you have to cap
 * the batch path's reading count at the same time.
 */
const DEFAULT_MAX_LINE_BYTES = 65_536;

/** A device that has said nothing at all within this window is not a device. */
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;

/** Post-auth inactivity. Generous — a slow logger may report every few minutes. */
const DEFAULT_IDLE_TIMEOUT_MS = 15 * 60 * 1000;

/** Slots, not bandwidth. Well beyond any real instrument count on one site. */
const DEFAULT_MAX_CONNECTIONS = 200;

/**
 * Per CONNECTION, matching the WS listener's and the HTTP route's 600/min
 * (audit 2026-10-03, INGEST-10). This was the one transport with no rate cap:
 * a line costs a JSON parse and a write — or, when it cannot be parsed, a
 * dead-letter row of up to 4 KB — so an authenticated logger with corrupt
 * firmware could stream garbage at wire speed and grow `dead_letters` at
 * ~270 rows a second with nothing to stop it. Counted on LINES, the unit the
 * core is handed, and before the queue, so a flood is refused before it costs
 * anything. Pre-auth lines count too: the window belongs to the socket.
 */
const DEFAULT_MAX_MESSAGES_PER_WINDOW = 600;
const DEFAULT_RATE_WINDOW_MS = 60_000;

export interface TcpListenerOptions {
  authTimeoutMs?: number;
  idleTimeoutMs?: number;
  maxLineBytes?: number;
  maxConnections?: number;
  maxMessagesPerWindow?: number;
  rateWindowMs?: number;
  /** Injected in tests to keep the run quiet; defaults to console. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

export interface TcpListenerHandle {
  close(): Promise<void>;
  port: number;
}

/** The first line's shape. Anything else is not a client of this protocol. */
function readToken(line: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const t = (parsed as Record<string, unknown>).token;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

/**
 * Starts unconditionally on the port it is handed. The `INGEST_TCP_PORT` gate
 * lives in `app.ts`, not here, so a test can start one on port 0 without
 * mutating `process.env`.
 */
export async function startTcpListener(
  port: number,
  opts: TcpListenerOptions = {},
): Promise<TcpListenerHandle> {
  const authTimeoutMs = opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES;
  const maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const maxMessages = opts.maxMessagesPerWindow ?? DEFAULT_MAX_MESSAGES_PER_WINDOW;
  const rateWindowMs = opts.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const log = opts.log ?? ((msg: string, meta?: Record<string, unknown>) =>
    logger.warn(`[ingest:tcp] ${msg}`, meta ?? ''));

  // Tracked so `close()` can destroy them. `server.close()` alone stops
  // ACCEPTING but waits for open connections to end on their own, which for a
  // long-lived telemetry socket is never — the process would hang on shutdown.
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    // Counted at accept time, decremented in 'close' ONLY. 'close' fires
    // exactly once per socket however it died; decrementing in 'end' or
    // 'error' too would double-count and the cap would drift shut.
    if (sockets.size >= maxConnections) {
      log('connection refused — concurrent-connection cap reached', {
        cap: maxConnections, remote: socket.remoteAddress,
      });
      socket.destroy();
      return;
    }
    sockets.add(socket);

    const framer = new LineFramer();
    let identity: IngestIdentity | null = null;
    /** The token this socket authenticated with — re-checked before every line. */
    let authToken = '';
    // Serialises this socket's own processing. Without it, 'data' keeps firing
    // while an `await ingestPayload` is in flight, so one chatty device issues
    // unbounded concurrent writes in nondeterministic order.
    let draining = false;
    const queue: string[] = [];

    let windowStart = Date.now();
    let inWindow = 0;

    // ABSOLUTE, not `socket.setTimeout`. Node's socket timeout is an INACTIVITY
    // timer and resets on every byte, so a scanner dribbling one byte every
    // four seconds would hold the slot forever — exactly what this defends
    // against.
    const authDeadline = setTimeout(() => {
      log('closing socket — no valid token within the unauthenticated window', {
        ms: authTimeoutMs, remote: socket.remoteAddress,
      });
      socket.destroy();
    }, authTimeoutMs);

    const kill = (reason: string, meta?: Record<string, unknown>) => {
      log(reason, { ...meta, remote: socket.remoteAddress });
      socket.destroy();
    };

    socket.on('close', () => {
      clearTimeout(authDeadline);
      sockets.delete(socket);
    });

    // EVERY socket. An ECONNRESET with no listener is an unhandled 'error'
    // event, which is a process-level crash, not a logged warning.
    socket.on('error', (err) => {
      log('socket error', { err: (err as Error).message, remote: socket.remoteAddress });
      socket.destroy();
    });

    socket.on('data', (chunk: Buffer) => {
      if (socket.destroyed) return;

      let lines: string[];
      try {
        lines = framer.push(chunk);
      } catch (e) {
        kill('framer failure', { err: (e as Error).message });
        return;
      }

      // Rate first: the cheapest check, and the one that must apply to lines
      // about to be rejected anyway. See DEFAULT_MAX_MESSAGES_PER_WINDOW.
      const now = Date.now();
      if (now - windowStart >= rateWindowMs) { windowStart = now; inWindow = 0; }
      inWindow += lines.length;
      if (inWindow > maxMessages) {
        kill('closing socket — message rate cap exceeded', {
          cap: maxMessages, windowMs: rateWindowMs, code: identity?.code,
        });
        return;
      }

      // Two checks, not one. `LineFramer` retains only the UNTERMINATED
      // remainder, so a single 70 KB write ending in '\n' leaves `buffered`
      // at 0 while handing back a 70 KB line. Guarding only the buffer would
      // wave that straight through to the batch path.
      for (const line of lines) {
        if (Buffer.byteLength(line, 'utf8') > maxLineBytes) {
          kill('closing socket — line exceeds the byte cap', { cap: maxLineBytes });
          return;
        }
      }
      if (framer.buffered > maxLineBytes) {
        kill('closing socket — unterminated line exceeds the byte cap', { cap: maxLineBytes });
        return;
      }
      if (lines.length === 0) return;

      // Backpressure: stop reading while these lines are processed, resume
      // after. Pausing before the async work is what makes the pause real.
      socket.pause();
      queue.push(...lines);
      void drain();
    });

    async function drain(): Promise<void> {
      if (draining) return;
      draining = true;
      try {
        while (queue.length > 0 && !socket.destroyed) {
          const line = queue.shift() as string;

          if (!identity) {
            const token = readToken(line);
            if (!token) {
              // Pre-auth there is no instrument to file a dead-letter against,
              // so this is a drop, not a record. Inventing a placeholder
              // instrument to hang it on would be a fabricated record in a
              // §11 system.
              kill('closing socket — first line was not a {"token":"..."} envelope');
              return;
            }
            const resolved = await resolveInstrumentByToken(token);
            if (!resolved) {
              kill('closing socket — invalid device token');
              return;
            }
            // Device certificates (2026-10-27): raw TCP is never TLS, so it
            // never carries one — an instrument whose profile requires a
            // certificate cannot report here at all.
            const verdict = judgeConnection(resolved, null);
            if (!verdict.ok) {
              await recordCertificateRefusal(resolved.id, 'tcp', verdict.code);
              kill('closing socket — device certificate required (raw TCP cannot carry one)', { code: resolved.code });
              return;
            }
            identity = resolved;
            authToken = token;
            clearTimeout(authDeadline);
            // Only NOW does an inactivity timer make sense: the peer has
            // proved who it is, and silence from here means a dead device
            // rather than a stalling attacker.
            socket.setTimeout(idleTimeoutMs, () => {
              log('closing socket — idle past the post-auth timeout', {
                ms: idleTimeoutMs, code: identity?.code,
              });
              socket.destroy();
            });
            continue;
          }

          // Revocation must reach an OPEN socket (audit 2026-10-12): deactivated,
          // token revoked or replaced, or deleted since it authenticated → the
          // line is not stored and the socket is closed. Cached, so cheap.
          const current = await reauthorizeConnection(authToken, identity);
          if (!current) {
            kill('closing socket — credential revoked, or instrument deactivated or deleted', { code: identity.code });
            return;
          }
          identity = current;
          // The profile may have started requiring a certificate since this
          // socket authenticated.
          const verdict = judgeConnection(identity, null);
          if (!verdict.ok) {
            await recordCertificateRefusal(identity.id, 'tcp', verdict.code);
            kill('closing socket — device certificate required (raw TCP cannot carry one)', { code: identity.code });
            return;
          }

          const outcome = await ingestPayload({
            identity, raw: Buffer.from(line, 'utf8'), transport: 'tcp', certificateVerified: false,
          });

          // A refusal is the core having RECORDED the problem correctly —
          // UNPARSEABLE and NOT_A_GATEWAY are both dead-lettered in there.
          // Closing on them would let one bad reading disconnect a device
          // that is otherwise reporting fine, which is the failure this
          // listener most has to avoid. Only protocol-level violations (bad
          // token, over-cap line, timeouts) destroy the socket.
          if (!outcome.ok) {
            log('reading refused', { code: outcome.code, instrument: identity.code });
          }
        }
      } catch (e) {
        // A throw out of ingestPayload (a DB outage, say) must not take the
        // process down with an unhandled rejection. Drop the connection; the
        // device will reconnect.
        kill('closing socket — ingest failed', { err: (e as Error).message });
      } finally {
        draining = false;
        if (!socket.destroyed) socket.resume();
      }
    }
  });

  // Without this an EADDRINUSE at boot is an unhandled 'error' event on the
  // server — the API would die at startup over a busy telemetry port.
  server.on('error', (err) => {
    log('server error', { err: (err as Error).message });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => reject(err);
    server.once('error', onError);
    server.listen(port, '0.0.0.0', () => {
      server.removeListener('error', onError);
      resolve();
    });
  });

  const address = server.address();
  const boundPort = typeof address === 'object' && address ? address.port : port;

  return {
    port: boundPort,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        sockets.clear();
        server.close(() => resolve());
      }),
  };
}
