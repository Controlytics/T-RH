import fp from 'fastify-plugin';
import { type FastifyInstance, type FastifyRequest, type FastifyReply } from 'fastify';
import { verifyToken, type JwtPayload } from '../lib/jwt.js';
import { prisma } from '../lib/prisma.js';
import {
  verifyOfflineReplayToken,
  OfflineReplayTokenError,
  OFFLINE_REPLAY_TOKEN_HEADER,
  LEGACY_OFFLINE_REPLAY_HEADER,
} from '../lib/offline-replay-token.js';
import { isPasswordExpired } from '../lib/password-expiry.js';
import { isSuperAdminApiEnabled } from '../lib/super-admin-lock.js';

declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload;
    /** True only after a verified offline-replay grant token has been
     * presented for the current request. Audit 2026-05-04 fix C1. */
    offlineReplayVerified?: boolean;
  }
}

// Session config cache (1-min TTL) to avoid DB read per request
let sessionConfigCache: { sessionDurationHours: number; cachedAt: number } | null = null;
const SESSION_CONFIG_CACHE_TTL = 60_000; // 1 minute

async function getSessionDurationHours(): Promise<number> {
  const now = Date.now();
  if (sessionConfigCache && (now - sessionConfigCache.cachedAt) < SESSION_CONFIG_CACHE_TTL) {
    return sessionConfigCache.sessionDurationHours;
  }
  const config = await prisma.systemConfig.findFirst({ where: { configKey: 'session' } });
  const hours = (config?.configValue as any)?.sessionDurationHours ?? 8;
  sessionConfigCache = { sessionDurationHours: hours, cachedAt: now };
  return hours;
}

// Password-policy cache (1-min TTL). Read on every authenticated request
// to derive password expiry from the LIVE policy + each user's
// passwordChangedAt + the policy's own updatedAt (grace floor).
// invalidatePasswordPolicyCache() is called from config.service.ts when
// the admin saves a new password policy so the new window applies
// immediately instead of after up to 60s of TTL lag.
type CachedPasswordPolicy = { passwordExpiryDays: number; policyUpdatedAt: Date | null };
let passwordPolicyCache: { policy: CachedPasswordPolicy; cachedAt: number } | null = null;
const PASSWORD_POLICY_CACHE_TTL = 60_000;

async function getPasswordPolicy(): Promise<CachedPasswordPolicy> {
  const now = Date.now();
  if (passwordPolicyCache && (now - passwordPolicyCache.cachedAt) < PASSWORD_POLICY_CACHE_TTL) {
    return passwordPolicyCache.policy;
  }
  const config = await prisma.systemConfig.findUnique({ where: { configKey: 'password-policy' } });
  const policy: CachedPasswordPolicy = {
    passwordExpiryDays: ((config?.configValue as { passwordExpiryDays?: number })?.passwordExpiryDays) ?? 90,
    policyUpdatedAt: config?.updatedAt ?? null,
  };
  passwordPolicyCache = { policy, cachedAt: now };
  return policy;
}

export function invalidatePasswordPolicyCache(): void {
  passwordPolicyCache = null;
}

/**
 * Audit §1.7 (2026-05-16). Caches the per-request user + session reads
 * so every authenticated request doesn't pay 2 DB round-trips before the
 * route logic runs. With Prisma's default pool size (`physical_cpus * 2 + 1`,
 * typically 9 on a 4-core dev box), 50 concurrent users at 1 req/s × 3-4
 * queries each saturated the pool with auth overhead alone.
 *
 * TTL = 30s. Trade-off: a user disabled / locked / role-changed via a
 * SUPER_ADMIN action has up to 30s of zombie access before the cache
 * expires. Matches the same posture as `sessionConfigCache` above.
 *
 * Invalidation: callers that mutate user.status / user.role / session
 * lifecycle should call `invalidateUserAuthCache(userId)` /
 * `invalidateSessionAuthCache(sessionId)` to take effect immediately.
 * (Wire-up across user.service.ts + auth.service.ts is a follow-up PR.)
 *
 * NOT INCLUDED in this PR: debouncing the session.update for lastActiveAt
 * + expiresAt (the row-lock-serialising write). That requires careful
 * coordination with the expiresAt enforcement check below — separate PR.
 */
type CachedSession = { id: string; createdAt: Date; expiresAt: Date; isActive: boolean };
type CachedUser = {
  role: string;
  username: string;
  status: string;
  forcePasswordChange: boolean;
  passwordChangedAt: Date | null;
  createdAt: Date;
  /** Legacy snapshot column — no longer used to gate expiry (isPasswordExpired
   * derives from passwordChangedAt + live policy). Retained for back-compat
   * with any caller that still reads from req-attached user. */
  passwordExpiresAt: Date | null;
};

const userAuthCache = new Map<string, { user: CachedUser; cachedAt: number }>();
const sessionAuthCache = new Map<string, { session: CachedSession; cachedAt: number }>();
const AUTH_CACHE_TTL_MS = 30_000;

// Debounce the sliding-window session write (lastActiveAt + expiresAt). Writing
// the session row on EVERY authenticated request is a per-request DB write that
// saturates the pool under a tablet fleet. We write at most once per
// SESSION_TOUCH_INTERVAL_MS per session. Safe: an active user still gets a write
// every ~60s, each extending expiresAt by hours, so an active session never
// expires mid-use; an idle session (no requests) still ages out normally.
// See the 2026-07-09 auth review.
const sessionTouchTimes = new Map<string, number>();
const SESSION_TOUCH_INTERVAL_MS = 60_000;

async function getCachedSession(sessionId: string): Promise<CachedSession | null> {
  const cached = sessionAuthCache.get(sessionId);
  if (cached && Date.now() - cached.cachedAt < AUTH_CACHE_TTL_MS) return cached.session;
  const session = await prisma.session.findFirst({
    where: { id: sessionId, isActive: true },
    select: { id: true, createdAt: true, expiresAt: true, isActive: true },
  });
  if (session) sessionAuthCache.set(sessionId, { session, cachedAt: Date.now() });
  return session;
}

async function getCachedUser(userId: string): Promise<CachedUser | null> {
  const cached = userAuthCache.get(userId);
  if (cached && Date.now() - cached.cachedAt < AUTH_CACHE_TTL_MS) return cached.user;
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true, username: true, status: true, forcePasswordChange: true,
      passwordChangedAt: true, createdAt: true, passwordExpiresAt: true,
    },
  });
  if (!user) return user;
  // Do NOT cache users mid-password-change. Temp-password / expired-password
  // operators flip forcePasswordChange false the moment they submit a new
  // password; if we cache the stale `true`, dashboard SWR queries after the
  // redirect see 403 FORCE_PASSWORD_CHANGE for up to 30s and the FE
  // window.location-redirects back to /change-password (operator perceives
  // it as "page refreshed, new password didn't take"). They go through
  // change-password exactly once — paying one extra DB read per request
  // during that brief window is cheap; the cache is for steady-state users.
  if (user.forcePasswordChange) return user;
  userAuthCache.set(userId, { user, cachedAt: Date.now() });
  return user;
}

/** Evict a user from the auth cache. Call from user.service.ts mutation paths
 * (status change, role change, force-password-change toggle, delete). */
export function invalidateUserAuthCache(userId: string): void {
  userAuthCache.delete(userId);
}

/** Evict a session from the auth cache. Call from auth.service.ts logout +
 * force-logout + session-expiry + password-reset paths. */
export function invalidateSessionAuthCache(sessionId: string): void {
  sessionAuthCache.delete(sessionId);
  sessionTouchTimes.delete(sessionId);
}

/**
 * Match a request URL against a public-path allowlist with a SEGMENT BOUNDARY,
 * not a bare prefix. `startsWith('/api/health')` would wrongly make
 * `/api/health-evil` public; this matches only when the path equals the prefix,
 * is a true sub-path (prefix + '/'), or — for directory prefixes already ending
 * in '/' — starts with it. Query string is ignored. Exported for unit testing.
 */
export function matchesPublicPath(url: string, prefixes: string[]): boolean {
  const path = url.split('?')[0];
  return prefixes.some((p) => {
    if (p.endsWith('/')) return path.startsWith(p);
    return path === p || path.startsWith(p + '/');
  });
}


const isProduction = process.env.NODE_ENV === 'production';
const PUBLIC_PATHS = [
  '/api/auth/login', '/api/auth/forgot-password', '/api/auth/beacon-logout',
  '/api/health',
  '/api/guest/cleaning-request',  // guest (unauthenticated) filter cleaning request

  ...(isProduction ? [] : ['/docs', '/docs/']),  // Swagger only public in non-production
  '/api/notification-settings/email/oauth2/code', // OAuth2 callback (no JWT - redirect from Microsoft/Google)
  // 2026-07-03: removed 6 stale JWT-skip entries whose routes were deleted in the
  // Phase 7 data-ingestion + MQTT tear-out — no route is registered for any of
  // them, so the allowlist entries were dead cruft:
  //   /api/internal/mqtt (EMQX), /api/ws (WS transport module),
  //   /api/data/{telemetry,attributes,binary,event} (data-ingestion module).
];

// Paths that are public only for GET requests
const PUBLIC_GET_PATHS = ['/api/config/branding', '/api/config/datetime/current', '/uploads/photos/', '/uploads/branding/', '/api/roles/active', '/api/admin-requests/user-lookup'];

async function authPlugin(app: FastifyInstance) {
  app.addHook('onRequest', async (req: FastifyRequest, reply: FastifyReply) => {
    // Fully public paths (all methods). Segment-boundary match, not bare prefix.
    if (matchesPublicPath(req.url, PUBLIC_PATHS)) return;

    // Paths that are public only for GET requests
    if (req.method === 'GET' && matchesPublicPath(req.url, PUBLIC_GET_PATHS)) return;

    // M1 (SERVE_WEB): when the API also serves the built web UI, static assets
    // and SPA navigations must load WITHOUT a token — the login page itself is
    // served by this process. Allow GET/HEAD for any path that is not a server
    // surface (/api, /uploads, /docs). The SPA's own data calls hit /api/* and
    // still go through full auth below; protected uploads + Swagger are excluded
    // so this never widens their existing access rules. See EXE-PACKAGING §5.
    if (
      process.env.SERVE_WEB === 'true' &&
      (req.method === 'GET' || req.method === 'HEAD') &&
      !req.url.startsWith('/api') &&
      !req.url.startsWith('/uploads') &&
      !req.url.startsWith('/docs')
    ) {
      return;
    }

    // POST /api/admin-requests — public submit (but GET/other methods require auth)
    if (req.method === 'POST' && req.url === '/api/admin-requests') return;

    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Missing token' });
    }

    // ONLY the token verification is guarded. Everything below it does DB I/O,
    // and a catch-all here reported any Postgres fault — pool exhaustion, a
    // restart, a lock timeout — as "invalid or expired token", which logs the
    // operator out and hides the outage from the logs entirely. Infrastructure
    // errors now fall through to the global handler (app.ts setErrorHandler),
    // which logs them and returns 500. verifyToken is pure jose, no I/O.
    let payload: JwtPayload;
    try {
      payload = await verifyToken(header.slice(7));
    } catch {
      return reply.code(401).send({ error: 'TOKEN_EXPIRED', message: 'Invalid or expired token' });
    }
    req.user = payload;

    const session = await getCachedSession(payload.sessionId);

    if (!session) {
      return reply.code(401).send({ error: 'SESSION_INVALID', message: 'Session terminated' });
    }

    if (session.expiresAt < new Date()) {
      // Evict cache + persist invalidation in same step.
      invalidateSessionAuthCache(session.id);
      await prisma.session.update({
        where: { id: session.id },
        data: { isActive: false, terminationReason: 'expired' },
      });
      return reply.code(401).send({ error: 'SESSION_EXPIRED', message: 'Session expired' });
    }

    // Enforce absolute session timeout (max 24h regardless of activity)
    const MAX_ABSOLUTE_SESSION_MS = 24 * 60 * 60 * 1000;
    if (Date.now() - session.createdAt.getTime() > MAX_ABSOLUTE_SESSION_MS) {
      invalidateSessionAuthCache(session.id);
      await prisma.session.update({
        where: { id: session.id },
        data: { isActive: false, terminationReason: 'absolute_timeout' },
      });
      return reply.code(401).send({ error: 'SESSION_EXPIRED', message: 'Session exceeded maximum duration. Please log in again.' });
    }

    // Check user status and sync role from DB (cached)
    const user = await getCachedUser(payload.sub);
    if (!user || user.status !== 'ENABLED') {
      // If user was just disabled, evict so next request sees the change.
      invalidateUserAuthCache(payload.sub);
      return reply.code(401).send({ error: 'ACCOUNT_INACTIVE', message: 'Account is not active' });
    }

    // Patch req.user with authoritative DB values
    req.user = {
      ...req.user,
      role: user.role,
      username: user.username,
    };

    // Paths allowed when forcePasswordChange is true
    const PASSWORD_CHANGE_ALLOWED = [
      '/api/auth/change-password',
      '/api/auth/logout',
      '/api/auth/me',
      '/api/config/password-policy',
      // The tablet login gate (mobile-login.tsx checkTabletAccess) reads the
      // operator's OWN allowlist here before deciding whether to admit them.
      // Without this exemption it returned 403 for any forced-change user, the
      // fail-closed check read that as "no tablet access", and the operator
      // was bounced off login and never reached /change-password — i.e. a
      // temp-password / reset / expired user could not set a new password from
      // the tablet at all (reported 2026-05-30). Read-only, own-config only.
      '/api/config/tablet-access/my-features',
    ];

    // Check password expiry (server-side enforcement). Derived from
    // passwordChangedAt + the live policy + policy save time (which acts
    // as a grace-period floor — lowering the policy doesn't mass-lock
    // every account whose password is older than the new window). See
    // lib/password-expiry.ts.
    //
    // SUPER_ADMIN is exempt — same posture as the LOCKED / EXPIRED auto-
    // recovery in auth.service.login(). Weakens 21 CFR §11.10(g) for
    // privileged accounts; documented trade-off per user request 2026-05-25.
    let passwordExpired = false;
    if (user.role !== 'SUPER_ADMIN') {
      const policy = await getPasswordPolicy();
      passwordExpired = isPasswordExpired(
        user.passwordChangedAt,
        user.createdAt,
        policy.passwordExpiryDays,
        policy.policyUpdatedAt,
      );
    }

    if (passwordExpired && !user.forcePasswordChange) {
      await prisma.user.update({
        where: { id: payload.sub },
        data: { forcePasswordChange: true },
      });
      // Mutate the cached object in place so this request sees the new state,
      // and evict so the next request re-reads from DB.
      user.forcePasswordChange = true;
      invalidateUserAuthCache(payload.sub);
    }

    // Enforce forcePasswordChange server-side (§11.10(f))
    if (user.forcePasswordChange) {
      const isAllowed = PASSWORD_CHANGE_ALLOWED.some((p) => req.url.startsWith(p));
      if (!isAllowed) {
        const errorCode = passwordExpired ? 'PASSWORD_EXPIRED' : 'FORCE_PASSWORD_CHANGE';
        return reply.code(403).send({
          error: errorCode,
          message: errorCode === 'PASSWORD_EXPIRED'
            ? 'Your password has expired. Please change your password.'
            : 'You must change your password before continuing.',
        });
      }
    }

    // Super Admin API kill-switch (2026-06-11). When the global
    // `super-admin-api-access` flag is OFF, a SUPER_ADMIN is frozen to the
    // SA_LOCK_ALLOWED allowlist below. This neutralises the all-powerful
    // SUPER_ADMIN account on demand; ADMIN/operator users are unaffected
    // (the check only runs for role === SUPER_ADMIN, so it adds zero DB reads
    // for everyone else). Login is in PUBLIC_PATHS and never reaches here, so
    // the SA can always log back in; logout + me + refresh + change-password +
    // the toggle endpoint stay reachable so he can re-enable it. Default ON /
    // fail-open — see lib/super-admin-lock.ts.
    if (user.role === 'SUPER_ADMIN') {
      const enabled = await isSuperAdminApiEnabled();
      if (!enabled) {
        const SA_LOCK_ALLOWED = [
          '/api/auth/me',
          '/api/auth/logout',
          '/api/auth/refresh',
          '/api/auth/change-password',
          '/api/config/password-policy', // public policy read used by the shell
          '/api/super-admin/api-lock',   // read state + flip the switch (reauth on flip)
        ];
        if (!SA_LOCK_ALLOWED.some((p) => req.url.startsWith(p))) {
          return reply.code(403).send({
            error: 'SUPER_ADMIN_API_LOCKED',
            message: 'Super Admin API access is currently disabled. Re-enable it to continue.',
          });
        }
      }
    }

    // Update last active + extend session expiry (sliding window), DEBOUNCED
    // to at most once per SESSION_TOUCH_INTERVAL_MS per session (see the map
    // declaration above for why this is safe).
    const lastTouch = sessionTouchTimes.get(session.id) ?? 0;
    if (Date.now() - lastTouch >= SESSION_TOUCH_INTERVAL_MS) {
      sessionTouchTimes.set(session.id, Date.now());
      const durationHours = await getSessionDurationHours();
      await prisma.session.update({
        where: { id: session.id },
        data: {
          lastActiveAt: new Date(),
          expiresAt: new Date(Date.now() + durationHours * 60 * 60 * 1000),
        },
      });
    }

    // Audit 2026-05-04 fix C1: verify offline-replay grant token (if any).
    //
    // Tablets in offline-replay mode send `x-offline-replay-token: <jwt>`.
    // We verify it here in onRequest so the result is available to ALL
    // downstream code (buildContext, enforceReauth, route handlers, the
    // offlinePerformedAt validator) without making 146 buildContext sites
    // async. Rejecting bare `x-offline-replay: true` (the legacy boolean
    // header) here makes the upgrade fail loud, not silent.
    const replayToken = req.headers[OFFLINE_REPLAY_TOKEN_HEADER];
    if (replayToken) {
      try {
        await verifyOfflineReplayToken(
          Array.isArray(replayToken) ? replayToken[0] : replayToken,
          req.user.sub,
          req.user.sessionId,
        );
        req.offlineReplayVerified = true;
      } catch (err: any) {
        if (err instanceof OfflineReplayTokenError) {
          return reply.code(401).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    } else if (req.headers[LEGACY_OFFLINE_REPLAY_HEADER] === 'true') {
      return reply.code(401).send({
        error: 'OFFLINE_REPLAY_HEADER_DEPRECATED',
        message: 'Bare `x-offline-replay: true` is no longer accepted. Obtain an offline-replay grant via POST /api/auth/offline-grant and send it as `x-offline-replay-token`.',
      });
    }
  });
}

export default fp(authPlugin, { name: 'auth' });
