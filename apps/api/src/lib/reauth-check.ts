import type { FastifyRequest, FastifyReply } from 'fastify';
import { prisma } from './prisma.js';
import { verifyCredential } from './ldap-identity.js';
import { applyFailedPasswordAttempt } from '../modules/auth/auth.service.js';
import type { ActionReauthConfig } from '@digilog/shared';

/**
 * Reauth password verification shared by enforceReauth / enforceReauthAlways.
 * Runs the SAME account-lockout policy as login (2026-07-09 security review) so
 * a valid-session attacker can't grind the password via reauth without locking.
 * Returns null on success (streak reset if any), or a REAUTH_FAILED reply payload
 * on failure (with a LOCKED code once the threshold trips).
 *
 * 2026-08-08: routed through `verifyCredential`. This path had the same defect
 * as `authService.verify` — a straight bcrypt compare against a directory
 * user's sentinel hash, which always fails — so every inline-password reauth
 * was unreachable for AD-authenticated staff, and three attempts locked them
 * out of the application entirely. Lockout is delegated to the directory for
 * those users (see lib/ldap-identity.ts).
 */
async function verifyReauthPassword(
  req: FastifyRequest,
  password: string,
): Promise<{ error: string; message: string } | null> {
  const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
  if (!user) return { error: 'REAUTH_FAILED', message: 'User not found.' };
  const { ok, lockoutDelegated, unavailableReason } = await verifyCredential(user, password);
  if (!ok) {
    if (unavailableReason) console.error(`[Reauth] ${user.username}: ${unavailableReason}`);
    if (lockoutDelegated) {
      return { error: 'REAUTH_FAILED', message: 'Incorrect password. Please try again.' };
    }
    const { locked } = await applyFailedPasswordAttempt(user, req.ip, req.headers['user-agent']);
    return locked
      ? { error: 'ACCOUNT_LOCKED', message: 'Account locked due to multiple failed attempts. Contact administrator.' }
      : { error: 'REAUTH_FAILED', message: 'Incorrect password. Please try again.' };
  }
  // Clear the consecutive-failure streak on a successful password proof
  // (guarded so the common already-zero case pays no write). failedLoginAttempts
  // is not an auth-cache field, so no cache invalidation is needed.
  if (user.failedLoginAttempts > 0) {
    await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0 } });
  }
  return null;
}

// In-memory cache with TTL to avoid DB hit on every mutation
let configCache: { data: ActionReauthConfig; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 10_000; // 10 seconds
// Warn at most once per process when the legacy (reauth-OFF) config shape is seen.
let legacyShapeWarned = false;

export async function getActionReauthConfig(): Promise<ActionReauthConfig> {
  const now = Date.now();
  if (configCache && (now - configCache.fetchedAt) < CACHE_TTL_MS) {
    return configCache.data;
  }
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'action-reauth' } });
  const raw = (row?.configValue as unknown) ?? {};
  const config = normalizeActionReauthConfig(raw);
  configCache = { data: config, fetchedAt: now };
  return config;
}

/**
 * Defensive shape normalization. Historical seeds stored this config as
 *   { actions: [{ action: 'DELETE_USER', roles: ['ADMIN'] }, ...] }
 * but every reader (frontend page, isReauthRequired, getMyActions, the Zod
 * schema in @digilog/shared) expects the flat record shape
 *   { DELETE_USER: ['ADMIN'], ... }
 *
 * Two consequences of the legacy shape:
 *   (a) Reauth was silently OFF for every action — `config[action]` was
 *       always undefined under the nested data, so no caller could resolve
 *       a roles list. Production effectively ran with no reauth policy.
 *   (b) PUT /api/config/action-reauth was un-saveable: GET returned the
 *       nested data verbatim, the frontend (and this test) spread it into
 *       the body of the next save, and the Zod schema rejected
 *       `actions: [{...}, ...]` with "Expected string, received object".
 *
 * Fix: when we detect the legacy shape, return `{}` (the de-facto state).
 * That preserves the historical reauth-OFF behavior, lets the PUT endpoint
 * work for the first time, and signals to operators that the on-disk
 * policy needs to be re-saved via the action-reauth page to take effect.
 * Already-flat data is returned as-is (with non-string-array values dropped
 * defensively).
 */
function normalizeActionReauthConfig(raw: unknown): ActionReauthConfig {
  if (!raw || typeof raw !== 'object') return {};
  const obj = raw as Record<string, unknown>;
  // Detect the legacy nested shape: a single `actions` key whose value is an
  // array of { action, roles } objects.
  const legacyActions = obj.actions;
  const looksLegacy = Array.isArray(legacyActions)
    && legacyActions.length > 0
    && typeof legacyActions[0] === 'object'
    && legacyActions[0] !== null
    && 'action' in (legacyActions[0] as object)
    && 'roles' in (legacyActions[0] as object);
  if (looksLegacy) {
    // Legacy data was non-functional — return empty so behavior matches the
    // de-facto reauth-OFF state. Operators must re-save via the UI to
    // (re)establish a policy. LOUD warning (once per process) so a bad restore
    // / migration that silently disables ALL re-auth on a 21 CFR system doesn't
    // go unnoticed — the previous silent `{}` was itself a finding.
    if (!legacyShapeWarned) {
      legacyShapeWarned = true;
      console.warn(
        '[reauth] action-reauth config is in the legacy nested shape — ALL re-authentication gates are currently DISABLED. Re-save the policy via the Action Re-auth config page to restore enforcement.',
      );
    }
    return {};
  }
  // Already in flat shape (or empty). Drop any non-array values defensively.
  const flat: ActionReauthConfig = {};
  for (const [key, value] of Object.entries(obj)) {
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      flat[key] = value as string[];
    }
  }
  return flat;
}

export function invalidateReauthCache(): void {
  configCache = null;
}

/**
 * Check if re-auth is required for the given action and role.
 */
export async function isReauthRequired(action: string, role: string): Promise<boolean> {
  const config = await getActionReauthConfig();
  const roles = config[action];
  if (!roles || roles.length === 0) return false;
  return roles.includes(role);
}

/**
 * Enforce re-authentication on a request.
 * Accepts one or more action keys — reauth is required if ANY of them is
 * configured to require reauth for the user's current role. This supports
 * routes that serve multiple logical actions (e.g., POST /instances handles
 * both CREATE_ASSET and CREATE_FILTER semantics).
 */
export async function enforceReauth(
  action: string | string[],
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ ok: boolean }> {
  const role = req.user.role;
  const actions = Array.isArray(action) ? action : [action];
  const needed = (await Promise.all(actions.map(a => isReauthRequired(a, role)))).some(Boolean);
  if (!needed) return { ok: true };
  const primaryAction = actions[0];

  // Extract password from body field or custom header
  const body = req.body as Record<string, unknown> | undefined;
  const password = (body?._currentPassword as string)
    ?? (req.headers['x-reauth-password'] as string);

  if (!password) {
    reply.code(401).send({
      error: 'REAUTH_REQUIRED',
      message: 'This action requires password re-authentication.',
      action: primaryAction,
    });
    return { ok: false };
  }

  const failure = await verifyReauthPassword(req, password);
  if (failure) {
    reply.code(failure.error === 'ACCOUNT_LOCKED' ? 403 : 401).send(failure);
    return { ok: false };
  }

  // Strip password from body so it doesn't get stored or validated by Zod
  if (body?._currentPassword) {
    delete body._currentPassword;
  }

  // Mark request as already verified so hardcoded re-auth can skip
  (req as any)._reauthVerified = true;

  return { ok: true };
}

/**
 * ALWAYS-ON reauth for compliance-mandated gates. Identical password
 * verification to `enforceReauth`, but NOT gated on the admin-managed
 * action-reauth config — the password confirmation is intrinsic to the action,
 * not an opt-in policy, so it cannot be turned off.
 */
export async function enforceReauthAlways(
  action: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ ok: boolean }> {
  const body = req.body as Record<string, unknown> | undefined;
  const password = (body?._currentPassword as string) ?? (req.headers['x-reauth-password'] as string);
  if (!password) {
    reply.code(401).send({ error: 'REAUTH_REQUIRED', message: 'This action requires password re-authentication.', action });
    return { ok: false };
  }
  const failure = await verifyReauthPassword(req, password);
  if (failure) {
    reply.code(failure.error === 'ACCOUNT_LOCKED' ? 403 : 401).send(failure);
    return { ok: false };
  }
  if (body?._currentPassword) delete body._currentPassword;
  (req as any)._reauthVerified = true;
  return { ok: true };
}
