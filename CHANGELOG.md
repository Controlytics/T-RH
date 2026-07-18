# Changelog

## [Unreleased] — Replacement-schedule audit rows name the AHU/filter (2026-07-18)

Replacement-schedule workflow audit rows now show **which** entry was acted on.
The audit templates already read `{targetName}` (e.g. `Replacement schedule
"{targetName}" approved by {actor}`), but the workflow only stored the
comment/remarks in `afterValue` — no name — so the frontend resolved
`{targetName}` to `''` and its empty-`""`-collapse rendered a bare
`Replacement schedule approved by EMP-124`. `workflow.ts` now embeds an
AHU/filter descriptor (`name` = `"AHU: AHU-12 · Size: 610x610 · Micron: 10µ ·
Qty: 4"` — each value **titled** so the one-line summary is self-explanatory
and the dimension can't be mistaken for the micron — plus structured
`ahuName`/`filterSize`/`filterMicron`/`qty` for the detail drill-down) into
`afterValue` for every per-entry action (reviewed, rejected-at-review,
approved, rejected-at-approval, resubmitted, review-modified); the batch
**upload** row (`service.ts`, one row for the whole file) gets an `ahus[]` list
(same titled format) for its drill-down. No frontend or audit-template change —
`getAuditSummary` already resolves `{targetName}` from `after.name`, and the
detail modal already itemizes the structured fields under "Full record".

Historical rows are immutable/hash-chained and **cannot** be back-filled without
breaking the chain (21 CFR Part 11), so pre-fix rows (which stored only the
comment/remarks, no name) are instead enriched at **read time**: `GET /api/audit`
batch-resolves each `replacement_schedule_entry` row's entry by `targetId` and
stamps the titled `name` + structured fields onto the *returned* `afterValue`
(mirroring the existing `pm_schedule_entry` enrichment; reuses the exported
`entryLabel` so read-side and write-side formats can't drift). The stored row is
never modified — `integrityValid` still verifies against the original checksum.
Only resolves for entries that still exist (a deleted entry's old rows keep the
bare summary). e2e guard: `src/e2e/replacement-audit-enrichment.test.ts`.
Commits `55f9865`, `15d9635`, `2a1fe6f`.

## [Unreleased] — Multiple equipment groups per block (2026-07-16)

A block may now have **multiple active equipment groups** at once, and the
Enable/Disable toggle is **removed**. Previously enabling one group disabled the
others (single-active-per-block). Now every group is created active and stays
available; the operator picks which group to record readings against per cleaning
(the equipment dialog's existing group picker — the runtime already supported
this, only the config side restricted it). `create()` always-active;
`setActive()` + `PATCH /:id/active` removed (delete/soft-delete is the only
removal path, keeping the last-active-group in-use guard); the
`equipment_groups.toggle` permission-tree node removed (non-configurable, so
feature-privilege counts are unchanged); web config toggle UI removed; the
`assertSingleEquipmentGroupPerBlock` runtime guard stays as a "select one" safety
net. Existing inactive groups are left as-is (isActive is ambiguous between
disabled and soft-deleted, so no blanket reactivation). Design:
`docs/superpowers/specs/2026-07-16-multiple-equipment-groups-per-block-design.md`.
Commit `2183090`.

## [Unreleased] — AHU overdue-replacement cleaning gate (2026-07-16)

Blocks **starting** a new cleaning cycle on any active filter under an AHU whose
replacement task is **overdue** (the `MISSED` status: past `windowEnd`, not fully
replaced), until that specific filter is replaced. Whole-AHU scope; per-filter
unblock (a replaced filter becomes cleanable immediately while un-replaced
siblings stay blocked); in-flight cycles finish (the gate is start-only, so
advance/checklist/atomic ops are untouched).

Enforced **online** (authoritative) and **offline**. Server: new
`blockedFilterIdsForCleaning`/`isFilterBlockedForCleaning` helpers in
`replacement-schedule/service.ts` (sharing an `unreplacedAhuFilterIds` primitive
with `listTaskEntries` so the gate and the "replaced X of Y" progress can't
drift), a new open-to-any-role `GET /api/replacement-schedules/blocked-filters`
endpoint, and a `409 AHU_REPLACEMENT_OVERDUE` gate in `start-cycle.ts` that
exempts offline replay (mirrors `validateBlockChange`; consumed via dynamic
import to avoid a module-scope circular dependency). Tablet: caches the
blocked-filter set like `checklist-profiles` and refuses a start via
`validateOfflineGate`'s new `replacementBlocked` flag. Design +
plan: `docs/superpowers/specs/2026-07-16-ahu-overdue-cleaning-gate-design.md`,
`docs/superpowers/plans/2026-07-16-ahu-overdue-cleaning-gate.md`. Commits
`60f2c55`..`a236bd7`. **Device verification pending** (see the plan's Task 6).
Known limitations (all by decision, not oversight): online single-scan start
relies on the server gate (client gate is offline-only there); desktop offline
starts are unblocked (desktop uses its own inline gate; desktop-online is
server-covered); and the admin **"Edit Filter Status"** manual cycle-start
(back-dated `-M` path via `startManualCycleTx`) is **exempt** — it bypasses
`startCycleImpl`, so the gate does not fire there, intentionally, as an admin
correction surface in the same class as the manual-record-create tool.

## [Unreleased] — Six confirmed-live clusters fixed; 3 filings refuted (2026-07-15)

> **Scope correction.** `ba41cb5`'s subject says "close confirmed-live backlog".
> That is an overclaim and this entry supersedes it. Six clusters were fixed;
> **74 low-signal Mediums remain genuinely unverified** (a 2026-07-13 fan-out
> stalled and never read them), as do 89 untriaged Info findings. See §1 of
> `tasks/ENTERPRISE-AUDIT-CONSOLIDATED-2026-07-15.md` for the standing tally.

Works the findings left after the verification sweep, in four parallel clusters
over non-overlapping file sets. `ba41cb5` (32 files, +1859/-264) + APK `77a80d4`.
**Verified serially once all agents had landed: API 1159 passed / 0 failed / 12
skipped (112 files); web 530/530 (41 files); both typechecks clean.** No schema
changes; offline-sync untouched.

**Data integrity.** Partial `PUT` no longer wipes filter attributes — "field
absent" had been an *overloaded* signal (the edit dialog meant "clear it", every
other caller meant "don't touch"), so replace-semantics honoured the dialog and
destroyed regulated data for anyone else. Now: absent = don't touch, explicit
`''`/`null` = clear; the builder is untouched so create + bulk-upload stay
byte-identical. Found outside scope: the audit `afterValue` logged the partial
input rather than the merged result. Filter delete now refuses with 409 when a
cycle is IN_PROGRESS and frees RFID identifiers in-tx — **not** a
cascade-terminate, because `retire()` is the audited path that stamps a reason
and `delete` carries no remarks, so auto-terminating would manufacture an
unremarked §11 cycle-termination.

**Auth / correctness.** A bare `catch` wrapped ~180 lines including 6 Prisma
queries, so any DB fault surfaced as `401 TOKEN_EXPIRED`; the `try` is now
narrowed to `verifyToken` (pure jose — everything else in there was I/O).
graphile-worker boot failure now logs at error and surfaces as
`/api/health.jobRunner`, **deliberately still 200**: `probeServer` reads `r.ok`,
so a 503 would flip every tablet offline over a background-job fault.
`/api/health` was also returning `db` and having it silently dropped by
fast-json-stringify (undeclared in the response schema). deployment-check read
`API_PORT` while `install.ps1` writes `PORT` — a *correct* customer install
WARNed and a broken one PASSed. Zero-connection cleaning profiles rejected at
both doors (`update()` had skipped validation entirely when `stages` was absent).

**Security.** Password policy enforced on admin resets (`unlock`/`resetPassword`/
approve validated nothing; approve had a bare `length < 8`) — validator parity
only, not history, since the target is force-changed at next login. Photo upload
was gated on `USER_UPDATE` while its own comment said "authenticated users only":
**70 users across 6 roles were 403'ing on their own profile**. Now auth-only,
with a route rate limit bounding the orphan-file loop this widens (keys on IP,
not user — rate-limit registers before authPlugin). Equipment-group `setActive`
was an unguarded second door to delete's soft-delete mutation; both paths now
refuse when disabling a block's last active group would strand unbound
in-progress cycles, under `SELECT … FOR UPDATE` inside the tx.

**API base.** 17 raw relative `fetch('/api/...')` sites now use the base every
other caller already uses. Dev proxies `/api` so `getApiBase()` is `''` — no
behaviour change. `fetch(logoUrl)` deliberately left: it's an asset load and the
pattern spans 3+ files, so it's one policy question, not a local prefix.

**Three filings refuted — recorded, not fixed.** `retire()` must NOT free
identifiers: injecting the cascade turned `replace()` red — the tag row is
destroyed, `replace()` still returns 200, and the replacement filter comes up
untagged. `retire()` being hands-off is a load-bearing precondition of
`replace()`, which re-points identifiers onto the replacement; and `unretire` is
reversible, so a physical delete would silently restore a tagless filter. The
real pattern is *free the tag when the binding becomes meaningless (delete),
preserve it when the filter's history stays meaningful (retire), move it when the
physical tag stays on the wall (replace)* — three behaviours, all already
correct. Net: zero production code, one test; the invariant had been protected
only by a code comment. Separately, the "tablet-breaking" framing on the API-base
cluster was wrong — `contact-admin` is desktop-only and `main.tsx`'s native guard
redirects any non-`/m` path to `/m/login`, so those fetches never ran on the APK.
And the unbound-cycle guard is **preventive, not live**: of 13 unbound cycles, 8
have no `cleaning_area_id` and 5 sit in a block that never had a group.

**Open, needs a decision.** 6 of 10 notification event types have zero emit sites,
but a live ACTIVE rule ("Filter Replacement") uses `CHECKLIST_APPROVED`/
`CHECKLIST_REJECTED`. Trimming needs a hand-authored migration against a populated
DB and would destroy that rule. Worse: the test-fire endpoint dispatches the
rule's own type with fabricated vars, so **an admin's test succeeds while the rule
never fires in production**.

**Mutation-tested throughout**, which earned its keep: one mutation exposed a test
passing against a broken implementation — `vi.clearAllMocks()` does not drain
`mockResolvedValueOnce` queues, so a leaked queue fed the next test.

## [Unreleased] — Enterprise-audit Medium findings: 54 confirmed, 54 fixed (2026-07-15)

62 high-signal Mediums (security / compliance / data-integrity / concurrency; the
generic "correctness" and "performance" ones were skipped) verified
refute-by-default by two independent agents: **54 CONFIRMED, 2 ALREADY_FIXED, 3
REFUTED-BY-DESIGN**. All four clusters are fixed across `812ffc5`, `b973605`,
`bc30219`, `b122436`, `3d8e0ea`, `4240d7e`. Evidence per finding:
`tasks/ENTERPRISE-AUDIT-HIGHS-TRIAGE-2026-07-15.md`.

**The most valuable result isn't a defect — it's a pattern.** Both agents
independently found that the 07-13..07-15 fixes landed on the *symptom* and left
the *sibling surfaces*: backup **restore** was fixed while its CSV parser,
truncation check, truncate-coverage and export snapshot stayed broken;
audit-payload masking landed while `GET /sms` still returned the same secrets
unmasked; `assertCanManageTarget` covered mutations while `getById` stayed open;
the targetId-overflow fix landed while the delete lookups stayed unscoped.

### Data destruction / exposure (`812ffc5`, `b973605`)

- **`GET /api/sync/since` had NO authorization gate.** The global hook
  authenticates the token, but authentication is not authorization — any
  logged-in account, *including one with zero permissions*, could hydrate the
  entire plant model (every filter with its full attributes JSON, plus templates,
  checklist profiles, pipelines, equipment groups). The header claimed the data
  was "filtered by what the user's templates make visible"; it never was. Gated on
  ASSET_VIEW OR FILTER_OPERATE, mirroring the endpoints it duplicates — verified
  against the live DB that all 8 active roles hold ASSET_VIEW, so nothing that
  syncs loses access. **Offline-sync is a protected surface: needs tablet
  verification.**
- **Restore truncated every table but repopulated only those the backup carried.**
  A hand-built or cross-version JSON omitting `audit_trail` destroyed all 16,958
  rows and returned 200 — the chain check never ran, because its `length > 0`
  guard is false when the key is absent, and `/validate` reported valid because it
  only parses what IS present. Now refuses with `BACKUP_INCOMPLETE`; `force=true`
  remains the explicit escape hatch.
- **Truncated uploads restored a partial database, silently.** Past the 100 MB
  limit multipart truncates rather than rejects; `parseSqlBackup` then `break`s at
  the malformed tail and returns a valid-looking partial whose audit prefix is
  chain-consistent, so verification passed. Both handlers now 413 on
  `file.truncated`.
- **Decompression bombs** — the 100 MB cap bounds compressed bytes only, and gzip
  reaches ~1000:1. Added a 2 GB `maxOutputLength` plus a declared-size check on the
  ZIP path (the central directory gives uncompressed sizes without decompressing).
- **`/backup/validate` was gated on CONFIG_UPDATE**, not BACKUP_* — broken in both
  directions.
- **AUDIT_DELETE holders could destroy SUPER_ADMIN rows they cannot READ** — the
  reads filter them, both delete lookups didn't, and the meta-audit row echoed the
  hidden row's contents back in `beforeValue`.
- **The redaction short-circuit holed the tamper-evidence the design rests on.**
  `verifyAuditChecksum` returned TRUE for any redacted row, justified by "a
  mutation would still surface via chain mismatch on the NEXT row". False: that
  link points at this row's **stored** checksum, which an attacker never touches.
  Rewrite the payload, leave the checksum, and row + chain both verify while the
  API serves the forgery — the exact DB-level actor the file names as its threat
  model, and it fired ahead of the V3 HMAC path so a keyed chain didn't help.
- **Temp passwords came from `Math.random()`** plus a `sort(() => Math.random() -
  0.5)` shuffle — not a CSPRNG, and a non-transitive comparator yields a biased
  permutation. Now `crypto.getRandomValues` with rejection sampling + Fisher-Yates.
  Measured, not assumed: P(position 0 is uppercase) was **35.0% broken vs 27.2%
  uniform**.
- **SMTP TLS verification was hardcoded off** — `rejectUnauthorized: false` in BOTH
  transporters, reading no config. Same class as the LDAP TLS default fixed 07-13,
  in a file that batch never touched. Now secure by default with an explicit
  opt-out.

### TOCTOU races (`bc30219`)

Five check-then-act sites: read the row, check its state, then issue an
**unconditional** write. The predicate now lives in the WHERE, so Postgres
serialises the writes and the loser matches zero rows *before any side effect*.

- **report-reviews** — the worst, because it's the flagship §11 e-signature
  workflow. A report assigned to a ROLE admits every member, so racing approvers
  was routine: A rejects, B approves, B's unconditional update overwrites it. The
  row ended up carrying `rejectedBy`/`rejectionStage='APPROVAL'` **and**
  `approvedBy`/`approvedAt` with status APPROVED — simultaneously rejected and
  approved — still downloadable with full signature lines.
- **stage-approvals** — the update was already in a transaction but keyed on `id`
  alone, so the tx merely serialised the two decisions. A reject that *lost* the
  race still wrote its deviation event and dragged `currentLifecycleState` back to
  DRY_IN on a filter the winning approve had just released.
- **admin-requests** — two admins approving one FORGOT_PASSWORD request both ran
  `executeApproval` and issued **two** temp passwords; the first is overwritten
  before the admin reads it out, so it fails at login. Fixed by claiming
  atomically *then* executing, with a revert-to-PENDING on failure to preserve the
  original retry contract.
- **checklist-profiles delete** — the in-use guards and the delete were four
  separate statements outside any transaction, so a cycle starting mid-check
  pinned a version the cascade then destroyed.
- **equipment-groups create** — count moved inside the tx. **Honest limitation,
  stated in the code:** this narrows the race, it does not close it (READ
  COMMITTED lets two txs both count 0). The proper fix is a partial unique index,
  which cannot be created while block MUPS has two active groups.

### Audit gaps (`b122436`, `3d8e0ea`)

Nine surfaces that mutated or destroyed records and wrote **no** `audit_trail`
row — `grep auditLog modules/notifications/` returned nothing at all. Notification
delete/bulkDelete (physical deletes, zero trace), rule toggle, delivery-log delete,
4 user-group mutations, LDAP auto-provision (an unknown directory user could become
an ADMIN nobody provisioned), and the identifier cascade — which is why the RFID
Track Record showed a dangling ASSIGN with no REMOVE after an AHU delete, and a
re-assigned tag produced two consecutive ASSIGNs.

Every *physical* delete now audits **inside** the tx that destroys the row (the
audit row is the only surviving evidence). Registered 12 actions + 8 templates —
5 were already being emitted but never registered, so they rendered as raw jargon
in the inspector UI.

### Mass assignment (`4240d7e`)

Three PUTs doing `data: body` against schemas without `additionalProperties:
false`, so every client key reached Prisma: `createdBy`/`createdAt` (provenance
falsification) and, on the widget route, `dashboardId` — re-parenting a widget
past the ownership check the handler runs on the parent. **Two audit findings
stated the mechanism wrong** (claiming AJV lacks `removeAdditional`); it has it by
default, but it only acts when the schema declares `additionalProperties: false`.
Settled empirically and encoded in a test that asserts both directions.

**Suites:** `apps/api` **1083 / 0 / 12** (102 files), `apps/web` 464/0, shared 332.
Typechecks clean; `@digilog/shared` rebuilt; dist rebuilt. ~40 tests added, several
**mutation-verified** (reverting the fix turns them red) after a first-draft
password test was found to pass against the broken implementation. No count changes
to models/enums/permissions/reauth actions/modules/config defs.

**⚠ Two live data issues for the operator:** block **MUPS** has two active equipment
groups ("Testing" / "Testing 2"), which breaks readings for operators in that block
*and* blocks the unique index; and filter `CWH/F1/AHU-0B/SA/05/06-01` is still Set A
from the earlier dialog bug. Both need a UI fix so the correction is audited.

## [Unreleased] — Enterprise-audit High findings, round 2: the last 5 (2026-07-15)

Verified the 5 remaining Highs from `wf_6ea8254c-3b2` refute-by-default against HEAD.
**None had been touched by the earlier batch** — every buggy construct was still
present verbatim. All 5 are now resolved (`320281d`, `221b8fc`, `c6603ed`). This
takes the audit's 38 Highs to fully triaged. Detail:
`tasks/ENTERPRISE-AUDIT-HIGHS-TRIAGE-2026-07-15.md`.

- **Filter Lifecycle silently omitted block-direct AHUs** (`320281d`). An AHU sits
  either directly under a block (`blockId` set, `areaId` null) or under an area, but
  the scope cascade tested only the area path — so selecting a Block dropped every
  block-direct AHU from the dropdown and, via `allowedAhuIds`, all of their filters
  from the report. **Reported as "latent"; it is not** — this database has 7 such AHUs
  carrying 35 filters, so the report has been under-reporting by that much with no
  warning, which is the worst failure mode for a §11 record. `blockId` was already on
  the payload; it just wasn't used. Grepped for the same cascade elsewhere: one-off.
- **PM "To Review" / "To Approve" tabs returned 400** (`320281d`). The `/entries`
  querystring enum was missing `PENDING_REVIEW`/`PENDING_APPROVAL`, so AJV rejected
  before the handler ran and the table rendered empty with no error — while the header
  badge, counted from the ALL tab, showed a non-zero count. A reviewer saw "nothing to
  review" with real entries waiting. `'ALL'` already means no-filter, so no service
  change.
- **sanitize-html 2.17.2 → 2.17.6** (`320281d`, GHSA-9mrh-v2v3-xpfm). **Hygiene, not a
  live vulnerability** — the advisory is an `allowedTags` bypass that only applies to
  configs allowing `option`/`textarea`, and `lib/sanitize.ts` passes `allowedTags: []`;
  the advisory's own PoC and 10 variants all escape cleanly against our config. The `^`
  already permitted the patch.
- **The input sanitizer had ZERO tests** (`320281d`) — noticed while bumping it.
  Bumping the library under a security control with nothing to catch a behaviour change
  is a blind swap. 17 tests added. They pin two things worth knowing: **`stripHtml` does
  not strip, it ESCAPES** (`<b>x</b>` → `&lt;b&gt;x&lt;/b&gt;` — the name misleads, and
  the first draft of these tests asserted the name and was simply wrong), and it
  entity-encodes bare `&`/`<` in legitimate operator text (`Wear & tear` →
  `Wear &amp; tear`) — the lossiness behind the 2026-07-04 `sanitizeStrings` revert.
  Pinned, not fixed.

### Scheduled DB backups now actually exist (`221b8fc`)

Zero `schtasks`/`Register-ScheduledTask` existed anywhere in `scripts/`; the only
automated `pg_dump` was `upgrade.ps1`'s one-shot pre-upgrade dump, and the only routine
backup path was an operator manually clicking Export. Yet `PHARMA_DEPLOYMENT_21CFR.md`
told operators the installer "Configures scheduled DB backups" and §5.3's inspection
checklist listed them as installer-satisfied — a **§11.10(c) record-protection control
certified at IQ but non-existent**. The "no cron infrastructure" excuse never applied:
the doc itself names Windows Task Scheduler, present on every target.

- New `scripts/backup-db.ps1` (nightly `pg_dump` → `ProgramData\backups`, 14-day
  rotation) + `scripts/register-backup-task.ps1`, registered from **both** `install.ps1`
  and `upgrade.ps1` — the `.iss` upgrade path runs `upgrade.ps1` directly and never calls
  install, so install-only registration would have left every upgrading customer with no
  backup job while §4 told their QA otherwise.
- Runs as SYSTEM (no stored password; `schtasks /query /xml` exposes nothing); the DB
  password is never on a command line.
- Rotation prunes **only** this job's `nightly-*.sql` — the directory is shared with
  `pre-upgrade-v*.sql` dumps, and a blanket age sweep would have eaten exactly the dumps
  worth keeping longest. Pruning happens only **after** a verified-good dump, and a
  partial/zero-byte dump is deleted rather than left looking like a backup.
- Failure is visible three ways: `LAST-BACKUP-STATUS.txt` (always rewritten via a
  `Finish` function every exit path routes through), `logs\backup.log`, and a non-zero
  Task Scheduler result. The status file's **timestamp is itself the alarm** — a deleted
  or disabled task reads as stale, which a log alone cannot show.
- `build-installer.ps1` stages both new scripts: it stages by **named list, not glob**,
  so they'd have been correct on disk and silently absent from the artifact — and
  `install.ps1` throws on a missing sibling, aborting the install *after* DB provisioning.
- Doc: `:123` was false twice ("the app's dynamic backup" — it's pg_dump; "copied
  off-box" — same disk) and is rewritten to name the task, path, rotation and status
  file, and to state plainly that off-box copying and test-restores are site procedures
  the installer does **not** perform. `:154` mixed one implemented control with two
  unimplemented ones in a single checkbox — split into a verifiable "status file reads OK
  with last night's timestamp" and a "site SOP, not installer-provided". `:172` is now
  true as written and left alone.
- **Not verified**: the task actually firing nightly under SYSTEM against the bundled PG
  on :5433 — that needs a real install. Verified by inspection, real cmdlet/parameter
  signature checks (which caught `New-ScheduledTaskSettings`, a cmdlet that does not
  exist), `CommandLineToArgvW` on the argument string, and a real end-to-end dump against
  the dev DB (28.9 MB / 88k lines, exit 0, `audit_trail` data confirmed inside).

### The AHU bulk-upload dialog is gone (`c6603ed`)

It was a 100% dead flow: it offered a CSV template and parsed CSV client-side, while the
endpoint has only ever parsed `.xlsx` (`wb.xlsx.load`). No file could satisfy both. It
also posted to the create endpoint rather than the `/validate` dry-run, and never sent
the reauth header. **Removed rather than repaired** because it was stale as well as dead:
it hardcoded `['Pre','HEPA','Fine','ULPA','Carbon','Bag']` against live master data of
`PRE/CYCLIC/FINE/HEPA` — `ULPA`/`Carbon`/`Bag` don't exist, `CYCLIC` is missing, and
`Pre`/`Fine` are case-mismatched. Bulk upload survives on the Filters page; the backend
(`/bulk-upload-filters`, `/validate`, `FILTER_BULK_UPLOAD`) is untouched.

Also fixes a pre-existing trap in the **surviving** Filters-page dialog:
`handleBulkUploadSubmit` set the `'uploading'` spinner before `reauth.execute`, stranding
the dialog on a spinner when the operator cancelled the password prompt. Note the obvious
one-line fix is **insufficient** — the callback re-throws `REAUTH_FAILED` for a re-prompt
with the step already `'uploading'`, so the hook re-prompts over a spinner and cancelling
there strands you identically. The step now enters inside the callback and is restored to
`'preview'` on any throw. Latent today only because `BULK_UPLOAD_FILTERS` reauth ships
off — it arms the moment anyone enables it.

**Suites:** `apps/api` **1047 / 0 / 12** (98 files), `apps/web` **464 / 0** (35 files).
Typecheck clean; `vite build` OK; `exceljs` still its own 940 kB lazy chunk. No count
changes to models/enums/permissions/reauth actions/modules/config defs.

## [Unreleased] — Enterprise-audit High findings: 24 verified, 24 fixed + a critical restore regression (2026-07-15)

Worked the still-open **High** findings from the 2026-07-13 enterprise audit
(`wf_6ea8254c-3b2`, 38 Highs, all UNVERIFIED). 24 were adversarially verified against
HEAD by 4 refute-by-default agents before any fix; all 24 are now fixed across
`f01bea0`, `31de7fc`, `34b04cf`, `b493c38`, `cead64c`. Per-finding evidence and the
full triage: `tasks/ENTERPRISE-AUDIT-HIGHS-TRIAGE-2026-07-15.md`.

Verification changed the outcome in four cases and is worth recording:
- **L81** (admin-requests as an "ungoverned second door" into user mutations) was
  **REFUTED at HEAD** — the module calls the *guarded* `userService` methods, so the
  2026-07-13 `assertCanManageTarget` fix had already closed it transitively.
- **L41**'s claimed "silent save no-op" was **REFUTED** — react-hook-form submits from
  its internal `_formValues`, not the DOM, so the role was never lost. The blank
  dropdown was real; the data loss was not.
- **L131**'s "SUPER_ADMIN takeover" was **REFUTED** — three existing guards cap LDAP
  role-mapping escalation at ADMIN. The unvalidated mappings and substring matching
  were real, at reduced severity.
- **L86**'s "over 6 records" threshold was confirmed as **exactly 7** (37n−1 > 255).

### CRITICAL — backup restore had been 100% broken since 2026-07-04

Found only by *running* a restore; no typecheck or test could have caught it.
`ae1bc3b` — itself the "round-2 CRITICAL backup restore lockout" fix — added a
pre-truncate snapshot selecting `users.password_history_hashes`. **That column has
never existed** (password history is its own table). It raised `42703` on every
restore, and because a caught JS error does **not** un-abort a Postgres transaction,
every subsequent statement died with `25P02` and the whole restore rolled back. The
`try/catch` is what hid it. It also explains why the mirror-trigger bug below went
unnoticed for months — nothing ever got that far.

- `backup.repository.ts` now queries real columns only, with no `try/catch` around
  in-transaction probes (the hazard is commented in place).
- **Mirror triggers (L96):** restore disabled only `audit_trail`'s triggers, leaving
  the asset/filter mirror armed. `topologicalSort` emits `asset_instances` before
  `ahus`/`filters`, so the mirror pre-populated them and the plain INSERT then hit a
  duplicate key — **restore failed on any backup containing a single AHU or filter**,
  i.e. every real one. Now disables every user trigger on the tables it rewrites.
  (`SET session_replication_role = 'replica'` would be tidier but needs superuser;
  the app's DB role has neither that nor replication — verified, don't retry it.)
- **Sequences (L101):** `resetAuditSequence()` was a no-op with a false comment
  ("UUID PK, no sequence" — `chain_position` is a BIGSERIAL) and **zero callers**, so
  nothing had ever realigned sequences after a restore. New
  `resyncSequencesAfterRestore()` derives `audit_trail_chain_position_seq`,
  `deviation_number_seq` and `qnn_seq` from the restored data. Left as-was, a restore
  onto a fresh install collided deviation numbers and **permanently broke hash-chain
  verification**.
- **password_history leak (L91):** `stripSensitiveColumns`'s `table !== 'users'` guard
  let every historic bcrypt hash out in the clear — the `password_history` TABLE is not
  the `users.password_history_hashes` COLUMN it strips. Now stripped, with a matching
  restore-side snapshot so sentinels can't overwrite real history. §11.10(d).

**Proven by a real round-trip**, not by inspection: export `digilog_db` → restore into
a throwaway `digilog_restore_test` (never dev/test — restore TRUNCATEs). Counts exact
(510 asset_instances / 38 ahus / 376 filters / 16955 audit_trail); chain state
**byte-identical to source** (same 100 pre-existing anomalies at the same positions, so
the restore is faithful rather than lossy); `DEV-000142`→`DEV-000143` and
`QN-2026-000107`→`QN-2026-000108` with no collision; `chain_position` continues after
restored history. A second restore onto a **populated** DB preserved real password
hashes — meaning the 07-04 lockout fix works for the first time.

### Security / authorization (`f01bea0`)

- **`users.list` `?role=` bypassed the higher-privilege hiding** — the filter *replaced*
  the exclusion instead of intersecting, so an ADMIN could request `?role=SUPER_ADMIN`
  and receive exactly the accounts the filter exists to hide. (The 2026-07-13 SA-hiding
  work covered the *roles* endpoints, not this one.) Also fixes a latent bug found while
  reading: with no exclusions (a SUPER_ADMIN caller) `where.role` was never set at all,
  so `?role=` was silently ignored.
- **`block-change-requests.create` mass assignment** — the row was built by spreading
  `req.body`, and the POST schema never set `additionalProperties: false`. A holder of
  only `BLOCK_CHANGE_REQUEST` could post `status: 'APPROVED'` to self-forge the approval
  `hasApproval()` checks, **bypassing the cross-block gate with no approver**, or
  `manualEntry: true` to disguise the row. Now built from explicit named fields; schema
  tightened as defense-in-depth.
- **ADMINs never saw their own or general notifications** — `NOT: { forRole: 'SUPER_ADMIN' }`
  was ANDed over the whole OR, and `NOT (NULL = 'SUPER_ADMIN')` is NULL, not TRUE, so
  every `forRole IS NULL` row was dropped. That killed two of the three visibility
  branches. Fixed at both mirrored sites (`notification.service.ts` +
  `notification.repository.ts`, whose docstring promised a byte-for-byte mirror — and
  delivered one, bug included).
- **Audit bulk redact/delete 500'd on 7+ records** — `targetId` is `varchar(255)` and the
  handlers joined matched UUIDs into it (37n−1 chars). Postgres raised `22001` inside the
  transaction and the whole operation rolled back. The id list already lives in the
  unbounded JSONB `beforeValue.records`.
- **Offline interlock gate was unenforced** — `interlock` and `stageLookup[].interlockGated`
  were undeclared in the `current-state` 200 response schema, so fast-json-stringify
  dropped them. Online this only hid the QA banner (`actions[]` still gates), but the
  **tablet reads `interlockGated` from the cached response**: `!!undefined === false` let
  an operator advance out of an interlock stage with no QA approval.
- **LDAP `tlsRejectUnauthorized` defaulted to `false`** — an `ldaps://` bind accepted any
  certificate, so an on-path attacker could harvest the service-account `bindPassword`
  and every user password in cleartext. Secure by default now; explicit opt-out honoured.
- **LDAP group matching used `.includes()`** — a mapping for `admin` also matched
  `CN=BackupAdmins`. Now matches the full DN or an exact RDN value (which is how
  operators actually configure it, so CN-name configs keep working). Role mappings can no
  longer confer SUPER_ADMIN.

### Frontend (`31de7fc`)

- **Editing any Set B filter silently rewrote it to Set A** — `openEditFilter` seeded the
  toggle by comparing against `'B'`, but the API sends the raw Prisma enum (`SET_B`), so
  it never matched and always pre-selected Set A; `submitEditFilter` then sent `filterSet`
  unconditionally. Live since 2026-04-20. The audit row recorded it as a deliberate
  change, and set membership drives AHU set config and PM/replacement scoping, so
  schedules followed the corrupted value. Enum mapping fixed and the toggle is now
  tri-state, omitting `filterSet` when unset so a set-less filter isn't assigned Set A.
  **⚠️ Existing data:** 1 filter is provably corrupted — `CWH/F1/AHU-0B/SA/05/06-01`
  (SET_B→SET_A, 2026-07-14). 91 earlier edits are forensically invisible: before/after
  audit capture only landed 2026-07-08.
- **Editing a LOCKED or EXPIRED user silently did nothing** — `status` was seeded into a
  form whose schema accepts only `ENABLED|DISABLED`, so the resolver rejected and, with no
  rendered error for that field, Save was a no-op. For exactly the users most likely to
  need editing. The form has no status input (that goes through enable/disable/unlock), so
  the field is simply no longer seeded.
- **Unlock failures were indistinguishable from success** — `handleUnlockConfirm` was the
  only `reauth.execute` site in the file passing no `onError`, and `use-reauth` swallows
  non-reauth errors when it's absent. An admin would hand out a temp password for an
  account that was still locked.
- **Role dropdown rendered blank** for USER_UPDATE-only editors (`/creatable` is
  USER_CREATE-gated → 403 → zero options). Now always offers the user's current role.
- **Config → Role Assignments lost input focus on every keystroke** — five components were
  declared inside the page component, so each render created new component types and React
  remounted the whole card subtree, destroying the DOM inputs. Multi-digit values were
  unenterable in "Auto-expire (hours)" and "Default tolerance (days)". Hoisted to module
  scope; verified live in a browser, since focus retention is invisible to tsc and vitest.
- **Three reauth actions were unsettable** — both policy editors build their lists by
  iterating `REAUTH_ACTION_CATEGORIES`, which was missing `'Notifications'` and
  `'Super Admin'`, so `DELETE_NOTIFICATION`, `BULK_DELETE_NOTIFICATIONS` and
  `SUPER_ADMIN_DATA_EDIT` rendered nowhere (13→15 categories).

### Compliance (`34b04cf`, `b493c38`, `cead64c`)

- **Cross-block approvals were never consumed and never expired** — one approval was a
  permanent, unlimited licence to clean a filter in another block. `consumeApprovalTx` had
  existed since 2026-05-05 with **zero callers**; a comment documented a fix that was
  written and never wired. Now spent inside `start-cycle`'s transaction under the existing
  `FOR UPDATE` lock, which also closes the TOCTOU that comment described. A 0-row consume
  means another start won the race → 409. Offline replay never consumes (it was never
  gated on one; spending it would burn an unused approval). **`autoExpireHours` is now
  honoured** — it was editable in config and read by nothing. Dead non-transactional
  `consumeApproval` + `hasApprovalTx` removed.
- **super-admin stops deleting `audit_trail` rows.** `DELETE /filter-data/retirements/:id`
  and `/replacements/:id` could never succeed (bare delete vs the immutability trigger, no
  Prisma error mapping → raw 500) and are **removed with their UI**. **Unretire is kept but
  fixed**: all reads resolve before the transaction, every write goes through `tx`, audit-row
  deletions gone. Previously ~10 destructive writes committed and *then* it 500'd — half
  applied, unrollbackable. **Behaviour change:** a replaced-then-unretired filter now stays
  listed in Replacements pointing at a deleted target — that row is the §11 record. The
  dialog's false "the retirement audit record will be removed" was corrected.
- **Secrets no longer reach the immutable audit trail** — the handlers rehydrate real stored
  secrets into `body` whenever the client echoes a mask sentinel, so an admin editing an
  unrelated field **could not avoid** writing live `clientSecret`/`refreshToken`/`accessToken`.
  New `lib/mask-secrets.ts` is an **allowlist**: an unrecognised key is redacted until a human
  declares it safe, because the write is permanent and unscrubbable. Applied to both
  notification-delivery sites and to `ldap/routes.ts` (same denylist pattern). Notably excludes
  `httpGatewayUrl`/`httpGatewayBodyTemplate` — MSG91/Plivo/Kaleyra embed API keys there.
  Verified read-only: **zero existing rows carry any secret**, so no historic redaction was
  needed.
- **checklist-profiles: only `create` was audited** — update, delete and every question
  mutation wrote nothing to `audit_trail`. The version sidecar is not hash-chained, not
  immutable, absent from the inspector UI, and `delete()` cascades it away, so a deleted
  profile left no trace anywhere. §11.10(e). 7 `auditLog` calls now, all after the tx commits;
  4 new actions registered in `audit-actions.ts` + `audit-templates.ts`.
- **PM `PUT /:id` archived the ACTIVE schedule before validating** — an empty body left it
  ARCHIVED with no replacement and PM generation stopped silently (the `entries !== undefined`
  guard was inert). Validate first, wrap archive+create in a transaction, tighten the body
  schema (no caller needed a partial body — the PUT has zero web/mobile callers).
- **PM bulk upload destroyed APPROVED entries and all `PmExecution` history** at upload time,
  before review, non-transactionally — replacements landed in `PENDING_REVIEW` and might never
  be approved. Executions are retained evidence: that `deleteMany` is gone. APPROVED entries
  are guarded when workflow is on, and each (AHU, year) gets its own transaction so a mid-file
  failure can't strand months.
- **`e2e/super-admin-unretire.test.ts`** proves the unretire fix rather than assuming it: a
  child row under the replacement makes the *last* transaction statement violate
  `asset_instances_parent_id_fkey` (RESTRICT) after every destructive write, and the test
  asserts the early-deleted identifiers/events/cycles/relationships survive. Pinned to
  `toBe(500)` — a looser `>= 400` would let a preHandler short-circuit satisfy those
  assertions trivially (rows survive because nothing ran) and pass for the wrong reason.

### Deliberately NOT fixed (collide with authorized design)

Three confirmed findings were left alone by explicit decision — the code does what the
finding says, but it's what was asked for:
- **super-admin rewriting checksummed `audit_trail` fields** — the manual-record-edit
  feature authorized on 2026-07-10 (§11 warning overridden twice).
- **Reauth on Filter Data mutations shipping OFF** — the intended configurable default.
  (The *real* bug inside it — `SUPER_ADMIN_DATA_EDIT` being unsettable — is fixed above.)
- **The sync global-max version cursor** — offline-sync is a protected surface; it gets its
  own task, not a sweep.

**Suites:** `apps/api` **1030 passing / 0 failed / 12 skipped** (97 files, single-fork, quiet
tree); `apps/web` **464 / 0**. Typecheck clean both sides; `@digilog/shared` rebuilt;
`vite build` rerun. ~80 tests added. No count changes to models/enums/permissions/reauth
actions/modules/config defs.

## [Unreleased] — Security: finish audit security phase + fix a 3rd Critical (2026-07-13)

Resumed the enterprise audit's **Security phase** (the 12 VAPT sweeps + adversarial
verify that died in the partial run) as a fresh focused workflow `wf_45c246d1-1ee`
on Claude Fable 5 — 12/12 sweeps + verify completed (27 agents, 0 errors). **53
findings: 1 Critical, 6 High, 16 Medium, 19 Low, 11 Info** in
`scratchpad/audit/security-findings.json` + `SECURITY-PHASE-REPORT.md`.

- **C3 — ADMIN→SUPER_ADMIN takeover via password-reset-request approval** (CVSS 9.1,
  CONFIRMED by both adversarial skeptics) — `apps/api/src/modules/users/user.service.ts`
  `processResetRequest()` was the ONE user-mutating method the C2 fix missed: no
  `assertCanManageTarget()` guard. Chain: public `POST /api/auth/forgot-password`
  creates a PENDING reset for `superadmin` → an ADMIN with USER_RESET_PASSWORD approves
  it with an attacker-chosen password (reauth only checks the ADMIN's own password) →
  SA takeover. Fixed by adding the same hierarchy guard after the target lookup,
  covering both the approve and reject branches. 3 regression tests added
  (`user.service.test.ts`, 31/31 pass); typecheck clean.

Additional confirmed findings from the sweep, now FIXED + tested (all with regression tests):
- **Role create/update privilege boundary** (`role.service.ts`): new `assertRoleWithinCallerPrivilege()`
  — a non-SUPER_ADMIN caller can no longer grant permissions its own role lacks, create/raise a role
  at or above its hierarchy level, or edit its own / a higher role. SUPER_ADMIN exempt; only newly-added
  permissions are subset-checked (grandfathers a target's existing perms). 5 regression tests.
- **Session termination on admin reset/unlock** (`user.service.ts`): `resetPassword()`/`unlock()` now
  call `terminateSessions()` + `invalidateUserAuthCache()` (mirrors `disable()`), so a stolen session
  can't survive a compromise-response reset. 2 regression tests.
- **Account-lockout on the two brute-force oracles**: `changePassword()` (`auth.service.ts`) and the
  `offline-grant` route (`auth/routes.ts`) now call `applyFailedPasswordAttempt()` on a bad password,
  so a session holder can't grind the password without ever locking. 1 regression test + reset-on-success.

Affected suites green: user 33, roles 26, auth 28 (127 total across the 7 files). Typecheck clean.

**Dependency CVE remediation (all verified):**
- `fastify` 5.7.4 → **5.10.0** (GHSA-247c-9743-5963 body-schema-validation bypass). Typecheck + 26 auth
  e2e green under 5.10.
- `nodemailer` 8.0.2 → **9.0.3** (SMTP/CRLF header injection advisories). API stable across 8→9
  (`createTransport`/`sendMail` unchanged); typecheck + tests green.
- `xlsx` 0.18.5 **removed**, replaced with **`exceljs`** in `apps/web` (`lib/excel-export.ts`) — the
  SheetJS prototype-pollution + ReDoS advisory is unpatchable on the npm registry. `exportToExcel()` is
  now async and loads exceljs via a **dynamic import**, so it's a separate 940 kB lazy chunk (only fetched
  when a user clicks Export — zero initial-bundle cost). All 10 callers unchanged (fire-and-forget). Vite
  build + web typecheck + 464 web tests green.
- `@fastify/static` (our direct dep, serves the SPA + uploads + `reply.sendFile` downloads) 9.0.0 →
  **10.1.0** (GHSA-pr96 path traversal + GHSA-x428 route-guard bypass via encoded separators). App boots
  + auth e2e green.
- **Accepted residual:** `@fastify/swagger-ui@5.2.5` still pulls `@fastify/static@9.0.0` transitively for
  the `/docs` Swagger UI's own bundled assets (fixed paths, internal surface). No swagger-ui release yet
  depends on static@10, and an npm `overrides` pin conflicts with the direct ^10 dep, so it wouldn't apply
  cleanly. Low risk; left as-is rather than force a swagger-ui major bump on a docs-only surface.

**Audit hash-chain: keyed HMAC (V3) — the last High from the sweep, now implemented + verified.**
The chain was unkeyed SHA-256, so a DB-level actor could recompute a fully self-consistent forged chain
that passes verify-chain. Added a keyed **HMAC-SHA256 (V3)** path, gated on a new `AUDIT_CHAIN_KEY` env
secret held outside the DB:
- `lib/hash-chain.ts` — `computeChecksumV3` / `computeChainedChecksumV3` (HMAC over the V2 recursive
  canonical form) + `getAuditChainKey()`. `verifyAuditChecksum` now REQUIRES the key + an HMAC match for
  `checksum_version = 3` rows and never accepts the unkeyed formula for them (a downgrade-to-unkeyed forge
  breaks the forward chain link, which re-linking needs the key). Legacy rows (version NULL) keep verifying
  via the V1/V2 fallback, so all historical audit history stays valid.
- `lib/audit.ts` — write path uses V3 + stamps `checksum_version = 3` when `AUDIT_CHAIN_KEY` is set;
  otherwise stays on unkeyed V2 (version NULL) so an un-keyed install still works.
- Migration `20260713180000_add_audit_checksum_version` — additive nullable `audit_trail.checksum_version
  SMALLINT` (no backfill, no data loss). Applied to dev + test DBs; drift guard PASS.
- `AUDIT_CHAIN_KEY` documented in `.env` + `.env.example` (must be stable + backed up outside the DB;
  losing it makes v3 rows permanently unverifiable). Left UNSET on dev → dev stays on the working legacy chain.
- Verified: 33 hash-chain unit tests (keyed verify, no-key/wrong-key/tamper/downgrade all rejected, legacy
  still valid); audit-chain e2e passes both WITHOUT and WITH the key (mixed v2+v3 chain verifies); DB shows
  v3 rows stamped `checksum_version = 3`. 204 tests green across users/roles/auth/audit/backup/hash-chain.

All enterprise-audit security findings triaged this session are now addressed. None yet folded into
`ENTERPRISE-AUDIT-REPORT.md` (the full re-audit workflow `wf_42314da7-827` is producing a fresh report).

## [Unreleased] — Security: fix 2 Critical auth/authz findings (2026-07-13)

From the enterprise audit (`wf_6ea8254c-3b2`). Both fixed + verified same day.
- **C1 — LDAP sentinel auth bypass** (`apps/api/src/modules/auth/auth.service.ts`):
  a `passwordHash === 'LDAP_EXTERNAL_AUTH'` user used to set `skipPasswordCheck = true`
  unconditionally, so ANY password logged them in when LDAP was disabled or for a
  SUPER_ADMIN-role LDAP user. Now a sentinel-hash user is denied unless an LDAP bind
  actually succeeded this request. Normal local login unaffected (200; wrong pw 401).
- **C2 — ADMIN→SUPER_ADMIN account takeover** (`apps/api/src/modules/users/user.service.ts`):
  `resetPassword`/`unlock` (and `update`/`disable`/`enable`) had no target-role guard,
  so an ADMIN could set a SUPER_ADMIN's password. Added shared `assertCanManageTarget()`
  (SUPER_ADMIN short-circuits; otherwise reject when the target's hierarchy level exceeds
  the caller's) on all five privileged mutations. Also closes 2 related High findings.
  4 regression tests added (`user.service.test.ts`); 28/28 user + 75/75 auth+user pass.

The audit was a PARTIAL run (session limit killed the 12 VAPT sweeps, 4 cross-cutting
lenses, 12 frontend areas, and synthesis) — 38 High + 158 Medium findings remain open;
report + findings JSON under `scratchpad/audit/`. Resume: `resumeFromRunId: wf_6ea8254c-3b2`.

## [Unreleased] — Hide SUPER_ADMIN role from non-SA users app-wide (2026-07-13)

Branch: `RFID`. The SUPER_ADMIN **role** is now filtered out of every role
list / dropdown / access-matrix for any non–SUPER_ADMIN caller (extends the
pre-existing Users-page hiding to the whole app). Done at the source in
`apps/api/src/modules/roles/`: `role.service.ts` gains a caller-aware
`hideSuperAdminFor()` used by `listAll` / `listActive` / `getAccessMatrix`;
`routes.ts` passes the caller role — authenticated on `/api/roles` +
`/api/roles/access-matrix`, and via an optional Bearer-token decode
(`optionalCallerRole`) on the PUBLIC `/api/roles/active`. SUPER_ADMIN callers
still see the role everywhere. Covers Module Guide, Role Assignments, Sidebar
config, Roles table, and all `/active`-fed pickers at once. Verified via curl
(anonymous/SUPERVISOR excluded, SA included) + browser (Supervisor Module Guide
legend no longer lists Super Admin); 5 regression tests in `role.service.test.ts`.

Also this session (branch `RFID`): `/home` Module Guide flowcharts redesigned
(roomier cards, branches in normal flow, scroll cues, full-width); Filter
Operations flow notes that real stages vary by cleaning profile; `home` made a
normal Roles-&-Access-managed sidebar item (`SIDEBAR_ITEMS` 26→27, force-show
removed, role_configs backfilled).

## [Unreleased] — Manual record Create in Filter Data Management (2026-07-10)

Branch: `RFID`. The SUPER_ADMIN-only **Filter Data Management** console
(`apps/web/src/routes/config/filter-data-management.tsx`) already let an admin **edit** rows silently
(no audit trail) on six data surfaces. This adds the mirror-image **Create** capability — insert brand
new rows with any date/time (past **or** future). Requested by the operator, who was warned about the
21 CFR §11 backdating/fabrication implications and chose to proceed; consistent with the existing silent
edit, the create endpoints are also **not written to the audit trail**.

- **6 new endpoints `POST /api/super-admin/data/<entity>`** (`super-admin/routes.ts`), one per
  edit-capable surface: `cleaning-cycles`, `filter-events`, `pm-entries`, `notifications`,
  `admin-requests`, `block-change-requests`. Each mirrors the sibling `PUT`'s field whitelist but calls
  `prisma.<model>.create`; same `SUPER_ADMIN` + `SUPER_ADMIN_DATA_EDIT` reauth guard.
- **Required NOT-NULL columns the edit form hides are auto-filled**: cycle → `cycleCode` (`MANUAL-…`) /
  `sequenceNumber` (count+1) / `profileVersion` (from the chosen profile) / `cleaningReasonKey` (slug of
  label) / `startedAt` (now); event → `performedBy` (caller) / `ipAddress` / `checksum`
  (`computeChecksum`); pm-entry adds `scheduleId`; block-change requires full filter + from/to block
  identity, requester defaults to the caller. Unique-index violations (one-in-progress-per-filter,
  `cycle_code`, `[scheduleId, month]`) return a friendly **409**.
- **Audit Trail tab intentionally has NO Create** — it exposes no editable columns to mirror, and
  appending fabricated rows would break the tamper-evident SHA-256 hash chain. Every other listed tab is
  covered.
- **Frontend**: `Field` gains name-based dropdown support (`optionObjs`); a "+ Create" button appears per
  supported tab; a create modal mirrors each tab's edit columns plus the required FK pickers (filter /
  cleaning-profile / PM-schedule) and enum selects (event type, notification type). New records
  revalidate the same SWR keys as edit, so they appear on both the data-mgmt tab and the matching
  user-facing page.
- **Note**: a manually-created **IN_PROGRESS** cleaning cycle does not set
  `FilterDetails.currentCycleId`, so it won't drive the tablet/operations active-cycle view — use
  **COMPLETED** for historical records (the modal defaults + hint steer this way).

- **"Manual entry" badge (2026-07-10 follow-up)**: a new `manual_entry BOOLEAN NOT NULL DEFAULT false`
  column on all 6 tables (migration `20260710120000_add_manual_entry_flag`; drift guard PASS; existing
  rows correctly `false`) is set `true` by every create handler. A shared `<ManualEntryBadge>`
  (`apps/web/src/components/manual-entry-badge.tsx`) renders an amber pill on those rows in the Filter
  Data Management console (all 6 tabs) and on the user-facing Cleaning Cycles history page — so
  back-/future-dated records are visually distinguishable from natively-captured ones. (`manualEntry`
  flows through untouched: the list endpoints spread full rows and use `data: array` / `additionalProperties`
  response schemas, so Fastify doesn't strip it.)

Verified: `tsc` clean (api + web), `vite build` clean, routes live, migration drift guard PASS, and
Prisma-direct inserts confirmed a back-dated cycle + event survive the DB triggers, unique index, enum
and checksum (cross-filter consistency trigger correctly rejects a mismatched event), and that a created
row round-trips with `manualEntry = true`.

## [Unreleased] — Bulk filter-operate: one request for a 50–100 tag batch submit (2026-07-09)

Branch: `RFID`. The tablet batch submit (scan 50–100 RFID tags → Submit) was **N sequential HTTP
round-trips** — one `/advance` per mid-cycle filter, and up to **3** per fresh-cycle filter
(`/start-cycle` → `/current-state` → `/advance`) — so a "mix of both" batch of 50 filters was ~100+
serial round-trips over WiFi/HTTPS. That serial network time *was* the wait, scaling linearly.

- **New endpoint `POST /api/filters/bulk-operate`** (`filter-operations/routes.ts` +
  `cycle-write/bulk-operate.ts`): an orchestrator that **loops the existing
  `service.advance/startCycle/submitChecklist` per item**, each in its own transaction with its own
  ordered audit row — the tamper-evident hash chain stays sequential, and **partial success** is
  preserved (one bad tag doesn't reject the tray). `items[]` with `kind` advance / start-and-advance
  / submit-checklist (bypass excluded), cap 200. Reauth enforced **once** over the union of the
  actions the batch implies — reuses existing reauth actions, **no new constant**. Payloads bounded
  per-kind to match the single routes.
- **Client** (`routes/mobile/mobile-operations.tsx`): a shared `runBulkOnline` helper posts ONE batch
  and primes caches from the response. **Three** online call-sites now feed it — mid-cycle advances
  (`handleSubmitQueue`), batch cycle-starts (`handleEquipSubmit`), and batch checklist submits
  (`handleChecklistSubmit`). The **offline sync engine is untouched** and every bulk path is
  `online`-gated, so offline submit behavior is unchanged (the earlier perf commit consolidated the
  offline *repaint cadence* — one repaint vs N — but not sync behavior); a transport failure or a
  declined reauth keeps the scan queue for retry.
- **`useReauth.executeWithResult`** (`hooks/use-reauth.ts`): a returning reauth variant (the existing
  `execute()` returns void + defers) so a reauth-gated batch gets ONE password dialog and its results
  back. Backward-compatible.
- Also (same session, `db64376`): client-side per-filter overhead cut on the same handler (O(N²) IDB
  read → one Map; skip the same-block block-change GET; bounded post-submit priming).
- **Measured before/after: _<pending tablet verification>_.** Compliance preserved throughout —
  identical audit rows, e-signatures, RBAC, per-filter atomicity.

## [Unreleased] — Audit text templates reconciled with the app (2026-07-08)

Branch: `RFID`. Reconciled `packages/shared/src/types/audit-templates.ts` against every action the
app actually emits. **~40 real actions had no template and were rendering as bare title-case**
("Dryer Started", "Deviation Opened", "Pm Schedule Approved"); added proper templates for all of
them (PM deviations + approval workflow, dryer/lifecycle ops, replacement-schedule workflow, help
articles, notification rules, LDAP/email/SMS config, dashboards, user groups, password-reset
approve/reject, guest cleaning requests, report-review, audit self-admin delete/redact, etc.).

- **Entity CRUD read plainly now.** Cleaning/Filter/Checklist **profiles** and **PM schedules**
  log generic `CREATED`/`UPDATED`/`DELETED`/`ARCHIVED`/`ASSIGNED` (disambiguated by `targetType`).
  Added templates for those verbs using a new `{recordType}` placeholder (title-cased `targetType`,
  with `pm_schedule`→"PM Schedule") → *New **Cleaning Profile** "CP-1" created by EMP-004*. Fixes
  historical rows too (no backend change).
- **Removed 10 dead templates** (never emitted, no historical subsystem): `DATA_VIEWED`,
  `PARAMETER_CAPTURE`, `SESSION_TIMEOUT`, `UNAUTHORIZED_ACTION_ATTEMPT`, `APPROVAL_GRANTED/REJECTED/REQUESTED`,
  `ROLE_ASSIGNED`, `CYCLE_COMPLETED`, `PM_EXECUTION_COMPLETED`. **Kept** the historical ones
  (`ALARM_*`, `RULE_CHAIN_*`, `RETENTION_*`, `UNS_*`, `DEVICE_CREDENTIAL_*`, `DATA_EXPORTED`) and the
  `_SELF` variants (used by the self-action renderer).
- Template count 75 → 116; every emitted (non-test) action now has a template.

Tests: `apps/web/src/routes/audit/audit-helpers.test.ts` covers the generic `{recordType}` render
and sample new templates; `packages/shared/.../audit-templates.test.ts` updated. Full API 885/0, web 423/0.

## [Unreleased] — Readable audit trail for Block / Area / AHU / Filter (2026-07-08)

Branch: `RFID`. Hierarchy/filter audit rows were generic and jargon-y — *New entity "MF3"
created from template*, *Relationship created: "MF3" linked to "L8"* — you couldn't tell which
was a Block/Area/AHU/Filter or how they related. Now they name the specific kind and read plainly,
with **no "entity"/"asset"/"relationship" wording** (per request):
- *New **Filter** "MF3" created by EMP-004*
- ***Filter** "MF3" placed under **AHU** "L8" by EMP-004*

**One row per create.** Creating a record *under a parent* previously wrote **two** audit rows (the
create + a separate hierarchy-link). It's one action, so it's now **one** row that folds the parent
in: *New **AHU** "L8" created under **Block** "B1" by EMP-004* (`{parentClause}` placeholder;
`instance.service.create` no longer emits the second `ASSET_RELATIONSHIP_CREATED`). The physical
CONTAINS links are still written; moving an existing record to a new parent via edit still audits
the move as its own event.

### How
- **Backend `afterValue` enrichment** (new rows; old immutable rows unaffected):
  `instance.service` + `filter.service` now attach `templateKind` (Block/Area/AHU/Filter) to every
  create/update/status/delete audit, and `sourceKind`/`targetKind` + `relationshipType` to the
  hierarchy-link audits. `instance.repository.findByIdWithName` now also selects `template.templateKind`
  so the parent's kind is known.
- **Templates** (`packages/shared/src/types/audit-templates.ts`): reworded every `ASSET_*` entry to
  kind-aware, jargon-free wording — `New {entityKind} "{targetName}" created by {actor}`,
  `{targetKind} "{targetName}" placed under {sourceKind} "{sourceName}" by {actor}`, etc. Category
  `Entity Management` → `Hierarchy & Filters`; the `Entity Template` labels → `Template`.
- **Frontend** (`audit-helpers.ts`): resolves `{entityKind}`/`{sourceKind}`/`{targetKind}`
  (BLOCK→Block, AHU→AHU, …) with a graceful, jargon-free fallback for old rows; kind-aware badge
  labels (*Filter Created*, *Placed Under Parent*, …); `friendlyTargetType()` remaps the exported
  `targetType` column off `asset_instance`/`asset_relationship`.

### Notes
- Templates render at **view time**, so all historical rows re-render with the new wording (stored
  record + hash-chain checksum untouched — compliance intact). Old rows lacking a kind fall back to a
  neutral word ("record"/"item"), never "entity"/"asset".
- `audit-templates` config is not seeded, so the code defaults surface (verified: no saved override).

### Tests
`packages/shared/.../audit-templates.test.ts` (category + structure), new
`apps/web/src/routes/audit/audit-helpers.test.ts` (kind rendering, hierarchy link, fallback,
`friendlyTargetType`). Verified end-to-end against `digilog_test_db` through the real
`instance.service.create`. Full API suite 885/0, web 419/0.

## [Unreleased] — Bug fixes: optional email on user edit + audit-export logging (2026-07-08)

Branch: `RFID`. Two reported bugs fixed.

### 1. Email wrongly required when editing a user (e.g. changing role)
Editing an emailless user rejected the save as if email were mandatory. Root cause spanned
three layers — fixed all:
- **Zod** (`packages/shared/src/schemas/users.ts`): `updateUserSchema.email` was
  `z.string().email().optional()` (`.optional()` allows only `undefined`, not `''`/`null`).
  Now `z.union([z.literal(''), z.string().email().max(100)]).nullish()` — accepts `''`, `null`,
  a valid email, or omitted; still rejects a malformed address. (Mirrors `createUserSchema`.)
- **Fastify** (`apps/api/src/modules/users/routes.ts` PUT body): dropped `format: 'email'` and
  made the field `type: ['string','null']` (the create route already omits `format` for the same
  reason) — the format check was 400-ing `''` before the handler ran.
- **Service** (`user.service.ts` `update`): normalizes a blank email to `NULL` (mirrors `create`)
  so multiple no-email users don't collide on the `@unique` index; blank no longer triggers the
  duplicate-email probe.
- **Frontend** (`apps/web/src/routes/users/edit.tsx`): form seeds `email: userData.email ?? ''`.

### 2. Report/audit downloads not recorded in the audit trail
Report exports (PDF/Excel) were **100% client-side**, so no audit row was ever written — downloads
left no trace. The audit-trail export also only included the **currently visible page**.
- **New audit action `REPORT_GENERATED`** ("Report Generation") + audit-templates entry
  (`{targetType} report generated by {actor}`), used for **every** report download.
- **New endpoint** `POST /api/audit/report-export-log` (auth-only — the per-report export
  permission is already enforced upstream) writes a `REPORT_GENERATED` row: **`userId` = the
  username** (not the UUID `sub` — the reported "user id was not coming" bug), the report type
  (as `targetType`), format, record count, and active filters.
- **Shared helper** `apps/web/src/lib/report-export-log.ts`, wired into **all 12 report surfaces**:
  Audit Trail, Filters, PM Schedule, Cleaning Record, Cleaning Lifecycle, Cleaning Cycle Detail,
  Deviations, Quality Notifications, Retirement List, Replacement List, Replacement Schedule, RFID
  Track Record. Each records the export **before** producing the file.
- **Fail mode (offline-first aware):** the **Audit Trail** export is **fail-closed** (`logReportExport`)
  — it already pages the server for all records, so it needs connectivity anyway; a logging failure
  cancels it. The **11 operational reports** are **fail-open** (`logReportExportOrWarn`): they export
  from already-loaded data and must still work offline on the tablet, so if the log can't reach the
  server the file still downloads and a non-blocking warning toast is shown ("Not recorded in audit
  trail"). This preserves offline export while still recording every download when online.
- The **audit-trail export** additionally now fetches **all filtered records** (pages through the
  200-cap list API); "Send for Review" also snapshots the full filtered set (was page-only).
- (Backup export was already logged by the backup module; unchanged.)

### Tests
`schemas/users.test.ts` (+empty/null email), `user.service.test.ts` (+blank→null normalize),
`e2e/users.test.ts` (+empty-email PUT end-to-end through Fastify+zod+service),
`e2e/audit-export-log.test.ts` (REPORT_GENERATED row written with the username + auth/validation gates).

## [Unreleased] — Password expiry notifications (2026-07-08)

Branch: `RFID`. Added a per-user password-expiry warning system driven by **one new
admin setting** in *General & Password Settings → Expiry*: **`expiryNotificationDays`**
(`0` = off, default `0`). When set to `N` and a password-expiry period is configured,
each affected user gets **one in-app notification per day for the `N` days before their
password expires** (per-user, `forUserId = username`), plus a **one-time "password expired"
notice** on the expiry day sent to **both the user and the ADMIN role** (the user is blocked
at login once expired and can't otherwise see it; the admin can reset it). The existing login
block still enforces the actual expiry. **SUPER_ADMIN is excluded** (already exempt from expiry).

### Touchpoints
- **Config setting** — `expiryNotificationDays` added to `password-policy.def.ts` (Expiry
  group), the zod schema (`packages/shared/src/schemas/config.ts`), the custom page
  (`config/password-policy.tsx`), and the seed default (`prisma/seed.ts`). Defaults added to
  the two web policy-literal fallbacks (`lib/password-utils.ts`, `auth/change-password.tsx`).
- **Expiry math** — `daysUntilPasswordExpiry()` added to `lib/password-expiry.ts`, sharing
  the SAME anchor (`max(passwordChangedAt‖createdAt, policyUpdatedAt)`) as `isPasswordExpired`
  so warnings and the login block never disagree.
- **Notification types** — 2 new `NotificationType` enum values (`PASSWORD_EXPIRY_WARNING`,
  `PASSWORD_EXPIRED_NOTICE`) + migration `20260708050513_add_password_expiry_notification_types`
  (`ALTER TYPE … ADD VALUE`; drift guard PASS). Frontend notification page (`routes/notifications`)
  gets colour + icon entries for both (amber warning / red expired).
- **Daily sweep** — `sweepPasswordExpiryNotifications()` (`modules/auth/password-expiry-sweep.ts`):
  idempotent (warning deduped per-user-per-day; expiry notice per expiry event since the last
  password change). Cron `password_expiry_check` (`packages/queue/crontab.txt`, daily `0 0 * * *`)
  + worker `workers/password-expiry.worker.ts` registered in `app.ts` taskList (3 → 4 tasks).
  The single graphile-worker Runner starts with the API (no `USE_PG_QUEUE` gate), so this cron
  fires daily in any running instance.
- **Manual trigger** — `POST /api/users/password-expiry-sweep` (gated `CONFIG_UPDATE`) runs the
  same sweep on demand (e.g. testing without waiting for midnight).

### Known / intentional behaviour
Saving the password policy for any reason bumps its `updatedAt`, which is the grace floor for
every user's expiry anchor (the 2026-05-25 mass-lockout fix). So right after enabling this
feature, users whose passwords predate the save get a fresh window and won't be warned until it
nears — consistent with the login block, which also won't expire them until then. In steady
state (policy unchanged for a while) warnings fire exactly `N`…`1` days before real expiry.

### Tests
`lib/__tests__/password-expiry.test.ts` (+`daysUntilPasswordExpiry` cases),
`modules/auth/__tests__/password-expiry-sweep.test.ts` (mocked-prisma branch coverage),
`e2e/password-expiry-sweep.test.ts` (real digilog_test_db: warn/expire/skip + idempotency).

## [Unreleased] — Home / Module Guide page (2026-07-06)

Branch: `RFID`. Added a `/home` "Module Guide" page + a top-of-sidebar `home` nav item
(`apps/web/src/routes/home/`, `apps/web/src/components/layout/sidebar.tsx`). Frontend route
count **76 → 77** (`grep -cE "<Route" apps/web/src/main.tsx`); route folder count **22 → 23**.

### What it does
Renders per-module workflow flowcharts as **horizontal card-to-card flows** (`FlowChart.tsx`,
`module-flows.ts`) — no new dependencies. Matches the cleaning-profile pipeline view: step cards
run left→right joined by arrow connectors, branch operations (bypass/reject/terminate) drop below
their card via a down-arrow, per-kind left accent, horizontal scroll per flow. Each step's real
backend permission gate is carried in the catalog (`FlowStep.gate: Permission[]`, traceable to the
module routes / `PERMISSION_TREE`); role-level (`gateRoles`) and non-permission access
(`automatic`/`public`/`configured`/`authenticated`) are modelled explicitly (an integrity test
requires every step + branch to resolve to exactly one, so a SUPER_ADMIN-only action can never
render as "any user").

### Roles: live from configuration, per-viewer module filter
For each operation the guide shows the role(s) **configured live** to perform it, from
`GET /api/roles/access-matrix` (new authenticated endpoint — active roles + permissions + per-role
sidebar config; not `ROLE_MANAGE`-gated). A role shows on a step only if it can **see that
module's sidebar item AND holds the step's gate**; SUPER_ADMIN always. Custom roles appear
automatically with their own colour (e.g. on PM Schedules, a custom `Manager` reviews and `QA`
approves). Each viewer sees only the **modules their own role can access** (mirrors their sidebar),
via `routes/home/viewer-access.ts`. The earlier static `default-roles` copy + drift-guard were
retired for this live matrix. Backend: `roleRepository.findActiveWithAccess` +
`roleService.getAccessMatrix` + `GET /api/roles/access-matrix`.

### Sidebar item
`home` is hardcoded in `sidebar.tsx` (`if (item.id === 'home') return true;`) — it is
**non-configurable** and deliberately **not** part of `packages/shared/src/types/sidebar-items.ts`
(sidebar item count stays **26**, unaffected). It sits above the configurable items and is
visible to every authenticated user regardless of role, since the Module Guide is ungated
reference documentation, not a data-bearing page.

### Doc sync
Updated the frontend route count (76 → 77) and route-folder count (22 → 23) across the active
doc set: `CLAUDE.md`, `apps/web/CLAUDE.md`, `README.md`, `PROJECT_SUMMARY.md`,
`PROJECT_ARCHITECTURE.md`. `OFFLINE_SYNC_ARCHITECTURE.md` was not touched (protected surface).

## [Unreleased] — Reports (generate/sign) module tear-out (2026-07-04)

Branch: `RFID`. Removed the orphaned server-side report **generation + signing** engine
(`modules/reports/`) and its **template-designer backend** (`modules/report-templates/`).
Both were dead code: their frontend + 2 sidebar items were removed 2026-06-08, no active
backend imported either module, and they were reachable only by direct API. Same spirit as the
Phase 6 (rule-chain/alarm) and Phase 7 (data-ingestion/TSDB) tear-outs. Plan:
`tasks/REMOVE-REPORTS-MODULE-PLAN.md`. Pre-removal git tag: `pre-reports-module-drop`. Landed
across phases A–F (commits `655deaf`, `9c6defb`, `9189dc7`, `4df5bbc`, `c5c9660`, + this doc close).

### Scope removed
- **2 backend modules**: `apps/api/src/modules/reports/` (service, variable-resolver, 5 data-sources,
  renderers incl. chart/pdf, `renderers/__tests__/`) + `apps/api/src/modules/report-templates/`.
  Module count **35 → 33**. `app.ts`: 3 registration lines dropped.
- **4 Prisma models**: `ReportTemplate`, `ReportTemplateVersion`, `ReportInstance`, `ReportSignature`
  (tables `report_templates`, `report_template_versions`, `report_instances`, `report_signatures`) +
  4 back-relation fields on `User` + 4 cascade-cleanup `deleteMany` lines in `user.repository.ts`.
  Dropped via `prisma/migrations/20260704121326_drop_reports_generate_sign`; drift guard PASS. Model
  count **65 → 61**. Hard-deleted data: `report_templates` (5 rows), `report_template_versions`
  (27 rows) — belonged solely to the dead designer; `report_instances`/`report_signatures` were 0 rows.
- **2 enums**: `ReportTemplateStatus`, `ReportStatus`. Enum count **25 → 23**.
- **Shared package** (`packages/shared`): 7 permissions (`REPORT_TEMPLATE_{READ,CREATE,UPDATE,DELETE}`,
  `REPORT_VIEW`, `REPORT_SIGN`, `REPORT_DELETE`; **109 → 102**), 7 reauth actions
  (`{CREATE,UPDATE,DELETE}_REPORT_TEMPLATE`, `GENERATE_REPORT`, `SIGN_REPORT`, `REJECT_REPORT`,
  `DELETE_REPORT`; **99 → 92**), 9 orphaned `PERMISSION_TREE` nodes in the `filter-lifecycle-report`
  group (`report_templates.{view,create,edit,delete}` + `reports.{generate,view,sign,delete,export}`)
  + their `CONFIGURABLE_PRIVILEGE_ORDER` entries. Derived feature-privileges **90 → 83** (−9 nodes,
  +2 re-gated export nodes — see below). `legacy-maps-derived.test.ts` + `legacy-maps-snapshot.ts`
  updated; frozen-snapshot / referential-integrity tests green.
- **npm deps** (`apps/api/package.json`): `puppeteer-core`, `@napi-rs/canvas`, `chart.js`,
  `chartjs-adapter-date-fns`, `dayjs` (all reports-only; verified no other importer). Drops the
  Chromium-bindings + native-canvas transitive tree.
- **Default roles** (`default-roles.ts`): stripped the 7 dropped perms from SUPER_ADMIN / ADMIN /
  SUPERVISOR / MAINTENANCE / VIEWER grants; reconciled live `roles.permissions`.
- **Tests**: deleted 3 renderer tests (`chart-renderer`, `edge-detector`, `pdf-renderer`); trimmed
  the `/api/reports` registration + `POST /generate` blocks from `e2e/phase4-perms-themes-reports.test.ts`
  and `tests/integration/windows-server-stack.test.ts` "Test 4".

### Retained (active surfaces — NOT part of the generate/sign engine)
- **report-reviews** — `modules/report-reviews/` + `ReportReview` model + `/report-reviews` FE: the
  ad-hoc submit/review/approve workflow. Zero cross-import with the removed modules; no FK to dropped
  tables. Perms `REPORT_REVIEW_SUBMIT`/`REPORT_REVIEW`/`REPORT_APPROVE` + reauth
  `REVIEW_REPORT`/`APPROVE_REPORT` kept.
- **Report-config defs** — `report-page-titles`, `report-labels`, `report-signatories` + `report-config.tsx`
  + `report-page-wrapper.tsx` print chrome + `FilterLifecycleReportPage`.
- **Client PDF export re-gate (Option A)** — kept the `REPORT_EXPORT` / `REPORT_GENERATE` perm
  constants and made `cleaning_record.export` / `lifecycle.export` **configurable** with grant-set
  `['REPORT_EXPORT','REPORT_GENERATE']`, so those active export toggles remain grantable via the
  role-config picker after the orphaned `reports.generate`/`reports.export` toggles were removed.

### Doc correction
- Root `CLAUDE.md` previously claimed the *"live e-signature surface uses `ReportSignature`"* — wrong:
  `ReportSignature`'s only writer was the removed `reports/service.ts`. The live e-signature surface is
  `ReportReview` (plain signer columns) + the hash-chained `audit_trail`. Fixed in the doc sync.

### 21 CFR §11 contract retained
- `audit-actions.ts` / `audit-templates.ts` `REPORT_*` registry entries kept (retained-but-unemitted,
  like the UNS / RULE_CHAIN / DEVICE_CREDENTIAL entries) so historic audit rows still render.

## [Unreleased] — AHU dialog: show the real stage, "Completed" only when the cycle finished (2026-07-02)

The AHU interlock dialog labelled a filter "Completed" whenever it had `done=true`, but `done`
means *reached final stage* — which includes a filter parked AT its final stage (e.g. Storage
Out) with its terminal checklist **not yet submitted**. A cycle only completes when that
checklist is submitted (`CLEANING_CYCLE_COMPLETED`). Fix (display-only, `remaining-filters-dialog.tsx`):
- "Completed" (green ✓) is shown ONLY when `stage === 'CLEANING_CYCLE_COMPLETED'`.
- A filter at its final stage but checklist-pending now shows its actual stage (e.g. "Storage
  Out") with a distinct sky/blue indicator (reached final, not blocking, not yet completed).
- Still-in-progress / idle filters keep the blocking (rose/amber) treatment with their stage.
- The "N/M completed" count now counts only finished cycles, not filters merely at final.

The interlock gate is unchanged — "reached final stage" is the correct gate condition (requiring
full completion would deadlock: no filter could finish until all had finished). This is purely
the dialog's status wording. APK rebuilt.

## [Unreleased] — AHU interlock: multi-AHU carousel dialog (2026-07-02)

When a submission batch spans multiple AHUs, the pre-checklist dialog now shows **every AHU**
as a card in a ◀ ▶ carousel (was: only the primary filter's AHU). Approach A — the server
still enforces the interlock per-filter; the carousel is the heads-up.

- **Backend** (`ahu-completion-gate.ts` + route): new `computeAhuBatchStatus(filterIds)` resolves
  each filter's AHU, returns one `{ ahuId, ahuName, allAtFinal, filters }` block per distinct AHU
  (pending-first). New `POST /api/filters/ahu-completion-status/batch` (ASSET_READ).
- **Frontend** (`ahu-completion-check.ts` + desktop `filter-operations.tsx` + tablet
  `mobile-operations.tsx`): `gateAhuBeforeChecklist` now takes the **batch** filter IDs
  (single-filter sites pass `[id]`, batch sites pass all members), calls the batch endpoint, and
  shows the carousel when any AHU is pending. On proceed the whole-batch checklist opens; the
  server completes ready-AHU filters and 422-blocks pending ones ("block only pending").
- **Dialog** (`remaining-filters-dialog.tsx`): `ahus[]` array + carousel — ◀ ▶ arrows,
  "AHU X of N", dot indicators (green = ready), per-AHU "Ready"/"Blocking" badge, each AHU's
  filter roster. One AHU → single card, no arrows (unchanged look). INTERLOCK footer shows
  "Complete ready filters" only when at least one AHU is ready; all-pending → Close-only hard block.
- **Tests:** `ahu-completion-gate.e2e.test.ts` Task 10 asserts `computeAhuBatchStatus` returns a
  block per AHU, pending-first (17 tests pass). Live-verified: 3 filters across 3 AHUs → 3 cards.
  Spec: `docs/superpowers/specs/2026-07-02-ahu-multi-carousel-design.md`. APK rebuilt.

## [Unreleased] — AHU completion: pre-checklist gate + richer dialog (2026-07-02)

The AHU completion check now runs **before the terminal checklist opens** (for both POPUP
and INTERLOCK) instead of at submit — the operator is stopped before filling a checklist
they'd be blocked on. The dialog was redesigned to show the AHU + the full filter roster.

- **Backend** (`ahu-completion-gate.ts`): `computeAhuCompletionStatus` now also returns
  `ahuName` and `filters` (all active non-Retired `templateKind='FILTER'` children, each
  `{ id, name, stage, done }`, including the filter being cleaned). `allAtFinal`/`pending`
  unchanged (still exclude the current filter). `GET /ahu/:id/completion-status` schema +
  the INTERLOCK 422 details carry the new fields.
- **Frontend gate** (`ahu-completion-check.ts` + `filter-operations.tsx` desktop +
  `mobile-operations.tsx` tablet): a shared `gateAhuBeforeChecklist(filterId)` runs at every
  point a checklist is about to open, gated on `isTerminalChecklist`. **INTERLOCK + pending**
  → block (checklist doesn't open); **POPUP + pending** → warn (Continue opens, Cancel
  aborts); else opens normally. The old submit-time POPUP pre-flight is removed; the server
  422 stays as a safety net. Gating on the terminal checklist means intermediate checklists
  are never affected — dissolving the original two-filter deadlock concern.
- **Dialog** (`remaining-filters-dialog.tsx`): header shows the AHU name; body lists **all**
  filters under the AHU — completed marked with a green ✓ + "Completed", in-progress
  highlighted with their stage, the current filter tagged "(this filter)", plus an
  "N/M completed" count.
- **Tests:** `ahu-completion-gate.e2e.test.ts` gains an assertion for `ahuName` +
  `filters[].done` (16 tests pass). Live-verified: the endpoint returns `ahuName:'AHU-0B'`
  and the 6-filter roster with correct done flags. Spec:
  `docs/superpowers/specs/2026-07-02-ahu-precheck-dialog-design.md`.
- **APK rebuilt** — the tablet frontend change requires it.

## [Unreleased] — AHU INTERLOCK never blocked (loadCountedFilters predicate bug) (2026-07-02)

**Bug:** with AHU Completion Process = INTERLOCK, completing a filter's final cleaning
stage was **not** blocked even when sibling filters of the same AHU hadn't been cleaned —
the interlock never fired. Root cause in `ahu-completion-gate.ts loadCountedFilters()`: it
counted only filters whose `FilterDetails.filterProfileId` is non-null. But that direct
binding is optional and **unused in practice** — `resolveFilterProfile()` resolves a
filter's cleaning profile from a config rule (`cleaning-profile-assignment`) or a default
fallback (first ACTIVE profile), per the 2026-05-25 decision that `filter_profile_id` must
not be required to start a cycle. Measured: **0 of 274** filters carry the binding, so
`loadCountedFilters` returned **zero siblings for every AHU** → `computeAhuCompletionStatus`
always reported `allAtFinal: true` → INTERLOCK (and the POPUP feed, which shares the same
helper via `GET /ahu/:id/completion-status`) were silent no-ops **system-wide**. This also
contradicted the feature's own design decision D3 ("count all active, non-Retired child
filters").

**Fix:** count all active, non-Retired child **filters** (`template.templateKind = 'FILTER'`)
regardless of the `filterProfileId` binding — matching D3, and D4 (idle / never-started
filters are included and block). One-line predicate change in `loadCountedFilters`; fixes
both INTERLOCK and POPUP (single shared code path).

**Why it shipped undetected:** the existing e2e fixtures set `filterProfileId`, so they
passed with the bug present. Added a fail-first regression test (`ahu-completion-gate.e2e.test.ts`
Task 9) that creates filters with `filterProfileId = null` (the production condition) and
asserts the idle sibling is counted as pending — it fails on the old predicate, passes on the
new one. All 15 gate tests pass. **Live-verified** on the reported AHU: `completion-status`
now returns `allAtFinal:false` with the 4 uncleaned siblings (was `true`/empty).

**Note:** cycles that already completed before this fix stay completed (past actions are
immutable); the gate now blocks *future* final-stage completions while siblings are pending.

## [Unreleased] — Date/time config respected in audit detail + app-wide sweep (2026-07-02)

**Bug:** the Audit Trail detail modal showed `createdAt`/`updatedAt` inside a record's
before/after payload as raw ISO strings (`2026-07-02T07:25:38.462Z`) instead of the
configured date/time format. The modal rendered every payload field via `String(value)`,
so ISO date strings bypassed the `useDatetimeFormat()` hook.

- **New shared helper `formatIfDate(value)`** on `useDatetimeFormat()` — formats a value
  ONLY if it's an ISO-8601 date (`…T…` → `formatDateTime`, `YYYY-MM-DD` → `formatDate`),
  else returns `null` so callers fall back. Value-based (not key-name) detection.
- **`audit/components/audit-detail-modal.tsx`** — both Previous/New value blocks now render
  `formatIfDate(value) ?? String(value)`; `formatIfDate` threaded from `audit/index.tsx`.
  Verified live: `createdAt`/`updatedAt` now show `02/07/2026 01:10 PM` (config format,
  UTC→configured timezone), no console errors.

**App-wide sweep** (4 parallel agents over routes/mobile/lib/components; canonical pattern =
the ~43 files using `useDatetimeFormat`, exclusions = `toISOString()` wire/filenames,
`<input type=date|datetime-local>`, chart-axis/preview, date-math). Fixed the clear
data-timestamp display bugs:
- **`version-history/index.tsx`** — the diff-view `formatVal()` rendered ISO snapshot values
  with raw `toLocaleString()`; now takes the config `formatDateTime` (threaded through `DiffLine`).
- **`mobile-wrapper.tsx`** — the RFID-scan "Last Cleaned" `fmt` used hardcoded `toLocale*`;
  now uses `formatDateTime`.

Also made the **`mobile-wrapper.tsx:1036`** weekday home-header (`THU 02 JUL`)
timezone-correct — it kept its decorative weekday/day/month style but now passes
`timeZone: config.timezone` so it can't show the wrong day for the configured timezone.

**Reviewed, left as a judgment call (not a data timestamp):** `dashboard.tsx:406,412`
(chart **axis** tick labels — full config dates per tick would clutter the axis). **Confirmed OK:**
PDF/Excel report output (`lib/pdf-report.ts`, `lib/report-review.ts`) already receives
`formatDateTime` from callers, so reports honor the config; filter-management pages were clean.

## [Unreleased] — Test suite isolated to digilog_test_db (2026-07-02)

**The `apps/api` vitest suite ran against the live dev DB `digilog_db`**, so every
audited e2e action wrote **permanent, immutable, hash-chained** rows into the real
`audit_trail` (21 CFR §11). The most visible symptom: `phase3-rfid-offline.test.ts`
created `RFID-p3-<Date.now-b36>-A/B` tags and deleted their throwaway filters in
`afterAll`, leaving orphaned `ASSET_IDENTIFIER_*` audit rows with blank filter names
that dominated the top (newest-first) of the operator's Audit Trail UI.

- **New `apps/api/vitest.env.ts`** — shared bootstrap that loads `.env` then rewrites
  `DATABASE_URL` (`digilog_db` → `digilog_test_db`) before any `lib/prisma` import
  constructs the client. Idempotent (skips if already the test DB).
- **`vitest.setup.ts`** (per worker) and **`vitest.global-setup.ts`** (main process)
  both import it for its side effects; the duplicated dotenv boilerplate was consolidated
  into it.
- **`digilog_test_db` seeded** (roles incl. `SUPER_ADMIN`, base config, template kinds) —
  same migration-driven schema as `digilog_db` (68 tables, 2 migrations; no migration needed).
- **Two tests un-coupled from ambient data:** `entities.test.ts` instance-list now asserts
  the pagination contract (array/number/page) instead of `total >= 1` (relied on the 390
  seeded filters in `digilog_db`).
- **Verified:** full single-fork run **829 passed / 0 failed / 15 skipped** against
  `digilog_test_db` — identical to the `digilog_db` baseline. Confirmed airtight: three
  test-suite runs added **0** rows to `digilog_db.audit_trail` (newest identifier row
  unchanged at 327); test writes landed in `digilog_test_db`.
- **Known pre-existing flake (not introduced here):** `config.test.ts`'s
  `GET /api/config/datetime/current` intermittently sees a body without `dateFormat` in the
  full 80-file run only (passes in isolation + most full runs; the `[Config] Validation
  failed` warning is absent, ruling out data corruption). Documented in `apps/api/CLAUDE.md`.

## [Unreleased] — RFID audit record: filter name + tag value now render (2026-07-02)

**Bug:** the audit-trail line for adding/removing an RFID (or QR/barcode) identifier
rendered as `New identifier (RFID) added to filter "" by admin` — the filter name was
blank and the tag value was absent. Two independent defects, fixed at both layers:

1. **Stored record was not self-describing.** `identifier.service.ts` wrote
   `afterValue: identifier` (the raw `asset_identifier` row), which carries `assetId`
   but no filter name. The audit-list endpoint (`audit/routes.ts`) has read-time
   enrichment that resolves `assetId → filterName` by looking the filter up live — so
   rows whose filter **still exists** already rendered the name. But when the filter was
   **later hard-deleted**, the live lookup returns nothing → the row falls back to `""`
   (measured: 81 of 492 identifier rows referenced a since-deleted filter). Fix: capture
   the name at write time so the audit record is self-describing and survives deletion —
   `create()` now stores `{ ...identifier, filterName: asset.name }`; `delete()` resolves
   the filter via `instanceRepository.findByIdSimple` and stores `filterName` on
   `beforeValue`. (Read-time enrichment preserves the stored value via `?? `, so no conflict.)
2. **Template never surfaced the tag value.** `ASSET_IDENTIFIER_CREATED` / `_DELETED`
   templates (packages/shared `audit-templates.ts`) rendered `{identifierType}` only —
   the RFID/QR value was missing on **all** rows even though it was stored. Added
   `{identifierValue}` to both templates + their `placeholders`, and the matching
   `{identifierValue}` substitution in the web renderer (`audit/audit-helpers.ts`).

Now renders e.g. `New identifier (RFID: E28011700000021ABCDE) added to filter "Filter-42" by admin`.

**Historic rows:** the **tag value** backfills on all rows (already stored). The **filter
name** already resolves on rows whose filter still exists (read-time enrichment); rows whose
filter was hard-deleted **cannot** recover the name — it was never stored and `audit_trail`
is immutable (21 CFR §11 / `audit_trail_no_update` trigger). Only new rows are guaranteed
correct post-deletion. This is a data limitation, not a further code gap.

**Touchpoints checked:** `getRfidTrackRecord` (RFID Track Record report) reads specific
`afterValue` fields and resolves filter/AHU names via its own join — the added `filterName`
field is additive and does not affect it. Audit-text config has no saved override for these
keys (verified `system_config` row), so the shared-default change takes effect. Tests:
`identifier.service.test.ts` (asserts `filterName` + `identifierValue` in the audit payload),
`audit-templates.test.ts` (placeholder⊆template invariant). Shared package rebuilt.

## [Unreleased] — AHU Cleaning Completion Process (2026-07-01)

New global configuration (`ahu-completion-process`, SUPER_ADMIN-only) that gates final-stage cleaning submission per AHU. Three mutually-exclusive modes:

- **None** (default) — today's behaviour, no check.
- **Popup** — client-side warning listing sibling filters not yet at final stage; operator may Continue or Cancel.
- **Interlock** — hard server-side block: `POST /api/filters/:id/submit-checklist` returns **422 `AHU_INTERLOCK_PENDING`** with `{ pendingFilters }` when any active sibling filter of the same AHU has not yet reached its final cleaning stage.

**Design decisions (D1–D7):**
- **D1** — "Final stage" requires a terminal checklist (`submit-checklist.ts` path only; `advance.ts` auto-complete is untouched). See §11.1 limitation below.
- **D2** — Offline best-effort: gate skips when `isOfflineReplay === true` to avoid sync-queue poisoning. Documented gap.
- **D3** — Counted filters = all active, non-Retired child filters of the AHU (ignores `pmFilterSetMode`).
- **D4** — Every counted filter must reach final, including idle / never-started ones. A brand-new or never-started filter blocks the AHU.
- **D5** — Config rendered as a dropdown (`select`) by the existing auto-generated dynamic config renderer; no new page file.
- **D6** — Admin force-complete (`instance.service.ts`) intentionally bypasses the batch rule.
- **D7** — A filter's "reached final" state is interpreted against its current cycle id; `CLEANING_CYCLE_COMPLETED` marker is reset when a different new cycle starts, so stale completions from a prior cycle are not counted.

**New files:**
- `apps/api/src/modules/config/defs/ahu-completion-process.def.ts` — config definition (config-def count 34 → 35).
- `apps/api/src/modules/filter-operations/ahu-completion-gate.ts` — `getAhuCompletionMode`, `resolveAhuId`, `buildFinalStageMap`, `assertAhuInterlockSatisfied`.
- `apps/api/src/modules/config/static-routes/ahu-completion-process.routes.ts` — runtime read route.
- `apps/web/src/hooks/use-ahu-completion-mode.ts` — SWR hook returning `'NONE' | 'POPUP' | 'INTERLOCK'`.
- `apps/web/src/routes/filter-management/components/remaining-filters-dialog.tsx` — mode-aware dialog (Popup: Continue/Cancel; Interlock: blocking).

**New endpoints:**
- `GET /api/config/ahu-completion-process/current` — runtime mode for authenticated operators.
- `GET /api/filters/ahu/:ahuId/completion-status` (`ASSET_READ`) — pending-sibling list (used by Popup + client Interlock UX).
- `GET /api/filters/cleaning-profiles/without-final-checklist` — lists in-use cleaning profiles whose last pipeline node is not a checklist (drives admin warning banner on the config card).

**Modified endpoint:** `POST /api/filters/:id/submit-checklist` — may now return **422 `AHU_INTERLOCK_PENDING`** in Interlock mode.

**§11.1 Limitation (accepted, D1):** Interlock enforces **only** on cleaning profiles that end with a checklist node. Profiles that complete via `advance.ts` auto-complete (no terminal checklist) are not blocked. An amber admin warning banner on the config card lists any in-use profiles without a final checklist so operators know which profiles are unenforced. Full coverage (gating `advance.ts`) is deliberately deferred — higher risk to a validated, audited, offline-critical path.

**No schema/migration changes.** Config stored in existing `SystemConfig` table. No new Prisma models, columns, or enums. No new permissions or reauth actions (reuses `CONFIG_READ` / `CONFIG_UPDATE` / `ASSET_READ`). Query cost in Interlock mode: 3 DB queries + ≤ k profile-graph loads (k = distinct pinned profile versions in the AHU, typically 1).

Frontend wired into both desktop (`filter-operations.tsx`) and tablet (`mobile-operations.tsx`) terminal-checklist submit paths. Config card added to `apps/web/src/routes/config/index.tsx`.

## [Unreleased] — Audit Trail: physical hard-delete permission (⚠ compliance-affecting) (2026-07-01)

Per explicit operator request (confirmed after being warned twice about the 21 CFR §11
consequences), re-added the **physical hard-delete** of audit records that was torn out
in 2026-05 and replaced with redact.

- **New `AUDIT_DELETE` permission** (constants 108 → 109) + **`audit.delete` picker toggle**
  ("Delete Audit Record (permanent)", gate `['AUDIT_DELETE']`, grant-set `[AUDIT_DELETE, AUDIT_READ]`,
  feature-privileges 88 → 89). Off by default — no role is granted it; enable per role in
  Roles & Access. SUPER_ADMIN bypasses the gate.
- **New reauth actions** `DELETE_AUDIT_RECORD` + `BULK_DELETE_AUDIT_RECORDS` (100 → 102).
- **Backend** `DELETE /api/audit/:id` + `POST /api/audit/bulk-delete` (audit/routes.ts): require
  `AUDIT_DELETE` + reauth + a `reason` (≥5 chars). Each disables the `audit_trail_no_delete`
  immutability trigger for the scope of its transaction (query `pg_trigger` → `ALTER TABLE …
  DISABLE/ENABLE TRIGGER`; the ACCESS-EXCLUSIVE lock closes any concurrency window), and writes
  a meta-audit row (`AUDIT_RECORD_DELETED` / `AUDIT_RECORDS_BULK_DELETED`) capturing who/what/why
  **before** the target row is destroyed.
- **⚠ WARNING — this breaks the tamper-evident hash chain.** Physical deletion leaves a
  `chain_position` gap and orphans the next row's `previous_checksum`, so `GET /api/audit/verify-chain`
  reports the downstream chain **invalid, permanently**. `verify-chain` / `verifyAuditChecksum` were
  deliberately **not** taught to tolerate authorized deletions — the breakage stays loud and visible.
  **REDACT (`POST /:id/redact`) remains the recommended, chain-preserving path** (masks the payload,
  keeps the record + chain intact).
- **Frontend** (audit page): a distinct **"Delete Permanently"** affordance gated on
  `can('audit.delete')`, shown alongside the existing (now amber, clearly-labeled) **"Redact"**
  gated on `can('audit.redact')` (SUPER_ADMIN-only). The shared confirm dialog is now mode-aware
  (redact vs delete wording). `apiClient.delete` / `deleteWithReauth` gained an optional body so the
  required `reason` reaches the backend.

Verified: 27/27 RBAC frozen-snapshot tests, 15/15 audit + audit-chain e2e tests (endpoint deletes
against the real trigger; chain-breaking deletions don't cascade into verify tests); shared/api/web
typecheck clean.

## [Unreleased] — Notifications picker: remove Manage, make Delete a real permission (2026-07-01)

Per user request, two changes to Roles & Access → Notifications:

- **Removed "Manage Notifications"** (`notifications.manage`) from the picker (enforced-only).
  `NOTIFICATION_MANAGE` is enforced by no route (notification endpoints are user-scoped/auth-only).
- **Made "Delete Notifications" actually work.** It was inert: `notifications.delete` had gate `[]`
  (SUPER_ADMIN-only), so `can('notifications.delete')` was false for any non-SA role even after enabling
  the toggle → the delete button never appeared; the backend delete routes also used `requireSuperAdmin()`.
  Now the node gates on `['NOTIFICATION_DELETE']`, and the backend `bulk-delete` + `DELETE /:id` routes use
  `requirePermission('NOTIFICATION_DELETE')`. So **enabling the "Delete Notifications" toggle now shows the
  delete option** (per-row + "Delete Selected"), and only when the permission is granted. SUPER_ADMIN still
  bypasses; reauth (`DELETE_NOTIFICATION`) still applies. Reverses the 2026-06-30 M5 "delete = SA-only" decision.

Feature-privileges **89 → 88**; frozen snapshot + count assertions + the SA-only-nodes test updated;
27/27 RBAC tests pass; shared/api/web typecheck clean.

## [Unreleased] — Filters picker: remove RFID toggle, add Export (PDF/Excel) toggle (2026-07-01)

Per user request, swapped two toggles in the Roles & Access → Filters permissions:

- **Removed "Assign / Unassign RFID Tags"** (`filters.rfid_manage`) from the picker — made enforced-only.
  No practical impact: `FILTER_RFID_MANAGE` was held only by SUPER_ADMIN (who bypasses `can()` anyway),
  so nobody was using the toggle to grant RFID. The RFID button still gates on `FILTER_RFID_MANAGE`.
- **Added "Export Filter List (PDF / Excel)"** (`filters.export` → new `FILTER_LIST_EXPORT` constant,
  `enforce:'c'`) that hides/unhides the Filters-page Export menu. Gated `<ExportMenu>` in `filter-list.tsx`
  on `can('filters.export')`. Mirrors `retirement_list.export`: **off by default** (the export menu was
  previously always visible; now SUPER_ADMIN still sees it via bypass, and admins enable the toggle per role
  to unhide it for others).

Permission constants **107 → 108**; feature-privileges unchanged at **89** (−1 RFID, +1 Export). Frozen
snapshot + map updated; 27/27 RBAC tests pass; shared/api/web typecheck clean.

## [Unreleased] — Filters edit/create/delete gate on the specific FILTER_* perm, not broad ASSET_* (2026-07-01)

Follow-up to the ASSET_* over-grant fix. The grant-set change stopped *new* grants of `ASSET_UPDATE`
via "Update Filter Status", but **existing roles that already held `ASSET_UPDATE` still showed edit
everywhere** — because the edit/create/delete controls gate via `can('filters.edit')` etc. whose gates
accepted the broad `ASSET_*` as an alternate (`FILTER_EDIT` **or** `ASSET_UPDATE`).

Fixed by tightening the 5 gates to the specific perm only:
`filters.edit → [FILTER_EDIT]`, `filters.hierarchy_edit → [FILTER_HIERARCHY_EDIT]`,
`filters.create → [FILTER_CREATE]`, `filters.delete → [FILTER_DELETE]`,
`filters.hierarchy_delete → [FILTER_HIERARCHY_DELETE]` (dropped the `ASSET_UPDATE`/`ASSET_CREATE`/`ASSET_DELETE`
alternates). Now the edit/create/delete controls appear **only** when the role has the specific "Edit Filters" /
"Edit Block/Area/AHU" toggle — a role with only "Update Filter Status" (or only the broad `ASSET_UPDATE`) sees
just the manual status-update feature, no edit. Verified: status-only role → status feature only; broad
`ASSET_UPDATE` → nothing unlocked; `FILTER_EDIT` → edit shows.

**Role sync:** the live-DB `ADMIN` row was stale (relied on `ASSET_UPDATE`; its default-roles definition already
lists the `FILTER_*` perms) — added `FILTER_EDIT/DELETE/HIERARCHY_CREATE/EDIT/DELETE` to live ADMIN so it keeps
edit. Custom roles that got edit only via the broad `ASSET_UPDATE` (e.g. MANAGER) now need the "Edit Filters"
toggle enabled — that's the intended model (edit is granted by the Edit toggle, not by broad/legacy perms).
Backend edit endpoints still accept `ASSET_UPDATE` via `requireAnyPermission` (UI is fixed; tightening the API
is a separate follow-up). No gate tests to update; 27/27 RBAC tests pass; shared/api/web typecheck clean.

## [Unreleased] — Fix ASSET_* over-grant leaking edit/create across the Filters page (2026-07-01)

**Bug (user report):** enabling **Update Filter Status** for a role also made **every edit control on
the Filters page appear**. Root cause: `filters.status_update`'s grant-set was
`['FILTER_STATUS_UPDATE', 'ASSET_UPDATE', 'ASSET_READ']` — it handed out `ASSET_UPDATE`, and the page
gates edit via `can('filters.edit')` (gate `FILTER_EDIT` **or** `ASSET_UPDATE`) and
`can('filters.hierarchy_edit')` (gate `FILTER_HIERARCHY_EDIT` **or** `ASSET_UPDATE`). So the broad
`ASSET_UPDATE` satisfied the edit gates. Real escalation, not just cosmetic — the edit endpoints also
accept `ASSET_UPDATE`. The status-update endpoint itself only needs `FILTER_STATUS_UPDATE`.

**Fix (whole pattern — 6 toggles):** removed the broad `ASSET_CREATE/UPDATE/DELETE` over-grants from
the grant-sets of `filters.status_update` (`ASSET_UPDATE`), `filters.bulk_upload` + `filters.hierarchy_create`
+ `equipment_groups.create` (`ASSET_CREATE`), `equipment_groups.edit` (`ASSET_UPDATE`), and
`equipment_groups.delete` (`ASSET_DELETE`). Each keeps its specific perm (`FILTER_*`/`EG_*`) + `ASSET_READ`.

**Consequence:** `ASSET_*` now appears in **no** configurable grant-set, so it left `allMappedPerms` and is
**manual-managed** — edit/create is granted via the `FILTER_*` toggles. This reverses the 2026-06-30
"keep ASSET_* in grant-sets" decision (which had the side effect of this leak). Perm constants KEPT;
ADMIN/MAINTENANCE hold `ASSET_*` explicitly in default-roles; existing roles' `ASSET_*` is preserved on
re-save (no data migration — no live role was spuriously leaked). Feature-privilege count unchanged (89).
27/27 RBAC tests pass; shared/api/web typecheck clean.

## [Unreleased] — Permissions-picker redundancy audit: de-dup toggles + re-tag notifications (2026-07-01)

Audited all 92 configurable picker toggles (gate vs. actual backend enforcement). Findings + fixes:

**A — 3 redundant toggles → enforced-only** (feature privileges **92 → 89**; perms + nodes kept):
- `checklists.toggle` — **identical gate** to `checklists.edit` (`FCP_UPDATE`+`CHECKLIST_EDIT`); `CHECKLIST_TOGGLE` is only a read-alternate.
- `cleaning_profiles.toggle` — gate is a superset of `cleaning_profiles.edit`; anyone who can edit satisfies it.
- `checklists.submit` — **same `FILTER_OPERATE` gate** as `filters.operate`; `CHECKLIST_SUBMIT` is enforced in 0 routes (submitting a checklist is part of operating).

**B — 2 mislabeled toggles re-tagged `enforce:'a' → 'c'`:**
- `notifications.view` / `notifications.manage` — `NOTIFICATION_VIEW`/`NOTIFICATION_MANAGE` are enforced by **no route** (the notification endpoints are user-scoped/auth-only; delete is SUPER_ADMIN-only). They remain configurable (they gate the Notifications sidebar item) but are honestly tagged visibility-only.

Kept `visibilityPrivilegeIds`/`SIDEBAR_PRIVILEGE_MAP` untouched → **zero sidebar-visibility change**. Verified NOT
redundant: Dashboards (real UI + `DASHBOARD_VIEW/CREATE` enforced), filters create/edit/delete + hierarchy family
(distinct entities), reports, PM, users. Frozen snapshot + count assertions updated (92→89); **27/27 RBAC tests pass**;
shared/api/web typecheck clean.

## [Unreleased] — Remove vestigial ASSET_RELATIONSHIP_* permission constants (2026-07-01)

Follow-up to the toggle de-dup: fully removed the two `ASSET_RELATIONSHIP_CREATE` /
`ASSET_RELATIONSHIP_DELETE` **permission constants** (PERMISSIONS **109 → 107**) — they were
grant-only perms **never used as a route gate** (relationship writes go through the PUT-instance
`parentId` change, gated by `ASSET_UPDATE/FILTER_EDIT/FILTER_HIERARCHY_EDIT`, i.e. the `assets.edit`
node). Removed from: `permissions.ts`; the (already enforced-only) `assets.relationships.create/delete`
PERMISSION_TREE nodes **deleted entirely**; `permission-categories.ts` ("Asset Relationships" category
gone); `role.service.ts` label map; `default-roles.ts` (2 roles); the frozen-snapshot oracle was already
clean; and the two `resolveNodeGate` relationship tests removed. Also stripped the orphaned strings from
the live-DB `roles.permissions` (only SUPER_ADMIN had them — and SA bypasses checks anyway). No effective
access change (the edit gate still covers relationship writes). 27/27 RBAC tests pass; shared/api/web
typecheck clean.

## [Unreleased] — Roles & Access: de-dup RFID/Relationship toggles + rename View Filters (2026-07-01)

Cleaned up redundant toggles in the **Roles & Access → Permissions** picker (feature
privileges **96 → 92**), following the 2026-06-30 assets/filters de-dup pattern:

- **RFID assign/unassign was shown 3×** — `assets.identifiers.create` ("Assign RFID Tags"),
  `assets.identifiers.delete` ("Unassign RFID Tags"), and `filters.rfid_manage`
  ("Assign / Unassign RFID Tags"). Made the two `assets.identifiers.*` nodes **enforced-only**
  (dropped from the picker); `filters.rfid_manage` is now the single RFID toggle. Both identifier
  endpoints already accept `FILTER_RFID_MANAGE` via `requireAnyPermission`, and `ASSET_IDENTIFIER_DELETE`
  was added to `filters.rfid_manage`'s grant-set so the permission map stays complete.
- **Relationship toggles were vestigial** — `assets.relationships.create/delete` grant
  `ASSET_RELATIONSHIP_CREATE/DELETE`, which are **never used as a route gate** (relationships are
  created/removed via the PUT-instance parentId change, gated by `ASSET_UPDATE/FILTER_EDIT/FILTER_HIERARCHY_EDIT`).
  Made both **enforced-only**.
- **Renamed** `assets.view` label "View Assets" → "View Filters".

Nodes are retained for gate/reauth resolution and all permission constants are kept, so **no role's
effective access changes** and no `useCan` gating breaks (none referenced these node ids). Updated the
frozen-snapshot oracle + count assertions (`legacy-maps-derived.test.ts` 96→92); **all 29 RBAC tests
pass**, shared/api/web typecheck clean.

## [Unreleased] — Drop orphaned qr_codes + latest_telemetry tables (2026-07-01)

Removed two dead tables surfaced by a schema audit: **`QrCode`/`qr_codes`** and
**`LatestTelemetry`/`latest_telemetry`** (Prisma models **69 → 67**; 25 enums unchanged).
Both had **0 rows and no foreign keys**. The systems that populated them were already gone
— the QR-code module was deleted 2026-06-06, and the telemetry ingestion pipeline was torn
out in Phase 7 (2026-06-11..17) — but the models + tables + a few stale references lingered.

Removed: the two model blocks in `schema.prisma`; the cascade `deleteMany` calls in
`assets/services/instance.service.ts` (+ their test mocks); and the `prisma.latestTelemetry.findMany`
read in `dashboards/routes.ts` (the `value_card`/`gauge`/`status_indicator` widgets now return
`[]` like the already-stubbed `timeseries_chart`). Hand-authored migration
`20260701071802_drop_qrcode_latesttelemetry` (DROP TABLE IF EXISTS, per the no-`db push`
discipline); applied to dev + test DBs; **drift guard PASS** (scratch-from-migrations diffs empty
vs dev). Backup/restore is dynamic (no hardcoded table list) so it adapts automatically.

## [Unreleased] — Setup.exe packaging M8: tablet HTTPS-on-LAN + runtime server URL (2026-07-01)

**Context:** M8 of the customer `Setup.exe` effort (`tasks/EXE-PACKAGING-PLAN.md` §13) — the
desktop install now also serves the Android tablet over the LAN. Three parts shipped; one
gate deferred (needs a real Android device on a LAN).

**1. Client — runtime server-URL resolver + first-launch screen.**
New `apps/web/src/lib/api-base.ts` exports `getApiBase()` (localStorage `digilog.serverUrl`
→ `window.__API_BASE__` → `VITE_API_URL` → `''`); wired into all ~8 base-URL read sites and
the boot init in `main.tsx`. New native-only "Server Address" setup screen
(`apps/web/src/routes/mobile/server-config.tsx`) appears on first APK launch when no server
URL is stored; validates the entered URL against `/api/health` before persisting. A "Change
server address" link is shown on the login page for native builds. Desktop (non-Capacitor)
skips the screen and falls back to `''` (same-origin). `apps/web/.env.production`
`VITE_API_URL` blanked and force-tracked via a `.gitignore` negation so it ships as-is.

**2. Server — HTTPS cert generation at install.**
`scripts/install.ps1` now generates a rootCA + server cert (SAN = LAN IP + `localhost` +
`127.0.0.1`) into `C:\ProgramData\DigiLog\certs` via the bundled openssl from the PG18 zip.
Sets `API_HTTPS=true`, `TLS_KEY_PATH`, `TLS_CERT_PATH`, and `https://` `ALLOWED_ORIGINS` in
`digilog.env`. Imports `rootCA.pem` into `LocalMachine\Root` so the PC's own browser trusts
the cert. Health check updated to `https://localhost:3000/api/health`. `installer/DigiLog.iss`
updated: shortcut URL changed to `https://localhost:3000`; new "Install tablet certificate"
Start-menu helper pointing at `C:\ProgramData\DigiLog\certs\rootCA.pem`.

**3. APK — trust operator-installed CAs.**
`apps/android/.../res/xml/network_security_config.xml` now includes `<certificates
src="user" />` alongside the existing `src="system"` and `@raw/rootca`. This means the APK
trusts any CA the operator installs on the tablet (Settings → Security → Install certificate)
— enabling one APK for all customers rather than a per-site rebuild.

**Deferred gate (cannot verify in dev):** the full tablet round-trip — real Android device on
a LAN, operator installs `rootCA.pem`, APK first-launch server-address entry (`https://<IP>:3000`),
Connect (health check), login over HTTPS. Documented in `tasks/M7-CLEAN-VM-ACCEPTANCE-RUNBOOK.md`
§7.

## [Unreleased] — Setup.exe packaging M7: code-signing scaffold + acceptance runbook (2026-07-01)

**Signing scaffold** (`scripts/build-installer.ps1`): optional `-Sign` step — `-CertPath`(PFX)
`+ -CertPassword`, or `-CertSubject` (Windows store cert), with an RFC3161 `-TimestampUrl`
(default DigiCert). Locates `signtool.exe` from the newest installed Windows SDK. When `-Sign`
is omitted the build is unsigned and prints an explicit "UNSIGNED — SmartScreen/AV will warn"
notice; when `-Sign` is requested but the cert/tool can't be resolved it **fails hard** (no
silently-unsigned "signed" build). Also hardened staging: `build-installer.ps1` now runs
`prisma generate` in the clean-room and stages `apply-schema.ps1`/`upgrade.ps1`;
`stage-runtime.ps1` now **fails** (not warns) if the generated Prisma client or query engine
is missing.

**Clean-VM acceptance runbook** (`tasks/M7-CLEAN-VM-ACCEPTANCE-RUNBOOK.md`): fresh-Windows-VM
checklist — install → services auto-start → login → data-lands-in-ProgramData → reboot →
upgrade-preserves-data+secrets → uninstall-preserves-ProgramData, with SmartScreen warnings
flagged as expected (not failures).

**Decisions (user, 2026-07-01):** (1) code signing = **scaffold now, sign later** (no cert
purchased); (2) the desktop install **must also serve the Android tablet over the LAN** — this
opens **M8** (`EXE-PACKAGING-PLAN.md` §13): server-side HTTPS-on-LAN (openssl cert into
ProgramData, env-configurable cert path, `API_HTTPS`, CA trust/export) + the open (a)/(b)
client decision for how the APK finds the server (per-customer rebuild+static-IP vs a
runtime-configurable server-address screen). M8 not started.

## [Unreleased] — Setup.exe packaging M6: upgrade + uninstall safety (2026-07-01)

**Context:** M6 of the customer `Setup.exe` effort (`tasks/EXE-PACKAGING-PLAN.md`) — safe
v(N)→v(N+1) upgrades of an audited DB, plus the `UPLOAD_DIR` ship-blocker M4 flagged.

**1. Uploads honor `UPLOAD_DIR` (§9.6b ship-blocker).** New `apps/api/src/lib/uploads-dir.ts`
(`UPLOADS_ROOT` = `UPLOAD_DIR` or a cwd-independent `apps/api/uploads` fallback) is the single
source for uploads. Wired into 4 sites: static serve (`app.ts`), profile-photo writer
(`modules/uploads/routes.ts`), report-PDF writer (`modules/reports/service.ts`), deployment-check
probe. The report writer was the worst — `path.resolve('uploads/reports')` was **cwd-relative**, so
under the Windows service it wrote into the program dir and stored that (soon-deleted) absolute path
in the DB. Dev behavior unchanged (no `UPLOAD_DIR` set); customer install points it at
`C:\ProgramData\DigiLog\uploads` so uploads survive upgrades.

**2. Schema apply runs with only `node.exe` (fixes fresh install AND upgrade).** `tsx` and the
`prisma` CLI are `devDependencies` → pruned by `npm ci --omit=dev`, and the bundle ships only
`node.exe` (no `npx`) — so the M3 `provision-db.ps1` (which used `npx prisma`/`npx tsx`) could never
have run on a real customer box. Fixed: moved `prisma` to runtime `dependencies` (keeps the CLI +
`@prisma/engines` schema engine after the prune); precompiled `prisma/seed.ts` → `prisma/seed.mjs`
via esbuild in `build-bundle.ps1`. Proven end-to-end on a scratch DB with only `node`:
`node …/prisma/build/index.js migrate deploy` (70 tables) + `node prisma/seed.mjs` (roles, superadmin,
33 help articles, invariants).

**3. Shared `scripts/apply-schema.ps1`** (migrate deploy + seed; node-only with npx/tsx dev fallback)
is used by BOTH fresh (`provision-db.ps1`, refactored) and upgrade (`upgrade.ps1`) so the two paths
can never drift.

**4. `scripts/upgrade.ps1`** — validate prior install → ensure DB up → stop API → **`pg_dump` backup
(FATAL on failure)** → apply-schema (throwaway admin pw; seed upsert preserves the real password) →
restart API → health. `digilog.env` secrets preserved, never regenerated. Manual rollback documented.

**5. `installer/DigiLog.iss`** — detects upgrade (env file present), skips the admin-password page,
`net stop DigiLogAPI` in `PrepareToInstall()` before the file copy; `pgsql\` copied `onlyifdoesntexist`
so the DB stays up for the live backup and `postgres.exe` never locks the copy. `uninstall.ps1` already
preserves `C:\ProgramData` (only `-PurgeData` removes it).

**Deferred gates (build/customer machine, same class as M5):** ISCC compile, admin test-install, a real
clean-room `npm ci --omit=dev` + bundled-node migrate/seed run. All dev-testable pieces verified here;
scripts AST-clean, API typecheck clean.

## [Unreleased] — Filters/Assets permission toggle de-duplication (2026-06-30)

**Problem (user report):** on the Filters page the role-config picker showed two parallel write
vocabularies for the same capability — *Asset Management* (`Create/Edit/Delete Assets` →
`ASSET_CREATE/UPDATE/DELETE`) and *Filters Page Controls* (`Create/Edit/Delete Filters` +
`Block/Area/AHU` → `FILTER_*`/`FILTER_HIERARCHY_*`). Because the polymorphic backend create/edit/
delete endpoints accept *either* via `requireAnyPermission(...)`, these are the same power under
different names.

**Fix (conservative, no migration):** `assets.create`/`assets.edit`/`assets.delete` PERMISSION_TREE
nodes made **enforced-only** (`configurable` dropped) so they no longer appear as separate toggles in
the picker; the filter-specific Create/Edit/Delete (Filters + Block/Area/AHU) toggles are now the single
clear control. `FEATURE_PRIVILEGES` 99→96. The `ASSET_CREATE/UPDATE/DELETE` **permission constants are
KEPT** — still granted in default roles + live DB, still accepted as backend alternates — and still appear
in the grant-expansion of `filters.hierarchy_create`/`filters.bulk_upload`/`filters.status_update`/
`equipment_groups.*`, so `config.service` `allMappedPerms` is unchanged and **role rebuilds behave
identically** (no role loses access, no DB migration). Frozen snapshot + count assertions updated
(legacy-maps-derived 8/8, permission-tree 21/21, web coverage 8/8, api+web typecheck clean).

**Investigation receipts + the deeper full-removal option:** `tasks/ASSET-FILTER-PERM-CONSOLIDATION-PLAN.md`
(complete consumer map of the 3 asset-write perms; the only sole-gate is the FE-unused
`PATCH /instances/:id/status`). Full removal was scoped but deferred — it would change MAINTENANCE/SUPERVISOR
effective access and need a role-translation decision + live-DB migration.

## [Unreleased] — Sidebar RBAC — Phase 5D + 5E (admin tree UI + single-source consolidation) (2026-06-30)

**5D — Roles & Access permissions picker → Sidebar/Page/Action tree.** Replaced the flat
category checkbox list in `roles-components/permissions-tab.tsx` with a hierarchical tree built
from `PERMISSION_TREE`: per-sidebar-group Enable All / Disable All, page sub-headers, and a
`🔒 re-auth` badge on actions that carry a step-up `reauthAction` (cross-linking the two axes).
A pure `permission-tree-grouping.ts` helper + coverage test prove **all 98 FEATURE_PRIVILEGES ids
are covered** (no togglable permission dropped). Load/save contract unchanged (`{featureId:bool}`
→ `PUT /api/config/roles/:name`).

**5E — Retire the hand-maintained legacy maps (the single-source consolidation).** `FEATURE_PRIVILEGES`,
`FEATURE_PRIVILEGE_CATEGORIES`, `FEATURE_TO_PERMISSION_MAP`, and `SIDEBAR_PRIVILEGE_MAP` are now
**derived from `PERMISSION_TREE`** (via a `configurable: true` flag on exactly the 98 role-configurable
nodes); the hand-authored originals are deleted. Gated by a **frozen-snapshot invariant**
(`__snapshots__/legacy-maps-snapshot.ts` + `legacy-maps-derived.test.ts`) proving the derived values
EXACTLY equal the former originals — zero behavior change to the CFR backend role-expansion
(`config.service.ts`) or anything else. No circular dependency (`permission-tree.ts` value-imports
nothing from the legacy files; type-only imports erased at runtime). Resolves Phase-1 finding I1
(double-maintenance). Verified: shared build clean, 29 tree/snapshot tests + 330 shared tests pass
(1 pre-existing unrelated `assets.test.ts` failure), api + web tsc clean.

**Phase 5 complete:** the `PERMISSION_TREE` catalog is now the single source of truth driving sidebar
visibility (5B), button gating via `useCan()` (5C), the Roles & Access admin UI (5D), and the derived
legacy maps (5E). **Runtime curl 403/200 verification still owed** across Phases 2/3/5C.

## [Unreleased] — Sidebar RBAC — Phase 5B + 5C (catalog drives sidebar + buttons) (2026-06-30)

**5B — Sidebar reads the tree.** `sidebar.tsx` visibility now resolves from `PERMISSION_TREE`
(`visibilityPrivilegeIds` + `resolveNodePermissions`) via a pure `isSidebarItemVisible()` helper,
replacing the `SIDEBAR_PRIVILEGE_MAP` + `FEATURE_TO_PERMISSION_MAP` lookup. Behavior-identical —
locked by `sidebar-visibility.test.ts` (152 cases: every item × representative role perm sets → new === legacy).

**5C — ~19 pages' button gating → `useCan(<node>)`.** Replaced ad-hoc `isSuperAdmin || perms.includes()`
checks with the centralized `useCan()` hook so each button shows iff the backend allows: Users, Filters,
Notifications, Audit, Approvals, Admin Requests, Stage Approvals, Report Reviews, RFID Track Record,
Deviations, My Tasks, Retirement/Replacement Lists, Cleaning Record, Lifecycle Report, Cleaning Profiles,
Checklists, Equipment Groups, PM Schedules. Mostly behavior-identical; the deliberate **corrections**:
- Previously-ungated buttons now gated (Users Create/Reset-Requests; Stage Approvals + Report Reviews Approve/Reject; My Tasks/Deviations export).
- **Theater fixes:** Cleaning Profiles & Checklists enable/disable toggles now gate on the *real* backend perm (`FCP_UPDATE|*_EDIT`) instead of the no-op `CP_TOGGLE`/`CHECKLIST_TOGGLE`.

**Gate-correctness fixes surfaced during 5C** (in `permission-tree.ts`): export nodes gate on the dedicated
export perm (not page-view, which would loosen); create/edit/delete on filters/cleaning-profiles/checklists/
equipment-groups/pm narrowed to per-action UI intent (not the shared-endpoint union — "keep UI narrow",
user decision mirroring Phase 3); `report_reviews.reject` accepts both REPORT_REVIEW and REPORT_APPROVE.
PM Schedules' review/approve flags intentionally KEEP their workflow-ROLE logic (useCan can't express
"role === configured approver role"). Verification: web `tsc` clean; 166 web RBAC tests (use-can/sidebar-visibility/
route-guard) + 21 tree tests pass. **Runtime curl 403/200 verification still owed.** Plan: `docs/superpowers/plans/2026-06-30-rbac-sidebar-phase-5.md`.

## [Unreleased] — Sidebar RBAC — Phase 5A (gate field + useCan hook) (2026-06-30)

Extended the `PERMISSION_TREE` catalog and added the `useCan()` authorization hook (additive, no page wiring):
- **`PermissionNode.gate: Permission[]`** — discriminating backend permission set added to every node (91+ nodes populated). Differs from `permissions[]` (grant-expansion). Conventions: `requirePermission('X')` → `gate:['X']`; `requireAnyPermission('A','B')` → `gate:['A','B']`; `requireSuperAdmin()` / SA-only → `gate:[]`; role-gated → `gate:[]`+`gateRoles:['ADMIN']`; cosmetic → gate=page VIEW perm. Phase-3 delta overrides applied: `users.delete`/`pm.delete`/`notifications.delete`/`audit.redact`/`audit.verify_chain` → `gate:[]`; role-config endpoints → `gate:['ROLE_MANAGE']`; `filters.status_update` → `gate:['FILTER_STATUS_UPDATE']`; `report_reviews.view` → `gate:['REPORT_REVIEW_SUBMIT','REPORT_REVIEW','REPORT_APPROVE']`.
- **`PermissionNode.gateRoles?: string[]`** — role-level bypass list (only `system_health.view` → `['ADMIN']` currently).
- **`resolveNodeGate(nodeId)`** / **`resolveNodeGateRoles(nodeId)`** — new helpers exported from `@digilog/shared`. Both return `[]` for unknown ids.
- **`useCan()`** (`apps/web/src/hooks/use-can.ts`) — returns a stable `(nodeId) => boolean` callback. Decision: SA bypass → gateRoles bypass → empty gate = deny → OR over gate vs user perms. Corrects the Phase-1 regression where using `permissions[]` (grant-expansion) would have incorrectly authorized read-only users for destructive actions.
- **TDD**: 7 gate tests in `permission-tree.test.ts` confirmed failing before implementation, all pass after. 13 `use-can` tests confirmed module-not-found before implementation, all pass after. Total: 333 shared tests pass (1 pre-existing `assets.test.ts` failure unrelated).
- No page wiring — additive only (Phases 5B–5E will wire pages).

## [Unreleased] — Sidebar RBAC — Phase 3 (fix FE/BE mismatches) (2026-06-30)

Aligned backend authorization gates to the stricter UI intent (user decision: more-restrictive wins), closing API bypasses where a hidden button was still reachable by direct API. Analysis §3.2 (M1–M6):
- **M1** — `PATCH /api/assets/instances/:id/lifecycle-state` now requires `FILTER_STATUS_UPDATE` (was `ASSET_UPDATE`) — the permission the UI gates the Status-Update button on. Closes the `ASSET_UPDATE`-only API bypass (e.g. MAINTENANCE).
- **M2** — `POST /api/filters/:id/{retire,replace}` now require `FILTER_RETIRE`/`FILTER_REPLACE` (dropped the `FILTER_OPERATE` fallback) — operate-only roles can no longer retire/replace via API.
- **M3/M4/M5** — `DELETE` (+ bulk) for users / PM schedules / notifications now require **`requireSuperAdmin()`** (were `USER_DELETE`/`PM_DELETE`/`NOTIFICATION_DELETE`), matching the SUPER_ADMIN-only UI. Supersedes the Phase 2 S5 `NOTIFICATION_DELETE` gate.
- **M6** — `PUT /api/config/{roles/:name,users/:userId,action-reauth}` now require `ROLE_MANAGE` (were `CONFIG_UPDATE`) — closes a privilege-escalation surface (a `CONFIG_UPDATE`-only role could edit role permissions / sidebar / reauth policy). FE surfaces already sit behind ROLE_MANAGE/SUPER_ADMIN route guards.
- **Seed honesty** — removed the now-vestigial `USER_DELETE`/`PM_DELETE`/`NOTIFICATION_DELETE` from ADMIN in `apps/api/prisma/default-roles.ts` (SUPER_ADMIN keeps them; it bypasses regardless). CFR invariant test still 7/7.

Independent review: **0 test regressions** (every test hitting the changed endpoints uses a SUPER_ADMIN token, which bypasses), legitimate access preserved (changes only remove API-only bypass from roles that never had the UI button). **Runtime curl 403/200 verification owed** (no low-priv creds; dev server live). Plan: `docs/superpowers/plans/2026-06-30-rbac-sidebar-phase-3.md`.

## [Unreleased] — Sidebar RBAC — Phase 2 (close security gaps) (2026-06-30)

Closed the genuine, safe authorization gaps from the analysis (`tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md` §3.1):
- **S1** — config card visibility (`canAccessModule`) flipped from fail-OPEN to **default-DENY**: an unconfigured config module is now hidden from non-SUPER_ADMIN instead of visible to all. Predicate extracted to a pure, unit-tested `apps/web/src/routes/config/can-access-module.ts` (7 tests). Paired with an `access-matrix` **seed** (create-only) granting ADMIN the 4 general config cards, so a fresh install does not lock ADMIN out (`apps/api/prisma/seed.ts`).
- **S4** — `GET /api/report-reviews/{queue,/,:id}` now require `REPORT_REVIEW_SUBMIT | REPORT_REVIEW | REPORT_APPROVE` (previously any authenticated user could read the review queue/snapshots by URL). Matches the page route guard.
- **S5** — `DELETE /api/notifications/:id` now requires `NOTIFICATION_DELETE`, matching bulk-delete (was reauth-only; a user blocked from bulk could delete one-by-one). UI already restricted delete to admins.
- **S2-help** — `GET /api/help` + `/api/help/:key` now require `CONFIG_READ` (only the SUPER_ADMIN help-manager page consumes them).

**Reclassified as intentional (NOT gaps), verified 2026-06-30** — left untouched: `GET /api/config/branding` + `GET /api/roles/active` (truly public for login theming / pre-auth contact-admin), Dashboard `/` (all-authenticated landing + catch-all), `/quality-notifications` (already 403s server-side via `canSeeQnn`), tablet `my-features`/`my-modules` (self-scoped, consumed at login gate). Export `useExportOptions` fail-open is a UI affordance, not a security control.

**Discovered (logged, not fixed)** — the standalone `/checklist/:entityId` page (`routes/checklist-form/`) submits to `POST /api/data/checklist`, deleted in the Phase 7 ingestion tear-out → silently broken at submit. Orphaned (no inbound links; QR-code entry module also deleted). Separate from the live cleaning-profile/in-cycle checklist flow (`/api/filters/:id/submit-checklist`), which is unaffected. Logged in `tasks/todo.md` for a future decision (remove vs. rebuild standalone checklists on a relational table). Task 2.3 (route guard on that page) is therefore moot.

Out of scope (later phases): FE/BE permission mismatches M1–M6 (Phase 3), per-page View granularity (Phase 4), the tree-driven admin UI + `useCan()` (Phase 5). Plan: `docs/superpowers/plans/2026-06-30-rbac-sidebar-phase-2.md`.

## [Unreleased] — Sidebar RBAC — Phase 1 (catalog foundation) (2026-06-30)

Added a single `PERMISSION_TREE` catalog (`packages/shared/src/types/permission-tree.ts`) that anchors every sidebar group → page → action in one place. Pure derive functions (`deriveFeaturePrivileges`, `deriveFeatureToPermissionMap`, `deriveSidebarPrivilegeMap`) reproduce `FEATURE_PRIVILEGES`, `FEATURE_TO_PERMISSION_MAP`, and `SIDEBAR_PRIVILEGE_MAP` exactly; parity is locked by `permission-tree.test.ts` (11 tests). A CFR invariant test (`apps/api/src/__tests__/role-effective-permissions.test.ts`, 7 tests) proves every seed role's effective permissions are bit-identical before and after the catalog is introduced. Reconciled the `roles.ts` ↔ `seed.ts` hierarchy mismatch; extracted `defaultRoles` to a pure `apps/api/prisma/default-roles.ts` helper. Added a route-guard coverage lock (`apps/web/src/__tests__/route-guard-coverage.test.ts`, 1 test) documenting 2 open routes for Phase 2. Zero behavior change — the uppercase `PERMISSIONS` vocabulary stays the enforced runtime contract. `useCan()` hook deferred to Phase 5. References: `tasks/RBAC-SIDEBAR-REDESIGN-ANALYSIS.md` + `docs/superpowers/plans/2026-06-30-rbac-sidebar-phase-1.md`.

## [Unreleased] — Combine filter configs into one "Filter Setup" page (2026-06-29)

Merged **Cleaning Profile Assignment**, **Filter Cleaning Reasons**, and **Filter Field Options** into one **Filter Setup** page (`/config/filter-setup`, SUPER_ADMIN) with three tabs (Profile Assignment / Cleaning Reasons / Field Options) — same pattern as the other consolidations. Each tab keeps its own config/endpoint + Save; the three page components were converted to header-less panels (and their now-unused `useNavigate` back-buttons removed). Config index: three cards → one "Filter Setup" card. Routes `/config/cleaning-profile-assignment`, `/config/filter-cleaning-reasons`, `/config/filter-field-options` removed; `/config/filter-setup` added. `filter-cleaning-reasons` + `filter-field-options` (hasCustomPage:false defs) added to `roleAssignmentKeys` so they don't auto-appear as "Additional Modules" cards now that their standalone cards are gone. **Access:** Cleaning Profile Assignment previously had a broad guard (CONFIG_READ/FP_READ/FP_ASSIGN/VERSION_HISTORY_VIEW); the combined page is SUPER_ADMIN-only (chosen). Defs/endpoints retained.

**Verification**: web `tsc` clean; `vite build` clean; dist rebuilt. Browser: all three tabs render; `/config` shows one Filter Setup card (old three gone, no Additional Modules leak); no console errors.

## [Unreleased] — Display Settings: prune stale field IDs + surface hidden audit templates (2026-06-29)

Currency audit of the three Display Settings tabs:
- **Field IDs** — removed **14 stale rows** for torn-out subsystems: **Alarms ×11** (orphaned from an old seed — already absent from `seed.ts`) and **Telemetry ×3** (still in `seed.ts`). Dropped Telemetry from `prisma/seed.ts` and deleted both modules' rows from the live DB (`field_id_config`). The tab now lists 12 modules / 64 fields (was 78).
- **Audit Text** — fixed 2 *current* templates being invisible: `ASSET_IDENTIFIER_CREATED` / `ASSET_IDENTIFIER_DELETED` use category `'Filter Management'`, which was missing from `AUDIT_TEMPLATE_CATEGORIES` (the page iterates that list). Added the category; shared rebuilt. The `ALARM_*` templates are intentionally retained (21 CFR — render historic audit rows), so they stay.
- **Pagination** — already current (numeric settings); no change.

**Verification**: shared rebuilt; api + web `tsc` clean; `vite build` clean. Browser: Field IDs shows 64 fields with no Alarms/Telemetry; Audit Text now shows the Filter Management category with the Identifier templates; no console errors. `packages/shared/CLAUDE.md` field-id count synced (78→64).

## [Unreleased] — Combine Field IDs + Audit Text + Pagination into "Display Settings" (2026-06-29)

Merged **Field ID Names**, **Audit Text Templates**, and **Pagination Settings** into one **Display Settings** page (`/config/display-settings`, SUPER_ADMIN) with three tabs (Field IDs / Audit Text / Pagination) — same pattern as the other consolidations. Each tab keeps its own config key (`field-ids` / `audit-templates` / `pagination`) + Save; the three page components were converted to header-less panels. Config index: three cards → one "Display Settings" card. Routes `/config/field-ids`, `/config/audit-templates`, `/config/pagination` removed; `/config/display-settings` added. **Access:** Field IDs previously used `FIELD_ID_UPDATE`; the combined page is SUPER_ADMIN-only (chosen) — a non-SA FIELD_ID_UPDATE role loses the Field IDs UI (its card was already SA-section-only). Defs/endpoints retained.

**Verification**: web `tsc` clean (removed now-unused `Link`/`useNavigate` imports); `vite build` clean; dist rebuilt. Browser: all three tabs render; `/config` shows one Display Settings card (old three gone); no console errors.

## [Unreleased] — Branding: raise logo size limit to 2MB (2026-06-29)

A 571KB logo couldn't be uploaded because of two size caps (both below it):
- **Client**: `handleLogoUpload` rejected files > 500KB → raised to **2MB** (`branding.tsx`); helper text updated (`logo-upload-section.tsx`).
- **Schema**: `brandingConfigSchema.logoUrl` was `z.string().max(500000)` chars — a 571KB image as base64 is ~780k chars, so the save was rejected by validation (client form + server). Raised to **3,000,000** chars (≈ a 2MB base64 image) in `packages/shared/src/schemas/config.ts`; shared package rebuilt.

Backend `bodyLimit` is already 10MB, so no server-limit change needed. **Requires an API restart** to load the recompiled shared schema (zod schema is bound at startup).

**Verification**: api + web `tsc` clean; `vite build` clean; dist + shared rebuilt. Unit-checked the rebuilt schema: a ~571KB-image base64 (780k chars) now validates, while >3M chars is still rejected.

## [Unreleased] — Combine Branding + Dashboard Cards; fix logo-upload Save gating (2026-06-29)

**Combine** — merged Branding and Dashboard Cards into one **Branding & Dashboard** page (`/config/appearance`, SUPER_ADMIN) with two tabs (Branding / Dashboard Cards), same pattern as Report Configuration: each tab keeps its own config key (`branding` / `dashboard-cards`) + Save; the two page components were converted to header-less panels. Config index: the two cards → one "Branding & Dashboard" card. Routes `/config/branding` + `/config/dashboard-cards` removed; `/config/appearance` added. **Access:** Dashboard Cards previously allowed ADMIN; the combined page is SUPER_ADMIN-only (Branding's level) — ADMIN can no longer edit dashboard cards (chosen). The `branding` def/endpoints retained.

**Bug fix — logo upload couldn't be saved.** In the Branding editor, `handleLogoUpload`/`handleRemoveLogo` called `setValue('logoUrl', …)` without `{ shouldDirty: true }`, but Save is `disabled={!isDirty || isSubmitting}`. So picking a logo updated the preview but never enabled Save → the upload couldn't be persisted. Added `shouldDirty: true` to both calls (pre-existing bug, not caused by the combine).

**Verification**: web `tsc` clean; `vite build` clean; dist rebuilt. Browser: both tabs render with working Save; `/config` shows one Branding & Dashboard card; uploading a test logo now enables Save and shows the preview (not saved over real branding). No console errors.

## [Unreleased] — Report Configuration: add Export tab (2026-06-29)

Added **Export Options** as a fourth tab on the combined Report Configuration page (Identity / Labels / Signatories / **Export**). The Export tab is the existing role × page → PDF/Excel matrix (`export-options` key, converted to a panel). Removed its standalone config card + `/config/export-options` route. **Access:** export-options' SUPER_ADMIN-only restriction lived only at the route level (its endpoints are CONFIG_READ/UPDATE), so the combined `/config/report-config` route was bumped to **SUPER_ADMIN** to preserve that (and to match the card's Super Admin Settings placement). The `export-options` def/endpoints are retained.

**Verification**: web `tsc` clean; `vite build` clean; dist rebuilt. Browser: Report Configuration shows four tabs; Export tab renders the PDF/Excel matrix; `/config` no longer shows a standalone Export Options card; no console errors.

## [Unreleased] — Combine the three report configs into one "Report Configuration" page (2026-06-29)

Merged **Report Page Titles**, **Report Labels**, and **Report Signatories** into a single **Report Configuration** page (`/config/report-config`) with three tabs — **Identity** / **Labels** / **Signatories** — mirroring the Role Assignments consolidation. Backend unchanged: each tab still reads/writes its own config key (`report-page-titles` / `report-labels` / `report-signatories`) and keeps its own Save (no data migration). The three page components were converted to header-less panels (slim toolbar + Save) hosted by the new tabbed shell (`routes/config/report-config.tsx`).

- `config/index.tsx`: the three cards are replaced by one **Report Configuration** card.
- `main.tsx`: removed `/config/report-page-titles`, `/config/report-labels`, `/config/report-signatories`; added `/config/report-config`.
- The three defs/endpoints are retained (they back the tabs). Their cards are gone; `customPagePath` is now vestigial (never navigated — `hasCustomPage:true` excludes them from auto-cards). Access matrix still lists the three storage keys (left as-is per scope).

**Verification**: web `tsc` clean; `vite build` clean; dist rebuilt. Browser: `/config/report-config` shows all three tabs, each rendering its editor + Save; `/config` shows a single Report Configuration card (old three gone); no console errors.

## [Unreleased] — RFID Track Record: hide the report footer (2026-06-29)

On the RFID Track Record view the report footer (identity line + "X records / Page X of Y") sat below the page's own pagination ("Showing 1–50 of 427 … Page 1/9") and was unwanted. Added two opt-in props to `ReportPageWrapper`: `hideFooterStats` (drop just the count/page row, keep the identity line) and `hideFooter` (drop the whole footer). RFID Track Record now uses `hideFooter` — no footer below the pagination; the report header (logo + company + application name + title) is unchanged. All other reports (Audit, Filter Traceability, QNN) keep the full footer (both props default false).

**Verification**: web `tsc` clean; `vite build` clean; dist rebuilt. Browser: RFID Track Record shows no identity/count/page footer below the pagination (header identity intact); Audit footer unchanged. No console errors.

## [Unreleased] — PDF reports: fix doubled identity + use configurable Report identity (2026-06-29)

The PDF report header printed `appName + " - Digital Filter Management System"` (a hardcoded suffix in `apps/web/src/lib/pdf-report.ts`), so with `appName = "Filter Management System"` it read "Filter Management System - Digital Filter Management System". Removed the hardcoded suffix — the header now shows just the application name. Also made the PDF identity **configurable** like the on-screen report: `loadBranding()` now layers the **Report Page Titles** company/app overrides on top of Branding (override → Branding), so PDF header (Company name / Application name) and footer (`Company | Application`) match the on-screen report.

**Verification**: web `tsc` clean; `vite build` clean; dist rebuilt. (PDF content isn't browser-inspectable via the harness; change is a localized header-string + identity-source fix, typecheck-verified.)

## [Unreleased] — Report Page Titles: remove the configurable common labels (2026-06-29)

Removed the "Common labels" section (the configurable **performed-by prefix / record-count word / pagination label**) from Report Page Titles. Those three now use fixed defaults in `ReportPageWrapper` (`By:`, `records`, `Page X of Y`). The page is now solely the **Report identity** (company name + application name overrides → Branding fallback). Trimmed `use-report-page-titles.ts` (dropped the labels interface/defaults), updated the def/card/CLAUDE.md descriptions.

**Verification**: web `tsc` clean; `vite build` clean; dist rebuilt. Browser: config page shows only Report identity (no Common labels); Audit report still renders By/records/Page + the company·application identity line in header & footer; no console errors.

## [Unreleased] — Report header/footer identity (logo + company + app name) (2026-06-29)

Added the **logo, company name, and application name** to both the report header **and** footer (`ReportPageWrapper`), configurable via **Report Page Titles**:
- Header now shows: logo · company name · **application name** (new) · report title · performed-by.
- Footer now carries a matching identity line: logo · company name · application name, above the record-count / pagination row.
- Two new override fields on the Report Page Titles config page — **Company name** and **Application name** — stored on the `report-page-titles` config. Blank falls back to the global **Branding** value (shown as the field placeholder), so reports match the app by default but can be overridden per the report surface. The logo always comes from Branding.

`use-report-page-titles.ts` resolves `companyName`/`appName` (override → Branding). No backend change (the config PUT already accepts an open object). 

**Verification**: web `tsc` clean; `vite build` clean; dist rebuilt. Browser: config page shows the Report identity fields with Branding placeholders; the Audit report header renders company + application name, and the footer renders the matching "Company · Application" identity line. No console errors. (No overrides saved — reports show Branding values by default.)

## [Unreleased] — Replace Report Settings with Report Page Titles (2026-06-29)

Removed the **Report Settings** config (show/hide toggles + custom header/footer text + records-per-page + compact mode) and replaced it with **Report Page Titles** — a focused config for the labels that are common to *every* report's on-screen page view (rendered by `ReportPageWrapper`). Report-specific titles stay in **Report Labels**; PDF exports are unaffected.

**New config `report-page-titles`** (category *display*, `requiredRole: null`): three editable labels —
- `performedByLabel` (header prefix before the viewer's name, default `By:`),
- `recordsLabel` (footer word after the record count, default `records`),
- `pageLabel` (footer word before the page number in "Page X of Y", default `Page`).

Blank = built-in default. Backend: `report-page-titles.def.ts` (`hasCustomPage:true`) + `static-routes/report-page-titles.routes.ts` — `GET /report-page-titles/current` (all authenticated users, so report viewers get the labels), `GET` (CONFIG_READ) + `PUT` (CONFIG_UPDATE, audited as `CONFIG_CHANGED`). Frontend: `routes/config/report-page-titles.tsx` (3 fields with live previews) + `hooks/use-report-page-titles.ts`; the config card replaces the Report Settings card.

**Behavior changes from the removal**:
- `ReportPageWrapper` now **always** renders the header + footer (the per-part show/hide toggles, custom header/footer text, and compact mode are gone).
- The three report pages that defaulted their page size from `report-settings.recordsPerPage` (Audit, Cleaning Record history, Filter Traceability) now take it from **Pagination Settings** (`usePaginationDefaults().defaultLimit`).

Deleted: `report-settings.def.ts`, `report-settings.routes.ts`, the `/report-settings/current` GET in `config/routes.ts`, `routes/config/report-settings.tsx`, `hooks/use-report-config.ts`, and the main.tsx route/import. The `phase4-perms-themes-reports` e2e was repointed to the new config. Config-def count unchanged (−1/+1 = 34).

**Verification**: API + web `tsc` clean; `vite build` clean; dist rebuilt. Live: `/report-page-titles/current` → 200, `/report-settings/current` → 404, manifest swapped. Browser: config page renders with previews; Audit report chrome shows By/records/Page; edited "records"→"entries" propagated to the report, then reverted to default (net-zero). No console errors.

## [Unreleased] — Configuration Access: make Filter Data Management grantable (2026-06-29)

Filter Data Management is a hardcoded config page (no config def), so it never appeared in the Configuration Access matrix, and its card sat in the SUPER_ADMIN-only section — so it couldn't be delegated. Made it grantable per-role **while keeping the card in the Super Admin Settings section**:
- **`access-matrix.tsx`**: added an `EXTRA_MODULES` list (injected as synthetic matrix rows for hardcoded pages with no def) containing Filter Data Management, so it now shows under the *filter-management* category with a checkbox per role. The backend `PUT /api/config/access-matrix` already accepts arbitrary module keys (`additionalProperties` schema), so the grant persists with no backend change.
- **`config/index.tsx`**: Filter Data Management **stays in the Super Admin Settings block** (not moved to the general section). Added `EXPLICIT_GRANT_KEYS` + a `visibleSuperAdminCards` filter so the Super Admin section renders for SUPER_ADMIN (all cards) and for any non-admin role that has been explicitly granted a delegable card — showing **only** that card (e.g. Filter Data Management), never the other SA-only cards (Branding / Roles / Backup / etc.). Fail-closed: a non-admin sees it only when explicitly granted (it edits/deletes filter records with no audit trail). SUPER_ADMIN always retains access; the route still requires `CONFIG_READ`/`CONFIG_UPDATE` (defense in depth).

**Verification**: `tsc --noEmit` clean; `vite build` clean; dist rebuilt. Browser-verified: the matrix lists Filter Data Management; on `/config` the card renders once, in the Super Admin Settings section (not the general section), for SUPER_ADMIN; no console errors.

## [Unreleased] — Configuration Access: hide consolidated modules + fix key warning (2026-06-29)

The Configuration Access matrix (`apps/web/src/routes/config/access-matrix.tsx`) still listed the seven modules that were folded into Role Assignments (pm/replacement workflow, QNN, guest requests, cross-block, stage interlock, pm settings). They have no standalone page and are SUPER_ADMIN-only, so a per-role access grant for them did nothing — dead, misleading rows. Added `HIDDEN_MODULE_KEYS` (kept in sync with `roleAssignmentKeys` in `config/index.tsx`) to exclude them from the matrix. Also fixed a pre-existing React "unique key" console warning — the per-category row group used a keyless `<>` fragment; switched to `<Fragment key={category}>`.

**Verification**: `tsc --noEmit` clean; `vite build` clean; dist rebuilt. Browser-verified: the seven modules no longer appear; legitimate modules (Branding, Report Settings, Schedule AHU Filters, …) remain grouped by category; console is clean (key warning gone).

## [Unreleased] — Admin Requests: UI refresh + accurate status counts (2026-06-29)

Reworked the Admin Requests screen (`apps/web/src/routes/admin-requests/index.tsx`) from a flat table into a more finished console:
- **Stat / filter cards** (All / Pending / Approved / Rejected) with icons and colored accents replace the plain status pills; clicking a card filters, the active one gets a ring highlight.
- **Search box** (requester name / employee ID), debounce-free client filter with a clear button.
- **Richer rows**: requester initial **avatar**, type **icon chip**, and a Review/View affordance with a chevron (label reads "Review" for actionable pending rows).
- Better empty state — distinguishes "no requests yet" from "no matches" (with a Clear filters action).

**Bug fixed along the way**: the status counts were computed from the server response that was *already* filtered by `?status=`, so selecting a filter zeroed the other buckets. The page now fetches the full list once and filters + counts client-side, so the card counts are always correct. Detail slide-over, re-auth, and the approval-credentials dialog are unchanged.

**Verification**: `tsc --noEmit` clean; `vite build` clean; dist rebuilt. Browser-verified: cards show 7/3/4/0 and stay correct under filtering; Pending filter shows 3 rows; search + slide-over still work; no console errors.

## [Unreleased] — Version History: visual pipeline flow for cleaning-profile compare (2026-06-29)

Replaced the cleaning-profile before/after **tables** with the actual **pipeline flow graph** — the same node-graph the editor shows (START → stages → END with CHECKLIST branches). New read-only `ProfileFlow` SVG renderer in `apps/web/src/routes/version-history/index.tsx` draws the stored node positions + connections with the editor's colors (green START, blue STAGE, purple CHECKLIST, red END) and bezier wiring, scaled to fit via `viewBox`. "Compare with v(n-1)" now shows **Before · v{prev}** and **After · v{curr}** flow graphs side by side (with status + node count). The single-version snapshot view also gained a "Pipeline flow" panel above its detail tables. Stage labels come from the state key (WASH IN, DRY OUT…); checklist nodes show their profile name.

**Verification**: `tsc` clean; `vite build` clean; dist rebuilt. Browser-verified on CWH v12→v13 — Before renders 6 nodes (no checklist), After renders 7 (adds a purple Checklist node), each as a proper connected flow graph instead of text.

## [Unreleased] — Version History: before/after view for cleaning profiles (2026-06-29)

Cleaning-profile version comparison showed every stage/connection as both **Removed** (old id) and **Added** (new id) — because the cleaning-profile editor regenerates all node/connection ids on each save, so the id-keyed field diff is pure noise (the same WASH_IN appears on both sides). Replaced the field-level diff *for cleaning profiles only* with a **before/after view**: "Compare with v(n-1)" now renders the full structured snapshot of both versions side by side (Before · v{prev} | After · v{curr}, stacks on narrow screens) via the existing `CleaningProfileSnapshot` viewer. Checklist profiles and equipment groups keep the humanized field-level diff (their ids are stable). New `VersionCompare` component in `apps/web/src/routes/version-history/index.tsx`.

**Verification**: `tsc` clean; `vite build` clean; dist rebuilt. Browser-verified on CWH v12→v13 — the comparison now shows the whole profile before (6 stages, ARCHIVED) and after (7 stages, ACTIVE) instead of 25+ add/remove lines.

## [Unreleased] — Version History: label structural pipeline nodes in diffs (2026-06-29)

Follow-up to the diff humanization: cleaning-profile diffs showed raw 8-char ids (e.g. `Stages "bde2f506"`) for the pipeline's **START / END / CHECKLIST** nodes, because `labelFor()` only knew `name` / `stateKey` / etc. — and those structural nodes carry none (only real STAGE nodes have a `stateKey` like `WASH_IN`). Added a `nodeType` fallback so they now render as **"Start" / "End" / "Checklist"** before the last-resort id slice. Real stages are unchanged (still show their state key). Connections remain id-labelled (they're edges with only from/to ids — no natural name).

**Verification**: `tsc` clean; diff suite 8/8; `vite build` clean; dist rebuilt. Browser-verified on the CWH v12→v13 diff — "Stages Start / End / Checklist" now read clearly instead of UUIDs.

## [Unreleased] — Version History: drop Filter Profiles tab + human-readable diffs (2026-06-29)

**Removed the "Filter Profiles" tab.** `FilterProfile` has a server-side version sidecar but **no user-facing page** (no route in `main.tsx`, no sidebar item, no `filter-profile-list.tsx`), so the tab pointed at an entity users can't create or manage. Removed `filter-profile` from the `EntityKind` union, the `TABS`/`ENTITY_KINDS` lists, the endpoint switches, `SnapshotBody`, and deleted the `FilterProfileSnapshot` component (`apps/web/src/routes/version-history/index.tsx`). The `FilterProfile` model + `/api/filter-profiles/:id/versions` endpoints are untouched — only the UI tab is gone. The set-style diff branch (`SET_FIELDS`) was filter-profile's only consumer, so it and its two unit tests were removed too.

**Human-readable version diffs.** The compare-versions view previously printed raw field paths and quoted/JSON values (e.g. `alarmOnForwardSkip: "STRICT" → "LENIENT"`). Now:
- Field paths are humanized — `stages[Wash In].stateKey` → **Stages "Wash In" › State key**; camelCase → sentence case, with a small label map for awkward fields.
- Values are formatted for people — booleans → **Yes/No**, null/empty → **(none)**, ISO timestamps → locale date, arrays → comma list (object items by name/label/key), no more quotes/JSON noise.
- Each change shows a clear **Changed / Added / Removed** tag, with the old value muted and the new value emphasized (removed values struck through).

**Verification**: web `tsc --noEmit` clean; the diff unit suite passes (8/8); `vite build` clean; dist rebuilt; `apps/web/CLAUDE.md` B7.1 note synced. Browser-verified: Version History shows only Cleaning Profiles / Checklist Profiles / Equipment Groups; a real v12→v13 diff renders human-readably (e.g. "Changed · Status · ARCHIVED → ACTIVE").

## [Unreleased] — Role Assignments: add PM Schedule Settings section (2026-06-29)

Added a **PM Schedule Settings** section to the Role Assignments page (`apps/web/src/routes/config/role-assignments.tsx`), editing the `pm-schedule-settings` config. An enable switch (master PM on/off); when on, it reveals **default tolerance (days)**, **task visibility** (Everyone / Per-user* / Role-gated* — the latter two flagged not-yet-implemented), **show overdue separately**, and **overdue notification roles** (chips). Renders full-width below Cleaning Stage Interlock.

Per the established pattern, the standalone "PM Schedule Settings" card was removed from `config/index.tsx` and `pm-schedule-settings` added to `roleAssignmentKeys`; the def + dynamic endpoint are retained (Role Assignments reads/writes them). Note: unlike the other Role-Assignments sections this config is mostly *operational* (tolerance/visibility/enable), not purely role-based — moved wholesale at the user's request so PM config lives in one place.

**Verification**: web `tsc --noEmit` clean; `vite build` clean; dist rebuilt. Browser-verified: all seven Role Assignments sections render; the PM card loads its stored values (enabled on, tolerance 3, visibility GLOBAL, show-overdue on) and the enable toggle reveals/hides the detail fields; `/config` no longer shows a standalone PM Schedule Settings card. No console errors.

## [Unreleased] — Role Assignments: Save All only writes changed sections (audit-noise fix) (2026-06-29)

**Bug — Save All audit noise.** The Role Assignments page PUT *every* config key on each save, and the dynamic config PUT writes a `CONFIG_CHANGED` audit row unconditionally — so one click logged up to six audit entries (one per section) even when only one section changed, polluting the 21 CFR audit trail with false "changed" records.

- **Fix** (`apps/web/src/routes/config/role-assignments.tsx`): the page now keeps a `baseline` snapshot of the loaded config and, on save, PUTs **only** the sections whose value actually differs (stable, key-order-insensitive JSON diff via `jsonEqual`). The `dirty` flag is now *derived* from that diff (replacing the sticky boolean), so Save All is disabled unless there's a real change, and toggling a value back to its original disables it again. After a successful save the baseline advances for just the saved keys. Toast reports how many sections were written ("1 section updated").
- **Verification**: web `tsc --noEmit` clean; `vite build` clean; dist rebuilt. Browser-verified via the network panel: changing one section (QNN) and saving issued exactly **one** PUT (`/api/config/dynamic/qnn-notifications`), not six; Save All disabled itself after the save. Test change reverted + re-saved (again a single PUT) — confirmed the stored config returned to its original value.

## [Unreleased] — Role Assignments: add Cleaning Stage Interlock section (2026-06-29)

Added a **Cleaning Stage Interlock** section to the Role Assignments page (`apps/web/src/routes/config/role-assignments.tsx`), editing the `stage-interlock` config. An enable switch; when on, it reveals **Wash Out approver**, **Dry Out approver** (role selects, blank = "Super Admin only"), and a **Require different approver** toggle (segregation of duties, recommended for 21 CFR Part 11). Renders full-width below the Cross-Block Cleaning section.

Consistent with the prior consolidations, the standalone "Cleaning Stage Interlock" card was removed from `config/index.tsx` and `stage-interlock` added to `roleAssignmentKeys`; the def + dynamic endpoint are retained (Role Assignments reads/writes them). Stage Interlock is now edited in exactly one place.

**Verification**: web `tsc --noEmit` clean; `vite build` clean; dist rebuilt. Browser-verified: all six Role Assignments sections render; the interlock card loads its stored values (enabled on, both approvers = "shift officer", different-approver on) and the enable toggle reveals/hides the approver fields; `/config` no longer shows a standalone Cleaning Stage Interlock card. No console errors.

## [Unreleased] — Role Assignments: add Cross-Block Cleaning section (2026-06-29)

Added a **Cross-Block Cleaning** section to the Role Assignments page (`apps/web/src/routes/config/role-assignments.tsx`) — the page's own card already advertised "block-change" but the section was never built. It edits the `block-change-approval` config: a segmented **mode** control (No restriction / Self-confirm / Needs approval) and, when mode is *Needs approval*, the **approval role**, **auto-expire hours**, and **require reason** controls (the latter three only apply to approval requests, so they're hidden otherwise). Renders full-width below the 2×2 grid.

To avoid re-introducing the duplication just fixed, the standalone "Block Change Approval" card was removed from `config/index.tsx` and `block-change-approval` added to `roleAssignmentKeys`. The def + dynamic `/api/config/dynamic/block-change-approval` endpoint are retained (Role Assignments reads/writes them). Block Change Approval is now edited in exactly one place.

**Verification**: web `tsc --noEmit` clean; `vite build` clean; dist rebuilt. Browser-verified: the card loads its stored values (mode, approval role = QA, auto-expire = 24, require reason on), the mode segmented control reveals/hides the approval fields, dirty + Save All gating work (change discarded without saving), and `/config` no longer shows a standalone Block Change Approval / Cross-Block card. No console errors.

## [Unreleased] — Role Assignments: de-duplicate config cards + redesigned screen (2026-06-29)

**Bug — config modules shown twice.** PM Schedule Workflow, Replacement Schedule Workflow, QNN Notifications, and Guest Cleaning Requests each appeared **twice** in System Configuration: once inside the consolidated **Role Assignments** page, and again as standalone cards (PM via a hardcoded "PM Schedule Approval" card; the other three as auto-discovered "Additional Modules"). Root cause: their config defs are intentionally `hasCustomPage:false` so `dynamic-routes.ts` auto-generates the `/api/config/dynamic/<key>` GET/PUT endpoints that Role Assignments reads/writes — but that same flag also makes `config/index.tsx` render them as standalone cards.

- **Fix** (`apps/web/src/routes/config/index.tsx`): added a `roleAssignmentKeys` exclusion set so the four Role-Assignments-owned keys never render as standalone/Additional-Modules cards, and removed the redundant hardcoded "PM Schedule Approval" card. **Defs are intentionally retained** (deleting them or setting `hasCustomPage:true` would drop the dynamic endpoints and break Role Assignments). The "Additional Modules" section now disappears (its only contents were these duplicates); Role Assignments is the single editing surface. Standalone cards unrelated to Role Assignments (Block Change Approval, Stage Interlock, Offline Cache) are untouched.

**Feature — redesigned Role Assignments screen** (`apps/web/src/routes/config/role-assignments.tsx`). Rebuilt the page as a professional **2-up card grid** (PM | Replacement, then QNN | Guest):
- Workflow cards render the upload → review → approve sequence as a **numbered, connected stepper** (the order is meaningful) with a switch for the review/approval toggle. Replacement keeps the existing "inherit from PM" behavior (blank = inherit; toggle shows "(inheriting from PM)").
- Notification cards use **toggle chips** (filled + ✓ when selected) instead of raw checkboxes.
- Added an **"Unsaved changes"** indicator; **Save All** is disabled until something changes. All four config keys + save-all logic preserved exactly.

**Verification**: web `tsc --noEmit` clean; `vite build` clean; dist rebuilt. Browser-verified on the Vite dev server (admin login): all four dynamic endpoints return 200 (Role Assignments still loads/saves), saved roles bind into the steppers + chips, the dirty indicator + Save All gating work (change discarded without saving), and `/config` shows no duplicate cards and no "Additional Modules" section. No console errors on either page.

## [Unreleased] — Cleaning Record: fix stages showing "Pending" under status/reason filters (2026-06-29)

**Bug — filtered Cleaning Record showed every stage cell as "Pending".** On the **Completed** (and any status pill, or Cleaning-Reason) tab, per-stage cells (Wash In/Out, Dry In/Out, Storage In/Out) rendered "Pending" even for cycles whose stages were complete — while the cycle's **status pill** correctly read "Completed" and the **View** page showed all stages done. The per-stage cells are derived client-side from each cycle's `events` (`getStageInfo()` in `apps/web/src/lib/cleaning-cycle-report.ts`); the status pill comes from `c.status`, so they diverged.

Root cause in `getCleaningRecord` (`apps/api/src/modules/filter-operations/filter-operations.service.ts`): the status/reason-filtered branch (`if (query.status || query.cleaningReasonKey)`) called `getCycles(...)` **without** `includeEvents`, so `c.events` was absent → `getStageInfo` returned `null` → every cell fell through to "Pending". The unfiltered "All" path already passed `includeEvents: 'true'`, and `getCycleById` (the View page) always includes events — which is why only the filtered list misbehaved.

- **Fix**: pass `includeEvents: 'true'` in the status/reason branch so it matches the "All" path. One line; also fixes the Cleaning-Reason filter (shares the branch). No other endpoint affected — `GET /api/filters/cycles` keeps its existing contract (events only on `includeEvents`).
- **Verification**: DB confirmed completed cycles carry 4–7 `STATE_TRANSITION` events. `GET /api/filters/cleaning-record?status=COMPLETED` now returns `events` populated (e.g. `L5/AHU26/SAG/05` → `[WASH_IN,WASH_OUT,DRY_IN,DRY_OUT,STORAGE_IN,STORAGE_OUT]`, 12 events) where the array was previously absent. `tsx watch` hot-reloaded the change; verified against the running API.

## [Unreleased] — Cleaning Record: search + block/area/AHU filters; fix Retired/Replaced status pills (2026-06-22)

**Bug — Retired/Replaced (and Terminated) status pills.** The cleaning-record + `/cycles` endpoints' `status` enum was `['IN_PROGRESS','COMPLETED','TERMINATED']`, but the UI pills also send `RETIRED`/`REPLACED` (which are *effective* statuses — a `TERMINATED` cycle whose `terminationReason` is `RETIRED`/`REPLACED`). Those values failed schema validation → **400**. Fix:
- Expanded both `status` enums to include `RETIRED`, `REPLACED`.
- `getCycles` now maps effective status → query: `RETIRED`→`status=TERMINATED AND terminationReason='RETIRED'`; `REPLACED`→`='REPLACED'`; `TERMINATED`→`status=TERMINATED AND (terminationReason IS NULL OR NOT IN ('RETIRED','REPLACED'))` (explicit NULL-OR because SQL `NOT IN` drops NULL rows). Verified against the DB: the pills now return 3 / 11 / 24 / 261 / 23 rows respectively. Note: `TERMINATED` is now stricter — it shows only plain-terminated cycles (retired/replaced live under their own pills), where before it lumped all 38 together.

**Feature — search + hierarchy filters on the Cleaning Record page.** Added a filter-name **Search** box (debounced) and cascading **Block → Area → AHU** dropdowns, all resolved **server-side** (the list is paginated). Backend: new `blockId`/`areaId`/`search` params (+ existing `ahuId`) resolve to a set of descendant FILTER ids via a recursive `asset_instances` walk (`resolveScopeFilterIds`) — handles 2- *and* 3-level hierarchies — intersected with a name `ILIKE` for search, then applied as a single `filterId IN (...)` to **both** the cycle and manual-update branches (the old `ahuId` column filter never scoped manual rows). A specific-filter selection still takes precedence. FE cascades via `/api/hierarchy/{blocks,areas,ahus}`; blocks with no Area level fall back to Block-level filtering (AHU dropdown stays disabled until an area exists).

**Verification**: `tsc --noEmit` clean (API + web); status/scope/search SQL validated directly against the DB; API restarted; dist + APK rebuilt.

## [Unreleased] — Hide "Send for Review" + fix Export menu placement (2026-06-22)

- **Hid "Send for Review" across all report pages.** `SendForReviewButton` (`apps/web/src/components/SendForReviewButton.tsx`) now renders `null` behind a `SEND_FOR_REVIEW_ENABLED = false` flag (workflow code retained for easy re-enable; guard placed after all hooks to respect Rules of Hooks). One change covers all 10 report pages (cleaning record/timeline/lifecycle, PM, audit, deviations, QNN, RFID track record, replacement, filters) and any future page — no per-page edits.
- **Fixed Export-menu placement as a side effect.** Several pages laid the header out as `flex justify-between` with Export + Send-for-Review as bare siblings, which stranded the Export button in the *middle* (three flex children). With the null sibling dropping out of the flex row, Export is now the last child → right-aligned. Pages that already wrapped the two in a sub-div are unaffected.
- **Verification**: web `tsc --noEmit` clean; "Send for Review" text confirmed gone from the built bundle; dist + APK rebuilt.
- **Not touched**: the Report Reviews inbox page + its sidebar item (existing in-flight reviews still need actioning). Say the word to hide those too.

## [Unreleased] — Audit trail: render stage-approval template placeholders (2026-06-22)

Fixed the audit trail showing literal `{stageKey}` / `{filterName}` instead of values on **Stage Approval Approved/Rejected** rows. The renderer `getAuditSummary()` (`apps/web/src/routes/audit/audit-helpers.ts`) substitutes a fixed allow-list of placeholders, and the stage-interlock templates' `{stageKey}`, `{filterName}`, `{rejectToStateKey}` were never added — so they passed through verbatim (while `{actor}` resolved). Added the three substitutions, prettifying the stage keys via `titleCase` (`WASH_OUT` → "Wash Out"). Render-time fix → **existing** audit rows now display correctly too (the data was always stored in `afterValue`). The reports/PDF module doesn't use this renderer, so no parallel gap. dist + APK rebuilt.

## [Unreleased] — Cross-block cleaning: add "None" mode (no restriction) (2026-06-22)

Added a third **Cross-Block Mode** alongside CONFIRM and APPROVAL: **`NONE`** — no cross-block check at all. Any filter can be cleaned in any block with nothing shown or asked (no confirm dialog, no approval request, no "recorded offline" notice). Config stays at `CONFIRM` by default, so existing installs are unchanged.

- **`block-change-approval.def.ts`** — added the `NONE` option to the mode selector (auto-rendered config page).
- **`block-change.service.ts` `getMode()`** — now returns `'NONE' | 'CONFIRM' | 'APPROVAL'`.
- **`filter-resolver.ts`** — both block gates now no-op under `NONE`:
  - `validateBlockChange()` (start-time cross-block gate) returns early.
  - `validateAdvanceBlock()` (mid-cycle "cycle frozen to its starting block" guard, error `BLOCK_MISMATCH`) returns early too. **This closed a gap**: with only the start gate disabled, an operator who selected a different block for a later stage still hit `BLOCK_MISMATCH` mid-cycle even though blocks were meant to be unrestricted. CONFIRM/APPROVAL keep this guard (a cycle can't span blocks).
- **`current-state.ts`** — under `NONE`, a different block is stamped `blockChangeStatus = 'MATCH'` so the FE never prompts (online, and offline via the cached current-state — doesn't depend on the config being cached on-device).
- **`mobile-operations.tsx`** — reads `NONE`; gated the offline-force-prompt (also respects cached `MATCH`) and both passive "recorded offline" notices on `NONE`. Desktop `filter-operations.tsx` needed no change (it only prompts on backend signals, which never fire under `NONE`).
- **Independent of the stage interlock**: with interlock ON, Wash Out / Dry Out still require approval (online) regardless of block mode — they're separate gates. `validateAdvanceBlock` runs before the interlock leave-gate, which is why a block mismatch surfaced first.
- **Verification**: `tsc --noEmit` clean (API + web); config registry loaded clean (34 modules); FE `NONE` logic confirmed in the bundle; APK rebuilt.

## [Unreleased] — Stage interlock: offline exemption fix + bulk approve/reject + docs (2026-06-22)

Hardening + UX pass on the cleaning **stage interlock** (the two-point QA gate after WASH_OUT / DRY_OUT; still **OFF by default**). Full reference: `docs/compliance/stage-interlock.md`.

- **Bulk approve/reject on the Stage Approvals page** (`apps/web/src/routes/stage-approvals/index.tsx`): multi-select pending items + "Approve Selected" / "Reject Selected". One reauth password signs the whole batch, but each item still hits the existing per-item `/approve` / `/reject` endpoint, so every approval keeps its own audit signature, filter event, and operator notification. Partial failures are reported per-filter; stale orphans surface as per-item failures.
- **Offline interlock-stuck fix** (`apps/web/src/routes/mobile/mobile-operations.tsx`, 3 sites): the interlock is online-only (offline cleaning is interlock-exempt — commit `d8afc02`), but the **tablet** was carrying the cached server action tape. When an operator was online at the gate, the server caches a tape with the advance *stripped* (only `TERMINATE_CYCLE` survives); going offline then stranded the operator with no advance. Fix: offline, at an interlock-gated stage, drop the stale stripped tape so `getCurrentActions()` recomputes the interlock-free tape locally. Guarded on `!online` so the live online interlock is untouched. Sites: `buildOfflineState()` + the two `getCurrentActions(...)` calls in `handleSubmitQueue`. The desktop page was already correct (it rebuilds offline state without a tape).
- **Server stale-orphan guard** (`apps/api/src/modules/stage-approvals/service.ts`, `assertFilterStillAtGate`, wired into `approve()` + `reject()`): the offline fix *opens* a corruption path — an operator can enter the gate online (PENDING created), advance past it offline, and the PENDING orphans. Without a guard, an approver clicking **Reject** later would yank the now-progressed filter back to WASH_IN/DRY_IN and clear dryer state. The guard refuses with `409 APPROVAL_STALE` when the filter is no longer parked at the approval's stage/cycle. Normal online flow passes (filter is still at the gate when its approver acts).
- **Verification**: `tsc --noEmit` clean for both `apps/web` and `apps/api`; `dist/` rebuilt + `DigiLog-FilterOps.apk` rebuilt; API restarted so the guard is live.
- **Known open item (deferred — product/compliance decision)**: orphaned PENDING approvals are now *safe* (un-actionable) but still **sit in the approver inbox** as clutter. Proper cleanup (auto-resolve the PENDING on offline replay past the gate) needs a status semantic — add a `CANCELLED`/`SUPERSEDED` enum value (cleanest, needs a migration), reuse a status, or leave them visible-but-blocked.

## [Unreleased] — Data-ingestion + TimescaleDB removal — Phase 7-10 cleanup wrap (2026-06-17)

Final cleanup wave for the data-ingestion + TimescaleDB tear-out started 2026-06-11 (Phases 1-6 landed as `a95f6eb`, Section 14 Debug Traces repurpose as `8619d24`). Pre-removal git tag: `pre-ingestion-removal`.

- **Phase 7 — Operational hygiene**:
  - `apps/api/.env` cleaned: removed `TSDB_HOST`, `TSDB_PORT`, `TSDB_DATABASE`, `TSDB_USER`, `TSDB_PASSWORD`, `TSDB_POOL_MAX`, `MQTT_ENABLED`, `MQTT_BROKER_HOST`, `MQTT_BROKER_PORT`, `EMQX_ADMIN_PASSWORD`, `UNS_ROOT_PREFIX` (10 dead env keys).
  - `deployment-check/routes.ts`: removed the `TSDB_HOST` required-env check.
  - **Deleted** `apps/api/src/lib/uns-path.ts` — `getEntityUnsPath()` helper with zero importers (last consumer `instance.service.ts:22` removed in Phase 3).
  - **Mosquitto Windows service uninstalled** via elevated `Stop-Service mosquitto; sc.exe delete mosquitto`. Port 1883 freed. The `.exe` files remain at `C:\Program Files\Mosquitto\` — only the service registration is gone.
- **Phase 8 — Test cleanup**:
  - Fixed `apps/api/src/e2e/test-helper.ts`: removed broken `import connectivityRoutes from '../modules/connectivity/routes.js'` + `import unsRoutes from '../modules/uns/routes.js'` + their 2 `app.register(...)` calls. **The whole e2e suite was un-compilable until this fix** because every test that calls `buildApp()` re-imports this file.
  - Fixed `apps/api/src/modules/assets/services/__tests__/instance.service.test.ts`: removed `deviceCredential`/`connectivityStatus`/`unsMapping`/`dataStream` model mocks (Prisma client no longer has them).
  - **Deleted** `apps/api/src/workers/__tests__/ingestion.worker.test.ts` (worker deleted in Phase 2) and `apps/api/src/e2e/connectivity.test.ts` (16 e2e tests for deleted `/api/connectivity/*` routes).
- **Phase 9 — Config defs + perms/privileges/reauth cleanup**:
  - **Deleted** 2 dead config defs: `apps/api/src/modules/config/defs/uns.def.ts` + `retention.def.ts`. Removed their imports from `config-discovery.ts` and added their `configKey`s (`'uns'`, `'retention'`) to the `cleanupDeadConfigKeys` migration so any stale DB rows are auto-removed on next boot.
  - `packages/shared/src/types/`: removed `UNS_VIEW` + `UNS_MANAGE` from `permissions.ts` and `permission-categories.ts`; removed `uns.view`/`uns.manage` cards + their `FEATURE_TO_PERMISSION_MAP` entries from `feature-privileges.ts`; removed 6 reauth actions from `reauth-actions.ts` (`MANAGE_DEVICE_CREDENTIAL`, `OVERRIDE_UNS_PATH`, `DELETE_UNS_MAPPING`, `UPDATE_UNS_CONFIG`, `UPDATE_RETENTION_POLICY`, `EXECUTE_RETENTION`) and 2 reauth categories (`'UNS'`, `'Retention'`).
  - `apps/api/prisma/seed.ts`: removed `UNS_VIEW`/`UNS_MANAGE` from SUPER_ADMIN + ADMIN role permission lists.
  - `apps/api/src/modules/roles/role.service.ts`: removed `UNS_VIEW`/`UNS_MANAGE` permission labels from the role config UI map.
  - **Live DB cleanup**: stripped `UNS_VIEW`/`UNS_MANAGE` from `roles.permissions` (1 row updated, SUPER_ADMIN went 89 → 87 perms). Stripped 5 dead keys (`EXECUTE_RETENTION`, `OVERRIDE_UNS_PATH`, `UPDATE_UNS_CONFIG`, `DELETE_UNS_MAPPING`, `UPDATE_RETENTION_POLICY`) from the `system_config['action-reauth']` JSONB.
- **Kept per 21 CFR §11 inspector contract**: `audit-actions.ts` registry entries `UNS_PATH_OVERRIDDEN`, `UNS_CONFIG_UPDATED`, `RETENTION_POLICY_UPDATED`, `RETENTION_EXECUTED`, `DEVICE_CREDENTIAL_REGENERATED`. New code never emits these but historic audit rows still render correctly in the inspector UI.
- **Phase 10 — Doc sync**: this CHANGELOG entry + System Stats refresh in `CLAUDE.md` / `apps/api/CLAUDE.md` / `packages/shared/CLAUDE.md` + windowsIssues.md Mosquitto section dropped.

**Verification on close**:
- `tsc --noEmit` clean for both `packages/shared` and `apps/api`.
- API boot clean: `[config-registry] 34 modules registered` (was 36 — `uns.def` + `retention.def` gone).
- graphile-worker task names: `notification`, `pm_overdue_check`, `session_sweep` only.
- All real business endpoints return real data (`/api/health`, `/api/filter-cleaning-profiles`, `/api/assets/templates`, `/api/filters/cycles`, `/api/audit`, etc.). `UNS_VIEW`/`UNS_MANAGE` grep on `/api/roles` response: **0 hits**.
- All previously-deleted endpoints (`/api/uns`, `/api/connectivity/*`, `/api/queries/telemetry/*`, `/api/retention`, `/api/config/retention`, `/api/export/*`, `/api/data-ingestion/*`) return **404**.

## [Unreleased] — Remove dead `qr-code` module (Scope A) (2026-06-06)

Removed the non-functional `qr-code` API module. It generated a **placeholder** SVG (a white box with the URL as text — not a scannable QR, because the `qrcode` lib was never installed) and had **zero frontend consumers** (`grep "/api/qr"` in `apps/web` → none). Pre-deletion touchpoint sweep confirmed nothing functional depends on it.

- **Deleted**: `apps/api/src/modules/qr-code/routes.ts`, `apps/api/src/e2e/qr-codes.test.ts`; removed the import + `/api/qr` registration in `app.ts` and `e2e/test-helper.ts`; removed the "QR Codes" Swagger tag.
- **Kept (Scope A)**: the `QrCode` Prisma model + `qr_codes` table, and `instance.service.ts:574` `tx.qrCode.deleteMany(...)` (asset-delete cascade cleanup) — harmless, avoids a schema migration. Scope B (drop the model + table) deferred.
- **Verified**: API `tsc --noEmit` clean; no dangling `/api/qr` / `qrCodeRoutes` references. Module count 34→**35** in docs (the old "34" was already stale — `replacement-schedule`/`hierarchy`/`sync` had drifted in uncounted; flagged for a separate reconciliation).

## [Unreleased] — Cross-block cleaning: advance gate + super-admin toggle (2026-06-06)

Uncommitted on `RFID`. **Scope: block-change enforcement only — no cleaning-cycle mechanics changed** (stage flow, checklist/dryer logic, cycle codes untouched).

- **Bug fixed — a later stage could be performed in a different block with no approval.** The block-change check existed only in `start-cycle`; `advance` destructured `cleaningAreaId`, wrote it onto the event, but **never validated it**, so e.g. DRY_IN in another block was silently accepted (confirmed live: HTTP 200). New `validateAdvanceBlock()` (`filter-operations/filter-resolver.ts`) rejects a stage whose `cleaningAreaId` ≠ the cycle's frozen block with **`409 BLOCK_MISMATCH`** ("This cleaning cycle is running in CWH. Perform this stage in CWH, not L1."). Wired as a single pre-write guard at `advance.ts` (throws before any mutation). Distinct code (not `BLOCK_CHANGE_REQUIRED`) so the FE shows a plain rejection, not the dead-end approval popup (a frozen cycle can't be moved).
- **New super-admin toggle — "Require Cross-Block Approval"** added to the existing **Block Change Approval** config (`config/defs/block-change-approval.def.ts`, `requireApproval` boolean, default **true** = current behaviour). When **off**, cross-block cleaning is allowed freely. `blockChangeService.isEnforcementEnabled()` reads it (defaults true when absent) and **all four enforcement points** short-circuit so FE and backend agree: `validateBlockChange` (start pre-check), `consumeBlockChangeApprovalTx` (start in-tx consume), the new `validateAdvanceBlock` (advance), and `current-state` `blockChangeStatus` (pre-start popup → reports `APPROVED` when disabled).
- **Diagnosis note — Bug 1 ("no active cleaning cycle" at WASH_IN) is a frontend symptom, not backend.** Live test proved `start-cycle` into a different block correctly returns `409 BLOCK_CHANGE_REQUIRED`. The FE opens the block-change popup proactively from `blockChangeStatus`; the "no active cleaning cycle" path is offline/stale-cache adjacent and was **left untouched** pending a tablet repro (avoids touching the cycle/sync flow).
- **Verified**: API typecheck clean; toggle ON → cross-block start 409 + advance 409 BLOCK_MISMATCH, same-block start/advance 200; toggle OFF → cross-block start 201 + advance 200; config restored, test filter left with no active cycle. Targeted suites pass (61); the 2 `deep-review-d5-d7` failures are pre-existing (verified via stash-compare). No web/APK rebuild needed for the backend bits (backend + API-driven config).

- **Frontend fix — "No active cleaning cycle" on cross-block via the queue/"Submit All" path.** Diagnosed live on tablet HA28H13Z (adb + Capacitor console): a cross-block submit fired `start-cycle` (→409 BLOCK_CHANGE_REQUIRED) and then `advance` (→400 NO_CYCLE) because the **queue path lacked the up-front cross-block popup gate** that the single-scan path has, and the **sync engine** still ran dependent ops after a failed start. Two surgical, same-block-safe guards:
  - `mobile/mobile-operations.tsx` `handleSubmitQueue`: before submitting a queued item, when online + a block is selected, fetch `/current-state?cleaningAreaId=<selected>` and if `blockChangeStatus === 'REQUIRED'` open the **Request Block Change** popup and stop (clears queue, no start/advance). MATCH/APPROVED fall straight through — same-block cleaning untouched.
  - `lib/sync-engine.ts`: track filters whose `start-cycle` op failed (excluding `CYCLE_ACTIVE`) and **skip their dependent advance/checklist/bypass ops** in the same drain (mark failed, no HTTP) so the cross-block "start rejected → advance fires → NO_CYCLE" cascade can't happen.
  - Verified on tablet: cross-block now shows the approval popup; after QA approval, starting with the approved block selected records the cycle in that block and consumes the approval; same-block cleaning unchanged. Web rebuilt + APK reinstalled via adb. Pre-change snapshot kept at `git stash@{0}` ("pre cross-block FE fix").
  - **Note (not a code bug):** a cycle's block is fixed at Start from the selected block; a block-change approval only *permits* starting in the new block — it does not relocate an already-started cycle. Operator must have the approved block selected when starting.

## [Unreleased] — Replacement Tasks: pick filters from the AHU (tablet) (2026-06-05)

Commit on `RFID`.

On the tablet's **Replacement Tasks** page, after opening a task (AHU + micron + size), the operator can now **pick the filters to replace from a list** instead of only scanning each tag. The existing RFID scan box stays (additive).

- **Pick-from-list** (`apps/web/src/routes/mobile/mobile-wrapper.tsx`): after selecting a task, the view lists the **active filters directly under that AHU**, matched against the task's micron + size (`attributes.micronSize` ↔ `filterMicron`, `attributes.filterSize` ↔ `filterSize`, normalised case/whitespace, `NA`/`-`/blank ignored). **Matching-first with all-as-fallback**: if no filter matches (attributes blank/mismatched) it shows every active filter under the AHU with an amber note. Each row shows the filter's own micron · size · RFID tag, plus a name **search** box (first 80 rendered).
- **Multi-select batch**: tick filters up to the task's `qtyRemaining` (the rest grey out at the cap); **"Replace N selected filters"** runs them in one loop through the **same** `POST /api/replacement-schedules/entries/:id/execute` endpoint + `REPLACE_FILTER` reauth + audit the scan path already uses — one password covers the batch. Per-filter errors are collected (one bad filter doesn't abort the rest); `REAUTH_FAILED`/`REAUTH_REQUIRED` re-throw to the reauth dialog. On partial failure the task stays open with a "Replaced X, N failed" message; on full success it returns to the task list (which refreshes the decremented qty).
- **Tablet task endpoints opened to any role** (`apps/api/src/modules/replacement-schedule/routes.ts`, 2026-06-04 per user): `GET /due` and `POST /entries/:id/execute` dropped their `REPLACEMENT_SCHEDULE_VIEW` / `REPLACEMENT_SCHEDULE_EXECUTE` preHandlers so any authenticated operator can run scheduled replacements from the tablet. **Web view/upload of the schedule stays role-gated**, and execute **still requires `REPLACE_FILTER` reauth**, so the 21 CFR electronic signature + audit are preserved.
- **Bug fixed along the way**: cancelling the reauth dialog left `replTaskSubmitting` stuck (froze the task's submit button) — now reset in the dialog's `onCancel`.
- **Verified**: `vite build` clean; logic validated against the live DB (AHU-0A's micron-20/100x110x120 qty-2 entry maps to exactly `F2/AHU-0A/SA/011` + `/012`; micron-15/150x160x170 → `/013`); operator-confirmed working on the tablet. APK rebuilt (`DigiLog-FilterOps.apk`).

## [Unreleased] — Configurable report labels (titles / subtitles / column headers) (2026-06-03)

Commit on `RFID`: `95f8271`.

Admins can now rename every report's **title, subtitle, and table column headers** from **Configuration → Report Labels**, applied to BOTH the on-screen view AND the PDF export. Blank fields fall back to the built-in labels. **Logo + company name are unchanged** — they remain in the existing **Branding** config and already render on every report PDF + on-screen header (so they are intentionally *not* duplicated here).

- **Single source of truth**: `apps/web/src/lib/report-labels.ts` — `REPORT_DEFS` registry (per report: key, default title, ordered column keys + default labels) + `resolveReportLabels(key, cfg)` that merges admin overrides over defaults (blank ⇒ default). Hook `apps/web/src/hooks/use-report-labels.ts` reads `/api/config/report-labels/current` and returns `labelsFor(reportKey)` → `{ title, subtitle, columns, orderedLabels }`.
- **Backend config**: new `defs/report-labels.def.ts` (config card, CONFIG_READ/UPDATE, `/config/report-labels`) + `static-routes/report-labels.routes.ts` (`GET /report-labels/current`, `PUT /report-labels` → `systemConfig` key `report-labels`, audited `CONFIG_CHANGED`). Registered in `config-discovery.ts` + `config/routes.ts`. Display config ⇒ no reauth (matches report-settings).
- **Config page**: new `routes/config/report-labels.tsx` — per-report Title + Subtitle (blank = auto period/totals) + an input per column header (placeholders show the defaults), Save + Reset-to-defaults, gated on `CONFIG_UPDATE`. Route added to `main.tsx`; card added to `config/index.tsx`.
- **Reports wired** (each reads its title/subtitle/columns from the config — on-screen `<th>` headers, PDF `addTable` head, `ReportPageWrapper` title, and the PDF title/subtitle — with the current strings as defaults): **Audit Trail**, **Cleaning Cycles** (the cycles table *and* the Manual Status Updates table on the same page), **Filter Traceability**, **RFID Track Record**.
- **Verified** (Playwright + curl): config GET/PUT persist; the page renders all 5 report sections and loads/saves overrides; renaming the RFID report's title → "RFID Lifecycle Log" and Reason column → "Removal Reason" showed on the on-screen view AND was found inside the downloaded PDF's content streams; reset to defaults afterward; no console errors. API + web `tsc` clean.

## [Unreleased] — Tab⇄Web cleaning unification + RFID Track Record + audit fixes (2026-06-03)

Commits on `RFID`: `cda4bd9` `abebe4e` `01c50fb` `3a400d7` `3b2d4f4` `38fa872` `1758e73`.

### Cleaning workflow unification — manual web moves now follow the cleaning profile (P1–P3)
Goal: web **Edit Filter Status** behaves like tablet cleaning — same profile rules, same cycle records. **Architecture:** no rewrite of the tablet `advance()` engine; a new shared helper reuses the *same* `@digilog/shared` `findReachable()` the tablet uses, so the rules are provably identical.
- **P1 — profile-sequence validation** (`3b2d4f4`). New `filter-operations/stage-rules.ts` (`getFilterStageRules` / `classifyMove` → FORWARD/BACKWARD/SKIP/COMPLETE/NON_CLEANING/START / `buildStageOptions` / `getProfileOrderedStages`). New `GET /api/filters/:id/stage-options` (profile-aware option list, works with or without a cycle). `changeLifecycleState` rejects an out-of-sequence **SKIP** with *"Invalid stage movement. Please follow the configured cleaning profile sequence."* `StatusUpdatePanel` constrains the dropdown to the profile (omits stages it doesn't define), flags skips, marks backward/current, shows the profile name + a "Moving filter manually…" banner. Manual moves attach the `STATE_TRANSITION` event to the active cycle (so they populate that cycle's stage columns).
- **P2 — missing profile stage = NA** (`3b2d4f4`). `getCycles` attaches `profileStages[]` per cycle (batched by profile); Cleaning Cycles table + PDF show **NA** for a stage the cycle's profile doesn't configure, vs `-` for an in-profile stage not yet reached.
- **P3 — backward move breaks the cycle** (`38fa872`). New `filter-operations/manual-cycle.ts` (`breakActiveCycleTx` → TERMINATED + `broken` marker; `resolveManualCycleReason` → 400 `REASON_REQUIRED`/`JUSTIFICATION_REQUIRED`; `startManualCycleTx` → manual-origin cycle, `-M` cycle code). A backward manual move closes the in-flight cycle (reuses **TERMINATED** + reason — no schema migration) and starts a fresh one from the target stage; a cleaning move on a filter with no active cycle starts one too. Both **prompt the operator for a cleaning reason** (+ justification when required) — `lifecycle-state` route accepts `cleaningReasonKey`/`cleaningJustification`; the dialog shows the reason picker + conditional justification and gates submit.

### RFID Track Record report (P4, `1758e73`)
New report: full assign/remove/reassign lifecycle of every RFID tag, **built from `audit_trail`** (no new table).
- `identifier.service.getRfidTrackRecord` reconstructs the timeline (`ASSET_IDENTIFIER_CREATED`=assign / `…_DELETED`=remove, RFID-only) joining filter/AHU/user; filters: date range / RFID / filter / AHU / user + pagination. (Guard: audit `userId` is varchar — only UUID-shaped ids hit `User`, else fall back to the raw value.)
- **Removal reason capture:** `DELETE /identifiers/:id` now accepts a `reason` (body or query) → `audit_trail.reason`, so the report can show *why* a tag was removed.
- New `GET /api/assets/identifiers/track-record` (ASSET_VIEW or FILTER_RFID_MANAGE). New web `/rfid-track-record` page (filter bar + timeline table + **Download PDF** via the jsPDF `createReport` helper — PDF only). Sidebar item + route + `SIDEBAR_PRIVILEGE_MAP` entry (reuses `assets.view`/`filters.rfid_manage` — no new permission).

### Same-day fixes
- **Logout audit** (`cda4bd9`): `logout(reason)` + a `session_sweep` worker (cron */5) that terminates idle/expired sessions and writes a `LOGOUT` audit — captures tablet app-close / window-close / crash logouts that never hit `/logout`. Fixes the SUPER_ADMIN-hides-from-self audit filter so superadmin sees its own rows.
- **Last Cleaned rule** (`abebe4e`): `lastCleanedAt` = latest cleaning-stage event time (real cycle OR manual Edit-Filter-Status); Filters page shows **NA** (not `--`) when never cleaned.
- **Retirement Remarks** (`01c50fb`): retirement list now shows the reason (joined from the `FILTER_RETIRED` audit) + retiredBy/retiredAt.
- **FDM console cross-page refresh** (`3a400d7`): editing a cycle/event status in the Filter Data Management console now refreshes the Cleaning Cycles page (SWR prefix-mutate; was an exact-key mismatch).

**Verification:** every item exercised live (curl + Playwright) — SKIP→400/state-unchanged, FORWARD→200/event-attached, backward→cycle-1-TERMINATED + cycle-2-IN_PROGRESS, REASON/JUSTIFICATION 400s, NA rendering, RFID timeline + removal reason + valid `%PDF`. API + web `tsc` clean; shared rebuilt. Plan/decisions: `tasks/todo.md` "Cleaning Workflow Unification".

## [Unreleased] — Filter Replacement Schedule, Phase 1 (2026-06-02)

New **upload-driven** feature (additive — no existing functionality changed). Design: `tasks/REPLACEMENT-SCHEDULE-SCOPE.md`; plan/status: `tasks/REPLACEMENT-SCHEDULE-TODO.md`.

- **DB**: 3 new models — `ReplacementSchedule` → `ReplacementScheduleEntry` → `ReplacementExecution` + `ReplacementEntryStatus` enum (cascade FKs; soft AHU refs). Tables created via **direct DDL** (psql) because `prisma db push` is blocked by pre-existing NotificationType/EventType enum drift from the 2026-05-17 tear-out — unrelated, untouched. Client regenerated.
- **Permissions**: `REPLACEMENT_SCHEDULE_VIEW/UPLOAD/EXECUTE` (UPLOAD/EXECUTE explicit-grant-only) + feature privileges `replacement_schedule.view/upload` + `FEATURE_TO_PERMISSION_MAP` → SUPER_ADMIN grants UPLOAD to any role via Role Privileges ("configurable by which role"). Shared rebuilt.
- **API module** `modules/replacement-schedule/` at `/api/replacement-schedules`: `GET /template.xlsx` (live AHU-name dropdown), `POST /validate` (dry-run + per-cell errors), `POST /` (all-or-nothing create, audited), `GET /` (list + computed DUE/IN_PROGRESS/COMPLETED/MISSED status), `GET /due` (active-window entries → tablet tasks). Upload validates: AHU resolves by name (rejects unknown/ambiguous), qty integer ≥1, schedule date valid + **not past**, **± tolerance window** (column wins, else config default 0). Permission-gated (reauth deferred to polish).
- **Web**: `/replacement-schedule` page — Download Template + Upload dialog (dry-run preview, per-row errors, all-or-nothing confirm) + schedules/entries list with status chips (bounded-scroll + sticky header). Sidebar item + route guard added. xlsx-only.
- **Verified live via Playwright** (clean browser): routes gated (401 unauth), template returns valid .xlsx (12.5KB PK zip), list returns empty `data`, page renders (heading/buttons/empty-state), sidebar item present. tsc clean (api + web + shared); web built.
- **Phase 2 (done, 2026-06-02)**: tablet tasks + replace-from-task.
  - `POST /entries/:id/execute` — wraps the existing `filterOps.replace` action (unchanged), logs a `ReplacementExecution`, increments `qtyReplaced`, marks `COMPLETED` at qty; gated by `REPLACEMENT_SCHEDULE_EXECUTE` + **reuses the existing `REPLACE_FILTER` reauth** (replacement stays gated, no new reauth action).
  - Tablet (`mobile-wrapper.tsx`, additive): a **separate "Replacement Tasks" tile** on the home (per user decision — NOT merged into My Tasks; cleaning tiles untouched), badged with the due count, → a **dedicated page** listing due entries (AHU + micron/size + qty-remaining + due-by). Tapping an entry → scoped **scan the old filter** (reuses the scan-to-select pattern) → reauth → `execute` → qty decrements; multi-session until met.
  - **Verified live via Playwright** (seeded one due entry, then cleaned up): tile shows badge "1", dedicated page lists the task (`AHU-E · micron 0.3 · 610x610x292mm · 2 of 2 left · due 6/5/2026`). tsc clean (api/web); web built.
- **Phase 3 next**: dashboard counter + notifications + follow-ups (reauth on upload, ADMIN seed grants, config-def for tolerance default, CSV support).

## [Unreleased] — Filters Page UI/UX + new "Filter Size" field (2026-06-02)

Enhancements to the desktop Filters page (`apps/web/src/routes/filter-management/filter-list.tsx`) plus a brand-new **Filter Size** field-option, distinct from Micron Size (physical dimensions, e.g. `610×610×292mm`).

**New `filterSize` field-option** — mirrors `micronSize` end-to-end (configurable dropdown sourced from the `filter-field-options` config; admin populates the list):
- Backend: `assets/services/filter-fields.service.ts` (`FilterFieldOptions` / `FilterFieldInput` / `checkList` / defaults), `hierarchy/routes.ts` (create + edit filter body schemas — both had `additionalProperties:false`, so the key had to be declared), `filter-operations/events-routes.ts` (`/api/filters/field-options` response schema + handler — also `additionalProperties:false`, would have silently stripped it), `assets/services/bulk-upload-filter.service.ts` (parse/validate/create), `assets/services/filter-upload-template.service.ts` (new .xlsx column + live dropdown), `config/defs/filter-field-options.def.ts` (description), `prisma/seed.ts` (`filterSize: []`), `assets/routes/instance.routes.ts` (swagger text). Create/update flow through `validateAndBuildFilterAttributes` automatically (via `FilterFieldInput`); the read path needed no change (`attributes` is `additionalProperties:true` in the tree response schema).
- Frontend: `filter-list/components/FilterFieldOptionsSection.tsx` (type + 4th select), `filter-list/types.ts`, `dialogs/{CreateFilterDialog,EditFilterDialog,BulkUploadDialog}.tsx`, `filter-list.tsx` (state + enriched map + table column + submit bodies), `config/filter-field-options.tsx` (admin CRUD page — new "Filter Size" section).
- Tests: `filter-fields.service.test.ts` (+2), `filter-upload-template.service.test.ts` (+1, header order updated), `create-filter.routes.test.ts` (payload now carries filterSize to prove the schema doesn't strip it). All green.

**UI/UX** (per the 7-point brief):
- New **Filter Size** column in the grid.
- **Update Status** action got a distinct adjustments/sliders glyph (row + bulk bar) — it previously shared the Edit pencil.
- Single-line cells: `whitespace-nowrap` on all td/th, `truncate` + `max-w` + `title` tooltip on Filter / AHU / Area / Filter Type / Filter Size.
- Tighter density (`px-5 py-3.5` → `px-3 py-2.5`) so the extra column fits and more rows show.
- Toolbar: **Export · Create Filter · Bulk Upload** grouped adjacent on the right.
- New client-side **CSV Export** of the listed filters (full filtered set, not just the page; UTF-8 BOM; RFC-4180 quoting) including Filter Size.

**Flagged, NOT changed** (product decision): `filter-resolver.ts` `BY_FILTER_SIZE` cleaning-profile routing + `config/cleaning-profile-assignment.tsx` ("By Micron Size") still read `micronSize` for backward-compat. Now that `filterSize` is real, you may want that mode to match the real dimension — left as-is to avoid regressing existing rules.

### Lifecycle status: dropdown change + cycle-completion auto-update (2026-06-02)
- **Update-Status dropdown** (`filter-list/constants.ts` `LIFECYCLE_STATE_OPTIONS`): removed **Installed** + **In Use** (still valid system/historic states — kept in `STATUS_LABELS` + `FILTER_STATE_COLORS` for rendering); added **Cleaning Cycle Completed** (`CLEANING_CYCLE_COMPLETED`). Panel-open defaults no longer default to the removed `INSTALLED`.
- **Backend enum** (`assets/routes/instance.routes.ts` `/:id/lifecycle-state`): added `CLEANING_CYCLE_COMPLETED` (INSTALLED/IN_USE kept valid).
- **Cycle completion auto-update** (`cycle-write/advance.ts` + `submit-checklist.ts`): on END-reaching completion, `currentLifecycleState` → `CLEANING_CYCLE_COMPLETED` (was `null`/Idle) and `filters.attributes.lastCleaningDate` is stamped to the completion day (`offlineTime ?? now`, dryer-anchor offline rule; `jsonb_set` preserves other attrs; mirror trigger syncs asset_instances). `currentCycleId` still cleared (getCurrentState/start-cycle key off it). `start-cycle.ts` resets `currentLifecycleState` to null on start so the terminal badge doesn't linger.
- **Propagation**: single `FilterDetails.currentLifecycleState` source + `filters.attributes.lastCleaningDate` (both served by `/api/hierarchy/tree`); filters page `mutate`s the tree, other views revalidate via SWR.
- Tests: 61/63 filter-operations pass; the 2 `deep-review-d5-d7.test.ts` failures are **pre-existing** (mock missing `filterCleaningProfile.findFirst`, verified by git-stash-compare). Both apps tsc-clean.
- **Force-complete fix** (`assets/services/instance.service.ts` `changeLifecycleState`): manually setting **Cleaning Cycle Completed** while the filter has a live `IN_PROGRESS` cycle previously desynced the views (Filters page showed "Cleaning Cycle Completed" via the label, but the Cleaning Cycles page still showed "In Progress" because nothing finished the cycle). Per user decision, the manual change now force-completes the active cycle inside a transaction: marks the `CleaningCycle` COMPLETED, clears `currentCycleId`, emits a `CYCLE_COMPLETED` filter event flagged `manualForceComplete: true` (operator remarks = justification; checksum via `computeChecksum`), sets the label, and stamps `lastCleaningDate`. Other states keep the old label-only behaviour. The Filters-page status handlers also invalidate the `/api/filters/cycles|events` SWR caches so the Cleaning Cycles view refreshes immediately. (Compliance note: this finishes a cycle outside the normal stage/checklist progression — the `manualForceComplete` flag marks it in the trail.) 192/194 backend tests pass (same 2 pre-existing).

### Table horizontal scrolling + full-bleed + Filter Size = free text (2026-06-02)
- **App-wide drag-to-scroll** (`hooks/use-drag-scroll.ts`, mounted once in `AppLayout`): every wide table/grid/list (any `.overflow-x-auto`/`.overflow-auto` with horizontal overflow) is now click-drag pannable. Document-delegated, mouse-only (touch/pen keep native gestures), 5px drag threshold + post-drag click suppression so row checkboxes/links/buttons still work, skips the scrollbar gutter. Shift+wheel + touchpad were already native (not duplicated to avoid double-scroll). Root cause of the original complaint: tables relied solely on the native `overflow-x-auto` scrollbar with no JS pan; no grid library involved.
- **Filters page full-bleed** (`filter-list.tsx` wrapper): negative margins cancel `AppLayout`'s `<main>` padding (`p-3 sm:p-4 lg:p-6`) so the grid uses the full content-area width instead of doubled padding.
- **Filter Size is now FREE TEXT, not a dropdown** (per user): `FilterFieldOptionsSection` renders a text `<input>`; backend `validateAndBuildFilterAttributes` stores it as trimmed, HTML-stripped free text (no master-data list check); the bulk-upload template column drops its data-validation dropdown; the `filter-field-options` config page no longer manages a Filter Size list. Display column, CSV export, create/edit/bulk wiring unchanged. Tests updated (free-text accept + no-dropdown).
- **Infra**: Vite dev server + API were restarted — both had been running since before this session and Windows file-watching never picked up the edits, which is why changes appeared "missing" (not a code or service-worker problem). Both apps tsc-clean; web built.
- **Tablet filter replacement — scan-to-select (additive)** (`routes/mobile/mobile-wrapper.tsx`): the mobile Replace view kept its Block→Area→AHU→Filter cascade + name search, and **gained a "Scan filter tag" input** at the top. Scanning (or typing) an RFID/QR tag resolves it via `buildIdentifierMap` (same identifier→filter map the Status "Scan RFID" lookup uses) and pre-selects the filter, jumping to the remarks/confirm step. Reuses the proven `useRfidScanField` + `data-rfid="true"` scanner-capture pattern (RFID-guard-friendly) and the shared `retireOrReplaceFilter` action — no new backend. **Verified via Playwright**: scanned a live tag → filter auto-selected → confirm panel; cascade + search confirmed still present. **Replacement Schedule: confirmed NOT implemented** anywhere (no DB model, API, UI, or docs — PM Schedules cover cleaning/maintenance only); flagged for separate scoping.
- **Bounded table containers (Option 1) — horizontal scrollbar reachable without scrolling to page bottom**: the real complaint was that the horizontal scrollbar sat at the bottom of a *full-height* table, so users had to scroll the whole page down to reach it. Root cause: the table's scroll container had no height bound (Filters used `overflow-x-auto` with table-height; Cleaning Cycles used `flex-1 overflow-auto` whose ancestors weren't height-constrained, so it grew to ~1781px). Fix: bound the scroll box (`overflow-auto max-h-[calc(100vh-16rem)]` on Filters; `…-26rem` on Cleaning Cycles) + `sticky top-0` header → the table now scrolls BOTH ways *inside* a viewport-sized box, so the horizontal scrollbar is always on screen, the header stays put, and drag-scroll/Shift-wheel still work. **Verified via Playwright** (clean browser, fresh dev bundle): Filters box bottom y=666/678 viewport with internal v-scroll + sticky head + 54px drag; Cleaning Cycles box bottom y=643/678 with 251px bounded box over 1781px content + 300px drag. The earlier "nothing works" reports were a stale cached bundle in the user's browser — confirmed by Playwright loading the fresh code and the drag-scroll hook firing.

## [Unreleased] — Enterprise-audit remediation: security, perf, dead-code (2026-05-30)

Acting on `tasks/ENTERPRISE-AUDIT-2026-05-30.md`. SUPER_ADMIN lockout/expiry/audit-visibility exemptions are **intentionally retained** as documented accepted trade-offs (per CLAUDE.md + memory) and are NOT changed here.

**Security / correctness**
- **OAuth2 callback XSS** (`notification-delivery/routes.ts`): reflected `error` / `error_description` / message values are now `escapeHtml()`-escaped before being interpolated into the HTML response.
- **Report path leak** (`reports/routes.ts`): `/:id/pdf` + `/:id/preview` wrap `readFile` in try/catch and return a clean `404 NOT_FOUND` instead of letting a raw `ENOENT` (with the server file path) reach the 500 handler.
- **Password in audit trail** (`users/user.service.ts`): `USER_UPDATED` audit `afterValue` previously spread the full `data` (including `password`/`passwordHash`). Now stripped before logging.
- **Auth-cache staleness** (`users/user.service.ts`): wired `invalidateUserAuthCache(id)` into `update` / `enable` / `disable` / `deleteMany` so a role/status/password change takes effect immediately instead of after the 30s TTL (the cache is keyed by user UUID; verified).

**Performance**
- **Bulk-upload N+1** (`assets/services/filter-fields.service.ts`): `loadFilterFieldOptions()` now has a 10s TTL cache, collapsing a 200-row upload's 400+ identical config reads to one.
- **Per-request assignment scans** (`assets/routes/instance.routes.ts`): `GET /instances` + `/instances/tree` short-circuit the two `findMany({take:10000})` visibility-scoping queries when no `EntityAssignment`/`TemplateAssignment` rows exist anywhere (the common case), via a 30s cached `isScopingConfigured()` check.
- **Unbounded lists** (`filter-operations.service.ts`): `getRetirements` / `getReplacements` gained a defensive `take: 5000` cap (array contract preserved — no frontend change).

**Dead code / dependency hygiene**
- Removed **`reactflow`** + **`@monaco-editor/react`** from `apps/web` (0 imports remained after the 2026-05-17 rule-chain tear-out; pipeline editor uses a custom canvas).
- Migrated PM-schedule bulk upload (`pm-schedules/routes.ts`) from **`xlsx` (SheetJS — abandoned, CVE-2023-30533 / CVE-2024-22363, no registry fix)** to **`exceljs`** (already a dependency) + a hand-rolled CSV parser; removed the `xlsx` dep. CSV cells now stay strings (reaches `importSchedules`' string branch directly — kills the old Excel-serial TZ-drift footgun); XLSX date cells arrive as `Date`. Round-trip verified: a date cell yields the correct UTC calendar day, quoted-comma fields parse, comment rows preserved.
- Deleted stale root **`docker-compose.yml`** (referenced retired Redis) and broken **`.github/workflows/ci.yml`** (referenced retired Redis + `turbo` when the repo builds with `nx` + `prisma migrate deploy` against a psql-applied migration set). **Note: this removes the only CI workflow** — a minimal typecheck+test CI could replace it if desired.
- `.gitignore`: `old/db-backups/*.sql` (local dumps hold bcrypt hashes + audit PII — must never be committed).
- `.env.example`: dropped the dead Redis block, relabelled MQTT EMQX→Mosquitto, replaced `digilog123` defaults with `CHANGE_ME`, added the required `OFFLINE_REPLAY_SECRET`.

**Flagged, NOT executed** (needs explicit user go-ahead — destructive): git-history purge of `old/` dumps + the credentials/JWT-secret committed in `18a7337` (removed in `1439c33` but still in history). Deferred (with reasons): TSDB backup/DR runbook, god-component refactors, super-admin `paginatedList` per-model `select` + true offset pagination (response-contract risk), 47 empty tables.

## [Unreleased] — A-01 Tier 2 Phase 2 (partial): Filter reads move to the typed tree (2026-05-30)

**What**: Started migrating the filter pages off the legacy `/api/assets/instances` read onto the typed `/api/hierarchy/tree`, so `asset_instances` can eventually be dropped for filters (T2.4).

- **Two backend gaps fixed first** (they blocked any reader migration):
  - `hierarchyService.getTree()` now **zips `FilterDetails`** (filterSet / currentLifecycleState / …) onto every nested filter — the typed `filters` table dropped those columns. Live: 61/61 filters now carry `filterSet`.
  - Typed `ahus` gained a **`block_id`** column (migration `20260530_ahu_block_id`) so an **AHU parented directly by a block** (no area) is representable — previously the typed model only had `area_id`, so the 1 such AHU + its filters would have vanished. Backfilled; the forward-mirror AHU branch now sets `block_id` when the parent is a BLOCK; `getTree` returns `block.ahus` (direct). Live: the direct AHU now surfaces in `/tree`.
- **`filter-list.tsx` migrated** (desktop, hosts Bulk Upload): a flatten adapter maps the typed tree into the legacy flat node shape, preserving the existing tree-build + table logic; read + all 13 mutates repointed to `/api/hierarchy/tree`. Browser-verified: table renders AHU Type / Filter Type / Micron / Set A-B / lifecycle / RFID, the direct AHU is preserved, 0 console errors. Writes still hit `/api/assets/instances` (T2.3).

- **Filter edit + delete migrated** (T2.3): `filterService.update` / `softDelete` write the typed `filters` + `FilterDetails` directly; new `PUT` / `DELETE /api/hierarchy/filters/:id` (reauth `EDIT_FILTER` / `DELETE_FILTER`). The reverse mirror syncs `asset_instances` on UPDATE + soft-delete. Web edit now sends raw field values (no pre-built attributes); closes the "filter edit still legacy" gap from Slice 1. Live + browser verified (edit → "Filter Updated" modal, propagates to both tables; soft-delete flips `is_active` in both).

**Still pending (T2.2 remainder + T2.3/T2.4)**: `filter-operations.tsx` (legacy read remains as offline-cache input), the **operator-critical mobile pair** (`mobile-operations.tsx`, `mobile-wrapper.tsx`) + the offline-cache hook — these touch the tablet offline sync and need **on-tablet QA**, deferred to a dedicated session. Remaining mutations (block/area/ahu CRUD, filter retire/replace, cycle ops) and T2.4 (drop the reverse mirror + `asset_instances` for filters) also pending.

## [Unreleased] — A-01 Tier 2 Phase 1: Filter create is standalone (2026-05-30)

**What**: Filter **creation** (single + bulk) now writes the typed `filters` table **directly** — no `validateParent`, no `asset_relationships`, no asset-template. This fixes the **"Parent connections reached"** error (the legacy AHU asset-template `maxConnections=10` limit no longer applies to filters) and makes `filters` the write source-of-truth for new filters.

**How (reverse-mirror)**: New `filterService.create()` (`apps/api/src/modules/assets/services/filter.service.ts`) writes `filters` (+ `filter_details`, + RFID via `identifierService`) directly, generating the id in app code (the typed `filters.id` has no DB default). A new **reverse-mirror trigger** `fn_mirror_typed_to_asset_instance` (migration `20260530_filter_reverse_mirror`) back-fills a legacy `asset_instances` row (template_id = active FILTER template, parent_id = ahu_id) so the 7 pages still reading `/api/assets/instances` keep working. Both the new reverse trigger and the existing forward trigger got a `pg_trigger_depth() > 1` guard to prevent reverse↔forward recursion. `hierarchyService.createFilter` and `bulk-upload-filter.service` route through `filterService.create`; `instanceService.create`/`validateParent`/`resolveFilterTemplateRef` are no longer in the filter-create path.

**Verified live**: bulk upload of 3 filters into an AHU that already had **9 children** → all created, **no "Parent connections reached"**; 3 typed `filters` rows (ahu_id set), 3 `asset_instances` mirror rows (reverse trigger, parent_id set), **0 `asset_relationships`**, 3 `filter_details` with filter_set; deleting from `filters` cascaded the mirror + sidecar out. Trigger recursion-safety proven transactionally. Tests: `filter.service.test.ts` (3) + `create-filter.routes.test.ts` (4) + `hierarchy.routes.test.ts` (4) + c2 reauth e2e (6) green; both apps typecheck.

**Scope / still pending** (`docs/superpowers/plans/2026-05-30-filter-standalone-t2.1-plan.md`): this is **Phase 1** (create only). `asset_instances` still holds filters as a reverse-mirror because 7 reader files (`filter-list.tsx`, `filter-operations.tsx`, mobile, etc.) still read `/api/assets/instances`. **T2.2** = migrate those readers to `/api/hierarchy/filters`; **T2.3** = retire/replace/cycle/delete mutations to typed-direct; **T2.4** = drop the reverse mirror + forward FILTER branch + the FILTER asset_template (then `asset_instances` no longer holds filters at all).

## [Unreleased] — A-01 Slice 2: Bulk Upload .xlsx parity (2026-05-30)

**What**: The Filter Bulk Upload now matches Single Filter Creation — same concrete fields (no templateId / attributeSchema), the same live-master-data dropdowns, and the same typed create path. **CSV is replaced by `.xlsx`** with real Excel Data Validation dropdowns.

- **Template** (`GET /api/assets/instances/filter-upload-template.xlsx`): server-generated via `exceljs` with built-in dropdowns for `filterSet`, `ahuType`, `filterType`, `micronSize` whose values are read **live** from the `filter-field-options` config each download (zero hardcoding — a master-data edit shows up in the next download). Columns: `name` (the only required field — the Filter Name), `filterSet, ahuType, filterType, micronSize, lastCleaningDate, rfidTag`.
- **RFID assignment from bulk** (per user request): the `rfidTag` column lets operators assign an RFID tag per row during upload. Tags are validated for uniqueness — a tag already assigned to another filter (global `asset_identifiers.identifier_value @unique`) or duplicated within the file is **rejected** with `{row, column:'rfidTag', value, message}`; clean rows get the tag assigned via `identifierService.create` (one-per-entity + global-unique + audit). Filter-name duplicates (in-file or existing) are likewise rejected. The `filterProfileId` column was **removed** from the template.
- **Validation** (`POST …/bulk-upload-filters/validate`, dry-run): parses the `.xlsx` and returns per-cell `{row, column, value, message}` errors + the parsed rows, with **no DB write**. The dialog uses this to render a preview that flags invalid rows and lists the exact `Row N, column X = "value" — message` before the operator commits.
- **Upload** (`POST …/bulk-upload-filters`): re-runs the same validation, then creates each clean row through the typed single-create path (`instanceService.create` → FilterDetails + mirror trigger). Partial success supported (valid rows created, invalid rows reported). Fixed the stale `name:'Filter'` template lookup → `templateKind:'FILTER'`.
- **Frontend**: `BulkUploadDialog` shows the fixed field columns with their live dropdown values, the Area→AHU cascade (matches single-create), an `.xlsx` picker, and the row/column/value validation panel. The client CSV string-builder + `split(',')` parser are gone (binary `.xlsx` can't be parsed client-side).

**Verified**: unit tests (template generator 3, validator 4, create route 5) green; c2 reauth e2e green (6); both apps typecheck + web `vite build` green. **Live round-trip** against the real DB: template download → fill valid + bad-`filterType` rows → `/validate` returns the bad cell as `{row:3, column:'filterType', value:'CARBON', …}` with no write → real upload creates the valid row (typed `filters` + `FilterDetails.filter_set=SET_A`) and rejects the bad one; test rows cleaned up. **Browser-verified**: dialog renders with live dropdown values, template downloads, zero console errors from the feature.

Reuses Slice 1's `filter-fields.service.ts`. Spec + plan: `docs/superpowers/specs/2026-05-30-bulk-upload-filter-parity-design.md`, `docs/superpowers/plans/2026-05-30-filter-create-typed-cutover.md`.

## [Unreleased] — A-01 Slice 1: Filter single-create typed cutover (2026-05-30)

**What**: Filter single-creation moved off the asset-template / `templateId` / generic-`attributes` API surface onto a concrete typed endpoint. The create dialog no longer sends `templateId` or an `attributes` object built from a template `attributeSchema`; its dropdown fields are validated against the live `filter-field-options` config (per A-01 decision **D2=A**).

**New endpoint**: `POST /api/hierarchy/filters` — body is concrete fields only: `name`, `ahuId` (required), plus optional `filterSet` (A/B), `ahuType`, `filterType`, `micronSize`, `lastCleaningDate`, `filterProfileId`. The FILTER-kind template id is resolved **internally** for the unavoidable `asset_instances.template_id` FK (operator never sees it); the `fn_mirror_asset_instance` trigger mirrors the write into the typed `filters` table and `instanceService.create` writes the `FilterDetails` sidecar (`filterSet`/`filterProfileId`). Persistence is otherwise **unchanged** — this is an API-surface + field-source change, not a persistence rewrite.

**Validation (req #6)**: `ahuType`/`filterType`/`micronSize` must match the live config list (case-insensitive, stored canonical); `lastCleaningDate` must be `NA` or a calendar-valid `YYYY-MM-DD` (round-trip guard rejects e.g. `2026-02-30`). Failures return `400 { error: VALIDATION_ERROR, message, details: [{field, value, message}] }`.

**Files**: new `apps/api/src/modules/assets/services/filter-fields.service.ts` (field-options loader + `resolveFilterTemplateRef` + `validateAndBuildFilterAttributes`); `hierarchyService.createFilter` + `POST /filters` route in the hierarchy module; web `submitCreateFilter` repointed and the dead dynamic-`attributeSchema` field block removed from `CreateFilterDialog`. Also sidesteps the stale `name:'Filter'` template lookup (the live resolver uses `templateKind:'FILTER'`).

**Tests**: `filter-fields.service.test.ts` (4) + `create-filter.routes.test.ts` (5) — all green; both apps typecheck clean; web `vite build` green. **Live-verified** against the real DB: create→201 with canonicalized attributes + typed `filters` mirror + `FilterDetails.filter_set=SET_A`; bad dropdown value→400 with field/value detail; test rows cleaned up.

**Scope**: single-create only. Filter **edit** (`EditFilterDialog`) stays on the legacy path (FILTER `attributeSchema` is empty, so no functional divergence). **Bulk upload (Slice 2)** — `.xlsx` template with Excel data-validation dropdowns + server-side validation, reusing `filter-fields.service.ts` — is the planned follow-up (`exceljs` dependency already added). Spec + plan: `docs/superpowers/specs/2026-05-30-bulk-upload-filter-parity-design.md`, `docs/superpowers/plans/2026-05-30-filter-create-typed-cutover.md`.

## [Unreleased] — M-04: fix asset→typed-table mirror trigger breaking filter writes (2026-05-27)

**Bug**: Commit `97d298c` (2026-05-25) dropped four cycle-state columns (`filter_profile_id`, `current_lifecycle_state`, `current_cycle_id`, `filter_set`) from the `filters` typed-hierarchy table (FilterDetails is their authoritative home). The companion migration `20260525223000` dropped the sibling `fn_mirror_filter_details()` trigger and unblocked the *cycle-write* path — but the Wave-1 `fn_mirror_asset_instance()` trigger (mirrors every `asset_instances` write into `blocks`/`areas`/`ahus`/`filters` by `template_kind`) was left untouched. Its FILTER branch still did `INSERT INTO filters (... filter_profile_id ...)`, so every `asset_instances` write of FILTER kind failed with `column "filter_profile_id" of relation "filters" does not exist` — **breaking filter create / rename / retire / replace and bulk-upload** since 2026-05-25. Confirmed live on 2026-05-27 (columns absent from `filters`; `pg_get_functiondef` still referenced them).

**Fix**: migration `20260527191316_fix_mirror_asset_instance_drop_dead_filter_cols` — `CREATE OR REPLACE FUNCTION fn_mirror_asset_instance()` with only the FILTER branch cleaned (dropped the four dead column refs from the INSERT list, VALUES, and `ON CONFLICT DO UPDATE` set, plus the now-unused local vars and the `filter_details` SELECT-INTO). BLOCK / AREA / AHU / DELETE / ELSE branches unchanged; the trigger `trg_mirror_asset_instance_iud` untouched. Applied directly via psql (the `_prisma_migrations` table is absent — A-02 — so `migrate deploy` is not in use; `CREATE OR REPLACE` is idempotent).

**Verification** (transactional, all rolled back — zero test rows persisted): FILTER `asset_instance` INSERT now succeeds and mirrors a `filters` row with the correct `ahu_id` + reused UUID; UPDATE (rename + retire) drives the `ON CONFLICT DO UPDATE` branch correctly; BLOCK insert still mirrors. No application code changed — the fix is DB-side and live immediately, no API restart needed.

**Context**: This is item **M-04** in `tasks/PENDING-FIXES-2026-05-25.md`, on the asset-removal (typed-tables) programme path. The full generic-model→typed-table cutover remains task **A-01** (4–8 weeks, separate engagement) — executable plan now drafted at `tasks/A-01-ASSET-CUTOVER-PLAN.md`.

## [Unreleased] — Password expiry derives from live policy + grace floor (2026-05-23 → 25)

**Original bug (5/23)**: Setting `passwordExpiryDays` to 1 (or any value) did not expire existing users' passwords. Root cause: `users.password_expires_at` was a frozen snapshot baked in at password-change / create / unlock / reset time; lowering the policy later did not retroactively update any user row, and the login + per-request expiry checks only consulted that stale column.

**Follow-up bug (5/25)**: First iteration of the fix derived `expired = passwordChangedAt + days < now`. Admin lowered policy from 120 → 1 day and **every** account was force-flagged the instant they saved, including superadmin — bad UX, even though the policy was finally being honored.

**Fix**: new helper `apps/api/src/lib/password-expiry.ts` exports `isPasswordExpired(passwordChangedAt, createdAt, expiryDays, policyUpdatedAt)`. Anchor = `MAX(passwordChangedAt ?? createdAt, policyUpdatedAt)`. So saving the policy grants every account a fresh `days`-long grace window from the save time. After that window, accounts whose password is still older than the policy expire. The two enforcement sites — `authService.login` (`auth.service.ts:170`) and the auth plugin's per-request gate (`plugins/auth.ts:236`) — both consume the helper. The legacy `passwordExpiresAt` column is still written (vestigial, no longer authoritative).

**SUPER_ADMIN exemption (2026-05-25)**: Both gate sites now short-circuit for `user.role === 'SUPER_ADMIN'` before computing or applying expiry — mirrors the existing LOCKED-auto-unlock / EXPIRED-auto-recover / lockout-exempt branches in `auth.service.login`. Weakens 21 CFR §11.10(g) for privileged accounts; documented trade-off per user request. Plugin test `does NOT force password change for SUPER_ADMIN even with an ancient password` locks the behavior.

**Supporting changes**:
- `plugins/auth.ts`: added `passwordPolicyCache` (60s TTL holding `{ passwordExpiryDays, policyUpdatedAt }`) + `getPasswordPolicy()` + exported `invalidatePasswordPolicyCache()`.
- `auth.repository.ts`: added `getPasswordPolicyRow()` returning the full `SystemConfig` row so callers can read `updatedAt` alongside `configValue`.
- `config.service.ts updateConfig`: calls `invalidatePasswordPolicyCache()` when `key === 'password-policy'` so admin saves take effect immediately rather than after up to 60s of TTL lag.
- `user.repository.ts`: `createUser`, `unlockUser`, `resetPassword`, `approveResetRequest` now write `passwordChangedAt = new Date()` (previously only `auth.repository.changePassword` did). Makes the new derived check consistent across all password-write paths and removes the implicit dependency on `forcePasswordChange` ordering after admin resets.
- `auth.plugin.test.ts`: fixtures updated for new `passwordChangedAt` / `createdAt` + `systemConfig.findUnique(password-policy)` mocks including `updatedAt`; cache reset in `beforeEach`.
- `auth.service.test.ts`: added `getPasswordPolicyRow` to the repository mock + default fixture.
- **NEW** `lib/__tests__/password-expiry.test.ts`: 9 unit tests covering 0-day no-expiry, null `passwordChangedAt` fallback, the grace floor (the 5/25 regression), and the null-`policyUpdatedAt` legacy path.

**Net test delta**: 0 from this fix (+9 helper tests, 0 new failures). Same 4 pre-existing auth.plugin failures remain (module-scope cache pollution between tests — unrelated). Type-check clean.

**Deploy note**: On admin's next save of the password policy, every account gets a fresh `days`-long grace window starting from save. Accounts whose password is *still* older than `days` after the window elapses then expire on their next request. With expiry=1 day, that means the warning becomes: "everyone has 24 hours from save to change their password before being force-flagged." Preview who will eventually flip (run after save):

```sql
SELECT username, role, created_at, password_changed_at FROM users
 WHERE GREATEST(
         COALESCE(password_changed_at, created_at),
         (SELECT updated_at FROM system_config WHERE config_key='password-policy')
       )
       < NOW() - (SELECT (config_value->>'passwordExpiryDays')::int FROM system_config WHERE config_key='password-policy') * INTERVAL '1 day';
```

## [Unreleased] — Rule chain + alarm tear-out (2026-05-17)

Branch: `RFID`. Single-bundle commit covering 8 phases. Plan: `tasks/REMOVE-RULECHAIN-ALARM-PLAN.md`. Pre-removal git tag: `pre-rulechain-alarm-drop`. Test counts: api **1080 / 22 / 8** (matches baseline 1233/22/8 minus ~153 deleted rule-chain/alarm test cases — zero new failures). Web build clean (12.78s).

### Scope removed
- **5 Prisma models**: `RuleChain`, `RuleChainVersion`, `RuleNode`, `RuleNodeConnection`, `Alarm` — dropped via `prisma/migrations/20260517100000_remove_rule_chain_and_alarms/migration.sql`
- **3 columns on retained tables**: `asset_templates.{default_rule_chain_id, alarm_rules}`, `notification_logs.{rule_chain_id, alarm_id}`
- **API source**: whole `apps/api/src/modules/rule-chain/` dir (22 files: engine, 77 node types across 8 categories, default-chain-builder, debug-recorder, routes, types, registry, tests); `queries/alarm.routes.ts`; `config/static-routes/alarm-columns.routes.ts`; `config/defs/alarm-columns.def.ts`; `e2e/rule-chains.test.ts`
- **Web source**: whole `apps/web/src/routes/rule-chains/` (12 files: visual editor, palette, node config, dialogs); `routes/alarms/index.tsx`; `routes/config/alarm-columns.tsx`
- **Shared package**: 7 permissions (`RULE_CHAIN_*` × 4, `ALARM_*` × 3), 7 feature privileges, 5 reauth actions (`ACKNOWLEDGE_ALARM`, `CLEAR_ALARM`, `CREATE/UPDATE/DELETE_RULE_CHAIN`), 2 sidebar items, both `FEATURE_TO_PERMISSION_MAP` blocks, both REAUTH categories, `types/alarm-columns.ts`, `ALARM_RULE_TYPES`/`ALARM_SEVERITIES` constants, `alarmRules` schema field
- **Cross-module surgery**: data-ingestion Stages 7 + 8 (rule-chain execution + alarm dispatch) + `evaluateTemplateAlarmRules` + `createAlarm`; DLQ overflow alarm branch; notification-dispatcher event labels/fields/templates for `RULE_CHAIN_TRIGGERED` + `ALARM_*`; `buildAlarmVariables` / `buildRuleChainVariables` in template-engine; `ruleChainId`/`alarmId` from `NotificationPayload`; `defaultRuleChainId` from MQTT handler + asset-template service/repo/routes; `alarms` from queries export + retention + UNS topic suffix; `alarm_table` from dashboard widgets; super-admin alarm CRUD; deployment-check schema-health probe; `notification.worker.ts` collapsed to no-op drain
- **Seed**: 6 role permission arrays (SUPER_ADMIN through VIEWER), 11 alarm `FLD_ALARM_*` field-IDs, 5 `rule_engine.*` config rows, `pipeline.dlq_alarm_threshold`, 7 help articles
- **Runtime DB rows** (`scripts/remove-rulechain-alarm-runtime-cleanup.sql`): 3 stale `roles.permissions` JSONB arrays, 1 stale `role_configs.sidebar_items`, 1 orphan `system_config.alarm-columns` row
- **Queue package**: `JOB_PRIORITY.ALARM_PROCESSING` constant; `notificationJobSchema.alarmId`; `'alarms'` from `exportJobSchema.exportType` enum

### Retained (21 CFR §11 contract)
- `packages/shared/src/types/audit-actions.ts`: `ALARM_CREATED/ACKNOWLEDGED/CLEARED/ESCALATED`, `RULE_CHAIN_CREATED/UPDATED/DELETED/SET_ROOT/IMPORTED` — marked "no longer emitted as of 2026-05-17", kept for historic-row rendering and inspector reference
- `packages/shared/src/types/audit-templates.ts`: matching template strings
- `audit_trail` rows referencing deleted UUIDs (4 historic rows in JSON details) — hash chain unbroken; UUIDs become orphan references per user "hard delete" decision
- `notification_logs.triggeredBy` historic strings (`'alarm'`, `'rule-chain'`) — column is VARCHAR not enum; no decoder breaks

### Out of scope (filter cleaning-cycle pipeline)
The cleaning-cycle pipeline (`cleaning-profiles/`, `filter-operations/`) is an independent node-based system (STAGE / CHECKLIST nodes via ReactFlow). Zero refs to RuleChain. Unaffected by this tear-out.

## [Unreleased] — P0 compliance branch close (2026-05-04)

Branch: `fix/p0-compliance-2026-05-04` — 12 commits closing 8 of 9 P0 audit findings from `tasks/CODE-REVIEW-2026-05-04-summary.md` plus follow-up cleanup. Test counts: api **1277 / 0 failed / 8 skipped** (was 1249), web **104 / 104**.

### Worst-impact bug closed (independently flagged by 2 reviewers)

`a139fcb` — **HMAC-signed offline-replay grant replaces unauthenticated `x-offline-replay: true` header bypass**. New `apps/api/src/lib/offline-replay-token.ts` (jose HS256, dedicated `OFFLINE_REPLAY_SECRET`); new `POST /api/auth/offline-grant` requires password (NOT routed through configurable reauth registry); auth plugin verifies grant + decorates `req.offlineReplayVerified`. Bare legacy header returns 401 `OFFLINE_REPLAY_HEADER_DEPRECATED`. FE login fetches grant, sync-engine forwards as `x-offline-replay-token`. Tablet upgrade requires single re-login per device.

### 21 CFR Part 11 audit-trail integrity

- `7dc339c` — **Tamper-evident audit hash chain**. Schema: `audit_trail.previous_checksum` + `chain_position BIGSERIAL`. Write path: `pg_advisory_xact_lock` + chained `$executeRaw`. New `GET /api/audit/verify-chain` (SUPER_ADMIN). Detects in-place mutation, insertion, gap. Backup repository stringifies BigInt for JSON. ingestion.service routes through `auditLog()`.
- `f6d1282` — **Bounded `offlinePerformedAt`**: tablet wall-clock stays source of truth (replay-only), but server validates: max 5min future skew, max 30 days stale, must be ≥ cycle.startedAt. New `OfflineTimeError` → HTTP 400. Wired into start-cycle, advance, submit-checklist; parity for bypass + terminate-cycle in `48b1320`.
- `679e642` — **Backup chain-verify on restore**: `restoreFromBackup()` walks the backup's audit_trail and verifies chain integrity BEFORE installing. Tampered backups return 400 `BACKUP_AUDIT_CHAIN_INVALID`. Operator opts in via `force=true` form field — audited as `forced=true` on `BACKUP_RESTORED` row.

### Privilege-escalation + reauth-coverage fixes

- `7e5839a` — Renamed `'admin_requests.view'` privilege from `USER_CREATE` → new `ADMIN_REQUEST_REVIEW` permission. Added `UPDATE_EMAIL_CONFIG` + `UPDATE_SMS_CONFIG` to `REAUTH_ACTIONS` (notification-delivery routes referenced non-existent keys → step-up auth was silently disabled). Fixed start-cycle race (`SELECT ... FOR UPDATE`). Fixed submit-checklist null-state false 409 (`equals: null` instead of `undefined`).
- `b8fb038` — Wrapped `reauth.execute()` on 6 FE skip sites: approvals (block-change), mobile-wrapper (block-change + RFID), config/equipment-groups, rule-chains/editor (toggle + name), config/action-reauth save itself (new `UPDATE_REAUTH_CONFIG` action — closes the meta-policy escalation: anyone with CONFIG_UPDATE could disable reauth on DELETE_USER then delete users).
- `2596196` — 4 sensitive-config surfaces: access-matrix (`UPDATE_ROLE_CONFIG`), ldap (`UPDATE_LDAP_CONFIG`), audit deletion single + bulk (distinct `DELETE_AUDIT_RECORD` + `BULK_DELETE_AUDIT_RECORDS` so collapsing many rows under one challenge isn't possible). Added 15 missing `PERMISSION_META` entries (perms previously rendered as "Other" with raw key in role-edit UI). Removed stale `organizations` SIDEBAR_PRIVILEGE_MAP entry + 4 dead files.
- `48b1320` — Template-kinds CRUD reauth (`CREATE/UPDATE/DELETE_TEMPLATE_KIND` — controlled-vocabulary edits cascade across every entity using the kind). Extracted `useBlockChangeApproval` hook so `approvals/index.tsx` and `mobile-wrapper.tsx` can't drift again (the bug they shared in `b8fb038` is exactly the failure mode the "tablet must NOT have a separate implementation" rule exists to prevent).

### Reports + offline + JWT plumbing

- `679e642` — `POST /api/reports/generate` rejects unknown entity IDs in `entitySlots` (HTTP 404 + slot name). Stops UUID-existence probing.
- `d685e1e` — Drop `navigator.onLine` residue from offline-store + sync-since (Capacitor connectivity engine was being defeated). Surface partial-sync failures via new `SyncProgress.partialFailures` field — operator sees "Synced with warnings: …" instead of misleading green check.
- `d322fc7` — Centralize JWT refresh via new `apiClient.refreshToken()` with in-flight Promise guard. The 30-min interval refresher in use-auth.ts had been a silent no-op on Capacitor APK (raw fetch with relative URL hit WebView origin, not the API host).

### Compliance invariants → migration

`17950db` — Moved 4 invariants from `prisma/sql/invariants.sql` (only run by seed.ts) to dedicated `20260504190000_compliance_invariants/migration.sql`: 1-IN_PROGRESS-per-filter unique partial index, filter_event ↔ cycle.filter_id consistency trigger, asset_relationship bidirectional-pair constraint trigger, audit_trail no-delete trigger. Idempotent. A `prisma migrate deploy`-only production cutover would have shipped without 21 CFR Part 11 invariant enforcement.

### Operator runbook

`17950db` (DEPLOY-WINDOWS § 10.3) documents: new `OFFLINE_REPLAY_SECRET` env var (required in production), the two new migrations to apply, single re-login per tablet after upgrade (queues then drain), `GET /api/audit/verify-chain` runbook, `offlinePerformedAt` server-side validation policy, `ADMIN_REQUEST_REVIEW` privilege rename.

### Still pending (NOT closed by this branch)

- **P0 #5** — UI for `/bypass` + `/terminate-cycle` (UX placement decision; backend ready)
- 5 lower-blast config surfaces still unprotected: `notification-rules`, `dashboard-cards`, `cleaning-profile-assignment`, `filter-cleaning-reasons`, `notification-settings/email-settings` page-level wrap, `ahu-filter-set-config`, `checklist-form` signature flow
- PWA `skipWaiting` + reload-prompt (operators submit stale contracts post-deploy)
- Decision-tape `tapeVersion` integer overflow at 1e6 events/cycle
- RBAC caching (4 sequential queries before every handler)
- ~140 bare-string FKs (data-layer C3 — schema audit; orphan UnsMapping bug class)

---

## [Unreleased] — Wave 8a: § 11 follow-ups close (2026-05-03)

Final pass on `PHASE_5_RECENT_WORK.md § 11` outstanding work. Six parallel agents (Y/Z/AA/AB/AC/AD) closed three remaining items in a single dispatch.

### `8694435` — DEPLOY-WINDOWS.md Phase 8.7 release notes

New section 10 (+60 lines, 403→463) documents two operational items from the 8.7 carried-forward list:
- **10.1 Drift catch-up migration** requires `npx prisma migrate resolve --applied 20260503162127_capture_schema_vs_db_drift` BEFORE any future `migrate deploy` on populated DBs (greenfield is unaffected). Failure modes: `filter_cleaning_profiles.lineage_id NOT NULL`, `asset_instances` column drops. Recommended path: pg_dump → resolve → deploy.
- **10.2 Offline-queue replay tapeVersion=null failures** expected after upgrade. Pre-8.7 IDB ops with `tapeVersion: null` will 400 on first sync; sync-engine marks them failed. Operator guidance: failed actions did NOT execute, must be re-performed; clean rollout = drain queues under old APK first; no server-side workaround by design.

Forward-pointer added in section 9 step 4; 2 new troubleshooting-table rows added in section 11. Sections 10/11/12 → 11/12/13 renumber.

### `d660daf` — Multi-filter batch checklist dialog cycles through every pending filter

Closes the § 11 known follow-up "Multi-filter batch checklist dialog — currently opens for first item only (session 04-20 known follow-up)". **21 CFR Part 11 risk** closed: filters B/C/... in a batch were silently skipping their pending CHECKLIST gates after the first dialog submitted.

Fix existed on BOTH desktop AND mobile (per the per-page parity rule from `feedback_batch_single_parity.md`). New shared helper `apps/web/src/lib/filter-ops/next-pending-checklist.ts` walks the batch and returns `{item, checklists, remaining} | null`. Each page tracks the remainder in a NEW state (mobile: `pendingChecklistBatch`; desktop: `postAdvanceChecklistQueue` — separate from the existing `pendingBatch` shared-answer-set path so BATCH MODE stays byte-identical). After each `handleChecklistSubmit`, the page cycles to the next pending dialog. 7 new unit tests on the helper.

### `859492e3` — Phase 2/3/4/5 e2e route-layer suites

Closes the § 11 outstanding work "tests/manual-test-cases/ was deleted in the documentation cleanup. Need fresh cases for filter operations, RFID, offline replay, reports, block-change approval, PM My Tasks, admin requests." Replaced markdown manual-test recipes with executable vitest e2e suites — 4 new files, 29 new tests:

- **phase2-filter-operations.test.ts** (10) — start-cycle / advance / submit-checklist / bypass / terminate-cycle / getCurrentState shape on the wire. Hybrid pattern: real auth + MOCKED service layer = zero DB pollution. Phase 8.7 invariants (legacy fields stripped, tapeVersion required) verified at the route layer. Service-layer concurrency NOT duplicated (covered by `concurrent-operator.test.ts`).
- **phase3-rfid-offline.test.ts** (7, 6 active + 1 skip) — identifier lookup/create/delete/conflict + offline-replay header skips reauth. Real route paths discovered: `GET /api/assets/identifiers/lookup/:value`, `POST /api/assets/identifiers`, `DELETE /api/assets/identifiers/:id` (NOT `/api/identifiers` as planned). Header literal: `'x-offline-replay': 'true'` (string).
- **phase4-perms-themes-reports.test.ts** (8, 6 active + 2 skips) — VIEWER/OPERATOR perm-gate proofs + report-settings/branding/registry. Surfaced **pre-existing PUT report-settings 404 bug**: `hasCustomPage:true` skips `dynamic-routes.ts` PUT wiring, but no static route exists; FE writes silently fail. Flagged for follow-up.
- **phase5-decision-tape-backup.test.ts** (7) — Phase 8.7 invariants verified end-to-end + backup export/validate round-trip + `/sync/since` 6-entity hydration (incl. ChecklistProfile + AssetTemplate hydrated by 8.7 commit `d31f5d2`). Real route paths: `/api/backup/{export,validate,restore}` (NOT `/api/system/backup`). Used unique `P5<suffix>` SUPER_ADMIN test user to avoid SESSION_INVALID race against shared `admin` user when local dev server contends with the test runner.

### Test counts (single-fork mode — only stable mode per AA's findings)

- **Before Wave 8a:** api 1202 / 2 / 6 (1210)
- **After Wave 8a:**  api 1231 / 2 / 9 (1242) — net +29 from 4 e2e files; same 2 pre-existing failures unchanged.
- **Web:** 84 → 91 (+7 from Y's `next-pending-checklist` helper unit tests)
- **Shared:** 305/306 unchanged.

### Stability note

Full-suite default-pool runs are **flaky** due to shared `admin` test-user contention across worker processes. The verified count requires `--pool=forks --poolOptions.forks.singleFork=true`. This is a pre-existing infra issue surfaced (but not introduced) by the new e2e files.

### Closes (all carried-forward items from § 11)

- ✅ "Phase 2/3/4/5 manual test cases" — replaced with executable e2e suites in `859492e3`
- ✅ "Multi-filter batch checklist dialog opens for first item only" — fixed on both desktop + mobile in `d660daf`
- ✅ Drift migration `migrate resolve` operator guidance — added in `8694435`
- ✅ Tombstone-replay tapeVersion=null operator guidance — added in `8694435`

### New pre-existing flags surfaced (not fixed)

- PUT `/api/config/dynamic/report-settings` returns 404 — `report-settings.def.ts` has `hasCustomPage:true` so `dynamic-routes.ts` skips a generic PUT but no `static-routes/report-settings.routes.ts` exists. Flagged in `859492e3` for follow-up.

### Carried forward (out of scope for this session)

- Phase 8.8 (APK rebuild + tablet field QA) — APK was rebuilt this session; install + field QA still requires physical tablets per `tasks/PLAN-2026-05-02-step8.8-apk-field-qa.md`.
- Browser smoke (Wave 6 O) — needs Vite dev server restart from this worktree (currently running stale build from main checkout).
- Pre-existing flags from prior splits (telemetry-row JSX-escape, dead `useDatetimeFormat`, etc. — listed in `4036336`/`26d61d0`/`4aa5a27` commit messages).

---

## [Unreleased] — Wave 7: P0.2 monster-file decomposition closes (2026-05-03)

Closes the last open item from the bloat audit (`PHASE_5_RECENT_WORK.md § 11 P0.2`). All 8 monster files (1000+ LOC) decomposed into 78+ cohesive modules across 9 commits via parallel + sequential subagent dispatch (waves 7a/7b/7c). **Façade pattern throughout** — every original file path keeps its public export(s) so consumers (`main.tsx` lazy-loads + downstream imports) resolve unchanged. Zero behavior change verified by full-suite parity at every commit.

### What landed (9 commits, 78+ new modules, 7 monster files reduced)

| Commit | File(s) | Was → Orchestrator | Strategy |
|---|---|---|---|
| `de54329` | `apps/web/src/routes/checklist-form/index.tsx` | 1561 → 507 | 8 sub-components + types + helpers |
| `66cc80d` | `apps/api/src/modules/pm-schedules/pm-schedule.service.ts` | 1042 → 120 | 7 domain modules + 2 leaf (`crud`, `executions`, `due-tasks`, `import`, `ahu-config`, `approval`, `shared`, `types`); `delete` → `remove` (JS reserved word at fn-decl) |
| `3b0346f` | `apps/web/src/routes/debug/index.tsx` | 1145 → 648 | 5 sub-components + types + helpers; agent correctly rejected the brief's "tabs" hypothesis (file is single linear page) |
| `cfc78fb` | `apps/api/src/modules/filter-operations/filter-operations.service.ts` | 2119 → 599 | `helpers` + `filter-resolver` + `current-state` + `cycle-write/{locking,start-cycle,advance,bypass,submit-checklist,terminate-cycle}`; SHARED `lockAndVerifyFilterState` helper DRYs the 4 writes; **all Phase 8.7 invariants verified preserved** (no TAPE_PARALLEL gate, no deprecated fields in getCurrentState, all 4 writes still SELECT FOR UPDATE + STATE_CHANGED + CYCLE_CHANGED) |
| `7edacc1` | desktop `filter-operations.tsx` + mobile `mobile-operations.tsx` | 4567 → 4396 (combined) | Coordinated split — kept as sibling presentations; extracted shared LOGIC into `apps/web/src/lib/filter-ops/{types, validate-offline-gate, resolve-pending-checklist, use-dryer-countdown, index}`. **Drift-prevention map in commit message** tells future maintainers exactly which module owns each bug class |
| `e825e9b` | `apps/web/src/routes/filter-management/filter-list.tsx` | 2535 → 1633 | 16 modules under `filter-list/` (constants + types + 1 component + 13 dialogs/panels); 6 pre-existing dead-code flags surfaced |
| `26d61d0` | `apps/web/src/routes/assets/components/template-form-editor.tsx` | 1102 → 448 | 8 row sub-components — cleanest split of the wave (every row had clean `{value, idx, onUpdate, onRemove}` interface); flagged 1 pre-existing JSX-escape bug in telemetry-row placeholder |
| `4036336` | `apps/web/src/routes/assets/templates.tsx` | 1166 → 463 | 12 modules under `templates-list/` (5 components + 3 dialogs + 1 hook + 3 lib); two-phase agent dispatch (V extracted modules but timed out before wire-up; V2 finished — combined into one commit since the modules-without-wire-up are dead code) |
| `4aa5a27` | `apps/web/src/routes/rule-chains/editor.tsx` | 2140 → 971 | 9 modules under `editor/`; brief's "77-case switch" assumption corrected — `NodeConfigPanel` is generic schema-driven (iterates `configSchema`, dispatches on `fieldDef.type`); single-file extraction of the 571-LOC panel was correct vs. fragmenting the iteration loop. Removed one provably-dead `useCallback` (the only behavioral-equivalent simplification across all 9 commits) |

### Tests — all suites preserved exactly through every split

- **api:** 1202/1210 passing (2 known unrelated failures, 6 documented skips). Net Δ from pre-Wave-7: 0.
- **web:** 84/84 passing.
- **shared:** 305/306 passing (1 known unrelated failure).
- **TypeScript:** clean across `apps/api`, `apps/web`, `packages/shared` after every split.

### Per-split discipline (codified across all 9 commit messages)

- Each split uses **façade pattern** — orchestrator file stays at its original path, becomes a thin re-exporter; consumers' imports never change
- Each split honors **"no behavioral change"** — byte-equivalent runtime behavior verified by full test-suite parity
- Each commit message **lists what stayed inline + why** — typically state/handlers/state-coupled JSX where extracting would drill 10+ props through a single-use component (per advisor + agent T's playbook). The orchestrators are intentionally NOT minimized at the cost of cohesion
- Each commit message **surfaces pre-existing dead code or oddities** found during the split for a future cleanup pass — not fixed under the no-behavior-change constraint
- Coordinated splits (filter-ops desktop+mobile) include a **drift-prevention table** mapping bug classes to the shared module that owns them

### Closes

- ✅ "P0.2 — split monster files (the only bloat-audit item still open)" — all 8 files done; PHASE_5_RECENT_WORK.md § 11 entry struck through

### Carried forward

- 6 pre-existing dead-code flags from `e825e9b` (filter-list) — `templateFieldKeys` unused, `createFilterProfile` stub, dead `enrichedFilters` fields, `closePanel` referenced before declaration, etc.
- 1 pre-existing JSX-escape bug from `26d61d0` (template-editor) — `telemetry-row.tsx` placeholder uses literal `°` instead of `°`
- 4 pre-existing oddities from `4aa5a27` (rule-chains editor) — dead `useDatetimeFormat` destructure, superfluous `doSave` deps, unused `fieldKey` prop on `RuleChainSelectField`, unused `_backendData` extension on Node
- 1 pre-existing pagination-prop semantic from `4036336` (templates) — `templatesRes.page` vs local `page` for displayed Page-X-of-Y text

These all originated in the pre-Wave-7 monoliths; the splits surfaced them for visibility but explicitly did not fix them per the discipline rule.

---

## [Unreleased] — Step 8 Phase 8.7 follow-ups (2026-05-03)

Three follow-ups landed after the 8.7 cutover, closing every audit-flagged risk that didn't strictly need physical tablets. Single-day batch dispatched as 3 parallel agents (K + L + M).

### `b955059` — bypass + terminateCycle now serialize with row locks

Closes the two existing-risk items Phase 8.7's concurrent-operator audit flagged (tasks/AUDIT-2026-05-02-concurrent-operator.md lines 83-93 and the bypass cycle-id gap). Brings both write methods to full parity with `advance()` — every cycle-bound write now does pre-txn state snapshot + in-txn `SELECT ... FOR UPDATE` + 409 STATE_CHANGED + 409 CYCLE_CHANGED.

Before this commit, two collision shapes were silently accepted:
- `terminateCycle` had NO row lock at all (transaction-wrapped only) and NO state/cycle recheck — operator A could terminate cycle X while operator B was already terminating it; the second termination wrote against the post-first-termination row.
- `bypass` had a SELECT FOR UPDATE on filter_details but only checked `current_lifecycle_state` — a cycle-id swap behind a bypass write silently recorded BYPASS_DEVIATION against the pre-lock cycle.

3 previously-skipped concurrent-operator tests now pass: `bypass > CYCLE_CHANGED`, `terminateCycle > STATE_CHANGED`, `terminateCycle > CYCLE_CHANGED`. Bonus mock fix in `tape-version-check.test.ts` so 2 unrelated tests don't regress (`tx.$queryRaw` is now called inside terminateCycle).

### `11b4b82` — cycle-tombstone replay sends justification + tapeVersion

Two bugs in the cycle-tombstone replay path at `sync-engine.ts:163` — both would 400 against the live server, both moot in practice because the path has zero live callers (UI uses operations store, not tombstones store):

1. **Wrong field name.** The replay sent `{ reason, clientOpId }` but the server's `/terminate-cycle` route requires `justification`, not `reason`. Pre-Phase-8.7 this would 400 with "missing justification".
2. **Missing tapeVersion.** After `f8fae1d` tightened tapeVersion to required, the same dead-code path would 400 with "missing tapeVersion".

Fix: `Tombstone` interface gains optional `tapeVersion?: number | null`; replay forwards `justification` (preferred) or maps legacy `payload.reason` for backward compat; tapeVersion forwarded conditionally. No IDB schema bump needed — zero on-disk tombstone rows exist.

2 new web tests cover both paths (with-tapeVersion forwards correctly, null tapeVersion documents the migration cost — would 400 SCHEMA_ERROR).

### `11095ad` — gitignore root-level test/QA PNG droppings + backups/

Closes the "P3.2 / Root working-tree noise" follow-ups documented in `PHASE_5_RECENT_WORK.md` § 11. The main checkout has 109 untracked PNGs at the repo root from prior sessions (`bug-fix-*.png`, `bug-sweep-*.png`, `mt-removal-*.png`, `step1-*.png`, etc.) that pollute every `git status`. New patterns: `/*.png` (root-anchored — 50+ tracked PNGs under `PROJECT_HANDOVER/diagrams/`, `apps/`, `RFID/`, `old/screenshots/` are unaffected) and `/backups/`.

### Tests (post-Wave-5)

- **api:** 1199 → 1202 passing (+3 from K's newly-active concurrent-operator tests). 2 pre-existing failures unchanged. 9 → 6 skipped.
- **web:** 82 → 84 passing (+2 from L's tombstone tests).
- **shared:** 305/306 unchanged.
- TypeScript: clean across all 3 packages.

### Closes (carried-forward from 8.7 follow-up list)

- ✅ "`terminateCycle` lacks SELECT FOR UPDATE + post-lock state recheck" — `b955059`
- ✅ "`bypass` doesn't recheck `current_cycle_id` inside its lock" — `b955059`
- ✅ "terminate-cycle tombstone path doesn't carry tapeVersion" — `11b4b82` (also caught a separate field-name bug)
- ✅ "Root working-tree noise — test PNGs, `.playwright-mcp/`, `backups/` not gitignored" — `11095ad`

### Out of scope (still carried forward)

- Pre-Wave-2 IDB-queued ops with `tapeVersion: null` will 400 on replay (sync-engine marks them failed). Documented migration cost.
- Drift migration `20260503162127_capture_schema_vs_db_drift` is fresh-DB-only as written. Populated environments need `prisma migrate resolve --applied` instead of `migrate deploy`.
- Phase 8.8 (APK rebuild + tablet field QA) — needs physical tablets per `tasks/PLAN-2026-05-02-step8.8-apk-field-qa.md`.

---

## [Unreleased] — Step 8 Phase 8.7: cutover complete (2026-05-03)

Branch: `feature/phase5-verification`. Removes the dual-emit / flag-gated transition into the decision-tape architecture. Server now always emits `actions[]` + `tapeVersion`; the deprecated `nextAllowedStages` / `pendingChecklist` derived fields are gone from the `getCurrentState()` response and from the 4 cycle-bound write responses. FE consumes only the action tape. Pipeline-walking drift between client and server is now structurally impossible. **One app-visible enforcement change**: the 4 write routes (advance, submit-checklist, bypass, terminate-cycle) now require `tapeVersion` in the request body — they return 400 if missing, 409 STALE_TAPE if mismatched. FE plumbing was audited end-to-end and every caller confirmed sending it.

### What landed

#### Wave 1 — independent foundations (4 commits, parallel agents)

- **`1033aca`** — `apps/api/prisma/migrations/20260503162127_capture_schema_vs_db_drift/migration.sql` (NEW, 467 lines). Captures the schema-vs-migration drift the team accumulated via `prisma db push` between ~2026-04 and 2026-05-02 (Kind B drift from `tasks/MIGRATION-DRIFT-2026-05-02.md` § 3). Generated by `prisma migrate diff --from-migrations --to-schema-datamodel --script` against a transient shadow DB (subsequently dropped — no live DB mutated). Coverage: 4 new enums, 2 trimmed enums (MT removal), DROP organizations + 10 organizationId column/FK/index sites, 10 new tables (template_kinds, filter_details, filter_profile_*, equipment_group_versions, checklist_profile_versions, report_*), ~25 indexes + ~20 FKs. Header documents the fresh-DB-only constraint and the `prisma migrate resolve --applied` workaround for environments populated via `db push`. `invariants.sql` NOT folded in (Prisma cannot emit triggers/partial-unique-indexes from the schema; separate concern). Verification: re-running diff produced "-- This is an empty migration."

- **`d31f5d2`** — `apps/api/src/modules/sync/{sync.service.ts, routes.ts, __tests__/sync.service.test.ts}`. Closes the 8.4b deferred follow-up: `ChecklistProfile` (with `questions` inlined, `orderBy sortOrder`) and `AssetTemplate` (verbatim passthrough) now populate on `GET /api/sync/since` instead of returning `[]`. Same per-entity cursor + 500-row pagination + `Promise.all` pattern as the existing 4 entities. 6 entities, all required in the response schema. Tests: 17 service + 3 route = 20 (was 16). FE consumer at `apps/web/src/lib/sync-since.ts` already calls `cacheEntities` for both — populated arrays land in IDB on next poll automatically.

- **`1fa84b5`** — `apps/web/src/routes/filter-management/filter-operations.tsx` (desktop) deprecated reads → 0. New helpers added in `apps/web/src/lib/offline-cache.ts`: `cacheServerStateResponse(filterId, st, ttlMs?)` (encapsulates the cache row write so legacy field names live in one shared lib), `getCachedPendingChecklists(filterId)` (cache-row read fallback), `dialogChecklistsFromActions(actions)` (converts SUBMIT_CHECKLIST tape entries into ChecklistDialog's `PendingChecklist[]` shape). 18 deprecated read sites switched to `actionsForStage()` + `getCurrentActions()` (3-tier fallback) + `hasActionKind`.

- **`2521aad`** — `apps/web/src/routes/mobile/mobile-operations.tsx` deprecated code reads → 0 (using D's helpers). 9 grep hits remain post-cleanup = 7 explanatory comments + 2 spec-mandated cache writes (the L1307 two-phase write pattern that `local-context.ts:466` depends on for `CHECKLIST_COMPLETED` synthesis offline; preserved verbatim with surrounding rationale).

#### Wave 2 — server cutover (1 commit, single agent)

- **`f8fae1d`** — `apps/api/src/modules/filter-operations/{filter-operations.service.ts, routes.ts, tape/__tests__/tape-parity.test.ts, __tests__/get-current-state.test.ts}`. Five coupled cuts:
  1. **TAPE_PARALLEL flag removed** — `actions[]` always emitted from `getCurrentState()`. `process.env.TAPE_PARALLEL` references in `apps/api`: 0. `tape-parity.test.ts` rewritten (option 1, advisor-confirmed): same 8 tests, no env-flag setup, asserts the tape contract directly.
  2. **`nextAllowedStages` + `pendingChecklist` dropped** from the `getCurrentState` response and Fastify response schema.
  3. **`tapeVersion` tightened to required** on the 4 cycle-bound write request schemas (`/advance`, `/submit-checklist`, `/bypass`, `/terminate-cycle`). `/start-cycle` deliberately untouched (no tapeVersion concept until cycle exists).
  4. **`actions[]` + `tapeVersion` added** to the 4 POST write-route response schemas (per agent E's discovery — they emitted `pendingChecklist` but not `actions[]`). Service computes the post-write tape via the same generator path.
  5. **`pendingChecklist` dropped** from those 4 POST response schemas.

  Test changes: `get-current-state.test.ts` mocks expanded with `filterEvent.findMany`/`count` (now always called because tape generation is unconditional). `tape-version-check.test.ts` left untouched — the route-schema gate enforces required, the service still tolerates `undefined`.

#### Wave 3 — verification (2 commits, parallel agents)

- **`73a5f44`** — NEW `apps/api/src/modules/filter-operations/__tests__/concurrent-operator.test.ts` (508 lines, 9 active + 9 documented skips). Closes the "coordinated full smoke test: concurrent-operator scenarios" gap. Drives off `tasks/AUDIT-2026-05-02-concurrent-operator.md`. Active coverage: STALE_TAPE on all 4 methods, STATE_CHANGED on advance + bypass, CYCLE_CHANGED on advance, ALREADY_SUBMITTED on submitChecklist, plus a happy-path control. Skips document why each missing combination is intentional vs. needing real-DB scaffolding. **Two existing risks surfaced (NOT 8.7 regressions, flagged for follow-up)**: (1) `terminateCycle` lacks SELECT FOR UPDATE + post-lock state recheck — audit lines 83-87 / 92-93 — needs integration test before relying on "low frequency" claim under tablet load; (2) `bypass` does not recheck `current_cycle_id` inside its lock — a cycle-id swap behind a bypass write is silently accepted; tighten if cycle-swap-during-bypass becomes live risk.

- **`28e574c`** — `apps/web/src/{hooks/use-offline.ts, lib/sync-engine.ts, routes/filter-management/filter-operations.tsx}`. After Wave 2 tightened `tapeVersion` to required, every cycle-bound FE caller was audited for plumbing. Three gaps fixed: (a) `executeOrQueue()` rewritten to read `tapeVersion` from cached `filter-state-{filterId}` row for cycle-bound types and merge into both online payloads and queued offline ops; (b) `sync-engine.ts` start-and-advance replay fetches `/current-state` between the two POSTs to send fresh tapeVersion; (c) direct WASH_IN online start-cycle→advance pair in `filter-operations.tsx` does the same. All 9 cycle-bound caller sites confirmed sending `tapeVersion`. **One pre-existing limitation flagged**: terminate-cycle tombstone path (`sync-engine.ts:163`) sends `{reason, clientOpId}` only and would 400 on replay against the now-required schema; orthogonal tombstone-shape work for follow-up.

### Tests

- **api:** 1186 → 1199 passing (+13: +9 from concurrent-operator G, +4 from get-current-state mock expansion in F). Same 2 pre-existing failures unchanged (`auth.test forgot-password`, `config.test PUT action-reauth`). 9 documented skips.
- **web:** 82/82 passing (no FE test files added — caller plumbing was a pure refactor; existing tests still cover the dispatcher).
- **shared:** 305/306 passing (1 pre-existing failure unchanged: `assetQuerySchema rejects limit over 100`).
- TypeScript: clean across `apps/api`, `apps/web`, `packages/shared`.

### Closes

- ✅ "TAPE_PARALLEL flag still on parallel-validation" (deferred follow-up #8.7) — flag removed in `f8fae1d`
- ✅ "`tapeVersion` still optional on 4 write routes" (deferred #8.7) — tightened in `f8fae1d`; FE plumbing audited in `28e574c`
- ✅ "`nextAllowedStages` / `pendingChecklist` still in getCurrentState" (deferred #8.7) — both gone in `f8fae1d`
- ✅ "8.4b ChecklistProfile + AssetTemplate hydration in /sync/since" (deferred 8.5/8.6) — landed in `d31f5d2`
- ✅ "Migration-drift remediation plan" (deferred #8.7) — captured in `1033aca`
- ✅ "Smoke test drift on shared package" (deferred #8.6) — was already retired in 8.6 part 2
- ✅ "Server still has duplicate guard bodies" (deferred #8.6/#8.7) — closed by 8.6 part 2 + this cutover

### Out of scope (carried forward)

- Pre-Wave-2 IDB-queued rows with `tapeVersion: null` will 400 on replay (sync-engine marks them failed). Documented migration cost.
- terminate-cycle tombstone path (`sync-engine.ts:163`) doesn't carry `tapeVersion`; would 400 on replay against new required schema. Pre-existing tombstone-shape limitation, orthogonal to this cutover.
- `terminateCycle` lacks SELECT FOR UPDATE + post-lock state recheck (audit-flagged existing risk).
- `bypass` doesn't recheck `current_cycle_id` inside its lock (audit-flagged existing risk).
- Phase 8.8 (APK rebuild + tablet field QA) — needs physical tablets; plan ready at `tasks/PLAN-2026-05-02-step8.8-apk-field-qa.md`.

---

## [Unreleased] — Step 8 Phase 8.6: FE consumes shared executor (2026-05-02)

Branch: `feature/phase5-verification`. Wires the FE — both mobile and desktop filter-ops pages — into the shared executor that landed in Phase 8.5. The pure-function graph walkers (`computeNextStages`, `findChecklistsAfterStage`, the inline DFS inside `updateCachedStateAfterAdvance`) now delegate to `@digilog/shared` instead of re-implementing the same algorithm three times. Server / mobile / desktop now share one walker; any future bugfix lands once. **No app-visible behaviour changed** — same gates, same dialogs, same offline cache shape. Phase 8.7 owns the cutover that removes the deprecated `nextAllowedStages` / `pendingChecklist` fields from the server response.

### What landed

#### Commit 1 — FE local-context loader (commit `6653416`)

- **NEW** `apps/web/src/lib/local-context.ts` (398 lines) — `loadLocalContextFromCache(filterId)` reads from IDB v5 sync stores + the legacy `filter-state-{filterId}` cache + cached user from `localStorage.digilog_cached_user`, projects everything into the slice shapes the shared executor consumes (`ProfileSlice`, `CycleSlice`, `FilterSlice`, `EquipmentGroupSlice`, `ChecklistProfileSlice`, `FilterEventSlice`). Every entity falls back to a sentinel rather than throwing when its cache slot is missing, so callers can call the executor unconditionally.
- **Events synthesis** — the FE has no event stream (the `/api/filters/:id/current-state` response carries `pendingChecklist[]` as a derived field but no underlying events). The executor's `assertChecklistGatePassed` / `computeNextActions` checklistAnswered branch reads `events[]` for `CHECKLIST_COMPLETED` rows. Compromise: when cached `pendingChecklist === []` AND the profile has CHECKLIST nodes between `currentState` and the next STAGE, the loader synthesizes one `CHECKLIST_COMPLETED` event with `attributes.afterStage = currentState`. Without this, the gate would re-fire after the operator already cleared it offline. STATE_TRANSITION / CYCLE_STARTED events are NOT synthesized — none of the FE-invoked guards consume them; `filter.currentLifecycleState` is the source of truth.
- **stageLookup priority** — server-supplied `stageLookup` from the cached current-state response wins (B.7 contract); falls back to `buildStageLookup(profile)` from the shared executor when missing.
- **NEW** `apps/web/src/lib/__tests__/local-context.test.ts` — 14 unit tests across sentinel fallbacks, the three events-synthesis branches (no checklist node / pending non-empty / pending empty + chained CHECKLIST), equipment-group projection, server-stageLookup priority, cached-user reading, and end-to-end integration with `computeNextActions` (happy path + checklist-gate behaviour both ways).

#### Commit 2 — mobile-operations.tsx switch (commit `95b4575`)

- **EDIT** `apps/web/src/routes/mobile/mobile-operations.tsx` — converted the bodies of the two graph-walking helpers to delegate to the shared executor:
  - `computeNextStages()` Tier-2 fallback now calls `sharedFindReachable()` instead of an inline DFS.
  - `findChecklistsAfterStage()` Tier-2 fallback now calls `sharedCollectChecklistsAfterStage()` (chained CHECKLIST → CHECKLIST → STAGE walk lives in shared code).
- Tier-1 stageLookup branches preserved unchanged in both helpers (server-authoritative; never modified by 8.6).
- Imports `loadLocalContextFromCache` for use by future call sites; not yet wired into a gate decision because the converted helper bodies cover the gates in lockstep with shared code already.
- File delta: 2486 → 2456 lines (-30).
- **Why bodies converted instead of helpers deleted** (the audit's `-128 lines` plan): per-call-site shape contracts are consumed at 5+ places. Rewriting 5 call sites carries more drift risk than redirecting one helper body to shared code. The deprecated `nextAllowedStages` / `pendingChecklist` cache fields are deliberately preserved (8.7 cutover territory).

#### Commit 3 — filter-operations.tsx (desktop) switch (commit `e190415`)

- **EDIT** `apps/web/src/routes/filter-management/filter-operations.tsx` — same pattern as mobile:
  - `findChecklistsAfterStage()` body now calls `sharedCollectChecklistsAfterStage()`. **Side benefit:** the legacy desktop implementation only inspected direct outConns and silently skipped chained checklists (the bug operators reported as "checklist not coming at that stage"). Converting to shared closes that gap on desktop too.
  - The inline DFS inside `updateCachedStateAfterAdvance()` that built `nextAllowed` from the pipeline graph now calls `sharedFindReachable()`.
- File delta: 2088 → 2088 lines (19 insertions / 19 deletions).

#### Commit 4 — assertProfileActive fix + cleanup (commit `<this commit>`)

- **EDIT** `packages/shared/src/pipeline-executor/transitions.ts` — `assertProfileActive` now enforces both null-check AND `status === 'ACTIVE'`. The original Phase 8.5 implementation only null-checked, which forced `filter-operations.service.ts` to add a redundant manual `cp.status !== 'ACTIVE'` check immediately after every call (advance + bypass). The status check now lives in the shared guard so the contract is "active and ready" for both runtimes.
- **EDIT** `apps/api/src/modules/filter-operations/filter-operations.service.ts` — dropped 2 redundant manual `cp.status !== 'ACTIVE'` checks (advance line 1143, bypass line 1466). Both sites now rely on `assertProfileActive` for the status gate; the remaining `if (!cp)` is just a TS narrowing assertion.
- **EDIT** `packages/shared/src/pipeline-executor/__tests__/transitions.test.ts` — extended `assertProfileActive` test block from 2 cases (null + non-null) to 4 (added DRAFT and INACTIVE rejection cases).

### Tests

- **shared:** 303 → 305 (added 2 cases for the new `assertProfileActive` status branches). Same 1 pre-existing failure in `schemas/assets.test.ts > rejects limit over 100` predates this work.
- **api:** 1186 / 1188 (no change — same 2 pre-existing failures).
- **web:** 68 → 82 (added 14 cases for `loadLocalContextFromCache`).
- TypeScript: clean across `packages/shared`, `apps/api`, `apps/web`.

### Carried over from 8.5 (now closed)

- ✅ `assertProfileActive` rename / status fix — done in Commit 4 (status check added to the guard rather than rename).
- ✅ `advance()` profile resolution using `cycle.profileId` first — already silently improved in 8.5; documented in this entry for the record.

### Out of scope (deferred to 8.7+)

- Removing `nextAllowedStages` / `pendingChecklist` from `getCurrentState()` response — Phase 8.7 cutover.
- Removing the `TAPE_PARALLEL` flag and tightening `tapeVersion` to required — Phase 8.7.
- Deleting the legacy `offline-sync-service.ts` — blocked on 4 entities still uncovered by `/api/sync/since` (cleaning reasons, identifier map, PM tasks, checklist profiles full-questions). See `tasks/AUDIT-2026-05-02-offline-sync-legacy-deprecation.md`.
- APK rebuild + tablet field QA — Phase 8.8.

## [Unreleased] — Step 8 Phase 8.4: Option D foundation — versioned local cache + shared executor scaffold (2026-05-02)

Branch: `feature/phase5-verification`. The original 8.4 plan (delete the FE graph walker and switch FE to consume server `actions[]`) was reframed after a field-bucket audit on `mobile-operations.tsx` (2486 lines) + `filter-operations.tsx` (2088 lines) showed the cutover was a UX redesign + offline-state-machine rewrite, not a wiring change. The audit classified 48 guards across the 4 write methods as 35 Pure (73%) / 5 Hybrid (10%, already solved by 8.3 tapeVersion + clientOpId) / 8 Server-only (17%, concurrency control that can never move client-side). Conclusion: tablet should become a **versioned local replica** of the server's read model for the offline-relevant slice, with a **shared executor** running the same guard code on both sides. Drift becomes impossible by construction for the 35 pure guards; the 8 server-only guards stay server-side and surface their failures via the existing 8.3 STALE_TAPE / clientOpId reconciliation contract. **No app-visible behavior changed in 8.4** — additive plumbing only. The actual `TAPE_PARALLEL` flag flip + derived-field removal is now scheduled for Phase 8.7 (after 8.5 extraction + 8.6 FE consumption).

### Architecture pivot (Option D)

- **NEW** `tasks/PLAN-2026-05-02-step8-OPTION-D.md` — canonical Step 8 plan (~12 days focused work, 8.4 → 8.8 phase plan, 8 acceptance criteria). Original `tasks/PLAN-2026-05-02-step8-decision-tape.md` is superseded but kept for history.
- **NEW** `tasks/INVENTORY-2026-05-02-step8.5-guards.md` — full enumeration of 48 guards (file:line, LocalContext inputs, output shape, target shared function name). Drives the 8.5 extraction work.

### 8.4a — ChecklistProfile snapshot-then-bump regression gate (commit `f63207c`)

- **NEW** `apps/api/src/modules/checklist-profile/__tests__/checklist-profile.service.test.ts` — 3 tests against mocked prisma + tx (mirrors `filter-operations/__tests__/get-current-state.test.ts` pattern). `create()` leaves profile at version=1 with NO sidecar row (lazy first-version), `update()` archives the OUTGOING snapshot to `ChecklistProfileVersion` then increments inside the same transaction, `addQuestion()` runs snapshot-then-bump on the question-mutation path that drives offline checklist replay. Schema + service-layer versioning was already shipped in Phase A.1 (2026-05-01); this commit just adds the regression gate that 8.4b's local cache depends on.
- AssetTemplate already had equivalent coverage in `template.service.test.ts` (lines 63 + 87) — verified passing.

### 8.4b — `/api/sync/since` server endpoint + FE consumer + IDB v5 stores

#### Server (commit `a6ec6e8`)
- **NEW** `apps/api/src/modules/sync/sync.service.ts` (223 lines) — `SyncService.since()` with `Promise.all` over 4 entity queries (FilterCleaningProfile, FilterProfile, EquipmentGroup, AssetInstance + FilterDetails). Per-entity version cursors (`gt: clientVersion`); Filter rows use `updatedAt` watermark since `AssetInstance` has no version column (query OR's `FilterDetails.updatedAt` so a sidecar-only update still surfaces). 500-row pagination cap per entity; `hasMore` flag fires if any entity hits the cap.
- **NEW** `apps/api/src/modules/sync/routes.ts` (99 lines) — mounts `GET /api/sync/since` under the global auth hook (any logged-in user; no `requirePermission` per task brief). Response schema declares all 6 entity arrays + `serverTimestamp` + `hasMore` as required at the top level (so empty arrays don't get stripped) and `additionalProperties: true` per item (matches existing `/:id` and version-history pattern; lets Prisma row shapes pass through verbatim).
- **EDIT** `apps/api/src/app.ts` — registers new module.
- ChecklistProfile + AssetTemplate are intentionally returned as `[]` in this commit — both have version columns in `schema.prisma` already, but the per-write bump triggers were finalized in 8.4a; populating those two arrays is a follow-up before 8.5.
- **NEW** 16 tests (13 service, 3 route registration). Pattern follows `tape-version-check.test.ts` — `vi.hoisted` prisma mock, no real DB. Covers cursor handling defaults, 500-cap + hasMore, filter `updatedAt` parse + invalid-date fallback, parent-chain flatten (Filter → AHU → Area → Block) to FE-cache shape, missing parent links don't crash, `applicableTemplates` flattened from Step 4 join rows to `string[]`, route registers at `GET /since` with no preHandler.

#### IDB v5 schema (commit `e5f46cb`)
- **EDIT** `apps/web/src/lib/offline-store.ts` — bumped `DB_VERSION` 4 → 5; added 7 new object stores: `syncFilterCleaningProfiles`, `syncFilterProfiles`, `syncEquipmentGroups`, `syncChecklistProfiles`, `syncAssetTemplates`, `syncFilters`, `syncVersionState`. All keyed by `id` except `syncVersionState` which is a single-row store with `key='current'` holding `{profileVersion, filterProfileVersion, equipmentGroupVersion, checklistVersion, assetTemplateVersion, filterUpdatedSince, lastSyncedAt}`.
- **Critical naming choice:** the new filter store is `syncFilters`, not `filters`. The legacy `filters` store at the top of `offline-store.ts` already holds `CachedFilter` rows in a different shape, used by the offline operations queue to optimistically update lifecycle state. Reusing the name would write conflicting shapes into the same store. The two are now parallel additive caches; consolidation is deferred to 8.5/8.6 once the executor is in.
- New helpers exported (pure pass-throughs over the new stores): `cacheEntities(storeName, rows)`, `getCachedEntity(storeName, id)`, `getAllCachedEntities(storeName)`, `getVersionState()`, `setVersionState(state)`. `SYNC_ID_STORES` const, `SyncEntityStore` type, `VersionState` interface, `DEFAULT_VERSION_STATE` constant — all exported for the sync engine.
- **NEW** `apps/web/src/lib/__tests__/sync-store-shape.test.ts` — 4 shape tests (full IDB integration would need fake-indexeddb which the workspace doesn't install; same pure-shape pattern as `offline-store.test.ts`). Asserts `SYNC_ID_STORES` order is stable, new stores don't collide with legacy ones, `DEFAULT_VERSION_STATE` shape (5 cursors at 0, 2 timestamps at null), version-state row key is the literal `'current'`.

#### FE sync-since consumer (commit `996d1c1`)
- **NEW** `apps/web/src/lib/sync-since.ts` (264 lines) — `syncSince()` runs one round-trip (reads versionState from IDB, builds query, calls endpoint, writes results into the 6 sync stores, advances cursor, returns `SyncResult { rowsAdded, hasMore, versionState, serverTimestamp }`). Single in-flight Promise dedupes concurrent calls. `triggerSync(reason)` is the debounced fire-and-forget entry point (1s coalescing window); errors are swallowed (warn log) — next trigger retries. `startSyncPolling()` wires up a 60s online-only timer + `visibilitychange` handler + `online` event handler, all routed through `triggerSync()`. Returns idempotent teardown fn.
- **Cursor-advance semantics:** each entity's version cursor advances to `max(version)` of returned rows. NEVER goes backward — empty arrays leave the cursor untouched. `filterUpdatedSince` advances to `max(updatedAt, filterDetailsUpdatedAt)` across the filter rows (ISO-8601 string compare is lexicographic-safe for UTC-Z timestamps).
- Defensive shape: missing entity arrays in the response treat as empty rather than crash — matches the same robustness in `offline-store.ts` that allowed the staged 8.3 → 8.4 rollout.
- **NEW** `apps/web/src/lib/__tests__/sync-since.test.ts` — 12 tests (mocked api-client + offline-store, follows `sync-engine.test.ts` pattern). Covers default-cursor query, non-default cursor propagation, all 6 stores receive rows, max(version) advance per entity, no-backward on empty, filter watermark = max of `updatedAt + filterDetailsUpdatedAt`, rowsAdded counts, hasMore passthrough, malformed-response defensive empty, concurrent in-flight dedup, debounce coalesces 5 bursts into 1 network call, post-run trigger goes through.

#### App-shell wiring (commit `0e0e2b7`)
- **EDIT** `apps/web/src/components/layout/app-layout.tsx` — `useEffect` on `isAuthenticated` transition to true: `triggerSync('app-start')` + `startSyncPolling()`; teardown on unmount. Login screen unaffected (effect only runs once auth has resolved).
- **EDIT** `apps/web/src/routes/mobile/mobile-wrapper.tsx` — parallel `useEffect` alongside the existing `syncAllDataForOffline` path. Different cache (v5 sync stores vs. legacy `cache` key/value blobs); runs additively without replacing. Will subsume the legacy path in 8.6 once the shared executor lands.

### 8.4c — `packages/shared/src/pipeline-executor/` scaffold (commit `3c7c916`)

Empty-body skeleton for the Option D shared executor. Phase 8.5 fills in the 35 pure guards from the inventory.

- **NEW** `packages/shared/src/pipeline-executor/types.ts` (235 lines) — `GuardResult` / `ValidationResult` + slice types projecting the Prisma rows the executor reads. **No `@prisma/client` import** — `packages/shared` must stay runtime-agnostic for the FE bundle, and Block/Area/AHU/Filter are not Prisma models anyway (they're `AssetInstance` rows discriminated by `template.templateKind`). `ProfileNode` / `ProfileEdge` / `ChecklistQuestion` are aliases over the existing `TapeStage` / `TapeConnection` / `TapeQuestion` shapes from `packages/shared/src/types/action-tape.ts` (canonical types the live tape generator already walks). Aliasing avoids duplicate declarations and lets the 8.5 implementer adopt either vocabulary.
- **NEW** `packages/shared/src/pipeline-executor/context.ts` (115 lines) — `LocalContext` interface + `loadLocalContext` / `loadLocalContextFromCache` stubs. Phase 8.5 relocates the concrete loaders to `apps/api` + `apps/web`.
- **NEW** 7 module stubs: `transitions.ts`, `checklist.ts`, `dryer.ts`, `bypass.ts`, `terminate.ts` (later renamed/replaced with `instruments.ts` + `justification.ts` + `parameters.ts` per the 8.5 prep), `actions.ts` (`computeNextActions(ctx)` → `ActionTape`).
- **NEW** `index.ts` — barrel re-export of the public surface.
- **Stub error format is greppable:** `NOT_IMPLEMENTED -- pipeline-executor/<module>.<fn> -- Phase 8.5`. The smoke test asserts the prefix on every stub.
- **NEW** `packages/shared/src/pipeline-executor/__tests__/smoke.test.ts` — 20 cases (LocalContext fixture compiles; each of 17 stubs throws NOT_IMPLEMENTED; barrel exports the expected symbols).
- **EDIT** `packages/shared/src/index.ts` — re-exports `pipeline-executor`.

### 8.5 prep (commits `0c8c159 da756ea 64dc469 d9f52ab ff10952 2981d93`)

Pre-extraction artifacts produced by background subagents (audits + fixtures), uncommitted to docs intentionally — they drive the 8.5 / 8.6 / 8.7 implementation work but are reference material, not code.

- `tasks/AUDIT-2026-05-02-filter-operations-desktop.md` — desktop FE audit
- `tasks/AUDIT-2026-05-02-mobile-operations.md` — mobile FE audit
- `tasks/AUDIT-2026-05-02-getcurrentstate-consumers.md` — consumer audit
- `tasks/AUDIT-2026-05-02-concurrent-operator.md` — concurrent-operator collision audit
- `tasks/AUDIT-2026-05-02-offline-sync-legacy-deprecation.md` — legacy `offline-sync-service` deprecation audit
- `packages/shared/src/pipeline-executor/__tests__/fixtures.{ts,test.ts}` — 8 LocalContext scenarios + smoke runner

### Tests

- **API**: 1186 passing (was 1167 after 8.4 Commit 1 / 1165 at 8.3 close). Same 2 pre-existing unrelated failures (`auth.test.ts > forgot-password`, `config.test.ts > PUT /api/config/action-reauth`) that predate Step 8.
- **Web**: 68 passing (was 52 after 8.4 Commit 1 / 47 at 8.3 close).
- Net delta vs. 8.3 close: api +21, web +21 across 8.4a (+3 ChecklistProfile snapshot), 8.4 Commit 1 (+5), 8.4b commit 1 (+16 server sync-since), commit 2 (+4 IDB shape), commit 3 (+12 FE sync-since), 8.4c scaffold (+20 smoke), 8.5 prep fixtures (+1).

### Out of scope (deferred to 8.5 → 8.8)

- Filling in the 17 NOT_IMPLEMENTED stubs in `packages/shared/src/pipeline-executor/` — Phase 8.5 (background subagent in flight).
- Server's 4 write methods rewriting to load context → `executor.canX(ctx)` → 8 server-only guards → transaction — Phase 8.5.
- Tape generator becoming `(ctx) => executor.computeNextActions(ctx)` — Phase 8.5.
- `mobile-operations.tsx` + `filter-operations.tsx` building LocalContext from IDB cache and rendering via `executor.computeNextActions(ctx)` — Phase 8.6.
- Deleting the FE walker + `updateOfflineState()` + `nextAllowedStages` / `pendingChecklist` derivations — Phase 8.6.
- Removing `TAPE_PARALLEL` flag, tightening `tapeVersion` to required, removing old derived response fields — Phase 8.7.
- APK rebuild + tablet field QA — Phase 8.8.
- ChecklistProfile + AssetTemplate hydration in `/sync/since` (currently returned as `[]`) — follow-up before 8.5 closes.
- Consolidation of legacy `filters` store + legacy `cache` blob path with the new v5 sync stores — 8.6/8.7.

## [Unreleased] — Step 8 Phase 8.3: offline replay tape-versioning (2026-05-02)

Branch: `feature/phase5-verification`. Adds an optimistic-concurrency guard to all 4 cycle-bound write routes (advance / submit-checklist / bypass / terminate) so a stale offline replay can no longer silently overwrite progress made by another operator on a different device. Renderer surface is ready for Phase 8.4 cutover; consumer wiring (mobile-operations.tsx / filter-operations.tsx) is intentionally untouched.

### What landed

- **EDIT** `apps/api/src/modules/filter-operations/tape/tape-generator.ts` — extracted `computeTapeVersion(profileVersion, filterEventCount)` as the single source of truth for the formula. Generator now calls it; service-side check calls it; tests assert agreement. M3 TODO left at this site — formula aliases when `filterEventCount >= 1000`, deferred to 8.4.
- **EDIT** `apps/api/src/modules/filter-operations/filter-operations.service.ts` — added `assertTapeVersionFresh()` helper. Wired into all 4 write methods after the clientOpId dedup so idempotent replays still short-circuit. Mismatch throws `409 STALE_TAPE` with `details.currentTapeVersion`. Optional during 8.3 (callers pre-migration omit the field) — server treats absent / null as a no-check. Phase 8.4 will tighten to required.
- **EDIT** `apps/api/src/modules/filter-operations/routes.ts` — added `tapeVersion: { type: 'integer' }` to the body schema on `/advance`, `/submit-checklist`, `/bypass`, `/terminate-cycle`. Optional for backward compat.
- **EDIT** `packages/shared/src/types/action-tape.ts` + `packages/shared/src/index.ts` — added `StaleTapeError` interface as a type-guard target (NOT a thrown class). Surfaced on the FE via `(error as any).code === 'STALE_TAPE'` + `currentTapeVersion: number`.
- **EDIT** `apps/web/src/lib/api-client.ts` — lifted `details.currentTapeVersion` to a top-level field on the rejected Error (mirrors the existing `attemptsRemaining` pattern).
- **EDIT** `apps/web/src/lib/offline-store.ts` — bumped IDB `DB_VERSION` 2 -> 3, added `tapeVersion: number | null` to the `OfflineOperation` row shape. No `onupgradeneeded` migration needed (row-shape-flexible store; existing rows have undefined tapeVersion which the server's optional schema accepts).
- **EDIT** `apps/web/src/lib/sync-engine.ts` — replay sends `tapeVersion` for cycle-bound ops (advance / submit-checklist / bypass / terminate); explicitly omitted on start-cycle / start-and-advance start step (not cycle-bound). On 409 STALE_TAPE the op is dropped as `failed` with a refresh-prompt toast — retrying with the same stored version would just keep failing, mirroring the existing `CYCLE_ENDED` stranded path.
- **EDIT** `apps/web/src/lib/action-tape/ActionRenderer.tsx` — added `tapeVersion?: number` prop to both `ActionRendererProps` and `ActionTapeRendererProps`. Dispatcher seam (single point in the component) merges the prop into every payload before forwarding to the caller. Per-button components unchanged.

### Tests

- `apps/api/src/modules/filter-operations/tape/__tests__/tape-generator.test.ts`: 23 -> 26 (computeTapeVersion direct unit + generator-vs-helper agreement).
- `apps/api/src/modules/filter-operations/__tests__/tape-version-check.test.ts` (NEW): 3 cases on terminateCycle() — match passes, mismatch -> 409 STALE_TAPE with currentTapeVersion in details, absent -> no-check (backward compat).
- `apps/web/src/lib/__tests__/sync-engine.test.ts` (NEW): 4 cases — replay carries tapeVersion through, pre-8.3 op (null) replays without the field (server skip path = IDB schema-migration backward-compat req), 409 STALE_TAPE marks failed (no retry), generic 500 marks pending (regular retry).
- API: 1159 -> 1165. Web: 43 -> 47. Two pre-existing e2e failures (auth.test.ts:210, config.test.ts:596) are unrelated and predate this work.

### Out of scope (deferred to 8.4)

- Tightening the route schema to require `tapeVersion` and removing the optional fallback.
- Wiring `tapeVersion` into mobile-operations.tsx / filter-operations.tsx callsites.
- Fixing the M3 formula aliasing.

## [Unreleased] — Step 8 Phase 8.2: full per-action-type renderers + M1 BYPASS expansion (2026-05-02)

Branch: `feature/phase5-verification`. Two-part batch — replaced the 7 Phase-8.1 stub renderers with full-functionality components (dialogs / validation / typed payloads), and closed the M1 follow-up flagged by the Phase 8.0 reviewer. The renderers still live in isolation — `mobile-operations.tsx` / `filter-operations.tsx` are unchanged. Cutover is Phase 8.4.

### What landed

#### Part (a) — Full renderers for all 7 action types

- **NEW** `apps/web/src/lib/action-tape/components/action-dialog.tsx` — shared modal primitive used by the 4 dialog-bearing renderers. Light-theme (`bg-white`, `border-slate-200`, gradient header), backdrop-click dismiss when not loading, role="dialog" + aria-modal for a11y, supports primary / success / warning / danger header+submit variants. Body is an opaque slot so each renderer can build whatever form it needs.
- **EDIT** `apps/web/src/lib/action-tape/ActionRenderer.tsx` — child contract changed from `onClick: () => void` to `onSubmit: (payload: ActionPayload) => Promise<void>`. Dispatcher now wraps the child's onSubmit to call the caller's `onSubmit(action, payload)` with the loading flag plumbed through. New `ActionPayload` discriminated union mirrors what the corresponding server route accepts (`POST /advance` / `/submit-checklist` / `/bypass` / `/terminate` / etc.) so Phase 8.4 cutover can plug the dispatcher into the existing routes without translation.
- **EDIT** all 7 components in `apps/web/src/lib/action-tape/components/`:
  - `CompleteCycleButton.tsx` — single-click submit, no dialog (success/green).
  - `AdvanceToStageButton.tsx` — single-click submit when no `requiresInstrumentReadings`, dialog with one numeric input per instrument id otherwise. Operating-range hints rendered next to each input as soft amber advisory; out-of-range readings still allowed (mirrors existing service.ts behaviour where ranges are advisory).
  - `BypassStageButton.tsx` — justification dialog (amber/warning), textarea required, length validated against `action.requiresJustification.minLength` (read from action — not hard-coded).
  - `TerminateCycleButton.tsx` — justification dialog (red/danger), same `minLength` contract.
  - `SetDryerDurationButton.tsx` — two number inputs (min/max), validated `1 ≤ min ≤ max ≤ 1440`, integer-only, seeded from `action.params.minMinutes` / `maxMinutes`.
  - `SubmitDryerReadingsButton.tsx` — one numeric input per `params.instrumentIds`, all required, range advisory rendered.
  - `SubmitChecklistButton.tsx` — question list (YES/NO/N/A radios + optional remarks per question), required-question gate enforced; remarks always optional (matches the project rule that filter cleaning checklist remarks stay optional). Submit payload mirrors what `POST /:id/submit-checklist` accepts: object-keyed `answers: Record<questionId, value>` with unanswered optionals **omitted** (server rejects extras with 400 INVALID_QUESTIONS — see `filter-operations.service.ts:870-882`). Optional `remarks` map sent under a separate key only when at least one remark is non-empty.

#### Dialog UX semantics — close on success, stay open on error

All 5 dialog-bearing renderers now `await onSubmit(...)` rather than fire-and-forget. On resolve: close the dialog and reset form state. On reject: keep the dialog open and surface the parent's error message inside the dialog so the operator can fix and retry without losing context. The dispatcher's existing `try/finally` (no `catch`) propagates parent errors back through the await chain. Without this, the operator would see a dialog that should have closed staying stuck open and re-clicking would double-submit.

#### Part (b) — Test coverage

- **EDIT** `apps/web/src/lib/action-tape/__tests__/ActionRenderer.test.tsx` — extended from 11 to **33** tests. New cases cover: dialog open-on-click for each dialog renderer, justification min-length validation (BYPASS + TERMINATE), required-question gating + object-keyed answers payload (CHECKLIST), min/max + bounds validation (SET_DRYER_DURATION), readings input + numeric coercion (SUBMIT_DRYER_READINGS), instrument-readings dialog flow (ADVANCE_TO_STAGE with readings), immediate-submit path (ADVANCE without readings + COMPLETE), loading-lock parity with the new contract, the disabled-prop short-circuit (no dialog opens), and three close-on-success / stay-open-on-error tests covering the dialog-lifecycle UX. Existing 11 dispatch tests updated for the new `(action, payload)` signature.

#### Part (c) — M1 follow-up: BYPASS_STAGE emit-set expansion

- **EDIT** `apps/api/src/modules/filter-operations/tape/tape-generator.ts` — when `pinnedProfile.flowMode === 'BYPASS_ENABLED'`, BYPASS_STAGE actions now emit for every pipeline `STAGE` node EXCEPT the current state. Previously the emit-set was restricted to `reachableStages` (forward-walkable from the current node), which under-reported the operator's real bypass surface — specifically step-back (jumping to an earlier pipeline stage), which the existing in-app UI exposes today and which the server's `bypass()` route accepts (`filter-operations.service.ts:1548-1556` validates targetState against `cp.stages.filter(s => s.nodeType === 'STAGE' && s.stateKey)` — i.e. ANY pipeline STAGE is a legal bypass target).
- **EDIT** `apps/api/src/modules/filter-operations/tape/__tests__/tape-generator.test.ts` — added 3 tests (21–23): full-pipeline bypass set excluding current state (4-stage profile), step-back targets included (filter at DRY_OUT must offer WASH_IN), and no-current-state edge case (fresh cycle → all STAGEs eligible). Test count: 20 → **23**.
- Parity test `tape-parity.test.ts` was unaffected — its assertions are additive (`some()`), so the expanded BYPASS emit-set falls within the existing parity contract (tape ⊇ existing fields).

### Verification (Phase 8.2)

- `cd packages/shared && npx tsc` → exit 0 (untouched).
- `cd apps/api && npx tsc -p tsconfig.json --noEmit` → exit 0.
- `cd apps/web && npx tsc --noEmit` → exit 0.
- `cd apps/api && npx vitest run src/modules/filter-operations` → 3 files, **38 tests pass** (Phase 8.1 had 35).
- `cd apps/web && npx vitest run` → 2 files, **43 tests pass** (Phase 8.1 had 21).

### Out of scope (Phase 8.2)

- FE consumption of the tape — Phase 8.4 cutover.
- Offline replay tape-versioning — Phase 8.3.
- APK changes — Phase 8.5.

## [Unreleased] — Step 8 Phase 8.1: shared types + FE action-renderer skeleton + Phase 8.0 review follow-ups (2026-05-02)

Branch: `feature/phase5-verification`. Three parts in one batch — type extraction to `@digilog/shared`, FE renderer skeleton (stub-level — no live consumers yet), and the two Minor cleanups flagged by the Phase 8.0 reviewer (M4 + M6). Strictly additive on the FE side; the FE skeleton is built but not yet consumed by `mobile-operations.tsx` / `filter-operations.tsx` — that's Phase 8.4 cutover.

### What landed

#### Part (a) — Action-tape types live in `@digilog/shared`

- **NEW** `packages/shared/src/types/action-tape.ts` — full type contract lifted from `apps/api/src/modules/filter-operations/tape/types.ts`. Server tape generator + parity tests + future FE renderer all consume the same source of truth, eliminating the drift risk that comes from duplicating discriminated-union shapes across two languages of import.
- **EDIT** `packages/shared/src/index.ts` — barrel re-exports the 21 named types from action-tape (`Action`, `ActionTape`, `TapeInput`, `TapeQuestion`, `OperatingRangeMap`, etc.).
- **EDIT** `apps/api/src/modules/filter-operations/tape/types.ts` — replaced with a re-export shim (`export type { ... } from '@digilog/shared'`). Picked the shim over deleting the file because deleting would force three additional unrelated edits to update import paths in `tape-generator.ts`, `tape-generator.test.ts`, and `filter-operations.service.ts:13` for purely cosmetic gain. The shim adds zero runtime cost and the parity test continues to guarantee shape stability.

#### Part (b) — FE action-renderer skeleton (stubs only)

- **NEW** `apps/web/src/lib/action-tape/types.ts` — convenience re-export of the shared types so action-tape FE imports stay co-located with the renderer code. Call sites are also free to import directly from `@digilog/shared`.
- **NEW** `apps/web/src/lib/action-tape/ActionRenderer.tsx` — top-level dispatcher. Takes a single `Action` plus an `onSubmit: (action) => Promise<void> | void` callback; switches on `action.type` and renders the right child stub. Owns `useState` for in-flight `loading`; passes `disabled` to the child while `onSubmit` is pending. Honors a caller-provided `disabled` prop (e.g. tape stale, refetching). Includes an `ActionTapeRenderer` convenience wrapper that takes the whole `actions[]` and shares a loading-lock across all of them (one click disables the rest until the promise settles). Exhaustiveness guard via `_exhaustive: never` so a future action-kind added to the shared union but not wired here will fail typecheck.
- **NEW** `apps/web/src/lib/action-tape/components/base-action-button.tsx` — visual primitive with 4 variants (primary / success / warning / danger). Each stub picks a variant matching the action's semantic role: ADVANCE / SUBMIT_CHECKLIST / SUBMIT_DRYER_READINGS / SET_DRYER_DURATION → primary; COMPLETE_CYCLE → success; BYPASS_STAGE → warning (deviation); TERMINATE_CYCLE → danger.
- **NEW** 7 stub components (one per action type) in `apps/web/src/lib/action-tape/components/`:
  - `AdvanceToStageButton.tsx` — primary
  - `SubmitChecklistButton.tsx` — primary
  - `SubmitDryerReadingsButton.tsx` — primary
  - `SetDryerDurationButton.tsx` — primary
  - `BypassStageButton.tsx` — warning (amber)
  - `TerminateCycleButton.tsx` — danger (red)
  - `CompleteCycleButton.tsx` — success (green)

  Each stub: takes its specific action variant + `disabled` + `loading` + `onClick`. Renders a single button via `BaseActionButton` with a `data-action-type` attribute (used by tests to confirm the right stub rendered). Phase 8.2 will swap most of these for dialogs/forms (instrument readings, justification capture, checklist questions, dryer-duration picker) — but the dispatch shape stays the same, so the dispatcher needs no rework.
- **NEW** `apps/web/src/lib/action-tape/__tests__/ActionRenderer.test.tsx` — 11 component tests:
  - 7 per-type cases: render the dispatcher with each action variant; assert the right `data-action-type` rendered; click; assert `onSubmit` was called once with the exact action shape (reference equality — we don't clone).
  - 1 caller-disabled case: `disabled` prop forces the button disabled; click does not fire `onSubmit`.
  - 1 in-flight loading case: a deferred-resolve promise; assert button becomes disabled + `aria-busy=true` while pending; assert it clears on resolve.
  - 2 `ActionTapeRenderer` cases: shared loading-lock disables siblings during in-flight; empty-state slot renders when `actions[] === []`.

#### Part (c) — Phase 8.0 review follow-ups (M4 + M6)

- **EDIT** `apps/api/src/modules/filter-operations/tape/__tests__/tape-generator.test.ts` — added `beforeEach(() => { nextId = 0; })` inside the `describe(...)` block (M4). The fixture helpers (`simpleProfile`, `checklistProfile`) already do this on entry, so this is defense-in-depth — but it makes the file safe under `test.concurrent` and removes the order-dependent fragility the reviewer flagged.
- **EDIT** `apps/api/src/modules/filter-operations/filter-operations.service.ts:706-722` — wrapped the two sequential `prisma.filterEvent.findMany` + `prisma.filterEvent.count` calls in `Promise.all` (M6). One less DB round-trip when `TAPE_PARALLEL=true`. Behaviorally identical; the falsy branch returns a typed `[[], 0]` tuple to keep TS narrowing happy.

### Why a re-export shim instead of moving import paths

Three sites import from `./types.js` today: `tape-generator.ts`, `tape-generator.test.ts`, `filter-operations.service.ts:13`. The shim replaces only the body of `types.ts` and leaves the imports alone. The "delete + rewire" path was three additional unrelated edits with no functional benefit; the shim is one line of indirection that the typechecker sees through and the bundler tree-shakes (it's purely `export type`). If we ever need to add api-only types alongside the shared ones, the shim file is already the natural home.

### Verification

- `cd packages/shared && npx tsc` → builds the new `action-tape.{js,d.ts,d.ts.map,js.map}` artifacts; existing 10 type files unchanged.
- `cd apps/api && npx tsc --noEmit` → exit 0.
- `cd apps/web && npx tsc --noEmit` → exit 0.
- `cd apps/api && npx vitest run src/modules/filter-operations` → 3 files, 35 tests pass (unchanged from 8.0 baseline; M4 `beforeEach` is additive).
- `cd apps/api && npx vitest run` (full) → 84 passed / 2 failed; the 2 failing files (`auth.test.ts > forgot-password`, `config.test.ts > action-reauth`) are the same pre-existing e2e failures from 8.0 — confirmed unrelated to this batch (no import path or service code from those modules touched).
- `cd apps/web && npx vitest run` → 2 files, 21 tests pass (B7.1's 10 + B8.1's 11). No `act()` warnings, no console noise.

### Out of scope (deferred to later phases)

- FE consumption of the tape (Phase 8.4 — `mobile-operations.tsx` / `filter-operations.tsx` cutover).
- Per-action-type full UI (Phase 8.2 — instrument-readings dialog, justification capture, checklist-question modal, dryer-duration picker, countdown gate).
- Offline replay tape-versioning (Phase 8.3).
- APK changes (Phase 8.5).
- M1 (BYPASS_STAGE emit-set expansion to all pipeline stages in `BYPASS_ENABLED` mode) — deferred to 8.2 per the original plan.
- M3 (`tapeVersion` collision-resistance — pick `BigInt` or bit-shifted layout) — deferred to 8.4 per the original plan.

---

## [Unreleased] — Step 8 Phase 8.0: server tape generator + parallel-validation harness (2026-05-02)

Branch: `feature/phase5-verification`. Strictly additive — no existing field removed, no consumer touched. Lays the foundation for Phase 8.1+ (FE renderer rewrite) and Phase 8.4 cutover (decision-tape architecture).

### What landed

- **NEW** `apps/api/src/modules/filter-operations/tape/types.ts` — full type contract for the action tape: `Action` (7 discriminated variants), `ActionTape`, `TapeInput` (cycle / filter / pinnedProfile / pinnedEquipmentGroup / pinnedChecklistProfiles / recentChecklistEvents / now), `TapeQuestion` mirrors the existing `pendingChecklist[].questions` shape so the FE doesn't have to translate.
- **NEW** `apps/api/src/modules/filter-operations/tape/tape-generator.ts` — `generateTape(input: TapeInput): ActionTape`. Pure function, no I/O, no prisma. Mirrors the action-emission rules enforced together by `getCurrentState()` + `advance()` (filter-operations.service.ts:331-696, 1031-...). Emits the 7 action types covering the in-cycle stage-advance surface: `ADVANCE_TO_STAGE`, `SUBMIT_CHECKLIST`, `SUBMIT_DRYER_READINGS`, `SET_DRYER_DURATION`, `BYPASS_STAGE`, `TERMINATE_CYCLE`, `COMPLETE_CYCLE`.
- **NEW** `apps/api/src/modules/filter-operations/tape/__tests__/tape-generator.test.ts` — 20 pure-function unit tests covering each action type's emit conditions and edge cases (no-cycle, cycle-not-in-progress, no-profile, fresh-cycle, instrument-bound advance, checklist-pending gate, checklist-resolved fall-through, all-checklists-disabled fall-through, SET_DRYER_DURATION entering DRY_IN, SUBMIT_DRYER_READINGS half-time elapsed, half-time NOT elapsed blocking, readings-already-submitted, COMPLETE_CYCLE on END, BYPASS_STAGE in BYPASS_ENABLED mode, no-bypass in SEQUENTIAL, tapeVersion derivation, tapeVersion determinism, state mirror).
- **NEW** `apps/api/src/modules/filter-operations/tape/__tests__/tape-parity.test.ts` — 8 parity tests proving the action tape is internally consistent with the existing `nextAllowedStages` / `pendingChecklist` invariants on the SAME response (TAPE_PARALLEL=true). Also asserts flag-OFF behavior leaves the response shape unchanged. This is the regression gate for Phase 8.4 cutover.
- **EDIT** `apps/api/src/modules/filter-operations/filter-operations.service.ts` — `getCurrentState()` return block now conditionally appends `actions` + `tapeVersion` when `process.env.TAPE_PARALLEL === 'true'`. `TapeInput` is assembled from already-resolved data (no extra prisma calls except a single `findMany` for `CHECKLIST_COMPLETED` events on the cycle, only when the flag is on). Existing fields untouched.
- **EDIT** `apps/api/src/modules/filter-operations/routes.ts` — response schema for `GET /api/filters/:id/current-state` extended with `actions` (array of objects with `additionalProperties:true` so the discriminated-union variants flow through unchanged) and `tapeVersion` (integer). Required because Fastify's response serializer strips unlisted top-level keys (verified — sibling `stageLookup` was already explicit).
- **EDIT** `CHANGELOG.md` — this entry.

### tapeVersion derivation (Phase 8.0)

`profileVersion * 1000 + filterEventCount` (any FilterEvent type for the cycle, not just checklist events). The full event count is required so tapeVersion changes between stage transitions — using only checklist events would leave two consecutive `getCurrentState()` calls before/after a STATE_TRANSITION at the same tapeVersion despite the action list having changed entirely. Stable for fixed inputs; changes whenever any input that affects the action list changes. Phase 8.4 may revisit once the FE consumes this.

### Verification

- `cd apps/api && npx tsc --noEmit` → exit 0.
- `cd apps/api && npx vitest run src/modules/filter-operations` → 3 files, 35 tests passing (7 B7.3 + 20 unit + 8 parity).
- `cd apps/api && npx vitest run` (full) → 84 passed / 2 failed; the 2 failing files (`auth.test.ts > forgot-password > existing user`, `config.test.ts > action-reauth`) are the documented pre-existing e2e failures unrelated to this batch (1156/1158 tests pass).
- Curl smoke: not run — local stack restart not in scope for additive code path that defaults OFF; coverage proven by parity test `p6` (flag OFF → no actions/tapeVersion in response) and `p7` (flag ON → actions + tapeVersion present, TERMINATE_CYCLE always emitted while in progress).

### Out of scope (deferred to later phases)

- FE consumption of the tape (Phase 8.1+).
- Offline replay tape-versioning (Phase 8.3).
- Removing existing fields from `getCurrentState()` (Phase 8.4 cutover).
- APK changes (Phase 8.5).
- Action types beyond the 7 listed (retire / replace / RFID-scan / batch-flow stay on the existing routes).

---

## [Unreleased] — Batch 7 summary: server-side online-quality follow-ups (2026-05-02)

Branch: `feature/phase5-verification`. Five tasks (B7.1 → B7.5) closing the next layer of online-quality polish after L1-L5 wrapped the operator-visible drift surfaces. None of these were biting users today; each closes an architectural gap or test-coverage hole that would have bitten us later. Strict server-side / online-only — no tablet / android / APK touch.

### What landed

- **B7.1** (commit `1ab2a05`) — `apps/web` got its first vitest config (fresh `defineConfig` from `vitest/config`, NOT derived from `vite.config.ts`), `vitest.workspace.ts` extension, devDeps + scripts. First regression suite at `apps/web/src/routes/version-history/__tests__/diff.test.ts` — 10 tests against the `diffSnapshots()` engine added in VHv3 (Batch 6 commit `d31ed37`). Closes L6 from `tasks/SERVER-ONLINE-WORKLIST.md`.
- **B7.2** (commit `7a2f3b4`) — `BLOCK_CHANGE_REQUIRED` 409 now pops the structured block-change modal on **all four** previously-unguarded `start-cycle`/`start-and-advance` catch sites: mobile `handleEquipSubmit`, desktop `handleEquipmentSubmit` (single + batch), and the desktop PM auto-start loop. Closure-stale `if (!blockChangeDialog)` guards inside `for/await` loops replaced with local `blockChangePopped` flags. Reviewer fix iteration also covered the PM auto-start gap.
- **B7.3** (commit `0b2821f`) — `apps/api/src/modules/filter-operations/__tests__/get-current-state.test.ts` — 7 vitest unit tests asserting the L1 (cycle-pinned `EquipmentGroupVersion.snapshot`) and L2 (cycle-pinned `FilterCleaningProfile` pipeline) invariants. Mocks prisma directly per the project's canonical pattern. Negative assertions (e.g. legacy null-pin path must NOT consult the version sidecar) lock the contract against silent regression.
- **B7.4** (commit `1d6ec6b`) — Operator-facing amber advisory card on `mobile-operations.tsx` and `filter-operations.tsx` when the API returns a non-null `equipmentGroupSyncWarning` (added in L3 commit `d7026ce`). Reviewer fix iteration also closed an intra-stage state-leak (advisory now cleared on every block-change / stage-transition path).
- **B7.5** (this commit) — Final doc sync: worklist + plan + resume note + this CHANGELOG batch summary + `tasks/todo.md` audit log entries.

### Live counts re-verified at B7.5

Counts unchanged from Batch 6 baseline (Batch 7 was meant to be invariant — only test infrastructure + FE rendering + closing cross-refs).

| Metric | Count |
|---|---|
| Prisma models / enums | **69** / **23** |
| Permissions / feature privileges / reauth actions / sidebar items | **106** / **90** / **81** / **26** |
| API modules / config defs / config pages | **36** / **30** / **27** |
| `<Route>` defs in `apps/web/src/main.tsx` | **82** |

### Deferred follow-ups (recorded; do not pick up without re-approval)

- **B7.2 reviewer M1** — pre-existing `advanceBatch:422` closure-stale guard (`if (!blockChangeDialog)` inside a sync `for/await` loop) in `filter-management/filter-operations.tsx`. Cosmetic; same risk profile as the four sites fixed in B7.2 but not a B7-introduced regression. Track as cleanup.
- **B7.4 reviewer Issue #2** — `DryingFiltersPanel`'s 15s SWR poller does not surface `equipmentGroupSyncWarning`. Operator parked on the DRY_IN screen would not see the advisory until the next scan. Defer until a wider DRY_IN panel refactor or CHVH-style chip rendering lands.
- **L5** — manual browser smoke of Version History on a live cycle. Never run in this worktree (no seeded data); flagged in resume notes.

### Verification (whole batch)

- `cd apps/web && npx vitest run` → 1 file, 10 tests passing.
- `cd apps/api && npx vitest run src/modules/filter-operations` → 1 file, 7 tests passing.
- `cd apps/web && npx tsc --noEmit` → exit 0.
- `cd apps/api && npx tsc --noEmit` → exit 0.
- Live-count regex sweep against the active doc set — no drift detected; counts match the Batch 6 close baseline.

Per-task detail follows below.

---

## [Unreleased] — B7.4: render `equipmentGroupSyncWarning` advisory on operator pages (2026-05-02)

Branch: `feature/phase5-verification`. L3 (commit `d7026ce`) added the `equipmentGroupSyncWarning` field to the `getCurrentState()` API response, but no FE consumer read it — operators got zero signal that an admin had edited the cycle's pinned EquipmentGroup mid-cycle. This closes the L3 advisory loop end-to-end.

### Changes

- `apps/web/src/routes/mobile/mobile-operations.tsx` — new `equipmentGroupSyncWarning` component-state, set after each `getCurrentState` fetch in `handleSubmit` (line ~890) and cleared in `goHome` / `openStage`. Renders a persistent amber advisory card just under the existing red error banner (line ~1485).
- `apps/web/src/routes/filter-management/filter-operations.tsx` — same pattern. State set after the `apiClient.get<any>('/api/filters/:id/current-state')` call inside `handleSubmitBatch` (line ~620), cleared in `closeDialog` / `clearScanState` / the URL-stage-sync `useEffect`. Renders an amber card on the dedicated stage screen just below the pending-sync banner (line ~1493). Type declared inline at the call site — no `CurrentStateResponse` type added (would be over-engineering for one field).
- Copy on both pages (verbatim): "Equipment group has been updated by admin (you started on v{pinnedVersion}, current is v{liveVersion}). Your readings will continue to validate against the version you started with — terminate-and-restart only if you need the new ranges."
- Visual: `bg-amber-50 border-amber-200 text-amber-800` with the standard amber warning triangle SVG. Distinct from the red error banner (so an operator sees both at once if both fire) and persistent (no auto-clear timer — the existing red `error` auto-clears after 6s, this advisory does not).

### Reviewer follow-up (Issue #1) — intra-stage state leak on block change

- Reviewer flagged that `equipmentGroupSyncWarning` was not cleared when the operator changes block within the same stage screen. Scenario: scan Filter A on Block 1 → see amber advisory → "Change Block" → switch to Block 2 → between this and the next scan the advisory is still visible despite no longer applying. Self-corrects on next scan, but leaks briefly.
- Fix on desktop (`apps/web/src/routes/filter-management/filter-operations.tsx`): added `setEquipmentGroupSyncWarning(null)` to `handleBlockSelect` and to both `onChangeBlock` handlers (the fullPage variant inside the activeStage branch and the modal variant just above the cleaning-reason dialog). All three sites now drop the advisory before transitioning the step.
- Fix on mobile (`apps/web/src/routes/mobile/mobile-operations.tsx`): the in-place "Change" button next to the selected-block chip (the only intra-stage block-change affordance on mobile — `goHome` and `openStage` already cleared the advisory) now also calls `setEquipmentGroupSyncWarning(null)`. `performTask` (Wash-In jump from My Tasks) was updated symmetrically.

### Notes / known limits

- The advisory is set only after a `getCurrentState` fetch, so an operator already on the stage screen who hasn't scanned yet won't see it until the next scan. This matches the pattern of `profileSyncWarning` (which is also evaluated at scan-time only).
- **Deferred follow-up (Issue #2) — `DryingFiltersPanel` poller does not surface the advisory:** the panel's SWR poller fetches `/current-state` every 15 s for in-progress DRY_IN cycles but only uses the dryer-countdown shape, not `equipmentGroupSyncWarning`. An admin who edits the EquipmentGroup while the operator is parked on the DRY_IN screen would not see the advisory until they scan the next filter. Tracked as a follow-up; not fixed in this iteration.
- Offline-built state does not carry `equipmentGroupSyncWarning` (it's a derived comparison between `cycle.equipmentGroupVersionPin` and the live group version, which the offline path can't compute from the cache shape). The `?? null` fallback ensures stale values are cleared when offline.
- The recommendation is `CONTINUE_OR_TERMINATE_AND_RESTART` — operator is *not* blocked. Mirrors the L3 server-side semantic (validation continues against the pinned snapshot via Phase A.4 P1; new ranges are admin-driven, not safety-driven).

### Verification

- `cd apps/web && npx tsc --noEmit` → exit 0.
- `cd apps/api && npx tsc --noEmit` → exit 0 (no API changes; sanity check only).
- `cd apps/web && npx vitest run` → existing B7.1 diff suite still passes (10/10).
- Visual smoke: not run (no live server in this worktree); the amber-card render shape is straight Tailwind and mirrors the existing `pendingCount` amber banner adjacent to it.

### Out of scope

- No "View pinned snapshot" button on the advisory (CHVH territory; the chips on the cycle timeline page already deep-link).
- No semantic change to the warning's recommendation.
- No tests added for the FE rendering — the advisor flagged this as B7.5 doc territory and the component-level test would be over-engineering for a non-blocking advisory.

---

## [Unreleased] — B7.3: vitest unit tests for `getCurrentState()` L1+L2 invariants (2026-05-02)

Branch: `feature/phase5-verification`. The `filter-operations.service.ts` module had zero unit tests (verified — no `__tests__` folder existed for the module). L1 (cycle-pinned `EquipmentGroupVersion.snapshot` rendering) and L2 (cycle-pinned `FilterCleaningProfile.id` pipeline rendering) had no automated regression coverage. A future refactor could silently revert either path back to live-row reads and we wouldn't notice until an operator complained.

### Changes

- `apps/api/src/modules/filter-operations/__tests__/get-current-state.test.ts` — new vitest unit-test file. Mocks prisma directly per the canonical pattern in `apps/api/src/modules/assets/services/__tests__/instance.service.test.ts` (`vi.hoisted` + `vi.mock('../../../lib/prisma.js', …)`). Spies on the service's private `getProfilePipeline` after instance construction (option (a) in the task brief) so L2 can be asserted by call-args without restructuring the service.

### Coverage (7 tests across 2 describe groups)

L1 — equipment-group snapshot resolution:
1. **case 1** — pin set + snapshot row exists → returned `equipmentGroup` matches snapshot fields, `version === pin`, instruments sorted by `sortOrder`. Live-row stub poisoned to a divergent value to make a regression that reads it instead of the snapshot fail loudly.
2. **case 2** — pin set + no snapshot row + `live.version === pin` → returned `equipmentGroup === liveGroup` (lazy first-version path; live row IS v1 until first edit creates the archive). `console.warn` NOT called.
3. **case 3** — pin set + no snapshot row + `live.version !== pin` → defensive log path: returns live row AND emits a single `console.warn` containing `equipmentGroupVersionPin=…`, `groupId`, and `cycleId`.
4. **case 4** — pin null (legacy cycle pre-P1) → returns live row, `prisma.equipmentGroupVersion.findUnique` is NEVER called (negative assertion enforces the L1 contract that legacy cycles must not consult the version sidecar).
5. **case 5** — cycle has no `equipmentGroupId` → block-fallback group via `prisma.equipmentGroup.findFirst({ where: { blockId, isActive: true }, … })`, neither `equipmentGroup.findUnique` NOR `equipmentGroupVersion.findUnique` is called.

L2 — cycle-pinned profile pipeline rendering:
6. **case 6** — `currentCycle.profileId !== resolvedLiveProfileId` → `getProfilePipeline` is called with the cycle's `profileId`, NOT the live `resolveFilterProfile()` result. Returned `profile.name`/`flowMode` reflect the cycle-pinned pipeline (sanity end-to-end check).
7. **L2 control** — pre-cycle path (no `currentCycleId`) → `getProfilePipeline` IS called with the live resolved profileId. Documents the inverse: cycle-pinned rendering only fires when a cycle is in progress; pre-cycle preview shows the live binding (so the operator sees what they'd start a cycle against).

### Why no helper extraction

The task brief allowed extracting `resolveEquipmentGroupForResponse()` / `resolveProfileForRender()` helpers from `getCurrentState()` if the function was too entangled to test in one shot. It wasn't. Mocking the ~10 prisma calls L1+L2 actually touch (filtering out the unrelated PM-due, block-change-status, profileSyncWarning, equipmentGroupSyncWarning, and stageLookup branches with empty/null returns) keeps the test focused on the two invariants and avoids an out-of-scope refactor. No production-code change beyond the new test file.

### Verification

- `cd apps/api && npx vitest run src/modules/filter-operations` → 1 file, 7 tests, all passing.
- `cd apps/api && npx vitest run` (full api suite, 84 files) → 82 passed, 2 pre-existing e2e failures unrelated to this change (`auth.test.ts > forgot-password` — UUID corruption in test DB; `config.test.ts > datetime/current` + `action-reauth` — environmental). Both reproduced on `7a2f3b4` (HEAD before this commit) without the new test file.
- `cd apps/api && npx tsc -p tsconfig.json --noEmit` → exit 0.

### Touched files

- `apps/api/src/modules/filter-operations/__tests__/get-current-state.test.ts` (new, 345 lines).
- `CHANGELOG.md` (this entry).

---

## [Unreleased] — B7.2: BLOCK_CHANGE_REQUIRED 409 handled in equipment-dialog + PM auto-start flows (2026-05-02)

Branch: `feature/phase5-verification`. Closes a partially-stale gap: the `BLOCK_CHANGE_REQUIRED` 409 already emitted structured `details` from `validateBlockChange()` (commit `60dcbaa`, 2026-04-10), and the reason-dialog catch paths in mobile + desktop had been popping a structured modal since then. **What was missing**: four `start-and-advance` catch blocks (three equipment-dialog + one desktop PM auto-start) that go through `start-cycle` → `validateBlockChange`. On a cross-block hit there, the 409 was falling through to a generic toast / "failed" string. Operators got no actionable surface for requesting approval from those flows.

### Changes

- `apps/web/src/routes/mobile/mobile-operations.tsx` — `handleEquipSubmit`: detect `e.code === 'BLOCK_CHANGE_REQUIRED'` and pop the existing `blockChangeDialog` modal (same shape as the reason-dialog catch at line 1137). Clears `equipDialog`, `selectedEquipGroup`, `readings`, and `pendingCyclePayload` so the new modal isn't stacked under stale state.
- `apps/web/src/routes/filter-management/filter-operations.tsx` — `handleEquipmentSubmit` (single + batch paths): same detection, mirroring the reason-dialog catch at line 1060 and the `advanceBatch` catch at line 388. Batch loop sets the modal once on first hit and keeps iterating so other items still succeed.
- `apps/web/src/routes/filter-management/filter-operations.tsx` — **PM auto-start desktop loop** (added in this revision): the `for (const item of batch)` at line ~721 was calling `executeOrQueue('start-and-advance', …)` with no inner try/catch, so a 409 from `validateBlockChange` would bubble to the outer catch at line ~826 and surface as a generic `setPopupError(e.message)` — exactly the gap B7.2 was meant to close. Mobile already had this (mobile-operations.tsx:1015-1022); only desktop was missing it. The proactive `state.blockChangeStatus === 'REQUIRED'` cache check at line 661 mitigates most cases, but it's a stale-cache gate, not a server-side hard guarantee. Fix mirrors mobile + the equipment-dialog batch pattern: per-iteration try/catch, structured modal popped once on first hit (via local `blockChangePopped` flag), other items continue.

### Minor cleanups (same commit)

- **Closure-staleness fix in `handleEquipmentSubmit` batch loop** — replaced the `if (!blockChangeDialog)` guard with a local `blockChangePopped` flag. React does not flush state between iterations of a sync `for/await` loop, so the closure-captured `blockChangeDialog` is always whatever it was at function entry — the original guard would re-set the dialog on every cross-block hit. Local flag = correct "set on first hit only". Same fix applied to the new PM auto-start loop above.
- **Symmetry with `advanceBatch`** — added `&& !blockChangePopped` guard on the post-loop `setPopupError` in `handleEquipmentSubmit` batch (mirroring `advanceBatch:422`'s `&& !blockChangeDialog`), so the generic toast doesn't fire when the structured modal is already up. Used the local flag for the same closure-staleness reason.

### Why no new modal / no inline card / no API change

- The structured modal already exists (one in each file) with filter name, home block, requested block, reason textarea, and inline `POST /api/block-change-requests` submit. Adding an inline card alongside (S4UX-style) would create two competing UIs for the same error.
- `validateBlockChange()` already returns the exact `{ filterId, homeBlockId, homeBlockName, requestedBlockId, requestedBlockName }` shape the FE consumes. No server-side change.

### Verification

- `cd apps/web && npx tsc --noEmit` → exit 0.
- `cd apps/api && npx tsc --noEmit` → exit 0.
- `cd apps/web && npx vitest run` → 1 file, 10 tests, all passing (B7.1 regression).
- Server contract verified by code reading: `filter-operations.service.ts:205-213` constructs the AppError; `app.ts:147-152` serializes `details` into the JSON body; `error-schemas.ts:13` uses `additionalProperties: true` so Fastify preserves it; `api-client.ts:67` maps `err.details` → `err.connectionInfo`. End-to-end live curl was not feasible without building out a full block-with-filters fixture in the local DB; documenting the inspection chain instead.

### Touched callsites — full audit (so future drift is detectable)

In both files, every `catch` for an `executeOrQueue('start-cycle' | 'start-and-advance', …)` path now either pops the modal or delegates to a loop that does. Audited catches:

- mobile: 1015 (PM auto), 1071 (handleSubmit), 1136 (handleReasonSubmit), 1245 (handleEquipSubmit — fixed in this commit).
- desktop: 388 (advanceBatch), **~721 (PM auto-start loop — fixed in this revision)**, 868 (reason-batch start), 935 (reason-batch advance), 1010 (reauth-wrapped start), 1060 (handleReasonSubmit), 1232 (handleEquipmentSubmit batch — fixed in this commit), 1283 (handleEquipmentSubmit single — fixed in this commit).

`submit-checklist`, `bypass`, `terminate`, dryer-temp `advance`, and offline-cache fetch catches do not need the branch — `validateBlockChange` is only called from `startCycle()` server-side (verified at `filter-operations.service.ts:899`).

---

## [Unreleased] — B7.1: apps/web vitest setup + diffSnapshots() regression suite (2026-05-02)

Branch: `feature/phase5-verification`. Closes L6 from `tasks/SERVER-ONLINE-WORKLIST.md` — no FE test runner existed and the snapshot diff engine in the Version History page (added in `d31ed37` — VHv3 interactive diff timeline) had zero coverage.

### Changes

- `apps/web/package.json`: added `vitest@^3.0.0`, `jsdom@^25`, `@testing-library/react@^16.1`, `@testing-library/jest-dom@^6.6` devDeps; added `test` (= `vitest run`) and `test:watch` scripts. Vitest version is pinned to match `apps/api` and `packages/shared` so npm doesn't hoist two majors.
- `apps/web/vitest.config.ts`: new file. Fresh `defineConfig` from `vitest/config` — intentionally NOT derived from `vite.config.ts`, which reads HTTPS certs at module load and registers VitePWA / Tailwind plugins that would explode under a unit-test runner. Uses `jsdom` environment, `@vitejs/plugin-react`, and the `@` path alias mirroring `tsconfig.json#paths`.
- `apps/web/src/test-setup.ts`: new file. Registers `@testing-library/jest-dom/vitest` matchers. Unused by the diff suite (no React rendering) but in place for future component tests.
- `apps/web/src/routes/version-history/index.tsx`: minimal export of `diffSnapshots`, `DiffChange`, `EntityKind`. No restructuring; runtime behavior of the page is unchanged.
- `apps/web/src/routes/version-history/__tests__/diff.test.ts`: new suite. **10 tests** covering each branch of `diffSnapshots()`:
  1. scalar field change (`changed`)
  2. keyed-array stage addition with context (`added`)
  3. keyed-array stage removal with context (`removed`)
  4. keyed-array item field change — recursion path, `id` filtered as META
  5. set-style `applicableTemplates` add (filter-profile)
  6. set-style `allowedBlocks` remove (filter-profile)
  7. all META_FIELDS differ but nothing else → empty diff
  8. deep-equal snapshots (no-change case) → empty diff
  9. checklist-profile `questions` keyed by id (cross-kind smoke)
  10. equipment-group `instruments` operatingMax change (cross-kind smoke)
- `vitest.workspace.ts`: added `apps/web/vitest.config.ts` to the workspace list. **This is a touchpoint not in the B7.1 spec** — flagging here rather than silently extending. The omission would have meant `npm test` at root wouldn't pick up the new project, regressing against the existing api/shared/integration pattern.
- `apps/web/CLAUDE.md`: new "Testing" section with run commands and a pointer at the B7.1 suite.
- `tasks/SERVER-ONLINE-WORKLIST.md`: marked L6 done with delivery summary.

### Verification

- `cd apps/web && npx vitest run` → 1 file, 10 tests, all passing (~1.4s).
- `cd apps/web && npx tsc --noEmit` → exit 0.
- No `index.tsx` runtime change beyond three `export` keyword additions; the page still renders identically.

---

## [Unreleased] — L4: advance() reading-validation snapshot/live equality audit — NO CHANGE (2026-05-02)

Branch: `feature/phase5-verification`. L4 from `tasks/SERVER-ONLINE-WORKLIST.md` was a defense-in-depth audit of `filter-operations.service.ts:1227-1262` (`advance()` reading-validation snapshot vs lazy-first-version live-fallback path). **Outcome: no code change. The path is correct.**

### What was audited

The validator picks `stageInstruments` from one of three sources depending on cycle pin state:

1. Snapshot path (`pin=N`, snap row exists): reads `snapshot.instruments[]`.
2. Lazy-first-version live-fallback (`pin=N`, no snap row, asserts `live.version === pin`): reads live `equipmentGroupInstrument` rows.
3. Legacy fallback (`pin=NULL`): reads live rows. Documented drift gap, intentionally kept for backwards-compat with pre-P1 cycles.

The concern was whether the instrument IDs the FE has cached (used to key the submitted `instrumentReadings: {[id]: number}`) could ever diverge from the IDs the validator iterates over.

### Finding: instrument IDs are stable across edits

`equipment-groups.service.ts:163-178` mutates each instrument by `tx.equipmentGroupInstrument.update({where: {id: existingInst.id}, ...})` — fields change, row identity is preserved. There is no replace-instrument code path that creates new rows. Therefore:

- Snapshot path: `snap.instruments[i].id` matches what the FE saw via `getCurrentState()` (which after L1 returns the same snapshot).
- Lazy-first-version: snapshot doesn't exist yet, both server and FE use the live row's IDs — identical.
- Legacy: pre-P1 cycle never had a pin, FE always saw live IDs, validator reads live IDs — identical.

### Auto-bind at submit (line ~1199-1216)

When a cycle has no `equipmentGroupId` and a single block-group exists, the validator auto-binds at submit time and stamps `pin = live.version`. The submitted `instrumentReadings` was built from a prior `getCurrentState()` call which returned the live group; validator reads the same live group via the lazy-first-version branch (`pin === live.version` assertion holds). **Synchronous online flow: race-free.**

The narrow offline-batch case (FE rendered against live v1, admin edited to v2 mid-flight, sync replays the readings, validator pins to v2) is reachable but is exactly what Slice B in `future/offline-version-sync-contract.md` is designed to handle. Out of scope for online-side work.

### Decision: no change

L4 closed. Documented here for the record.

---

## [Unreleased] — L3: equipmentGroupSyncWarning on getCurrentState (2026-05-02)

Branch: `feature/phase5-verification`. Symmetric to the existing `profileSyncWarning` (cleaning-recipe drift) but for the EquipmentGroup pin. Read-only advisory; no functional change to validation.

### Changes

- `filter-operations.service.ts:~628`: new `equipmentGroupSyncWarning` field on the `getCurrentState()` response. Fires when `cycle.equipmentGroupVersionPin !== null` AND the live group's `version > pin`. Carries `{ groupId, pinnedVersion, liveVersion, recommendation: 'CONTINUE_OR_TERMINATE_AND_RESTART' }`. Null in all other cases (no cycle, no group, pin matches live, etc.).
- `filter-operations/routes.ts:~63`: response schema entry for the new field, so Fastify doesn't strip it.

### Verification

- `tsc -p apps/api/tsconfig.json` exit 0; service restart clean.
- End-to-end via curl on F1/B1:
  - Started cycle with pin=1 on a freshly-seeded group at v1. GET `/current-state` → `equipmentGroupSyncWarning: null`. ✓
  - PUT to bump live group v1→v2. GET `/current-state` → `equipmentGroupSyncWarning: { pinnedVersion: 1, liveVersion: 2, recommendation: 'CONTINUE_OR_TERMINATE_AND_RESTART' }`. ✓
- Test data fully cleaned up.

### Notes

- Recommendation says `CONTINUE_OR_TERMINATE_AND_RESTART` (not `TERMINATE_AND_RESTART` like the profile warning) because: the operator can finish their cycle on the pinned ranges (still correct, still audit-replayable). Restarting only matters if they want the new ranges to apply. Less coercive than the profile case where the cleaning recipe changing is materially different.
- No FE consumer wired up yet — additive field. The existing FE warning UI for `profileSyncWarning` is the natural spot to render this when the FE is updated. Not blocking; the field is documented in the OpenAPI/Fastify schema.

---

## [Unreleased] — L2: getCurrentState renders cycle-pinned cleaning profile pipeline (2026-05-02)

Branch: `feature/phase5-verification`. Closes the pipeline-graph display drift between the operator's UI and what `advance()` enforces. Symmetric to L1 but for the cleaning pipeline graph (stages + connections + profile name) rather than the equipment group.

### Background

Before L2: `getCurrentState()` rendered `pipelineGraph`, `pipelineStages`, `nextAllowedStages`, `pendingChecklist`, `stageLookup`, and `profile` from `getProfilePipeline(resolvedProfileId, false)` — where `resolvedProfileId` came from `resolveFilterProfile(filter)` (the LIVE FilterProfile binding via FilterDetails or config rule).

The cycle's actual pinned recipe is `currentCycle.profileId` (locked at start, immutable post-A.2 rowful versioning). When an admin reassigned a block's FilterProfile mid-cycle, the operator's tablet showed the new pipeline's stages while `advance()` still enforced the old one. `profileSyncWarning` (line 553-577) detected the mismatch and told the operator to TERMINATE_AND_RESTART, but the visual layout was misleading until they did.

### Changes

- `apps/api/src/modules/filter-operations/filter-operations.service.ts:402-417` — when `currentCycle` exists, render the pipeline from `currentCycle.profileId` (the cycle's pinned FilterCleaningProfile id) instead of the live FilterProfile binding. Pre-cycle path falls back to the live binding (so the operator sees what they'd start a cycle against).
- All downstream consumers (`pipelineStages`, `pipelineGraph`, `nextAllowedStages`, `nextBlocks`, `pendingChecklist`, `stageLookup`, `profile`) automatically pick up the pinned graph because they all read from the same `cp` variable.
- `profileSyncWarning` semantics preserved: now it correctly says "your view matches the rules; admin has reassigned the block to a different profile; terminate-and-restart to use the new one" instead of "your view is wrong."

### Verification

- `tsc -p apps/api/tsconfig.json --noEmit` exit 0; full compile to dist exit 0; service restart clean.
- End-to-end via curl on F1/B1 with two distinct CleaningProfiles seeded:
  - **CP-A** (cycle-pin) has stage `WASH_IN`. **CP-B** (live-binding) has stage `DRY_IN`.
  - Step 1: FilterProfile -> CP-A. Started cycle. `cycle.profileId = CP-A.id`. ✓
  - Step 2: GET `/current-state` -> `pipelineGraph.stages` shows `WASH_IN`, `profile.name = "L2 CP-A (cycle-pin)"`. ✓
  - Step 3: SQL `UPDATE filter_profiles SET cleaning_profile_id = CP-B.id` (live binding now diverges from cycle pin).
  - Step 4: GET `/current-state` -> `pipelineGraph.stages` still shows **`WASH_IN`** (NOT `DRY_IN`); `profile.name` still **`L2 CP-A (cycle-pin)`**. ✓
  - `profileSyncWarning` populated correctly: `cycleProfileName: "L2 CP-A (cycle-pin)"`, `expectedProfileName: "L2 CP-B (live-binding)"`, recommendation `TERMINATE_AND_RESTART`. ✓
- Test data fully cleaned up: 0 cycles, 0 cleaning profiles, 0 stages, 0 connections.

### Notes

- No FE change required — same `pipelineGraph` / `pipelineStages` / `nextAllowedStages` field shapes.
- No APK rebuild required.
- Scope deliberately narrow: this L2 only covers the rendered pipeline graph at `getCurrentState()`. The actual `advance()` logic was already correct — it walks `cp.stages` from `currentCycle.profileId`. L2 just makes the read path consistent with the write path.

---

## [Unreleased] — L1: getCurrentState returns pinned EquipmentGroupVersion snapshot (2026-05-02)

Branch: `feature/phase5-verification`. Closes the operator-visible drift surface left by P1: server validated against the pinned snapshot but `getCurrentState()` still returned the live group, so dropdowns built from live ranges (`mobile-operations.tsx:2062 genOpts(...)`) could offer values that the server then rejected with no warning.

### Changes

- `apps/api/src/modules/filter-operations/filter-operations.service.ts:486-553` — when `cycle.equipmentGroupVersionPin` is set, `getCurrentState()` reconstructs `equipmentGroup` from `EquipmentGroupVersion.snapshot` instead of the live `equipmentGroup` row. Field shape preserved (`{id, name, blockId, isActive, version, instruments: [...]}`) so the existing FE consumers + the deployed APK consume unchanged.
- Lazy-first-version handling: when pin is set but no `EquipmentGroupVersion` row exists yet (live row IS v1 until the first edit creates its archive), falls back to live row IFF `live.version === pin`. Mirrors the canonical logic from `advance()` reading-validation at `:1101-1175`.
- Legacy fallback (cycle started pre-P1, pin is NULL): live row, with the documented drift gap.
- Mismatch path (pin set, no snapshot row, live.version !== pin): logs a console.warn and returns live; doesn't throw because this is a read endpoint and breaking the operator's UI is worse than logging. `advance()` will throw `409 GROUP_VERSION_MISSING` if the operator tries to act on it.

### Verification

- `tsc -p apps/api/tsconfig.json --noEmit` exit 0.
- Full compile to dist exit 0; service restart clean.
- End-to-end via curl on F1/B1 + a seeded cleaning profile + filter profile + equipment group:
  - Started a cycle with pin=1; live group at v1. Lazy-first-version path: GET `/current-state` returned Air `operatingMax=6, version=1`. ✓
  - PUT to bump live group v1→v2 (Air `operatingMax 6→7`). Snapshot row v1 created. GET `/current-state` returned **Air `operatingMax=6, version=1`** — the pin survived; the FE would now render dropdowns from the pinned ranges. ✓
  - Set `equipmentGroupVersionPin = NULL` directly (legacy fallback). GET `/current-state` returned Air `operatingMax=7, version=2` — live row, as expected for pre-P1 cycles. ✓
- Test data fully cleaned up: 0 cycles, 0 groups, 0 group versions.

### Notes

- **No FE change required.** Verified via grep: every FE consumer of `equipmentGroup.*` reads only `id`, `instruments`, plus defensive reads of `name`/`blockId`/`isActive` — all preserved by the snapshot-reconstruction shape.
- **No APK rebuild required.** Same field-shape contract.
- This implicitly closes the offline reading-submit replay drift case from `future/offline-version-sync-contract.md` (O3 in the addendum) — once the tablet caches what `getCurrentState()` returns per cycle, subsequent admin edits to the live group don't reach the cached cycle state. Slice B's primary motivation evaporates; only the narrow "first cache-fill happens during admin edit" residual remains.

---

## [Unreleased] — Batch 6: VHv2 + VHv3 + S4UX + WSL + DocSweep + CHVH (2026-05-02)

Branch: `feature/phase5-verification`. Per user direction: items 2-7 from the menu, all touchpoints listed before editing, all verified after, deep fixes applied where bugs were uncovered.

### VHv2 — Structured per-entity snapshot viewers
- `apps/web/src/routes/version-history/index.tsx`: replaced the JSON pretty-print modal body with kind-aware structured cards (CleaningProfile, FilterProfile, ChecklistProfile, EquipmentGroup). Each renders the entity's full snapshot in human-readable form: cleaning profiles show stages (sorted, with nodeType + stateKey + configuration) and connections; filter profiles show applicable templates list; checklist profiles render the question list (sortOrder, type, required, options summary); equipment groups group instruments by stageKey in a per-stage table with all ranges. The raw JSON is preserved behind a "Show raw JSON" toggle.

### VHv3 — Version diff view
- Same file. Added "Compare with v(N-1)" expander on every version timeline row (hidden on v1 since there's no v0). Inside, fetches both snapshots in parallel, runs a kind-aware diff: scalar changes render as `field: old → new`, keyed array members (stages by id, instruments by id, questions by id, cleaningReasons by key) diff per-item with per-field changes, set-style fields (`applicableTemplates`, `allowedBlocks`) render as set add/remove. Meta fields (timestamps, author, version pointers) are filtered out so the diff only shows admin-edit changes.

### S4UX — TEMPLATE_IN_USE structured response
- **Deep fix**: `apps/api/src/lib/errors.ts` — `ConflictError` constructor now takes a `details?: unknown` arg and forwards it through `AppError`. Pre-existing limitation — `ConflictError` could only emit a string message; couldn't carry structured payloads.
- `apps/api/src/modules/assets/services/template.service.ts` — Step 4 delete guard now throws `ConflictError(message, 'TEMPLATE_IN_USE', { bindings: [{id, name}, …] })` instead of jamming names into the message string.
- `apps/web/src/routes/assets/templates.tsx` — delete handler detects `err.code === 'TEMPLATE_IN_USE'` and renders the bindings list inline (each profile shown as a card with name + truncated id) instead of a single-line toast.
- `apps/api/src/modules/assets/services/__tests__/template.service.test.ts` — assertion updated: now checks `err.code === 'TEMPLATE_IN_USE'` AND `err.details === { bindings: [...] }`. **All 11 tests pass.**

### WSL — Windows-service launcher full automation
- New `scripts/install-windows.ps1`: top-level orchestration installer that ties together the existing piecemeal scripts (`install-mosquitto.ps1`, `install-services-phase5.ps1`). Steps: tooling sanity check (Node, NSSM auto-install via winget if missing) → builds packages/shared / apps/api / apps/web (skippable with `-SkipBuild`) → installs/refreshes Mosquitto (skippable on existing install) → registers DigiLog API + Web services via NSSM → starts services → probes `/health` (200 or 401 both OK — TLS up). Idempotent.
- New `scripts/uninstall-windows.ps1`: stops + removes DigiLog services. Mosquitto opt-in via `-RemoveMosquitto`. Logs opt-in via `-RemoveLogs`. Falls back to `sc.exe delete` if NSSM isn't found.
- Both scripts parse-validated (PowerShell AST parser exit 0); ASCII-only per the existing convention to keep PS 5.1 happy.

### DocSweep — Doc-sync verification across active doc set
- Ran live-count regex sweep. Pre-VH-shipped values (105 perms / 89 privs / 25 sidebar) found stale in: `LOCAL_SETUP_WINDOWS.md`, `packages/shared/CLAUDE.md`, `PROJECT_ARCHITECTURE.md`, `windowsIssues.md`. Older pre-MT-removal values (109 perms / 91 privs) found stale in: root `CLAUDE.md` (×2), `AGENTS.md`, `PROJECT_SUMMARY.md` (×2), `docs/index.md`. **All bumped to 106 / 90 / 26.**
- Verified live counts: 69 models, 23 enums, 106 permissions, 90 feature privileges, 81 reauth actions, 26 sidebar items, 36 API modules, 30 config defs, 27 config pages, 82 frontend `<Route>` definitions in `main.tsx`.

### CHVH — Cycle history ↔ version history linkage
- `apps/web/src/types/filter.ts`: extended `CleaningCycle` interface with `equipmentGroupId`, `equipmentGroupVersionPin`, `checklistVersionPins`. The fields were already in the API response; the FE just hadn't typed them.
- `apps/web/src/routes/cleaning-cycles/timeline.tsx`: new "Pinned Versions (audit replay)" card after the cycle info grid, conditional on the cycle having any pin. Renders three chip types — "Pipeline vN" (FilterCleaningProfile via existing `profileVersion`), "Equipment vN" (`equipmentGroupVersionPin` from P1), "Checklist vN" (one chip per entry in `checklistVersionPins`). Each chip deep-links to `/version-history?entity=<kind>&id=<uuid>&v=<n>`.
- `apps/web/src/routes/version-history/index.tsx`: added `useSearchParams` + a one-shot `useEffect` that reads `entity=`, `id=`, `v=` on mount, lands on the right tab, pre-selects the entity, and opens the snapshot modal at the requested version. Tab change clears the deep-link params (so back/forward doesn't reopen the modal).

### Verification

- `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0.
- `npx tsc --noEmit` (apps/web) exit 0.
- Full API compile to dist exit 0; service restart clean.
- `vitest run src/modules/assets src/modules/backup` — 14 files / 163 tests pass; the updated `template.service.test.ts` 409-path test asserts the new structured `details.bindings` shape.
- Curl: `DELETE /api/assets/templates/<bound-template-id>` returns `{"error":"TEMPLATE_IN_USE", "message":"…", "details":{"bindings":[{"id":"…","name":"409 Bound FP"}]}}` with code 409. Test data cleaned up.
- PowerShell AST parse on `install-windows.ps1` and `uninstall-windows.ps1` exit 0.

### Notes

- No new permission, no new model, no schema migration, no new package dep.
- Counts unchanged from VH commit: 69 models, 23 enums, 106 permissions, 90 feature privileges, 81 reauth, 26 sidebar items, 36 API modules.
- Em-dash characters originally in the new PS scripts broke PS 5.1 tokenisation — caught + replaced with `--` (matches the ASCII-only convention from the existing `install-services-phase5.ps1`).

---

## [Unreleased] — VH: Version History admin page + new VERSION_HISTORY_VIEW permission (2026-05-02)

Branch: `feature/phase5-verification`. Per user direction: "add a page to see versions, keep it in super admin scope and be assignable to other users through super admin configurations." Closes the FE sync gap for the four versioned entities (Phase A.1 + A.2 + A.3 + A.4) — server-side audit history existed at the API level but no admin UI surfaced it.

### Changes

- **New permission `VERSION_HISTORY_VIEW`** in `packages/shared/src/types/permissions.ts`. SUPER_ADMIN only by default (added to seed.ts and to the live SUPER_ADMIN role's permission array); assignable to other roles via Role Privileges → Audit / Versions → "View Version History".
- **New feature privilege** `version_history.view` (category: Audit / Versions) wired to the new permission via `FEATURE_TO_PERMISSION_MAP` in `feature-privileges.ts`.
- **New sidebar item** `version-history` in `sidebar-items.ts` + `sidebar-privilege-map.ts`. Render hook in `apps/web/src/components/layout/sidebar.tsx`.
- **Route gates updated** on the four `/versions` endpoints + their underlying entity list/detail endpoints (cleaning-profiles, filter-profiles, checklist-profiles, equipment-groups). Each gate now uses `requireAnyPermission(<existing entity-level perms>, 'VERSION_HISTORY_VIEW')` so a user with only the new permission can browse history without entity edit rights.
- **New page** `apps/web/src/routes/version-history/index.tsx`. Layout: 4-tab bar (Cleaning Profiles / Filter Profiles / Checklist Profiles / Equipment Groups). Each tab: master-detail with the entity list on the left (current version badge), version timeline on the right (newest-first, with archive timestamps + author UUID prefix + change notes when present). Click a version row → opens a modal with the frozen snapshot (JSON pretty-print for v1; structured per-entity viewers are a follow-up).
- **Route registered** in `main.tsx` at `/version-history` with `<RequireRole permissions={[PERMISSIONS.VERSION_HISTORY_VIEW]}>`.

### Verification

- `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0.
- `npx tsc --noEmit` (apps/web) exit 0.
- Full API compile to dist exit 0; service restart clean.
- End-to-end via curl as superadmin: all 4 entity list endpoints (cleaning-profiles, filter-profiles, checklist-profiles, equipment-groups) returned 200. The new permission is in the live SUPER_ADMIN role's permission array (verified via psql: `perm_count: 90, has_vh: t`).
- The OR-permission gate is mechanical: `requireAnyPermission` returns true if any of the listed perms is in the user's permission set. Server-side gating is enforced.

### Notes

- v1 page renders snapshots as JSON pretty-print. A future iteration could add structured per-entity viewers (e.g., a pipeline-graph diff for cleaning profiles, a question-list diff for checklist profiles).
- Live counts after this batch: **106 permissions** (was 105), **90 feature privileges** (was 89), **26 sidebar items** (was 25). Reauth actions unchanged at 81.
- Full re-seed not run; live SUPER_ADMIN role updated directly via SQL UPDATE per `feedback_role_perms_after_restore`. `seed.ts` updated for next clean restore.
- The new endpoints existed before this work (Phase A.1–A.4); only the gating permission was relaxed. No API additive surface.

---

## [Unreleased] — P3: AWS SNS dropped; MSG91 / Twilio / similar over generic HTTP gateway (2026-05-02)

Branch: `feature/phase5-verification`. Per user direction: "remove AWS SNS dependencies — we'll do API POST to MSG91 or Twilio or similar service." The `http-gateway` provider already existed in the codebase as a generic templated POST adapter; this change makes it the default and removes the AWS SNS path entirely.

### Background

`apps/api/src/modules/notification-delivery/channels/sms-channel.ts:75` shelled out to the `aws` CLI via `child_process.spawn` to publish SMS via SNS. That made the runtime depend on the AWS CLI being installed on the Windows host — incompatible with the local-Windows-only deployment. Operators who want AWS now configure the http-gateway provider against the SNS REST endpoint (or any other provider — MSG91, Plivo, AfricasTalking, Kaleyra, Twilio's own REST). The http-gateway adapter accepts a configurable URL, method, headers map, and body template with `{phone}` / `{message}` placeholders.

### Changes

- **Backend**:
  - `apps/api/src/modules/notification-delivery/channels/sms-channel.ts` — removed `sendViaAwsSns()` (the spawn-aws-cli function), removed the `'aws-sns'` switch case in `send()` and `testConnection()`. Twilio + Vonage + http-gateway remain.
  - `apps/api/src/modules/notification-delivery/types.ts` — `SmsConfig.provider` union narrowed from `'twilio' | 'aws-sns' | 'vonage' | 'http-gateway'` to `'twilio' | 'vonage' | 'http-gateway'`. Dropped `awsAccessKeyId / awsSecretAccessKey / awsRegion` fields.
  - `apps/api/src/modules/notification-delivery/routes.ts` — removed `'aws-sns'` from the provider enum on `PUT /api/notification-settings/sms`. Dropped the `awsAccessKeyId / awsSecretAccessKey / awsRegion` body schema entries. Dropped from `sensitiveKeys` mask list (no longer applicable). Dropped from the audit-log redaction call.
  - `apps/api/src/modules/config/defs/notification-sms.def.ts` — provider select now offers `http-gateway` (default), `twilio`, `vonage`. AWS SNS gone.
- **Frontend**:
  - `apps/web/src/routes/config/notification-settings/{sms-settings,email-settings}.tsx` — removed `awsAccessKeyId / awsSecretAccessKey / awsRegion` from the `SmsConfig` interface, the `defaultValues` literal, and the AWS SNS provider config block. `SMS_PROVIDERS` now lists `http-gateway` first (with a description naming MSG91 / Plivo / AfricasTalking / Kaleyra). Default provider switched to `http-gateway`.
- **Rule-chain `aws-sns` / `aws-sqs` / `aws-lambda` nodes** — left in place. They're stub no-op nodes that just annotate the message and pass through; they do NOT carry a real AWS dependency. Out of scope for "drop AWS SNS dependencies."

### Verification

- `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0 (twice — once after the channel/types/def changes, once after the routes.ts cleanup).
- `npx tsc --noEmit` in `apps/web` exit 0.
- Full compile to dist exit 0; **dist contains zero references** to `aws-sns / sendViaAwsSns / awsAccessKeyId / awsSecretAccessKey / awsRegion` (verified via grep against `apps/api/dist/modules/notification-delivery/`).
- `Restart-Service DigiLogAPI-Phase5` clean.
- End-to-end via curl:
  - `PUT /api/notification-settings/sms` with a MSG91-style body template via `http-gateway` provider → `200 success`.
  - `GET /api/notification-settings/sms` → returned the persisted config with the body template intact.
  - `PUT /api/notification-settings/sms` with `provider: "aws-sns"` → `400 VALIDATION_ERROR` from the route schema enum (`allowedValues: ["twilio", "vonage", "http-gateway"]`). Confirms the new shape is enforced server-side, not just in the FE dropdown.
- Test config wiped from `system_config` after verification.

### Notes

- The http-gateway provider supports `{phone}` and `{message}` placeholders in URL and body template. Headers map is configured per-provider (e.g., `authkey` for MSG91, `Authorization: Basic …` for Twilio's REST endpoint).
- Existing rows in `system_config` with `provider: 'aws-sns'` will still load (the runtime `switch` falls through to "Unknown SMS provider"), so any configured installation will silently stop sending until the operator updates the provider. **No automatic migration** since aws-sns config rows are credentials-only — operators must reconfigure to a real provider regardless.
- No new package dependencies. The http-gateway path was already in the codebase; only field/type plumbing was changed.

---

## [Unreleased] — P1: cycle-side EquipmentGroup version pinning + latent FK bug fix (2026-05-02)

Branch: `feature/phase5-verification`. Closes the operational drift gap left by Phase A.4 (which versioned the EquipmentGroup composite but didn't pin to the cycle). Server-side only — tablet contract documented in `future/offline-version-sync-contract.md` for the next APK build cycle (Slice B).

### Background

Phase A.4 added `EquipmentGroupVersion` snapshots so admin edits archive history. But `cleaning_cycles` had no per-cycle version reference, so reading validation in `filter-operations.service.ts` read the **live** group row and validated against current operating ranges. An admin edit to operating ranges between cycle-start and reading-submit would change the rules a cycle was held to, breaking audit replay byte-correctness. P1 closes this gap on the server side.

### Changes

- **Schema** (`apps/api/prisma/schema.prisma`):
  - `CleaningCycle.equipmentGroupVersionPin Int? @map("equipment_group_version_pin")` — nullable, set when a group is bound to the cycle (at start-cycle or first lazy-bind during reading-submit). Legacy cycles + cycles that never bind a group keep `NULL` and the validator falls back to the live row.
  - Applied via `prisma db push --skip-generate` — empty cycle table, no backfill.
- **Service** (`apps/api/src/modules/filter-operations/filter-operations.service.ts`):
  - `startCycle()` (~line 859) — when `equipmentGroupId` provided, fetches the live group's `version` and stamps it onto `cleaning_cycles.equipmentGroupVersionPin`.
  - Reading auto-resolve path (~line 1086-1098) — when a cycle lazy-binds a group during reading-submit, also stamps the live version into `equipmentGroupVersionPin`.
  - Reading validation (~line 1101-1175) — branches on `cycle.equipmentGroupVersionPin`:
    - `pin !== null`: read `equipmentGroupVersion.findUnique({ groupId_versionNumber: { groupId, versionNumber: pin } })` and validate `operatingMin/Max` from `snapshot.instruments[]`. If the version row is missing (lazy first-version pattern: live row IS v1 until first edit), assert live row's `version === pin` and use the live row directly. If live version drifts unexpectedly, throw `409 GROUP_VERSION_MISSING`.
    - `pin === null`: legacy fallback — read live row, validate against current ranges. Documented as a known drift gap kept only for backwards compat with pre-P1 cycles.
- **Latent pre-existing bug fix** (caught during P1 verification):
  - Line 877 was `profileId: resolvedProfileIdForCycle` but `cleaning_cycles.profile_id` FKs to `filter_cleaning_profiles.id`, not `filter_profiles.id`. `resolveFilterProfile()` returns either depending on whether the filter has a `FilterDetails.filter_profile_id` binding (returns FilterProfile id) or only a config-based rule (which *might* return a CleaningProfile id directly). The bug was masked because no FilterDetails-bound cycle had ever been started in the dev DB — every prior test went through the config-based path. Fixed: now uses `cleaningProfileIdForCycle` (computed at line 820).

### Verification

- `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0; full compile to dist exit 0.
- `prisma db push --skip-generate` reports schema in sync; `equipment_group_version_pin` column present on `cleaning_cycles`.
- End-to-end via curl on existing block B1 + filter F1:
  - Seeded a CleaningProfile (with `cleaningReasons: [{key:"p1_test", name:"P1 Test", isActive:true}]`), a FilterProfile pointing at it, a FilterDetails binding F1 to the FilterProfile, an EquipmentGroup with 3 instruments (Air `2-6`, RO `1-4`, Dryer `60-120`).
  - `POST /api/filters/F1/start-cycle` with `equipmentGroupId` → cycle created with `equipmentGroupVersionPin: 1` in the response and DB row. **Verifies pin is stamped at start-cycle.**
  - `PUT /api/equipment-groups/<id>` to bump Air `operatingMax: 6 → 7` → live group becomes v2; `equipment_group_versions` v1 row carries the original Air `operatingMax: 6`.
  - DB inspection after: cycle row's `equipment_group_version_pin = 1` (unchanged); live group `version = 2`; v1 snapshot row has Air `operatingMax = 6`. **Verifies cycle pin is immune to admin edits.**
  - Pinned-snapshot validation path is exercised whenever `cycleVersionPin !== null` — full integration through the advance() pipeline graph requires a real cleaning-profile pipeline (out of scope for the bug-fix verification); structural correctness verified via the schema + DB row + tsc + service code-path branch logic.
  - Latent FK bug fix verified: start-cycle no longer fails with `cleaning_cycles_profile_id_fkey` when the filter has a FilterDetails-bound FilterProfile.
- Test data fully cleaned up: 0 leftover cycles, groups, group versions, FilterProfiles, or seeded CleaningProfile rows.

### Notes

- **Tablet/offline app NOT updated by this change.** The tablet keeps its current behavior — caches whatever `getCurrentState()` returns, submits readings without sending a version number. The server validates against the cycle's pinned version regardless. Operator UX is slightly inconsistent (display = live ranges, validation = pinned ranges) until Slice B lands. Per `future/offline-version-sync-contract.md`, Slice B will:
  - Make `getCurrentState()` return the pinned snapshot in `equipmentGroup`.
  - Add `expectedGroupVersion: number` to the reading-submit body.
  - Return `409 SCHEMA_DRIFT` with the pinned snapshot embedded so the tablet can self-heal.
  - This is bundled with the next APK build cycle (mirrors the A.1 ChecklistProfile contract).
- The latent FK bug had been waiting since whenever the FilterProfile-via-FilterDetails path was added. P1's verification scenario is the first time a FilterDetails-bound cycle actually started in this DB. The fix is one line; no schema change.
- Per-cycle group-version pinning was the deferred item from the Phase A.4 entry of `tasks/STEP-5B-A-VERSIONING-PLAN.md`. **Now closed.**

---

## [Unreleased] — Step 4: FilterProfile.applicableTemplates JSONB → join table (2026-05-02)

Branch: `feature/phase5-verification`. From the 9-step architectural-refactor plan; closes Step 4. Removes a long-standing dangling-FK-via-JSON foot-gun.

### Background

`FilterProfile.applicableTemplates` was `Json @default("[]")` storing an array of `AssetTemplate` UUIDs as plain strings. No FK enforcement: deleting an `AssetTemplate` left orphan UUIDs in every JSON array that pointed at it. The dangling refs passed DB validation, the JOIN-via-IN-clause silently dropped them, and there was no audit trail of what got orphaned.

### Changes

- **Schema** (`apps/api/prisma/schema.prisma`):
  - Dropped `FilterProfile.applicableTemplates Json` column.
  - Added new model `FilterProfileApplicableTemplate` — composite-PK `(profileId, templateId)`, both FKs `onDelete: Cascade`, `@@index([templateId])`, `@@map("filter_profile_applicable_templates")`.
  - Reverse relations: `FilterProfile.applicableTemplates: FilterProfileApplicableTemplate[]` and `AssetTemplate.filterProfileBindings: FilterProfileApplicableTemplate[]`.
  - Applied via `prisma db push --skip-generate` against an empty `filter_profiles` table — no backfill needed.
- **Service** (`apps/api/src/modules/filter-profiles/filter-profile.service.ts`):
  - `create()` — wrapped in `prisma.$transaction`; creates the FilterProfile row, then `createMany` the join rows. Verifies all incoming template IDs exist (returns 400 with the missing list) before opening the transaction.
  - `update()` — when the caller provides `applicableTemplates`, replaces the join set inside the existing snapshot-then-bump transaction (`deleteMany` + `createMany`). Same upfront ID-existence check as `create()`.
  - `list()` / `getById()` — `include: { applicableTemplates: { select: { templateId: true } } }` then flatten via a small helper to keep the wire shape `applicableTemplates: string[]`. **No FE change.**
  - **A.3 snapshot fix** — `snapshotAndBump()` now reads the live join rows inside the transaction and freezes them as `string[]` in `FilterProfileVersion.snapshot.applicableTemplates`, so historical replay still works byte-correct.
- **AssetTemplate delete guard** (`apps/api/src/modules/assets/services/template.service.ts`):
  - Before `softDelete()`, count `filter_profile_applicable_templates` rows for `templateId`. If > 0, throw `ConflictError` (`409 IN_USE`) listing the binding profiles by name. The cascade FK on the join table is the safety net for hard deletes (super-admin paths, backup-restore); this guard is the user-facing path.

### Verification

- `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0; full compile to dist exit 0.
- `prisma db push` reports schema in sync; `\d filter_profile_applicable_templates` confirms columns + cascade FKs; `applicable_templates` column gone from `filter_profiles`.
- `Restart-Service DigiLogAPI-Phase5` clean.
- End-to-end via curl:
  - Seeded an ACTIVE FilterCleaningProfile so a FilterProfile could reference one.
  - `POST` with two real template UUIDs → response carries `applicableTemplates: ["…", "…"]` as `string[]`.
  - `POST` with a bogus template UUID → clean `400 VALIDATION_ERROR` listing the unknown ID.
  - `PUT` removing one template → response shows the shorter array; `version` bumped to 2.
  - `GET /:id/versions/1` → frozen v1 snapshot still has BOTH templates as `string[]`. v3-style isolation works for the join data.
  - `DELETE /api/assets/templates/<bound-template-id>` → clean `409 CONFLICT` with `Cannot delete template "Block-T": still bound by 1 filter profile(s) [S4 Test Filter Profile]. Remove these bindings first.`.
  - `DELETE /api/assets/templates/<unbound-template-id>` (the second template, after PUT detached it) → `200 success`.
- Test data fully cleaned up — 0 leftover rows in `filter_profiles`, `filter_profile_versions`, `filter_profile_applicable_templates`; the seeded cleaning profile dropped; the unbound template restored to `is_active = true` so the dev DB stays usable.

### Notes

- **Decision recorded**: AssetTemplate delete blocks on FilterProfile bindings (option b). The cascade FK is the safety net, not the operator-visible path. Consistent with the existing FilterProfile delete-guard against FilterDetails references.
- `allowedBlocks` stays JSONB — only used when `blockRestriction = SPECIFIC_BLOCKS`; the conditional case doesn't justify a join table.
- Frontend untouched — no `applicableTemplates` references exist under `apps/web/src` (verified via grep). The wire shape preserved by the flatten helper means even FE-side type definitions don't need to change immediately.
- Model count: **68 → 69** (added `FilterProfileApplicableTemplate`). Enum count unchanged at 23.

---

## [Unreleased] — Phase A.4: EquipmentGroup composite versioning + cleaning-reasons doc note (2026-05-02)

Branch: `feature/phase5-verification`. Final entry in the universal-versioning rollout (A.1 = ChecklistProfile sidecar, A.2 = FilterCleaningProfile lineage, A.3 = FilterProfile sidecar). Closes Phase 5b Path A.

### Background

A.4 had two declared sub-targets: cleaning reasons (config def values) and equipment-group instruments. They turned out to need very different treatments:

1. **Cleaning reasons** are stored in a `SystemConfig` row keyed `filter-cleaning-reasons` as a JSON list of `{ key, label }`. The drift concern (admin renames a reason mid-cycle) was already handled at design time — `CleaningCycle.cleaningReasonKey` and `cleaningReasonLabel` are written at cycle start (`apps/api/prisma/schema.prisma:1431-1432`), so cycles carry their own label snapshot. Editing the config later affects new cycles only. **No code change needed**, only this doc note.
2. **Equipment-group instruments** mutate in place via `equipment-groups.service.ts → update()`, which mutates the parent group + all 3 instruments together inside one transaction. The natural unit of versioning is therefore the **whole composite** (group + 3 instruments), not each instrument independently — same shape as A.1 ChecklistProfile + questions. Operational drift on submitted readings is already covered by `FilterEvent.attributes.instrumentReadings` (immutable + checksummed; snapshots `description / instrumentCode / uom / leastCount / value` at submit time, `filter-operations.service.ts:1116-1123`). The remaining gap was admin-edit history of the group config itself.

Per-cycle group-version pinning (so reading validation reads operating-range from a pinned version rather than the live row) is intentionally NOT included — that requires a design call on "pin at cycle-start" vs "pin at first-reading" semantics and is left as a separate item.

### Changes

- **Schema** (`apps/api/prisma/schema.prisma`):
  - `EquipmentGroup.version Int @default(1)` — monotonic counter, bumped on every mutation of the group OR any of its instruments.
  - New model `EquipmentGroupVersion` (sidecar): `id`, `groupId`, `versionNumber`, `snapshot Json` (carries `name`, `blockId`, `isActive`, `instruments[]` ordered by sortOrder), `changeNotes`, `createdAt`, `createdBy`. Cascade-deletes with the parent. `@@unique([groupId, versionNumber])` + `@@index([groupId])`.
  - Applied via `prisma db push --skip-generate` against an empty `equipment_groups` table — no backfill needed.
- **Service** (`apps/api/src/modules/equipment-groups/equipment-groups.service.ts`):
  - New private `snapshotAndBump(tx, groupId, changeNotes, ctx)` — freezes the OUTGOING composite (group row + all instruments ordered by sortOrder) into `equipment_group_versions`, then `version: { increment: 1 }`. Mirrors A.1/A.3 helpers.
  - `update()` now wraps the existing transaction with snapshot-then-bump as the first step before the live row mutations.
  - First version is created lazily — `create()` does NOT write a version row; the live composite IS v1 until first edit (matches A.1/A.3).
  - New `getVersions(_, id)` returns `{ groupId, currentVersion, versions[] }` newest-first with metadata only.
  - New `getVersion(_, id, n)` returns the frozen composite snapshot.
  - Audit log on update now includes `version` in `beforeValue`/`afterValue`.
- **Routes** (`apps/api/src/modules/equipment-groups/routes.ts`):
  - `GET /api/equipment-groups/:id/versions` (gated `ASSET_READ` OR `EG_VIEW`).
  - `GET /api/equipment-groups/:id/versions/:versionNumber` (same gate).

### Verification

- `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0; full compile to dist exit 0; new endpoints emit 4 occurrences of "versions" in `dist/modules/equipment-groups/routes.js`.
- `prisma db push --skip-generate` reports schema in sync; `\d equipment_group_versions` confirms columns; `version` column present on `equipment_groups`.
- `Restart-Service DigiLogAPI-Phase5` clean.
- End-to-end via curl against the running service:
  - Created a group on existing block `B1` with the 3 standard instruments → returned `version: 1`. Live composite was v1; no version row written yet.
  - First `PUT` (renamed group + bumped Compressed Air `operatingMax: 6 → 7`) → `version: 2`; one row in `equipment_group_versions` carrying the v1 composite.
  - Second `PUT` (changed Compressed Air `serialNumber` and `instrumentId`) → `version: 3`; two version rows.
  - `GET /:id/versions` → `currentVersion: 3` + 2 archived versions newest-first.
  - `GET /:id/versions/1` → frozen v1 composite (original name, Air `operatingMax: 6`, Air SN `SN-AIR-1`).
  - `GET /:id/versions/2` → frozen v2 composite (renamed, Air `operatingMax: 7`, Air SN still `SN-AIR-1` — the v3 SN/ID change correctly isolated).
  - `GET /:id/versions/99` → clean 404.
- Test data fully cleaned up: 0 leftover rows in `equipment_groups`, `equipment_group_instruments`, `equipment_group_versions` (cascade fired correctly).

### Notes

- Cleaning reasons are NOT versioned and don't need to be — `CleaningCycle.cleaningReasonKey` + `cleaningReasonLabel` already act as the per-cycle pin. This is documented in `BACKEND_GUIDE.md` § "Versioning" and the plan.
- Per-cycle group-version pinning is NOT included; left as a separate design call.
- Frontend untouched — existing route shapes unchanged; new `/versions` endpoints are additive.
- Model count: **67 → 68** (added `EquipmentGroupVersion`). Enum count unchanged at 23.

---

## [Unreleased] — Phase A.3: FilterProfile sidecar versioning (2026-05-01)

Branch: `feature/phase5-verification`. Third entry in the universal-versioning rollout (A.1 = ChecklistProfile sidecar, A.2 = FilterCleaningProfile lineage).

### Background

FilterProfile is the per-mapping table that binds a filter to a `FilterCleaningProfile` (plus block-restriction policy, applicable templates, default PM schedule). Unlike FilterCleaningProfile (immutable-rowful), the live FilterProfile row was being mutated in place by `update()` — there was no version history, so an audit replay had no way to reconstruct the mapping that was active at a historical moment. FilterProfile is the same across all blocks (per-block override is explicitly out of scope), so the design follows the A.1 ChecklistProfile sidecar pattern rather than A.2's lineage pattern.

In-flight cycles are unaffected: cycles already pin `cleaning_cycles.profileId` (and `profileVersion`) to a specific FilterCleaningProfile row at start, so FilterProfile drift cannot reach a running cycle. No cycle-side pin map is needed.

### Changes

- **Schema** (`apps/api/prisma/schema.prisma`):
  - `FilterProfile.version Int @default(1)` — monotonic counter, bumped on every mutation.
  - New model `FilterProfileVersion` (sidecar): `id`, `profileId`, `versionNumber`, `snapshot Json`, `changeNotes`, `createdAt`, `createdBy`. Cascade-deletes with the parent. `@@unique([profileId, versionNumber])` + `@@index([profileId])`.
  - Applied via `prisma db push --skip-generate` against an empty `filter_profiles` table — no backfill needed.
- **Service** (`apps/api/src/modules/filter-profiles/filter-profile.service.ts`):
  - New private `snapshotAndBump(tx, profileId, changeNotes, ctx)` writes the OUTGOING row's full state into `filter_profile_versions`, then `version: { increment: 1 }`. Mirrors the A.1 helper.
  - `update()` now wraps the mutation in `prisma.$transaction` with snapshot-then-bump first.
  - First version is created lazily — `create()` does NOT write a version row; the live row IS v1 until the first edit.
  - New `getVersions(id)` returns `{ profileId, currentVersion, versions[] }` newest-first with metadata only (id, versionNumber, changeNotes, createdAt, createdBy).
  - New `getVersion(id, n)` returns the frozen snapshot as `{ profileId, versionNumber, …snapshot fields, createdAt, createdBy, changeNotes }`.
  - Hard-delete-with-guard preserved (rejects if any FilterDetails still reference the profile). Cascade drops version rows.
  - Audit log on update now includes `version` in `beforeValue`/`afterValue`.
- **Routes** (`apps/api/src/modules/filter-profiles/routes.ts`):
  - `GET /api/filter-profiles/:id/versions` (gated on `FP_READ`).
  - `GET /api/filter-profiles/:id/versions/:versionNumber` (gated on `FP_READ`).

### Verification

- `npx tsc -p apps/api/tsconfig.json --noEmit` exit 0.
- `npx tsc -p apps/api/tsconfig.json` (compile to dist) exit 0; new endpoints emit 4 occurrences of "versions" in `dist/modules/filter-profiles/routes.js`.
- `npx prisma db push --skip-generate` succeeds; `\d filter_profile_versions` confirms columns; `version` column present on `filter_profiles`.
- `Restart-Service DigiLogAPI-Phase5` clean.
- End-to-end via curl against the running service:
  - Seeded one `FilterCleaningProfile` (id `…0a301`) directly in DB so a FilterProfile could reference it.
  - `POST /api/filter-profiles` → returned `version: 1`. Live row was v1; no version row written yet (lazy first-version, matches A.1).
  - `PUT /api/filter-profiles/:id` (rename) → `version: 2`; one row in `filter_profile_versions` carrying the v1 snapshot.
  - Second `PUT` (changed `description` and `blockRestriction` to `ANY_BLOCK`) → `version: 3`; two version rows.
  - `GET /:id/versions` → `currentVersion: 3` + 2 archived versions newest-first.
  - `GET /:id/versions/1` → frozen v1 snapshot (original name, original description, `OWN_BLOCK_ONLY`).
  - `GET /:id/versions/2` → frozen v2 snapshot (renamed, first-edit description, still `OWN_BLOCK_ONLY` — the v3 change isolated correctly).
  - `GET /:id/versions/99` → clean 404 with "Version 99 of filter profile … not found".
- Test data fully cleaned up: 0 leftover rows in `filter_profiles`, `filter_profile_versions`, and the seeded `filter_cleaning_profiles` row.

### Notes

- Per-block override capability (originally floated for Step 7) is explicitly NOT in scope — the user confirmed FilterProfile is uniform across all blocks. The Step 7 entry in `future/architectural-refactor-9-steps.md` should be revisited under that constraint.
- Frontend untouched — existing route shapes are unchanged; new `/versions` endpoints are additive.
- Model count: **66 → 67** (added `FilterProfileVersion`). Enum count unchanged at 23.

---

## [Unreleased] — Phase A.2: FilterCleaningProfile lineage-based versioning (2026-05-01)

Branch: `feature/phase5-verification`. Continuation of the universal-versioning rollout (Phase A.1 covered ChecklistProfile).

### Background

FilterCleaningProfile already used immutable-rowful versioning: `update()` archived the old row (`status=ARCHIVED`) and inserted a new row with `version+1`. Cycles freeze `profileId` at start, so historical replay was already pointing at the exact archived row. The remaining gaps were:

1. The `list()` view grouped by `name` (`distinct: ['name']`), so renaming a profile during an update orphaned the version history into separate "lineages."
2. There was no API to enumerate version history of a profile.
3. There was no API to fetch a frozen snapshot at a specific version.
4. Hard-deleting a profile was protected only by the FK on `cleaning_cycles.profile_id` — no service-level guard with a useful error.

### Changes

- **Schema** (`apps/api/prisma/schema.prisma`):
  - `FilterCleaningProfile.lineageId String @db.Uuid` (NOT NULL).
  - `@@unique([lineageId, version])` to enforce one row per (lineage, version).
  - `@@index([lineageId])` for lineage lookups.
  - Applied via direct DDL on empty `filter_cleaning_profiles`; `prisma db push` reports schema in sync.
- **Service** (`apps/api/src/modules/cleaning-profiles/cleaning-profile.service.ts`):
  - `create()` mints a fresh `lineageId` (`randomUUID()`).
  - `update()` propagates parent's `lineageId` to the new version row.
  - `list()` now uses `distinct: ['lineageId']` instead of `distinct: ['name']` — rename-safe.
  - New `getVersions(id)` and `getVersion(id, n)` methods.
  - New `deleteProfile(id)` with explicit cycle + filter-profile reference checks (returns 409 with helpful message before relying on the DB FK).
- **Routes** (`apps/api/src/modules/cleaning-profiles/routes.ts`):
  - `GET /api/filter-cleaning-profiles/:id/versions` — list all versions in lineage.
  - `GET /api/filter-cleaning-profiles/:id/versions/:versionNumber` — frozen snapshot.
  - Both gated on `FCP_READ` or `CP_TOGGLE`.

### Verification

- `npx tsc -p apps/api/tsconfig.json` exit 0.
- `npx prisma db push --skip-generate` reports "already in sync" (DDL applied directly first).
- Synthetic seed of two versions sharing one `lineageId`:
  - `GET /api/filter-cleaning-profiles?page=1&limit=5` → 1 latest entry (collapse correct).
  - `GET /:v2/versions` → both versions, latest first.
  - `GET /:v1/versions` → identical lineage response from archived anchor.
  - `GET /:v1/versions/2` → frozen v2 snapshot with stages/connections.
  - `GET /:v1/versions/99` → clean 404 with "Version 99 not found in lineage" message.
- Seed cleaned up post-test (DELETE 2).

### Notes

- `cleaning_cycles.profile_id` FK has no `onDelete: Cascade`, so the DB enforces RESTRICT on hard delete of any cycle-referenced profile. The new service-level guard improves the error UX before the DB blocks it.
- Frontend untouched — API response shapes unchanged for existing routes; new `/versions` endpoints are additive.

---

## [Unreleased] — Auth-loop fix: cached-user kept page bouncing /login ↔ / (2026-05-01)

Branch: `feature/phase5-verification`. Surfaced during full UI e2e walk after Step 6 verification, but the bug pre-dates Step 6 — it's a latent issue in the auth state machine that became visible when a session was concurrently invalidated server-side.

### Symptom

When the JWT session was terminated server-side (single-tab takeover, idle timeout, parallel-login eviction), the browser tab kept ping-ponging between `/login` and `/` and the dashboard rendered with `Total Users: -` / `Audit Trail: -` placeholders that never resolved. Console accumulated thousands of 401 + "Missing token" errors per minute.

### Root cause

Two pieces of state colluded:
1. `apps/web/src/lib/api-client.ts` cleared the access token on 401 but **left `digilog_cached_user`** in localStorage.
2. `apps/web/src/hooks/use-auth.ts` computed `isAuthenticated` as `!!user && (!error || isNetworkError(error))` — purely from the user object. With a cached user still in localStorage, `isAuthenticated` stayed truthy even when the token had been cleared.

The result: api-client redirected to `/login`, login.tsx saw `isAuthenticated === true` (stale cached user), `<Navigate to="/" replace />` fired, dashboard mounted, SWR queries fired without a token, server returned 401, api-client redirected to `/login`, repeat forever.

### Fix

- **`apps/web/src/lib/api-client.ts:38-54`** — on a non-login 401, also drop `digilog_cached_user`, `digilog_active_tab_id`, `digilog_tab_heartbeat`, `digilog_active_user_id`. Same cleanup `logout()` already does.
- **`apps/web/src/hooks/use-auth.ts:185`** — `isAuthenticated` now requires `getToken()` truthy in addition to user + non-network-error. A stale cached user without a token can no longer keep the app authenticated.

### Verification

- `npx tsc --noEmit` exit 0 (web)
- `npx vite build` rebuilt the web bundle (new hash `index-DHUGfJFQ.js`); web service restarted; SW unregistered + cache cleared in browser.
- Reproduced the loop pre-fix (5933 console errors in 17 seconds, URL bouncing between `/` and `/login`).
- Re-tested post-fix: login → dashboard renders fully (Total Users 2, Audit Trail 2, Notifications 1, Filter Cleaning Analytics section visible). 1 console error on second login (expected 409 from "Active Session Detected" — not the loop).

### Out of scope

This fix is independent of Step 6. It would have surfaced equally under Step 1 + MT removal alone if a session got server-side-invalidated mid-flight. The full UI walk for Step 6 verification is what triggered the discovery.

---

## [Unreleased] — Architectural Refactor Step 6 of 9: FilterDetails 1:1 split (2026-05-01)

Branch: `feature/phase5-verification`. Step 6 of the 9-step architectural refactor (see `tasks/STEP-6-FILTERDETAILS-PLAN.md`). Splits filter-specific cycle state off the generic `AssetInstance` model into a 1:1 sidecar so non-filter rows stop carrying nullable cycle columns that are meaningless to them.

### Schema

- **New model `FilterDetails`** (1:1 with AssetInstance via `assetInstanceId` unique FK, cascade on delete). Holds: `filterProfileId` (FK → FilterProfile), `currentLifecycleState` (varchar), `currentCycleId` (FK → CleaningCycle), `filterSet` (`FilterSetLabel?`), audit timestamps. Indexed on `currentLifecycleState`, `currentCycleId`, `filterProfileId`.
- **Dropped from `AssetInstance`:** `filterProfileId`, `currentLifecycleState`, `currentCycleId`, `filterSet` columns; `filterProfile` and `currentCycle` relations; `@@index([currentLifecycleState])`. Net: AssetInstance is now generic again.
- **Inverse relations moved:** `FilterProfile.assetInstances` → `FilterProfile.filterDetails`; `CleaningCycle.activeInstances` → `CleaningCycle.activeFilterDetails`.
- **Net model count:** 64 → **65**.

### Backend

- **New helper module:** `apps/api/src/lib/filter-details.ts` with `getFilterCore`, `upsertFilterDetails`, `clearFilterCycle`, `flattenFilterFields`, `flattenFilterFieldsAll`. Centralises the read+flatten and upsert+create patterns so service code reads the same shape it always did.
- **Eager FilterDetails creation:** `instance.service.ts.create()` now also creates a `FilterDetails` row inside the same transaction when the template's `templateKind === 'FILTER'`. Saves null checks downstream and prevents bootstrap races at first cycle start. Other template kinds (BLOCK, AHU, AREA, EQUIPMENT, OTHER) never get a sidecar row.
- **Repository flatten on every read path:** `instance.repository.ts` `findMany`, `findTree`, `findById`, `findByIdSimple`, `findChildren` all `include: { filterDetails: true }` and call `flattenFilterFields` so API responses stay flat (`filterProfileId / currentLifecycleState / currentCycleId / filterSet` appear on the instance object exactly as before). **Frontend code unchanged.**
- **Service rewrites:**
  - `filter-operations.service.ts`: `getFilter` private rewritten to include + flatten; all 7 write sites (start/advance/bypass/complete/terminate/retire/replace) routed through `prisma.filterDetails.upsert/update` or the helper; lock-checks inside transactions read from `FilterDetails`; `getDashboardStats` `groupBy` switched from `assetInstance.groupBy(by: currentLifecycleState)` to `filterDetails.groupBy(by: currentLifecycleState, where: { assetInstance: { isActive: true } })`; `getCycles`/`getCycleById`/`getRetirements` updated to read `filterSet` from `filterDetails`.
  - `cleaning-profile.service.ts`: `listAssignedAssets` reads via `assetInstance.findMany({ where: { filterDetails: { is: { filterProfileId: { in: ... } } } } })`; `assignAssets` writes via `filterDetails.updateMany` (unassign) + per-instance `upsert` (assign — keeps legacy non-eager assets working).
  - `filter-profile.service.ts`: `delete` count + `assign` write routed through `filterDetails`. Filter-profile list now uses `_count: { filterDetails: true }` instead of `_count: { assetInstances: true }`.
  - `bulk-upload-filter.service.ts`: bulk filter create now writes `filterSet` + `filterProfileId` via `tx.filterDetails.create` after `tx.assetInstance.create` (instead of inlining them on the asset).
  - `pm-schedule.service.ts`: AHU child-filter queries include `filterDetails: { select: { filterSet: true } }` and read it through the relation.
  - `super-admin/routes.ts`: retired-filter edit route writes `filterSet` to `FilterDetails` via upsert; unretire writes `currentLifecycleState: null` to `FilterDetails`; `cleaning-cycles` delete clears `currentCycleId/currentLifecycleState` via `filterDetails.updateMany`.
  - `instance.service.ts`: `changeLifecycleState` writes via `upsertFilterDetails`; instance updatedBy bump kept on AssetInstance.

### Frontend

- **Zero changes required.** API response shape preserved via repository flatten. Tested: `/api/assets/instances` and `/api/filters/batch-states` return objects with the 4 fields directly on the instance, exactly like before.

### Verification

- `npx prisma validate` clean; `npx tsc --noEmit` (backend) exit 0; web `npx tsc --noEmit` exit 0.
- DB reset + reseed succeeded.
- End-to-end:
  - Created Block→AHU→Filter chain with non-canonical template names ("Block-T", "AHU-T", "Filter-T") — confirmed eager FilterDetails creation only for FILTER template kind (DB sanity: 3 asset_instances active, 1 filter_details row).
  - PATCH `/api/assets/instances/:id/lifecycle-state` to `WASH_IN` → `currentLifecycleState` landed on FilterDetails; response shape flat with field on instance.
  - `dashboard-stats.stageCounts.WASH_IN: 1` — groupBy via FilterDetails works.
  - `batch-states` returns `currentState: "WASH_IN"` (read via flatten); `homeBlock` resolves correctly.
  - `pm-schedules/ahu-configs` returns 1 AHU with 1 child filter (templateKind+FilterDetails join works).

### Out-of-scope (intentionally deferred)

- **Step 5b checklist hardening** (questions snapshot on event, offlinePerformedAt, cycleId in clientOpId dedup, etc.) — will land after Step 6 per the agreed sequencing.
- **DB-level constraint that FilterDetails only exists for templateKind=FILTER** — eager creation enforces it operationally; CHECK constraint is Tier-2 polish.
- **Performance tuning** — hot-path `current-state` becomes a join, but it was already a multi-query path; no measurable regression in the smoke run.

### Standing rule notes

- OPERATOR `RB0001` re-seeded with default password `Test@1234` (the password rotation from yesterday's testing was wiped by the DB reset).
- PM module is enabled in config (left ON from yesterday's verification; reseed preserves it).

---

## [Unreleased] — Codex Adversarial Review fixes (2026-05-01)

Branch: `feature/phase5-verification`. Three findings raised by `/codex:adversarial-review` against the uncommitted Step-1 + MT-removal diff. All three plus three additional bugs surfaced during the audit are fixed in the same batch.

### Fixed

- **[high security] Default-deny visibility for non-admin asset endpoints.** `apps/api/src/modules/assets/routes/instance.routes.ts` — both `GET /api/assets/instances` and `/instances/tree` would return *all* entities to a non-admin user when they had no USER/ROLE/template assignments. Both endpoints now apply `{ id: { in: [] } }` (Prisma emits `WHERE 1=0`) for the list, and return `[]` for the tree. Verified end-to-end with OPERATOR `RB0001` (zero assignments) → list = `{"data":[],"total":0,...}`, tree = `[]`.
- **[high] Six service-layer canonical-template-name lookups replaced with `templateKind` codes.** Step 1 made the frontend kind-aware but six backend hot-path queries still keyed off the editable `template.name`. Renaming the canonical Block/AHU/Filter template would have silently broken offline state caching, dashboards, PM aggregation, and Block change validation.
  - `apps/api/src/modules/filter-operations/filter-operations.service.ts:112` — `getFilterHomeBlock()` now matches `template.templateKind === 'BLOCK'` (Codex didn't flag this — found during audit).
  - `apps/api/src/modules/filter-operations/filter-operations.service.ts:243` — `getBatchStates()` now filters `template: { templateKind: 'FILTER' }`.
  - `apps/api/src/modules/filter-operations/filter-operations.service.ts:1246` — `getDashboardStats()` total-filter count uses `templateKind`.
  - `apps/api/src/modules/pm-schedules/pm-schedule.service.ts:459` — bulk PM upload AHU lookup now filters instances directly via `template: { templateKind: 'AHU' }` (eliminates a now-unsafe two-step template-by-name → instance-by-templateId lookup; Codex didn't flag).
  - `apps/api/src/modules/pm-schedules/pm-schedule.service.ts:620` — `listAhuFilterSetConfigs()` AHU lookup same fix (Codex didn't flag).
  - `apps/api/src/modules/pm-schedules/pm-schedule.service.ts:638` — child-filter count under each AHU uses `template.templateKind === 'FILTER'`.

### Verified end-to-end (renamed-template tolerance)

- Created an AHU-kind template named **"Renamed AHU Tpl"**, a FILTER-kind template named **"Renamed Filter Tpl 5b"**, and a BLOCK-kind template named **"Renamed Block Tpl"** — none of them match the canonical names that the old name-based lookups expected.
- Built a Block→AHU→Filter chain and confirmed:
  - `GET /api/filters/dashboard-stats` → `totalFilters: 1` (was 0 pre-fix).
  - `GET /api/filters/batch-states` → returns the renamed-template filter (was empty pre-fix).
  - `GET /api/filters/:id/current-state` → `homeBlock: { id, name: "Test Block 5b" }` (was `null` pre-fix).
  - `GET /api/pm-schedules/ahu-configs` (after enabling PM module) → `{"ahus":[{"ahuId":..,"ahuName":"Test AHU 5b","totalFilters":1,...}]}` (was `{"ahus":[]}` pre-fix).
- Regression sweep: `templates`, `instances`, `tree`, `template-kinds`, `dashboard-stats`, `checklist-profiles`, `users`, `audit` all 200 OK as superadmin.

### Out of scope (intentionally left)

- Rule-chain user-authored filters that match by `template.name` (`filter-nodes.ts`, `analytics-nodes.ts`) — these are user-defined rule conditions; the choice to filter by name vs kind belongs in the rule definition, not the engine. Future enhancement: expose a `templateKind` filter alongside.
- Display-only `template.name` reads (UNS path construction, audit-log labels, report variable substitution, entity-resolver context). These are labels, not canonical lookups.

### Notes

- OPERATOR `RB0001` password rotated during testing from `Test@1234` → `Test@12345`. Cannot revert because password policy blocks reuse of last 12 passwords.
- API service rebuilt + restarted (NSSM `DigiLogAPI-Phase5`) to pick up the dist changes.

---

## [Unreleased] — Multi-Tenancy Removal (2026-04-30)

Branch: `feature/phase5-verification`. DigiLog is now **single-tenant, single-site, single-company**. Multi-tenancy was removed wholesale because the deployment model (one customer, one company, local Windows install) didn't justify the complexity. Step 3 of the 9-step architectural refactor (`AssetInstance.organizationId NOT NULL`) is **obsolete** as a result — the column was dropped entirely.

### Removed

- **Schema:** `model Organization` deleted. 11 `organizationId` columns dropped (User, AssetTemplate, AssetInstance, FilterCleaningProfile, FilterProfile, ChecklistProfile, BlockChangeRequest, EquipmentGroup, EntityAssignment, TemplateAssignment, DashboardAssignment). 2 `orgId` columns dropped (ReportTemplate, ReportInstance). 5 composite indexes rewritten as single-column. `AssigneeType` enum lost `ORGANIZATION` value. `RoleScope` enum collapsed from `GLOBAL | ORGANIZATION` to just `GLOBAL`. Net model count: 65 → **64**.
- **Backend modules:** `apps/api/src/modules/org-admin/` and `apps/api/src/modules/tenant-admin/` deleted entirely. `apps/api/src/lib/org-scope.ts` (the `orgWhere(ctx)` helper) deleted. `super-admin/routes.ts` lost its 5 organization CRUD endpoints. Net module count: 38 → **36**.
- **Backend logic:** `organizationId` removed from JWT payload, `RequestContext`, `build-context.ts`, `auth plugin` user-pinning, `auth.service.ts` login response. JWT `scope` field always stamps `GLOBAL` now (was `ORGANIZATION` for non-superadmin roles).
- **Shared package:** `ORG_MANAGE`/`ORG_VIEW`/`ORG_CREATE`/`ORG_DELETE` permissions deleted (109 → **105**). `org.view`/`org.manage` privileges deleted (91 → **89**). `ORG_ADMIN` role deleted from default roles + role-hierarchy + scope map + creatable-roles list. `organizations` sidebar item deleted (26 → **25**). `organizationId` field dropped from `createUserSchema` + `updateUserSchema`.
- **Frontend:** `apps/web/src/routes/tenant/` folder deleted (`organizations.tsx` + `org-detail.tsx`). `/organizations` + `/organizations/:id` routes removed from `main.tsx`. "Organizations" sidebar nav item removed. `organizationId` removed from User + Filter types. Organization assignment dropdown stripped from user create/edit; org column dropped from user list. `assignments-tab.tsx` had its ORGANIZATION assignee branch trimmed (USER + ROLE assignees retained). `ahu-dashboard.tsx` lost its org pill. `ldap.tsx` lost its "Default Organization" config. `/config/filter-data-management` permission gate switched from `ORG_MANAGE` to `CONFIG_UPDATE`.
- **Seed:** `ORG_MANAGE/VIEW/CREATE/DELETE` permissions stripped from SUPER_ADMIN + ADMIN role definitions in `prisma/seed.ts`. `vitest.global-setup.ts` no longer auto-creates a "System" org for fresh DBs.

### Verification

- `npx prisma validate` passes; `npx tsc --noEmit` (backend) exits 0; `npx vite build` (frontend) succeeds
- E2E (Playwright) walked through Login, Dashboard, /users + /users/create (no org dropdown), /assets/templates, /config/template-kinds (Step 1 Kind column still works), /audit, /filter-list (Block resolution via `templateKind === 'BLOCK'` still works). Sidebar = 25 items with no Organizations. `/api/organizations` returns 404. JWT inspect shows `scope: "GLOBAL"`.

### Post-MT-removal hardening (same day, 2026-04-30)

Three bugs surfaced during the post-removal e2e walk and were fixed in the same uncommitted batch:

- **`/pm-schedules`** crashed with React error #300 ("rendered fewer hooks than expected"). Root cause: a "PM disabled" early-return at line 143 of `apps/web/src/routes/pm-schedules/index.tsx` ran *before* two hooks (a `useSWR` for instances and a `useMemo` for paginated entries) defined further down. On the second render, when `pmConfig` arrived from SWR and was disabled, the early-return fired and skipped those hooks → React detected the count mismatch. Fix: moved the early-return below all hooks.
- **`/my-tasks`** showed a misleading red "Failed to load tasks: PM scheduling module is not enabled" error when the PM module was disabled. Replaced with an amber-tinted message ("Preventive Maintenance scheduling is disabled. Enable it in Configuration → PM Schedule Settings to start receiving tasks.") gated on the `PM_DISABLED` error code.
- **Any unknown URL** (`/organizations`, typos, etc.) rendered a blank white page because there was no `*` catch-all route. Added `<Route path="*" element={<Navigate to="/" replace />} />` to `apps/web/src/main.tsx` (and the matching `Navigate` import). Net `<Route>` count is now 81.

---

## [Unreleased] — Architectural Refactor Step 1 of 9: Admin-editable TemplateKind lookup (2026-04-30)

Branch: `feature/phase5-verification`. First step of a 9-step architectural refactor (see `tasks/RESUME-STATE-2026-04-30-step1-templateKind-done.md`). Replaces the closed Prisma `TemplateKind` enum with a runtime-editable `TemplateKind` lookup table so SUPER_ADMIN can add new kinds (PUMP, VALVE, COMPRESSOR, etc.) without a code migration. The 6 system kinds (BLOCK / AREA / AHU / FILTER / EQUIPMENT / OTHER) are protected — codes immutable, rows non-deletable — so Filter Management / Cleaning Operations / Mobile pages keep routing by code.

### Added

- `apps/api/src/modules/template-kinds/routes.ts` — new CRUD module under `/api/template-kinds` (list, create, update, delete). System kinds protected from delete + code-rename; in-use kinds protected from delete (409 with helpful messages on each).
- `apps/web/src/routes/config/template-kinds.tsx` — Configuration page with full CRUD UI; system rows show 🔒 badge and Delete is hidden; non-system rows can be deleted only when `templateCount = 0`.
- `packages/shared/src/schemas/assets.ts` — `SYSTEM_TEMPLATE_KIND_CODES` const-array, `SystemTemplateKindCode` type, `templateKindCodeSchema` regex (UPPER_SNAKE_CASE), `createTemplateKindSchema`, `updateTemplateKindSchema`. Barrel-exported in `index.ts`.
- `prisma/seed.ts` — seeds 6 system kinds on every fresh DB.
- New `Kind` column on `apps/web/src/routes/assets/templates.tsx` list (label looked up from kind code via SWR).
- `Template Kind` dropdown on the Create/Edit Template form, fetched from `/api/template-kinds?isActive=true`. Falls back to seeded codes if the API is unreachable.

### Changed

- `enum TemplateKind` removed from `prisma/schema.prisma`; replaced by `model TemplateKind` (id, **code** unique varchar(50), label, description, isSystem, isActive, sortOrder, audit cols).
- `AssetTemplate.templateKind` is now `String @db.VarChar(50)` FK → `TemplateKind.code` (was the closed enum).
- 10 frontend lookup sites converted from `t.name === 'Block'` / `'Filter'` / `'AHU'` / `'Area'` to `t.templateKind === 'BLOCK'` / `'FILTER'` / `'AHU'` / `'AREA'`. Files: filter-list, filter-operations, mobile-operations, mobile-wrapper, plus the bulk-upload-filters dialog. Admins renaming a template ("Block" → "Building") no longer breaks page logic.
- Live counts: 64 → 65 Prisma models, 37 → 38 API modules, 26 → 27 config pages.

### Fixed (caught during step 1 verification)

- `apps/api/src/modules/assets/repositories/template.repository.ts` — type signature accepted `templateKind` but the Prisma `data: { ... }` block was silently dropping the field, causing every created template to land with `OTHER` regardless of the body. Live API test caught it.

### Verified live

- API: `POST /api/template-kinds {code:"PUMP",label:"Pump"}` → 201 with `isSystem: false`.
- API: `DELETE /api/template-kinds/BLOCK` → 409 `SYSTEM_KIND` with operator-friendly message.
- API: `PUT /api/template-kinds/BLOCK {label:"Building"}` → 200 with new label; underlying code preserved.
- API: `DELETE /api/template-kinds/PUMP` (no templates use it) → 204.
- DB: seed creates 6 system kinds + restoring the 4 canonical templates (Block/Area/AHU/Filter) via API persists templateKind correctly.
- UI: SUPER_ADMIN sees Template Kinds Configuration page with all 6 kinds and 🔒 badges.
- UI: Create Template dropdown lists current kinds; selecting BLOCK persists BLOCK after the repo fix.
- Regression test: renaming "Block" template to "Building" in DB does not break Filter Management page (resolves by `templateKind === 'BLOCK'`, not by name).

## [Unreleased] — Phase 5+ managed Windows-service launcher (2026-04-30)

Branch: `feature/phase5-verification`. Closes the only Phase 5+ open item flagged in `PHASE_5_RECENT_WORK.md` § 12 ("a managed Windows-service launcher that registers the API as a Windows service with restart policies, log rotation, and boot persistence"). Plus three TypeScript build fixes uncovered when running `npm run build` against this branch for the first time.

### Added

- `scripts/install-services-phase5.ps1` — registers `DigiLogAPI-Phase5` (`node apps/api/dist/app.js` from `apps/api/`, `DependOnService=postgresql-x64-18`) and `DigiLogWeb-Phase5` (`node apps/web/node_modules/vite/bin/vite.js preview --port 5175 --host` from `apps/web/`) as NSSM-managed services. Configures `Start=SERVICE_AUTO_START` (boot persistence), `AppExit Default = Restart` + `AppRestartDelay=3000` (auto-restart on crash), 10 MB rotated stdout/stderr logs under `logs/`, and `NODE_ENV=production`. Idempotent re-run (existing services stopped + removed first). ASCII-only so PS 5.1 tokenises it correctly when launched via `Start-Process`.
- `scripts/uninstall-services-phase5.ps1` — companion teardown; idempotent (silently skips services that aren't installed).
- `.gitignore` entries for `nssm-path.txt` (per-machine NSSM exe pin) and `logs/` (rotated NSSM stdout/stderr).

### Fixed

- 3 production TypeScript errors blocking `tsc -p apps/api/tsconfig.json` (commit `1697f99`): `checklist-profiles.list` query type missing `expand?: string` (added in `5eb9db8` runtime but never typed); `deployment-check/routes.ts` reading `role.privileges` instead of `role.permissions` (Prisma `Role.permissions` is the actual schema field, line 166); `filter-operations.getFilter` `select` missing `parentId` (retire flow at line 1509 needs it for `_preRetireParentId` snapshot).

### Verified live

- `Get-Service Digi*-Phase5` → both `Running` / `Automatic`.
- `curl https://localhost:3000/api/health` → `{"status":"ok"}`.
- `curl https://localhost:5175/` → 200 (compiled `apps/web/dist/` baked with `VITE_API_URL=https://localhost:3000`).
- Authenticated round-trip (`POST /api/auth/login` → JWT → `GET /api/roles` with bearer) returns real Role rows with `permissions` JSON arrays.
- Crash test: `Stop-Process` of API node pid → NSSM restarted with new pid in <3 s, service stayed `Running`.
- NSSM log rotation working: prior crash's stdout/stderr archived to timestamped `.out-<ts>.log` / `.err-<ts>.log`; fresh `*.out.log` / `*.err.log` for the live process.

---

## [Unreleased] — Phase 5.1 + 5.2 of windows-friendly-rewrite — Verification harness (2026-04-29)

Branch: `feature/phase5-verification`. Cut-over commits `b4ad539..ad07280` (Phase 5.2) and `a51628d..24620c0` (Phase 5.1). Closes the verification gap that prior phases (1–4) left open: a single end-to-end run through the new stack lives in code now, and an operator can re-run a smoke check on any deployed box. No app/runtime code changes — only test + script files.

### Added

- `tests/integration/windows-server-stack.test.ts` (gated by `INTEGRATION_TEST=1`) — end-to-end suite that exercises the post-rewrite stack: API boot + `/api/health`, MQTT publish 100 messages via in-process aedes broker → assert TimescaleDB rows in `ts_telemetry`, graphile-worker enqueue → handler fires within 15 s, PDF render → `%PDF-` magic bytes (commits `a51628d`, review-fix `24620c0`).
- `scripts/verify-windows-deployment.ps1` — operator-facing smoke-check (4 sequential checks: `/api/health`, Mosquitto :1883, graphile-worker schema via psql, real PDF render via login → reports/generate). PS 5.1 + 7+ compatible. Comment-based help + `-Help` flag (commits `b4ad539`, review-fix `ad07280`).
- `tests/integration/vitest.config.ts` + `tests/integration/vitest.global-setup.ts` — separate vitest project so the integration suite skips cleanly when the gate is off.
- `vitest.workspace.ts` — registered the new integration project.

### Verified live

- Gate-off `npx vitest run` → 4 skipped, no regressions in the existing 1279-test suite.
- `verify-windows-deployment.ps1 -Help` → comment-based help renders.
- PowerShell parse-test passes for both new scripts on PS 5.1 and 7+.
- Live `INTEGRATION_TEST=1` + live deployment runs deferred — they require the full stack (Postgres + TimescaleDB + Mosquitto + Edge + admin password), which a fresh worktree doesn't have.

---

## [Unreleased] — Phase 5 doc-sync sweep (active set + future/) (2026-04-29)

Branch: `feature/phase5-verification`. Single docs commit on top of `24620c0`. Closes the four files Phase 4 explicitly deferred plus the 12 stale references the audit found across the rest of the active doc set + `future/` + `docs/` + `PROJECT_HANDOVER/`. No code changes.

### Phase 4 deferred files — now updated

- `PROJECT_ARCHITECTURE.md` — system-architecture diagram redrawn (Fastify-direct on `:3000`; reverse proxy is optional/customer-choice; queue moved to graphile-worker on Postgres; broker is Mosquitto 2.0). Request-flow, data-ingestion-pipeline, queue-architecture table, security-layers, and protocols table all updated. `63 models` → `64 models`. Redis usage scoped to "pub/sub only" with Phase 4 follow-up note.
- `API_REFERENCE.md` — base URL prose drops "via Nginx"; "Internal Endpoints (EMQX callbacks)" section rewritten as "Internal Endpoints (Mosquitto dynamic-security)" pointing at `POST /api/internal/mqtt/refresh-acl`; "Permission Reference (95 total)" updated to live count of 109 with verification command.
- `FRONTEND_GUIDE.md` — "served by Nginx in production" rewritten to "served by Fastify on `:3000`; reverse proxy optional"; reauth count `69` → `81`.
- `OFFLINE_SYNC_ARCHITECTURE.md` — APK/web connection diagram drops Nginx, route-modules count `34` → `37`, `63 models` → `64`, `EMQX — MQTT broker` → `Mosquitto 2.0 — MQTT broker`, `Redis/Memurai — BullMQ job queues` → `graphile-worker on Postgres — job queues; Redis (optional) — non-queue pub/sub only`.

### Other active-doc-set fixes (12 files)

- `AGENTS.md` — module count `34` → `37`, `57 Prisma models, 17 enums` → `64 / 22`, `52+ permissions` → `109/91/81/26` (with the four explicit shared-types receipts), and "BullMQ jobs" → "graphile-worker jobs".
- `PROJECT_SUMMARY.md` — monorepo tree block updated (`packages/queue` → graphile-worker; rfid_scan_app description; `deploy/` line removed; `scripts/` description updated). `BullMQ job queues 5` → graphile-worker `5` cron + tasks. "95 granular controls" → `109` with verification cmd. "Production Deployment (Windows Server)" rewritten honestly (Fastify-direct, optional reverse proxy, NSSM stopgap, Phase 5 launcher pending).
- `README.md` — `packages/queue/` line in the contents table swapped to graphile-worker prose.
- `apps/api/CLAUDE.md` — module count `34` → `37` (both inline mentions); module list refreshed to include `report-templates`/`reports` and `30` defs (was `23`); "Phase 4 Update" disambiguated from windows-friendly-rewrite Phase 4; `95 total permission constants` → live count of `109`.
- `apps/api/DECISIONS.md` — Decision #26 (BullMQ for Ingestion Queue) updated to record the Phase 2 swap to graphile-worker on Postgres while preserving the original queueing rationale; Decision #39 (Force IPv4 SMTP) flagged as historical-EC2-era and noted as a safe defensive default in the current Windows-local-only deployment.
- `apps/web/CLAUDE.md` — `# Build (for Nginx serving or APK packaging)` comment swapped for the Fastify-static-serve reality; `20+ page modules` → `23 route folders/files; ~85 pages; 81 <Route>`.
- `windowsIssues.md` — added "Phase 5 status footnote" pointing at `tests/integration/windows-server-stack.test.ts` + `scripts/verify-windows-deployment.ps1` (the verification gap Phase 5 closes); "Things that work fine" list updated (BullMQ → graphile-worker; Memurai marked optional).

### Reference docs (`docs/`, `future/`, `PROJECT_HANDOVER/`)

- `docs/getting-started/system-requirements.md` — full rewrite of "Server (Production — EC2)" + dependency tables to reflect Windows-local-only post-Phase-1-through-4 stack; legacy port table marked as "no longer part of standard install".
- `docs/getting-started/what-is-digilog.md` — architecture stack list updated (37 modules, 64 models, Mosquitto, graphile-worker, puppeteer-core+Edge+napi-rs/canvas, 30 config defs).
- `docs/compliance/21-cfr-part-11.md` — "HTTPS support via Nginx" → Fastify TLS via mkcert, reverse proxy optional.
- `docs/user-guide/connectivity/mqtt.md` — full rewrite: Mosquitto 2.0 instead of EMQX, dynamic-security via `POST /api/internal/mqtt/refresh-acl`, no web dashboard, hard-coded EC2 IP removed.
- `docs/user-guide/telemetry/telemetry.md` — `via EMQX broker` → `via Mosquitto 2.0 broker`.
- `docs/user-guide/data-export/data-export.md` — `via BullMQ` → `via graphile-worker on Postgres`.
- `docs/user-guide/entities/entities-and-hierarchy.md` — `57 Prisma models with 17 enums` → `64 / 22`.
- `docs/deployment-methods/{README,method-a,method-b,method-d,method-e,comparison}.md` — added Phase 4/5 status banners pointing at root `DEPLOY-WINDOWS.md`; the original evaluation prose is preserved for historical context.
- `future/overview/CODEBASE_SUMMARY.md` — `BullMQ queue definitions` line → graphile-worker prose.
- `future/overview/API_LIST.md` — EMQX webhook footer note rewritten for Mosquitto refresh-acl + legacy-EMQX conditional.
- `future/backend/README.md` — Tech stack line, transport block, env-var table, workers note all rewritten for the post-Phase-1-through-3 stack.
- `future/backend/API_ENDPOINTS.md` — MQTT-topics note updated for Mosquitto 2.0 + refresh-acl.
- `future/backend/ENV_SETUP.md` — prereqs list, Memurai section, Nginx mention all rewritten.
- `future/frontend/README.md` — `served by optional Nginx` rewritten to Fastify-direct + Capacitor APK.
- `future/qa/README.md` — local prod URL no longer points at Nginx; EMQX dashboard reference removed.
- `future/qa/FEATURE_CHECKLIST.md` — EMQX auth/ACL webhook check rewritten as Mosquitto refresh-acl.
- `future/qa/ACCEPTANCE_CRITERIA.md` — `/api/system-health` expected outputs adjusted (Mosquitto, optional Redis).
- `PROJECT_HANDOVER/APPLICATION_FLOW.md` — header banner added pointing at the post-Phase-4 stack; existing Mermaid diagrams + .docx renders preserved as a historical Phase-4 snapshot.

### tasks/todo.md

- New audit entry `2026-04-29 — windows-friendly-rewrite Phase 5 — FULL doc-sync sweep` documenting the deferred-files closure, the additional active-doc-set fixes, the live-count verification commands run, and the files NOT touched (and why).

### Verification commands run before doc updates

```bash
git log --oneline 24620c0..HEAD                                                  # baseline
grep -cE "^model "                       apps/api/prisma/schema.prisma           # 64
grep -cE "^enum "                        apps/api/prisma/schema.prisma           # 22
grep -cE "^\s+[A-Z_]+:\s*'"              packages/shared/src/types/permissions.ts  # 109
grep -cE "^\s+[A-Z_]+:"                  packages/shared/src/types/reauth-actions.ts # 81
ls apps/api/src/modules/ | wc -l                                                  # 37
ls apps/api/src/modules/config/defs/*.def.ts | wc -l                              # 30
ls apps/web/src/routes/config/*.tsx | wc -l                                       # 26
grep -cE "<Route" apps/web/src/main.tsx                                           # 81
grep -rln -i "emqx\|memurai\|bullmq\|nginx\|pm2" --include="*.md" .                # found ~30 matches; sweep complete
```

### Out of scope for Phase 5 doc sync

- The Mermaid `.png` renders in `PROJECT_HANDOVER/diagrams/` were **not regenerated** — they're paired with the Phase 4 .docx and should land together when the handover doc is regenerated for a Phase 5+ release.
- `docs/runbooks/queue-cutover.md` and `docs/plans/2026-04-29-windows-friendly-rewrite.md` were intentionally **not edited** — the runbook is the cutover playbook itself (describes the BullMQ → graphile-worker migration and is correct in that role) and the plan is the source-of-truth for the rewrite phases.
- `apps/web/DECISIONS.md` line 13 mentions "(nginx) would handle this" in the dev-Vite-proxy rationale — left as historical context since it correctly describes the original design intent and is a small inline parenthetical, not a load-bearing claim.

### Verified live

No code changes. The doc set was sweep-grepped before and after the edit pass; remaining `EMQX|BullMQ|Memurai|Nginx|PM2` matches are now either explicit historical references (Phase X swaps), part of the historical `docs/runbooks/queue-cutover.md` cutover playbook, or part of `docs/plans/2026-04-29-windows-friendly-rewrite.md` (the plan describing the rewrite itself).

---

## [Unreleased] — Phase 4 of windows-friendly-rewrite — Tooling cleanup (Install + Packaging) (2026-04-29)

Branch: `feature/phase4-tooling`. Cut-over commits `127f25d..60d3c90`. No code changes — only the two installer/packager scripts and the `.env.example` template were touched, so behavior of the running app is unchanged. The point of the phase was to make `scripts/install-on-target.ps1` and `scripts/package-for-production.ps1` honest about the post-Phase-1+2+3 stack (Mosquitto, graphile-worker, puppeteer-core+Edge, @napi-rs/canvas) and stop pretending the customer needed Memurai / EMQX / PM2 / a baked-in Nginx config.

### Changed
- `scripts/install-on-target.ps1` (`127f25d`): dropped the Memurai/Redis prereq probe, dropped the EMQX firewall rule + 18083 dashboard port, dropped the PM2 install/start/save blocks, dropped the inline Nginx-config drop. Added: invocation of `scripts/install-mosquitto.ps1` (so the installer is the single entry point — no separate broker step), `LongPathsEnabled = 1` registry edit (try/catch — warns if not admin), Microsoft Edge presence probe (warns and points at `PUPPETEER_EXECUTABLE_PATH` override if Edge is missing). Firewall rule for port 1883 renamed `DigiLog Mosquitto MQTT`.
- `scripts/install-on-target.ps1` (`5dd0eab`, review-fix): footer rewritten to honest "smoke-test only" wording — `cd api; node dist/app.js` runs the API in the foreground with no restart-on-crash, no boot persistence, no log rotation, and notes the managed-Windows-service launcher is tracked as Phase 5 work. Also removed a bogus `$LASTEXITCODE` check that was always passing on the fail path, and dropped a `2>&1` redirection from the `prisma db seed` invocation that was wrapping native stderr in NativeCommandError records and tripping `$ErrorActionPreference = 'Stop'`.
- `scripts/package-for-production.ps1` (`bcfd621`): dropped copies of the now-broken `start-digilog.ps1` / `stop-digilog.ps1` shells (they referenced PM2 + EMQX). Now requires `install-on-target.ps1` and `install-mosquitto.ps1` and throws on either missing. Copies the repo's `mosquitto/` config directory into the output zip alongside `scripts/`. Replaced the inline `.env.example` template's MQTT(EMQX) and Redis blocks with a single Mosquitto block, a graphile-worker note clarifying that the queue runs on Postgres so no Redis is required (with a hint on where `REDIS_HOST`/`REDIS_PORT`/`REDIS_PASSWORD` would go if pub/sub Redis is added later), and a commented `PUPPETEER_EXECUTABLE_PATH` override.
- `scripts/package-for-production.ps1` (`60d3c90`, review-fix): added an explicit-scope comment at the top of the inline `.env.example` writer that names it as a partial mirror of `apps/api/.env.example` (so anyone editing one knows the other exists). Fixed a pre-existing `Write-Host -f` bug where the parameter alias was being interpreted as a positional arg. Normalized the Mosquitto admin-password / refresh-token placeholder strings to SHOUTY_SNAKE so they grep cleanly.
- `apps/api/.env.example` (`60d3c90`): `MOSQUITTO_ADMIN_PASSWORD` + `MOSQUITTO_REFRESH_TOKEN` placeholder strings normalized to SHOUTY_SNAKE so the file matches the packager output.

### Resolved windowsIssues entries
None new. §1 Puppeteer / §2 chartjs-node-canvas / §3 EMQX / §7 Memurai were resolved in Phase 1+2+3. Phase 4 retires PM2 and the bundled Nginx config from the customer-facing install path (covered by §14 "Optional Nginx reverse proxy on Windows" — the recommended stance is now "skip the proxy entirely; Fastify on :3000 direct").

### Out of scope for Phase 4 (deferred to Phase 5)
- A managed Windows-service launcher (`verify-windows-deployment.ps1` + NSSM/sc.exe service registration) so the API survives reboots and crashes.
- End-to-end Windows-Server integration test that exercises the full `install-on-target.ps1` → smoke-test → tablet-login path on a fresh box.

### Deferred to Phase 5 doc sync
The follow-up review found stale Nginx / EMQX / Memurai references in four architecture-diagram-heavy docs that weren't touched in this pass to keep blast radius small. These will be swept by the Phase 5 doc-sync commit once the managed-service launcher actually ships and the prose can describe the real shape of the install:

- `PROJECT_ARCHITECTURE.md` — system-architecture diagram still shows Nginx + Memurai boxes
- `API_REFERENCE.md` — header prose still mentions Memurai/EMQX as required services
- `FRONTEND_GUIDE.md` — deployment context still references Nginx as reverse proxy
- `OFFLINE_SYNC_ARCHITECTURE.md` — prose still references the EMQX broker by name

The two operationally-load-bearing prose files — `BACKEND_GUIDE.md` (the documented launch command) and `PHASE_5_RECENT_WORK.md` § "Production deployment artifacts" (description of `install-on-target.ps1`) — were fixed in this commit because they describe what the install scripts actually do, not just the architecture they live in.

### Verified live
No code changes, so no test runs. The two scripts were sanity-read and the `.env.example` placeholder normalization was verified by grep — but the only end-to-end proof will be the Phase 5 fresh-box install test.

---

## [Unreleased] — Phase 3 of windows-friendly-rewrite + test cleanup (2026-04-29)

Branch: `feature/phase3-reports-edge`. Cut-over commits `0ecc151..b2c3b37` on `windows_dep`.

### Added
- `apps/api/src/modules/reports/renderers/edge-detector.ts` — resolves the browser executable for puppeteer-core. Honours `PUPPETEER_EXECUTABLE_PATH`, then probes Edge → Chrome on Windows, Chromium → Chrome on Linux, `.app` bundles on macOS. Throws with the full candidate list when nothing exists.
- `apps/api/vitest.setup.ts` — loads `apps/api/.env` so `PrismaClient` construction finds `DATABASE_URL` during tests, and seeds JWT-secret fallbacks if a service test imports `lib/jwt.ts` before `dotenv` runs.
- `apps/api/vitest.global-setup.ts` — idempotent test-fixture upserts: `admin`/`Admin@123` (SUPER_ADMIN), `RB0001`/`Test@1234` (OPERATOR), and the `VIEWER` system role. All upserts are safe to re-run on every test launch regardless of dev DB state.

### Changed
- `apps/api/src/modules/reports/renderers/pdf-renderer.ts`: switched from `puppeteer` (bundled ~150 MB Chromium) to `puppeteer-core` driving Microsoft Edge via `detectEdgePath()`. Eliminates the Chromium download, works on Windows Server Core, cold-start render time dropped from ~34 s to ~1.9 s in the smoke test.
- `apps/api/src/modules/reports/renderers/chart-renderer.ts`: replaced `chartjs-node-canvas` (transitive `canvas` package needs Cairo + node-gyp + MSVC + Python) with `@napi-rs/canvas` (prebuilt N-API binaries for Win/macOS/Linux x64+arm64). `npm ci` on a clean Windows Server box no longer needs Visual Studio Build Tools. Public `renderChart` signature is unchanged.
- `apps/api/src/modules/config/routes.ts`: hardcoded reauth fallback now also accepts the `x-reauth-password` header. Previously it only checked `body._currentPassword`, which broke `PUT /api/config/datetime` (and any future config tab not in the dynamic action-reauth registry) for callers using the header.
- `mosquitto/mosquitto.windows.conf`: documented (with comments) that `log_dest stdout` is incompatible with Windows service mode. The source conf still uses stdout for dev foreground; `scripts/install-mosquitto.ps1` rewrites the deployed copy.
- `scripts/install-mosquitto.ps1`: rewrites three lines in the deployed `mosquitto.conf` because the SCM-managed broker has `CWD = System32` and no stdout — `persistence_location ./data/` → absolute install-dir path; `plugin_opt_config_file ./dynamic-security.json` → absolute path; `log_dest stdout` → `log_dest file <InstallDir>/mosquitto.log`. Without these rewrites the service silently exited on every launch.
- `packages/shared/src/schemas/users.ts`: `userQuerySchema.limit` re-acquired `.max(100).default(20)`. Earlier impl drift had removed both, leaving public list endpoints unbounded — a DoS surface.
- `packages/shared/src/schemas/assets.ts`: `assetQuerySchema.limit` and `templateQuerySchema.limit` re-acquired `.max(100).default(50)` for the same reason.
- `apps/api/vitest.config.ts`: `fileParallelism: false`. e2e tests share the `admin` user / session row; running files in parallel had them stomping each other's sessions and producing 401 cascades. Until each suite owns its own login identity, run files serially.

### Removed
- `apps/api/package.json`: `puppeteer` (replaced by `puppeteer-core`); `chartjs-node-canvas` (replaced by `@napi-rs/canvas` + `chartjs-adapter-date-fns`).

### Fixed (test suite)
Brought `apps/api` Vitest sweep from `30 failed files / 65 failed tests` to `0 failed`. Discipline: every test was matched to the **actual** implementation behaviour (or fixed a real impl regression where the impl was wrong, like the unbounded query `limit`). No `.skip()`, no test deletions for convenience, no mock fakery to hide behaviour. Highlights:
- `connectivity-tracker.test.ts`: added `findUnique` to the prisma mock and stubbed `notification-dispatcher` (markOnline/markOffline read prior status before upserting and dispatch notifications now).
- `instance.service.test.ts`: `$transaction`-aware mock that aliases `tx` to the same recording surface, since the service moved create/delete inline into `prisma.$transaction`.
- `default-chain-builder.test.ts`: builder now emits `clear-alarm` nodes; counts went 4 nodes/4 conns → 5/6 (1 rule) and 8/11 (2 rules); filter config field renamed `scriptBody → script`.
- `node-registry.test.ts`: pinned exact category counts (FILTER=12, ENRICHMENT=11, TRANSFORM=12, ACTION=20, EXTERNAL=12, FLOW=5); rewrote the `tenant-attributes` test to assert the actual `sys_<key>` behaviour with a DB-failure fallback case.
- `backup.repository.test.ts`: rewrote for the dynamic-discovery shape (`getAllTables` + `fetchAllTablesRaw`); `fetchAllTablesPrisma` was deleted and `resetAuditSequence` is now a no-op for UUID PKs.
- `auth.plugin.test.ts`: added `createdAt` to session fixtures (auth.ts checks absolute-session timeout via `createdAt`); mocked `systemConfig.findFirst`, `role.findFirst`, `organization.findUnique`.
- `e2e/audit.test.ts`: `auditTrail.id` is a UUID; use a syntactically-valid UUID for the 404 cases and bulk-delete payload (numeric strings make Prisma throw a parse error → 500).
- `e2e/connectivity.test.ts`: server now returns `python/nodejs/curl/c` snippets — the legacy `arduino` snippet was retired.
- `e2e/checklist-submission.test.ts`: globalSetup upserts `RB0001` so the OPERATOR-RBAC paths can run.
- `e2e/roles.test.ts`: globalSetup upserts the `VIEWER` system role (older dev DBs were seeded before VIEWER was added).
- `lib/user-id-validator.test.ts`: dropped the broken `@digilog/shared` schema mock that short-circuited `safeParse()` and dropped zod defaults; replaced `letterCase: 'ANY'` with `'MIXED'` (validator behaviour identical, schema only accepts UPPERCASE/LOWERCASE/MIXED).
- `paginationConfigSchema test`: schema went from `.length(3)` to `.min(2).max(10)`; rewrite the test to document the relaxed bounds.
- `AUDIT_TEMPLATE_CATEGORIES test`: list grew from 7 to 12 (Filter Operations, Cleaning Profiles, Filter Profiles, Equipment Groups, PM Schedules added in Phase 2).

### Verified live
- Booted apps/api in the Phase 3 worktree, activated the existing Filter Report template, `POST /api/reports/generate` → HTTP 201 with a 59,085-byte `e7432d7f-…pdf` on disk (`%PDF-1.4` header, `%%EOF` trailer). `GET /api/reports/:id/pdf` served the same bytes with `Content-Type: application/pdf`. Charts rendered via `@napi-rs/canvas`, document via puppeteer-core + Edge.
- Full sweep across all packages: **`apps/api` 83/83 files / 1123/1123 tests + `packages/shared` 5/5 / 150/150 + `packages/queue` 3/3 / 6/6 = 91 files / 1279 tests, all green.**

### Resolved windowsIssues entries
- §1 Puppeteer → resolved by `abdc9dd` + `79937b7`
- §2 chartjs-node-canvas → resolved by `d72d44c`
- §3 EMQX → resolved by Phase 1 + `0ecc151` install-script fix
- §7 Memurai → resolved by Phase 2 (`7832af1`)

---

## [Unreleased] — Phase 1 of windows-friendly-rewrite (2026-04-29)

Branch: `feature/phase1-mosquitto-rewrite`. Cut-over commits `510f903..7d33dbf`.

### Added
- Feature-flag mechanism (`apps/api/src/lib/feature-flags.ts`): `USE_MOSQUITTO`, `USE_PG_QUEUE`, `USE_EDGE_PDF`. Case-insensitive, whitespace-tolerant. Phase 1–3 of the windows-friendly-rewrite plan run behind these flags.
- Mosquitto Dynamic Security generator (`apps/api/src/transport/mosquitto-acl-generator.ts`): pure async function translating active `DeviceCredential` rows into Mosquitto v2 dynamic-security JSON. Mirrors the EMQX HTTP-webhook ACL taxonomy from `mqtt-auth-routes.ts` (5 publish + 8 subscribe ACLs per device, scoped to each device's UNS path; admin role uses `subscribePattern` for `#`). 12 unit tests including duplicate / empty-input rejection.
- `POST /api/internal/mqtt/refresh-acl` endpoint (`mosquitto-refresh-routes.ts`): regenerates `dynamic-security.json` from the DB on demand. Bearer-auth via `MOSQUITTO_REFRESH_TOKEN` (timing-safe compare). Atomic write via `<path>.tmp` + `rename`. Audit-trail entry written via `auditLog()` for every refresh. Conditionally registered in place of `mqtt-auth-routes` when `USE_MOSQUITTO=true`.
- `mosquitto/mosquitto.conf` — production config using the built-in dynamic-security plugin (Mosquitto 2.0+).
- `scripts/install-mosquitto.ps1` — idempotent silent Windows installer: caches the MSI, registers + starts the Windows service, copies repo config, grants NetworkService NTFS ACLs.
- `aedes` in `apps/api` devDeps + `mqtt-broker-integration.test.ts` — pure-JS in-process MQTT broker as a Mosquitto test double. 3 tests covering credential rejection, acceptance, and QoS 1 publish/subscribe round-trip.

### Changed
- `docker-compose.yml`: replaced the `emqx` service (EMQX 5 elixir) with `eclipse-mosquitto:2.0`. Dropped the 18083 dashboard port and all EMQX webhook env vars. Bind-mounts `mosquitto/mosquitto.conf` so Docker dev and bare-Windows installs share one config file.
- `apps/api/src/app.ts`: route registration at `/api/internal/mqtt` is now conditional — `mqtt-auth-routes` (legacy EMQX) when `USE_MOSQUITTO=false`, `mosquitto-refresh-routes` when `true`. Default off.

### Tests
- 163 passing across transport + lib (was 156 pre-Phase-1). 1 pre-existing failure in `src/lib/user-id-validator.test.ts:219` (unrelated to this work).

### Migration notes for cut-over (production)
1. Set `USE_MOSQUITTO=true` and `MOSQUITTO_REFRESH_TOKEN=<random>` and `MOSQUITTO_ADMIN_PASSWORD=<random-12+ chars>` in `.env`.
2. Run `powershell -ExecutionPolicy Bypass -File scripts/install-mosquitto.ps1` once on the Windows host.
3. Restart the API.
4. Bootstrap the ACL: `curl -X POST -H "Authorization: Bearer $MOSQUITTO_REFRESH_TOKEN" http://localhost:3000/api/internal/mqtt/refresh-acl`.
5. Restart Mosquitto so the dynsec plugin picks up the new file:
   - Windows: `Restart-Service mosquitto`
   - Docker:  `docker compose restart mosquitto`
   The plugin reads `dynamic-security.json` at broker startup; SIGUSR1 hot-reload is not implemented (and does not exist on Windows). A future phase will publish `$CONTROL/dynamic-security/v1` messages to apply changes live. Repeat this restart after every `/refresh-acl` call.
6. Verify Mosquitto loaded the file: check Windows Event Log for the `mosquitto` service.
7. Migrate devices to point at the Mosquitto host (DNS or config redirect).

### Out of scope for Phase 1
- Removing `mqtt-auth-routes.ts` — kept registered when flag is off; removed in Phase 4 after cut-over validated.
- BullMQ → graphile-worker migration (Phase 2).
- Puppeteer / canvas swaps (Phase 3).
- Android / APK build chain, CI runner choice — out of scope per `windowsIssues.md` § 10–§11, § 18.

---

## [2.5.0] — 2026-04-25 — Offline Hardening, RFID SDK, Filter Data Console

### Added
- **Offline overhaul foundation** — TTL-based cache invalidation, idempotency keys on every queued op, tombstones for deleted entities, LRU eviction, JWT refresh during replay (queued ops carry refreshed tokens) — commits `3c99973`, `0c8de53`, `b8e003e`
- **Server-side stage lookup walker** — `stageLookup` resolves stage chains across multiple consecutive CHECKLIST nodes (fixes wrong-stage / missing prompts)
- **Capacitor Network plugin + Service Worker hook** — reliable online detection on Android WebView (replaces unreliable `navigator.onLine`)
- **RFID SDK plugin in DigiLog APK** — `RfidPlugin.java` bundles `Reader_Usb.jar`, so KC-series readers work in SDK mode inside the main APK (commit `39ccd1c`)
- **Filter Data Management console** — 10 tabs each mirroring its corresponding user-facing page (cleaning cycles, filter events, alarms, PM entries, audit trail, notifications, admin requests, block changes), instead of raw DB rows
- **Edit modals** for cleaning-cycles and filter-events tabs in the Filter Data Mgmt console
- **Forgot-password flow + show/hide password + lockout-progress UI** on tablet/mobile login
- **Create-filter dialog** now renders the Filter entity template's `attributeSchema` fields dynamically
- **`?expand=questions`** query param honored on `GET /api/checklist-profiles` so offline cache contains questions

### Fixed
- Mobile RFID scan input losing focus after first scan
- RFID-burst capture in UKB mode missing first keystroke (seed buffer + raise burst threshold to 150 ms)
- `pm-schedule-approval` config def returning 404 (now registered in `config-discovery.ts`)
- Offline checklist prompts missing or showing wrong stage when two CHECKLIST nodes were chained
- Offline checklist cache empty because list endpoint silently dropped questions

### Changed
- Filter Data Mgmt console columns trimmed to those visible on the matching user-facing pages (no extra DB-only fields)

---

## [2.4.0] — 2026-04-21 — Reports, Reorg, Dynamic Backup, Bloat Audit

### Added
- **Reports module — phases A through F complete**: report template designer (visual editor), report generation engine (Puppeteer + chartjs-node-canvas + Handlebars), digital signatures, PDF storage, frontend pages, schema, variable resolver with 5 data sources (attribute / identifier / telemetry / timestamp / meta)
- **Dynamic backup/restore** — covers all 64 tables via `pg_tables` + `jsonb_populate_recordset`; non-superuser-compatible; two-pass fixup for self-referencing rows
- **Admin requests approval execution flow** — approvals now actually create/unlock/reset/modify users; requester Employee ID required; audit trail hides UUIDs
- **DRY_IN two-step flow** — separate SET_DURATION and SUBMIT_READINGS events; "Currently Drying" panel with countdown + temperature (web + tablet + offline)
- **Batch scan mode** in mobile operations
- **Stage cards** on tablet home page
- **Pipeline enforcement on offline path** — replay re-walks the pipeline to enforce checklist-as-stage rules
- **Block deletion**, RBAC fixes (roles drift after DB restore)
- **Entity org auto-assign** for admin-created entities
- **Reorg**: `old/` archive for superseded material, `future/` for forward-looking design notes

### Fixed
- Cycle `profile_id` frozen at start (reassigning a block's profile no longer corrupts in-progress cycles)
- DRY_IN temperature not showing in cleaning cycle history (now read from readings event)
- Offline DRY_IN sync skipping half-time check on replay
- Lenient offline cycle detection + preserve graph data in online cache
- Backend pipeline bypass at DRY_IN for both SET_DURATION and SUBMIT_READINGS
- Lifecycle state cleared on offline cycle completion so next cycle starts fresh
- Sync health check tolerant of self-signed certs (avoids false cycle-completion signals)

### Changed
- **Removed all EC2 / Linux production assets** — app runs on local Windows only (commit `251be95`); CLAUDE.md / per-app CLAUDE.md de-EC2'd
- **`apps/api/src/modules/config/routes.ts`** monolith split into per-tab files registered via auto-discovery (was 1003 lines / 40 endpoints)
- **Inline-style → theme-class codemod** across 54 TSX files (~200 occurrences eliminated)
- **Bloat audit** (`bloat.md`, archived) — 12 / 14 items resolved (SPIS submit-path parity, monster-file split, dependency drift cleanup, lint rule for `as any`, timer audit)
- **`packages/shared`** rebuild required after permissions / privileges / reauth changes

---

## [2.3.0] — 2026-04-14 — Permissions, Themes & Reports

### Added
- Granular role-based permissions: 18 new feature toggles across Filters Page Controls, Checklist Page Controls, Cleaning Profile Page Controls, Equipment Group Controls, PM Page Controls
- 10 configurable color themes: Ocean, Sapphire, Emerald, Amethyst, Sunset, Slate, Ruby, Forest, Midnight, Coral
- Report Settings configuration page with header/footer/layout controls and live preview
- ReportPageWrapper component applied to Audit Trail, Cleaning Cycles, Filter Traceability
- Dynamic bulk upload CSV template generated from Filter entity template attributeSchema
- PM Schedules page redesign: date range filter, summary cards, AHU inline with expandable filters, S.No, pagination
- AHU Type column on filters table
- Public endpoints: /api/config/password-policy/current, /api/config/report-settings/current
- Block change test data (PENDING, APPROVED, REJECTED, EXPIRED)

### Fixed
- SUPER_ADMIN now bypasses all frontend permission checks (was hidden from new features)
- Backup export 403 for non-superadmin (removed hardcoded role check)
- Backup restore failing for SQL/CSV formats (password_hash was stripped)
- Block change requests not visible to approvers (endpoint required wrong permission)
- "Load Error" toast on every page for non-admins (password-policy 403)
- api-client.ts missing .status on thrown errors (SWR couldn't suppress 403 toasts)
- Reauth popup password autofilling from browser saved credentials
- Reauth popup focus jumping to search bar on cancel/confirm
- Reauth popup not opening for checklist and cleaning profile actions
- Filter status update 403 (permission mapping missing backend permission)

### Changed
- Feature privilege mappings now include both frontend visibility and backend route permissions
- Reauth actions: 69 total across 16 categories (removed 8 dead, added 6 missing)
- Org-admin routes changed from requireRole to requirePermission
- PM Schedules: removed Month column, added AHU/S.No/Approved By columns
- Filters Page Controls permissions are separate from Entity Management permissions

## [2.2.0] — 2026-04-07

### Added — RFID & Offline Sync
- **RFID Scanner Android app** (`rfid_scan_app/`) — KC-series UHF reader via USB-C with 5 screens (Connect, Scan, Read/Write, Settings, UKB)
- **RFID input guard** (`use-rfid-guard.ts`) — global keydown interceptor blocks rapid RFID keyboard input from entering non-RFID fields
- **RFID scan dialogs** — 300ms debounce tag detection, deduplication for repeated scans, Continue/Remove flow
- **Filter details on scan** — after RFID tag detected, looks up and displays filter name + parent AHU
- **Offline cleaning operations** — all stage operations (advance, start-cycle, submit-checklist, equipment) wrapped with `executeOrQueue()` for offline queuing
- **Offline identifier lookup** — identifiers cached to IndexedDB `identifier-map` for RFID lookup without internet
- **"Data Synced" indicator** — mobile header badge shows when all data (instances, templates, reasons, identifiers) is cached and safe to go offline
- **Error popup component** (`components/ui/error-popup.tsx`) — reusable modal for error display, replaces inline banners in entities and filter operations
- **Responsive layout** — sidebar collapses to hamburger menu on mobile/tablet with slide-in overlay

### Changed
- **One identifier per entity** — backend now blocks creating more than one identifier per asset instance
- **Contact Admin roles** — `/api/roles/active` is now public (no auth) so the contact-admin page can populate the role dropdown
- **User creation** — admin users auto-assign new users to their own organization (org dropdown hidden)
- **Filter operations list** — shows all Filter template instances (fixes BY_BLOCK config-based profile assignment)
- **APK HTTP mode** — Capacitor WebView cannot trust self-signed certs for fetch; dev uses HTTP, production will use system cert install

### Fixed
- RFID reader in UKB mode typing tag IDs into random input fields
- Repeated tag scans filling inputs with duplicated EPC values
- Filter not found errors when scanning offline (identifiers now cached separately)
- Cleaning operations failing silently offline (start-cycle, checklist, equipment now queue properly)
- Background error messages not visible to user (now shown as popup dialogs)
- Fixed width sidebar breaking mobile layout

## [2.1.0] — 2026-04-04

### Added — Phase 2 Enhancements
- **Equipment Groups** — Group instruments and filters under AHUs with CRUD endpoints
- **Checklist Profiles** — Standalone checklist profile management with typed questions (YES_NO, PASS_FAIL, NUMERIC, DROPDOWN, MULTI_SELECT, TEXT)
- **Bulk Upload** — CSV-based bulk filter import functionality
- **Filter Retirement & Replacement** — End-of-life management for filters
- **Filter Scan** — QR/barcode scanning for filter identification
- **Mobile PWA** — Progressive Web App support for tablet/mobile filter operations
- **Android APK** — Capacitor-based Android build (JDK 21, apps/android/)
- **Notification Channels** — Telegram and Slack delivery channels added
- **Dashboard Widgets** — Configurable dashboard with widget assignments

### Updated
- Prisma schema expanded to **57 models** with **17 enums**
- API modules expanded to **34 total**
- Frontend routes expanded with equipment management, bulk upload, retirement pages
- All documentation files updated to reflect current application state

## [2.0.0] — 2026-03-27

### Added — Phase 2: Digital Filter Management System
- **Filter Operations page** — 8 cleaning stages (TO_BE_CLEANED through READY_FOR_USE) with block selection, QR scan
- **Cleaning Profile Editor** — Visual pipeline builder with STAGE, CHECKLIST, START, END nodes and wire connections
- **Checklist Profiles** — CRUD for checklist templates with 10 question types (YES_NO, PASS_FAIL, NUMERIC, DROPDOWN, etc.)
- **Filter Profiles** — Assign cleaning profiles to filters, block restrictions, max cycle limits
- **Cleaning Cycles** — Full lifecycle tracking with expandable history, stage timeline, filter names, performer names
- **PM Scheduling** — Per-AHU preventive maintenance schedules with monthly entries and tolerance windows
- **AHU Dashboard** — Filter set visualization with state-colored indicators
- **Filter Traceability** — Per-filter event history, cycle list, deviation tracking
- **Checklist gates in pipeline** — CHECKLIST nodes between stages auto-trigger question dialogs; server-side enforcement
- **Cleaning reason selection** — User selects from 8 configurable reasons when starting a cycle
- **Config pages** — Filter Lifecycle States and Filter Cleaning Reasons management
- **9 new database tables** — pm_schedules, pm_schedule_entries, pm_executions, filter_cleaning_profiles, filter_pipeline_stages, filter_pipeline_connections, filter_profiles, cleaning_cycles, filter_events
- **9 new enums** — CleaningCycleStatus, FilterEventType, PipelineNodeType, FlowMode, BlockRestriction, etc.
- **17 new permissions** across 6 roles
- **3 config definitions** — filter-cleaning-reasons, filter_lifecycle_states, filter-pm-schedule

### Fixed — Quality Audit (30 issues resolved)
- **CRITICAL:** Path traversal in binary file endpoints + missing auth
- **CRITICAL:** Auth double-throw for expired accounts
- **CRITICAL:** Config pages returning 404 (missing config definitions)
- **HIGH:** Organization scoping added to all filter-operations methods
- **HIGH:** Server-side checklist enforcement in advance() — prevents API bypass
- **HIGH:** bypass() now requires active cycle and validates target state
- **HIGH:** Permission guards on all 13 Phase 2 frontend routes
- **MEDIUM:** Race conditions in startCycle and submitChecklist (transactions + duplicate checks)
- **MEDIUM:** Cleaning profile update wrapped in transaction
- **MEDIUM:** Input sanitization (XSS) for remarks/justification fields
- **MEDIUM:** Pipeline validation (stateKeys, checklist profiles, graph connectivity)
- **MEDIUM:** getCycles performance (events opt-in via query param)
- **LOW:** 28 missing permissions added to ALL_PERMISSIONS
- **LOW:** Auth plugin role scope caching (30s TTL)
- **LOW:** ErrorBoundary dark theme, PM page navigation, node delete confirmation


## [Unreleased] — 2026-03-16

### Added
- Input sanitization (HTML stripping) on all user text fields to prevent XSS
- Data Retention config page with per-table retention settings (telemetry, attributes, events, traces, checklists)
- Help Articles: 28 articles with comprehensive documentation across 8 categories
- Login always redirects to home page (dashboard) instead of returnUrl

### Fixed
- Retention config page crash: backend now merges stored config with defaults
- Department field XSS vulnerability: cleaned existing DB data and added sanitization
- Cleaned up 27 test help articles from database

## [1.0.0] — 2026-03-12

### Added
- Config Registry System with 23 self-registering config definitions
- Field ID expansion to 39 fields across 7 modules
- Real-time auto-refresh across all pages via SWR polling and WebSocket
- Role-based access management page (replaced role privileges)
- Comprehensive manual test cases (25 test suites, 25 execution guides)

### Fixed
- SWR stale data across 23 files (revalidateOnMount + dedupingInterval: 0)
- Role change not persisting after logout (JWT refresh reads DB role)
- SQL/CSV restore fails with missing displayName (50+ column mappings)
- User ID validator prefix check only applies to PREFIX_* formats
- PM2 TSDB_DATABASE env var fixed from digilog_db to digilog_tsdb
- Email IPv4: added family: 4 to nodemailer for smtp.office365.com

## [0.9.0] — 2026-03-01

### Added
- Phase K: Testing & Documentation
- Phase J: Help Articles, UNS Browser, Alarm Dashboard
- Phase I: Checklist Mobile, QR Code Scanning
- Phase H: Connectivity, Device Credentials
- Phase G: Rule Chain Visual Editor (ReactFlow)
- Phase F: Telemetry Queries, Data Export
- Phase E: Unified Namespace (ISA-95)
- Phase D: Rule Chain Engine (77 node types)
- Phase C: Data Ingestion Pipeline (11 stages)
- Phase B: MQTT Transport (EMQX integration)
- Phase A: Infrastructure (PostgreSQL, TimescaleDB, Redis, PM2, Nginx)

### Core Features
- 21 CFR Part 11 compliant audit trail with hash-chain integrity
- Electronic signatures with re-authentication
- 6 hierarchical roles with 22+ permissions
- Entity template system with attribute schemas and alarm rules
- 12 relationship types with cycle detection
- Notification system (in-app, email, SMS)
- Backup and restore with SHA-256 integrity verification

---

## Phase 3 Update (2026-04-07)

**RFID & Offline Operations:**
- RFID Scanner Android app (`rfid_scan_app/`) for KC-series UHF readers
- RFID keyboard guard prevents UKB tag input leaking into random fields
- Offline cleaning operations via IndexedDB queue + sync engine
- Cached identifier→filter map for offline RFID lookup
- "Data Synced" indicator in mobile header
- One identifier per entity (backend-enforced)
- Responsive layout with collapsible sidebar
- Error popups replace inline banners
- User creation auto-assigns org for admins
- `/api/roles/active` public endpoint for contact-admin page

See `CHANGELOG.md` for full details.
