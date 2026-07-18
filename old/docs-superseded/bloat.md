# Code Optimization Audit — 2026-04-20

**Scope:** `apps/api/`, `apps/web/`, `packages/*`. Test files and node_modules excluded from most counts unless noted. All findings verified by direct `grep`/`find` on the committed working tree (branch `RFID`, head `ebb77b6`).

**Audit principles applied:**

1. **SPIS (targeted-fix)** — a change should live in one place; parallel code paths that must be "kept in sync" are a defect.
2. **No UI quick-fixes** — prefer library primitives + reusable components over inline styles, magic numbers, and one-off timers.
3. **No dead weight** — delete what isn't used; don't keep zombie files, dependencies, or commented blocks.
4. **Push for optimization without losing functionality** — every recommendation is behavior-preserving.

Findings are grouped by severity. Every finding lists the file(s) and a concrete, minimal-blast-radius fix.

---

## P0 — Structural (fix first, unblocks everything else)

### P0.1 Parallel submit paths in `mobile-operations.tsx`

**File:** `apps/web/src/routes/mobile/mobile-operations.tsx` (2053 lines)
**Evidence:** `handleSubmit` starts at **line 497**; `handleSubmitQueue` starts at **line 283**. Both perform the same offline-validation work per filter (cached filters lookup → state resolution → `computeNextStages` → block-change enforcement → bypass checks → queueing). Comments in the source explicitly acknowledge the parallelism (`// this is the same strict offline gate applied in handleSubmit`).

**Impact:** Every offline/online validation rule exists twice. Memory trail (`feedback_batch_single_parity.md`, 2026-04-20) documents this as a known source of drift.

**Fix — SPIS-correct:** Extract one `validateAndQueue(item)` helper that both paths call. `handleSubmit` becomes `validateAndQueue({ filterId, filterName })`; `handleSubmitQueue` becomes a `for` loop over `scanQueue` calling the same helper. Net deletion likely ~150–200 LOC and removes the class-of-bug entirely.

### P0.2 Monster files

Files > 1000 lines in one module:

| File | LOC | Role |
|---|---:|---|
| `apps/web/src/routes/filter-management/filter-list.tsx` | 2433 | Filter list + hierarchy + RFID + bulk-upload + dialogs |
| `apps/web/src/routes/rule-chains/editor.tsx` | 2140 | ReactFlow editor + node/connection edit + save + debug |
| `apps/web/src/routes/mobile/mobile-operations.tsx` | 2053 | (see P0.1 — separate fix) |
| `apps/web/src/routes/filter-management/filter-operations.tsx` | 1928 | Desktop cycle operations page |
| `apps/api/src/modules/filter-operations/filter-operations.service.ts` | 1617 | Server-side cycle state machine |
| `apps/web/src/routes/checklist/index.tsx` | 1561 | Standalone checklist form |
| `apps/web/src/routes/debug/index.tsx` | 1145 | Pipeline trace inspector |
| `apps/web/src/routes/assets/templates.tsx` | 1090 | Asset template list + editor |
| `apps/web/src/routes/assets/components/template-form-editor.tsx` | 1070 | Form editor inside templates |
| `apps/api/src/modules/pm-schedules/pm-schedule.service.ts` | 1042 | PM scheduling service |
| `apps/api/src/modules/config/routes.ts` | 1003 | 40-endpoint config module |

**Fix:** split by responsibility. Suggested first cuts:

- **`filter-list.tsx`** → extract `<FilterTreeView>`, `<BulkUploadDialog>`, `<RfidAssignDialog>`, `<FilterCardList>` into `components/`. The page becomes a composition + router. Target: `filter-list.tsx` ≤ 500 LOC.
- **`rule-chains/editor.tsx`** → extract a `useRuleChainEditor` hook that owns ReactFlow state; split the right-pane node editor into per-category panels already hinted at by `apps/api/src/modules/rule-chain/nodes/*.ts`.
- **`mobile-operations.tsx`** → after P0.1, further split the scan dialog, queue list, and reason picker.
- **`config/routes.ts`** → the 40 config endpoints are already grouped logically by tab. Split into `config/static-routes/<tab>.ts` files and have `routes.ts` register them. File becomes a registration index.
- **`filter-operations.service.ts`** → promote the cycle state machine into a separate `state-machine.ts` and the async workflow dispatchers into `cycle-workflow.ts`.

### P0.3 `as any` sprawl — 435 occurrences across 121 files

**Top offenders:**
- `apps/api/src/modules/super-admin/routes.ts` — 34 (dynamic JSON rows in the data-management console)
- `packages/db/src/__tests__/telemetry-batcher.test.ts` — 25 (test mocking; acceptable)
- `apps/api/src/modules/filter-operations/filter-operations.service.ts` — 18
- `apps/api/src/modules/assets/services/instance.service.ts` — 12
- `apps/web/src/routes/filter-management/filter-operations.tsx` — 10
- `apps/web/src/routes/mobile/mobile-operations.tsx` — 10
- `apps/api/src/modules/assets/repositories/template.repository.ts` — 10
- 14 more files ≥5 occurrences

**Fix — incremental:** treat `as any` as a budget, not free. Adopt a lint rule that **disallows new** `as any` (exempt existing occurrences via allow-list). Pay down the list file-by-file, starting with `super-admin/routes.ts` where the pattern is to destructure a dynamic row — a `Record<string, unknown>` + narrow guard is almost always possible.

---

## P1 — UI quick-fix debt

### P1.1 238 inline `style={{…}}` attributes across 54 TSX files

**Hot spots:**
- `filter-list.tsx` — 26
- `pm-schedules/index.tsx` — 20
- `checklists/detail.tsx` — 15
- `config/report-settings.tsx` — 15
- `dashboard.tsx` — 13
- `cleaning-profile-editor.tsx` — 12
- `checklists/list.tsx` — 11

**Spot check** (`filter-list.tsx`): many inline styles apply the theme CSS variables (`color: var(--theme-primary)`, `background: var(--theme-gradient-*)`). This is defensible because Tailwind classes cannot bind to runtime-resolved variables. But the same pattern — `style={{ color: 'var(--theme-primary)' }}` — appears ~20 times in this file alone.

**Fix:** add three theme-classed primitives in `components/ui/`:
- `<ThemedText variant="primary|primary-dark|primary-light">` instead of `style={{ color: 'var(--theme-primary)' }}`
- `<ThemedBackground>` for `var(--theme-primary-light)` backgrounds
- `<ThemedGradient>` for the gradient dialog headers
Alternatively, add utility CSS classes in `app.css`:
```css
.text-theme-primary { color: var(--theme-primary); }
.bg-theme-primary-light { background: var(--theme-primary-light); }
.border-theme-primary { border-color: var(--theme-primary); }
.bg-theme-gradient { background: linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to)); }
```
Then mass-replace via a codemod. Removes ~200 inline-style occurrences without touching behavior.

### P1.2 Duplicated ad-hoc `actionMessage` + `setTimeout` banners

**File:** `apps/web/src/routes/users/list.tsx` — 12 `setActionMessage` + 4 `setTimeout(() => setActionMessage(null), 5000)` calls.

**Impact:** a full `<ToastProvider>` + `use-toast` system exists at `components/toast-provider.tsx` + `components/ui/toast.tsx` + `hooks/use-toast.ts`. The user list re-implements toasts locally instead of using it.

**Fix:** replace with `toast.success(...)` / `toast.error(...)` from `use-toast`. Removes ~30 LOC and the 4 timer cleanups. Check `routes/users/{create,edit,reset-requests}.tsx` for the same pattern (2+2+2 `setTimeout` calls there too).

### P1.3 62 `setTimeout` calls across 40 files

Most are legitimate (debounce, copy-confirmation, PIN clear). **Red flags to triage manually:**
- `apps/web/src/hooks/use-offline.ts` — 1 timer driving health polling; worth checking it's cleaned up on unmount.
- `apps/web/src/lib/sync-engine.ts` — 3 timers in the sync engine; these are the ones most likely to leak if a component unmounts mid-sync.
- `apps/web/src/hooks/use-entity-websocket.ts` — 2 timers around reconnect logic; reconnect backoff should ideally live behind a single reusable helper.

**Fix:** audit `sync-engine.ts`'s 3 `setTimeout`s to ensure `clearTimeout` on unmount/close paths. Consider replacing health polling with a single shared `useInterval` hook.

### P1.4 Confusing plural/singular folder naming

`apps/web/src/routes/checklist/` (singular) = the submission form for end-users
`apps/web/src/routes/checklists/` (plural) = admin CRUD for checklist profiles

Both are live and both imported. The singular/plural distinction is brittle — a typo in the import path ships the wrong page.

**Fix:** rename to unambiguous paths — e.g. `routes/checklist-form/` and `routes/checklist-admin/`. Search+replace on the 3 import sites in `main.tsx`.

---

## P2 — Maintainability

### P2.1 In-memory state that won't survive horizontal scaling

Three backend modules hold state in a process-local Map, with explicit `TODO` markers to move them to Redis:

- `apps/api/src/modules/data-ingestion/ingestion.service.ts:74` — rate limiting
- `apps/api/src/modules/notification-delivery/notification-dispatcher.ts:17` — cooldown Map
- `apps/api/src/modules/notification-delivery/delivery.service.ts:89` — setTimeout retries

**Impact:** moving from single-instance PM2 to a multi-instance topology (e.g. horizontal scaling behind Nginx) breaks these three rate-limit/cooldown/retry flows silently. Today's deployment is single-instance so the bug is latent, not live.

**Fix:** migrate to BullMQ delayed jobs for the retries, and to `ioredis` SETEX for the rate-limit + cooldown maps. Estimated ≤ 1 day of work each.

### P2.2 BullMQ queue vs worker connection pool

`packages/queue/src/connection.ts:3` — `TODO: BullMQ recommends separate connections for workers vs queue producers`.

**Fix:** add `getWorkerConnection()` and `getQueueConnection()` factories; migrate call sites in `apps/api/src/workers/*` and `apps/api/src/modules/**` over two PRs.

### P2.3 `config/routes.ts` is the wrong shape

The 40 static config endpoints are all in one 1003-line file. Addition of a new config tab requires editing the monolith — a pattern that has historically caused "forgot to wire X" defects (see user rules `feedback_config_sync.md`, `feedback_config_discovery.md`, the **12-touchpoint rule** in `future/frontend/PATTERNS.md`).

**Fix:** one routes file per config surface (`config/static-routes/password-policy.routes.ts`, …); the top-level `config/routes.ts` becomes a registration loop over an auto-discovered list — analogous to how `config-discovery.ts` already handles dynamic configs.

### P2.4 Commented-out "removed:" imports in `main.tsx`

- `apps/web/src/main.tsx:25` — `// removed: RolePrivilegesPage`
- `apps/web/src/main.tsx:27` — `// removed: SidebarConfigPage`

These are rotted comments. Delete them and the corresponding files under `routes/config/` if they still exist on disk.

### P2.5 Error-handling duplication in frontend

`apps/web/src/routes/notifications/index.tsx` — 7 `catch(err) { console.error('Failed to X:', err); }` blocks, one per mutation.

**Fix:** introduce a small `reportError(context, err)` helper in `lib/api-client.ts` that logs and surfaces a toast in one line. Replaces 7 nearly-identical blocks with `reportError('mark read', err)`.

---

## P3 — Dependency hygiene

### P3.1 Root `package.json` duplicates workspace deps

| Dependency | Root declares | Workspace declares | Status |
|---|---|---|---|
| `html5-qrcode` | `^2.3.8` | — | **Dead** — zero imports found anywhere |
| `jspdf` | `^4.2.1` | — | Used by `apps/web/src/lib/pdf-report.ts` — belongs in `apps/web/package.json` |
| `jspdf-autotable` | `^5.0.7` | — | Used by `apps/web/src/lib/pdf-report.ts` — belongs in `apps/web/package.json` |
| `sanitize-html` | `^2.17.2` | — | Used by `apps/api/src/lib/sanitize.ts` — belongs in `apps/api/package.json` |
| `bullmq` | `^5.74.1` | `apps/api` `^5.70.1` | **Version drift** — root declaration conflicts |
| `puppeteer` | `^24.37.5` | `apps/api` `^24.40.0` | Version drift |
| `vite-plugin-pwa` | `^1.2.0` | `apps/web` `^0.20.0` | Massive version drift — pin one |
| `vitest` | `^4.0.18` | various `^3.0.0` | Version drift; make sure whichever runs is consistent |
| `typescript` | `^6.0.2` | various `^5.7.0` | Version drift |
| `vite` | `^7.3.1` | `apps/web` `^6.1.0` | Version drift |
| `turbo` | `^2.4.0` | — | OK — legitimately root-scoped |

**Fix:**
1. Remove `html5-qrcode` from root — dead dependency.
2. Move `jspdf`, `jspdf-autotable` to `apps/web/package.json`.
3. Move `sanitize-html` to `apps/api/package.json`.
4. Remove root-level `bullmq` and `puppeteer` (already in `apps/api`).
5. Audit the version drift on `typescript`, `vite`, `vitest`, `vite-plugin-pwa`: either the root is leading a workspace upgrade (in which case finish the upgrade) or the root is stale (in which case remove).

### P3.2 `.playwright-mcp/` accumulation policy

Phase-4 sessions produced 136 `page-*.yml` traces (now archived in `old/playwright-artifacts/`). There is no `.gitignore` rule for this folder — every session adds more untracked files.

**Fix:** add `.playwright-mcp/` to `.gitignore`, then delete `.playwright-mcp/*.yml` on session end via a Claude Code `Stop` hook. 

---

## Summary table

| ID | Area | Files | Est. LOC removable | Risk | Priority |
|---|---|---|---|---|---|
| P0.1 | Submit-path parity | `mobile-operations.tsx` | ~150–200 | low (tested via MANUAL_TEST_GUIDE §5) | P0 |
| P0.2 | Monster files | 11 files | splitting, not deletion | low if staged | P0 |
| P0.3 | `as any` sprawl | 121 files, 435 occurrences | type hardening; no LOC change | low | P0 |
| P1.1 | Inline styles | 54 TSX files, 238 occurrences | ~200 | low | P1 |
| P1.2 | Ad-hoc banners vs toast | `routes/users/*.tsx` | ~30 | low | P1 |
| P1.3 | Timer audit | `sync-engine.ts`, `use-offline.ts`, `use-entity-websocket.ts` | 0 (correctness) | medium (offline paths) | P1 |
| P1.4 | `checklist/` vs `checklists/` naming | 3 import sites | 0 | low | P1 |
| P2.1 | In-memory cluster state | 3 backend files | 0 (correctness) | high if scaled | P2 |
| P2.2 | BullMQ connection factories | 1 file | small | low | P2 |
| P2.3 | `config/routes.ts` monolith | 1 → many files | 0 | low | P2 |
| P2.4 | Rotted `// removed:` comments | `main.tsx` | 2 lines | trivial | P2 |
| P2.5 | Frontend catch-block sprawl | 1 file, 7 blocks | ~20 | low | P2 |
| P3.1 | Root package.json drift | `package.json` | 7 entries | medium (verify lockfile) | P3 |
| P3.2 | Playwright artifact policy | `.gitignore` + hook | 136 files + future growth | trivial | P3 |

**Estimated total LOC removable from conservative fixes** (P0.1 + P0.2 first-pass extraction + P1.1 + P1.2 + P1.4 + P2.4 + P2.5): ~1500–2000 lines without any feature loss.

---

## What we intentionally did NOT flag

- **JSDoc comment blocks** — counted 65 multi-line `/* … */` blocks ≥200 chars across 30 files. Sampled ones are legitimate documentation, not dead code.
- **`console.error` / `console.warn` across 106 call sites** — most are inside `catch` handlers or worker lifecycle logs; legitimate in a Node service that doesn't have a central structured logger routed through these helpers.
- **Tests with `as any`** — mocking requires loose typing; not part of the type-hygiene budget.
- **Tablet/web shared pages** (`mobile-operations.tsx` wrapping `filter-operations.tsx`) — user rule `feedback_unified_tablet_web.md` is explicit that this shared path is intentional. P0.1 is about the two submit **functions inside** `mobile-operations.tsx`, not about the tablet/desktop split.
- **RFID guard, offline sync, hash-chain, reauth, permissions** — complex code with good tests and a real purpose. No trimming recommended.

---

## Recommended next-three-PRs

1. **PR 1 — SPIS fix (P0.1):** extract `validateAndQueue` in `mobile-operations.tsx`. Golden-path: MANUAL_TEST_GUIDE §3, §5. Scope: one file. ~200 LOC delta.
2. **PR 2 — Theme primitives (P1.1):** add the four theme utility classes in `app.css` + run a codemod replacing the top 5 files' inline styles. Scope: 5 TSX files + 1 CSS file. ~100 LOC delta.
3. **PR 3 — Dependency cleanup (P3.1):** remove `html5-qrcode` from root, move misplaced deps into their workspaces, unify version drift. Scope: 3 `package.json` + `package-lock.json`. Verify via `npm install` + `turbo run build`.

Each is a single self-contained commit, easy to review, and fully reversible.
