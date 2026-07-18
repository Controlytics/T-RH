# DigiLog Codebase Cleanup Analysis — 2026-05-16

**Scope:** Full monorepo (`apps/api`, `apps/web`, `apps/android`, `packages/{shared,db,queue}`, `RFID/`, `tests/`, `scripts/`)
**Method:** 4 parallel deep-exploration agents over backend / frontend / schema-shared-DB / deps-config, cross-checked against prior reviews (`tasks/CODE-REVIEW-2026-05-04-*.md`, `tasks/AUDIT-2026-05-04-linkage-review.md`, `tasks/AUDIT-2026-05-09-crud-coverage.md`).
**Working-tree state at audit:** Phase 1 of the entity-removal programme has uncommitted deletes (`apps/web/src/routes/assets/`, `routes/config/template-kinds.tsx`) + ~10 file edits. Findings reflect that post-Phase-1 view.
**Deployment reality:** Per memory, local Windows dev only; no live remote production. Section 10 risk language honors the "enterprise production" framing but flags items as theoretical where applicable.

---

## 1. Executive Summary

The codebase is in healthier shape than the prompt language suggests. Multiple recent audit cycles (2026-05-04 data+queue+supporting reviews, 2026-05-09 CRUD coverage, 2026-05-13 deep-review series, Phase 4 Redis retirement, Phase 5 dist cleanup) have already removed the worst offenders. **Findings cluster into three honest tiers:**

**Tier 1 — Zero-risk deletes (do now, single PR each):**
- 3 zombie backend modules (`template-kinds`, `entity-assignments`, `assets/routes/relationship.routes.ts`) — ~600 LoC routes + ~260 LoC service/repo + 4 test files. Unreachable post-Phase-1.
- 5 post-Phase-4 `close*Redis` no-op shutdown functions + their tests — ~1,800 LoC of FE `action-tape/ActionRenderer` scaffolding + 4 dead UI primitives.
- 3 orphan FE pages (`filter-profile-list.tsx`, `filter-status.tsx`, `filter-scan.tsx`) — no `<Route>` mounts, no sidebar entries.
- 1 dead Zod schema (`reAuthSchema`).
- 5 unused npm deps (`handlebars`, `@types/handlebars`, `qrcode`, `recharts`, `qrcode.react`) — ~650 KB bundle reduction.
- ~13 stale env vars in `apps/api/.env` (Redis, EMQX, MQTT-WS, SMTP).
- 1 def-only config (`filter-data-management.def.ts`).
- Build artifacts in git: `RFID/app/build/` (~500 files) + root `DigiLog-FilterOps.apk` not gitignored.

**Total Tier 1 reclaim:** ~5,000 LoC source + ~650 KB bundle + ~500 tracked build files + 17 fewer files.

**Tier 2 — Refactors needing one design decision each:**
- `mobile-operations.tsx` 2,490 LoC god-component — extract into per-view files.
- `current-state.ts` 568 LoC file with a single 497-LoC `getCurrentStateImpl` — split by branch.
- `data-ingestion/ingestion.service.ts` 999 LoC with 430-LoC orchestrator — extract `runStage()` wrapper, dedup 9 `if (trace) recordStage(...)` blocks.
- `connectivity/routes.ts` 766 LoC dominated by ~300 LoC of inline language-snippet templates — move to `snippets/{python,nodejs,curl,c}.template.ts`.
- 2 sidebar-privilege-map copy-paste bugs (`equipment-groups` + `checklists` sections reference wrong privilege IDs).
- Add three small helpers (`useReauthMutation`, `useClipboardCopy`, `usePermissions`) to absorb 100+ duplicated wiring sites.
- Replace `CORS_ORIGIN` legacy reads with `ALLOWED_ORIGINS[0]` across 3 files.
- Hoist the `*_MANAGE` suffix implication table to a declarative shared/permissions.ts structure.

**Tier 3 — Deliberate-keep items (NOT to delete, despite low usage):**
- 20 unused `AUDIT_ACTIONS` keys + their audit-template defaults. 21 CFR Part 11 risk — these are inspector-facing contracts. Mark-deprecated, do not delete.
- Several `NotificationChannel` / `PipelineNodeType` / `FilterEventType` enum values — planned for not-yet-shipped features.
- `AssetInstance.telemetryConfig` / `customAttributes` columns — write-only today but documented as the extension hook; verify FE quiescence before drop.
- `User.ldapDn` — operationally useful for LDAP audit traceability even if unread today.
- `ts_telemetry.trace_id` — vestigial column but trivially cheap on a hypertable.

**Items the prompt asked about that we found CLEAN:**
- No `console.log` debug noise in production code (31 calls audited; all structured warn/error).
- No commented-out code blocks of 5+ lines anywhere in `apps/api/src` or `apps/web/src`. (Prior cleanup landed.)
- No class components except React error boundaries (required by React).
- No deprecated framework patterns (no Redux, no `node-fetch`, no `moment.js`, no `request`, no `classnames`).
- No `bullmq`, no `ioredis`, no `chartjs-node-canvas`, no `puppeteer` (full) — every Phase 2/3/4 cutover landed cleanly.
- No N+1 queries surfaced in spot-checks of high-traffic routes.
- No unused Prisma models (all 69 receive ≥1 `prisma.X.*` call or relation include).
- No unused permission constants, reauth actions, or sidebar items after Phase 1 trim.
- Memory-leak risks in `internal-bus.ts`, `rpc-cache.ts`, `use-offline.ts`, `connectivity.ts`, `use-entity-websocket.ts` are all clean (cleanup paths in place).

**One structural risk:**
The `apps/web/src/hooks/use-offline.ts` ↔ `apps/web/src/lib/offline-cache.ts` ↔ `apps/web/src/lib/offline-store.ts` cycle is currently worked around with two `await import('../lib/offline-cache')` dynamic-import calls (use-offline.ts:199, :256). Fragile — any contributor making the imports eager will TDZ-crash filter operations.

**Doc drift surfaced as a side effect:**
Every numerical claim in `CLAUDE.md` is now slightly off post-Phase-1 (perms, privileges, reauth actions, sidebar items, enum count). This isn't an "unused code" finding but should be swept per the doc-sync rule already in `CLAUDE.md`.

---

## 2. Unused Code Report

### 2.1 Zombie backend modules (post-Phase-1 deletes)

The Phase 1 FE deletes left these backend routes mounted but uncallable. All have 0 FE callers (`grep -rn "/api/X" apps/web/src` → 0) and 0 e2e test calls.

| File | Routes | LoC | Removable | Notes |
|---|---|---|---|---|
| `apps/api/src/modules/template-kinds/routes.ts` | 5 routes (CRUD on `/api/template-kinds`) | ~330 | Yes (routes only — keep `TemplateKind` Prisma model + 6 seeded rows; mqtt-handler + asset routes still read the model directly) | Mount: `app.ts:267` |
| `apps/api/src/modules/entity-assignments/routes.ts` | 4 routes on `/api/entity-assignments` | ~270 | Yes (routes only — keep `EntityAssignment` model; visibility filter reads it, table is intentionally empty by current product design) | Mount: `app.ts:296` |
| `apps/api/src/modules/assets/routes/relationship.routes.ts` + service + repo | 3 routes on `/api/assets/relationships` + 148 LoC service + 112 LoC repo + 4 tests | ~390 | Yes (DB invariant `trg_asset_relationship_pair` still enforces bidirectionality at the SQL layer) | Sub-mount: `modules/assets/index.ts:4,8`; hierarchy builder uses `PATCH /api/assets/instances` instead |
| `apps/api/src/modules/assets/routes/template.routes.ts:313-346` | `GET /api/assets/templates/:id/versions` | ~33 | Yes | Cross-entity `version-history` page doesn't cover templates; no FE caller |

### 2.2 Dead backend exports (Phase-4 leftovers)

5 no-op shutdown wrappers retained "for backward compatibility":

| File | Symbol | Reality |
|---|---|---|
| `apps/api/src/transport/ws-handler.ts:269` | `closeWsRedis` | No-op since Phase 4 (in-process EventEmitter) |
| `apps/api/src/modules/data-ingestion/rpc-handler.ts:105` | `closeRpcRedis` | No-op |
| `apps/api/src/modules/data-ingestion/ingestion.service.ts:996` | `closePipelineRedis` | No-op |
| `apps/api/src/modules/data-ingestion/pipeline-tracer.ts:211` | `closeTracerRedis` | No-op |
| `apps/api/src/modules/rule-chain/debug-recorder.ts:92` | `closeDebugRedis` | No-op |

Caller: `app.ts:388-392` (5 lines). Tests pinning the no-op resolution: `ws-handler.test.ts:226`, `debug-recorder.test.ts:322`, `rpc-handler.test.ts:94`, `pipeline-tracer.test.ts:506`. All deletable together. **Also rename misleading `*Redis` identifiers across the codebase to `*Bus`** — Phase 4 retired Redis; the naming contradicts current architecture and `CLAUDE.md`.

### 2.3 Orphan FE pages

| File | LoC | Reachability |
|---|---|---|
| `apps/web/src/routes/filter-management/filter-profile-list.tsx` | 67 | 0 `<Route>` mounts, 0 sidebar links. `main.tsx:64` comment says "removed — replaced by Config > Cleaning Profile Assignment" but file was never deleted |
| `apps/web/src/routes/filter-management/filter-status.tsx` | 144 | 0 mounts, 0 links. Only docstring reference in `lib/filter-constants.ts:1,21` |
| `apps/web/src/routes/filter-management/filter-scan.tsx` | 110 | 0 mounts, 0 links. Scan is handled by `components/stage-scan-dialog.tsx` and mobile-operations |

### 2.4 Dead FE action-tape renderer (Phase-8.2 scaffolding that never shipped)

Per memory `[Decision tape proposal]`, this was prep for a future architecture flip that wasn't adopted. Cycle-write today uses dialog components + inline handlers.

| File | LoC | Status |
|---|---|---|
| `apps/web/src/lib/action-tape/ActionRenderer.tsx` | 215 | 0 consumers (`<ActionRenderer`, `import { ActionRenderer }`, default-import — all 0) |
| `apps/web/src/lib/action-tape/components/AdvanceToStageButton.tsx` | 138 | 0 |
| `apps/web/src/lib/action-tape/components/BypassStageButton.tsx` | 99 | 0 |
| `apps/web/src/lib/action-tape/components/CompleteCycleButton.tsx` | 29 | 0 |
| `apps/web/src/lib/action-tape/components/SetDryerDurationButton.tsx` | 135 | 0 |
| `apps/web/src/lib/action-tape/components/SubmitChecklistButton.tsx` | 154 | 0 |
| `apps/web/src/lib/action-tape/components/SubmitDryerReadingsButton.tsx` | 128 | 0 |
| `apps/web/src/lib/action-tape/components/TerminateCycleButton.tsx` | 97 | 0 |
| `apps/web/src/lib/action-tape/action-dialog.tsx` | 131 | 0 |
| `apps/web/src/lib/action-tape/base-action-button.tsx` | 67 | 0 |
| `apps/web/src/lib/action-tape/__tests__/ActionRenderer.test.tsx` | 581 | Tests deleted code |

**KEEP** `apps/web/src/lib/action-tape/index.ts` + `types.ts` — barrel/helpers (`actionsForStage`, `getCurrentActions`, `hasActionKind`) ARE consumed by `lib/filter-ops/validate-offline-gate.ts:36` and `resolve-pending-checklist.ts:41`.

### 2.5 Dead FE UI primitives

| File | LoC | Notes |
|---|---|---|
| `apps/web/src/components/ui/alarm-badge.tsx` | 31 | 0 consumers |
| `apps/web/src/components/ui/code-snippet.tsx` | 60 | 0 consumers |
| `apps/web/src/components/ui/connectivity-indicator.tsx` | 50 | 0 consumers — superseded by `components/mobile/connectivity-ribbon.tsx` |
| `apps/web/src/components/ui/help-button.tsx` | 106 | 0 consumers |

### 2.6 Dead Zod schema

- `packages/shared/src/schemas/auth.ts` — `reAuthSchema` exported from barrel (`index.ts:58`) but no production code imports it. Backend `reauth-check.ts` uses its own JSON-schema validation.

### 2.7 Unused npm dependencies

| Package | Where | Bundle/disk impact | Notes |
|---|---|---|---|
| `handlebars` ^4.7.9 | `apps/api/package.json` | ~5 MB install | 0 imports; reports module uses string templating instead |
| `@types/handlebars` ^4.0.40 | `apps/api/package.json` | dev only | Companion to above |
| `qrcode` ^1.5.4 | `apps/api/package.json` | ~2 MB | 0 imports; `qr-code/routes.ts:7` comment admits the module returns placeholder SVG instead of real QR codes — this is also a **half-built feature** flag |
| `recharts` ^2.15.4 | `apps/web/package.json` | ~500 KB bundle | 0 imports; only mention is in `vite.config.ts:73` manualChunks |
| `qrcode.react` ^4.2.0 | `apps/web/package.json` | ~150 KB | 0 imports; FE displays QR via API-served images |
| `@hookform/resolvers` + `react-hook-form` | `apps/web/package.json` | ~150 KB | 0 imports; codebase uses raw `useState` forms (**verify before removing**) |

### 2.8 Stale env vars (apps/api/.env)

All have 0 `process.env.X` reads in `apps/api/src`:

| Var | Source/era |
|---|---|
| `REDIS_HOST`, `REDIS_PORT`, `REDIS_PASSWORD` | Phase 4 retirement leftover |
| `MQTT_BROKER_TLS_PORT`, `MQTT_BROKER_WS_PORT`, `MQTT_BROKER_WSS_PORT` | EMQX-era; Mosquitto uses only `MQTT_BROKER_HOST` + `:1883` |
| `MQTT_AUTH_CALLBACK_URL` | EMQX HTTP-auth-callback; Mosquitto uses dynsec |
| `UNS_VERSION` | Superseded by `UNS_ROOT_PREFIX` |
| `JWT_EXPIRES_IN` | JWT expiry hardcoded in `lib/jwt.ts` — either wire up or drop |
| `UPLOAD_DIR` | Reports path hardcoded in `reports/service.ts:11` — either wire up or drop |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD` | SMTP read from `SystemConfig['notification-email']` row, not env |

### 2.9 Half-wired config defs

`apps/api/src/lib/config-discovery.ts` registers 28 defs but `apps/api/src/modules/config/defs/` has 31 files. The 3 unregistered:

| File | Verdict |
|---|---|
| `filter-data-management.def.ts` | Fully dead — no runtime reader, no discovery, no static-route counterpart. **Delete.** |
| `dashboard-cards.def.ts` | Static route owns its own validation against `SystemConfig['dashboard-cards']` — def file is orphaned scaffolding. **Delete OR wire up — half-wired is the problem.** |
| `tablet-access.def.ts` | Same shape as above. **Delete OR wire up.** |

### 2.10 Unused FE feature-privilege wiring (bug, not orphan)

Two `sidebar-privilege-map.ts` entries reference the wrong privilege IDs — toggle the privilege on a role, nothing visible changes:

| Section | Currently maps to | Should map to |
|---|---|---|
| `equipment-groups` (lines 143-148) | `assets.view/create/edit/delete` | `equipment_groups.view/create/edit/delete` |
| `checklists` (lines 128-134) | `cleaning_profiles.*` | `checklists.*` |

### 2.11 Build artifacts checked into git

| Path | Files | Notes |
|---|---|---|
| `RFID/app/build/**` | ~500 | Android Gradle intermediates from standalone RFID Kotlin scanner; `.gitignore` covers `apps/*/dist/` but not `RFID/app/build/` or `RFID/.gradle/` |
| `DigiLog-FilterOps.apk` (root) | 1 large binary | APK tracked in git; `.gitignore` doesn't exclude `*.apk` |
| `old/apks/DigiLog-FilterOps.apk`, `old/apks/RFID-Scanner.apk` | 2 large binaries | Archived APKs in `old/` — keep if archival mandate, else move out |

### 2.12 One-time migration scripts no longer needed

| Script | Status |
|---|---|
| `scripts/backfill-orphan-entity-orgs.sql` | MT-removal one-off; completed 2026-04-30. Move to `old/`. |
| `scripts/reset-cwh-cycles.sql` | Per PHASE_5_RECENT_WORK.md:260; one-time. Move to `old/`. |

### 2.13 Items confirmed CLEAN (NOT findings)

These categories were audited and produced no findings, contrary to what a generic enterprise-cleanup template might expect:

- **No commented-out code blocks of 5+ lines** anywhere in `apps/api/src` or `apps/web/src` (200+ files audited).
- **No `console.log` debug noise.** 31 `console.*` calls in 18 files — all `console.warn` / `console.error` with `[module]` prefix on legitimate diagnostic paths. (7 redundant — see §3.4.)
- **No hardcoded URLs / ports / IPs** in `apps/web/src` (grep `localhost|192\.168` → 0).
- **No unused Prisma models, enums (as wholes), permissions, reauth actions, or sidebar items** post-Phase-1 trim. Some enum *values* unused — see §3.6.
- **No deprecated framework patterns** — only class components are the required React error-boundary ones.
- **No leftover Phase-1/2/3/4 imports** — `bullmq`, `ioredis`, `chartjs-node-canvas`, `puppeteer` (full), `node-fetch`, EMQX modules all fully removed. The only sin is misleading `*Redis` symbol names — see §2.2.

---

## 3. Blob / Bloated Code Report

### 3.1 Files >500 LoC in apps/api/src/modules/ (non-test)

| File | LoC | Verdict |
|---|---|---|
| `data-ingestion/ingestion.service.ts` | 999 | God-object — see §3.3 |
| `rule-chain/routes.ts` | 989 | NOT a god-object — 14 routes, mostly inline JSON-schema. Splittable but low-value. |
| `connectivity/routes.ts` | 766 | Half god-object — `/snippets` alone is ~300 LoC of inline Python/Node/curl/C templates. Extract per §3.3. |
| `queries/telemetry.routes.ts` | 701 | Inline schemas dominate. Acceptable. |
| `data-ingestion/routes.ts` | 658 | Acceptable. |
| `backup/backup.service.ts` | 617 | God-object (already documented in prior reviews — H3/H4/H5). |
| `filter-operations/filter-operations.service.ts` | 609 | Thin facade after Step-6 split. Acceptable. |
| `notification-delivery/routes.ts` | 572 | Per-channel config schemas. Acceptable. |
| `filter-operations/current-state.ts` | 568 | One 497-LoC function — see §3.3 |
| `assets/routes/instance.routes.ts` | 566 | Acceptable. |
| `deployment-check/routes.ts` | 547 | One giant env-check manifest. Could become data. Low priority. |
| `queries/retention.routes.ts` | 545 | Acceptable. |
| `rule-chain/nodes/action-nodes.ts` | 544 | Dispatch table. Keep. |
| `dashboards/routes.ts` | 520 | Acceptable. |
| `filter-operations/routes.ts` | 511 | Acceptable. |

### 3.2 Files >500 LoC in apps/web/src/routes/ (non-test)

| File | LoC | Notes |
|---|---|---|
| `routes/mobile/mobile-operations.tsx` | 2,490 | **Top offender.** 88 hook-state instances in one component; 5 view modes (`home/status/stage/my-tasks/approvals`) inline-rendered; 200–500 LoC per view. No prior memory note declining extraction. |
| `routes/filter-management/filter-operations.tsx` | 1,766 | Already partially extracted (DryingFiltersPanel + useFilterOperationsOfflineCache + useRecentSubmissions). Memory `[filter-ops extraction 2026-05-14]` **explicitly declines** further handler extraction. **Honor the decision.** |
| `routes/filter-management/filter-list.tsx` | 1,746 | 30+ `useState` calls in opening 130 lines. `useReducer` consolidation candidate. |
| `routes/config/filter-data-management.tsx` | 1,682 | Mirrors 10 user-facing pages as a SUPER_ADMIN console. Inherent shape; not easily split. |
| `routes/pm-schedules/index.tsx` | 1,060 | 22 inline `style={{...}}` blocks suggests heavy DOM-styled tables — review for className extraction. |
| `routes/mobile/mobile-wrapper.tsx` | 982 | 33 hook-state instances. Candidate: extract `useMobileSyncShell` hook. |

### 3.3 Methods >75 LoC (top offenders)

```
FILE: apps/api/src/modules/filter-operations/current-state.ts:71-568
WHAT: getCurrentStateImpl — single 497-LoC function
WHY: Builds the full snapshot the FE polls every tick — cycle row + pending checklist + next-actions + reauth flags + pipeline-resolved stage + equipment-group pin + offline mirror. All 5 branches (no cycle | pending checklist | mid-stage | bypass-allowed | end-of-pipeline) in one function.
RECOMMENDATION: split into resolveActiveCycle → resolvePendingChecklist → resolveNextAction → buildSnapshot (≤120 LoC each).
RISK: Medium — every cycle-state branch is compliance-relevant; need full test coverage during split.
```

```
FILE: apps/api/src/modules/data-ingestion/ingestion.service.ts:148-578
WHAT: processIngestionMessage — 430-LoC orchestrator
WHY: Stages 3→11 of the 11-stage pipeline inline-orchestrated; each stage has its own helper but the orchestrator that wires trace.recordStage + dispatchNotification + DLQ-add is monolithic. 9 instances of the same 4-line `if (trace) recordStage({...})` block (lines 171, 181, 199, 209, 225, 235, 297, 307, 319).
RECOMMENDATION: extract `runStage(name, fn, trace)` helper to absorb the trace-instrumentation duplication; lift orchestrator to <120 LoC.
RISK: Medium.
```

```
FILE: apps/api/src/modules/connectivity/routes.ts:226-526
WHAT: GET /:entityId/snippets — 300+ LoC of inline Python/Node/curl/C template literals
RECOMMENDATION: move to `modules/connectivity/snippets/{python,nodejs,curl,c}.template.ts`. Handler shrinks to ~15 LoC.
RISK: Low.
```

### 3.4 Repeated UI/code patterns

| Pattern | Sites | Recommendation |
|---|---|---|
| `reauth.execute(...) → onSuccess: toast.success + mutate + setX(null)` boilerplate around `reauth.execute` calls | ~103 sites across 47 FE files | Add `useReauthMutation(...)` helper to `hooks/use-reauth.ts`; migrate site-by-site |
| `clipboard.writeText → setCopied(true) → setTimeout(setCopied(false), 2000)` | ~10 sites | Extract `useClipboardCopy()` hook |
| `const isSuperAdmin = user?.role === 'SUPER_ADMIN'; const hasPerm = (p) => isSuperAdmin \|\| perms.includes(p)` | ~12 sites | Extract `usePermissions()` hook returning `{ isSuperAdmin, hasPerm, hasAny, hasAll }` |
| `if (trace) recordStage(trace, { stage, status, ... })` | 9 sites in `ingestion.service.ts` alone | Extract `traceStage(trace, name, status, extra?)` |
| `await enforceReauth('ACTION', req, reply); if (!ok) return;` | ~30 backend routes | Express as `preHandler: [requireReauth('ACTION')]` factory mirroring `requirePermission()` |
| `prisma.role.findFirst({ where: { name: userRole }, select: { permissions: true } })` | 2 inline copies in `plugins/rbac.ts` (called per request) | Already documented in prior M11 — add cache in `lib/`, reuse, don't inline |
| `(targetType, targetId) → human-readable label` for audit responses | ~12 sites | Share an `audit-label.ts` resolver |
| Dual-emit `console.error('...', err)` followed by `toast.error(...)` | 7 sites (`routes/audit/index.tsx:129,151`, `routes/config/roles-components/sidebar-tab.tsx:92,101,110`, `permissions-tab.tsx:54`) | Drop the redundant `console.error` |

### 3.5 Hardcoded magic values

| File | Value | Fix |
|---|---|---|
| `apps/api/src/lib/swagger.ts:41`, `qr-code/routes.ts:71`, `connectivity/routes.ts:246` | `process.env.CORS_ORIGIN \|\| 'http://localhost:3000'` (legacy var, never set) | Standardize on `ALLOWED_ORIGINS[0]`; add deployment-check entry so prod boots fail when neither set |
| `apps/api/src/plugins/rbac.ts:42-47` | `manageVariants = ['_CREATE','_UPDATE','_DELETE','_VIEW','_READ','_EXPORT']` hand-coded | Hoist to declarative shared/permissions.ts (memory: `*_MANAGE` suffix audit is a known open item) |
| `apps/api/src/app.ts:107` | 5-origin hardcoded dev fallback list | Move to top of file with `// dev only` comment |
| FE: 13 sites hardcode `setTimeout(..., 2000/3000/4000/6000)` for toast/copy/banner auto-dismiss | | Centralize in existing `apps/web/src/lib/timing-constants.ts` (file already exists and anticipates this) |

### 3.6 Enum values with no string-literal references (KEEP, do not delete)

| Enum | Unused values | Why keep |
|---|---|---|
| `NotificationChannel` | `TELEGRAM`, `WHATSAPP`, `SLACK` | Provider integration on the roadmap; rule-engine UI exposes channels by enum value |
| `NotificationEventType` | `USER_LOCKED` and several others | User-configurable in notification-rules UI |
| `PipelineNodeType` | `REMARKS`, `DURATION_INTERLOCK`, `CUSTOM_SCRIPT`, `APPROVAL`, `EQUIPMENT_LINK` | Pipeline DSL; cleaning-profile pipeline-editor + rule-chain registry may register dynamically — **audit before any removal** |
| `FilterEventType` | `EQUIPMENT_LINKED`, `REMARK_ADDED`, `SCRIPT_EXECUTED` | Tied to deferred custom-script feature |

### 3.7 Write-only / read-only model fields (KEEP under deprecation flag)

| Field | State | Action |
|---|---|---|
| `AssetInstance.telemetryConfig` (Json) | WRITE-only; instance-level telemetry-override never wired | Verify with FE quiescence, then drop after one release |
| `AssetInstance.customAttributes` (Json) | WRITE-only; `attributes` is the live field | Same as above |
| `User.ldapDn` | WRITE-only on first LDAP sign-in | Keep for forensic value; mark with comment |
| `ts_telemetry.trace_id` | WRITE-only post-Phase-4 trace migration | Cheap to keep on a hypertable; mark with comment |

---

## 4. Dependency Impact Analysis

### 4.1 Package.json removals (verified safe)

```
apps/api/package.json:
  - "handlebars": "^4.7.9"           (0 imports)
  - "@types/handlebars": "^4.0.40"   (companion)
  - "qrcode": "^1.5.4"               (0 imports; QR feature stubbed)

apps/web/package.json:
  - "recharts": "^2.15.4"            (0 imports; remove from vite.config.ts:73 manualChunks)
  - "qrcode.react": "^4.2.0"         (0 imports; remove from vite.config.ts:74 manualChunks)

apps/web/package.json (verify first):
  - "react-hook-form"                (0 imports; codebase uses raw useState)
  - "@hookform/resolvers"            (companion)
```

Plus `pino` in `apps/api/package.json` is redundantly direct-listed; transitively pulled by Fastify v5. Cosmetic.

### 4.2 Dependency duplication — none material

- `clsx` + `tailwind-merge` — both needed for `cn()` helper. Not duplication.
- `jspdf` (web client-side) + `puppeteer-core` (server-side reports) — different concerns. Not duplication.
- Date libs: `dayjs` (api) + `chartjs-adapter-date-fns` (transitive only). Acceptable.
- No `axios` / `node-fetch` — native `fetch` only.

### 4.3 Circular imports

```
FILE: apps/web/src/hooks/use-offline.ts:199, :256
CYCLE: use-offline → offline-store; offline-cache → offline-store; use-offline → offline-cache
WORKAROUND: two `await import('../lib/offline-cache')` dynamic imports inside executeOrQueue callback.
ACKNOWLEDGED: code comment line 254-255 "Lazy-import to avoid circular deps"
RISK: Medium — fragile pattern; any contributor making them eager will TDZ-crash filter operations
RECOMMENDATION: refactor — extract `recomputeAndCacheFilterState` + `cacheServerStateResponse` to a new file depending only on `offline-store`. Removes the cycle structurally.
ADDITIONAL: run `madge --circular apps/web/src apps/api/src` to confirm no other cycles slip through.
```

apps/api: top importers (`lib/prisma.ts`, `lib/audit.ts`, `plugins/auth.ts`) only depend downward. No cycles in spot check.

### 4.4 Environment variable cleanup

13 stale vars in `apps/api/.env` (REDIS_*, MQTT_BROKER_*_PORT, MQTT_AUTH_CALLBACK_URL, UNS_VERSION, JWT_EXPIRES_IN, UPLOAD_DIR, SMTP_*). See §2.8 for the breakdown.

Also: `EMQX_ADMIN_PASSWORD` (line 20) is **still read** by `transport/mqtt-client.ts:51` and `mqtt-auth-routes.ts` as the legacy fallback when `USE_MOSQUITTO != true`. If the EMQX path is truly dead, drop both the env var AND the fallback branch — **medium risk** because killing the branch closes the rollback path.

### 4.5 Config def cleanup

See §2.9. 3 def files (`filter-data-management.def.ts`, `dashboard-cards.def.ts`, `tablet-access.def.ts`) not in `config-discovery.ts`. The first is fully dead; the latter two have working static-route counterparts that own validation — the defs are orphaned scaffolding.

---

## 5. Risk Assessment Matrix

Risk legend:
- **Low** — local edit, well-covered by tests, easy rollback.
- **Medium** — touches a hot path, needs targeted manual verification.
- **High** — touches audit, compliance, security boundary, or schema. Requires explicit review + extended QA.

### 5.1 Per-finding risk table

| # | Finding | Risk | Reason | Mitigation |
|---|---|---|---|---|
| 1 | Delete `template-kinds/routes.ts` | Low | 0 callers; keep model | Verify e2e suite has no `/api/template-kinds` calls |
| 2 | Delete `entity-assignments/routes.ts` | Low | 0 callers; table intentionally empty | Verify visibility-filter still reads model |
| 3 | Delete `assets/routes/relationship.routes.ts` + svc + repo + tests | Low-Med | DB invariant still enforces bidirectionality | Verify hierarchy builder uses PATCH path; review 4 test files |
| 4 | Delete `template.routes.ts:313-346` `/versions` route | Low | 0 callers; version-history page doesn't cover templates | Trim corresponding e2e block |
| 5 | Delete 5 `close*Redis` no-ops + 4 tests | Low | Verified no-ops since Phase 4 | Drop app.ts:388-392 lines; rename siblings to `*Bus` |
| 6 | Rename `*Redis` identifiers → `*Bus` | Low | Cosmetic; aligns with current architecture | Single PR with naming-only changes |
| 7 | Delete 3 orphan FE pages (filter-profile-list, filter-status, filter-scan) | Low | 0 mounts, 0 links | None |
| 8 | Delete action-tape ActionRenderer + buttons + test | Low | Verified 0 consumers; barrel/types stay | None |
| 9 | Delete 4 dead UI primitives | Low | 0 consumers | None |
| 10 | Delete `reAuthSchema` from auth.ts + barrel | Low | 0 imports | None |
| 11 | `npm uninstall handlebars @types/handlebars qrcode` (api) | Low | 0 imports verified | Re-run api tests |
| 12 | `npm uninstall recharts qrcode.react` (web) | Low | 0 imports; remove from vite manualChunks | Re-run web build |
| 13 | `npm uninstall @hookform/resolvers react-hook-form` (web) | Med | Verify with full repo grep + lint + build first | Don't bundle with item 12 — separate PR |
| 14 | Delete 13 stale env vars from .env | Low | All have 0 reads | Update apps/api/.env.example synchronously |
| 15 | Delete `EMQX_ADMIN_PASSWORD` + USE_MOSQUITTO fallback branch | Med | Closes rollback path | Confirm Mosquitto is the only live broker in all envs |
| 16 | Delete `filter-data-management.def.ts` | Low | Fully orphaned | None |
| 17 | Delete (OR wire up) `dashboard-cards.def.ts` + `tablet-access.def.ts` | Low | Static routes own validation | Pick one path consistently |
| 18 | Fix sidebar-privilege-map `equipment-groups` + `checklists` privilege IDs | Low | Bug fix, no removal | UI test: toggle privilege, observe sidebar change |
| 19 | git rm -r `RFID/app/build/` + gitignore | Low | Build outputs | Update `.gitignore` first |
| 20 | Move root `*.apk` out of git | Low-Med | Verify tablet-install workflow doesn't depend on git-tracked APK | Update DEPLOY-WINDOWS.md if it does |
| 21 | Move `scripts/backfill-orphan-entity-orgs.sql` + `reset-cwh-cycles.sql` to `old/` | Low | One-off migrations done | None |
| 22 | Split `mobile-operations.tsx` into per-view files | Med | Heavy state coupling | View-by-view PRs; verify offline cache priming continues |
| 23 | Split `getCurrentStateImpl` into 4 sub-resolvers | Med | Hot tablet-poll path; every branch compliance-relevant | Per-branch unit tests before split; UAT |
| 24 | Extract `runStage()` helper in ingestion.service.ts | Med | Touches 11-stage pipeline | Integration test for full message ingestion |
| 25 | Extract connectivity snippet generators to `snippets/` | Low | Localized | Snapshot test the generated snippets |
| 26 | Refactor offline-cache cycle (extract recomputeAndCacheFilterState) | Med | Fragile workaround in place | Run `madge --circular`; cypress smoke on offline flow |
| 27 | Standardize CORS_ORIGIN → ALLOWED_ORIGINS | Low | 3 file edits | Deployment-check entry catches misconfig |
| 28 | Hoist `*_MANAGE` suffix table to declarative shared/permissions.ts | Low | No behavior change | Re-run RBAC tests |
| 29 | Add `useReauthMutation`, `useClipboardCopy`, `usePermissions` helpers | Low | New surface, no deletions | Migrate progressively |
| 30 | Centralize toast/banner timeouts in `lib/timing-constants.ts` | Low | 13 sites, mechanical | None |
| 31 | Mark `AssetInstance.telemetryConfig`, `customAttributes` for deprecation | Med | Write-only fields; FE forms may still send | One-release deprecation log before drop |
| 32 | Mark 20 unused `AUDIT_ACTIONS` keys for deprecation | **High** | 21 CFR Part 11; inspector contracts | DO NOT delete; mark-deprecated with comment |
| 33 | Audit `PipelineNodeType`, `FilterEventType` unused values | High | Roadmap features may register dynamically | Investigate pipeline-editor + rule-chain registry before any removal |
| 34 | Drop redundant `console.error` in 7 dual-emit sites | Low | Cosmetic | None |
| 35 | Doc-sync sweep (CLAUDE.md count drift) | Low | Cosmetic | Verify per the doc-sync rule |

### 5.2 Risk distribution

- **Low:** 24 items
- **Medium:** 9 items
- **High:** 2 items (audit-action cleanup; unused pipeline-DSL enum values)

---

## 6. Safe-to-Remove Items (no judgment required)

These can be deleted in single PRs without product / design conversations:

**PR A — Backend zombie modules** (~600 LoC routes + 260 LoC svc/repo + 4 tests)
- `apps/api/src/modules/template-kinds/routes.ts`
- `apps/api/src/modules/entity-assignments/routes.ts`
- `apps/api/src/modules/assets/routes/relationship.routes.ts` + `services/relationship.service.ts` + `repositories/relationship.repository.ts` + matching tests
- `apps/api/src/modules/assets/routes/template.routes.ts:313-346` (/versions endpoint)
- Drop the corresponding mounts in `apps/api/src/app.ts` and `modules/assets/index.ts`
- Drop createTemplateKind/updateTemplateKind Zod schemas from packages/shared

**PR B — Post-Phase-4 no-op cleanup** (~120 LoC + 4 test files)
- Delete `closeWsRedis`, `closeRpcRedis`, `closePipelineRedis`, `closeTracerRedis`, `closeDebugRedis`
- Delete the matching test blocks
- Drop 5 imports + 5 lines from `app.ts:388-392`
- Rename remaining `*Redis` identifiers in `ws-handler.ts`, `pipeline-tracer.ts`, etc. → `*Bus`

**PR C — Frontend orphan pages + dead primitives** (~568 LoC, 7 files)
- `routes/filter-management/filter-profile-list.tsx`
- `routes/filter-management/filter-status.tsx`
- `routes/filter-management/filter-scan.tsx`
- `components/ui/alarm-badge.tsx`
- `components/ui/code-snippet.tsx`
- `components/ui/connectivity-indicator.tsx`
- `components/ui/help-button.tsx`

**PR D — Action-tape dead scaffolding** (~1,800 LoC, 11 files)
- `lib/action-tape/ActionRenderer.tsx`
- `lib/action-tape/action-dialog.tsx`
- `lib/action-tape/base-action-button.tsx`
- `lib/action-tape/components/*.tsx` (7 files)
- `lib/action-tape/__tests__/ActionRenderer.test.tsx`
- **KEEP** `lib/action-tape/index.ts` + `types.ts`

**PR E — npm dep cleanup**
- `apps/api`: `npm uninstall handlebars @types/handlebars qrcode`
- `apps/web`: `npm uninstall recharts qrcode.react` + remove `charts:` and `qrcode:` from `vite.config.ts:73-74` manualChunks
- Separate PR (Medium risk): `npm uninstall @hookform/resolvers react-hook-form` after a full repo verify

**PR F — Env + config cleanup**
- Delete 13 stale env vars from `apps/api/.env` and `.env.example`
- Delete `apps/api/src/modules/config/defs/filter-data-management.def.ts`
- Decide: delete OR wire up `dashboard-cards.def.ts` and `tablet-access.def.ts` (don't leave half-wired)
- Delete `packages/shared/src/schemas/auth.ts::reAuthSchema` + barrel re-export

**PR G — sidebar-privilege-map bug fixes**
- Fix `equipment-groups` and `checklists` sections to reference correct privilege IDs

**PR H — Repo hygiene**
- `git rm -r RFID/app/build/`
- Add `RFID/app/build/`, `RFID/.gradle/`, `*.apk`, `*.aab` to `.gitignore`
- Decide on root `DigiLog-FilterOps.apk` (move to GitHub Releases or shared drive)
- Move `scripts/backfill-orphan-entity-orgs.sql` + `scripts/reset-cwh-cycles.sql` to `old/`

**Total tier-1 reclaim: ~5,000 LoC source removed, ~650 KB bundle, ~500 git-tracked build files, 17 source files deleted.**

---

## 7. Refactoring Recommendations

Items that improve structure without deleting features. Each is a separate PR scope.

### 7.1 Helper extractions (FE)
- `hooks/use-reauth.ts`: add `useReauthMutation<T>({ action, fn, successTitle, successMsg, swrKey, onDone })`. Migrate the 103 reauth.execute boilerplate sites progressively. Expected save: ~600 LoC even at 30% adoption.
- `hooks/use-clipboard-copy.ts`: extract from the 10 duplicated `setTimeout(setCopied(false), 2000)` sites.
- `hooks/use-permissions.ts`: `{ isSuperAdmin, hasPerm, hasAny, hasAll }`. Eliminates the 12 SUPER_ADMIN-bypass copies.

### 7.2 Backend helper extractions
- `lib/trace.ts`: `traceStage(trace, name, status, extra?)` — dedups the 9 `if (trace) recordStage(...)` blocks in ingestion.service.ts (and the same shape in 3 other modules).
- `plugins/rbac.ts`: `requireReauth(action)` factory matching `requirePermission(perm)`. Eliminates the ~30 `await enforceReauth('X', req, reply); if (!ok) return;` boilerplate sites and removes "forgot the early-return" footgun.
- `lib/audit-label.ts`: shared `(targetType, targetId) → label` resolver. Eliminates ~12 duplicated audit-row formatters.

### 7.3 File splits
- **`mobile-operations.tsx`** → `routes/mobile/views/{Home,Status,Stage,MyTasks,Approvals}View.tsx` + `useMobileOperationsOfflineCache` hook. Target: 600-800 LoC main file + 5 views ≤500 LoC each.
- **`current-state.ts::getCurrentStateImpl`** → `resolveActiveCycle` + `resolvePendingChecklist` + `resolveNextAction` + `buildSnapshot`.
- **`connectivity/routes.ts::/snippets`** → `modules/connectivity/snippets/{python,nodejs,curl,c}.template.ts` exporting `renderXxxSnippet(ctx)`.
- **`mobile-wrapper.tsx`** → extract `useMobileSyncShell` hook absorbing the sync/ribbon/offline-status orchestration.

### 7.4 Structural fixes
- **Resolve the use-offline ↔ offline-cache ↔ offline-store cycle** by moving `recomputeAndCacheFilterState` + `cacheServerStateResponse` to a new file depending only on `offline-store`. Remove the two `await import(...)` workarounds.
- **Hoist `MANAGE_PERMISSION_SUFFIXES`** from `plugins/rbac.ts` to a declarative shared/permissions.ts structure (already a known open item per memory `[project_open_items_2026_05_15]`).
- **Standardize CORS_ORIGIN → ALLOWED_ORIGINS** in `lib/swagger.ts:41`, `qr-code/routes.ts:71`, `connectivity/routes.ts:246`. Add a deployment-check entry so prod boots fail loudly when neither is set.

### 7.5 Documentation
- Sync every numerical claim in root `CLAUDE.md` to live counts (per the doc-sync rule). Post-Phase-1 numbers: 104 perms, 86 feature privileges, 97 reauth actions, 24 sidebar items, 21 Prisma enums, 69 models, 37 API modules.
- Add comments to write-only kept fields (`AssetInstance.telemetryConfig`, `customAttributes`, `User.ldapDn`, `ts_telemetry.trace_id`) explaining why they're kept.
- Add a deprecation marker comment on the 20 unused `AUDIT_ACTIONS` keys.

---

## 8. Cleanup Execution Plan

Suggested wave ordering, each wave = one (or a few) PR(s) with isolated blast radius.

### Wave 1 — Tier-1 deletes (1 working day, no design decisions)
1. PR A — Backend zombie modules
2. PR B — Post-Phase-4 no-op cleanup
3. PR C — Frontend orphan pages + dead primitives
4. PR D — Action-tape dead scaffolding
5. PR E (part 1) — npm: handlebars + qrcode (api) + recharts + qrcode.react (web)
6. PR F — Env + config + reAuthSchema cleanup
7. PR G — sidebar-privilege-map bug fixes
8. PR H — Repo hygiene (RFID/app/build, *.apk gitignore, archived scripts)

Each PR: open, verify build + tests, merge. Aim for all 8 PRs landed in one cycle.

### Wave 2 — Medium-risk consolidations (1-2 days)
9. PR E (part 2) — `@hookform/resolvers` + `react-hook-form` removal (after explicit zero-import verify)
10. PR I — Standardize CORS_ORIGIN → ALLOWED_ORIGINS (3 file edits + deployment-check entry)
11. PR J — Rename `*Redis` identifiers → `*Bus` (mechanical)
12. PR K — Drop 7 redundant `console.error` in dual-emit sites
13. PR L — Centralize toast/banner timeouts in `lib/timing-constants.ts`

### Wave 3 — Helper extractions (3-5 days)
14. PR M — `useClipboardCopy` hook + migrate 10 sites
15. PR N — `usePermissions` hook + migrate 12 sites
16. PR O — `requireReauth(action)` preHandler factory + migrate ~30 backend sites in chunks
17. PR P — `useReauthMutation` helper (no forced migration; opt-in over time)
18. PR Q — `traceStage()` helper + dedup ingestion.service.ts
19. PR R — `audit-label.ts` resolver + migrate ~12 audit-row formatters

### Wave 4 — File splits (1-2 weeks, careful)
20. PR S — Extract `connectivity/snippets/` (low risk, localized)
21. PR T — Split `getCurrentStateImpl` (Med risk; per-branch tests first)
22. PR U — Resolve use-offline cycle by extracting `recomputeAndCacheFilterState` (Med risk; cypress smoke)
23. PR V — Hoist `MANAGE_PERMISSION_SUFFIXES` to declarative structure
24. PR W-Z — `mobile-operations.tsx` per-view split (one PR per view; sequence: Home → Status → Stage → MyTasks → Approvals)

### Wave 5 — Documentation + deprecation (1 day)
25. PR AA — Doc-sync sweep (CLAUDE.md counts, shared/CLAUDE.md, apps/api/CLAUDE.md)
26. PR AB — Add deprecation comments to 20 unused AUDIT_ACTIONS + write-only model fields
27. PR AC — Decide + document fate of `dashboard-cards.def.ts`, `tablet-access.def.ts`, root APK

### Wave 6 — Conditional / blocked
28. PR AD — EMQX_ADMIN_PASSWORD + USE_MOSQUITTO fallback removal (only after confirmation that all envs use Mosquitto)
29. PR AE — Drop `AssetInstance.telemetryConfig` / `customAttributes` columns (only after one-release deprecation log shows no writes)
30. PR AF — Trim 20 unused AUDIT_ACTIONS keys (only after audit-team sign-off; 21 CFR risk)
31. PR AG — Trim `PipelineNodeType` / `FilterEventType` unused values (only after pipeline-editor / rule-chain registry audit confirms no dynamic registration)

---

## 9. Testing Scope After Cleanup

Per wave:

### Wave 1 — Tier-1 deletes
**Per-PR verification:**
- `cd packages/shared && npx tsc` — clean
- `cd apps/api && npm test` — single-fork stable baseline (1231 pass / 2 known fail / 9 skipped per CLAUDE.md)
- `cd apps/api && npx tsc --noEmit` — clean
- `cd apps/web && npx vite build` — succeeds
- `cd apps/web && npm test` — passes
- Manual smoke: login, role list, user CRUD, dashboard renders.

**Specific to PR A:** confirm no curl/Postman exists in `tests/` against `/api/template-kinds`, `/api/entity-assignments`, `/api/assets/relationships`, `/api/assets/templates/:id/versions`.

**Specific to PR E:** `npm ls handlebars qrcode recharts qrcode.react` returns nothing across all packages.

**Specific to PR H:** `git rev-list HEAD -- DigiLog-FilterOps.apk` shows the file is no longer tracked in HEAD.

### Wave 2 — Medium-risk consolidations
- All Wave-1 checks plus:
- CORS smoke: hit `/health` from each `ALLOWED_ORIGINS` value, verify no 403.
- After `*Redis` → `*Bus` rename: run `tests/integration/windows-server-stack.test.ts` to confirm 100 telemetry publishes still flow.

### Wave 3 — Helper extractions
- All previous plus:
- Unit tests for each new hook (`useClipboardCopy`, `usePermissions`, `useReauthMutation`).
- E2E smoke: at least one reauth-gated mutation per migrated site.
- Backend integration tests for `requireReauth` factory in `tests/integration/` covering: missing reauth → 401, valid reauth → succeeds, stale reauth → 401.

### Wave 4 — File splits
- All previous plus:
- **For `getCurrentStateImpl` split:** per-branch tests (no cycle / pending checklist / mid-stage / bypass-allowed / end-of-pipeline). UAT on mobile tablet against a live filter through a full WASH_IN → DRY_IN → STORAGE_IN flow.
- **For `mobile-operations.tsx` split:** Capacitor APK rebuild + tablet smoke for each view (Home, Status, Stage, MyTasks, Approvals).
- **For use-offline cycle resolution:** disable network, perform a cycle start + advance + submit-checklist offline, re-enable, verify sync. Cypress + manual Capacitor.
- `madge --circular apps/web/src apps/api/src` — 0 cycles.

### Wave 5 — Documentation
- No runtime checks; spot-check `grep` counts match live code.

### Wave 6 — Conditional / blocked
- **PR AD (EMQX removal):** integration test against `USE_MOSQUITTO=false` to confirm the fallback path actually was dead before removal.
- **PR AE (drop telemetryConfig / customAttributes columns):** one release with logged-write warning showing zero writes before migration runs. Post-migration: full backup + restore round-trip via `dynamic-backup.ts`.
- **PR AF (audit-action trim):** audit team formal sign-off; bypass any inspectors-in-progress.
- **PR AG (PipelineNodeType trim):** end-to-end cleaning-cycle + rule-chain + checklist execution covering every node type.

---

## 10. Estimated Risk During Production Deployment

**Reality check:** Per the memory snapshot, this codebase has **no live remote production environment** — it runs locally on Windows. The risk language below honors the prompt's "enterprise production" framing and assesses what *would* happen at a real cleanroom site. Mark each item with the deployment-mode where the risk materializes.

### 10.1 Per-wave deployment risk

| Wave | Production risk | Recommended deploy strategy |
|---|---|---|
| 1 — Tier-1 deletes | **Low.** Backend zombies have no callers; FE orphans have no routes; dep removals are 0-import verified. Worst case: a forgotten internal script hits a deleted route and gets 404 — easy revert. | Direct merge after CI green. No staged rollout needed. |
| 2 — Medium consolidations | **Low to Medium.** CORS_ORIGIN cutover could surface a forgotten origin in some env. EMQX fallback removal (deferred to Wave 6) is medium because it closes rollback. | CORS change: deploy with `ALLOWED_ORIGINS` validated in pre-deploy script. Other items: direct. |
| 3 — Helper extractions | **Low.** Migrations are additive (new helper alongside old call sites). Each site migration is per-PR. | Direct. |
| 4 — File splits | **Medium for `getCurrentStateImpl`** (hot path; 21 CFR-relevant). **Medium for `mobile-operations.tsx`** (tablet APK; offline-mode coverage). **Low for snippets/cycle/permissions splits.** | Tablet APK splits: stage to test cleanroom first (one room, one tablet) before fleet rollout. Backend splits: staged behind a feature flag if any cleanroom production exists. |
| 5 — Documentation | **None.** No runtime impact. | Direct. |
| 6 — Conditional | **High.** EMQX removal closes rollback. Schema column drops are irreversible on running data. Audit-action trim could break inspector-facing UI. | Each item: explicit owner sign-off + extended UAT + backup before deploy. |

### 10.2 Audit / compliance touchpoints

For any deployment to a 21 CFR Part 11 cleanroom environment:
- **No item in Waves 1–5 touches `AuditTrail`, the hash chain, or signed records.** Phase 1 was already careful to leave the audit chain intact even when removing entity-management UI.
- **Wave 6 PR AF (audit-action trim)** is the only item that risks inspector contracts. Treat as schema change with regulatory review.
- **Wave 6 PR AE (drop telemetryConfig / customAttributes)** drops Json columns that may carry historical configuration on live entities. Even though never read, dropping them is a record-modification event — log + audit-trail the migration.

### 10.3 Rollback strategy

- **Wave 1–3:** `git revert <PR>` then redeploy. No DB changes. Risk window: minutes.
- **Wave 4:** `git revert` works for file splits. For the offline-cycle refactor, also clear the IndexedDB on tablets (one-time SW unregister) to avoid stale layout. Risk window: 1-2 hours for fleet refresh.
- **Wave 6:** `git revert` is insufficient for schema drops (PR AE) — requires DB restore from snapshot taken before the migration. Always: backup `digilog_db` + `digilog_tsdb` before running the migration.

### 10.4 Pre-deploy gates per wave

| Gate | Wave 1 | Wave 2 | Wave 3 | Wave 4 | Wave 5 | Wave 6 |
|---|---|---|---|---|---|---|
| `tsc --noEmit` clean | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `vitest run --pool=forks --poolOptions.forks.singleFork=true` baseline matched (1231/2/9) | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `apps/web && npx vite build` clean | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| `madge --circular` 0 cycles | — | — | — | ✓ | — | — |
| Capacitor APK rebuild + tablet smoke | — | — | — | ✓ | — | — |
| `scripts/verify-windows-deployment.ps1` 4-check smoke | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| DB backup taken | — | — | — | — | — | ✓ |
| `tests/integration/windows-server-stack.test.ts` | ✓ | ✓ | ✓ | ✓ | — | ✓ |
| Audit-trail spot-check (write + verify hash chain) | — | — | — | ✓ | — | ✓ |
| Stakeholder sign-off | — | — | — | tablet team | — | audit team |

### 10.5 Bundle / performance impact

| Change | FE bundle Δ | API memory Δ | Cold start Δ |
|---|---|---|---|
| PR D (action-tape) | −60 KB minified | — | negligible |
| PR E part 1 (recharts + qrcode.react) | −650 KB | — | −30 ms |
| PR E part 2 (react-hook-form) | −150 KB | — | −10 ms |
| PR C (orphan pages + UI primitives) | −15 KB | — | negligible |
| PR B (close*Redis no-ops) | — | -5 module loads | negligible |

Total cumulative FE bundle reduction: ~875 KB minified, ~250 KB gzipped. Cold-start improvement: ~40 ms on a midrange tablet.

### 10.6 Items deliberately deferred (require external decision)

- **QR code feature** (`apps/api/src/modules/qr-code/routes.ts:7` admits placeholder SVG output): product decision needed — finish the feature (install `qrcode` for real) or remove the module entirely. Don't ship cleanroom workflow that depends on non-scannable codes.
- **Root `DigiLog-FilterOps.apk` in git:** if tablet-install workflow points at the in-repo APK, moving it to GitHub Releases needs a doc update. Confirm with the deployment team.
- **PipelineNodeType / FilterEventType unused values:** verify pipeline-editor + rule-chain registry don't dynamically register them before any trim.

---

## Appendix A — Per-file findings index

(Cross-reference for quick navigation.)

**`apps/api/src/`**
- `modules/template-kinds/routes.ts` — §2.1, §5, §6.A
- `modules/entity-assignments/routes.ts` — §2.1, §5, §6.A
- `modules/assets/routes/relationship.routes.ts` (+svc, +repo, +tests) — §2.1, §5, §6.A
- `modules/assets/routes/template.routes.ts:313-346` — §2.1, §5, §6.A
- `transport/ws-handler.ts:269` — §2.2, §5, §6.B
- `modules/data-ingestion/{rpc-handler,ingestion.service,pipeline-tracer}.ts` — §2.2, §3.3, §5, §6.B, §7.2
- `modules/rule-chain/debug-recorder.ts:92` — §2.2, §5, §6.B
- `modules/filter-operations/current-state.ts:71-568` — §3.3, §5, §7.3
- `modules/connectivity/routes.ts:226-526` — §3.1, §3.3, §5, §7.3
- `modules/qr-code/routes.ts:7` — §2.7, §10.6
- `lib/swagger.ts:41`, `modules/qr-code/routes.ts:71`, `connectivity/routes.ts:246` — §3.5, §7.4
- `plugins/rbac.ts:42-47` — §3.5, §7.4
- `app.ts:107`, `app.ts:388-392` — §3.5, §6.B
- `package.json` — §4.1
- `.env` — §2.8, §4.4
- `prisma/schema.prisma` — §3.6, §3.7

**`apps/web/src/`**
- `hooks/use-offline.ts:199, :256` — §4.3, §7.4
- `routes/filter-management/{filter-profile-list,filter-status,filter-scan}.tsx` — §2.3, §6.C
- `routes/mobile/mobile-operations.tsx` — §3.2, §7.3
- `routes/filter-management/{filter-operations,filter-list}.tsx` — §3.2 (no recommended changes)
- `routes/config/filter-data-management.tsx` — §3.2 (no recommended changes)
- `routes/pm-schedules/index.tsx`, `routes/mobile/mobile-wrapper.tsx` — §3.2, §7.3
- `lib/action-tape/ActionRenderer.tsx` + `components/*.tsx` + `__tests__/ActionRenderer.test.tsx` — §2.4, §6.D
- `components/ui/{alarm-badge,code-snippet,connectivity-indicator,help-button}.tsx` — §2.5, §6.C
- `package.json`, `vite.config.ts:73-74` — §2.7, §4.1
- Multiple files — §3.4 (repeated patterns), §3.5 (hardcoded values)

**`packages/shared/src/`**
- `schemas/auth.ts::reAuthSchema` — §2.6, §6.F
- `types/sidebar-privilege-map.ts` (equipment-groups, checklists sections) — §2.10, §6.G
- `types/permissions.ts` (MANAGE_PERMISSION_SUFFIXES) — §3.5, §7.4

**Repo root**
- `RFID/app/build/**`, `*.apk` — §2.11, §6.H
- `scripts/backfill-orphan-entity-orgs.sql`, `scripts/reset-cwh-cycles.sql` — §2.12, §6.H

---

## Appendix B — Methodology notes

- **4 parallel general-purpose agents** ran for ~10-20 minutes each against backend / frontend / schema+shared+DB / deps+config surfaces. Each used grep + targeted file reads, cross-checked against prior audit docs (cited in agent prompts) to avoid re-discovering already-fixed items.
- **Spot-check budget:** 5 candidates per high-traffic model; 10 largest methods; ~60 sampled exports.
- **NOT exhaustive:** circular-import detection was heuristic only — a single concrete cycle (use-offline) was found and confirmed via in-code comment. Recommend running `madge --circular apps/web/src apps/api/src` for exhaustive trace.
- **NOT runtime-traced:** database column read-frequency, audit-action call rate, and similar runtime metrics require production telemetry which is unavailable in local-only dev. Findings on unused columns / audit actions are based on static code grep only.
- **Working-tree note:** at audit time, Phase 1 of the entity-removal programme had uncommitted deletes (`apps/web/src/routes/assets/`, `apps/web/src/routes/config/template-kinds.tsx`) and ~10 file edits. Agents saw the post-Phase-1 state. The backend zombie modules in §2.1 are direct consequences of Phase 1 — if Phase 1 is reverted, items in §2.1 also revert to "live, callable" status.

---

*Report generated 2026-05-16. Source: 4-agent parallel deep audit + cross-reference against prior 2026-05-04 / 2026-05-09 / 2026-05-13 review docs. ~4,500 words.*
