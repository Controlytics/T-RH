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
 *      match EVERY instrument. That hole is now closed at REGISTRATION instead
 *      — `instrumentCodeTopicViolation()` in `@digilog/shared` refuses `+`,
 *      `#`, NUL and a reserved last segment on every create path — so the
 *      client id can be operator text again without the ACL being forgeable.
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

    const { clientid, username } = body as Record<string, unknown>;
    if (typeof username !== 'string' || username.length === 0) return reply.send(DENY);
    if (typeof clientid !== 'string' || clientid.length === 0) return reply.send(DENY);

    // The single credential authority, exactly as every other listener uses it.
    // `password` is ignored on purpose: the token is the credential, and there
    // is no second secret to check. Accepting one would be a second auth path.
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
