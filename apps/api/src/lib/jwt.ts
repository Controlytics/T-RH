import * as jose from 'jose';
import { randomBytes } from 'node:crypto';

function getSecret(envVar: string, name: string): Uint8Array {
  const value = process.env[envVar];
  if (!value || value.length < 32) {
    const nodeEnv = process.env.NODE_ENV?.toLowerCase();
    if (nodeEnv === 'production' || nodeEnv === 'staging') {
      throw new Error(`FATAL: ${envVar} must be set to a string of at least 32 characters in production/staging.`);
    }
    const generated = randomBytes(32).toString('hex');
    console.warn(`WARNING: ${envVar} not set or too short. Using random secret for this session. Set ${envVar} in .env for persistent sessions.`);
    return new TextEncoder().encode(generated);
  }
  return new TextEncoder().encode(value);
}

const JWT_SECRET = getSecret('JWT_SECRET', 'JWT signing');
const VERIFY_SECRET = getSecret('VERIFICATION_TOKEN_SECRET', 'Verification token');

export interface JwtPayload {
  sub: string;
  username: string;
  role: string;
  sessionId: string;
}

// Audit S-8: JWT TTL default reduced from 8h → 1h.
// Callers may pass a sessionDurationHours value from the session config; this
// function clamps it to JWT_EXPIRY_HOURS (env, default 1h) so the token never
// outlives the security policy even if the session config row drifts upward.
// To restore 8h behaviour temporarily set JWT_EXPIRY_HOURS=8 in .env.
const JWT_MAX_EXPIRY_HOURS = process.env.JWT_EXPIRY_HOURS
  ? Number(process.env.JWT_EXPIRY_HOURS)
  : 1;

export async function signToken(payload: JwtPayload, expirationHours = JWT_MAX_EXPIRY_HOURS): Promise<string> {
  // Clamp: the JWT must never be valid longer than JWT_MAX_EXPIRY_HOURS,
  // regardless of what the session config says.
  const clampedHours = Math.min(expirationHours, JWT_MAX_EXPIRY_HOURS);
  return new jose.SignJWT(payload as unknown as jose.JWTPayload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime(`${clampedHours}h`)
    .sign(JWT_SECRET);
}

export async function verifyToken(token: string): Promise<JwtPayload> {
  // Pin the algorithm (defense-in-depth): jose already rejects `alg:none` and
  // won't accept an asymmetric alg against a symmetric key, but an explicit
  // allowlist removes any dependence on library defaults across upgrades.
  const { payload } = await jose.jwtVerify(token, JWT_SECRET, { algorithms: ['HS256'] });
  return payload as unknown as JwtPayload;
}

export async function signVerificationToken(userId: string): Promise<string> {
  return new jose.SignJWT({ sub: userId, purpose: 'reauth' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(VERIFY_SECRET);
}

export async function verifyVerificationToken(token: string): Promise<{ sub: string }> {
  const { payload } = await jose.jwtVerify(token, VERIFY_SECRET, { algorithms: ['HS256'] });
  return { sub: payload.sub as string };
}
