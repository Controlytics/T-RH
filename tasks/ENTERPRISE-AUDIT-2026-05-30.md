# DigiLog — Enterprise Codebase Audit (2026-05-30)

**Method:** 6 parallel specialist review agents (code/deps, architecture, API, security, frontend, devops) + direct DB inspection + controller verification of high-impact claims. **Coverage:** strict architectural / security / quality / DB / devops pass with `file:line` evidence — **not** a line-by-line read of all ~600 files. Sub-agent line-level claims were spot-verified; one gross hallucination corrected (an agent claimed `use-core.ts` = 23,186 lines; it is **544**). Items marked *(verify)* are agent-reported and should be confirmed at the cited line before acting.

---

## Executive Summary

**Overall health score: 63 / 100.**

The app is **functional and shows substantial prior hardening** (SHA-256 hash-chained audit trail, bcrypt-12, helmet/CSP, reauth enforcement, timing-safe MQTT auth, recent permission audits). But for a **21 CFR Part 11 pharma system** it carries real, evidence-backed gaps in three buckets that pull the score down:

1. **Compliance / DR (highest risk):** the TimescaleDB (`digilog_tsdb`) telemetry — *regulated record data* — has **no scheduled/automated backup**, and the whole stack is single-node with no replication or DR plan. Credentials + the JWT secret sit **unpurged in git history**. The audit trail **hides SUPER_ADMIN actions from auditors** (§11.10(e)).
2. **Tech debt from an in-flight migration:** the A-01 asset→typed-tables cutover is ~40% done — filters now dual-write (`asset_instances` 20 rows ↔ `filters` 16 rows via mirror triggers), and several god components (`mobile-operations.tsx` 3,399 lines, `mobile-wrapper.tsx` 2,249, `filter-list.tsx` 1,901) carry transitional complexity.
3. **Waste:** **47 of 73 DB tables are empty** (feature scaffolding never used), 2 confirmed-dead frontend deps, an **abandoned + vulnerable `xlsx`** dependency duplicating `exceljs`, stale CI/docker/`.env.example` referencing retired Redis + EMQX, and ~50 MB of SQL dumps (with `password_hash`) committed under `old/`.

**Good news, verified:** DB referential integrity is clean (0 orphans across filter_details / identifiers / relationships). Much of the security surface is already mitigated. The criticals are concentrated and fixable.

---

## Findings Table (top items)

| Category | Issue | Severity | Impact | Recommendation |
|---|---|---|---|---|
| Security | `CREDENTIALS.md` + `.env.production` (DB pwd, SUPER_ADMIN pwd, JWT secret) in git history, never purged ✅verified | **Critical** | Anyone with a clone can forge JWTs indefinitely | `git filter-repo` purge + **rotate all** secrets (incl. JWT_SECRET) |
| DR/Compliance | TimescaleDB (`digilog_tsdb`) has no app/scheduled backup; in-app backup only covers `digilog_db` ✅verified (backup.repository targets DATABASE_URL only) | **Critical** | Single disk failure = total telemetry loss; §11.10(c) | Scheduled `pg_dump digilog_tsdb` + WAL archiving to 2nd location; write a DR plan |
| Security/AuthZ | `GET /api/audit` unconditionally filters out `userRole='SUPER_ADMIN'` (audit/routes.ts:73) — auditors can't see superadmin actions ✅known | **High** | §11.10(e) audit-completeness breach | Make the filter conditional on *viewer* role |
| DR | Single-node, single-DB, no replication/failover/HA | **High** | No RTO/RPO; pharma retention 3–7 yrs at risk | WAL archiving + warm standby (pg_basebackup) + documented DR |
| Dependencies | `xlsx` 0.18.5 — abandoned, 2 unfixable High CVEs (proto-pollution, ReDoS), only used in `pm-schedules/routes.ts:5`; duplicates `exceljs` ✅verified | **High** | Exploitable parse path + dead weight | Migrate pm-schedules upload to `exceljs`; remove `xlsx` |
| Dependencies | `reactflow` + `@monaco-editor/react` declared, **0 imports** in apps/web/src ✅verified | **Medium** | Bundle bloat + attack surface | Remove both from `apps/web/package.json` |
| Security | SUPER_ADMIN exempt from lockout **and** password expiry (auth.ts:248) ✅known | **High** | §11.10(g); only the 10/min login limiter guards brute-force | Enforce password-expiry for SUPER_ADMIN independently |
| Security | Auth cache 30s TTL; invalidation calls **not wired** in user disable/role-change *(verify user.service)* | **Medium** | Up-to-30s zombie access after revoke | Wire `invalidateUserAuthCache` in update/disable paths |
| Security | OAuth2 callback reflects `error`/`error_description`/`err.message` into HTML unescaped + `postMessage(..,'*')` *(verify notification-delivery/routes.ts:215,298)* | **High** | Reflected XSS on callback page | HTML-encode; replace `'*'` with explicit origin; check `event.origin` |
| API | `bulk-upload-filters` calls `validateAndBuildFilterAttributes` **per row** → `systemConfig.findUnique` ×200 for one immutable row ✅verified (I authored this) | **High** | 200 identical queries / upload | Fetch field-options **once** before the loop; pass in |
| API | Inconsistent response envelopes ({success,data} vs bare array vs {data,total,…} vs opaque object) across modules ✅sampled | **Medium** | Client fragility, no contract | Adopt one envelope; codify in a shared schema helper |
| API | Unbounded list returns: `GET /filters/retirements`, `/replacements` (bare arrays), `checklist history/responses` (no `limit` max), `/hierarchy/tree` (known) | **Medium-High** | DoS / large payloads at scale | Add pagination + `maximum` on limits |
| API | `reports/:id/pdf` & `/preview` `readFile` with no try/catch → 500 leaks server file path *(verify reports/routes.ts:57)* | **High** | Path disclosure | try/catch → 404 |
| API/Auth | 6 `notifications` routes have **no `preHandler`** permission gate (service-only scoping) *(verify notifications/routes.ts)* | **Medium** | Defense-in-depth gap | Add `requirePermission` preHandlers |
| Database | **47 / 73 tables empty** — large unused feature surface (dashboards, equipment_groups, user_groups, reports*, data_streams, qr_codes, electronic_signatures, notification_templates, …) ✅verified | **Medium** | Maintenance + schema bloat | Decide per-feature: ship, defer (document), or drop |
| Architecture | God components: `mobile-operations.tsx` 3,399 / `mobile-wrapper.tsx` 2,249 / `filter-list.tsx` 1,901 / `filter-operations.tsx` 1,744 ✅verified | **High** | Untestable, drift, fatigue-bug risk | Extract dialogs + hooks; unify mobile/desktop ops layout |
| Architecture | `filter-operations.tsx` (desktop) and `mobile-operations.tsx` are ~parallel implementations on the same `use-core` hook | **Medium** | Double-maintenance drift | Shared `FilterOperationsLayout` with `layoutMode` prop |
| Frontend | SWR `refreshInterval` polling on 15+ pages, no tab-visibility pause; god components recompute inline | **Medium** | Wasted fetches/renders on hidden tabs | `useVisibleRefreshInterval` hook; memoize derivations |
| Frontend | Hardcoded theme colors (`bg-blue-50`/`text-purple`…) violate the "unified theme" rule in filter-list.tsx *(verify)* | **Low-Med** | UI inconsistency | Use CSS theme vars / a `FILTER_SET_COLORS` map |
| DevOps | Stale `docker-compose.yml` (Redis service, postgres:16) + `.env.example` (Redis/EMQX/`digilog123` defaults) + `.github/workflows/ci.yml` (triggers wrong branch, provisions Redis + postgres:15, no TimescaleDB) ✅partially verified | **Medium** | Misleads contributors; CI effectively dead | Delete/refresh compose; fix `.env.example`; fix CI triggers+services |
| DevOps | `old/` dir (~50 MB SQL dumps **with `password_hash`** + APKs) committed; plus 2 untracked dumps in working tree ✅verified tracked | **Medium** | Secrets/PII in history; repo bloat | `git filter-repo --path old/`; gitignore `old/db-backups/*.sql` |
| DevOps | No `_prisma_migrations` in live DB; schema applied via psql directly → `prisma migrate deploy` would fail | **Medium** | Migration drift/runbook risk | Establish a verified migration runbook; baseline Prisma state |
| Security | TLS `server.key` present in repo working dir (gitignored, not committed) ✅verified keys not tracked | **Low** | Local filesystem exposure only | Move private keys out of repo root |

---

## Cleanup Report — safe to remove (verified / high-confidence)

- **Dead npm deps:** `reactflow`, `@monaco-editor/react` (apps/web — 0 imports, leftover from the 2026-05-17 rule-chain/alarm tear-out). `xlsx` (apps/api — after migrating pm-schedules to `exceljs`).
- **Stale infra files:** root `docker-compose.yml` (Redis/PG16), `.github/workflows/ci.yml` (or fix it), the Redis+EMQX blocks in root `.env.example`, `USE_EDGE_PDF` feature flag (0 prod callers) and the EMQX `USE_MOSQUITTO=false` legacy branch.
- **Committed artifacts:** `old/db-backups/*.sql` (~50 MB, contain `password_hash`), `old/apks/*.apk` — purge from history + gitignore. The 2 untracked `old/db-backups/2026-05-23*.sql` in the working tree — don't commit.
- **Empty DB tables (47):** *not* auto-drop — each is a feature decision. Cluster them: clearly-abandoned (e.g. `data_streams`, `qr_codes`, `dashboard_widgets`/`dashboards`/`dashboard_assignments`, `user_groups`/`user_group_members`, `notification_templates`/`notification_rules*`) vs. retained-by-design (`electronic_signatures`, `asset_template_versions` etc. for §11). Decide + document.
- **Dead code comments / TODO-Redis stubs** in `data-ingestion` + `notification-dispatcher` (cluster-mode rate-limit that never ships single-node).
- **Do NOT remove:** `audit-actions.ts`/`audit-templates.ts` 0-caller entries (21 CFR inspector contracts); `react-hook-form` (used by 15 files).

## Optimization Report

- **Eliminate the bulk-upload N+1:** load `filter-field-options` once before the row loop in `bulk-upload-filter.service.ts` (200 rows → 200 → **1** config query). Same pattern: cache the config read in `filter-fields.service` with a short TTL.
- **Non-ADMIN list overhead:** `GET /instances` + `/instances/tree` run `entityAssignment.findMany` + `templateAssignment.findMany` on **every** request — cache these (both tables are empty today, so it's pure waste) or short-circuit when assignment tables are empty.
- **Over-fetching:** add `select` to `super-admin` `paginatedList` (pulls full `audit_trail`/`cleaning_cycles` JSON blobs per page).
- **Frontend:** pause SWR polling on hidden tabs; memoize `treeData`/`flattenTypedTree` classification via a `Map` (O(n²)→O(n)); virtualize the filter table + hierarchy canvas for large facilities.
- **Payloads:** declare `response` schemas on `reports`/detail routes (currently `additionalProperties:true` ⇒ no field stripping + leak risk).

## Security Report (severity-ordered)

- **Critical:** (1) Credentials + JWT secret in git history — purge + rotate. (2) TLS/secret hygiene: move `server.key` out of repo; `EMQX_ADMIN_PASSWORD=public` default.
- **High:** (3) Audit hides SUPER_ADMIN from auditors. (4) SUPER_ADMIN no lockout/expiry (§11.10(g)). (5) OAuth2 callback reflected-XSS + wildcard `postMessage` *(verify)*. (6) `reports` readFile path leak *(verify)*. (7) offline-replay bypass token in `localStorage` (XSS-extractable).
- **Medium:** (8) Auth-cache invalidation not wired → 30s zombie access. (9) USER_UPDATED audit may spread plaintext `password` *(verify user.service:191)*. (10) CSP `unsafe-inline` global (Swagger). (11) X-Forwarded-Host trusted for OAuth2 redirect. (12) `notifications` routes missing preHandlers. (13) opt-in visibility ⇒ every authenticated user sees all assets.
- **Low:** dev `NODE_ENV` leaks perm/role in 403s on the LAN; Swagger public in dev; `Admin@123` documented default (seed guard mitigates).
- **Not exploitable (checked):** `$queryRawUnsafe` in `config.repository.ts` uses bind params ($1) — safe; backup module builds SQL from `information_schema`/identifier guards — review but no user-input injection found.

## Refactoring Roadmap

**Phase 1 — Critical Fixes (days):** purge git history + rotate all secrets · schedule `digilog_tsdb` backups + WAL archiving + write a DR plan · fix the SUPER_ADMIN audit filter (conditional on viewer) · enforce SUPER_ADMIN password expiry · fix OAuth2 XSS + `reports` readFile leak · wire auth-cache invalidation.

**Phase 2 — Performance (days):** bulk-upload N+1 (1 config query) · cache/short-circuit the per-request assignment queries · add `select` to over-fetching list routes · pause SWR on hidden tabs + memoize tree derivations.

**Phase 3 — Architecture (weeks):** finish A-01 (the work already in flight — migrate the mobile/offline readers with tablet QA, then drop the reverse mirror + `asset_instances` for filters) · split the 4 god components (extract dialogs/hooks; unify mobile/desktop ops) · standardize the API response envelope + pagination.

**Phase 4 — Tech-debt cleanup (ongoing):** remove dead deps (`reactflow`, `monaco`, `xlsx`) · purge `old/` from history · fix CI (branches/Redis/TimescaleDB) + `.env.example` + delete stale `docker-compose.yml` · resolve the 47 empty tables (ship/defer/drop, documented) · establish a Prisma migration runbook.

---

### Caveats / honest coverage notes
- Items tagged *(verify)* are sub-agent reports I did not personally open at the cited line — confirm before acting (agents occasionally hallucinate line numbers; one claimed 23,186 lines for a 544-line file).
- Several "findings" are **accepted trade-offs already documented** in CLAUDE.md/memory (opt-in visibility, JWT in sessionStorage, `Admin@123` dev default, SUPER_ADMIN exemptions) — listed for completeness, not as new bugs.
- This is a first-pass strict audit. A full line-by-line review of the 4 god files + the data-ingestion pipeline + the backup/restore SQL builder would likely surface more.
