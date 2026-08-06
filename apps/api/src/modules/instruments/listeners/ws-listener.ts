import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { WebSocket } from 'ws';
// Side-effect type import: pulls in the module augmentation that makes
// `{ websocket: true }` a legal route option. The plugin itself is registered
// by the composition root (app.ts / test-helper.ts), not here.
import type {} from '@fastify/websocket';
import { resolveInstrumentByToken, type IngestIdentity } from '../ingest-auth.js';
import { ingestPayload } from '../ingest-core.js';

/**
 * WebSocket ingest listener — `GET /api/ingest/v1/ws`.
 *
 * WSS is not a separate listener: TLS terminates in front of exactly this
 * route, so a `wss://` client and a `ws://` client reach the same handler and
 * both are recorded as `transport: 'ws'`. Inventing a second value would make
 * the dead-letter column describe the certificate rather than the protocol.
 *
 * Authentication accepts the token in EITHER place:
 *   - `Authorization: Bearer <token>` on the upgrade request, or
 *   - the FIRST frame, as `{"token":"..."}`, for the many clients (browsers
 *     included) that cannot set a handshake header at all.
 * They are two places to READ a token, not two credential paths:
 * `resolveInstrumentByToken` is the only authority either way, and a *bad*
 * Bearer header closes the connection instead of falling through to the frame
 * — otherwise a rejected credential would get a second attempt.
 *
 * Fastify supplies this route's HTTP-level plumbing but stops at the upgrade:
 * a `bodyLimit` never applies to a frame, and the global rate limit counts one
 * handshake, not the thousand frames that follow it. So the same three
 * defences the HTTP route gets for free are written by hand here — a frame
 * size cap enforced BEFORE any parse, a per-connection message rate cap, an
 * absolute deadline on an unauthenticated connection, and a GLOBAL
 * concurrent-connection cap (the per-connection caps bound what one client
 * costs; only this one bounds how many clients there are).
 */

/**
 * Matches the HTTP route's `BODY_LIMIT_BYTES` (`ingest-routes.ts`), for the
 * reason recorded there: `MAX_KEYS` in `ingest-core.ts` bounds the FLAT path
 * only, so on a gateway BATCH this size cap is the only thing standing between
 * a device and `writeBatch`'s Postgres bind-parameter ceiling (5 params per
 * reading against 65535 per statement = 13_107 readings; the smallest a
 * reading can be inside a device block is `"k":1,` = 6 bytes, so 65_536 bytes
 * buys at most ~10_922). Raise it and you must cap the batch path's reading
 * count at the same time.
 *
 * This is a REAL byte check on the frame about to be handed to the core, not a
 * check on any accumulator — the mistake the TCP listener records in its own
 * comment. The `ws` library's `maxPayload` (set where the plugin is
 * registered) is a much larger memory backstop on fragment reassembly, not
 * this cap; if it were set to the same value it would silently close the
 * connection first and this check would never be exercised.
 */
const DEFAULT_MAX_FRAME_BYTES = 65_536;

/** A connection that has not proved who it is within this window is not a device. */
const DEFAULT_AUTH_TIMEOUT_MS = 5_000;

/**
 * Per CONNECTION, matching the HTTP route's 600/min. A frame costs a JSON
 * parse and a DB write; without a cap one client can hold the event loop and
 * the connection pool against every other device on the site.
 */
const DEFAULT_MAX_MESSAGES_PER_WINDOW = 600;
const DEFAULT_RATE_WINDOW_MS = 60_000;

/**
 * Frames accepted while an earlier one is still being written. Processing is
 * serialised per connection, so a client that outruns the database would
 * otherwise grow this array without bound — the rate cap limits arrivals per
 * minute, not how far behind the queue may fall.
 */
const DEFAULT_MAX_QUEUED = 100;

/**
 * GLOBAL across this listener, mirroring the TCP listener's own cap. The
 * per-connection rate cap bounds what ONE client costs; nothing bounded how
 * many clients there were. An unauthenticated connection still holds a slot for
 * the whole auth deadline, so without this a scanner opening connections in a
 * loop consumes sockets, memory and file descriptors for free — the rate cap
 * never fires because each connection sends nothing.
 *
 * Well beyond any real instrument count on one site.
 */
const DEFAULT_MAX_CONNECTIONS = 200;

/** Application close codes (4000-4999 is the range reserved for us). */
const CLOSE_UNAUTHENTICATED = 4401;
const CLOSE_FRAME_TOO_LARGE = 4413;
const CLOSE_RATE_EXCEEDED = 4429;
const CLOSE_INTERNAL = 4500;
const CLOSE_CONNECTION_CAP = 4503;

export interface WsIngestOptions {
  authTimeoutMs?: number;
  maxFrameBytes?: number;
  maxMessagesPerWindow?: number;
  rateWindowMs?: number;
  maxQueued?: number;
  maxConnections?: number;
  /** Injected in tests to keep the run quiet; defaults to console. */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
}

function bearer(header?: string): string {
  if (!header) return '';
  const m = /^Bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1] : '';
}

/** The in-band auth frame's shape. Anything else is not a client of this protocol. */
function readToken(frame: Buffer): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(frame.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const t = (parsed as Record<string, unknown>).token;
  return typeof t === 'string' && t.length > 0 ? t : null;
}

export default async function wsIngestRoutes(
  app: FastifyInstance,
  opts: WsIngestOptions = {},
): Promise<void> {
  const authTimeoutMs = opts.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS;
  const maxFrameBytes = opts.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
  const maxMessages = opts.maxMessagesPerWindow ?? DEFAULT_MAX_MESSAGES_PER_WINDOW;
  const rateWindowMs = opts.rateWindowMs ?? DEFAULT_RATE_WINDOW_MS;
  const maxQueued = opts.maxQueued ?? DEFAULT_MAX_QUEUED;
  const maxConnections = opts.maxConnections ?? DEFAULT_MAX_CONNECTIONS;
  const log = opts.log ?? ((msg: string, meta?: Record<string, unknown>) =>
    console.warn(`[ingest:ws] ${msg}`, meta ?? ''));

  // Scoped to THIS plugin registration, not the module: the test helper builds
  // several apps in one process, and a module-level counter would leak between
  // them (and between a future second registration).
  const open = new Set<WebSocket>();

  app.get('/ws', {
    websocket: true,
    // NOT in the OpenAPI document, and it cannot be: `@fastify/websocket`
    // forces `schema.hide = true` on every websocket route (index.js), since an
    // upgrade is not expressible in OpenAPI 3.0. This block is therefore
    // in-source documentation only — the endpoint has to be written up by hand
    // wherever the ingest transports are documented.
    schema: {
      tags: ['Ingest'],
      summary: 'Submit telemetry over WebSocket (device token auth)',
      description:
        'Upgrade endpoint. Present the device token as `Authorization: Bearer <token>` on the '
        + 'upgrade request, or as a first frame `{"token":"..."}`. Every frame after '
        + 'authentication is one reading, in the same JSON shapes the HTTP route accepts.',
    },
  }, (socket: WebSocket, req: FastifyRequest) => {
    const remote = req.ip;

    // FIRST, before any branch that can return: an ECONNRESET with no 'error'
    // listener takes the whole process down. A REFUSED connection is exactly
    // when a peer is most likely to reset — the flood that trips the cap below
    // is the case this must survive.
    socket.on('error', (err: Error) => {
      log('socket error', { err: err.message, remote });
      socket.terminate();
    });

    // Counted at accept, removed in 'close' ONLY — 'close' fires exactly once
    // per connection however it died, whereas also decrementing on 'error'
    // would double-count and the cap would drift shut. Refused connections are
    // never added, so they cannot leak a slot.
    if (open.size >= maxConnections) {
      log('connection refused — concurrent-connection cap reached', {
        cap: maxConnections, remote,
      });
      try {
        socket.close(CLOSE_CONNECTION_CAP, 'connection cap reached');
      } catch {
        socket.terminate();
      }
      const capT = setTimeout(() => socket.terminate(), 1_000);
      capT.unref();
      return;
    }
    open.add(socket);
    socket.on('close', () => open.delete(socket));

    let identity: IngestIdentity | null = null;
    let shut = false;

    const queue: Buffer[] = [];
    // Serialises this connection's processing. Without it, 'message' keeps
    // firing while an `await ingestPayload` is in flight, so one chatty device
    // issues unbounded concurrent writes in nondeterministic order.
    let draining = false;

    let windowStart = Date.now();
    let inWindow = 0;

    const close = (code: number, reason: string, meta?: Record<string, unknown>) => {
      if (shut) return;
      shut = true;
      log(reason, { ...meta, remote });
      clearTimeout(authDeadline);
      try {
        socket.close(code, reason.slice(0, 120));
      } catch {
        socket.terminate();
      }
      // A peer that never answers the close handshake would otherwise hold the
      // connection open indefinitely — close() is a request, terminate() is not.
      const t = setTimeout(() => socket.terminate(), 1_000);
      t.unref();
    };

    // ABSOLUTE, not an inactivity timer: a client dribbling a frame every few
    // seconds without ever presenting a token would reset an idle timer forever
    // and hold the slot for free.
    const authDeadline = setTimeout(() => {
      if (!identity) close(CLOSE_UNAUTHENTICATED, 'no token within the unauthenticated window', {
        ms: authTimeoutMs,
      });
    }, authTimeoutMs);

    // ('error' is handled at the very top of this handler — see the comment
    // there for why it cannot wait until after the connection-cap branch.)

    socket.on('close', () => {
      shut = true;
      clearTimeout(authDeadline);
    });

    // Header auth is resolved eagerly, so a bad Bearer token is refused even if
    // the client never sends a frame. `headerAuth` is awaited at the top of
    // drain() so a frame arriving mid-resolution cannot be mistaken for the
    // in-band token frame.
    const headerToken = bearer(req.headers.authorization);
    let headerAuth: Promise<void> | null = headerToken
      ? (async () => {
          const resolved = await resolveInstrumentByToken(headerToken);
          if (!resolved) {
            close(CLOSE_UNAUTHENTICATED, 'invalid device token on the upgrade header');
            return;
          }
          identity = resolved;
          clearTimeout(authDeadline);
        })().catch((e: unknown) => {
          close(CLOSE_INTERNAL, 'token resolution failed', { err: (e as Error).message });
        })
      : null;
    if (headerAuth) void headerAuth.then(() => { void drain(); });

    socket.on('message', (data: Buffer | ArrayBuffer | Buffer[]) => {
      if (shut) return;

      // Rate first: the cheapest check, and the one that must apply to frames
      // we are about to reject anyway.
      const now = Date.now();
      if (now - windowStart >= rateWindowMs) { windowStart = now; inWindow = 0; }
      if (++inWindow > maxMessages) {
        close(CLOSE_RATE_EXCEEDED, 'message rate cap exceeded', {
          cap: maxMessages, windowMs: rateWindowMs, code: identity?.code,
        });
        return;
      }

      const frame = Array.isArray(data)
        ? Buffer.concat(data)
        : Buffer.isBuffer(data) ? data : Buffer.from(new Uint8Array(data));

      // A REAL byte check on the frame itself, BEFORE any parse — see the
      // comment on DEFAULT_MAX_FRAME_BYTES for why this is the batch path's
      // only bound.
      if (frame.byteLength > maxFrameBytes) {
        close(CLOSE_FRAME_TOO_LARGE, 'frame exceeds the byte cap', {
          cap: maxFrameBytes, size: frame.byteLength, code: identity?.code,
        });
        return;
      }

      if (queue.length >= maxQueued) {
        close(CLOSE_RATE_EXCEEDED, 'sending faster than readings can be written', {
          queued: queue.length, code: identity?.code,
        });
        return;
      }

      queue.push(frame);
      void drain();
    });

    async function drain(): Promise<void> {
      if (draining) return;
      draining = true;
      try {
        // Ordering, not politeness: until the header token has resolved we
        // cannot tell whether the first frame is a reading or an auth envelope.
        if (headerAuth) { await headerAuth; headerAuth = null; }

        while (queue.length > 0 && !shut) {
          const frame = queue.shift() as Buffer;

          if (!identity) {
            const token = readToken(frame);
            if (!token) {
              // Pre-auth there is no instrument to file a dead-letter against,
              // so this is a drop, not a record. Inventing a placeholder
              // instrument to hang it on would be a fabricated record in a
              // §11 system.
              close(CLOSE_UNAUTHENTICATED, 'first frame was not a {"token":"..."} envelope');
              return;
            }
            const resolved = await resolveInstrumentByToken(token);
            if (!resolved) {
              close(CLOSE_UNAUTHENTICATED, 'invalid device token in the first frame');
              return;
            }
            identity = resolved;
            clearTimeout(authDeadline);
            continue;
          }

          const outcome = await ingestPayload({ identity, raw: frame, transport: 'ws' });

          // A refusal is the core having RECORDED the problem correctly —
          // UNPARSEABLE and NOT_A_GATEWAY are both dead-lettered in there.
          // Closing on them would let one bad reading disconnect a device that
          // is otherwise reporting fine, which is the failure this listener
          // most has to avoid. Only protocol-level violations (bad token,
          // over-cap frame, rate cap, auth timeout) close the connection.
          if (!outcome.ok) {
            log('reading refused', { code: outcome.code, instrument: identity.code });
          }
        }
      } catch (e) {
        // A throw out of ingestPayload (a DB outage, say) must not surface as
        // an unhandled rejection. Drop the connection; the device reconnects.
        close(CLOSE_INTERNAL, 'ingest failed', { err: (e as Error).message });
      } finally {
        draining = false;
      }
    }
  });
}
