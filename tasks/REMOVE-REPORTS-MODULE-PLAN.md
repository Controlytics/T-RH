# Scoping Plan — Remove the orphaned Reports (generate/sign) + Report-Templates feature

**Status:** SCOPING ONLY (not executed). Authored 2026-07-04 from a 4-agent blast-radius audit.
**Pre-removal git tag (when executed):** `pre-reports-module-drop`.

## 1. What & why

The server-side **report generation + signing** feature (`modules/reports/`) and its **template
designer backend** (`modules/report-templates/`) are orphaned: their frontend was removed
2026-06-08 (`apps/web/src/main.tsx:92,268`, `sidebar.tsx:213`), no FE calls `/api/reports/*` or
`/api/report-templates/*`, and no active backend code imports either module. They remain registered
and reachable via direct API only. This is a clean dead-code cut in the same spirit as the Phase 6
(rule-chain/alarm) and Phase 7 (data-ingestion/TSDB) tear-outs.

The **active** report surfaces are entirely separate and MUST be preserved (see §3).

## 2. Boundary — DROP vs KEEP (the whole point)

| Surface | Verdict | Evidence |
|---|---|---|
| `modules/reports/` (service, renderers, variable-resolver, data-sources) | **DROP** | Only consumer is app.ts + 2 tests; 0 rows in `report_instances` |
| `modules/report-templates/` (routes, service) | **DROP** | Only consumer is app.ts; FE gone 2026-06-08 |
| Prisma `ReportTemplate` / `ReportTemplateVersion` / `ReportInstance` / `ReportSignature` | **DROP** | Written only by the two dropped modules |
| `modules/report-reviews/` + `ReportReview` model + `/report-reviews` FE | **KEEP** | Active submit/review/approve workflow; zero cross-import with dropped modules; no FK to dropped tables |
| Config `report-page-titles` / `report-labels` / `report-signatories` defs + `report-config.tsx` | **KEEP** | Served by `config/static-routes/*`, consumed by `report-page-wrapper.tsx` + client `lib/pdf-report.ts`; zero refs from dropped modules |
| `components/report-page-wrapper.tsx` (Audit Trail / Filter Traceability / QNN / RFID chrome) | **KEEP** | Independent of the server module |
| `FilterLifecycleReportPage` (`/filter-lifecycle-report`) | **KEEP** | Different active page (cleaning-cycles), not the template designer |
| `audit-actions.ts` / `audit-templates.ts` `REPORT_*` registry entries | **KEEP** | 21 CFR §11 inspector contract — retained-but-unemitted like UNS/RULE_CHAIN |

### Correction to fix as part of this work
Root `CLAUDE.md` claims *"Live e-signature surface uses `ReportSignature` + the hash-chained
`audit_trail`."* This is **misleading**: `ReportSignature`'s only writer is the orphaned
`reports/service.ts:253`. The live e-signature surface is `ReportReview` (plain signer columns) +
`audit_trail`. Update that line when executing.

## 3. Touch-point inventory

### 3a. Backend modules (delete outright)
- `apps/api/src/modules/reports/` (entire tree incl. `renderers/__tests__/`, `data-sources/`, `variable-resolver.ts`)
- `apps/api/src/modules/report-templates/` (entire tree)

### 3b. `apps/api/src/app.ts`
- Line 59 — `import reportTemplateRoutes ...` (delete)
- Line 363 — `app.register(reportTemplateRoutes, { prefix: '/api/report-templates' })` (delete)
- Line 365 — dynamic `app.register((await import('./modules/reports/routes.js'))...)` (delete; no static import to remove)

### 3c. Database (migration-driven — hand-author, drift-guard, NO `migrate dev`)
Drop 4 models from `schema.prisma`: `ReportTemplate`, `ReportTemplateVersion`, `ReportInstance`,
`ReportSignature` (tables `report_templates`, `report_template_versions`, `report_instances`,
`report_signatures`). Companion edits:
- Remove the 4 back-relation fields on `User` (`ReportTemplateCreator`, `TemplateVersionCreator`, `ReportGenerator`, `ReportSigner`).
- `apps/api/src/modules/users/user.repository.ts:22–25` — delete the 4 `deleteMany` cascade-cleanup lines.
- No KEEP→DROP FKs (`ReportReview` has no relations). No raw SQL touches these tables.
- Row counts: `report_instances`=0, `report_signatures`=0, `report_templates`=5, `report_template_versions`=27 (data belongs solely to the dead designer). Confirm the hard-delete is acceptable (matches prior tear-out decisions).
- Author migration per `apps/api/CLAUDE.md` "Database Migrations" (diff → strip out-of-band → hand-author → `npm run db:verify-migrations` PASS → `migrate resolve --applied` on dev/test DBs).

### 3d. Permissions (`packages/shared/src/types/permissions.ts`)
**Drop 7 (clean):** `REPORT_TEMPLATE_READ/CREATE/UPDATE/DELETE`, `REPORT_VIEW`, `REPORT_SIGN`, `REPORT_DELETE` → **109 → 102**.
**KEEP (repurposed export-only):** `REPORT_EXPORT`, `REPORT_GENERATE` — see §4 decision.
**KEEP (active report-reviews):** `REPORT_REVIEW_SUBMIT`, `REPORT_REVIEW`, `REPORT_APPROVE`.

### 3e. Reauth actions (`packages/shared/src/types/reauth-actions.ts`)
**Drop 7:** `CREATE/UPDATE/DELETE_REPORT_TEMPLATE`, `GENERATE_REPORT`, `SIGN_REPORT`, `REJECT_REPORT`, `DELETE_REPORT` → **99 → 92**.
**KEEP:** `REVIEW_REPORT`, `APPROVE_REPORT` (active report-reviews; the report-reviews reject path runs under these, NOT `REJECT_REPORT`).

### 3f. PERMISSION_TREE / derived feature-privileges (`packages/shared/src/types/permission-tree.ts`)
Remove the 9 orphaned configurable nodes in the `filter-lifecycle-report` group (lines ~550–582):
`report_templates.{view,create,edit,delete}` (4) + `reports.{generate,view,sign,delete,export}` (5).
Also remove them from `CONFIGURABLE_PRIVILEGE_ORDER` (~886). Feature-privileges (derived) **90 → 81**.
KEEP the active `cleaning_record.export` (537) and `lifecycle.export` (583) nodes.

### 3g. Default roles (`apps/api/prisma/default-roles.ts` — NOT seed.ts)
Strip orphaned grants (keep `REPORT_EXPORT`/`REPORT_GENERATE` + `REPORT_REVIEW*`):
- SUPER_ADMIN (34–36), ADMIN (73–75): remove the 7 dropped perms
- SUPERVISOR (99): remove `REPORT_TEMPLATE_READ`, `REPORT_VIEW`, `REPORT_SIGN`
- MAINTENANCE (118): remove `REPORT_TEMPLATE_READ`, `REPORT_VIEW`
- VIEWER (137): remove `REPORT_VIEW` (its only report perm)
Reconcile live `roles.permissions` rows from the updated seed afterward ("role perms stale after restore" pattern).

### 3h. Tests
- **Delete:** `modules/reports/renderers/__tests__/{chart-renderer,edge-detector,pdf-renderer}.test.ts`
- **Trim:** `e2e/phase4-perms-themes-reports.test.ts` (drop the `/api/reports` registration + `POST /generate` block, already `it.skip`'d; KEEP report-page-titles/branding/FILTER_OPERATE assertions); `tests/integration/windows-server-stack.test.ts` "Test 4" (imports pdf-renderer — already flagged stale in CLAUDE.md §5.1).
- **Update (count/snapshot):** `packages/shared/src/types/legacy-maps-derived.test.ts` (90→81 at ~52/55/60; SIDEBAR map stays); `packages/shared/src/types/__snapshots__/legacy-maps-snapshot.ts` (remove the 9 FEATURE_PRIVILEGES + FEATURE_TO_PERMISSION_MAP + PERMISSION_TREE entries); `permission-tree.test.ts` referential-integrity passes only if nodes + constants are removed together.
- **KEEP:** `report-reviews/__tests__/service.test.ts` (no cross-imports).
- Rebuild shared (`npm run build -w @digilog/shared`) before running api/web.

### 3i. npm deps (`apps/api/package.json`) — drop after `reports/` removal (verify no other importer first)
`puppeteer-core`, `@napi-rs/canvas`, `chart.js`, `chartjs-adapter-date-fns`, `dayjs` (reports-only across `apps/api/src`). Drops a large transitive tree (Chromium bindings, native canvas). `report-templates/` drops none. **`handlebars` is NOT in package.json** — stale doc claim, nothing to uninstall.

### 3j. Docs to sync (Documentation Sync Rule — verify each count against live code)
Module count **35 → 33**: root `CLAUDE.md` + `apps/api/CLAUDE.md:34` (35-module list) + `BACKEND_GUIDE.md:88–89`. Prisma model count (root CLAUDE.md "65 models" → 61; verify live `grep -cE '^model '`). Endpoint blocks: `API_REFERENCE.md:335–351`. Stack rows: `README.md:75,96`, `PROJECT_SUMMARY.md:19,76`. Phase-5 reports section: `CLAUDE.md:151,154–155`, `PHASE_5_RECENT_WORK.md:9–57,371,407–414`. Fix the `ReportSignature` "live e-signature" line (§2). `CHANGELOG.md` + a `tasks/todo.md` audit entry.

## 4. KEY DECISION — REPORT_EXPORT / REPORT_GENERATE re-gating (blocks a blind drop)

`cleaning_record.export` and `lifecycle.export` are **active** (client-side PDF export on the
cleaning-record / lifecycle pages, consumed in `cleaning-cycles/timeline.tsx`, `history.tsx`,
`filter-lifecycle.tsx`). Both have `permissions: []` and `gate: ['REPORT_EXPORT','REPORT_GENERATE']`.
Today the ONLY way to **grant** those perms to a non-SUPER_ADMIN role via the role-config picker is
the orphaned `reports.generate` / `reports.export` toggles. Removing those toggles:
- **Existing** SUPERVISOR/MAINTENANCE grants survive (baked into `default-roles.ts`).
- But there is **no longer a picker path** to grant export to another role → those export buttons
  become effectively SUPER_ADMIN + already-granted-roles only.

**Recommended (Option A):** keep the `REPORT_EXPORT`/`REPORT_GENERATE` *constants*, and make
`cleaning_record.export` / `lifecycle.export` **configurable** with grant-set
`['REPORT_EXPORT','REPORT_GENERATE']` so they become the grantable export toggles. Lowest churn;
perms 109→102, no gate rewrite. (Alt Option B: introduce a dedicated `CLEANING_EXPORT` perm, re-gate
the active nodes onto it, drop `REPORT_EXPORT`/`REPORT_GENERATE` → perms 109→100 but touches gates +
FE `can()` calls + default-roles. More churn, cleaner naming.) **Decide before executing.**

## 5. Phased execution (each phase compiles + tests green before the next)

1. **RBAC re-gate first** (Option A): flip the two active export nodes to configurable with the export grant-set; verify cleaning-record/lifecycle export still gated correctly. Commit.
2. **Delete backend modules** (`reports/`, `report-templates/`) + app.ts 3 lines + trim the 2 mixed tests + delete the 3 renderer tests. `tsc` clean.
3. **Shared RBAC trim**: drop 7 perms + 7 reauth + 9 tree nodes + CONFIGURABLE_PRIVILEGE_ORDER; update `legacy-maps-derived.test.ts` + `legacy-maps-snapshot.ts`; `npm run build -w @digilog/shared`; permission-tree/legacy-maps tests green.
4. **Default roles**: strip orphaned grants; reconcile live `roles.permissions`.
5. **DB migration**: drop 4 models + 4 User relations + user.repository cascade lines; hand-author migration; `npm run db:verify-migrations` PASS; `migrate resolve --applied` on dev/test.
6. **npm deps**: uninstall the 5 (verify no stray importer); `npm install`; confirm bundle shrink.
7. **Docs sync** (§3j) + CHANGELOG + memory + todo audit entry.

## 6. Verification
- `npx tsc -p apps/api/tsconfig.json --noEmit` = 0; `apps/web` tsc = 0; shared build clean.
- Full api suite (expect ~876 minus the deleted/trimmed report tests, 0 failed) + web suite (373).
- `npm run db:verify-migrations` PASS (drift guard).
- Smoke: cleaning-record + filter-lifecycle PDF export still works for a granted role; report-reviews submit/review/approve unaffected; Audit Trail / Filter Traceability chrome (report-page-wrapper) renders.
- Grep sweep: `git grep -nE "modules/reports/|modules/report-templates/|REPORT_TEMPLATE_|REPORT_SIGN\b|GENERATE_REPORT|renderPdf|buildHtml"` returns only doc/changelog history.

## 7. Risks & mitigations
- **REPORT_EXPORT/GENERATE grant path** (§4) — the one real trap; handle in Phase 1 before removing nodes.
- **Frozen-snapshot drift** — remove nodes AND constants together or `permission-tree.test.ts` referential-integrity fails (that's the guardrail working).
- **Data loss** — `report_templates`(5)/`report_template_versions`(27) are destroyed; accepted per the orphaned-feature + prior-tear-out precedent. Tag `pre-reports-module-drop` first; the pre-deletion rule requires reading each file for unique knowledge before deleting.
- **`dayjs` uninstall** — double-check no non-reports importer before removing (agent grep says reports-only, but verify at execution).

## 8. Effort
~½ day. Mostly mechanical (mirrors Phase 6/7). The only judgement call is the §4 re-gate; everything
else is delete + count-sync + a straightforward drop migration.
