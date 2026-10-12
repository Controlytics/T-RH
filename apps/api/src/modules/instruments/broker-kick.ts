import { logger } from '../../lib/logger.js';

/**
 * Drop a device's OPEN MQTT session at the broker (audit 2026-10-12 follow-up).
 *
 * EMQX consults the API's auth hook only at CONNECT, and the ingest bridge
 * cannot see which credential a publisher used. So after a token is
 * regenerated or replaced, an instrument is deactivated or deleted, or its
 * code changes (the code IS the MQTT client id), the device's existing session
 * would keep publishing — and after a code is REASSIGNED, the old device's
 * messages land on the new owner's topic and are attributed to it. Kicking the
 * session forces a reconnect, which the hook then refuses.
 *
 * `DELETE {EMQX_API_URL}/api/v5/clients/{clientid}` with basic auth
 * `EMQX_API_KEY:EMQX_API_SECRET` — a REST API key the installers bootstrap into
 * the broker (`api_key.bootstrap_file`, rendered from scripts/emqx/).
 *
 * BEST EFFORT, by design: called AFTER the change has committed, bounded by a
 * short timeout, and it NEVER throws — a broker that is down must not turn a
 * committed revocation into an error the operator would retry. Every outcome
 * is logged. With the key or secret unset (an install provisioned before this
 * existed, or AWS until its env carries them) it is a no-op with ONE warning
 * per process.
 */
export type KickOutcome = 'kicked' | 'not-connected' | 'failed' | 'disabled';

interface KickLog {
  info: (obj: Record<string, unknown>, msg: string) => void;
  warn: (obj: Record<string, unknown>, msg: string) => void;
}

const DEFAULT_API_URL = 'http://127.0.0.1:18083';
const DEFAULT_TIMEOUT_MS = 2000;

let warnedDisabled = false;

/** Test seam. Never call from production code. */
export function resetBrokerKickWarning(): void { warnedDisabled = false; }

const defaultLog: KickLog = {
  info: (obj, msg) => logger.info(obj, msg),
  warn: (obj, msg) => logger.warn(obj, msg),
};

export async function kickMqttClient(
  clientId: string,
  /** Why — logged with the outcome. */
  reason: string,
  log: KickLog = defaultLog,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<KickOutcome> {
  const key = process.env.EMQX_API_KEY;
  const secret = process.env.EMQX_API_SECRET;
  if (!key || !secret) {
    if (!warnedDisabled) {
      warnedDisabled = true;
      log.warn({ clientId, reason },
        '[broker-kick] EMQX_API_KEY / EMQX_API_SECRET not set — an open MQTT session is NOT dropped on '
        + 'revocation (token change, deactivate, delete, code change); the device keeps publishing until it reconnects');
    }
    return 'disabled';
  }
  const base = (process.env.EMQX_API_URL || DEFAULT_API_URL).replace(/\/+$/, '');
  const url = `${base}/api/v5/clients/${encodeURIComponent(clientId)}`;
  try {
    const res = await fetch(url, {
      method: 'DELETE',
      headers: { authorization: `Basic ${Buffer.from(`${key}:${secret}`).toString('base64')}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
    // Drain the body so the socket is released.
    await res.text().catch(() => '');
    if (res.status === 204 || res.status === 200) {
      log.info({ clientId, reason }, '[broker-kick] MQTT session dropped');
      return 'kicked';
    }
    if (res.status === 404) {
      log.info({ clientId, reason }, '[broker-kick] no open MQTT session to drop');
      return 'not-connected';
    }
    log.warn({ clientId, reason, status: res.status },
      '[broker-kick] broker REFUSED the kick — the session stays open until the device reconnects');
    return 'failed';
  } catch (err) {
    log.warn({ clientId, reason, err: (err as Error).message },
      '[broker-kick] broker unreachable — the session stays open until the device reconnects');
    return 'failed';
  }
}
