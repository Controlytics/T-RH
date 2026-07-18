/**
 * HMAC-signed offline-replay grant — audit 2026-05-04 fix C1.
 *
 * Replaces the unauthenticated `x-offline-replay: true` boolean header with
 * a server-issued, signature-verifiable grant token. The grant proves that
 * the bearer was authenticated AND completed reauth (password challenge) at
 * issuance time — so we can safely skip the per-request reauth gate without
 * silently disabling the entire 21 CFR Part 11 attestation.
 *
 * Token shape (JWT, HS256):
 *   {
 *     sub: <userId>,         // bound to user — stolen JWT alone insufficient
 *     sid: <sessionId>,      // bound to session — old session's token can't
 *                            //   be used after the user re-authenticates
 *     typ: 'offline-replay', // hard-separates from session JWT (key reuse)
 *     iat, exp               // standard claims; default exp = +24h
 *   }
 *
 * Threat model assumptions:
 *   - JWT_SECRET equivalent (OFFLINE_REPLAY_SECRET) lives only on the server;
 *     a client cannot forge tokens.
 *   - Issuance requires successful reauth — physical password ownership.
 *   - Tokens expire (default 24h) — long enough for a typical offline shift,
 *     short enough that a leaked token has bounded blast radius.
 *   - The token authorizes offline replay ONLY for the bound user+session;
 *     a stolen token cannot be used by a different user.
 *
 * Operator notes:
 *   - When a user logs out (session ends), all their existing offline-replay
 *     tokens become invalid. They must log in and re-grant before replaying.
 *   - The token is sent in the `x-offline-replay-token` header (replaces
 *     `x-offline-replay: true`).
 *   - Bare `x-offline-replay: true` is now REJECTED — see reauth-check.ts.
 */
import * as jose from 'jose';
import { randomBytes } from 'node:crypto';

function getOfflineSecret(): Uint8Array {
  const explicit = process.env.OFFLINE_REPLAY_SECRET;
  if (explicit && explicit.length >= 32) {
    return new TextEncoder().encode(explicit);
  }
  const nodeEnv = process.env.NODE_ENV?.toLowerCase();
  if (nodeEnv === 'production' || nodeEnv === 'staging') {
    throw new Error(
      'FATAL: OFFLINE_REPLAY_SECRET must be set to a string of at least 32 characters in production/staging.',
    );
  }
  // Dev-mode fallback: derive a per-process secret. Domain-separated from JWT
  // so a JWT-secret leak does not give the attacker offline-replay forging.
  const jwtSecret = process.env.JWT_SECRET;
  if (jwtSecret && jwtSecret.length >= 32) {
    // Mix in a constant separator + random tail so the offline secret differs
    // from the JWT secret even when JWT_SECRET is reused.
    const mixed = jwtSecret + '|offline-replay|' + randomBytes(16).toString('hex');
    console.warn(
      'WARNING: OFFLINE_REPLAY_SECRET not set. Deriving per-session secret from JWT_SECRET. Set OFFLINE_REPLAY_SECRET in .env for persistence across restarts.',
    );
    return new TextEncoder().encode(mixed);
  }
  const generated = randomBytes(32).toString('hex');
  console.warn(
    'WARNING: OFFLINE_REPLAY_SECRET not set and no JWT_SECRET available. Using random per-session secret. Set OFFLINE_REPLAY_SECRET in .env for persistence.',
  );
  return new TextEncoder().encode(generated);
}

const OFFLINE_REPLAY_SECRET = getOfflineSecret();
const TOKEN_TYPE = 'offline-replay';
const DEFAULT_TTL_HOURS = 24;

export interface OfflineReplayClaims {
  sub: string;       // userId
  sid: string;       // sessionId
  typ: typeof TOKEN_TYPE;
  iat?: number;
  exp?: number;
}

/**
 * Issue an offline-replay grant token.
 * Called from POST /api/auth/offline-grant after a successful reauth.
 *
 * @param userId    JWT sub — the user the token authorizes
 * @param sessionId JWT sid — binds to the issuing session
 * @param ttlHours  Token lifetime (default 24h)
 */
export async function signOfflineReplayToken(
  userId: string,
  sessionId: string,
  ttlHours: number = DEFAULT_TTL_HOURS,
): Promise<{ token: string; expiresAt: Date }> {
  const expiresAt = new Date(Date.now() + ttlHours * 60 * 60 * 1000);
  const payload: OfflineReplayClaims = { sub: userId, sid: sessionId, typ: TOKEN_TYPE };
  const token = await new jose.SignJWT(payload as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .sign(OFFLINE_REPLAY_SECRET);
  return { token, expiresAt };
}

export class OfflineReplayTokenError extends Error {
  constructor(
    public readonly code:
      | 'OFFLINE_REPLAY_TOKEN_MISSING'
      | 'OFFLINE_REPLAY_TOKEN_INVALID'
      | 'OFFLINE_REPLAY_TOKEN_EXPIRED'
      | 'OFFLINE_REPLAY_TOKEN_USER_MISMATCH'
      | 'OFFLINE_REPLAY_TOKEN_SESSION_MISMATCH'
      | 'OFFLINE_REPLAY_TOKEN_WRONG_TYPE',
    message: string,
  ) {
    super(message);
    this.name = 'OfflineReplayTokenError';
  }
}

/**
 * Verify an offline-replay grant token bound to a specific user + session.
 * Returns the decoded claims on success; throws OfflineReplayTokenError
 * with a stable code on any failure.
 *
 * Throws (NOT returns false) so the caller can propagate the failure mode
 * up to the global error handler with a clear remediation message.
 */
export async function verifyOfflineReplayToken(
  token: string,
  expectedUserId: string,
  expectedSessionId: string,
): Promise<OfflineReplayClaims> {
  if (!token || typeof token !== 'string') {
    throw new OfflineReplayTokenError('OFFLINE_REPLAY_TOKEN_MISSING', 'Offline-replay token not supplied.');
  }
  let claims: jose.JWTPayload;
  try {
    const result = await jose.jwtVerify(token, OFFLINE_REPLAY_SECRET);
    claims = result.payload;
  } catch (err: any) {
    if (err?.code === 'ERR_JWT_EXPIRED') {
      throw new OfflineReplayTokenError(
        'OFFLINE_REPLAY_TOKEN_EXPIRED',
        'Offline-replay grant has expired. Log in again to obtain a new grant.',
      );
    }
    throw new OfflineReplayTokenError(
      'OFFLINE_REPLAY_TOKEN_INVALID',
      'Offline-replay token signature invalid.',
    );
  }

  if (claims.typ !== TOKEN_TYPE) {
    throw new OfflineReplayTokenError(
      'OFFLINE_REPLAY_TOKEN_WRONG_TYPE',
      'Token is not an offline-replay grant.',
    );
  }
  if (claims.sub !== expectedUserId) {
    throw new OfflineReplayTokenError(
      'OFFLINE_REPLAY_TOKEN_USER_MISMATCH',
      'Offline-replay token is bound to a different user.',
    );
  }
  if (claims.sid !== expectedSessionId) {
    throw new OfflineReplayTokenError(
      'OFFLINE_REPLAY_TOKEN_SESSION_MISMATCH',
      'Offline-replay token is bound to a different session. Log in again to obtain a new grant.',
    );
  }
  return claims as unknown as OfflineReplayClaims;
}

/** Header name (lowercase per Fastify convention). */
export const OFFLINE_REPLAY_TOKEN_HEADER = 'x-offline-replay-token';
/** Legacy header name — accepted ONLY to return a clear deprecation 401. */
export const LEGACY_OFFLINE_REPLAY_HEADER = 'x-offline-replay';
