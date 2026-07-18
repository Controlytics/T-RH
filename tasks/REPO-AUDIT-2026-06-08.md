# Repository Audit — 2026-06-08 (DigiLog / 21cfrlogbook)

**Scope:** 1,267 tracked files; 676 TS/TSX (api 341 · web 261 · packages 61).
**Method:** static analysis (`knip`, `depcheck`, `madge`) + reference tracing. Grounded
findings only — no fabricated inventory. 21 CFR Part 11 app → destructive changes require
sign-off; "any uncertainty → Needs Manual Review."

> ⚠️ Honesty note: this is a **tool-grounded audit of the highest-signal areas** (dead
> files, unused deps, circular deps, known dead surfaces). A literal line-by-line audit of
> every one of 676 files + an exhaustive per-endpoint security/perf audit was **not** fully
> performed this pass — those sections below are marked accordingly and need dedicated runs.

---

## Executive Summary

| Score | Value | Basis |
|---|---|---|
| Overall health | **78 / 100** | Working, well-tested, but accumulated dead surfaces from recent feature removals + some structural debt |
| Security | **~80 / 100** *(not exhaustively audited)* | RBAC + reauth + HTML sanitization + hash-chained audit + HTTPS in place; no full injection sweep done this pass |
| Performance | **~75 / 100** *(not exhaustively audited)* | No N+1 sweep done; 8 backend circular import chains; large monolith files |
| Maintainability | **72 / 100** | Dead report pages, redundant deps, circular deps, a few 1.5–2k-line files |

---

## CONFIRMED findings (reference-traced, safe)

### Dead files — frontend (feature removed last session, 0 imports)
Verified `grep` across `apps/web/src`: **zero** external imports of these.
- `apps/web/src/routes/reports/index.tsx`
- `apps/web/src/routes/reports/generate.tsx`
- `apps/web/src/routes/reports/detail.tsx`
- `apps/web/src/routes/report-templates/index.tsx`
- `apps/web/src/routes/report-templates/editor.tsx`
- `apps/web/src/routes/report-templates/components/*` (variable-tag-picker, etc.)

Reason: the **Report Templates + Generated Reports** features were removed from the sidebar
+ routes on 2026-06-08; these page files are now unreachable.
**Risk:** low (reversible via git). **Recommendation:** delete.

### Unused dependency — web (0 direct imports)
- `apps/web/package.json` → **`zod`** — not imported anywhere in `apps/web/src` (used only
  via `@digilog/shared`, which declares its own `zod`).
  **Recommendation:** remove from `apps/web/package.json`.

### Redundant dependencies — api (0 direct imports; provided transitively)
- `apps/api/package.json` → **`pg`** — not imported in `apps/api/src`; the TimescaleDB pool
  lives in `packages/db`. Redundant here.
- `apps/api/package.json` → **`pino`** — not imported directly; pulled transitively by Fastify.
  **Recommendation:** remove both from `apps/api/package.json` (low priority — harmless if kept).
  **Caveat:** verify nothing in `apps/api/dist` build scripts relies on them before removing.

---

## Circular dependencies (backend) — `madge`

**UPDATE after inspection — 6 of 8 are false positives:**
- The 6 `filter-operations.service ↔ cycle-write/* + current-state` chains are **`import type`
  only** → erased at compile time, **zero runtime cycle**. No action (fixing = pure churn).
- The 2 `data-ingestion` chains (`ingestion.service ↔ dlq-manager`,
  `mqtt-client → mqtt-handler → rpc-handler`) are **real value imports but deferred-call**
  cycles: the imported functions are only *invoked* at runtime, after both modules finish
  loading, so ESM resolves them correctly (the app runs). They sit on the **telemetry-ingest
  + MQTT critical path**. **Decision: leave as-is** — refactoring risks a critical pipeline
  for no functional benefit. Optional future fix: lazy `await import()` at call site.

Original madge output (for reference):
1. `data-ingestion/ingestion.service.ts ↔ dlq-manager.ts`
2. `data-ingestion/rpc-handler.ts → transport/mqtt-client.ts → mqtt-handler.ts` (cycle)
3–8. `filter-operations.service.ts ↔ cycle-write/{advance,bypass,start-cycle,submit-checklist,terminate-cycle}.ts` and `current-state.ts`

Cause: the cycle-write extraction left the sub-modules importing the parent service.
**Risk:** low now (no runtime break), but fragile under further refactor / can break HMR.
**Recommendation (Needs Manual Review):** invert the dependency — move shared types/helpers
the sub-files need into a `cycle-write/shared.ts` so they don't import the parent service.
Frontend: **0 circular** dependencies. ✅

---

## Known retained-on-purpose (DO NOT remove — 21 CFR)
- `packages/shared/src/types/audit-actions.ts` + `audit-templates.ts` — inspector contracts;
  zero callers by design (rule-chain/alarm + reports entries kept for historic audit rows).
- `apps/api/src/modules/reports` + `report-templates` **backend** — still present; only the
  web UI was removed. Keep unless you want the whole reporting capability gone (separate decision).
- `react-hook-form` (web) — used by 15 files (a prior audit false-positive).

---

## Unused exports / files — scoped `knip` (with false-positive triage)

**Unused FILES (src, confirmed by trace):**
- `apps/web/src/hooks/use-entity-websocket.ts` — 0 refs → **DELETED** (dead after entity removal).
- `apps/web/src/lib/action-tape/types.ts` — knip-flagged, but the action-tape module is heavily
  used; likely an `import type` false positive → **Needs Manual Review** (kept).

**Unused EXPORTS — 86 flagged, but heavy false positives:**
- **~42 are config `*Def` exports** (passwordPolicyDef … qnnNotificationsDef) — these are loaded
  via **dynamic `import()` in `config-discovery.ts`**, which knip doesn't trace. **NOT unused.**
- Test-only-used exports also appear here (tests were excluded from the knip scope).
- Remaining genuine candidates (need per-symbol tracing before removal — **Needs Manual Review**):
  `invalidateSessionAuthCache`, `computeChecksumV2`, `stopSweep`, `getClientOpId`,
  `shutdownChartRenderer`, `getFilterCore`, `clearFilterCycle`, `normalizeLimit`/`normalizePage`
  (hierarchy.service), `extractVariables`, `sendBulkNotification`, `extractTags`, `stopAutoSync`,
  `SHORT_TTL_MS`/`SYNCED_OP_RETENTION_MS`/`CACHE_LRU_CAP` (offline-store), etc.
  → These are small dead helpers; safe to prune in a focused pass with per-symbol grep, NOT in bulk.

**Naming bug found:** `apps/web/src/routes/config/notification-settings/sms-settings.tsx` exports a
component named `EmailSettingsPage` (the real one is in `email-settings.tsx`). → Needs Manual Review.

A reusable `knip.json` (scoped to ignore Android/dist) was added for future audits.

## NOT audited this pass (need dedicated runs) — marked Needs Manual Review
- **Per-endpoint API audit** (validation/authz/rate-limit/logging on each of 200+ routes).
- **DB audit**: unused tables/columns, missing indexes, N+1 — needs query-log + schema diff.
- **Security sweep**: injection/XSS/SSRF/path-traversal across all inputs.
- **Performance**: bundle analysis, re-render profiling, query timing.
- **Unused exports** across 676 files (knip ran but output was dominated by Android build
  artifacts; needs a scoped knip config to be reliable).

These are large enough to warrant their own focused sessions; doing them "by eyeball" here
would produce false positives, which is the opposite of the goal.

---

## Follow-up fixes APPLIED (2026-06-09, signed off)
- **Reauth wired on the 3 high-trust gaps:** `PUT /config/users/:userId` → new
  `UPDATE_USER_CONFIG`; retention `execute-range`/`delete-keys`/`delete-records` → reuse
  `EXECUTE_RETENTION`; device-credential `POST`/`DELETE /:entityId/token` → new
  `MANAGE_DEVICE_CREDENTIAL`. (Gate is now present + configurable via Action-Reauth, matching
  the rest of the app — challenges fire when an admin maps the action to a role.)
- **Indexes added:** `cleaning_cycles(equipment_group_id)`, `cleaning_cycles(profile_id)`,
  `filter_profiles(cleaning_profile_id)` (schema `@@index` + idempotent `CREATE INDEX`).
- **N+1:** replacement-schedule upload loop → single `createMany`.
- **Dead column dropped:** `device_credentials.device_fingerprint` (0 refs; schema + DDL).
- tsc clean (api/web/shared); Prisma client regenerated; API restarted + smoke-checked.

**Deferred (Needs Manual Review — risk > benefit right now):** hierarchy tree-walkers
(`collectDescendantIds`/`getDescendantIds`) → recursive CTE — touches hierarchy correctness on
a regulated system; warrants its own tested change. `ElectronicSignature` wire-or-retire
decision. notification-dispatcher per-row insert loop.

## Recommended SAFE auto-fixes (pending sign-off)
1. Delete the 6+ orphaned report/report-templates page files (confirmed dead).
2. Remove `zod` from `apps/web/package.json`.
3. (Optional) Remove `pg` + `pino` from `apps/api/package.json`.

Everything else → recommendation / Needs Manual Review.
