# DigiLog — Enterprise Audit, Consolidated Report (as of 2026-07-15)

**Supersedes** the two separate datasets that existed until now:
- `ENTERPRISE-AUDIT-REPORT.md` — 535 findings, hand-assembled 2026-07-13 (the synthesis agent died on a session limit)
- `SECURITY-PHASE-REPORT.md` — 53 findings, the re-run security phase, 2026-07-13

Both lived only in a **temp scratchpad** (`AppData/Local/Temp/claude/.../d4e93b4a-.../scratchpad/audit/`),
which is not durable. This file is the versioned successor. The raw datasets
(`findings-dataset.json`, `security-findings.json`) remain there; copy them out if
they still matter.

Per-finding evidence and the decision record: `ENTERPRISE-AUDIT-HIGHS-TRIAGE-2026-07-15.md`.

---

## 1. Where it stands

| Severity | Found | Verified | Fixed | Open |
|---|---|---|---|---|
| **Critical** | 3 | 3 | **3** | 0 |
| **High** | 38 | 38 | **35** | 0 (3 vetoed as authorized design) |
| **Medium (high-signal)** | 62 | 62 | **54** | 0 (2 already fixed, 3 by-design, 3 refuted) |
| **Medium (low-signal)** | 91 | **91** | 17 | **41 CONFIRMED-LIVE + 17 latent — now verified, NOT fixed** |
| **Low** | 248 | 248 | **5** | 0 (1 was a false alarm; ~242 correctly Low) |
| **Info** | 89 | 0 | — | not triaged (informational) |
| **Dependencies** | 17 prod advisories | 17 | **13** | 4 (unreachable, no in-range fix) |

Suites: **apps/api 1159 / 0 / 12** (112 files) · **apps/web 530 / 0** (41 files) · shared 332.
~120 tests added, many mutation-verified. (Counts as of `ba41cb5`, measured
serially — concurrent agents sharing `digilog_test_db` make any parallel run
unreliable; every mid-session number in this doc's history was noise.)

**Everything actionable at Critical / High / high-signal-Medium is closed**, plus the
5 Lows that mattered.

**The verification gap is now CLOSED — and it was not the good news the label
promised.** All 74 were verified 2026-07-15 (`tasks/ENTERPRISE-AUDIT-MEDIUMS-VERDICTS-2026-07-15.md`,
full evidence per finding): **41 CONFIRMED-LIVE**, 17 latent, 7 already fixed, 9
refuted. **"Low-signal" was a bad label** — the refute rate was ~17%, and `M69`,
`M37` and `M44` all rate *above* their filing. These are verified, **not fixed**;
41 live findings are the current backlog.

> Finding IDs are `M01`–`M90`, from the `batch_*.txt` briefs — **session
> scratchpad, never durable.** They survived only by luck; the verdicts doc is now
> the durable record. Do not re-derive IDs from a session summary: the `#NNN`
> numbering used in some is **wrong** (what one called "#37/#31" is `M84`).

### Later rounds — what the tail actually contained

| Finding | Filed as | Reality |
|---|---|---|
| **Crontab scheduled 3 DELETED tasks** (`dlq_check`/`connectivity_check` every minute) | Medium | **51,806 orphan jobs, 16 MB, since 2026-05-10.** Cleared; leak stopped; drift guard added. `app.ts` already documented this exact failure for `notification` — fixed at the producer, crontab never checked. |
| **Bulk retire/replace/status hit HIDDEN filters** | Medium | Select-all under search A, retype B, confirm → invisible filters retired. Wider than filed (block + diagram + search; bulk-status too). |
| **Naive datetimes** (M75/M60/M61/M77) | 4 Mediums | **One bug class.** M75 overstated (only fires if the field is touched) but found 6 save paths not 4; **M60 understated** — not "18.5h dropped" but a ZERO-WIDTH window: a single-day report returned 0 records for a day holding 15. |
| **`uploadRole` never enforced** | Low | **LIVE** — SoD step 1 decorative while 2 and 3 were enforced; MANAGER/QA/OPERATOR could upload against a SUPERVISOR-only config. |
| **Audit Details required DESTROY rights** | Medium | Privilege inversion; an inspector who may READ couldn't open a row. Backend was innocent — frontend prop overload. |
| **Operators "fabricating" instrument readings** | *"arguably High — the one a regulator would care about"* | **FALSE ALARM.** Fixed 3-slot instrument template; DRY_IN is always exactly 1. The branch is unreachable and the scenario cannot exist. |

Verification reversed or corrected the reported severity in **both directions**,
repeatedly. Three of four briefs in one batch were wrong about the *cause* while
right about the symptom (M49's rationale false, M67 named the wrong file, M71
blamed the backend).

---

## 2. The finding that outlives the findings

**Both Medium verifiers, working independently, reached the same conclusion: the
2026-07-13..07-15 fixes hit the *symptom* and left the *sibling surfaces*.**

| Fixed | Sibling left broken |
|---|---|
| Backup **restore** (triggers, sequences, password hashes) | its CSV parser, truncation check, truncate-coverage, export snapshot isolation |
| Audit-payload masking (`lib/mask-secrets.ts`) | `GET /sms` still returned the same secrets unmasked |
| `assertCanManageTarget` on all user **mutations** | `getById` — a USER_READ holder could still read a SUPER_ADMIN |
| audit `targetId` overflow on bulk ops | the delete **lookups** stayed unscoped by role |

`feedback_audit_pattern_across_codebase` already says *fix the pattern, not the symptom*.
It wasn't applied, and that is precisely why round 3 found 54 more. **When a finding names
one call site, grep for the shape before declaring it closed.**

### Three tests were actively defending bugs
Each encoded a confident, wrong justification in its own comment:
- `resetAuditSequence` — *"is a no-op: audit_trail PK is a UUID with no sequence to reset"*. The PK is a UUID; `chain_position` is a BIGSERIAL. The function had zero callers and nothing ever realigned sequences after a restore.
- `sync.routes` — *"has no preHandler — auth comes from the global onRequest hook"*. That hook authenticates; it does not authorize. A zero-permission account could pull the whole plant model.
- `verifyAuditChecksum` — *"always returns true for redacted rows… a mutation would still surface via chain mismatch on the NEXT row"*. It wouldn't: the next row's link points at this row's **stored** checksum, which an attacker never touches.

### Verification changed the answer repeatedly
- **L81** (admin-requests "second door") — REFUTED at HEAD; an earlier fix had closed it transitively.
- **L41** — symptom real (blank dropdown), stated mechanism wrong (RHF submits from `_formValues`, not the DOM).
- **L131** — "SUPER_ADMIN takeover" refuted; three guards cap it at ADMIN.
- **Mass assignment ×2** — claimed AJV lacks `removeAdditional`. It has it; it only acts when the schema declares `additionalProperties: false`.
- **`AuditAction` typing** — the proposed fix would have broken 65 working call sites. `AUDIT_ACTIONS` (89) isn't the registry; `AUDIT_TEMPLATES` (127) is. Zero production actions lack a template.
- **`sanitize-html`** — real advisory, not exploitable here (`allowedTags: []`).
- **`@fastify/static`** — recorded as unfixable; needed one `npm update`.

### Backlog round (`ba41cb5`) — three more filings refuted, two of them mine
- **"`retire()` strands RFID tags, same class as delete"** — REFUTED **by test, not argument**.
  Injecting the cascade turned `replace()` red: the tag row is destroyed, `replace()` still
  returns **200**, and the replacement filter comes up untagged with the physical tag orphaned.
  `replace()` calls `retire()` and *then* re-points identifiers — **retire being hands-off is a
  load-bearing precondition of `replace()`**. `unretire` is reversible too, so a physical delete
  would silently restore a tagless filter. The real pattern: *free the tag when the binding
  becomes meaningless (delete), preserve it when the filter's history stays meaningful (retire),
  move it when the tag stays on the wall (replace)* — three behaviours, all already correct.
  Three sites doing different things was read as inconsistency. Now locked by
  `e2e/retire-replace-identifier-invariant.test.ts`, written as a signpost for the next agent.
- **"Tablet uploads silently do nothing" (the API-base cluster)** — REFUTED. `contact-admin` is
  linked only from **desktop** `login.tsx`; `main.tsx`'s native boot guard redirects any non-`/m`
  path to `/m/login`, and `/m` was already clean. None of the 17 sites run on the APK. The fixes
  stand on consistency (every other caller uses `getApiBase()`), not on a reproduced break.
- **"13 unbound cycles ⇒ the equipment-group gap is live"** — REFUTED. 8 have
  `cleaning_area_id IS NULL` (block-fallback never runs); 5 sit in a block that has **never** had
  an equipment group. No block with an active group has unbound cycles. The guard shipped is
  **preventive**, not a repair.

Two of those three were errors I introduced or relayed, not the auditor's — the pattern rule and
a mis-read count. See `feedback_pattern_rule_is_a_hypothesis_not_a_verdict` in memory.

---

## 3. The one nobody was looking for

**Backup restore had been 100% broken since 2026-07-04 — and the commit that broke it was
itself a "CRITICAL restore lockout" fix.**

`ae1bc3b` added a pre-truncate snapshot selecting `users.password_history_hashes` — a column
that has never existed (password history is its own table). It raised `42703` on every
restore, and **a caught JS error does not un-abort a Postgres transaction**: everything after
died with `25P02` and the whole restore rolled back. The `try/catch` is what hid it.

It also explains why the mirror-trigger bug went unnoticed for months: nothing ever got that far.

**Only running a restore could find this.** Typecheck, unit tests and code review all pass
on it. Proven fixed by a real round-trip into a throwaway DB: counts exact, chain state
byte-identical to source, sequences non-colliding, and real password hashes preserved —
meaning the 07-04 lockout fix works for the first time.

---

## 4. Deliberately NOT fixed (authorized design)

Confirmed as real code behaviour, left alone by explicit operator decision:

1. **super-admin can rewrite checksummed `audit_trail` fields** — the manual-record-edit feature; the §11 warning was overridden twice.
2. **Reauth on Filter Data mutations ships OFF** — intentional configurable default. (The real bug inside it — `SUPER_ADMIN_DATA_EDIT` being *unsettable* in the UI — was fixed.)
3. **`audit_trail` has no UPDATE immutability trigger** — the trail is tamper-**evident** (hash chain detects edits), not tamper-**proof**. Documented 2026-07-10.
4. **The sync global-max version cursor** — offline-sync is a protected surface; its own task, not a sweep.

---

## 5. Open — operator actions

| # | Item | Impact |
|---|---|---|
| 0 | **Block MUPS has 2 active equipment groups** ("Testing", "Testing 2") | **The only pending item actively breaking something today.** Operators in MUPS get `MULTIPLE_EQUIPMENT_GROUPS` on readings; unpinned cycles resolve zero instruments. Also blocks the partial unique index that would properly close the equipment-group race (the in-tx count only narrows it — READ COMMITTED lets two txs both count 0). Fix via UI so it's audited. **Re-checked against the new `ba41cb5` deactivation guard: both groups sit in block `be97d14b` with `other_active = 1` each, so disabling either leaves one active → the guard does NOT block this fix.** |
| 1 | **Notification event types — decide** | 6 of 10 types have zero emit sites, but a live **ACTIVE** rule ("Filter Replacement") uses `CHECKLIST_APPROVED`/`CHECKLIST_REJECTED`. Trimming the enum needs a hand-authored migration against a populated DB and would destroy that operator's rule. **The test-fire endpoint dispatches the rule's own type with fabricated vars, so the admin's test SUCCEEDS while the rule never fires in production** — false confidence in a §11 system. Options: (a) trim the 6 and migrate the live rule, or (b) wire `CHECKLIST_*` into the checklist flow (net-new feature). Left untouched pending your call. |
| 2 | **Filter `CWH/F1/AHU-0B/SA/05/06-01`** is Set A, should be Set B | Corrupted 2026-07-14 by the Edit-dialog enum bug (live since 04-20). 91 earlier edits are forensically invisible — before/after audit capture only landed 07-08. Fix via UI so the correction is audited. |
| 3 | **Static IP `192.168.1.55`** + tablet Server Address `https://192.168.1.55:3000` | Machine drifted to `.124`, which the cert doesn't cover. `.55` is already in the cert SANs — no regen, no root-CA reinstall. APK is built and baked for it. |
| 4 | **Tablet verification** | Bulk filter-operate (pending since 07-09) and the new `sync/since` authz gate (protected surface). |
| 5 | **`/docs` under `@fastify/static@9.3.0`** | Unverified — no test covers it, and the running API holds pre-update modules. One restart settles it. Deferred because live users were on the API. |

---

## 6. Open — known gaps, with reasons

- **3,408 audit-chain anomalies** in `digilog_db`. `verify-chain` under-reports: `maxAnomalies` defaults to 100, so it bails at position ~193 and never checks the other ~16,700 rows. The **live write path is clean** (positions ≥16000: zero anomalies) and June is spotless; the damage is a ~49% cluster in May 2026 that the known AUDIT_DELETE test artifacts (41 link breaks + 59 gaps) do **not** explain. **Deliberately not "fixed"** — recomputing historic checksums to make verification pass is indistinguishable from tampering, and this design keeps breakage loud. See `reference_audit_chain_state_2026_07_15`.
- **4 dependency advisories remain** (`tar`, `uuid`) — neither reachable, neither fixable in-range. ⚠ **Do not run `npm audit fix --force`**: npm's "fix" for uuid is a **major downgrade of exceljs 4.4.0 → 3.4.0**, which would partially undo the 07-13 xlsx CVE migration.
- **LDAP audit unverified** — no directory available; covered by unit tests only.
- **Orphan-file GC for uploads** (`ba41cb5`). Un-gating photo upload to auth-only widened the orphan/DoS surface from `USER_UPDATE`-holders to all 70 users. Bounded with a route rate limit (~25 GB/min → 150 MB/hr), but it **keys on IP, not user** — `@fastify/rate-limit` registers at `app.ts:158`, `authPlugin` at `:176`, so `req.user` doesn't exist when the key is computed. Size cap (5 MB) + MIME allowlist + magic-byte validation already existed. **Unlink-on-replace was deliberately NOT built**: it doesn't touch the DoS loop (which never updates the profile, so nothing gets unlinked), and `photoUrl` is unvalidated — unlinking from the stored string would be an arbitrary-file-delete primitive. Needs a quota/GC design.
- **`#168` (block-change mode) is closed online only** — offline, the mode isn't cached (SWR gated on `online`), so a home/selected-block mismatch still prompts under `mode: NONE`. Pre-existing and deliberately scoped out: CONFIRM-offline is the documented never-block default (a spurious dialog offline is strictly safer than a missed block), and caching the mode reaches into the offline decision path beside the protected sync surface.
- **`fetch(logoUrl)` asset-base policy** — the default `/logo.jpg` is a bundled static asset that must NOT take the API base, but a DB-stored `/uploads/...` logo would. The same unprefixed pattern lives in `sidebar.tsx:345` and `report-page-wrapper.tsx:40`. One policy question across 3+ files (`getPhotoUrl` semantics), not a local prefix — left with a comment at the site.
- **`SELECT … FOR UPDATE` serialization is unit-tested for ordering only** — proving real concurrency behaviour needs two concurrent transactions against Postgres, which was not built.
- **`AuditEntry.action` is typed `string`** — investigated; the obvious fix is wrong (see §2). Typing against TEMPLATE keys would be the correct form, but there is no live defect behind it.
- **75 low-signal Mediums remain UNVERIFIED** — an agent's subagent fan-out stalled
  and it (correctly) refused to mark them REFUTED without checking. They are
  *unverified, not cleared*. Re-runs must forbid test execution — the stall was
  caused by prompts that invited `npm test` / EXPLAIN / curl.
- **89 Info** — not triaged (informational by definition).
- **The export-limit guard is inert on Cleaning Record export** for a second reason:
  the server caps its merge index at 5000 while `EXPORT_LIMIT_DEFAULT_MAX` is 10000,
  so under default config the guard cannot fire and >5000 cycles truncate. A
  truncation notice was added rather than pretending it's fixed.
- **`datetime-local` is minute-precision**, so editing a timestamp truncates seconds
  (`12:05:22.003Z` → `12:05:00.000Z`). Pre-existing (the old `.slice(0,16)` did the
  same) and not the −5:30 defect, but it IS real loss on a §11 record. `step="1"`
  would fix it.
- **The generic `POST /api/assets/instances` still can't gate by kind** — a
  hierarchy-only holder could create a FILTER by passing a FILTER templateId. The
  filter-specific routes were fixed; closing this needs a kind-aware check in the
  handler.

---

## 7. Method notes (worth reusing)

- **Refute-by-default verification, with the fix history supplied.** Roughly 20% of findings were stale or had the right symptom with the wrong mechanism. Agents that were told "some are already fixed, some are wrong" caught them; a fix-the-list approach would have shipped all of them.
- **Test the runtime, don't reason from docs.** The wins came from running the repo's actual libraries: RHF in jsdom, Prisma's generated SQL captured, the AJV question settled by booting a real Fastify, the sanitize-html PoC executed against our config.
- **Mutation-test the test.** A first-draft password test *passed against the broken implementation*. Measuring the real distribution (35.0% vs 27.2% uniform) produced a threshold that discriminates. Every statistical or atomicity test added afterwards was checked by reverting the fix and confirming it goes red.
- **Check the data, not just the code.** L71 was reported "latent — only fires where block-direct AHUs exist". The database has 7 of 38, carrying 35 filters. The report had been silently under-reporting for months.
