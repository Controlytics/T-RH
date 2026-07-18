# Cleaning Stage Interlock — Implementation Plan

**Branch:** RFID (confirm before starting — currently on RFID; ingestion-removal work is on a separate branch)
**Created:** 2026-06-12
**Status:** PLAN APPROVED — awaiting go-ahead to start Phase 1

## Goal
Two-point QA interlock inside the cleaning cycle. After **WASH_OUT** and after **DRY_OUT**,
the cycle pauses; the filter's identity + context is snapshotted and sent to a configurable
approver role. Approver re-auths (= digital signature) and Approves or Rejects.
- Approve → filter continues per the cleaning-profile graph.
- Reject after WASH_OUT → state back to WASH_IN.
- Reject after DRY_OUT → state back to DRY_IN.
- While pending, operator CANNOT advance past the stage (interlock).

## Locked design decisions (user, 2026-06-12)
1. **Approver role configurable per stage** (WASH_OUT and DRY_OUT can differ).
2. **Offline = block until online + approved.** No work proceeds without the signature.
   current-state must surface "awaiting connectivity to request approval" so the tablet
   isn't a silent dead-end.
3. **Different-role user must approve.** Enforce server-side: approver ≠ performer AND
   approver.role === stage's configured approverRole.

## Details to snapshot for the approver
Block, Area, AHU, AHU type, Micron size, Filter type, Filter dimensions, Filter set.
Sources:
- Block/Area/AHU → walk filter.parentId chain, identify by template_kind (extend
  `getFilterHomeBlock` in filter-resolver.ts to collect all levels).
- micron size / filter type / dimensions → filter attributes (micronSize, filterType, filterSize).
- AHU type → AHU instance attribute (ahuType).
- filter set → FilterDetails.filterSet.

## Phases

### Phase 1 — Data model + config (backend foundation)  ✅ DONE 2026-06-12
- [x] Prisma model `CleaningStageApproval` + enum `CleaningStageApprovalStatus`
      (PENDING/APPROVED/REJECTED). Fields: cycleId, filterId, stageKey, status,
      approverRole, rejectToStateKey, detailsSnapshot Json, requestedBy/Name/At,
      decidedBy/Name/At, decisionRemarks, attemptSeq. Indexes (cycleId,stageKey)
      / (status,approverRole) / (filterId). No Prisma relations (mirrors ReportReview).
- [x] HAND-WRITTEN migration 20260612120000_add_cleaning_stage_approvals/migration.sql,
      applied to digilog_db via psql + table verified. Client regenerated (API stopped
      for DLL lock, restarted clean — 36 modules).
- [x] Config def `stage-interlock.def.ts` (FLAT settings, not nested points):
      enabled(false) / requireDifferentApprover(true) / washOutApproverRole(ADMIN) /
      dryOutApproverRole(ADMIN). Reject targets fixed in service, not config.
      Registered in config-discovery.ts + card in config/index.tsx. Default seeded + verified.

NOTE: config shape is FLAT (washOutApproverRole/dryOutApproverRole) not the {points:[]}
array from the original plan — simpler, matches block-change-approval def pattern. The
service maps stageKey→config key + holds the fixed STAGE_INTERLOCK_POINTS
(WASH_OUT→WASH_IN, DRY_OUT→DRY_IN).

### Phase 2 — Engine integration (the interlock itself)
ADVISOR REVISIONS (2026-06-12) folded in:
- **Tape MUST be interlock-aware in Phase 2, not Phase 5** — offline client decides moves from
  the CACHED tape/stageLookup, not the server. Without this, offline operators advance past
  WASH_OUT, queue the op, and on sync the 423 poisons the whole queue → opposite of the
  "block until online" decision. Approach (no shared-pkg surgery): (a) static `interlockGated`
  flag per stageLookup entry → offline client stops at the gated stage; (b) post-filter
  actions[] in current-state.ts to drop ADVANCE_TO_STAGE/BYPASS_STAGE leave actions until
  APPROVED; (c) `interlock` field for display only; (d) server gate authoritative.
- **Notification enum pulled INTO Phase 2** — STAGE_APPROVAL_REQUESTED is a Postgres enum;
  createNotification insert throws until the value exists. ALTER TYPE ADD VALUE (3 values) now.
- **Bypass-skip gap** — bypass leave-gate covers leaving a gated stage, but bypass can also
  jump INTO a later stage skipping WASH_OUT/DRY_OUT entirely. KNOWN GAP for Phase 2 (most
  profiles are STRICT = bypass disabled). Surface to user; harden later if bypass is used.
- **DRY_OUT reject must null cycle dryer fields** (dryerStartedAt/dryerReadingsSubmitted/
  dryerDurationMinutes) — else stale data lets operator leave DRY_IN again without re-drying.
  Honor [[feedback_dryer_started_at_offline_anchor]]. → handled in Phase 3 reject handler.

Tasks:  ✅ DONE 2026-06-12 (backend; tsc clean, gate verified)
- [x] Notification enum: 3 values (STAGE_APPROVAL_REQUESTED/APPROVED/REJECTED) in Prisma enum
      + ALTER TYPE migration 20260612130000 applied + TS union in createNotification.
- [x] Module `stage-interlock.ts`: INTERLOCK_POINTS, getInterlockConfig, isInterlockStage,
      getApproverRoleForStage, getLatestApproval, assertStageApprovedToLeave (423 PENDING/
      REJECTED), collectFilterApprovalDetails (filters.attributes + ancestor walk by
      templateKind + FilterDetails.filterSet + filterName), requestStageApprovalTx (idempotent,
      attemptSeq), notifyStageApprovalRequested.
- [x] advance.ts (a) leave-gate after checklist gate; (b) create PENDING on entering (in-tx,
      atomic — captured via tx return value) + notify post-commit.
- [x] bypass.ts: leave-gate guard (+ KNOWN-GAP comment for skip-into-later-stage).
- [x] current-state.ts: `interlock` field + stageLookup.interlockGated (static, offline) +
      actions[] post-filter (drop leave ADVANCE/BYPASS until APPROVED).

VERIFIED (non-destructive, direct module call against live WASH_OUT cycle):
  config read enabled, isInterlockStage WO/DO=true WI=false, leave-gate WASH_OUT→DRY_IN throws
  423 STAGE_APPROVAL_PENDING, in-place + non-gated don't throw, snapshot resolves name/block/
  area/ahu/filterSet. Config left DISABLED (default).
DEFERRED to Phase 3 e2e (needs approver endpoints + a driven cycle): the entry approval-row
  CREATION inside advance, the notification firing, and the current-state interlock/actions
  response shape over HTTP. All typecheck clean; will be exercised end-to-end in Phase 3 tests.

### Phase 3 — Approver module  ✅ DONE 2026-06-12 (e2e green)
- [x] `stage-approvals/{service.ts, routes.ts}` @ /api/stage-approvals.
      GET /queue + GET / (STAGE_APPROVAL_VIEW), GET /:id, POST /:id/approve + /:id/reject
      (STAGE_APPROVAL_DECIDE + enforceReauthAlways = digital signature).
- [x] approve → APPROVED + APPROVAL_GRANTED FilterEvent + audit signatureMeaning + notify operator.
- [x] reject → remarks≥3 + REJECTED + STATE_TRANSITION deviation event + currentLifecycleState←
      rejectToStateKey + nulls cycle dryer fields when rejectTo=DRY_IN + audit + notify operator.
- [x] Guards: assertRoleAllowed (role===approverRole | SUPER_ADMIN), assertDifferentApprover
      (config requireDifferentApprover → decider≠performer). INVALID_STATUS on non-PENDING,
      CYCLE_NOT_ACTIVE on dead cycle.
- [x] Registered in app.ts (/api/stage-approvals). Route live (401 not 404).

VERIFIED via disposable-cycle e2e (full teardown, idle filter restored, orphan audit rows
  acceptable per precedent): all guards throw correctly; reject moves DRY_OUT→DRY_IN + nulls
  dryer + writes deviation event; approve flips status + writes APPROVAL_GRANTED; leave-gate
  BLOCKS while PENDING and PASSES after APPROVED (the full enter→block→approve→release loop).
  tsc clean. Config left disabled.
NOTE: enforceReauthAlways takes a free-string action (always-on, not registry-gated) so
  APPROVE_CLEANING_STAGE/REJECT_CLEANING_STAGE need NO reauth-actions.ts entry to function;
  perms STAGE_APPROVAL_VIEW/DECIDE work for SUPER_ADMIN now, seeded to roles in Phase 4.
  auditLog action is free-string too — STAGE_APPROVAL_* audit-registry entries are Phase 4 (UI).

### Phase 4 — Permissions / privileges / shared (12-touchpoint)  ✅ DONE 2026-06-12
- [x] permissions.ts: STAGE_APPROVAL_VIEW, STAGE_APPROVAL_DECIDE.
- [x] reauth-actions.ts: APPROVE_CLEANING_STAGE, REJECT_CLEANING_STAGE (Filter Management;
      labels note they're always-on, not config-toggleable).
- [x] audit-actions.ts + audit-templates.ts: STAGE_APPROVAL_APPROVED/REJECTED (proper 21 CFR
      registry + render templates — report-review skipped these; we did them right). Added
      filterName to reject afterValue so the template placeholder resolves.
- [x] feature-privileges.ts: stage_approvals.view/decide + FEATURE_TO_PERMISSION_MAP entries.
- [x] sidebar-items.ts + sidebar-privilege-map.ts: stage-approvals item + section.
- [x] seed.ts: granted to SUPER_ADMIN + ADMIN. Live UPDATE roles applied (both has_both=t).
- [x] NotificationType enum: already done in Phase 2 (pulled forward per advisor).
- [x] Rebuilt shared (`cd packages/shared && npx tsc`, exit 0); api tsc exit 0.

NOTE: per-package CLAUDE.md "Live Type Inventory" perm/privilege/reauth counts are ALREADY
stale (say 106/96/87, pre-date many additions) — a separate doc-count sweep is owed across the
active doc set; not blocking this feature. Existing non-SUPER_ADMIN/ADMIN roles need the perms
granted to use the inbox (by design — opt-in).

### Phase 5 — Frontend  ✅ DONE 2026-06-12 (browser-verified)
- [x] lib/stage-approval.ts (types + prettyStage + detailRows) + routes/stage-approvals/index.tsx
      inbox: To-Action/All tabs, frozen details-snapshot card (all 8 fields + filterName),
      Approve/Reject reauth dialog. main.tsx route (RequireRole STAGE_APPROVAL_VIEW/DECIDE) +
      lazy import. sidebar.tsx item.
- [x] Operator block banner: web filter-operations.tsx + tablet mobile-operations.tsx — read
      state.interlock, show "<stage> awaiting QA approval from <role>" when blocksLeaving. Server
      already drops the advance action from the tape so the button vanishes; banner explains why.
      (mobile-wrapper.tsx not needed — banner lives in the stage view rendered by mobile-operations.)
- [x] Config page auto-renders at /config/dynamic/stage-interlock (enable + segregation toggles +
      per-stage role pickers from /api/roles/active) — verified.

BROWSER-VERIFIED (took over superadmin session, Playwright): inbox renders + sidebar entry + route
  guard redirect; approve dialog shows ALL 8 detail fields + filterName; reauth signature dialog;
  Approve persisted → DB status APPROVED + APPROVAL_GRANTED event + hash-chained audit
  "Wash Out approved for filter ...". Config page renders with QA-selectable role pickers. Console:
  only benign 401s (pre-login no-token + the intentional reauth handshake) + a cosmetic DOM hint.
  Disposable data torn down; config reverted to disabled.
DEFERRED: live operator-block-banner drive (needs a real cycle at WASH_OUT) — code mirrors the
  proven equipmentGroupSyncWarning pattern, tsc clean, blocksLeaving logic verified in Phase 2.
  APK rebuild for tablet pending (mobile-operations.tsx changed).

## Touchpoints to test (CLAUDE.md correctness rule)
start-cycle · advance (both gates + block) · submit-checklist (CHECKLIST between WASH_OUT
and next) · bypass (must respect interlock) · terminate · current-state · offline replay ·
mobile + web operator UI · reports/Cleaning Record · audit-trail rendering · notifications.

## CLOSED GAP — enable-while-mid-stage (fixed 2026-06-12)
Enabling the interlock while filters were ALREADY parked at WASH_OUT/DRY_OUT stranded them (gate
blocks, but no PENDING approval existed to sign). FIXED: current-state.ts now lazily self-heals —
when a gated filter has interlock enabled + no approval for (cycle, stage), it creates the PENDING
approval (+ notifies the approver role), attributed to the REAL operator who performed the stage
(resolveStagePerformer reads the STATE_TRANSITION-into-stage event, falls back to cycle starter) so
segregation-of-duties still holds. Race-safe via the same `SELECT … FOR UPDATE` on filter_details
that advance uses. Idempotent (later polls see the PENDING and skip). Runs in single + batch
getCurrentState. VERIFIED against live parked filter L1/AHu-01/03: 0→1 PENDING, requestedBy=101114,
forRole=SUPERVISOR notification fired, 2nd poll no duplicate. Skips self-heal when no performer
event is found (won't fabricate an unattributable approval).
Note: config was briefly clobbered to enabled=false by test psql writes during verification
(re-enabled 2026-06-12, approver=SUPERVISOR). Notifications deliver to the approver ROLE only.

## Risks / edge cases
1. Offline: interlock = online-only checkpoint. Queued advance-out-of-stage must NOT poison
   the offline queue — it should hold gracefully and surface "needs connectivity".
2. Bypass must respect the gate.
3. Profiles without WASH_OUT/DRY_OUT → interlock simply never fires (keys off stateKey).
4. Reject→redo loop: attemptSeq prevents a stale attempt-1 APPROVED from releasing attempt-2.
5. Gate rule: leave stage X allowed only if LATEST approval for (cycle, X) is APPROVED.

## Reuse map (don't re-derive)
- State machine shape → report-reviews/service.ts
- Digital signature → enforceReauth + auditLog signatureMeaning
- Snapshot → report-review dataSnapshot pattern
- Notify role → createNotification({forRole})
- Hierarchy walk → getFilterHomeBlock (filter-resolver.ts)
- Gate guard style → executor.assertChecklistGatePassed (advance.ts)
