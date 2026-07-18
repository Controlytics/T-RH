# Resume state — 2026-05-02 — Batch 6 done; 72 commits ahead of origin; push still blocked

## Where the tree is

- **Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
- **Branch:** `feature/phase5-verification`
- **HEAD:** `d31ed37` — `feat(batch-6): VHv2 + VHv3 + S4UX + WSL + DocSweep + CHVH`
- **Origin status:** **72 commits ahead** of `origin/docsCleaned`. GitHub `github.com:443` unreachable for **6 consecutive sessions**. Push remains the single longest-running blocker.
- **Working tree:** clean (no modified, no untracked).
- **Services:** both `DigiLogAPI-Phase5` and `DigiLogWeb-Phase5` Running. `https://localhost:3000/health` returns 401 (auth-gated; TLS up).
- **Live counts (verified post-batch-6 via grep/ls):**
  - 69 Prisma models, 23 enums
  - 106 permissions, 90 feature privileges, 81 reauth actions, 26 sidebar items
  - 36 API modules, 30 config defs, 27 config pages
  - 82 frontend `<Route>` definitions in `apps/web/src/main.tsx`

## Sanity check on resume

```powershell
git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" status --short        # expect: empty
git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" log --oneline -3      # expect: d31ed37, eae6ba0, 469647f
Get-Service DigiLogAPI-Phase5, DigiLogWeb-Phase5                                                     # expect: both Running
curl.exe -sk -o NUL -w "%{http_code}`n" https://localhost:3000/health                                # expect: 401
```

If any of those don't match, don't proceed — investigate first.

## Commits in this branch since `origin/docsCleaned` (newest → oldest, last 15)

| Hash | Subject | Date |
|---|---|---|
| `d31ed37` | feat(batch-6): VHv2 + VHv3 + S4UX + WSL + DocSweep + CHVH | 2026-05-02 |
| `eae6ba0` | feat(version-history): admin page + new VERSION_HISTORY_VIEW permission | 2026-05-02 |
| `469647f` | feat(notifications): P3 — drop AWS SNS dependency; SMS via generic HTTP gateway | 2026-05-02 |
| `1581c6b` | feat(filter-operations): P1 — cycle-side EquipmentGroup version pinning + latent FK bug fix | 2026-05-02 |
| `08799d1` | fix(template-service): Step 4 delete guard goes through repo; restore unit-test hermeticity | 2026-05-02 |
| `b48b2e4` | docs(tasks): add Step 4 resume note | 2026-05-02 |
| `e857fea` | feat(filter-profile): Step 4 — applicableTemplates JSONB to join table | 2026-05-02 |
| `1700088` | docs(tasks): add Phase A.4 resume note (Path A complete) | 2026-05-02 |
| `6affffc` | feat(equipment-groups): Phase A.4 — composite version sidecar + history endpoints | 2026-05-02 |
| `5761cd6` | docs(tasks): record Phase A.3 touchpoint verification in resume note | 2026-05-01 |
| `7216804` | docs(tasks): add Phase A.3 resume note | 2026-05-01 |
| `a818f58` | feat(filter-profile): Phase A.3 — version sidecar + history endpoints | 2026-05-01 |
| `4bc9d34` | feat(cleaning-profile): Phase A.2 — lineageId + version history endpoints | 2026-05-01 |
| `19a5454` | docs: full sync after Phase 4 — Redis fully retired | (older) |
| `cd03de3` | feat: Phase 4 — retire Redis (ioredis dropped, in-process bus + TTL cache) | (older) |

`git log --oneline | wc -l` against `origin/docsCleaned..HEAD` = **72**.

## What landed across this multi-session run (newest → oldest)

### Batch 6 (2026-05-02, commit `d31ed37`)
Six items per user direction; web-or-server-side only (tablet/android explicitly skipped).

| Item | Summary | Files |
|---|---|---|
| **VHv2** | Structured snapshot viewers replace JSON pretty-print modal in `version-history`. Cleaning profile shows stages + connections + reasons; filter profile lists applicable templates; checklist profile renders questions; equipment group groups instruments by stage. Raw JSON behind a toggle. | `apps/web/src/routes/version-history/index.tsx` |
| **VHv3** | "Compare with v(N-1)" expander on each timeline row. Kind-aware diff: scalars, keyed arrays diffed per-item by id/key, set-style fields (applicableTemplates, allowedBlocks). Meta fields filtered out. | same file |
| **S4UX** | TEMPLATE_IN_USE returns structured `details.bindings` array; FE renders binding profiles inline as cards instead of generic toast. Test asserts the new shape. **Deep-fix:** `ConflictError` extended to accept `details?: unknown`. | `apps/api/src/lib/errors.ts`, `apps/api/src/modules/assets/services/template.service.ts`, `apps/api/src/modules/assets/services/__tests__/template.service.test.ts`, `apps/web/src/routes/assets/templates.tsx` |
| **WSL** | Top-level `install-windows.ps1` orchestrator (tooling sanity → build → mosquitto → services → start → /health probe). Matching `uninstall-windows.ps1`. Em-dash bug caught + fixed for PS 5.1. AST-parse-validated. | `scripts/install-windows.ps1` (new), `scripts/uninstall-windows.ps1` (new) |
| **DocSweep** | Live-count regex sweep. **9 stale doc count references** found and bumped: 4 from VH commit miss (105→106 / 89→90 / 25→26) + 5 pre-existing pre-MT-removal stale (109→106 / 91→90). | `CLAUDE.md`, `AGENTS.md`, `PROJECT_SUMMARY.md`, `PROJECT_ARCHITECTURE.md`, `LOCAL_SETUP_WINDOWS.md`, `windowsIssues.md`, `packages/shared/CLAUDE.md`, `docs/index.md` |
| **CHVH** | "Pinned Versions (audit replay)" card on cycle timeline page; chips for Pipeline / Equipment / Checklist version pins, each deep-linking to `/version-history?entity=…&id=…&v=…`. Version-history page reads URL params on mount. | `apps/web/src/types/filter.ts`, `apps/web/src/routes/cleaning-cycles/timeline.tsx`, `apps/web/src/routes/version-history/index.tsx` |

### Earlier in the same multi-session run

| Commit | Subject | Significance |
|---|---|---|
| `eae6ba0` | VH admin page + `VERSION_HISTORY_VIEW` permission (SUPER_ADMIN by default; assignable via Role Privileges → Audit / Versions). 4-tab master-detail UI at `/version-history`. Updated route gates on the four `/versions` endpoints + entity list/detail to OR-accept the new perm. | Closes the FE sync gap for the four versioned entities. |
| `469647f` | **P3** — AWS SNS dependency dropped. `sendViaAwsSns()` (the `aws` CLI spawn) removed; `aws-*` fields scrubbed from `SmsConfig` type, route enum, sensitive-key mask, audit-log redaction, FE config page, both `sms-settings.tsx` and `email-settings.tsx`. Default SMS provider switched to `http-gateway` — covers MSG91 / Plivo / AfricasTalking / Kaleyra / custom backends via configurable URL + headers + body template. Compiled dist contains zero AWS references. | Fully synced FE + API. |
| `1581c6b` | **P1** — cycle-side EquipmentGroup version pinning. `cleaning_cycles.equipmentGroupVersionPin Int?` stamped at start-cycle (and reading-submit lazy-bind). Reading validation reads operating-range from the pinned `EquipmentGroupVersion.snapshot` instead of the live group. **Latent pre-existing FK bug also caught + fixed**: `filter-operations.service.ts:877` was storing FilterProfile id where `cleaning_cycles.profile_id` FKs to FilterCleaningProfile id; masked because no FilterDetails-bound cycle had ever started in the dev DB. | Server-side only. Tablet/offline-app contract for sending `expected<Entity>Version` is documented in `future/offline-version-sync-contract.md` (Slice B; bundled with next APK build). |
| `08799d1` | Step 4 delete-guard hermeticity fix — `findFilterProfileBindings` moved to repo so unit tests stay isolated from prisma. | Bug-fix follow-up to `e857fea`. |
| `e857fea` | **Step 4** — `FilterProfile.applicableTemplates` JSONB → `FilterProfileApplicableTemplate` join table with cascade FKs. AssetTemplate delete blocked with `409 IN_USE` if bound. Wire shape preserved as `string[]` via flatten helper. A.3 snapshot fixed to read live join rows. | Closes Step 4 of the 9-step refactor. Models 68→69. |
| `6affffc` | **Phase A.4** — EquipmentGroup composite versioning. `EquipmentGroup.version` + new `EquipmentGroupVersion` sidecar (snapshots group + 3 instruments together). Cleaning reasons NOT versioned (already drift-resistant via `CleaningCycle.cleaningReasonKey` + `cleaningReasonLabel`). | Closes Phase 5b Path A versioning + the A.4-deferred design call (P1). |
| `a818f58` | **Phase A.3** — `FilterProfile.version` + new `FilterProfileVersion` sidecar (snapshot-then-bump). | |
| `4bc9d34` | **Phase A.2** — `FilterCleaningProfile.lineageId` + version-history endpoints. | |

## Current state map

### Phase 5b Path A (universal versioning rollout) — ✅ COMPLETE

| Phase | Target | Pattern | Commit |
|---|---|---|---|
| A.1 | ChecklistProfile + questions | Sidecar + cycle pin | (older) |
| A.2 | FilterCleaningProfile | Rowful immutable + lineageId | `4bc9d34` |
| A.3 | FilterProfile | Sidecar (no cycle pin needed) | `a818f58` |
| A.4 | EquipmentGroup composite | Sidecar | `6affffc` |
| A.4 | Cleaning reasons | No code (already pinned) | `6affffc` |
| P1  | EquipmentGroup cycle pinning (A.4 follow-up) | `cleaning_cycles.equipmentGroupVersionPin Int?` | `1581c6b` |

### 9-step architectural refactor

| # | Item | Status | Commit / Note |
|---|---|---|---|
| 1 | templateKind enum → admin-editable lookup | ✅ DONE 2026-04-30 | (older) |
| 2 | relationshipType enum + bidirectional check | ✅ DONE 2026-05-01 | (older — `51e1110`) |
| 3 | AssetInstance.organizationId NOT NULL | ❌ OBSOLETE | Superseded by MT removal |
| 4 | applicableTemplates JSONB → join table | ✅ DONE 2026-05-02 | `e857fea` + `08799d1` (hermeticity fix) |
| 5 | Investigate two checklist systems | ✅ NO-OP 2026-04-30 | Different domains, can't consolidate |
| 6 | FilterDetails 1:1 split | ✅ DONE 2026-05-01 | (older) |
| 7 | Multi-version pipeline rollout (per-block) | ❌ DEPRIORITIZED 2026-05-01 | Per user — pharma SOPs require uniform recipe |
| 8 | Decision-tape architecture | ⏳ pending — biggest (2-4 weeks) | Touches APK rebuild — currently out of scope per user |
| 9 | Cycle as event fold | ⏳ blocked on #8 | Same |

### Bug-fixes caught + resolved during this run (deep-fix per CLAUDE.md)

1. **Latent FK bug** — `filter-operations.service.ts:877` storing FilterProfile id into `cleaning_cycles.profile_id` (FKs to FilterCleaningProfile id). Masked since no FilterDetails-bound cycle had ever run. Fixed inline in `1581c6b`.
2. **`ConflictError` couldn't carry structured details** — pre-existing API limitation. Extended in `d31ed37`.
3. **`template.service.test.ts` hermeticity** — Step 4's first cut hit prisma directly from a mocked-repo test. Refactored to go through the repo layer in `08799d1`.
4. **9 stale doc count references** — pre-existing post-MT-removal drift + VH commit incomplete sweep. Fixed in `d31ed37`.
5. **Em-dash chars in PS scripts** — broke PS 5.1 tokenization. Caught by AST parser; replaced with `--` in `d31ed37`.

### Skipped per user direction (do not pick up without explicit re-approval)

- **Slice B — offline-version-sync contract for tablet** (the `expected<Entity>Version` + 409 SCHEMA_DRIFT + tablet self-heal flow). Documented in `future/offline-version-sync-contract.md`. Touches APK rebuild + tablet QA — explicitly skipped per user "skip anything tab/android" direction.
- **Step 8 (decision-tape) + Step 9 (cycle-as-event-fold)** — same reason; APK rebuild + 2-4 week scope.

## Next-session checklist

1. **Sanity check** (the 4 commands at top of this note).

2. **Push attempt** — first thing every session:
   ```
   git -C "C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification" push origin feature/phase5-verification
   ```
   72 commits will land on origin once the network returns. If it fails again, leave commits local and proceed to step 3.

3. **What's actually pending** (sorted by readiness, no tablet/android items):

   **Ready, no design call:**
   - **None left from the prior batch list.** Items 2–7 (VHv2, VHv3, S4UX, WSL, DocSweep, CHVH) all landed in `d31ed37`.

   **Possible follow-ups, only if the user re-asks:**
   - **Browser smoke test** of the new Version History + Pinned Versions UI on a live cycle (we never did one — would need actual data seeded). Half hour.
   - **Real cycle replay test** for P1 — start a cycle on a profile with a real pipeline graph, edit the equipment group operating-range mid-cycle, advance through WASH_IN with a reading at the boundary. Heavy setup (~1-2h) — verifies the pinned-snapshot validation path end-to-end. Structural correctness was already proven in `1581c6b` via direct DB inspection.
   - **Vitest config** for `apps/web` — there's no FE test setup; the diff engine in `version-history/index.tsx` has zero coverage. If the user wants FE tests added, that's a separate ~half day.
   - **MEMORY.md** index — claude-mem folder is at `C:\Users\hello\.claude\projects\C--Users-hello-21cfrlogbook-DigitalFMS\memory\` — review whether any new memory entries are warranted from this multi-session run.

   **Skipped per user (re-confirm before reviving):**
   - Slice B (tablet offline-version-sync) — `future/offline-version-sync-contract.md`.
   - Step 8 (decision-tape) — touches APK.
   - Step 9 — blocked on Step 8.

4. **GitHub network status** — check `curl.exe -sk -o NUL -w "%{http_code}\n" https://github.com` first thing. If non-zero exit / connection refused, push will keep failing. If 200, push immediately.

## File-by-file state of new things added across the multi-session run

| File | Status | Notes |
|---|---|---|
| `apps/api/prisma/schema.prisma` | M | A.2 lineageId, A.3 FilterProfileVersion, A.4 EquipmentGroupVersion, P1 equipmentGroupVersionPin column, Step 4 FilterProfileApplicableTemplate. 69 models total. |
| `apps/api/src/lib/errors.ts` | M | ConflictError now accepts `details?: unknown` (Batch 6). |
| `apps/api/src/modules/cleaning-profiles/{routes,service}.ts` | M | A.2 lineage; gates relaxed to OR-accept VERSION_HISTORY_VIEW. |
| `apps/api/src/modules/filter-profiles/{routes,service}.ts` | M | A.3 sidecar + Step 4 join table integration; gates relaxed for VH. |
| `apps/api/src/modules/checklist-profiles/routes.ts` | M | Gates relaxed for VH. |
| `apps/api/src/modules/equipment-groups/{routes,service}.ts` | M | A.4 composite sidecar; gates relaxed for VH. |
| `apps/api/src/modules/assets/services/template.service.ts` | M | Step 4 delete guard via repo (`08799d1`); structured TEMPLATE_IN_USE details (Batch 6). |
| `apps/api/src/modules/assets/repositories/template.repository.ts` | M | `findFilterProfileBindings()` added in `08799d1`. |
| `apps/api/src/modules/assets/services/__tests__/template.service.test.ts` | M | 11/11 tests pass; updated for new 409 shape. |
| `apps/api/src/modules/filter-operations/filter-operations.service.ts` | M | P1 cycle-side pin + latent FK bug fix. |
| `apps/api/src/modules/notification-delivery/{channels/sms-channel,types,routes}.ts` | M | P3 — AWS SNS removed. |
| `apps/api/src/modules/config/defs/notification-sms.def.ts` | M | P3 default switched to http-gateway. |
| `apps/api/prisma/seed.ts` | M | SUPER_ADMIN role gets VERSION_HISTORY_VIEW. |
| `packages/shared/src/types/permissions.ts` | M | VERSION_HISTORY_VIEW added (105 → 106). |
| `packages/shared/src/types/feature-privileges.ts` | M | version_history.view + FEATURE_TO_PERMISSION_MAP entry (89 → 90). |
| `packages/shared/src/types/sidebar-items.ts` | M | version-history entry (25 → 26). |
| `packages/shared/src/types/sidebar-privilege-map.ts` | M | maps version-history → version_history.view. |
| `apps/web/src/routes/version-history/index.tsx` | NEW | 4-tab page with structured snapshot viewers, version diff, deep-link query param support. |
| `apps/web/src/main.tsx` | M | `/version-history` route registered with VERSION_HISTORY_VIEW gate. |
| `apps/web/src/components/layout/sidebar.tsx` | M | Version History entry added (rendered conditional on permission). |
| `apps/web/src/routes/assets/templates.tsx` | M | Inline TEMPLATE_IN_USE bindings list. |
| `apps/web/src/routes/cleaning-cycles/timeline.tsx` | M | "Pinned Versions" card with deep-link chips (CHVH). |
| `apps/web/src/types/filter.ts` | M | CleaningCycle extended with equipmentGroupId/equipmentGroupVersionPin/checklistVersionPins (CHVH). |
| `apps/web/src/routes/config/notification-settings/{sms,email}-settings.tsx` | M | P3 — AWS SNS UI block removed; default switched to http-gateway. |
| `scripts/install-windows.ps1` | NEW | Top-level orchestration installer (Batch 6). |
| `scripts/uninstall-windows.ps1` | NEW | Service uninstaller (Batch 6). |
| `future/offline-version-sync-contract.md` | NEW | Slice B design memo (P1 tablet contract). |
| `future/architectural-refactor-9-steps.md` | M | Steps 4 + 7 status updates; AWS SNS marked DONE. |
| `tasks/STEP-5B-A-VERSIONING-PLAN.md` | M | A.2/A.3/A.4/P1 marked DONE; Path A complete. |
| `tasks/todo.md` | M | Audit log entries for every commit. |
| `tasks/RESUME-STATE-2026-05-01-phaseA2.md` ... `RESUME-STATE-2026-05-02-step4.md` | NEW | Phase-by-phase resume notes. |
| `CHANGELOG.md`, `CLAUDE.md`, `AGENTS.md`, `README.md`, `PROJECT_SUMMARY.md`, `PROJECT_ARCHITECTURE.md`, `BACKEND_GUIDE.md`, `OFFLINE_SYNC_ARCHITECTURE.md`, `LOCAL_SETUP_WINDOWS.md`, `windowsIssues.md`, `apps/api/CLAUDE.md`, `apps/api/DECISIONS.md`, `apps/web/src/types/filter.ts`, `packages/shared/CLAUDE.md`, `docs/index.md`, `docs/getting-started/*`, `docs/user-guide/entities/entities-and-hierarchy.md`, `future/overview/CODEBASE_SUMMARY.md`, `PHASE_5_RECENT_WORK.md`, `API_REFERENCE.md` | M | Doc-synced across the run. |

## Known network constraint

GitHub `github.com:443` unreachable for **6 consecutive sessions** (Phase A.2 → Batch 6). All 72 commits stay safe locally on `feature/phase5-verification`. When the network returns, a single `git push` ships everything.

## Memory entries that may be worth adding (not yet written)

- `feedback_em_dash_in_ps_scripts` — em-dashes break PS 5.1 tokenization; convention is ASCII-only with `--` for em-dashes. Caught in Batch 6.
- `feedback_conflict_error_details` — `ConflictError` extended to accept structured `details?: unknown` and forward to AppError. Use this for any future 409 that needs to return structured payload (not just string).
- `project_phase5b_path_a_complete` — A.1 + A.2 + A.3 + A.4 + P1 all closed 2026-05-02. Every mutable definition feeding a cleaning cycle now has byte-exact audit replay.
- `feedback_doc_sweep_after_each_commit` — `feedback_doc_sync_each_phase` already covers this, but Batch 6 found 9 stale references because the rule was applied per-commit instead of including a final sweep. Worth adding "and a final sweep before declaring batch done."
- `project_72_commits_local_2026_05_02` — branch state when push first comes back online so the user knows exactly what landed.

(Decide whether to write these on resume, or after the push lands.)

---

Recorded 2026-05-02 immediately before the user paused. Self-contained — anyone resuming should be able to pick up from sanity-check + push attempt without reading anything else.
