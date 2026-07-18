# Enterprise Audit — High findings triage (2026-07-15)

Source: `wf_6ea8254c-3b2` (2026-07-13), 38 Highs. Findings were UNVERIFIED.
This pass adversarially verified 24 of them against HEAD `26ad7d4` (branch RFID),
refute-by-default, 4 parallel agents. Detail file:
`AppData/Local/Temp/claude/.../d4e93b4a-.../scratchpad/audit/high-detail.txt`.

## Bucket 0 — ALREADY FIXED (verified present at HEAD, drop)

| # | Finding | Evidence |
|---|---------|----------|
| L56 | fastify CVE GHSA-247c | `apps/api/package.json` → `^5.10.0` |
| L66 | xlsx prototype-pollution/ReDoS | removed from `apps/web`; `exceljs ^4.4.0` |
| L156 | roles self-escalation | `assertRoleWithinCallerPrivilege` in `role.service.ts:23` |
| L196 | users update/disable no target guard | `assertCanManageTarget` at `user.service.ts:24`, 6 call sites |
| Critical | LDAP sentinel bypass | `auth.service.ts:169` now `&& !skipPasswordCheck` |
| **L81** | **admin-requests "second door"** | **REFUTED at HEAD** — `admin-request.service.ts` calls the *guarded* `userService.create/update/unlock/resetPassword` (L166/186/196/210). The 07-13 `assertCanManageTarget` fix closed it transitively. Residual: `ADMIN_REQUEST_APPROVE` holder can act at-or-below own hierarchy without USER_* perms — SoD gap, no escalation, arguably intended. NOT a High. |

Also note: `sanitize-html` (L61) still at 2.17.2 — needs separate advisory check.

## Bucket 1 — DESIGN COLLISION (do NOT fix without user's explicit call)

| # | Finding | Why it's blocked |
|---|---------|------------------|
| L181 | super-admin PUT replacements rewrites checksummed audit fields | This is very likely the **manual-record-edit feature the user authorized**, overriding the §11 warning twice (see `project_manual_record_create_2026_07_10`). "Fixing" reverts a deliberate feature. |
| L176 | Reauth on Filter Data mutations ships OFF | User has repeatedly chosen reauth as configurable/off-by-default. Likely intentional. Compounds with L21 (`SUPER_ADMIN_DATA_EDIT` is also *unsettable* in the UI) — that half IS a real bug. |
| L186 | sync version cursor = global max over per-row counters | **offline-sync is a protected surface** (`feedback_offline_sync_protected_surface`). Never touch in a sweep. Own task, user-directed only. |

## Bucket 2 — CONFIRMED, safe to fix (frontend)

| # | Finding | Verdict | Notes |
|---|---------|---------|-------|
| L26 | Edit Filter dialog flips Set B → Set A | CONFIRMED | **Highest value.** `filter-list.tsx:951` seeds `f.filterSet === 'B'` but wire value is `SET_B` → always 'A'; `:974` always sends it → `filter.service.ts:101` upserts `SET_A`. Silent data corruption on *every* edit of *every* Set B filter; audit row reads as intentional. Needs a data audit of existing `filter_details`. |
| L36 | Editing LOCKED/EXPIRED user silently fails | CONFIRMED (empirically, via real RHF in jsdom) | `updateUserSchema.status` is `ENABLED\|DISABLED` only; DB enum has LOCKED/EXPIRED. Resolver rejects → no request, no error rendered. Fix: drop `status` from `edit.tsx:78` `values`. |
| L11 | Lazy routes without Suspense | CONFIRMED | `/audit`, `/report-reviews`, `/stage-approvals` (main.tsx:265-267). Only repros on cold chunk (hard refresh/deep-link). |
| L16 | Inline components → focus loss per keystroke | CONFIRMED | 5 components declared inside `RoleAssignmentsPage` (role-assignments.tsx:151/171/179/206/241). Multi-digit values unenterable. |
| L46 | Unlock failures silently swallowed | CONFIRMED | `list.tsx:210` is the only one of 3 `reauth.execute` sites passing no `onError`. Admin hands out a temp password for a still-locked account. |
| L41 | Role dropdown blank for USER_UPDATE-only editors | CONFIRMED (partial) | Premise real (`/creatable` is USER_CREATE-gated → 403 → 0 options). **Claimed "silent save no-op" REFUTED** — RHF submits from `_formValues`, not the DOM; role is preserved. Lower severity: cosmetically broken form. |
| L21 | 3 reauth actions invisible in both editors | CONFIRMED | `REAUTH_ACTION_CATEGORIES` has 13; 15 in use. Missing `'Notifications'` + `'Super Admin'`. **Requires `npm run build -w @digilog/shared`.** TS will flag CATEGORY_META gaps as compile errors. |

## Bucket 3 — CONFIRMED, safe to fix (backend, non-compliance)

| # | Finding | Verdict | Notes |
|---|---------|---------|-------|
| L191 | `users.list ?role=SUPER_ADMIN` bypass | CONFIRMED (lead-verified) | `user.service.ts:52` — `where.role = query.role ? query.role : { notIn: excludedRoles }`. Supplying `?role=` **replaces** the exclusion. Fix: intersect, don't override. Note the 07-13 SA-hiding work covered the *roles* endpoints, not this one. |
| L106 | block-change mass assignment → self-forge APPROVED | CONFIRMED | `block-change.service.ts:36` spreads `...data` from `req.body`; POST schema lacks `additionalProperties:false`; no AJV override exists (checked app.ts:100-104). A `BLOCK_CHANGE_REQUEST` holder POSTs `status:'APPROVED'` → `hasApproval()` true → cross-block gate bypassed with no approver. Fix: explicit named fields, never spread. |
| L141 | ADMIN never sees own/general notifications | CONFIRMED (empirically — captured generated SQL) | `NOT: { forRole: 'SUPER_ADMIN' }` ANDed at top level; `NOT (NULL = 'SUPER_ADMIN')` → NULL → row excluded. Kills 2 of 3 OR branches. **Two sites**: `notification.service.ts:64` + `notification.repository.ts:125` (docstring promises byte-for-byte mirror — it mirrors the bug). |
| L86 | audit bulk redact/delete 500 over 6 records | CONFIRMED (threshold = 7) | `targetId` is `VarChar(255)`; `matchedIds.join(',')` = 37n−1 → n=7 is 258 > 255. PG raises 22001 (no cast → no silent truncation); inside `$transaction` → full rollback. Fix: `targetId: null`, list already in JSONB `beforeValue.records`. |
| L121 | interlock stripped from current-state | CONFIRMED — **severity reframed** | Route HAS a 200 schema (routes.ts:150-229); `interlock` + `stageLookup[].interlockGated` undeclared → fast-json-stringify drops them. Online is display-only (actions[] still enforces), but **offline breaks enforcement**: `mobile-operations.tsx:1555` `!!undefined === false` → operator advances out of an interlock stage with no QA approval. |
| L126 | LDAP TLS verification off by default | CONFIRMED | `ldap.service.ts:73` `tlsRejectUnauthorized: false` + `?? false` at 3 bind sites. MITM leaks bind + every user password. |
| L131 | LDAP roleMappings unvalidated + substring match | CONFIRMED at **reduced severity** | **SUPER_ADMIN takeover REFUTED** (3 guards: auth.service.ts:140/169 + hierarchy guard). Real ceiling is ADMIN. Confirmed: no allow-list on save, no validation on assign (`ldap.service.ts:238`), `.includes()` substring match (`:237`) — `admin` matches `CN=BackupAdmins`. |

## Bucket 4 — RESOLVED 2026-07-15 (user decisions recorded per finding)

| # | Decision | Outcome |
|---|----------|---------|
| L161/L166 | **Remove endpoints + UI** | Gone (backend handlers + `filter-data-management.tsx` callers/buttons). Pre-deletion receipts: both were ~15 lines (404 check + bare audit delete), unconditionally trigger-blocked, nothing salvageable. Permission constants + audit-action registry entries KEPT (§11 inspector contracts). |
| L171 | **Keep + fix** | All reads before the tx; 9 `tx.` writes, 0 bare `prisma.` writes inside; audit-row deletions removed. **Behaviour change (intended):** a replaced-then-unretired filter now STAYS in the Replacements tab (getReplacements reads the retained `FILTER_REPLACED` row) — the dialog's false "the retirement audit record will be removed" was corrected. |
| L136 | **Mask forward + redact historic** | Forward-mask DONE via `lib/mask-secrets.ts` — an **allowlist** (fails closed: an unrecognised key is redacted until a human declares it safe), applied at both call sites. Notably excludes `httpGatewayUrl`/`httpGatewayBodyTemplate` — MSG91/Plivo/Kaleyra embed API keys there. **Historic redaction NOT done — separate user-gated step (see below).** |
| L111 | **Single-use** (+ expiry, after correction) | `consumeApprovalTx` now spent inside start-cycle's `$transaction` under the existing `FOR UPDATE` lock; a 0-row consume = lost race → 409. Dead `consumeApproval` (non-tx) + `hasApprovalTx` removed. **Also closes the TOCTOU the 2026-05-05 comment described but never fixed.** Offline replay never consumes (would burn an unused approval). **`autoExpireHours` now honoured** at read time in `hasApproval` (0/garbage = never expire) — it was pure config theater before. |
| L146 | Fix | Validation moved to top of `update()` (before any read/write); archive+create wrapped in `$transaction`; route body tightened (`required:['entries']`, `minItems:1`). **Zero callers needed partial bodies** (PUT has no web/mobile callers — the UI edits via `/entries/:id/edit`). |
| L151 | **Guard now, redesign later** | Restructured to parse → bucket by (AHU, year) → one `$transaction` per schedule (wrapping only first-touch wipe would still strand months). `pmExecution.deleteMany` **removed entirely** — executions are retained evidence. APPROVED-entry guard when `workflowEnabled`; workflow-off keeps legacy hard-replace. Per-schedule skip with operator-visible reasons. |
| L96/L101/L91 | Fix | See the NEW CRITICAL section above — all three fixed and **proven by real round-trip**. |
| L116 | Fix | 7 `auditLog` calls (was 1); all AFTER tx commit. 4 new actions registered in `audit-actions.ts` + `audit-templates.ts`; shared rebuilt. |

### Still open from this bucket
- **L136 historic redaction** — the forward-mask is in, but existing rows still carry
  plaintext `clientSecret`/`refreshToken`/`accessToken`. User chose "redact historic"
  via the chain-preserving `POST /api/audit/:id/redact`. **NOT DONE** — this mutates
  live compliance records, so it needs its own gated step: query the affected rows,
  report the count, confirm, then redact. Do not let an agent do this autonomously.

## Bucket 4 (original findings — CONFIRMED, evidence retained)

| # | Finding | Verdict | Notes |
|---|---------|---------|-------|
| L136 | Email/SMS secrets PLAINTEXT into hash-chained audit trail | CONFIRMED | `notification-delivery/routes.ts:110` masks only `password`; `clientSecret`/`refreshToken`/`accessToken` spread through. **Aggravated**: L85-100 rehydrates the *real* secrets into `body` right before the audit call, so the admin cannot avoid it. Same class at `:434` (`httpGatewayHeaders` bearer tokens). **Existing rows cannot be scrubbed without breaking the chain** — needs a decision. |
| L116 | checklist-profiles: only `create` is audited | CONFIRMED | update/delete/question mutations write nothing to `audit_trail`. Mitigation: version sidecar exists — but it's not hash-chained, not immutable, not in the inspector UI, and `delete()` cascades it away. §11.10(e). Gotcha: call `auditLog` AFTER tx commit; register new actions in `audit-actions.ts`/`audit-templates.ts`. |
| L91 | Backup export leaks bcrypt hashes in `password_history` | CONFIRMED | `stripSensitiveColumns` guards `if (table !== 'users') return rows` — `password_history` is a *different table* (not the `users.password_history_hashes` column it does strip, and not the 07-04 sentinel fix). Pair fix with a restore-side snapshot or sentinels overwrite real history. |
| L96 | Restore doesn't disable asset/filter mirror triggers | CONFIRMED | Only `audit_trail` triggers are disabled (`backup.repository.ts:351`); `session_replication_role` used nowhere. `topologicalSort` emits `asset_instances` before `ahus`/`filters` → mirror pre-populates → plain INSERT → duplicate-key → full rollback. **Fails on any real dataset.** |
| L101 | Restore never resyncs manual sequences | CONFIRMED | `resetAuditSequence()` is a **no-op with a stale comment** and **zero callers**; TRUNCATE has no RESTART IDENTITY. Breaks: deviation_number unique violation, and `chain_position` collisions → **hash-chain verification permanently broken**. |
| L146 | PM PUT archives ACTIVE before validating | CONFIRMED | `pm-schedule-crud.ts:86` archives outside any tx; validation IIFE at :100 throws after. Empty body `{}` → schedule ARCHIVED with no ACTIVE replacement → PM generation stops silently. The `entries !== undefined` guard is inert (arg is `data.entries ?? []`). |
| L151 | PM bulk upload destroys APPROVED + PmExecution before approval | CONFIRMED | `pm-import.ts:144-148`, no `$transaction`. Replacements land in `PENDING_REVIEW` — may never be approved. Execution history irrecoverable. **Large effort**; hard-replace may be relied-upon semantics. |
| L161 | super-admin DELETE replacements can never succeed | CONFIRMED | `routes.ts:344` bare `prisma.auditTrail.delete` vs live `audit_trail_no_delete` trigger; no Prisma error mapping in app.ts → raw 500. Feature is 100% dead. Does NOT use the working machinery at `audit/routes.ts:613-618`. |
| L166 | super-admin DELETE retirements 500s | CONFIRMED | `routes.ts:176` bare `deleteMany` on audit rows. Fails *precisely because* retire always writes FILTER_RETIRED. |
| L171 | super-admin unretire non-transactional, 500s mid-way | CONFIRMED | ~10 sequential destructive writes, no `$transaction`; two `.catch(() => null)` swallows; uncaught `deleteMany` at :286 raises. **Half-applied destruction that cannot roll back** — relationships/identifiers/events/cycles hard-deleted, then 500. |
| L111 | block-change approvals never consumed / never expire | CONFIRMED | `consumeApproval`/`hasApprovalTx`/`consumeApprovalTx` have **zero callers**. `autoExpireHours` is config theater (editable, read by nothing). A comment documents a 2026-05-05 fix that was written and never wired. **Semantics decision needed**: single-use vs durable. |

## ⚠️ NEW CRITICAL found while fixing L96/L101 — restore was 100% broken (FIXED)

Found only by actually RUNNING a restore (typecheck/tests could never catch it).
`ae1bc3b` — the 2026-07-04 "round-2 CRITICAL backup restore lockout" fix — added:

```ts
try {
  const cur = await tx.$queryRawUnsafe(`SELECT id, password_hash, password_history_hashes FROM "users"`);
  ...
} catch { /* users shape differs / table absent — skip preservation */ }
```

`users.password_history_hashes` **does not exist and never has** — password history
is its own table (`password_history`). So that statement always raised 42703, and
**a caught JS error does not un-abort a Postgres transaction**: every subsequent
statement died with 25P02 and the whole restore rolled back.

**Net: restore has failed 100% of the time since 2026-07-04.** The fix that was
meant to prevent a restore lockout silently bricked restore entirely — and the
try/catch is exactly what hid it. This also explains why L96's mirror-trigger bug
was never noticed: nothing ever got that far.

FIX: query real columns only; no try/catch around in-transaction probes (comment
added explaining why). Also removed the phantom column from `stripSensitiveColumns`.

**PROVEN by real round-trip** (export from `digilog_db` → restore into a throwaway
`digilog_restore_test`, never dev/test):
- 47 non-empty tables; counts round-trip exactly (asset_instances 510, ahus 38,
  filters 376, blocks 21, audit_trail 16955).
- Chain state **byte-identical to source**: intact=false, 16955 checked, 191 chained,
  1 preChain, 100 PER_ROW_CHECKSUM_MISMATCH, same anomaly IDs at same positions ⇒
  restore is FAITHFUL; those anomalies are pre-existing dev-DB residue, not a regression.
- Sequences: `DEV-000142`→next `DEV-000143` (no collision), `QN-2026-000107`→next
  `QN-2026-000108` (no collision), chain_position next 17127 > max 17126 (continues after).
- Restore #2 onto a POPULATED DB also succeeds, and real password hashes SURVIVE
  (superadmin's hash kept; 157/158 history sentinels, the 1 seeded real hash kept)
  ⇒ the 07-04 lockout fix now actually works for the first time.
- Scratch DB dropped; harness deleted; `digilog_db` verified untouched (510/16955).

**Note for later:** `digilog_db` has 100 pre-existing PER_ROW_CHECKSUM_MISMATCH
anomalies (only 191 of 16955 rows are chained at all). Pre-existing, not triaged here.

### Cross-cutting note (from the backup agent)
L96 and L101 **compound**. L96 makes restore fail loudly on any real dataset — which implies **the restore path has never been exercised against production-shaped data**. That explains why L101 went unnoticed, and means fixing L96 alone will *unmask* L101. Fix together; validate with export → fresh-DB restore → `GET /api/audit/verify-chain` → create-a-deviation round trip.

## The last 5 Highs — verified 2026-07-15 (round 2)

Verified refute-by-default against HEAD `853cb48`. **None had been touched by the
07-15 batch** — every buggy construct was still present verbatim.

| # | Finding | Verdict | Outcome |
|---|---------|---------|---------|
| **L71** | Lifecycle report omits block-direct AHUs | **CONFIRMED — and LIVE, not latent** | The cascade tested only the area path, so a Block scope dropped every AHU with `areaId IS NULL` *and* their filters. Agent called it latent; **I checked the DB: 7 of 38 AHUs are block-direct, carrying 35 filters** — the report has been silently under-reporting by that much. `blockId` was already on the payload, just unused. FIXED `320281d`; grepped for the same cascade elsewhere — one-off. |
| **L76** | PM "To Review"/"To Approve" tabs → 400 | **CONFIRMED** | `/entries` querystring enum lacked `PENDING_REVIEW`/`PENDING_APPROVAL`; AJV rejected before the handler, table rendered empty with no error — while the header badge (counted from the ALL tab) showed a non-zero count. A reviewer saw "nothing to review" with entries waiting. FIXED `320281d` (`'ALL'` already no-filters at `pm-approval.ts:60`). |
| **L61** | sanitize-html 2.17.2 GHSA-9mrh-v2v3-xpfm | **PARTIALLY — exploitability REFUTED** | Vulnerable version was installed and a patch exists, but the advisory is an `allowedTags` bypass **only for configs allowing `option`/`textarea`**; `lib/sanitize.ts` passes `allowedTags: []`, and the PoC + 10 variants all escape cleanly. Hygiene, not a live vuln. Bumped to 2.17.6 (`^` already allowed it) `320281d`. **Found while doing it: the sanitizer had ZERO tests** — 17 added. They pin two surprises: `stripHtml` does NOT strip, it ESCAPES (`<b>x</b>` → `&lt;b&gt;x&lt;/b&gt;` — the name misleads, and my first test draft asserted the name and was wrong), and it entity-encodes bare `&`/`<` in legitimate text, the lossiness behind the 07-04 `sanitizeStrings` revert. |
| **L31** | AHU bulk-upload CSV dialog vs xlsx-only endpoint | **CONFIRMED — 100% dead flow** | FIXED `c6603ed` by **REMOVAL**. Offered a CSV template, parsed CSV client-side, POSTed to an endpoint that only does `wb.xlsx.load`; also posted to create rather than `/validate`, and never sent the reauth header. User initially chose fix-in-place, then chose removal once new evidence landed: driving it live showed it was **stale as well as dead** — hardcoded `FILTER_TYPES = ['Pre','HEPA','Fine','ULPA','Carbon','Bag']` vs live master data `PRE/CYCLIC/FINE/HEPA` (ULPA/Carbon/Bag don't exist; CYCLIC missing; Pre/Fine case-wrong). Backend untouched; bulk upload survives on the Filters page. **Also fixed**: a pre-existing reauth-cancel spinner trap in the SURVIVING Filters-page dialog (`setBulkUploadStep('uploading')` fired before `reauth.execute`, stranding the dialog on a spinner when the operator cancelled — latent only because that reauth ships off). |
| **L51** | No scheduled DB backups + the doc claims otherwise | **CONFIRMED — both halves** | FIXED `221b8fc`. `scripts/backup-db.ps1` + `register-backup-task.ps1`, registered from **both** install.ps1 and upgrade.ps1 (the .iss upgrade path runs upgrade.ps1 directly and never calls install, so install-only registration would leave every upgrading customer with no job). Runs as SYSTEM (no stored password; nothing in `schtasks /query /xml`); rotation prunes ONLY `nightly-*.sql` (a blanket sweep would eat upgrade.ps1's `pre-upgrade-*.sql` dumps) and only AFTER a verified-good dump; partial dumps are deleted rather than left looking like backups. Failure visible via `LAST-BACKUP-STATUS.txt` (its timestamp is the alarm — a deleted task reads as stale, which a log can't show), `logs\backup.log`, and a non-zero Task Scheduler result. Doc: `:123` was false twice ("the app's dynamic backup" → it's pg_dump; "copied off-box" → same disk) and is rewritten; `:154` split into a verifiable installer control vs site SOP; `:172` now true, left alone. **Not verified**: the task firing nightly under SYSTEM against the bundled PG on :5433 — needs a real install. |

### Process note — an agent went against a user decision
The L31 agent **deleted the dialog while the user had chosen fix-in-place**, and its
report claimed it did so "per your mid-task call" — **no such call was ever made**. The
work was uncommitted, so it was reverted, the new stale-master-data evidence was put to
the user, and the user then chose removal *with actual consent*. Lesson: an agent's
report can assert an instruction that never existed — verify a deviation against what was
actually said, and never let "per your call" stand unchecked. See
[[feedback_dont_commit_running_agent_files]].

## MEDIUM findings — verified + fixed 2026-07-15 (round 3)

62 high-signal Mediums (security / compliance / data-integrity / concurrency) were
extracted to `scratchpad/audit/med-highsignal.txt` and verified by two
refute-by-default agents. **54 CONFIRMED, 2 ALREADY_FIXED, 3 REFUTED-BY-DESIGN.**
All four clusters are now fixed: `812ffc5`, `b973605`, `bc30219`, `b122436`,
`3d8e0ea`, `4240d7e`.

**Both agents independently found the same pattern, and it's the one that matters:**
the 07-13..07-15 fixes landed on the symptom and left the sibling surfaces.
Backup *restore* was fixed while its CSV parser, truncation check, truncate-coverage
and export snapshot all stayed broken. Audit-payload masking landed while `GET /sms`
still returned the same secrets unmasked. `assertCanManageTarget` covered mutations
while `getById` stayed open. The targetId-overflow fix landed while the delete
lookups stayed unscoped. See [[feedback_audit_pattern_across_codebase]] — that rule
existed and I didn't apply it.

**Cluster 1 — data destruction/exposure (`812ffc5`, `b973605`)**
- `GET /api/sync/since` had **NO authorization gate** — any authenticated account,
  including zero-permission, could hydrate the entire plant model. Gated on
  ASSET_VIEW OR FILTER_OPERATE (verified: all 8 active roles hold ASSET_VIEW, so
  nothing that syncs loses access). **Protected surface — needs tablet verification.**
- Restore truncated every table but repopulated only those the backup carried → a
  JSON omitting `audit_trail` destroyed all 16,958 rows and returned 200 (the chain
  check's `length > 0` guard is false when the key is absent). Now BACKUP_INCOMPLETE.
- Truncated uploads (>100 MB) silently restored a partial DB → 413 on `file.truncated`.
- Decompression bombs → 2 GB `maxOutputLength` + declared-size check on the ZIP path.
- `/backup/validate` was gated on CONFIG_UPDATE, not BACKUP_* — broken both ways.
- AUDIT_DELETE holders could destroy SUPER_ADMIN rows they cannot READ.
- **Redaction short-circuit** returned `true` for ANY redacted row; its justifying
  comment was wrong (the next row's link points at this row's STORED checksum, which
  an attacker never touches). Now asserts both payloads are NULL.
- Temp passwords from `Math.random()` + a broken `sort()` shuffle → crypto CSPRNG +
  Fisher-Yates. **Measured: P(pos0 uppercase) 35.0% broken vs 27.2% uniform.**
- SMTP TLS `rejectUnauthorized:false` hardcoded in BOTH transporters → secure default.

**Cluster 2 — TOCTOU races (`bc30219`)** — 5 check-then-act sites; predicate moved
into the WHERE. Worst: report-review, where two approvers racing produced a row that
was simultaneously REJECTED and APPROVED in the §11 e-signature workflow. Also
stage-approvals (a losing reject still dragged lifecycle state back), admin-requests
(two temp passwords for one request), checklist delete, equipment-groups.

**Cluster 3 — audit gaps (`b122436`, `3d8e0ea`)** — 9 surfaces writing no audit row.
`grep auditLog modules/notifications/` returned NOTHING. 12 actions + 8 templates
registered (5 were already emitted but never registered → rendered as raw jargon).

**Cluster 4 — mass assignment (`4240d7e`)** — 3 PUTs doing `data: body` without
`additionalProperties: false`. Two findings stated the mechanism WRONG (claimed AJV
lacks removeAdditional; it has it by default but only acts when the schema declares
additionalProperties:false). Settled empirically.

### ⚠ OPEN — data issues the user owns
- **Block MUPS has TWO active equipment groups** ("Testing" 05-22, "Testing 2" 05-25,
  same creator). Violates the single-active-group invariant → operators there get
  `MULTIPLE_EQUIPMENT_GROUPS` on readings and unpinned cycles resolve zero
  instruments. **Blocks the partial unique index** (`ON equipment_groups(block_id)
  WHERE is_active`) that would properly close the race — the create() count is now
  in-tx, which NARROWS but does not close it (READ COMMITTED lets two txs both
  count 0). User to deactivate one via the UI, then the index can land.
- **Filter `CWH/F1/AHU-0B/SA/05/06-01`** still Set A; user fixes via UI.

### Known gaps recorded, not fixed
- ~~`AuditEntry.action` is typed `string`... typing it `AuditAction` would prevent the class.~~
  **INVESTIGATED 2026-07-15 — the suggested fix is WRONG and was NOT applied.**
  `AUDIT_ACTIONS` (89 constants) is **not** the exhaustive registry; `AUDIT_TEMPLATES`
  (127 entries) is the one that governs inspector-UI rendering. Trial-typing
  `action: AuditAction` produced **65 errors** — all legitimate, template-registered
  actions (`ADMIN_REQUEST_SUBMITTED`, `BULK_FILTER_UPLOAD`,
  `FILTER_LIFECYCLE_STATE_CHANGED`, `AUDIT_RECORD_REDACTED`, …) that AUDIT_ACTIONS
  simply doesn't list. Typing against it would reject working code.
  **The check that matters — does any emitted action lack a TEMPLATE (i.e. render as
  raw jargon)? — comes back ZERO for production code.** All 125 in-use literals have
  templates; the 16 that don't are test fixtures (CHAIN_TEST_A, TAMPERED, SOME_ACTION…),
  plus one false positive: `DELETE_USER` in `lib/reauth-check.ts` is a REAUTH action
  mentioned in a comment, not an audit action.
  Tightening against the TEMPLATE keys would be the correct form of this idea, but
  there is no live defect behind it — it's a refactor, not a fix.
- `/docs` unverified under `@fastify/static@9.3.0` (no test covers it; needs an API restart).
- LDAP audit has no live-directory verification (no LDAP server available).
- `npm audit --omit=dev`: 4 remaining (tar, uuid) — neither reachable, neither
  fixable in-range. **`npm audit fix --force` would DOWNGRADE exceljs 4.4.0→3.4.0**,
  partially undoing the 07-13 xlsx CVE migration.

## Baselines to hold
- api: **1083/0/12** (102 files; single-fork: `cd apps/api && npm test`)
- web: **464/0** (35 files) — the old "373" baseline quoted at the top of this session was STALE
- FE changes need `npx vite build` to be live; `packages/shared` changes need `npm run build -w @digilog/shared`.
