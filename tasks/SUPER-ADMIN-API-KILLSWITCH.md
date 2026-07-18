# Super Admin API kill-switch (2026-06-11)

Global ON/OFF switch, SUPER_ADMIN-only, password-gated. Default ON.
When OFF: the SUPER_ADMIN user is frozen to a tiny allowlist (login + stay-logged-in
+ change-password + logout + the toggle itself). ADMIN users unaffected.
Enforcement keys on the CALLER's role, not per-endpoint.

## Backend
- [ ] `lib/super-admin-lock.ts` (NEW) — cached `isSuperAdminApiEnabled()` (default/fail-open ON),
      `readEnabledUncached()`, `setEnabled(enabled, userId)`, `invalidateCache()`.
- [ ] `plugins/auth.ts` — in onRequest, after the forcePasswordChange block:
      if role===SUPER_ADMIN && !enabled && path not in SA_LOCK_ALLOWED → 403 SUPER_ADMIN_API_LOCKED.
- [ ] `modules/super-admin/routes.ts` — GET /api/super-admin/api-lock (requireRole SA),
      PUT /api/super-admin/api-lock (requireRole SA + enforceReauthAlways + auditLog + invalidateCache).

## Frontend
- [ ] `hooks/use-super-admin-lock.ts` (NEW) — SWR GET for SA users; setEnabled via putWithReauth.
- [ ] `components/super-admin-lockdown.tsx` (NEW) — full-screen lockdown (re-enable w/ password + logout)
      + a reusable toggle card.
- [ ] `components/layout/app-layout.tsx` — gate: SA && locked → lockdown screen instead of <Outlet/>.
- [ ] `routes/config/index.tsx` — SA-only card to DISABLE/enable when unlocked.

## Exempt allowlist (always works for SA even when OFF)
/api/auth/me, /api/auth/logout, /api/auth/refresh, /api/auth/change-password,
/api/config/password-policy, /api/super-admin/api-lock.
(login is public → never reaches the gate.)

## Safety
- Default ON; fail-open on DB error/missing row (never brick the SA on infra blip).
- DB escape hatch: `UPDATE system_config SET config_value='{"enabled":true}' WHERE config_key='super-admin-api-access';`
- 403 code SUPER_ADMIN_API_LOCKED → api-client throws (no logout loop).

## Verify
- [ ] tsc (api + web), vite build, api tests for the gate.
- [ ] Manual: SA disable → other APIs 403, login/logout/toggle still work, re-enable restores.
- [ ] ADMIN user unaffected while OFF.
