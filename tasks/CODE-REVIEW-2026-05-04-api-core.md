# API core review — 2026-05-04

Adversarial review of `auth/`, `filter-operations/`, `assets/`, `checklist-profiles/`,
`pm-schedules/`, and `admin-requests/`. Scope as briefed; ~10K LOC read.

Core architectural assessment in three lines: the cycle-write decomposition + shared
pure-guard executor + decision-tape contract is **sound and a clear improvement**.
The reauth gate + pinning sidecar work is mostly correct but has **two production-grade
holes** (one critical, one high) that require fixing before deploy. Multiple fragile
assumptions and silent-failure paths warrant cleanup this sprint.

---

## Critical (must fix before deploy)

- **[C1] `apps/api/src/lib/reauth-check.ts:101` — `x-offline-replay: true` header completely bypasses every reauth gate, with zero validation.**
  Any authenticated client (or any party holding a stolen JWT) can set this single
  header and skip all of `RETIRE_FILTER`, `REPLACE_FILTER`, `BULK_UPLOAD_FILTERS`,
  `BYPASS_FILTER_STAGE`, `APPROVE_ADMIN_REQUEST`, `UPDATE_PROFILE`, `UPDATE_FILTER_LIFECYCLE`,
  etc. This silently negates every recent reauth-hardening fix (H1, C2, M1, M2 from
  `tasks/AUDIT-2026-05-04-linkage-review.md`). The 21 CFR Part 11 attestation that
  these gates implement is meaningless when the header is unauthenticated.
  **Fix proposal:** replay must be cryptographically attested. Either:
   (a) require an HMAC-signed replay token issued at offline-cache-fetch time, scoped
       to the (userId, sessionId, filterId, clientOpId, originalPerformedAt) tuple;
   (b) require `clientOpId` + `offlinePerformedAt` to be present AND to predate the
       current session AND require an `x-replay-mac` header signed with a server-issued
       per-session secret; or
   (c) at minimum, restrict the bypass to the specific allowlist of routes the offline
       sync engine actually replays (start-cycle, advance, submit-checklist, bypass,
       terminate, identifier-create) and reject the bypass on every other reauth call.
  Today the bypass is universal, blanket, and unverifiable.

- **[C2] `apps/api/src/modules/filter-operations/cycle-write/start-cycle.ts:107-176` — claimed race protection is fictional.**
  The comment says "use transaction to prevent race conditions on double-start" but
  the in-tx recheck at L109 is `tx.filterDetails.findUnique` (no `FOR UPDATE`),
  unlike the row lock used by `lockAndVerifyFilterState` for advance/bypass/terminate.
  Two concurrent `startCycle` calls can both observe `currentCycleId=null`, both
  enter the create branch, both `cleaningCycle.create`, both `filterDetails.upsert`
  (the second will overwrite `currentCycleId` with its own cycle, orphaning the
  first). `prevCycleCount + 1` at L67 is also computed pre-tx, so `sequenceNumber`
  can collide; `cycleCode` at L70 includes the same uncoordinated `seq`.
  **Fix proposal:** acquire the lock first inside the transaction:
  ```ts
  await tx.$queryRaw`SELECT 1 FROM filter_details WHERE asset_instance_id = ${filterId}::uuid FOR UPDATE`;
  // recheck currentCycleId, then compute sequenceNumber inside the lock
  const seq = (await tx.cleaningCycle.count({ where: { filterId } })) + 1;
  ```
  Until then, the only thing preventing double-start in the field is operator timing.

- **[C3] `apps/api/src/modules/filter-operations/cycle-write/submit-checklist.ts:155-162` — ALREADY_SUBMITTED guard is broken when `currentState` is null.**
  ```ts
  attributes: { path: ['afterStage'], equals: currentState ?? undefined }
  ```
  When `currentState === null` (which is the legitimate state right after a cycle
  starts, before the first STAGE_TRANSITION advances out of START), `equals: undefined`
  causes Prisma to **drop the path filter entirely**, so the WHERE matches ANY
  `CHECKLIST_COMPLETED` event for the cycle. First checklist is fine; any subsequent
  attempt at any other stage in the cycle gets a false-positive 409 ALREADY_SUBMITTED
  and the user is locked out of the cycle.
  Worse, this is hot-path under offline replay where state can race ahead of the
  database write the operator's local sync engine has not yet reconciled.
  **Fix proposal:** treat null-state explicitly:
  ```ts
  if (currentState === null) {
    // pre-stage checklists are an unsupported legacy shape; reject with a real error
    throw new AppError(400, 'NO_CURRENT_STAGE', 'Cannot submit checklist before any stage');
  }
  // …then equals: currentState (a string)
  ```
  Or use `not: null` + an explicit string comparison.

---

## High (fix this sprint)

- **[H1] `apps/api/src/modules/admin-requests/admin-request.service.ts:10` — `new PrismaClient()` at module scope creates a second, untracked connection pool.**
  Every other module in scope uses `import { prisma } from '../../lib/prisma.js'`.
  This duplicate pool: (a) bypasses any middleware/extensions registered on the
  shared client (e.g. soft-delete plugins, query timing, redactions); (b) doubles
  the per-process pool footprint for a route that fires <1 req/s; (c) creates two
  separate FK transaction spaces, so a future move to multi-row transactions across
  admin-request + user mutations becomes impossible without re-pluming.
  **Fix:** delete L1 and L10, import the shared client.

- **[H2] `apps/api/src/modules/admin-requests/admin-request.service.ts:83-132` — admin-request approval is non-atomic.**
  `executeApproval` performs side effects (`userService.create` / `unlock` /
  `resetPassword` / `update`) **outside** any transaction; then `prisma.adminRequest.update`
  runs after, also outside a transaction. If the request status update fails for
  any reason (network blip, DB hiccup, concurrent processing), the user-side
  effect persists but the request stays `PENDING`. A subsequent admin re-approval
  produces duplicate users / repeated password resets — and there's no idempotency
  key on `adminRequestId`.
  **Fix proposal:** wrap both halves inside a single `prisma.$transaction`. Where
  the user-service call cannot live inside the same TX (because it does its own),
  add an `idempotencyKey = adminRequest.id` constraint on the user-side write so a
  second attempt is a no-op; and gate `status !== 'PENDING'` inside the same TX.

- **[H3] `apps/api/src/modules/pm-schedules/routes.ts:30-108, 230-251` — bulk PM CSV upload and entry-resubmit have zero reauth.**
  PM schedules are 21 CFR Part 11 compliance records. `BULK_UPLOAD_FILTERS` got
  reauth in the C2 fix on 2026-05-04 — `POST /api/pm-schedules/upload` is the
  exact same shape (multipart bulk write of compliance data) and got skipped.
  Similarly `POST /entries/:id/resubmit` rewrites `plannedDate` / `toleranceDays`
  with no reauth, even though the sibling `PUT /entries/:id/edit` does enforce
  it (line 270). And `POST /entries/approve` at L184 does reauth; `POST /entries/reject`
  at L207 does too — so re-submit is the obvious gap.
  **Fix:** add `enforceReauth('BULK_UPLOAD_PM_SCHEDULE', ...)` on `/upload` and
  `enforceReauth('RESUBMIT_PM_SCHEDULE', ...)` on `/entries/:id/resubmit`.
  Reauth on `/upload` must run BEFORE multipart consumption (req.file()) — the
  bulk-filter route handles this correctly at line 295; mirror that pattern.

- **[H4] `apps/api/src/modules/filter-operations/current-state.ts:50-54` — `getBatchStatesImpl` swallows ALL errors with bare `catch {}`.**
  ```ts
  try { states[f.id] = await service.getCurrentState(ctx, f.id, cleaningAreaId); }
  catch { /* skip */ }
  ```
  Any actual bug in `getCurrentState` for any one filter (auth issue, DB error,
  pin-resolution divergence, malformed pinned snapshot) is invisible. The
  client cache silently has fewer entries than expected and the offline tablet
  operator gets "filter not in cache" with no diagnosis path.
  **Fix:** at minimum log to `app.log.error({ filterId, err })`; ideally accumulate
  the failures into the response: `return { states, errors: [{ filterId, code, message }], cachedAt }`
  so the operator/admin can see which filters failed and why.

- **[H5] `apps/api/src/modules/filter-operations/cycle-write/locking.ts:30-49` — `lockAndVerifyFilterState` has no FILTER_NOT_FOUND guard.**
  When `lockedRows` is empty (the `filter_details` row was deleted between
  `loadLocalContext` and the lock acquisition — possible during retire / replace
  races), `lockedFD?.current_lifecycle_state` is `undefined`. The check at L43
  becomes `undefined !== expectedState`. If `expectedState` happens to be `null`
  (the legitimate post-cycle-start pre-first-advance state), the comparison
  passes vacuously and the writer proceeds to write into a soft-deleted row,
  producing orphaned events.
  **Fix:**
  ```ts
  if (!lockedFD) throw new AppError(409, 'FILTER_GONE', 'Filter no longer exists or was retired during this operation.');
  ```

- **[H6] `apps/api/src/modules/filter-operations/cycle-write/advance.ts:144-148` — equipment-group lazy-bind writes outside the cycle row lock.**
  ```ts
  await prisma.cleaningCycle.update({
    where: { id: cycle.id },
    data: { equipmentGroupId: cycleGroupId, equipmentGroupVersionPin: cycleVersionPin },
  });
  ```
  This runs BEFORE `lockAndVerifyFilterState` is acquired (L249). The comment
  acknowledges "pre-tx write — same as before; keeps lock-acquisition order
  unchanged." But that's exactly the bug: between this update and the row lock,
  an admin can `equipment-groups/:id` PUT to disable / version-bump the group,
  and the cycle now carries a pin to a version that the validator (which already
  read `cycleVersionPin = blockGroups[0].version` pre-tx at L141) believes is live.
  Effective state: `equipmentGroupVersionPin` is silently stale before the cycle
  has even completed its first reading-validation.
  **Fix:** move the bind into the same `prisma.$transaction` as the rest of advance,
  and re-read the live group `version` inside the lock right before pinning.

---

## Medium (technical debt)

- **[M1] `apps/api/src/modules/filter-operations/tape/tape-generator.ts:155-167` — synthetic event padding to satisfy legacy tape-version arithmetic.**
  Loop pads `events[]` with synthetic `STATE_TRANSITION` entries purely so
  `ctx.events.length === input.filterEventCount`, because `computeTapeVersion` is
  now defined as `profileVersion * 1e6 + ctx.events.length`. Future readers of
  `ctx.events` (e.g. a new pure guard added later) will see a mix of real and
  synthetic events without warning. Document hazard: any new guard that does
  per-event work will silently double-count.
  **Fix:** add an explicit `cycleEventCount` slot to `LocalContext` and rewrite
  `computeTapeVersion(profileVersion, ctx.cycleEventCount)`. Drop the padding loop.

- **[M2] `packages/shared/src/pipeline-executor/actions.ts:93-98` — tape-version overflow risk.**
  Formula `profileVersion * 1_000_000 + filterEventCount` assumes per-cycle event
  count never exceeds 1e6, but no enforcement exists. Long-running offline cycles
  with frequent micro-events (instrument readings logged as separate events,
  malicious replay) overflow the low 6 digits and corrupt the comparison —
  `assertTapeVersionFresh` then accepts STALE writes silently because the
  submitted "older" version arithmetic-equals the live "newer" one modulo 1e6.
  **Fix:** assert `cycleEventCount < 1_000_000` in `computeTapeVersion`; throw
  on overflow. Or use `BigInt`. Or use `(profileVersion << 24) | (eventCount & 0xFFFFFF)`
  with an explicit overflow guard.

- **[M3] `apps/api/src/modules/filter-operations/filter-operations.service.ts:418-528` — `replace()` calls `retire()` outside its own transaction, then opens a new transaction for the replacement and rolls back manually on failure.**
  L443: `await this.retire(ctx, filterId, remarks)` runs, commits its own TX. Then
  L449: `await prisma.$transaction(...)` opens a new TX. If the replacement TX
  throws, the catch block at L494 manually re-activates the old filter — but this
  re-activation is itself outside any transaction, so a crash here leaves a
  retired filter that was supposed to be un-retired. Audit-trail-wise: there's no
  single "replacement transaction" in the audit log; an inspector sees a
  RETIRED then a half-rollback then nothing.
  **Fix:** restructure so retire and create-replacement are both inside one TX
  using lower-level helpers, not the public `retire()`. The current code is
  correct in the happy path but the failure path violates atomicity.

- **[M4] `apps/api/src/modules/filter-operations/filter-operations.service.ts:46-53` and `start-cycle.ts:86`, `current-state.ts:155` — `(service as any).getProfilePipeline` cast indirection exists only to satisfy test monkey-patching.**
  Comment in service.ts:46-50 explicitly says "kept as a class method ... because
  get-current-state.test.ts monkey-patches it via `(service as any).getProfilePipeline = vi.fn(...)`".
  Production code is shaped by the test framework. Two costs: (a) every reader
  has to grep to see why the cast is there; (b) the cast prevents future TypeScript
  refactors from catching wrong-arity calls.
  **Fix:** inject a `profilePipelineResolver` dependency into `FilterOperationsService`
  and let tests pass a fake. Or use vitest's `vi.spyOn(filterResolver, 'getProfilePipeline')`
  module-level mock instead of monkey-patching the instance.

- **[M5] `apps/api/src/modules/assets/services/instance.service.ts:340-364` — `changeLifecycleState` mutates `currentLifecycleState` with no cycle-invariant check, no row lock, no tape-version guard.**
  Anyone with `ASSET_UPDATE` + reauth (`UPDATE_FILTER_LIFECYCLE`) can rewrite a
  filter's `currentLifecycleState` while a cycle is in progress, **silently
  desyncing the filter from its own cycle**. The reverse-lookup path (cycle's
  pinned profile expects state X, filter now claims state Y) breaks every
  subsequent `advance()` with cryptic 409 STATE_CHANGED until the cycle is
  terminated. There is no validation that no in-progress cycle exists.
  **Fix proposal:** reject lifecycle-state changes when `filterDetails.currentCycleId !== null`,
  or document this as a deliberate emergency recovery hatch and require a
  separate, more explicit reauth (`OVERRIDE_LIFECYCLE_DURING_CYCLE`) plus an
  audit-trail justification.

- **[M6] `apps/api/src/modules/filter-operations/cycle-write/start-cycle.ts:69-70` — `cycleCode` and `dateStr` use server `new Date()` instead of `offlinePerformedAt`.**
  Offline cycles synced 3 days later get a `CC-FilterX-001-20260504` even though
  the cleaning was performed on 2026-05-01. 21 CFR Part 11 traceability is
  weakly compromised — the code is operator-facing and will be quoted in batch
  reports without context.
  **Fix:** `const dateStr = (offlineTime ?? new Date()).toISOString().slice(0,10).replace(/-/g, '')`.

- **[M7] `apps/api/src/modules/checklist-profiles/checklist-profile.service.ts:158-175` — `create()` carries no reauth-style audit text and no version sidecar.**
  Comment at L159 says "First version is created lazily on first edit. Profile
  starts at version=1 with empty questions; no version row needed yet (live row
  IS v1)." This is correct in steady state but creates a fragile invariant: the
  first edit's `snapshotAndBump` snapshots the **mutated** state, not v1's empty
  state. So if a cycle pins v1 but then v1 is "lazy" — there's no
  `ChecklistProfileVersion` row for v1 — `resolveChecklistQuestions()` (helpers.ts:85-100)
  returns empty for that pin, falls through to live fallback at L102-117, and
  ends up resolving against (potentially wildly-different) v3.
  **Fix proposal:** create the v1 snapshot row eagerly at `create()` time. Storage
  cost is one row per profile. Removes the special case from every reader.

- **[M8] `apps/api/src/modules/admin-requests/routes.ts:10-65` — public `POST /` accepts `requesterEmployeeId` from the request body unverified.**
  This becomes the audit-log `userId` (admin-request.service.ts:39). Anyone
  hitting the public endpoint can claim to be "EMP1234" and the audit trail
  shows EMP1234 as the actor. The only protection is rate-limiting (5/15min/IP),
  which an attacker on a shared NAT defeats trivially. For a "submit a request"
  flow this is borderline acceptable, but the audit-trail is definitely lying.
  **Fix proposal:** at minimum, never use the public-supplied `requesterEmployeeId`
  as `auditLog.userId`. Use a synthetic `PUBLIC_REQUEST` actor and keep the
  claimed identity in `afterValue` only.

---

## Low (nits / future)

- **[L1] `apps/api/src/modules/filter-operations/filter-operations.service.ts:107-176`** —
  `updateMany` at L374 (retire) silently no-ops if the cycle is already in a
  terminal state. Probably the intended behavior, but worth a one-liner so the
  next reader doesn't suspect a bug.

- **[L2] `apps/api/src/modules/filter-operations/cycle-write/start-cycle.ts:41`** —
  HTML escape of `cleaningJustification` is open-coded (`replace(/</g, '&lt;')...`).
  Same pattern repeated in `bypass.ts:28-30`, `advance.ts:29`, `terminate-cycle.ts:31-33`.
  Extract to `escapeHtml(s: string | undefined)` in `apps/api/src/lib/sanitize.ts`
  to drop four duplicate snippets and avoid a future drift where one path adds
  `&` escaping and the others don't.

- **[L3] `apps/api/src/modules/filter-operations/cycle-write/advance.ts:225-241` —
  `checkEnd()` recursive walk is duplicated against the executor's `findReachable`
  (`packages/shared/src/pipeline-executor/actions.ts:38-63`).** Two implementations
  of the same graph walk; one will drift. Reuse the shared one.

- **[L4] `apps/api/src/modules/admin-requests/admin-request.service.ts:131` —
  `return { ...updated, ...actionOutcome }` leaks `temporaryPassword` into a
  spread that ends up in the JSON response.** Intentional, but worth a line of
  comment so a future developer doesn't add a sanitize-response interceptor that
  silently kills the password handoff.

- **[L5] `apps/api/src/modules/filter-operations/routes.ts:128-132`** — `GET /batch-states`
  has no rate-limiting and no `cleaningAreaId`-based cap. A misbehaving client
  polling this every 5s on a 500-filter site does 500 sequential `getCurrentState`
  calls per request. Already inefficient; with the H4 silent-error swallow, also
  invisible.

- **[L6] `apps/api/src/modules/auth/auth.service.ts:17-39`** — LDAP auto-provision
  catches errors with `console.error`, swallows them, then continues into
  `if (!user)` which throws USER_NOT_FOUND. The `console.error` will fire even on
  benign "LDAP not configured" paths, polluting prod logs. Either use `app.log.warn`
  with a structured object, or only log when `ldapConfig.enabled === true`.

---

## Design challenges (not bugs — questions about the approach)

- **[D1] Decision-tape adapter (`tape-generator.ts`) is intentional dead-code-in-waiting.**
  Comment at L20-22 says "Phase 8.5 Commit 3 rewrites the service to call the
  shared executor directly via `loadLocalContext(filterId)`; at that point this
  wrapper can be deleted." Phase 8.5 Commit 3 has happened
  (`local-context.ts` exists, `advance.ts:38` calls `loadLocalContext`). But
  `current-state.ts:449` still calls `generateTape({ … legacy TapeInput shape … })`.
  The adapter wrapper is **still load-bearing**. Either: finish the cutover (have
  `current-state` call `computeNextActions(localCtx, options)` directly and delete
  the adapter), or amend the comment to acknowledge that read-path lags write-path.
  Today the file's docstring is misleading.

- **[D2] `local-context.ts` builds two parallel "context" abstractions.**
  The service has `RequestContext` (auth/user/ip), the shared executor has
  `LocalContext` (cycle/profile/filter slices). `loadLocalContext` returns
  `{ ctx: LocalContext, cp, rawCycle, filterCurrentCycleId }` — and now the
  service code has `ctx` shadowing the prior `RequestContext` parameter (see
  advance.ts:38: `const { ctx: localCtx, cp, rawCycle: cycle } = await loadLocalContext(...)`).
  The rename collision is bug-bait. Recommend `lc` (local context) and `req` (request
  context) consistently, or rename `RequestContext` to `Auth` or similar.

- **[D3] Three different "snapshot-then-bump" implementations** — `ChecklistProfile`
  (Phase A.1), `FilterCleaningProfile` (A.2 lineage), `EquipmentGroup` composite (A.4).
  Each is correct in isolation but they all reinvent the same primitive (snapshot
  the outgoing state into a sidecar, then mutate live, all inside one tx).
  Recommend extracting `snapshotAndBump<T>(tx, table, id, snapshotFn)` so the
  pattern can be reasoned about once, audited once. The three flavors will
  otherwise drift — already see a divergence: ChecklistProfile's first version
  is lazy (M7), FilterCleaningProfile's lineage starts at v1 explicitly. An
  audit replay walking either type can't assume the same shape.

- **[D4] Tape-version is per-cycle but `assertTapeVersionFresh` doesn't include
  the cycle id in the comparison.** A submitted `tapeVersion=12345` against
  cycle B is compared against cycle B's live count; fine. But if the cycle has
  changed between the operator's read and the operator's write (cycle terminated,
  new one started — the FE is offline-replaying with an old `tapeVersion`), the
  recently-restored `lockAndVerifyFilterState` `CYCLE_CHANGED` recheck catches
  it — but only after `assertTapeVersionFresh` has already validated against the
  WRONG cycle. The tape-version is structurally per-cycle but doesn't carry the
  cycle identity. Recommend embedding the cycle id (or its hash) into the tape
  version to fail-fast at the executor layer.

- **[D5] `getProfilePipeline(profileId, requireActive=false)` is called with
  `requireActive=false` from `current-state.ts` and `start-cycle.ts` — but the
  parameter exists.** Anyone reading the call sites assumes "must be active";
  the false arg silently disables that. The method is also still test-spied
  via the `(service as any)` cast (M4). Two design smells stacked: a parameter
  that's only ever `false`, and an indirection that exists only for tests.
  Either delete the parameter and inline the active-check at call sites, or
  default to `true` and audit the `false` paths.

- **[D6] Reauth gate ordering vs multipart consumption.** The `/instances/bulk-upload-filters`
  route (instance.routes.ts:295) correctly runs reauth BEFORE `req.parts()`,
  with a great inline comment explaining why. The PM upload route
  (pm-schedules/routes.ts:30-108) has neither the gate nor the comment. Either
  every multipart route gets a lint rule that enforces reauth-before-parts, or
  this becomes a property test in the verification harness. Today it's
  copy-paste-driven.

- **[D7] Decision-tape contract drift surface: server emits `actions[]` with
  `additionalProperties: true` (routes.ts:95).** The schema is intentionally
  loose so the discriminated-union shapes in `Action` flow through. Cost: the
  Fastify schema offers no protection if a future shared-code refactor renames
  `params.targetState` to `params.target`. The FE 3-tier resolver is the
  only enforcement. Recommend: tighten the schema to the exact union as a
  per-action `oneOf`, or add a per-release contract test that validates a
  representative tape against a TypeScript-derived JSON schema (`zod-to-json-schema`).

---

## What I did NOT review (out of scope or too risky to assess in isolation)

- `apps/api/src/modules/assets/repositories/*` — leaf I/O, low review value.
- `apps/api/src/modules/assets/helpers/*` — pure utilities; spot-checked.
- `apps/api/src/modules/checklist-profiles/__tests__/*` — test-only.
- `apps/api/src/modules/auth/auth.repository.ts` — would need to cross-reference
  the Prisma schema's session/lockout columns and the seed; out of scope budget.
- `apps/api/src/modules/pm-schedules/pm-due-tasks.ts`, `pm-executions.ts`,
  `pm-schedule-crud.ts`, `pm-ahu-config.ts` — non-cycle, lower-stakes; not
  read in this pass.
- `current-state.ts` `equipmentGroupSyncWarning` / `profileSyncWarning` math —
  read but not adversarially validated; would need a query of historical drift
  events to verify the recommendation strings actually map to operator outcomes.
- `tape-generator/__tests__/*` — passing tests are not evidence the production
  contract is correct (per the advisor framing). Worth a separate pass.
- The shared `pipeline-executor` pure guards beyond `assertTapeVersionFresh`,
  `assertCycleActive`, `assertProfileActive` — not opened. Each is a potential
  place for a guard to silently say `{ok:true}` on an edge case.
- `assets/services/bulk-upload-filter.service.ts` — adversarial CSV injection
  surface; not opened.
- The frontend resolver tier (3-tier decision-tape consumer) — out of scope for
  this API review but absolutely the next thing to adversarially assess given
  the contract drift hazard in [D7].

---

## Summary

3 Critical · 6 High · 8 Medium · 6 Low · 7 Design Q.

**Most important finding: [C1]** — the `x-offline-replay: true` header is an
unauthenticated, blanket reauth bypass. Every recent reauth-hardening fix
(H1, C2, M1, M2 from `tasks/AUDIT-2026-05-04-linkage-review.md`) is silently
nullified for any actor willing to add one HTTP header. This is the only
finding that would block deploy on its own. C2 (start-cycle race) and C3
(false-positive ALREADY_SUBMITTED) are real but operationally rarer; C1 is
both real and trivially exploitable.
