# Contributing — Documentation Sync Reference

Detailed guidance on which docs to touch when changing code. CLAUDE.md holds the **principles**; this file holds the **enumerations** that apply them. Read this when you're about to make a non-trivial code change that affects counts, modules, shared types, or any part of the public API surface.

---

## Why this file exists

Across nine documentation-audit passes (2026-04-29) we found numerical drift, EC2/PM2 references long after EC2 was removed, undocumented code surfaces (`lib/idempotency.ts`, `lib/connectivity.ts`, `lib/rfid-bridge.ts`, 5 of 26 config pages, etc.), and stale folder references (`tests/manual-test-cases/` after deletion, `routes/checklist/` after rename to `checklist-form/`). Each pass found more. The receipts live in `tasks/todo.md`.

The fix wasn't a one-time cleanup — it was a contract. This file is that contract.

---

## Change → Docs map

For every kind of code change, update every doc in the right column **in the same commit**.

### Backend

| Code change | Docs to update |
|---|---|
| **New module** in `apps/api/src/modules/<name>/` | `BACKEND_GUIDE.md` (modules table + count), `PROJECT_ARCHITECTURE.md` (module list), `future/backend/MODULES.md`, `future/backend/API_ENDPOINTS.md`, `future/overview/API_LIST.md`, `future/overview/CODEBASE_SUMMARY.md`, `CLAUDE.md` System Stats |
| **New endpoint** in existing module | `BACKEND_GUIDE.md` endpoint count, `future/backend/MODULES.md`, `future/backend/API_ENDPOINTS.md`, `future/overview/API_LIST.md` |
| **New backend `lib/` helper** | `BACKEND_GUIDE.md` libs table, `future/backend/README.md` libs table, `PROJECT_ARCHITECTURE.md` apps/api map |
| **New plugin / transport / worker** | `BACKEND_GUIDE.md` corresponding table, `future/backend/README.md` corresponding section, `PROJECT_ARCHITECTURE.md` |
| **New `config/static-routes/<surface>.routes.ts`** | `BACKEND_GUIDE.md` static-routes list, `PHASE_5_RECENT_WORK.md` § 9 |
| **`PUBLIC_GET_PATHS` change** in `plugins/auth.ts` | `BACKEND_GUIDE.md`, `future/backend/README.md` "Public paths" |
| **New `requireAnyPermission` / `enforceReauth` usage** | `BACKEND_GUIDE.md` rbac plugin entry, `future/backend/README.md` rbac entry |
| ~~**New rule-chain node** in `nodes/<category>.ts`~~ | *(removed 2026-05-17 — rule-chain subsystem torn out; N/A)* |
| ~~**New data-ingestion file**~~ | *(removed 2026-06-17 — data-ingestion module torn out, Phase 7; N/A)* |
| ~~**New `queries/*.routes.ts`** sibling~~ | *(removed 2026-06-17 — queries module torn out, Phase 7; N/A)* |
| **New `assets/{routes,services,repositories}/` file** | `BACKEND_GUIDE.md` Assets module structure, `future/backend/MODULES.md` |

### Database

| Code change | Docs to update |
|---|---|
| **New Prisma model** | Update model count in: `README.md`, `PROJECT_SUMMARY.md` (2 places), `PROJECT_ARCHITECTURE.md` (3 places: tree + ASCII diagram + security diagram), `BACKEND_GUIDE.md`, `apps/api/CLAUDE.md`, `CLAUDE.md` System Stats, `docs/index.md`, `future/overview/CODEBASE_SUMMARY.md` |
| **New Prisma enum** | Same set as model |
| **New migration** in `apps/api/prisma/migrations/` | `PROJECT_ARCHITECTURE.md` migrations table |
| **`prisma/sql/extensions.sql`** change | `PROJECT_ARCHITECTURE.md` migrations table |

### Frontend

| Code change | Docs to update |
|---|---|
| **New `<Route>`** in `main.tsx` | `FRONTEND_GUIDE.md`, `PROJECT_SUMMARY.md` route count, `future/frontend/README.md` directory map (`<Route>` count), `future/frontend/KEY_FILES.md` if non-obvious |
| **New hook** in `apps/web/src/hooks/` | `FRONTEND_GUIDE.md` Hooks tables, `future/frontend/README.md`, `future/frontend/KEY_FILES.md`, `CLAUDE.md` System Stats |
| **New lib helper** in `apps/web/src/lib/` | `FRONTEND_GUIDE.md` libs table, `future/frontend/README.md`, `future/frontend/KEY_FILES.md` |
| **New component** in `apps/web/src/components/` | `FRONTEND_GUIDE.md` Components tables, `future/frontend/README.md` directory map |
| **New mobile route** in `routes/mobile/` | `FRONTEND_GUIDE.md` Mobile section, `future/frontend/README.md`, `future/frontend/KEY_FILES.md` |
| **Folder rename** in `routes/` | `FRONTEND_GUIDE.md`, `future/frontend/README.md`, `future/frontend/KEY_FILES.md`, `future/frontend/PATTERNS.md` |
| **New PWA asset** in `apps/web/public/` | `PROJECT_ARCHITECTURE.md` "Frontend public assets" |
| **New theme preset** in `lib/themes.ts` | `README.md` themes line, `CLAUDE.md` System Stats, `FRONTEND_GUIDE.md` theming, `future/frontend/README.md` Theme model |

### Config + permissions

| Code change | Docs to update |
|---|---|
| **New config def** in `apps/api/src/modules/config/defs/` | `CLAUDE.md`, `README.md`, `PROJECT_SUMMARY.md`, `BACKEND_GUIDE.md` (multiple places), `apps/api/CLAUDE.md`, `docs/index.md`, `future/overview/CODEBASE_SUMMARY.md`. **Plus the 12-touchpoint rule** (see below). |
| **New config page** in `routes/config/` | `FRONTEND_GUIDE.md` config-pages table, `future/frontend/README.md`, `apps/web/CLAUDE.md` count |
| **New permission** in `permissions.ts` | `README.md`, `CLAUDE.md` System Stats, `PROJECT_SUMMARY.md` (2 places), `PROJECT_ARCHITECTURE.md` (3 places), `docs/index.md`, `future/overview/CODEBASE_SUMMARY.md`, `future/overview/CURRENT_STATUS.md`, `future/qa/FEATURE_CHECKLIST.md`, `future/qa/ACCEPTANCE_CRITERIA.md`, `packages/shared/CLAUDE.md` |
| **New feature privilege** | Same set as permission. Plus must include BOTH frontend visibility perm AND backend route perm in `FEATURE_TO_PERMISSION_MAP`. |
| **New reauth action** | All files that mention the reauth count |
| **New sidebar item** | `packages/shared/CLAUDE.md`, `future/qa/FEATURE_CHECKLIST.md`, `FRONTEND_GUIDE.md` Sidebar component count |
| **New audit-template / audit-action / alarm-column** | `packages/shared/CLAUDE.md` types inventory |

### 12-touchpoint rule for new config def

When adding a new config def, you must update **all twelve** of these in the same commit (memory: `feedback_config_sync.md`):

1. `apps/api/src/modules/config/defs/<name>.def.ts` — the def itself
2. `apps/api/src/modules/config/config-discovery.ts` — import + register
3. `apps/web/src/routes/config/<name>.tsx` — the page
4. `apps/web/src/routes/config/index.tsx` — registry-card entry
5. `packages/shared/src/types/sidebar-items.ts` — sidebar entry if applicable
6. `packages/shared/src/types/sidebar-privilege-map.ts` — sidebar gate
7. `packages/shared/src/types/permissions.ts` — perm if new
8. `packages/shared/src/types/feature-privileges.ts` — privilege + `FEATURE_TO_PERMISSION_MAP`
9. `packages/shared/src/types/reauth-actions.ts` — reauth if applicable
10. `apps/api/prisma/seed.ts` — seed default config row
11. `apps/api/src/plugins/auth.ts` — `PUBLIC_GET_PATHS` if endpoint is public
12. Rebuild shared: `npm run build -w @digilog/shared`

Plus: write an e2e test, append to `CHANGELOG.md`, and update count claims in CLAUDE.md System Stats.

### Native Android / RFID / offline

| Code change | Docs to update |
|---|---|
| **New native Java plugin** in `apps/android/.../java/` | `PROJECT_ARCHITECTURE.md` Android tree, `OFFLINE_SYNC_ARCHITECTURE.md` if it touches sync, `PHASE_5_RECENT_WORK.md` § 3 |
| **`Reader_Usb.jar` SDK update** | `PROJECT_ARCHITECTURE.md`, `PHASE_5_RECENT_WORK.md`, `README.md` Phase 3/5 RFID line |
| **Capacitor plugin add** in `apps/android/package.json` | `future/overview/CODEBASE_SUMMARY.md` Android section, `OFFLINE_SYNC_ARCHITECTURE.md` if it changes connectivity |
| **Change to `offline-store`, `sync-engine`, `offline-sync-service`, `connectivity.ts`, `idempotency.ts`** | `OFFLINE_SYNC_ARCHITECTURE.md`, `future/frontend/README.md` Offline section, `FRONTEND_GUIDE.md` libs, `PHASE_5_RECENT_WORK.md` § 2 + § 9 |
| **New `x-*` header convention** | `OFFLINE_SYNC_ARCHITECTURE.md`, `future/backend/API_ENDPOINTS.md` "Header conventions" |

### Tests / infra / deployment

| Code change | Docs to update |
|---|---|
| **New e2e test** in `apps/api/src/e2e/` | `BACKEND_GUIDE.md` E2E table, `future/testing/README.md` (suite count), `future/testing/TEST_INVENTORY.md` |
| **New unit/schema test** | `future/testing/README.md`, `future/testing/TEST_INVENTORY.md` |
| **New manual golden path** | `future/testing/MANUAL_TEST_GUIDE.md` |
| **New PowerShell script** in `scripts/` | `PROJECT_ARCHITECTURE.md` Repo-level Infrastructure, `tasks/EXE-PACKAGING-PLAN.md`, `docs/PHARMA_DEPLOYMENT_21CFR.md` |
| **TLS/cert change** in `certs/` | `CLAUDE.md` TLS notes, `PROJECT_ARCHITECTURE.md`, memory `reference_apk_tls_setup` |
| **New env var** in `.env.example` | `BACKEND_GUIDE.md` Environment Variables, `LOCAL_SETUP_WINDOWS.md`, `future/backend/ENV_SETUP.md` |
| ~~**`tsdb-migration/init-hypertables.sql`** change~~ | *(removed 2026-06-17 — `tsdb-migration/` + TimescaleDB gone, Phase 7; N/A)* |
| **`turbo.json` / `vitest.workspace.ts` / per-workspace `vitest.config.ts`** change | `PROJECT_ARCHITECTURE.md` Build/test infra, `future/testing/README.md` |
| **`.github/workflows/ci.yml`** change | `PROJECT_ARCHITECTURE.md` CI section, `future/testing/README.md` |

---

## Pre-deletion rule

Before deleting **any** doc or doc-folder:

1. Read every file's actual content
2. Compare line-by-line against the active doc set for unique knowledge: problem statements, design rationale, version pins, gotchas, file annotations, persona breakdowns
3. Only delete if the knowledge is **thoroughly** duplicated, not just "covered at a higher level"
4. **When in doubt, restore** — git is cheap, lost institutional knowledge isn't

### Receipts (the war story this rule prevents)

Deleting `future/` was reverted twice during the 2026-04-29 cleanup:

- `02f8108` — bulk delete of `future/` (174 files removed)
- `8677bf7` — restore of `future/backend/` + `future/frontend/` after pushback ("the future folder backend frontend files don't you think were important")
- `2c1fa50` — restore of remaining `future/{README, overview, qa, testing}/` after second pushback ("recheck each file thoroughly...only then delete")

Net: every file in `future/` turned out to hold unique knowledge — version-pinned tech stack, KNOWN-GOTCHAS taxonomy, persona-based QA cookbook, golden-path test scripts, and "why it matters" annotated file index. None of it was duplicated in current root docs at sufficient depth.

Lesson: don't trust folder names like `old/` or `future/` to mean "obsolete". Read the files.

---

## Reading order for a fresh contributor

1. `future/README.md` — entry point with reading order across the onboarding pack
2. `future/overview/CODEBASE_SUMMARY.md` — tech stack with version pins, "How to find things" cookbook
3. `future/overview/CURRENT_STATUS.md` — KNOWN GOTCHAS taxonomy
4. Role-specific subfolder of `future/` (`backend/`, `frontend/`, `qa/`, `testing/`)
5. Root deep-dives (`BACKEND_GUIDE.md`, `FRONTEND_GUIDE.md`, `OFFLINE_SYNC_ARCHITECTURE.md`)
6. `PHASE_5_RECENT_WORK.md` for the most recent architecture decisions
7. `tasks/todo.md` for the audit-pass receipts (only if you're debugging documentation drift)

The pack under `future/` is one abstraction level higher than the root `*_GUIDE.md` files — it tells you where to look, not how every detail works.

---

## Audit-pass methodology (for future drift hunts)

When asked to verify docs against live code, run this loop:

1. **Live-count sweep** (commands in CLAUDE.md "Documentation Sync Rule" section)
2. **Stale-stat regex sweep** — generate the regex from the *current* counts you just measured, search across all active docs
3. **Code-surface sweep** — `ls` every directory referenced in any doc; flag any directory whose contents have moved
4. **Folder-rename sweep** — `git log --diff-filter=R` for last N commits, propagate rename targets across docs
5. **Memory cross-check** — read recent session memories and compare claims; trust live code over memory
6. **Append a numbered audit pass** to `tasks/todo.md` with verbatim before/after for every change

The 9-pass audit on 2026-04-29 followed this loop. Subsequent passes should follow the same.
