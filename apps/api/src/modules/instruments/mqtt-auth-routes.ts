import { createHash, timingSafeEqual } from 'node:crypto';
import { type FastifyInstance } from 'fastify';
import { resolveInstrumentByToken } from './ingest-auth.js';

/**
 * `POST /api/ingest/v1/mqtt-auth` — the hook EMQX calls on every CONNECT.
 *
 * This endpoint is the reason the design uses an external broker (EMQX) rather
 * than embedding one: EMQX stores no device credentials at all, it asks us per
 * connection. Revocation is therefore immediate rather than eventually
 * consistent — there is no copy of the token anywhere to go stale.
 *
 * CACHE INTERACTION (the one qualifier on "immediate"):
 * `resolveInstrumentByToken` caches a positive result for 10 s, so a revocation
 * could be honoured up to 10 s late on a NEW connection. In practice it is not:
 * `POST /api/instruments/:id/regenerate-token` and the revoke/delete paths call
 * `invalidateIngestAuthCache(id)`, which drops the entry the moment the operator
 * acts. The 10 s window only exists for a credential revoked by some path that
 * forgets to invalidate. Already-connected sessions are not affected by either —
 * EMQX only consults this hook at CONNECT (see the broker-side note below).
 *
 * ─── The topic-authorisation half, which this endpoint is one leg of ─────────
 * Authenticating the CONNECT does NOT stop a connected device publishing to
 * `instruments/<someone-else>/telemetry`. A subscriber (our bridge) cannot see
 * who published a message, so the bridge cannot check entitlement — the broker
 * has to. EMQX can only template a topic ACL on `${clientid}` or `${username}`,
 * and our username IS the secret token (which must never appear in a topic), so
 * the binding has to run through the client id:
 *
 *   1. HERE: the presented `clientid` must equal the resolved instrument's
 *      `code`, otherwise deny. Without this a device simply lies about its
 *      client id and the broker rule below is worthless.
 *
 *      HISTORY OF THIS ONE COMPARISON, because it has flipped twice:
 *      code until 2026-08-07; the UUID from then until 2026-09-04; the code
 *      again since, at the operator's request ("i want client id as
 *      CWH/RDU/001-00"). The UUID interlude existed because the code had
 *      become free text and a code of `+` or `#` in the ACL template would
 *      match EVERY instrument. That hole was closed at REGISTRATION from
 *      2026-09-04 (`instrumentCodeTopicViolation()` refused `+`, `#`, NUL and
 *      a reserved last segment) UNTIL 2026-09-16, when the operator had the
 *      guard removed ("remove instrument id restriction"), with the
 *      consequence stated: a `+` client id under the file ACL matches every
 *      instrument's topics, and a `+`/`#` code cannot publish at all (the
 *      broker refuses a wildcard in a publish topic). The comparison HERE is
 *      still exact-string, so a device must present its own code verbatim.
 *      `/` is allowed and appears in every code at this plant; the ACL
 *      template reproduces it literally and the bridge matches a fixed
 *      prefix/suffix rather than counting levels.
 *   2. IN EMQX (`etc/acl.conf`): publish is allowed only to
 *      `instruments/${clientid}/telemetry`, with `authorization.no_match = deny`.
 *
 * Composed: topic <-> clientid <-> token. Both legs are required; neither is
 * redundant with the other. The exact broker configuration is recorded in the
 * MQTT section of the ingest docs — changing `no_match` back to `allow`, or
 * re-adding an allow-all rule, silently removes the property while every
 * happy-path test stays green.
 */

interface EmqxAuthResult { result: 'allow' | 'deny' }

const ALLOW: EmqxAuthResult = { result: 'allow' };
const DENY: EmqxAuthResult = { result: 'deny' };

/** Constant-time string equality over fixed-length digests, so a wrong bridge
 *  password of any length costs the same as a right one. */
function sameSecret(a: string, b: string): boolean {
  const da = createHash('sha256').update(a).digest();
  const db = createHash('sha256').update(b).digest();
  return timingSafeEqual(da, db);
}

/**
 * The ingest BRIDGE's own credential (2026-09-08). The bridge — this very
 * process — connects to the broker with `MQTT_USERNAME` / `MQTT_PASSWORD` and
 * holds no instrument token. On the dev box a built-in-database user in EMQX
 * admits it AHEAD of this hook; the customer installer configures ONE
 * authenticator (this hook) so no dashboard or API-key step is needed, and
 * the hook admits the bridge by the same static credential the API connects
 * with. Read per request, not at boot: the e2e flips the env, and a value
 * captured at import would be a second copy of the secret to go stale.
 *
 * `null` = "this username is not the bridge, carry on to the token path";
 * a boolean = the decision. The bridge NAME with a wrong password is a deny,
 * never a fall-through to the token path — a device token under the bridge
 * name would otherwise inherit the bridge's ACL grants.
 */
function bridgeDecision(username: string, password: unknown): boolean | null {
  const u = process.env.MQTT_USERNAME;
  const p = process.env.MQTT_PASSWORD;
  if (!u || username !== u) return null;
  if (!p) return false;
  return typeof password === 'string' && password.length > 0 && sameSecret(password, p);
}

export default async function mqttAuthRoutes(app: FastifyInstance) {
  app.post('/mqtt-auth', {
    // Same tightening as the HTTP ingest route, for the same reason: this is
    // reachable without a user JWT. One CONNECT per device per reconnect is
    // nowhere near 600/min, so a caller at the cap is a broker in a reconnect
    // storm or someone guessing tokens.
    config: { rateLimit: { max: 600, timeWindow: '1 minute' } },
    // The body is EMQX's, not ours. Deliberately NOT validated by a Fastify
    // schema: a schema violation would return 400, and EMQX treats a non-2xx
    // as "authenticator errored" rather than "denied". Every unexpected shape
    // must reach the handler and come back as an explicit `deny`.
    bodyLimit: 8_192,
    schema: {
      tags: ['Ingest'],
      summary: 'EMQX HTTP authenticator hook (device token as MQTT username)',
      description:
        'Called by EMQX on every MQTT CONNECT. The device token is presented as the MQTT '
        + 'username and the instrument CODE (e.g. CWH/RDU/001-00) as the MQTT client id; both must match the same '
        + 'instrument. Always answers 200 with {"result":"allow"|"deny"} — deny is the default '
        + 'for every unrecognised body.',
      response: {
        200: { type: 'object', properties: { result: { type: 'string' } } },
      },
    },
  }, async (req, reply) => {
    const body = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return reply.send(DENY);

    const { clientid, username, password } = body as Record<string, unknown>;
    if (typeof username !== 'string' || username.length === 0) return reply.send(DENY);
    if (typeof clientid !== 'string' || clientid.length === 0) return reply.send(DENY);

    // The bridge's own credential — see bridgeDecision(). Checked FIRST and
    // terminal for that username, so the token path below never sees it.
    const bridge = bridgeDecision(username, password);
    if (bridge !== null) {
      if (!bridge) req.log.warn({ clientid }, '[ingest:mqtt-auth] denied — bridge username with a wrong or missing password');
      return reply.send(bridge ? ALLOW : DENY);
    }

    // The single credential authority, exactly as every other listener uses it.
    // For a DEVICE `password` is ignored on purpose: the token is the credential,
    // and there is no second secret to check. Accepting one would be a second
    // auth path. (The bridge above is the one, named exception.)
    const identity = await resolveInstrumentByToken(username);
    if (!identity) return reply.send(DENY);

    // Leg 1 of the topic binding — see the header comment. A valid token
    // presented under another instrument's client id is a device trying to
    // publish as someone else, and is refused at CONNECT.
    if (clientid !== identity.code) {
      req.log.warn(
        { clientid, instrument: identity.id, code: identity.code },
        '[ingest:mqtt-auth] denied — client id does not match the token\'s instrument code',
      );
      return reply.send(DENY);
    }

    return reply.send(ALLOW);
  });
}
