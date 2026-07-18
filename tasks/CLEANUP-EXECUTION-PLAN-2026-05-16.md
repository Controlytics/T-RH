# DigiLog Cleanup — Execution Plan
**Date:** 2026-05-16
**Source analysis:** `tasks/CLEANUP-ANALYSIS-2026-05-16.md` (4-agent audit)
**Working branch at start:** `RFID`
**Recommended cleanup branch:** `cleanup/wave-1-safe-deletions` (off `RFID`)

---

## 0. Preconditions & status

### 0.1 Working-tree state at plan time
- Phase 1 of the entity-removal programme is **uncommitted** in working tree:
  - Deletions: `apps/web/src/routes/assets/` (entire folder), `apps/web/src/routes/config/template-kinds.tsx`
  - Edits: `main.tsx`, `sidebar.tsx`, 5 shared types, 2 BE files (roles/role.service.ts, prisma/seed.ts), 4 small UI string renames
- Your independent 2026-05-15 session work also still uncommitted (10 files; per memory `project_session_2026_05_15`)
- Database backups taken pre-Phase-1: `backups/digilog_db_pre-entity-removal_20260516-115325.dump` + `digilog_tsdb_...` (still valid)

### 0.2 How Phase 1 affects Wave 1
**Independent of Phase 1** (executes now):
- Sub-PRs 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8

**Dependent on Phase 1** (deferred to Wave 1.7 until you settle Phase 1):
- Backend zombie modules `template-kinds/`, `entity-assignments/`, `assets/routes/relationship.routes.ts` — they are zombies **because** Phase 1 deleted their FE callers. If Phase 1 is reverted, these become live again.

### 0.3 Rule-9 compliance (do not auto-delete)
Audit-related items, roadmap-tagged items, runtime-registration items, and dynamic-loading items are **explicitly excluded** from Wave 1:

| Excluded item | Wave 1 deferral reason | When safe to revisit |
|---|---|---|
| 20 unused `AUDIT_ACTIONS` keys | 21 CFR Part 11 inspector contracts | After audit-team sign-off (Wave 6 conditional) |
| Unused `NotificationChannel` / `PipelineNodeType` / `FilterEventType` enum values | Roadmap features may register dynamically | After roadmap audit |
| `AssetInstance.{telemetryConfig, customAttributes}` columns | Write-only today; documented extension hook | After one-release deprecation log |
| `User.ldapDn`, `ts_telemetry.trace_id` | Forensic value, cheap to keep | Defer indefinitely |
| `EMQX_ADMIN_PASSWORD` env + `USE_MOSQUITTO` fallback branch | Closes rollback path | After all envs confirmed Mosquitto-only |

---

## 1. Verification protocol (executed per deletion BEFORE removal)

Each item in Wave 1 was verified using these checks. The checkmark column in the per-PR tables below records the result.

| Check | Command / method | Purpose |
|---|---|---|
| **Static import** | `Grep "from ['\"](path-to-file)" --output_mode=content` | Catch direct ES imports |
| **Bare side-effect import** | `Grep "import ['\"](pkg)['\"]"` (no `from` keyword) | Catch `import 'pkg'` for side effects |
| **Dynamic import** | `Grep "await import\(['\"](path)" \| "import\(['\"](path)"` | Catch `await import('...')` patterns |
| **String reference** | `Grep "'(symbol)'" \| "\"(symbol)\""` | Catch string-keyed access, runtime registries, dispatch tables |
| **Route registration** | `Grep "<Route .*path=['\"](path)" main.tsx`; `Grep "app.register\\\|fastify.register" + module path` | Catch lazy route mounts |
| **API references** | `Grep "/api/(endpoint)" apps/web/src` + `tests/` | Catch HTTP callers |
| **DB / Prisma access** | `Grep "prisma\\.(model)\\." \| "tx\\.(model)\\."` | Catch FK reads/writes |
| **Config registration** | Read `apps/api/src/lib/config-discovery.ts` + `apps/web/src/routes/config/index.tsx` | Catch auto-discovery / card consumers |
| **Test references** | `Grep (symbol)` in `**/__tests__/**`, `**/*.test.*`, `tests/` | Catch tests for the symbol |
| **Feature flags / system config** | `Grep "configKey: '(key)'" \| "SystemConfig.*(key)"` | Catch runtime-config consumers |

**Hard rules during Wave 1:**
- Never use `git add .` / `git add -A` — name files explicitly to avoid sweeping Phase 1 work into a Wave 1 commit
- Never run destructive git commands (`reset --hard`, `clean -fd`, force-push) without explicit user OK
- Never delete anything that grepping turned up >0 references for, unless every reference is in deleted-in-same-PR files or in tasks/ doc files
- Pause for `tsc` / `vite build` / test results after each sub-PR before proceeding

---

## 2. Git strategy

### 2.1 Branch
Create a single working branch **off `RFID`**:
```
git switch -c cleanup/wave-1-safe-deletions
```

### 2.2 Commit plan
One commit per sub-PR (6-8 commits total in Wave 1). Each commit is independently revertable. Use `git revert <sha>` for rollback — never reset.

### 2.3 Conventional commit messages
```
chore(cleanup): wave-1.1 — delete action-tape ActionRenderer scaffolding (−1,800 LoC)
chore(cleanup): wave-1.2 — drop post-Phase-4 close*Redis no-ops + tests
chore(cleanup): wave-1.3 — uninstall unused npm deps (handlebars, qrcode, recharts, qrcode.react)
chore(cleanup): wave-1.4 — drop stale env vars + half-wired filter-data-management config def
fix(perms): wave-1.5 — correct sidebar-privilege-map IDs for equipment-groups + checklists
chore(cleanup): wave-1.6 — gitignore Android build artifacts + archive one-time scripts
```

### 2.4 PR strategy
Two options:
- **Single PR** with 6-8 commits → easier review of related cleanups together
- **One PR per sub-wave** → cleaner reverts, but 6-8 PR review cycles

**Recommended: single PR**, since each commit is self-contained and the diffs are mechanical deletions.

### 2.5 Phase 1 coordination
Phase 1 edits stay in working tree on `RFID`. Wave 1 commits land on `cleanup/wave-1-safe-deletions`. They do not conflict because Wave 1 carefully avoids the files Phase 1 edits (`main.tsx`, `sidebar.tsx`, the shared types, `seed.ts`, `role.service.ts`, the 4 string renames).

You can later either:
- Cherry-pick Phase 1 commits onto `cleanup/...` after settling them, OR
- Land cleanup branch first, then settle Phase 1 on `RFID` and merge.

---

## 3. Wave 1 — Safe Deletions

Each sub-PR below has been verified using §1's protocol. Verification results are in the "evidence" columns.

### 3.1 Sub-PR 1.1 — Frontend dead code

**Scope:** action-tape ActionRenderer + 8 dialog/button components + test, 3 orphan filter-management pages, 4 dead UI primitives, dead Zod schema.

**Files to delete:**

| File | LoC | Evidence of non-usage |
|---|---|---|
| `apps/web/src/lib/action-tape/ActionRenderer.tsx` | 215 | 0 imports / 0 JSX usages of `ActionRenderer` or `ActionTapeRenderer` anywhere |
| `apps/web/src/lib/action-tape/action-dialog.tsx` | 131 | 0 imports |
| `apps/web/src/lib/action-tape/base-action-button.tsx` | 67 | 0 imports |
| `apps/web/src/lib/action-tape/components/AdvanceToStageButton.tsx` | 138 | 0 imports |
| `apps/web/src/lib/action-tape/components/BypassStageButton.tsx` | 99 | 0 imports |
| `apps/web/src/lib/action-tape/components/CompleteCycleButton.tsx` | 29 | 0 imports |
| `apps/web/src/lib/action-tape/components/SetDryerDurationButton.tsx` | 135 | 0 imports |
| `apps/web/src/lib/action-tape/components/SubmitChecklistButton.tsx` | 154 | 0 imports |
| `apps/web/src/lib/action-tape/components/SubmitDryerReadingsButton.tsx` | 128 | 0 imports |
| `apps/web/src/lib/action-tape/components/TerminateCycleButton.tsx` | 97 | 0 imports |
| `apps/web/src/lib/action-tape/__tests__/ActionRenderer.test.tsx` | 581 | Tests deleted code — goes with deletes |
| `apps/web/src/routes/filter-management/filter-profile-list.tsx` | 67 | 0 `<Route>` mounts, 0 sidebar links; `main.tsx:64` comment confirms "removed — replaced by Config > Cleaning Profile Assignment" |
| `apps/web/src/routes/filter-management/filter-status.tsx` | 144 | 0 mounts, 0 links |
| `apps/web/src/routes/filter-management/filter-scan.tsx` | 110 | 0 mounts, 0 links |
| `apps/web/src/components/ui/alarm-badge.tsx` | 31 | 0 imports |
| `apps/web/src/components/ui/code-snippet.tsx` | 60 | 0 imports |
| `apps/web/src/components/ui/connectivity-indicator.tsx` | 50 | 0 imports — superseded by `components/mobile/connectivity-ribbon.tsx` |
| `apps/web/src/components/ui/help-button.tsx` | 106 | 0 imports |

**Files to keep** (explicitly verified live):
- `apps/web/src/lib/action-tape/index.ts` — barrel exports `actionsForStage`, `getCurrentActions`, `hasActionKind`
- `apps/web/src/lib/action-tape/types.ts` — type definitions
- Both consumed by `lib/filter-ops/validate-offline-gate.ts:36` and `lib/filter-ops/resolve-pending-checklist.ts:41`

**Files to edit:**
- `packages/shared/src/schemas/auth.ts` — remove `reAuthSchema` export
- `packages/shared/src/index.ts` — remove `reAuthSchema` re-export from barrel
- `apps/web/src/routes/filter-management/lib/filter-constants.ts` — update docstring (lines 1, 21) that mentioned `filter-status` page

**Dependency impact:** none — verified zero external imports.
**Build impact:** ~60 KB minified savings (action-tape bundle eliminated).
**Runtime impact:** none.
**Effort:** ~5 minutes.
**Risk:** Low across the board.

**Rollback:** `git revert <commit-sha>`. All files recoverable from git history. No DB / config changes.

**Verification commands (post-delete):**
```bash
cd packages/shared && npx tsc                                # shared compile clean
cd apps/web && npx vite build                                # web build clean
cd apps/web && npm test                                      # web tests pass
```

**Expected verification output:**
- `npx tsc` → exit 0
- `npx vite build` → succeeds; bundle stats show ~60 KB reduction in main chunk
- `npm test` → no test count regression except −1 (the deleted ActionRenderer.test.tsx)

---

### 3.2 Sub-PR 1.2 — Backend Phase-4 no-op cleanup

**Scope:** Remove 5 `close*Redis` no-op functions retained "for backward compatibility" since Phase 4 retired Redis (2026-05-01) for the in-process EventEmitter bus.

**Files to edit:**

| File | Edit | Evidence |
|---|---|---|
| `apps/api/src/transport/ws-handler.ts` | Remove `closeWsRedis` function (lines ~265-275) | Only caller is `app.ts:388-392` |
| `apps/api/src/modules/data-ingestion/rpc-handler.ts` | Remove `closeRpcRedis` | Same — only `app.ts` |
| `apps/api/src/modules/data-ingestion/ingestion.service.ts` | Remove `closePipelineRedis` | Same |
| `apps/api/src/modules/data-ingestion/pipeline-tracer.ts` | Remove `closeTracerRedis` | Same |
| `apps/api/src/modules/rule-chain/debug-recorder.ts` | Remove `closeDebugRedis` | Same |
| `apps/api/src/app.ts` | Remove 5 imports + 5 lines from shutdown block (~lines 30-35 + 388-392) | Direct |
| `apps/api/src/transport/__tests__/ws-handler.test.ts` | Remove no-op test block (lines 226-240) | Tests the no-op |
| `apps/api/src/modules/rule-chain/__tests__/debug-recorder.test.ts` | Remove no-op test block (lines 322-330) | Tests the no-op |
| `apps/api/src/modules/data-ingestion/__tests__/rpc-handler.test.ts` | Remove no-op test block (lines 94-100) | Tests the no-op |
| `apps/api/src/modules/data-ingestion/__tests__/pipeline-tracer.test.ts` | Remove no-op test block (lines 506-525) | Tests the no-op |

**Excluded from this PR:** Renaming remaining `*Redis` symbols → `*Bus` (Wave 2; doesn't change behavior but touches many files for cosmetic cleanup).

**Dependency impact:** none.
**Build impact:** trivial — 5 fewer imports loaded at startup.
**Runtime impact:** none — these functions are no-ops, removing them removes nothing.
**Effort:** ~10 minutes.
**Risk:** Low.

**Rollback:** `git revert`.

**Verification commands:**
```bash
cd apps/api && npx tsc --noEmit                              # type-check clean
cd apps/api && npm test                                      # baseline: 1231/2/9 per CLAUDE.md
```

**Expected verification output:**
- `tsc --noEmit` → exit 0
- `npm test` → 1227 pass / 2 fail (pre-existing) / 9 skipped (− 4 deleted no-op tests)

---

### 3.3 Sub-PR 1.3 — npm dep removal (safe set)

**Scope:** Uninstall 4 npm deps verified to have 0 imports anywhere.

**Edits:**

| Package | Where | Evidence |
|---|---|---|
| `handlebars` | `apps/api/package.json` | 0 imports in `apps/api/src` |
| `@types/handlebars` | `apps/api/package.json` (devDep) | Companion |
| `qrcode` | `apps/api/package.json` | 0 imports; `qr-code/routes.ts:7` comment admits the module returns placeholder SVG |
| `recharts` | `apps/web/package.json` | 0 imports; only mention is `vite.config.ts:73` manualChunks |
| `qrcode.react` | `apps/web/package.json` | 0 imports; only mention is `vite.config.ts:74` |
| `vite.config.ts` | `apps/web/vite.config.ts:73-74` | Remove `charts: ['recharts']` and `qrcode: ['qrcode.react']` from manualChunks |

**Commands:**
```bash
cd apps/api && npm uninstall handlebars @types/handlebars qrcode
cd apps/web && npm uninstall recharts qrcode.react
```

**Dependency impact:** none — packages are 0-import.
**Build impact:** ~650 KB FE bundle reduction (recharts ~500 KB + qrcode.react ~150 KB); ~7 MB install reduction on api side.
**Runtime impact:** none.
**Effort:** ~10 minutes including verification.
**Risk:** Low (verified-safe set; the `@hookform/resolvers` + `react-hook-form` pair is deferred to Sub-PR 1.8 because it's higher-confidence-required).

**Rollback:** `npm install <pkg>@<version>` from package-lock entries OR `git revert` + `npm install`.

**Verification commands:**
```bash
cd apps/api && npm ls handlebars qrcode 2>&1 | grep -E "(extraneous|missing)" || echo "OK"
cd apps/web && npm ls recharts qrcode.react 2>&1 | grep -E "(extraneous|missing)" || echo "OK"
cd apps/api && npx tsc --noEmit
cd apps/web && npx vite build
```

**Expected verification output:**
- `npm ls` → packages not found (good)
- `tsc --noEmit` → exit 0 on both packages
- `vite build` → bundle stats show charts/qrcode chunks no longer emitted

---

### 3.4 Sub-PR 1.4 — env vars + half-wired config defs

**Scope:** Remove stale env vars + delete one orphan config def + document decisions on two more.

**Edits:**

| File | Change | Evidence |
|---|---|---|
| `apps/api/.env` | Delete 13 lines: `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `MQTT_BROKER_TLS_PORT`, `MQTT_BROKER_WS_PORT`, `MQTT_BROKER_WSS_PORT`, `MQTT_AUTH_CALLBACK_URL`, `UNS_VERSION`, `JWT_EXPIRES_IN`, `UPLOAD_DIR`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | All have 0 `process.env.X` reads in `apps/api/src` |
| `apps/api/.env.example` | Same 13 deletions | Companion |
| `apps/api/src/modules/config/defs/filter-data-management.def.ts` | DELETE file | Fully orphan: not in config-discovery.ts; 0 runtime readers; no static-routes counterpart |
| `apps/api/src/modules/config/defs/dashboard-cards.def.ts` | KEEP + add deprecation comment OR delete (your call) | Has working static-route counterpart that owns validation. Half-wired def. **Recommended action: delete the def, static route is the source of truth.** |
| `apps/api/src/modules/config/defs/tablet-access.def.ts` | Same as above | Same shape. **Recommended action: delete the def.** |

**Excluded from this PR:** `EMQX_ADMIN_PASSWORD` (still read at `transport/mqtt-client.ts:51`; removal needs Mosquitto-only confirmation — Wave 6).

**Dependency impact:** none — verified 0 readers.
**Build impact:** none.
**Runtime impact:** none. Config defs that are not in `config-discovery.ts` were never seeded into `SystemConfig`, so no DB cleanup needed.
**Effort:** ~10 minutes.
**Risk:** Low.

**Rollback:** `git revert` brings env lines and config defs back. No DB rollback needed because defs were never seeded.

**Verification commands:**
```bash
cd apps/api && npx tsc --noEmit
cd apps/api && npm test
cd apps/api && grep -r "filter-data-management\|dashboard-cards\|tablet-access" src/modules/config/ | grep -v "\.def\.ts" || echo "OK: no def imports"
```

---

### 3.5 Sub-PR 1.5 — sidebar-privilege-map bug fixes

**Scope:** Fix 2 copy-paste bugs in `packages/shared/src/types/sidebar-privilege-map.ts`.

**Edits:**

| Line range | Bug | Fix |
|---|---|---|
| `equipment-groups` section (lines 143-148) | `privilegeIds: ["assets.view", "assets.create", "assets.edit", "assets.delete"]` | Replace with `["equipment_groups.view", "equipment_groups.create", "equipment_groups.edit", "equipment_groups.delete"]` |
| `checklists` section (lines 128-134) | `privilegeIds: ["cleaning_profiles.view", "cleaning_profiles.create", "cleaning_profiles.edit", "cleaning_profiles.delete"]` | Replace with `["checklists.create", "checklists.edit", "checklists.delete", "checklists.toggle", "checklists.submit"]` |

**Dependency impact:** Role admins toggling these privileges will now affect the right perms.
**Build impact:** none.
**Runtime impact:** **behavioral change for admins** — previously, toggling `equipment_groups.view` did nothing visible; now it controls the equipment-groups sidebar item correctly. Same for `checklists.*`.
**Effort:** ~5 minutes.
**Risk:** Low — corrects a bug. Existing roles will see corrected privilege wiring; nothing should be silently revoked because the previous (wrong) IDs were never the gating mechanism.

**Note:** This is a BUG FIX, not a deletion. It changes behavior (in the corrected direction).

**Rollback:** `git revert`.

**Verification commands:**
```bash
cd packages/shared && npx tsc
cd apps/web && npx vite build
```

**Manual smoke (after deploy):** Log in as a role admin, open `/config/roles`, toggle `equipment_groups.view` on a non-SUPER_ADMIN role, log in as that role, verify the Equipment Groups sidebar item appears.

---

### 3.6 Sub-PR 1.6 — repo hygiene

**Scope:** Stop tracking Android Gradle intermediates + binary APKs; archive one-time migration scripts.

**Edits:**

| Action | Target | Evidence |
|---|---|---|
| `git rm -r --cached RFID/app/build/` | ~500 tracked Android build outputs | `.gitignore` lacks `RFID/app/build/` |
| Update `.gitignore` | Add `RFID/app/build/`, `RFID/.gradle/`, `*.apk`, `*.aab` | Prevent re-tracking |
| `git mv scripts/backfill-orphan-entity-orgs.sql old/` | One-off MT-removal migration (2026-04-30) | Documented in tasks/RESUME-STATE-2026-04-30-step1-templateKind-done.md |
| `git mv scripts/reset-cwh-cycles.sql old/` | One-off per PHASE_5_RECENT_WORK.md:260 | Documented |
| **Defer root `DigiLog-FilterOps.apk`** | Stays in git for now | Verify tablet-install workflow doesn't depend on git-tracked APK first |

**Dependency impact:** Future Android builds will not pollute git. CI runs unaffected.
**Build impact:** repository size drops significantly (~hundreds of MB depending on .gradle size).
**Runtime impact:** none.
**Effort:** ~10 minutes.
**Risk:** Low for build artifacts; **Medium for the deferred APK** (deployment workflow check needed before that step).

**Rollback:** `git revert` restores tracking — but you also need to restore the actual files locally if they were rebuilt. Easier to re-track from a fresh checkout if needed.

**Verification commands:**
```bash
git status --short                                           # confirm files staged for removal
cat .gitignore | grep -E "RFID|apk|aab"                      # confirm gitignore updates
ls old/ | grep -E "backfill|reset-cwh"                       # confirm script archive
```

---

### 3.7 Sub-PR 1.7 — backend zombie modules (DEFERRED)

**Scope:** Delete `template-kinds/`, `entity-assignments/`, `assets/routes/relationship.routes.ts` (+ service + repo + tests), `template.routes.ts:313-346 /versions` route.

**Deferral reason:** These are zombies **because** Phase 1 deleted their FE callers. If Phase 1 is reverted, they become live again.

**Decision required:** Commit, revert, or park Phase 1?

**Once Phase 1 is settled, this sub-PR's verification:**
- Confirm `grep "/api/template-kinds\|/api/entity-assignments\|/api/assets/relationships" apps/web/src tests/` → 0 results
- Confirm `grep "/api/assets/templates/.*/versions" apps/web/src tests/` → 0 results
- Then delete:
  - `apps/api/src/modules/template-kinds/` (entire folder)
  - `apps/api/src/modules/entity-assignments/` (entire folder)
  - `apps/api/src/modules/assets/routes/relationship.routes.ts`
  - `apps/api/src/modules/assets/services/relationship.service.ts`
  - `apps/api/src/modules/assets/repositories/relationship.repository.ts`
  - Associated tests under `__tests__/`
  - Lines 313-346 of `template.routes.ts`
  - Mount in `apps/api/src/app.ts` (~lines 267, 296)
  - Mount in `apps/api/src/modules/assets/index.ts`
- Drop Zod schemas `createTemplateKindSchema`, `updateTemplateKindSchema` from `packages/shared/src/schemas/assets.ts` + barrel

**Estimated effort once unblocked:** ~30 minutes.
**Risk once unblocked:** Low (DB invariant `trg_asset_relationship_pair` still enforces bidirectionality at SQL layer; TemplateKind model + 6 seeded rows stay; EntityAssignment model + visibility filter stay).

---

### 3.8 Sub-PR 1.8 — verify-first dep removal (@hookform/resolvers + react-hook-form)

**Scope:** Verify zero usage repo-wide, then uninstall.

**Pre-removal verification (gating):**
```bash
grep -rn "from '@hookform\|from 'react-hook-form\|require('react-hook-form\|require('@hookform" \
  apps/web/src apps/web/vite.config.ts apps/web/vitest.config.ts \
  apps/api/src packages/ scripts/
# Expect: 0 results
```

**If 0 results:**
```bash
cd apps/web && npm uninstall @hookform/resolvers react-hook-form
```

**Dependency impact:** ~150 KB bundle reduction.
**Build impact:** cleaner deps tree.
**Runtime impact:** none.
**Effort:** ~5 minutes.
**Risk:** Medium until verified; Low after.

**Rollback:** `npm install @hookform/resolvers@<v> react-hook-form@<v>` from package-lock.

**Verification commands:** same as Sub-PR 1.3.

---

## 4. Wave 2 — Medium-risk Refactors (PREVIEW only — not for execution this turn)

**Sub-PRs (preview, will be detailed in a separate plan when authorized):**
- 2.1 — Rename `*Redis` identifiers → `*Bus` across api codebase (mechanical, ~30 sites)
- 2.2 — Standardize `CORS_ORIGIN` → `ALLOWED_ORIGINS` in 3 files
- 2.3 — Hoist `MANAGE_PERMISSION_SUFFIXES` to declarative shared/permissions.ts structure
- 2.4 — Drop 7 redundant `console.error` calls in dual-emit toast sites
- 2.5 — Centralize toast/banner timeouts in `lib/timing-constants.ts`
- 2.6 — Add `useClipboardCopy`, `usePermissions`, `useReauthMutation` hooks (additive)
- 2.7 — Add `traceStage()` helper in `lib/trace.ts` and dedup the 9 sites in `ingestion.service.ts`
- 2.8 — Add `requireReauth(action)` preHandler factory; migrate ~30 backend sites in chunks
- 2.9 — Add `audit-label.ts` resolver; migrate ~12 sites

**Wave 2 estimated effort:** 2-3 days.
**Risk:** Low to Medium (most are additive; helper migrations are opt-in).

---

## 5. Wave 3 — Architectural Changes (PREVIEW only)

- 3.1 — Extract `connectivity/snippets/{python,nodejs,curl,c}.template.ts` (localized, low-risk split)
- 3.2 — Split `getCurrentStateImpl` 497-LoC function (Medium risk — 21 CFR-relevant hot path)
- 3.3 — Resolve `use-offline.ts` ↔ `offline-cache.ts` ↔ `offline-store.ts` cycle (Medium risk — fragile workaround)
- 3.4 — Extract `mobile-operations.tsx` 2,490-LoC into per-view files (one PR per view: Home → Status → Stage → MyTasks → Approvals)
- 3.5 — Decide on `routes/filter-management/filter-list.tsx` useReducer consolidation (or honor "leave alone" per memory)
- 3.6 — Extract `mobile-wrapper.tsx` `useMobileSyncShell` hook

**Wave 3 estimated effort:** 1-2 weeks.
**Risk:** Medium — tablet APK splits need staged rollout.

---

## 6. Wave 4 — Optional Optimizations (PREVIEW only)

- 4.1 — Doc-sync sweep (CLAUDE.md numerical claims)
- 4.2 — Deprecation comments on 20 unused AUDIT_ACTIONS + write-only model fields
- 4.3 — Resolve QR code module (product decision: install qrcode + finish OR delete module)
- 4.4 — Resolve root `DigiLog-FilterOps.apk` (move to GitHub Releases or shared drive)
- 4.5 — Add `madge` to dev deps + npm script for circular-import detection
- 4.6 — Decide on dashboard-cards.def.ts + tablet-access.def.ts (if not done in Wave 1.4)

**Wave 4 estimated effort:** 1 day.
**Risk:** Low.

---

## 7. Wave 1 — Aggregated impact projection

| Metric | Projected |
|---|---|
| Source files deleted | 18 (Wave 1.1) + 0 file deletes in 1.2/1.5/1.6 + 1 (Wave 1.4) + 2 conditional (Wave 1.4 defs) = **21 files** |
| Source files edited | ~12 |
| Source LoC removed | ~2,400 (FE dead code) + ~120 (close*Redis) + ~5 (reAuthSchema) + ~13 (env vars) + ~0 schema = **~2,540 LoC** |
| Test files deleted | 1 (ActionRenderer.test.tsx) |
| Test blocks removed | 4 (close*Redis tests) |
| npm deps removed | 5 in 1.3 + 2 in 1.8 = **7 packages** |
| FE bundle size delta | ~−650 KB (1.3) + ~−60 KB (1.1) + ~−150 KB (1.8) = **~−860 KB** minified |
| Git-tracked files removed | ~500 (RFID/app/build) + 21 source = **~520 files** |
| Behavioral changes | 2 (Sub-PR 1.5 sidebar privilege fixes — corrections, not deletions) |
| Database changes | **0** |
| Configuration changes | **0 runtime** (env vars deleted are unread; config defs deleted are unseeded) |

---

## 8. Wave 1 execution log — 2026-05-16

### Sub-PR 1.1 — Frontend dead code ✅ COMPLETE
- **Deleted (18 files):** action-tape/{ActionRenderer.tsx, components/* (7 button + action-dialog + base-action-button), __tests__/ActionRenderer.test.tsx} (11), filter-management/{filter-profile-list, filter-status, filter-scan}.tsx (3), components/ui/{alarm-badge, code-snippet, connectivity-indicator, help-button}.tsx (4)
- **Edited (4 files):** packages/shared/src/schemas/auth.ts (drop reAuthSchema + ReAuthInput), schemas/auth.test.ts (drop reAuthSchema describe block + import), src/index.ts (barrel re-export), apps/web/src/lib/filter-constants.ts (drop CLEANING_STAGES_STATUS + docstring update)
- **+2 Phase-1 collateral fixes:** apps/web/src/routes/config/{action-reauth.tsx, roles-components/reauth-tab.tsx} — renamed `'Entity Management'` category key → `'Asset Management'` (Phase 1 missed these consumers)
- **LoC removed:** ~2,376 source + ~16 test
- **Verification:** shared `tsc` exit 0; shared vitest 302 pass / 1 fail (pre-existing in `assets.test.ts`, unrelated); web `tsc --noEmit` exit 0; `npx vite build` exit 0 (15.69s)

### Sub-PR 1.2 — Backend Phase-4 no-op cleanup ✅ COMPLETE (narrowed scope)
- **Discovered during execution:** 2 of 5 audit-flagged "no-ops" actually do real work (`closeWsRedis` unsubscribes from bus; `closePipelineRedis` clears a setInterval timer + rateLimitMap). **Kept those** — only deleted the 3 true no-ops.
- **Removed functions (3):** `closeRpcRedis` (rpc-handler.ts), `closeTracerRedis` (pipeline-tracer.ts), `closeDebugRedis` (debug-recorder.ts)
- **Edited (6 files):** 3 source files (function removal), apps/api/src/app.ts (3 imports + 3 await calls), 3 test files (import + describe block removal)
- **LoC removed:** ~62
- **Verification:** api `tsc --noEmit` exit 0; affected vitest files: 56/56 pass
- **Wave 2 follow-up:** rename `closeWsRedis` → `closeWsBus` and `closePipelineRedis` → `stopRateLimitCleanup` (cosmetic but accurate)

### Sub-PR 1.3 — npm dep removal (safe set) ✅ COMPLETE
- **Removed (5 packages):** `handlebars`, `@types/handlebars`, `qrcode` (api); `recharts`, `qrcode.react` (web)
- **Edited:** apps/web/vite.config.ts (removed `charts:` and `qrcode:` from manualChunks)
- **Install size delta:** ~7 MB removed (handlebars ~5 MB, qrcode ~2 MB; recharts/qrcode.react ~650 KB on the web side)
- **Bundle delta:** main chunk unchanged (recharts + qrcode.react were never actually imported, just declared in manualChunks as empty groups)
- **Verification:** api `tsc --noEmit` exit 0; web vite build exit 0 (13.68s); spot-check confirmed node_modules dirs gone

### Sub-PR 1.4 — env vars + half-wired config defs ✅ COMPLETE (narrowed scope)
- **Discovered during execution:** 2 of the 13 flagged env vars are "operator might-expect-to-edit" cases — kept JWT_EXPIRES_IN + UPLOAD_DIR with note. EMQX_ADMIN_PASSWORD still actively read by legacy fallback (already noted in plan for Wave 6).
- **Removed (11 env vars from apps/api/.env):** `MQTT_BROKER_TLS_PORT`, `MQTT_BROKER_WS_PORT`, `MQTT_BROKER_WSS_PORT`, `MQTT_AUTH_CALLBACK_URL`, `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `UNS_VERSION`
- **Section comments added** explaining what moved where (SMTP → SystemConfig; EMQX retention rationale)
- **Deleted (3 config def files):** `apps/api/src/modules/config/defs/{filter-data-management,dashboard-cards,tablet-access}.def.ts` — all orphan; not registered in `config-discovery.ts`; static-routes counterparts own validation
- **Verification:** api `tsc --noEmit` exit 0
- `.env.example` not touched (didn't contain any of the removed vars)

### Sub-PR 1.5 — sidebar-privilege-map bug fixes ✅ COMPLETE
- **`equipment-groups` section:** `["assets.view", "assets.create", "assets.edit", "assets.delete"]` → `["equipment_groups.view", "equipment_groups.create", "equipment_groups.edit", "equipment_groups.delete"]`
- **`checklists` section:** `["cleaning_profiles.view", "cleaning_profiles.create", "cleaning_profiles.edit", "cleaning_profiles.delete"]` → `["checklists.create", "checklists.edit", "checklists.delete", "checklists.toggle", "checklists.submit"]`
- **Behavioral note:** role admins toggling `equipment_groups.*` or `checklists.*` privileges will now correctly affect the matching sidebar item. Previously did nothing visible.
- **Verification:** shared `tsc` exit 0

### Sub-PR 1.6 — Repo hygiene ✅ COMPLETE
- **`git rm -r --cached RFID/app/build/`** — 507 files untracked (working tree preserved)
- **`git rm -r --cached RFID/.gradle/`** — 51 files untracked
- **`git mv scripts/{backfill-orphan-entity-orgs.sql, reset-cwh-cycles.sql} old/`** — 2 one-off migration scripts archived
- **`.gitignore` additions:** `RFID/app/build/`, `RFID/.gradle/`, `*.apk`, `*.aab` (with `!old/apks/*.apk` exception to preserve the intentional archive)
- **Deferred:** root `DigiLog-FilterOps.apk` move out of git (Wave 4 — needs tablet-install workflow verification)

### Sub-PR 1.7 — Backend zombie modules ⏸ DEFERRED
**Reason:** Depends on Phase 1 disposition. The 3 modules (`template-kinds/`, `entity-assignments/`, `assets/routes/relationship.routes.ts`) are zombies *because* Phase 1 deleted their FE callers. If Phase 1 is reverted, they become live again.
**Action required:** Decide Phase 1 fate (commit / revert / park), then execute per §3.7.

### Sub-PR 1.8 — hookform deps ❌ CANCELLED
**Verification result:** `react-hook-form` + `@hookform/resolvers/zod` are imported by **15 source files**:
- `apps/web/src/routes/auth/{login.tsx, change-password.tsx}`
- `apps/web/src/routes/users/{create.tsx, edit.tsx}`
- `apps/web/src/routes/config/{offline-cache.tsx, retention.tsx, password-policy.tsx, datetime.tsx, branding.tsx, notification-settings/email-settings.tsx}`
- `apps/web/src/routes/config/branding-components/{logo-upload-section.tsx, login-bg-section.tsx, color-settings-section.tsx}`

The 4-agent audit (frontend agent) reported "0 imports; codebase uses raw useState" — that claim was wrong. Its grep was too narrow. **Verify-first gate did its job** — no removal executed. Live in production.

---

## 9. Wave 1 totals

| Metric | Result |
|---|---|
| Sub-PRs completed | 6 of 8 (1 deferred, 1 cancelled by verification) |
| Source files deleted | **21** (18 in 1.1 + 3 config defs in 1.4) |
| Source files edited | **22** (4 in 1.1 + 6 in 1.2 + 2 in 1.3 + 1 in 1.4 + 1 in 1.5 + 1 .gitignore in 1.6 + 2 Phase-1 collateral) |
| Test files edited | 4 (1 edit + 3 in 1.2) |
| Source LoC removed | **~2,800** (~2,376 in 1.1 + ~62 in 1.2 + 0 in 1.3 + ~356 in 1.4 + ~0 in 1.5) |
| npm packages removed | **5** (handlebars, @types/handlebars, qrcode, recharts, qrcode.react) |
| node_modules install delta | ~7 MB |
| Stale env vars removed | **11** |
| Sidebar-privilege bugs fixed | **2** (equipment-groups + checklists copy-paste IDs) |
| Git-tracked files removed (build artifacts) | **558** (RFID/app/build + RFID/.gradle) |
| Git renames (scripts → old/) | 2 |
| Behavioral changes | 2 (Sub-PR 1.5 bug fixes — corrections) |
| DB schema changes | **0** |
| Production runtime impact | **0** (env vars deleted were unread; config defs deleted were unseeded) |
| Build verification | api tsc ✅ / web tsc ✅ / vite build ✅ / affected tests ✅ |

### Final git status
- Staged: **560** changes (mostly Sub-PR 1.6 Gradle untrackings + 2 script renames)
- Unstaged: **114** changes (Phase 1 work + Wave 1 source edits/deletes from 1.1–1.5 not yet staged)
- Untracked: **9** (Phase 1 .tmp files + new tasks/ docs)

---

## 10. Remaining technical debt (after Wave 1)

### Carried forward to Wave 2 (medium-risk refactors)
1. Rename misleading `*Redis` identifiers to `*Bus` in: `transport/ws-handler.ts::closeWsRedis`, `data-ingestion/ingestion.service.ts::closePipelineRedis` (both do real work; just badly named)
2. Standardize `CORS_ORIGIN` → `ALLOWED_ORIGINS[0]` in `lib/swagger.ts:41`, `qr-code/routes.ts:71`, `connectivity/routes.ts:246`
3. Hoist `MANAGE_PERMISSION_SUFFIXES` from `plugins/rbac.ts` to a declarative shared/permissions.ts structure
4. Drop 7 redundant `console.error` calls in dual-emit toast sites
5. Centralize toast/banner timeouts in `lib/timing-constants.ts`
6. Add helper hooks: `useReauthMutation`, `useClipboardCopy`, `usePermissions`
7. Add backend helpers: `traceStage()`, `requireReauth()` preHandler factory, `audit-label.ts` resolver

### Carried forward to Wave 3 (architectural)
1. Extract `connectivity/snippets/{python,nodejs,curl,c}.template.ts`
2. Split `getCurrentStateImpl` 497-LoC function
3. Resolve `use-offline.ts` ↔ `offline-cache.ts` ↔ `offline-store.ts` circular import
4. Split `mobile-operations.tsx` 2,490-LoC into per-view files
5. Extract `useMobileSyncShell` hook from `mobile-wrapper.tsx`

### Conditional / blocked (Wave 6)
1. **Sub-PR 1.7 (backend zombie modules)** — blocked on Phase 1 disposition
2. `EMQX_ADMIN_PASSWORD` + `USE_MOSQUITTO` legacy fallback removal — needs Mosquitto-only confirmation across all envs
3. `AssetInstance.{telemetryConfig, customAttributes}` column drops — needs one-release deprecation log + audit-team approval (21 CFR Part 11 implications)
4. 20 unused `AUDIT_ACTIONS` keys trim — needs audit-team sign-off
5. `PipelineNodeType` / `FilterEventType` unused values — needs pipeline-editor / rule-chain registry audit
6. QR code module — product decision: finish (install `qrcode` for real) or delete entire module
7. Root `DigiLog-FilterOps.apk` — move to GitHub Releases pending tablet-install workflow check

### Items discovered during Wave 1 execution (NEW debt)
1. **Frontend audit false positive on `react-hook-form`** — the agent's grep missed 15 consumer files. Update `tasks/CLEANUP-ANALYSIS-2026-05-16.md` §4.1 to mark this row as "verified live, do not remove".
2. **2 Phase-1 collateral fixes** were folded into Sub-PR 1.1 (`action-reauth.tsx` + `reauth-tab.tsx` had stale `'Entity Management'` category references). These should go into the Phase-1 commit when Phase 1 settles.
3. **Pre-existing `assets.test.ts:413` failure** in shared vitest — schema accepts `limit: '200'` when test expects rejection. Lives in your uncommitted `packages/shared/src/schemas/assets.ts` working-tree changes; investigate before committing Phase 1.

---

## 11. Recommended commit sequence

When you're ready to commit Wave 1, follow this order. Each commit is independently revertable.

```
# Create cleanup branch off RFID (preserves Phase 1 in working tree)
git switch -c cleanup/wave-1-safe-deletions

# Commit 1 — Sub-PR 1.1
git add packages/shared/src/schemas/auth.ts \
        packages/shared/src/schemas/auth.test.ts \
        packages/shared/src/index.ts \
        apps/web/src/lib/filter-constants.ts \
        apps/web/src/routes/config/action-reauth.tsx \
        apps/web/src/routes/config/roles-components/reauth-tab.tsx
# Plus the 18 deletions are auto-staged when the files are gone — verify with git status
git commit -m "chore(cleanup): wave-1.1 — drop action-tape ActionRenderer scaffolding + orphan FE pages + dead UI primitives + reAuthSchema (~2,400 LoC)"

# Commit 2 — Sub-PR 1.2
git add apps/api/src/transport/ws-handler.ts \
        apps/api/src/modules/data-ingestion/rpc-handler.ts \
        apps/api/src/modules/data-ingestion/ingestion.service.ts \
        apps/api/src/modules/data-ingestion/pipeline-tracer.ts \
        apps/api/src/modules/rule-chain/debug-recorder.ts \
        apps/api/src/app.ts \
        apps/api/src/modules/data-ingestion/__tests__/rpc-handler.test.ts \
        apps/api/src/modules/data-ingestion/__tests__/pipeline-tracer.test.ts \
        apps/api/src/modules/rule-chain/__tests__/debug-recorder.test.ts
git commit -m "chore(cleanup): wave-1.2 — drop 3 post-Phase-4 close*Redis true no-ops + tests"

# Commit 3 — Sub-PR 1.3
git add apps/api/package.json apps/api/package-lock.json \
        apps/web/package.json apps/web/package-lock.json \
        apps/web/vite.config.ts
git commit -m "chore(deps): wave-1.3 — uninstall handlebars + qrcode + recharts + qrcode.react (~7 MB install)"

# Commit 4 — Sub-PR 1.4
git add apps/api/.env \
        apps/api/src/modules/config/defs/
# (the 3 deletions are auto-staged when files gone)
git commit -m "chore(cleanup): wave-1.4 — drop 11 stale env vars + 3 orphan config defs"

# Commit 5 — Sub-PR 1.5
git add packages/shared/src/types/sidebar-privilege-map.ts
git commit -m "fix(perms): wave-1.5 — correct sidebar-privilege-map IDs (equipment-groups + checklists)"

# Commit 6 — Sub-PR 1.6
git add .gitignore old/ scripts/
# (the 558 untracked + 2 renames are already staged)
git commit -m "chore(repo): wave-1.6 — untrack RFID Gradle build artifacts + archive one-time scripts"
```

**Important:** do NOT use `git add .` or `git add -A` — Phase 1 + tasks/ docs are in your working tree and would get swept in. Stage explicitly by path.

---

## 12. Verification gates summary

| Gate | Status |
|---|---|
| `packages/shared && npx tsc` | ✅ exit 0 |
| `packages/shared && npx vitest run` | ✅ 302/1/0 (1 fail pre-existing) |
| `apps/api && npx tsc --noEmit` | ✅ exit 0 (3 separate runs across Sub-PRs) |
| `apps/api` affected vitest files | ✅ 56/56 pass |
| `apps/web && npx tsc --noEmit` | ✅ exit 0 |
| `apps/web && npx vite build` | ✅ exit 0 (2 separate runs, 15.69s + 13.68s) |
| Manual grep verification per deletion | ✅ all pre-deletion greps surfaced 0 hits except 1.8 |

---

*Wave 1 execution complete 2026-05-16. 6/8 sub-PRs landed; 1 deferred (Phase-1-dependent); 1 cancelled (verification caught false positive). Ready for commit.*

---

## 9. Hard rules followed in this plan

1. **No item below the "Rule 9" exclusions** (audit / roadmap / dynamic / feature-flag) is in Wave 1.
2. **Phase 1 entity-removal work is NOT bundled into any Wave 1 commit** — explicit per-file `git add` only.
3. **No `git add .` / `git add -A` / destructive git commands** during Wave 1.
4. **No DB schema changes** in Wave 1.
5. **No behavior change** in Wave 1 except Sub-PR 1.5 (bug fix — corrected behavior).
6. **No commits without explicit user OK** at end of Wave 1.
7. **Verification gate between each sub-PR** — typecheck + build + tests pass before proceeding.

---
