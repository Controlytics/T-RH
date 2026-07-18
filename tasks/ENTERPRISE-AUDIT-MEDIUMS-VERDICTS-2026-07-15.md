# Low-signal Mediums (`M01`–`M90`) — verdicts

Closes the coverage gap left when the 2026-07-13 fan-out stalled. **74 findings
verified, 0 left unverified** (2026-07-15, HEAD `f09035f`), by three agents
briefed refute-by-default and forbidden from running the test suites (test
execution is what stalled the original run).

| Verdict | Count |
|---|---|
| CONFIRMED-LIVE | **41** |
| CONFIRMED-LATENT | 17 |
| ALREADY_FIXED (this session) | 7 |
| REFUTED-STALE | 5 |
| REFUTED-UNREACHABLE | 4 |

Refute rate ~17%, consistent with the ~20% prior. **"Low-signal" was a bad
label** — most were real. Severity moved in both directions: several filed
Mediums are Lows whose transactions roll back cleanly, while `M69`, `M37` and
`M44` are all **above** their filing.

## Read this before acting on anything below

**The "reauth ships OFF by default" exemption is FALSE in this deployment** and
was wrongly given to agents as a design exemption all session.
`system_config['action-reauth']` has **80 of 82 actions ENABLED** with real role
lists. Also: `isReauthRequired` (`reauth-check.ts:120-125`) has **no SUPER_ADMIN
bypass**, and `PROJECT_LEADER` — named in many entries — **is not a live role**.
This flipped `M85` to LIVE and kept 4 of `M73`'s 5 sites unreachable.

**Corrupt data found, not just code** (needs an audited UI fix, not SQL):
- `M37` — filter `L8/AHU-89/SA/00-00` is active with parent NULL and a
  retire-only `_preRetireParentId` stamp: the fingerprint of a failed
  `replace()` compensation (catch at `filter.service.ts:846-849`).
- `M27` — **5 filters** soft-deleted with cycles stranded IN_PROGRESS, oldest
  ~2 months. (`ba41cb5` stops new ones; these predate it.)
- `M72` — **3 redacted `audit_trail` rows** (of 17,044) render as ordinary rows:
  no badge, no reason, no redactor. Redaction is meant to be the *visible*,
  chain-preserving alternative to deletion.

**Doc bug found:** `apps/api/CLAUDE.md` (and the auditor) claim the baseline
needs the `ltree` extension. It appears **only in `extensions.sql` itself** —
zero uses in the baseline or schema. Vestigial.

---

## Chunk 1

# Verdicts — chunk1 (25 findings) — VERIFY ONLY, no source edits
Repo: C:\Users\hello\21cfrlogbook-DigitalFMS @ RFID / f09035f
All DB queries READ-ONLY against digilog_db. No test suites run (per brief).

---
## ⚠ CROSS-CUTTING CORRECTION THAT CHANGED SEVERAL VERDICTS

The brief lists **"reauth ships OFF by default"** as a REFUTED-BY-DESIGN exemption.
**That exemption does not hold in this deployment.** Live query:

```sql
SELECT count(*) FILTER (WHERE jsonb_array_length(value)>0) AS enabled, count(*) AS total
FROM system_config, jsonb_each(config_value) WHERE config_key='action-reauth';
--  enabled | total
--       80 |    82
```

**80 of 82 configured reauth actions are ENABLED with real role lists** (EDIT_FILTER→[SUPERVISOR,
PROJECT_LEADER], DELETE_FILTER→[ADMIN,SUPERVISOR,PROJECT_LEADER], CREATE_FILTER, REPLACE_FILTER,
RETIRE_FILTER, UPDATE_USERID_CONFIG→[ADMIN,PROJECT_LEADER], …). Reauth is heavily ON here.

Two further facts that gate the reauth findings:
- **No SUPER_ADMIN bypass.** `apps/api/src/lib/reauth-check.ts:120-125` `isReauthRequired` is literally
  `roles.includes(role)` — SA is gated only where explicitly listed. The frontend mirrors this
  (`use-reauth.ts:49-52` just reads `/api/config/action-reauth/my-actions`).
- **`PROJECT_LEADER` is not a live role.** Live roles: SUPER_ADMIN, ADMIN, SUPERVISOR, SHIFTOFFICER,
  MANAGER, VIEWER, QA, OPERATOR. Many config entries name PROJECT_LEADER and are therefore inert —
  this is why several reauth findings are latent despite reauth being ON.

Live users by role (decides who can actually reach a surface):
`SUPER_ADMIN 82 · OPERATOR 34 · VIEWER 18 · SUPERVISOR 6 · QA 6/5 · ADMIN 4/3 · MANAGER 4 · SHIFTOFFICER 2/1`

---

## M03 — graphile-worker boot failure unsurfaced
VERDICT: ALREADY_FIXED
EVIDENCE: apps/api/src/app.ts:299 `let jobRunnerStatus: 'starting'|'running'|'failed' = 'starting'`; :467 →'running'; :475 →'failed' with `app.log.error` (no longer a warn); :316 health schema declares `jobRunner`; :329 `return { status:'ok', db:'connected', jobRunner: jobRunnerStatus }`.
REACHABILITY: GET /api/health.
DATA: n/a — code-level fix.
SEVERITY-IF-REAL: matches filing (Medium). On the session's ALREADY_FIXED list; verified present.
FIX-SKETCH: n/a

## M06 — LOCAL_SETUP_WINDOWS.md fresh-machine bootstrap fails
VERDICT: CONFIRMED-LIVE — **but sub-claim (1) is REFUTED; the auditor and `apps/api/CLAUDE.md` are both wrong about ltree**
EVIDENCE:
  **(1) ltree — REFUTED.** The auditor says the baseline "requires ltree too" so `migrate deploy` fails on a bare DB. Completed negative search: `grep -rn "ltree" apps/api/prisma/` returns **exactly one hit — `apps/api/prisma/sql/extensions.sql:1` itself.** Zero hits in `migrations/00000000000000_baseline/migration.sql`, zero in `schema.prisma` (no `ltree`/`Unsupported` column). The baseline needs **pgcrypto** (68 × `gen_random_uuid`), which §3 **does** create. **ltree is vestigial — `migrate deploy` does not fail for want of it.** Note: `apps/api/CLAUDE.md` repeats the same false claim ("the baseline uses these but doesn't create them, so migrate deploy fails on a bare DB without it") — the auditor likely inherited it from the doc rather than checking. Worth correcting in the doc too.
  **(2) seed password — CONFIRMED.** apps/api/prisma/seed.ts:73-75 `const defaultPassword = process.env.INITIAL_ADMIN_PASSWORD; if (!defaultPassword) throw new Error('FATAL: INITIAL_ADMIN_PASSWORD env var must be set for seeding…')`. LOCAL_SETUP_WINDOWS.md §6.3 says plain `npx prisma db seed` and then claims it creates "superadmin … password: `Admin@123`". Following the guide verbatim **throws**.
  **(3) TLS — CONFIRMED.** `grep -niE "mkcert|API_HTTPS|OFFLINE_REPLAY_SECRET|ltree|INITIAL_ADMIN_PASSWORD" LOCAL_SETUP_WINDOWS.md` → **zero hits** (completed negative search: the guide mentions none of them). Meanwhile apps/api/.env.example:43 `API_HTTPS=true`, start-digilog.bat:116 forces `set API_HTTPS=true`, and apps/api/src/app.ts:73-78 `httpsOptions = process.env.API_HTTPS === 'true' ? { key: fs.readFileSync(tlsKeyPath), cert: fs.readFileSync(tlsCertPath) } : null` → **ENOENT on a fresh clone** (certs/*.key is untracked).
  **(3b) URLs — CONFIRMED.** LOCAL_SETUP_WINDOWS.md:183 "API runs on http://localhost:3000" and :231 `curl http://localhost:3000/api/health` contradict the HTTPS the launcher forces.
  **(3c) OFFLINE_REPLAY_SECRET — CONFIRMED.** apps/api/.env.example:28-31 marks it "REQUIRED for stable offline sync" (unset ⇒ per-process random secret, rotates every restart, invalidates outstanding grants); the guide's §4.1 env template omits it.
REACHABILITY: anyone following the canonical setup guide on a clean box.
DATA: n/a — doc-vs-code contradiction, verified by reading both sides.
SEVERITY-IF-REAL: Medium, agrees with filing on impact but **not on mechanism count — 3 of the 4 breakages are real, not 3 of 3.** The doc is genuinely unusable on a fresh machine (seed throws, API won't boot).
FIX-SKETCH: §6.3 → `INITIAL_ADMIN_PASSWORD=Admin@123 npx prisma db seed`; add a "Generate dev TLS certs" section (mkcert) or document `API_HTTPS=false`; add OFFLINE_REPLAY_SECRET to §4.1; fix the http:// URLs. **Do NOT add the ltree line** — and drop the false ltree claim from apps/api/CLAUDE.md.

## M09 — LDAP users can never pass reauth; attempts lock the account
VERDICT: CONFIRMED-LATENT
EVIDENCE: apps/api/src/modules/ldap/ldap.service.ts:289 `passwordHash: 'LDAP_EXTERNAL_AUTH'` (auditor cited :253 — off by ~36 lines; the sentinel itself is real). :63 `enabled: false` is the shipped default; :157 `if (!cfg.enabled) return null` short-circuits every LDAP path. The file's own header at :19-20 already says "Audit finding reference: L-1 (Medium-LATENT) … LDAP is currently disabled (enabled: false) so this is a latent risk" — the codebase already classifies this subsystem as latent. Mechanism is sound: `verifyReauthPassword` (lib/reauth-check.ts:16-33) does `verifyPassword(password, user.passwordHash)` then `applyFailedPasswordAttempt` on failure — bcrypt vs a non-bcrypt sentinel can never succeed, and each try increments the lockout streak.
REACHABILITY: LDAP is a wired, admin-configurable feature (modules/ldap/routes.ts:14 exposes `enabled`, serverUrl, bindDN, …; :84 returns enabled state). An admin CAN turn it on → genuinely reachable, hence LATENT not UNREACHABLE.
DATA: `SELECT count(*) FROM users WHERE password_hash='LDAP_EXTERNAL_AUTH'` → **0**. `SELECT * FROM system_config WHERE config_key ILIKE '%ldap%'` → **0 rows** (never configured; service uses the enabled:false default). Zero LDAP users ⇒ nobody can hit this today.
SEVERITY-IF-REAL: Medium-if-enabled. One sub-claim is **worse** than the filing implies: a legitimate signed action *bricking the account* via lockout is nastier than "reauth fails". But strictly gated on an admin enabling LDAP AND provisioning users. Today: zero impact.
FIX-SKETCH: (only if LDAP is ever enabled) branch on the sentinel/authSource in verifyReauthPassword / verify / changePassword / offline-grant; reject with a distinct code that does NOT call `applyFailedPasswordAttempt`.

## M13 — cleaning-profiles GET lacks FILTER_OPERATE read-alternate
VERDICT: REFUTED-STALE
EVIDENCE: apps/api/src/modules/cleaning-profiles/routes.ts:25 (GET /) **and** :68 (GET /:id) both read `preHandler: [app.requireAnyPermission('FCP_READ','CP_TOGGLE','VERSION_HISTORY_VIEW','FILTER_OPERATE')]`. A ~10-line comment above each documents the exact 2026-07-10 sibling-miss the auditor describes and says "Sync calls BOTH the list and the per-id detail (offline-sync-service.ts:243,250) — hence both, and ONLY these two."
REACHABILITY: offline sync step 9.
DATA: n/a — the gate described by the finding no longer exists.
SEVERITY-IF-REAL: would have been Medium. Stale, not ALREADY_FIXED: the fix predates this session and was already on the branch when the audit was filed. The auditor read the code but not the comment sitting directly above the line.
FIX-SKETCH: n/a

## M17 — PUT /api/dashboards/:id/layout unscoped, non-transactional, 500s
VERDICT: REFUTED-UNREACHABLE
EVIDENCE: Completed negative search — `grep -rn "/api/dashboards" apps/web/src` returns **only two hits, both prose in a docs catalog**: apps/web/src/routes/home/module-flows.ts:374 and :376. **Zero call sites.** :376 states verbatim: "The /api/dashboards module (… update/delete/widgets/layout gate DASHBOARD_MANAGE …) is feature-complete but **parked since 2026-04-30 — no frontend page calls it.**"
REACHABILITY: **no callers.**
DATA: n/a — no caller can produce the state.
SEVERITY-IF-REAL: the three code defects (no dashboardId scoping, `Promise.all` instead of `$transaction`, uncaught P2025 after partial commits) are all real *as code*. But this is exactly the "/api/dashboards has zero frontend callers" class the brief flagged — only a hand-rolled call by a DASHBOARD_MANAGE holder reaches it. Not worth fixing before the widget-canvas page exists.
FIX-SKETCH: n/a (defer to whenever the page is built)

## M21 — GET /report-labels/current requires CONFIG_READ
VERDICT: CONFIRMED-LATENT
EVIDENCE: apps/api/src/modules/config/static-routes/report-labels.routes.ts:16 `preHandler: [app.requirePermission('CONFIG_READ')]` — it is the module's only read endpoint; the convention break vs siblings is real. Consumer apps/web/src/hooks/use-report-labels.ts:15-16 `useSWR('/api/config/report-labels/current')` → `const config = (data ?? {})` — **fails soft to defaults**; its own comment says "Network failure ⇒ defaults".
REACHABILITY: **confirmed — the 7 report pages are NOT CONFIG_READ-gated, so non-CONFIG_READ roles genuinely reach the hook.** Route guards in apps/web/src/main.tsx gate on unrelated perms: `/filter-retirements` :236 `[ASSET_READ, ASSET_VIEW, FILTER_RETIRE]`; `/rfid-track-record` :237 `[ASSET_VIEW, ASSET_READ, FILTER_RFID_MANAGE]`; `/audit` :265 `[AUDIT_READ]`; and `/quality-notifications` :238 has **no `RequireRole` at all** — every authenticated user reaches it. So the 403 does fire for real viewers → LATENT holds (it is not REFUTED-UNREACHABLE).
DATA: `SELECT config_value FROM system_config WHERE config_key='report-labels'` → **`{}` (empty)**. Roles holding CONFIG_READ: **only ADMIN + SUPER_ADMIN**; the other 6 active roles (SUPERVISOR, SHIFTOFFICER, MANAGER, VIEWER, QA, OPERATOR) 403 here. **Because the override map is empty, admins and non-admins render identical built-in labels today — zero divergence.**
SEVERITY-IF-REAL: **Low — below the filing.** The harm ("configured labels apply only to admins") activates the instant anyone saves one override; until then it is a silent 403 producing identical output. Mechanism right, impact claim premature.
FIX-SKETCH: drop the CONFIG_READ preHandler from GET /report-labels/current (display labels only), matching report-page-titles.routes.ts:24.

## M24 — filter-profile update() can never clear nullable fields
VERDICT: REFUTED-UNREACHABLE
EVIDENCE: The code defect is **real**: apps/api/src/modules/filter-profiles/filter-profile.service.ts:255-261 uses `data.x ?? existing.x` for description / allowedBlocks / maxCleaningCycles / isActive, so `null` can never reset them; and `snapshotAndBump(tx, id, …)` at :251 runs **unconditionally before** the update, so a discarded payload still bumps the version and writes a FilterProfileVersion snapshot. The auditor's mechanism is accurate.
REACHABILITY: **no callers.** Completed negative search: `grep -rn "api/filter-profiles" apps/web/src` → **exit 1, zero matches**. Repo-wide, the only live-branch hits are `apps/api/src/app.ts:370` (the route registration) and a comment at `apps/api/src/modules/sync/sync.service.ts:102`. Every frontend caller (`filter-profile-list.tsx`, the version-history `filter-profile` tab) exists **only in stale `.worktrees/` copies** — consistent with apps/web/CLAUDE.md: "The `filter-profile` tab … removed 2026-06-29 (no user-facing Filter Profiles page existed)." Filter Data Management does not touch it either (same negative grep covers `/api/super-admin/data/filter-profiles`).
DATA: n/a — no caller can send `maxCleaningCycles: null`.
SEVERITY-IF-REAL: would be Medium (a version record for an edit that didn't happen is a compliance-relevant lie). But PUT /api/filter-profiles/:id has no UI. Fix it only if the page returns.
FIX-SKETCH: n/a

## M27 — Filter can be soft-deleted while its cleaning cycle is IN_PROGRESS
VERDICT: CONFIRMED-LIVE
EVIDENCE: apps/api/src/modules/assets/services/filter.service.ts:128-139 softDelete performs no read of `FilterDetails.currentCycleId` / cycle status before deactivating; legacy `instance.service.ts` delete has the same gap → no compensating server-side guard anywhere.
REACHABILITY: DELETE /api/hierarchy/filters/:id — a real UI affordance on the Filters page.
DATA: **5 live rows.**
```sql
SELECT ai.name, ai.is_active, ai.status, cc.status AS cycle_status, cc.started_at
FROM asset_instances ai JOIN filter_details fd ON fd.asset_instance_id=ai.id
JOIN cleaning_cycles cc ON cc.id=fd.current_cycle_id
WHERE ai.is_active=false AND cc.status='IN_PROGRESS';
```
| name | is_active | status | cycle_status | started_at |
|---|---|---|---|---|
| mups-rdu-02 | f | Active | IN_PROGRESS | 2026-05-18 |
| G2/AHU-07/SA/01 | f | Active | IN_PROGRESS | 2026-05-26 |
| L1/AHu-01/01 | f | Active | IN_PROGRESS | 2026-05-26 |
| L1/AHU-02/05 | f | Active | IN_PROGRESS | 2026-05-26 |
| pre-filter-12 | f | Active | IN_PROGRESS | 2026-06-20 |

All 5 are `is_active=false` with a cycle stranded IN_PROGRESS — the oldest for ~2 months.
SEVERITY-IF-REAL: Medium, agrees with filing. Not data loss, but 5 CleaningCycle rows are permanently IN_PROGRESS against filters every hierarchy read hides, while still appearing in cycle history/exports. The auditor reasoned from code shape and happened to be right — the data check confirms it.
FIX-SKETCH: in softDelete, read `FilterDetails.currentCycleId`; if it points at an IN_PROGRESS cycle return 409 ("terminate the active cycle first"). Same guard on instance.service.delete. The 5 existing rows need a separate reconciliation decision.

## M31 — GET /api/notifications without `limit` returns the entire table
VERDICT: CONFIRMED-LATENT
EVIDENCE: All three code claims verified. Route schema apps/api/src/modules/notifications/routes.ts:19 `limit: { type: 'integer', minimum: 1 }` — **no default, no maximum**. Zod schema notification.service.ts:45 `limit: z.coerce.number().min(1).optional()` — same. Repository notification.repository.ts:4-9 `...(take ? { skip, take } : {})` — **omits `take` entirely when undefined**, i.e. no LIMIT. service.ts:136 `limit: parsed.limit ?? total` confirms full-table intent.
REACHABILITY: **every frontend caller passes `limit`** — completed search of all callers: dashboard.tsx:77 `?limit=1`; notifications/index.tsx:120,124 builds `new URLSearchParams({ page, limit: String(perPage) })` (always set); mobile-wrapper.tsx:294 `?limit=50`. So the unbounded branch is only reachable via a hand-crafted authenticated request.
DATA: `SELECT count(*) FROM notifications` → **897**. Serializing 897 rows is not a blow-up today; the where-clause is user-scoped for non-SA, so only a SUPER_ADMIN's hand-rolled call sees all 897.
SEVERITY-IF-REAL: **Low — below the filing.** The "memory/latency blow-up" and tablet-OOM framing is unsupported at 897 rows with no caller omitting `limit`. The real point is the missing ceiling (`limit=10000000` is accepted) on a table with no retention job — worth a cheap guard, not urgent.
FIX-SKETCH: give `limit` a default (50) and `maximum` (200) in both the route and zod schemas; make the repository always apply `take`.

## M34 — Delivery retry engine is in-process setTimeout
VERDICT: CONFIRMED-LATENT
EVIDENCE: All three sub-claims verified in apps/api/src/modules/notification-delivery/delivery.service.ts (`MAX_RETRIES = 3` :18, `RETRY_DELAYS = [5000, 15000, 45000]` :19):
  - **Durability:** retries are `await new Promise(resolve => setTimeout(resolve, delay))` at :108 — a restart while a row is RETRYING strands it; no sweeper exists. The file's own TODO at :95-96 says "Replace setTimeout retries with graphile-worker delayed jobs (`runAt`) for durability across restarts."
  - **(a) nextRetryAt mismatch — CONFIRMED.** :68 records `now + RETRY_DELAYS[0]` (5 s), but :82 calls `scheduleRetry(log.id, resolvedPayload, 1)` and :107 sleeps `RETRY_DELAYS[attempt]` = `RETRY_DELAYS[1]` = 15 s. The DB timestamp is always wrong and `RETRY_DELAYS[0]` is never used as a real delay.
  - **(b) dead guard — CONFIRMED.** :99 `if (attempt >= MAX_RETRIES)` is unreachable: the only external caller passes `1` (:82), and the recursion at :149 fires only inside the `else` of `if (nextAttempt >= MAX_RETRIES)` (:128), so `attempt` ∈ {1, 2} and never ≥ 3.
REACHABILITY: `sendNotification` is called from notification-dispatcher.ts:6 and routes.ts:12 — real callers exist.
DATA: `SELECT status, count(*) FROM notification_logs GROUP BY status` → **0 rows. The table is completely empty** — no delivery has ever been logged (no channel is configured/exercised), so there is not a single stuck RETRYING row.
SEVERITY-IF-REAL: **Low — below the filing.** Every code defect is real and correctly diagnosed (the auditor was precise here), but with an empty table and no configured channel the retry engine has never run. Fix when notification delivery is actually turned on.
FIX-SKETCH: move retries to graphile-worker `runAt` jobs per the file's TODO; fix the delay indexing so recorded `nextRetryAt` matches the actual sleep; delete the :99-105 guard.

## M37 — Failed replace() leaves filter detached, relationships deleted, cycle terminated
VERDICT: CONFIRMED-LIVE
EVIDENCE: apps/api/src/modules/filter-operations/filter-operations.service.ts — `retire()` sets `parentId: null` (:705), stashes `_preRetireParentId` (:706), and `assetRelationship.deleteMany` (:716-718). `replace()` calls `await this.retire(ctx, filterId, remarks, 'REPLACED')` at **:780 as a separate commit**, then creates the replacement in its own `prisma.$transaction` (:787-842). The catch (:843-855) restores **only** `{ status:'Active', isActive:true }` (:846-849) and nulls `currentLifecycleState` (:850-853) — it does **not** restore `parentId`, does **not** recreate CONTAINS/CONTAINED_IN, does **not** revert the cycle's REPLACED status. Auditor's line refs and mechanism are accurate.
REACHABILITY: `replace()` via the Filters page and via `replacement-schedule` `executeReplacement` (service.ts:386).
DATA: **1 live row, matching the predicted fingerprint exactly.**
```sql
SELECT at.template_kind, ai.is_active, ai.status, count(*) FROM asset_instances ai
JOIN asset_templates at ON at.id=ai.template_id WHERE ai.parent_id IS NULL GROUP BY 1,2,3;
-- BLOCK  | f | Active  |  12      <- by design
-- BLOCK  | t | Active  |   9      <- by design (top of hierarchy)
-- FILTER | f | Retired | 151      <- by design (retire() nulls parentId)
-- FILTER | t | Active  |   1      <- ***THE ANOMALY***
-- OTHER  | f/t | Active | 43/10
```
That row: **`L8/AHU-89/SA/00-00`** — status `Active`, `parent_id` NULL, `custom_attributes->>'_preRetireParentId'` = `f2a40b36-c47c-4db2-8dd5-49db7d98ff05` (**not null**).
Why this is diagnostic: `_preRetireParentId` is written **only** by `retire()` (:706); `status='Active' + is_active=true` is written back **only** by the replace() catch (:846-849) — `retire()` itself leaves `status='Retired'/is_active=false`. An **active** filter carrying a **retire-stamp** with a **nulled parent** is the signature of a failed replace whose compensation ran. I could not construct another code path producing this triple.
**Honest caveat:** a SUPER_ADMIN hand-edit via Filter Data Management could in principle forge the same shape. I did not find audit evidence either way, so the mechanism is inferred from the fingerprint, not proven end-to-end.
SEVERITY-IF-REAL: **Medium-High — above the filing.** This filter is invisible in hierarchy views and excluded from AHU-completion rosters (`loadCountedFilters` keys on parentId), and it is a GxP record sitting in a corrupt state, undetected. That is the argument for fixing the compensation rather than just the row.
FIX-SKETCH: run retire-old + create-new in ONE `prisma.$transaction` (all writes are Prisma; nothing needs two commits) — compensation becomes unnecessary and the :759-769 name-check TOCTOU closes. Separately reconcile the one orphan using its `_preRetireParentId`.

## M40 — executeReplacement never verifies oldFilterId belongs to the entry's AHU
VERDICT: CONFIRMED-LATENT
EVIDENCE: apps/api/src/modules/replacement-schedule/service.ts:370-399 `executeReplacement(entryId, oldFilterId, remarks, ctx)` — loads `entry` (:371), computes `ahuReplacementProgress(entry.ahuId, entryId)` (:380), then calls `await filterOps.replace(ctx, oldFilterId, remarks)` at **:386 with the caller-supplied `oldFilterId` and no check that it is an active FILTER under `entry.ahuId`.** `filterOps.replace` (filter-operations.service.ts:735-739) only does `findFirst({ where: { id: filterId } })` — it accepts **any** asset id. The `before.remaining === 0` guard (:381-383) checks the AHU's progress, not the filter's membership. The `ReplacementExecution` row (:393-398) then records the wrong pairing. Auditor's mechanism is accurate.
REACHABILITY: reachable — POST via the replacement-schedule page. But the UI only offers the AHU's own child filters, so a *wrong* id requires a hand-crafted request (or a UI bug). REPLACE_FILTER reauth is enabled for [SUPERVISOR, PROJECT_LEADER] and SUPERVISOR holds FILTER_EDIT, so an authorized caller exists.
DATA: I found **no evidence of a mismatched execution today.** The one corrupt artifact I did find (M37's `L8/AHU-89/SA/00-00`) is a *compensation* failure, not a cross-AHU replacement. There is no `ReplacementExecution` row whose `old_filter_id` sits outside its entry's AHU that I could attribute to this path.
SEVERITY-IF-REAL: Medium, agrees with filing. Classic missing-server-side-validation: only UI convention protects the invariant, which is precisely the argument for the guard. But it is latent — no bad data yet.
FIX-SKETCH: before `replace()`, assert the old filter is active, FILTER-kind, not Retired, and `parentId === entry.ahuId` (reuse `activeFilterIdsByAhu([entry.ahuId])` and test membership); else 400 FILTER_NOT_IN_AHU.

## M43 — GET /due fetches EVERY cleaning cycle for all involved filters
VERDICT: CONFIRMED-LIVE (mechanism), severity **well below the filing**
EVIDENCE: apps/api/src/modules/pm-schedules/pm-due-tasks.ts:176-181
```ts
const recentCycles = filterIds.length
  ? await prisma.cleaningCycle.findMany({
      where: { filterId: { in: filterIds } },
      orderBy: [{ filterId: 'asc' }, { startedAt: 'desc' }],
    })
  : [];
```
**No `take`, no date bound, no `select`** — while the comment directly above at :172-174 claims "we take the 5 most recent per filter". The comment is simply false; the auditor is right.
REACHABILITY: My Tasks — a hot, frequently-polled tablet page. Runs on every request.
DATA: `SELECT count(*) FROM cleaning_cycles` → **612 — that is the ENTIRE table.** So the absolute worst case this query can materialize today is 612 rows (and in practice far fewer, since it is filtered to child filters of *due* AHUs).
SEVERITY-IF-REAL: **Low — the filing's "thousands of rows materialized per request, growing without bound" is not true today** (the whole table is 612 rows after a year+ of operation). The unbounded-growth argument is directionally valid but the urgency is overstated. Worth fixing as cheap hygiene (the lying comment alone justifies a touch), not as a performance incident.
FIX-SKETCH: bound by `startedAt: { gte: <min windowStart across entries − margin> }` and `select` only {status, startedAt, completedAt, cleaningReasonKey, filterId}; fix or honor the "5 most recent" comment.

## M46 — PUT /api/pm-schedules/:id accepts an unvalidated entries array
VERDICT: REFUTED-STALE
EVIDENCE: apps/api/src/modules/pm-schedules/routes.ts:676-695 — the PUT body is **not** `{ entries: { type: 'array' } }`. It reads:
```ts
body: { type:'object', required:['entries'], properties: { entries: { type:'array', minItems: 1,
  items: { type:'object', required:['month','plannedDate'], properties: {
    month:{type:'integer',minimum:1,maximum:12}, plannedDate:{type:'string',format:'date'},
    toleranceDays:{type:'integer',minimum:0}, notes:{type:'string'} } } } } }
```
That is **exactly the fix the auditor proposed** (POST /'s items schema copied in, plus `minItems: 1`), already present. Garbage `month`/`plannedDate` are rejected at the schema layer; no Prisma 500.
REACHABILITY: PUT /api/pm-schedules/:id (UPDATE_PM_SCHEDULE reauth enabled for SUPERVISOR/PROJECT_LEADER).
DATA: n/a — the schema described by the finding no longer exists.
SEVERITY-IF-REAL: would have been Medium. **Residual nit only:** `toleranceDays` still has `minimum: 0` with **no `maximum`** on both POST (:653) and PUT (:689), whereas import/resubmit enforce 0-365 — the auditor's parity point survives, at Low severity.
I did **not** inherit the finding's "non-transactional archive bug above" premise (it belongs to another finding and the main claim is refuted regardless).
FIX-SKETCH: n/a for the core claim; optionally add `maximum: 365` to `toleranceDays` on POST / and PUT /:id for parity.

## M50 — Generic super-admin PUT/POST handlers do no value validation
VERDICT: CONFIRMED-LIVE
EVIDENCE: apps/api/src/modules/super-admin/routes.ts:358-372 `PUT /data/cleaning-cycles/:id` — every sub-claim verified:
```ts
schema: { …, body: { type:'object', additionalProperties: true } }   // :358
for (const f of stringFields) { if (body[f] !== undefined) data[f] = body[f]; }        // :366  ← status → CleaningCycleStatus enum, unchecked
for (const f of dateFields)   { if (body[f] !== undefined) data[f] = body[f] ? new Date(body[f]) : null; }  // :367 ← no isNaN guard
for (const f of uuidFields)   { if (body[f] !== undefined) data[f] = body[f] || null; }  // :369 ← filterId/profileId re-point, no FK check
return prisma.cleaningCycle.update({ where: { id }, data });          // :371  ← NO try/catch
```
(a) `status:'BOGUS'` → Prisma enum validation error → **raw 500**. (b) `'13/07/2026'` → Invalid Date → Prisma throws → **500**. (c) re-pointed `filterId` → FK P2003 → 500, and re-pointing does **not** reconcile `FilterDetails.currentCycleId`, stranding the old filter "in progress". (d) no cross-field checks. Confirmed the PUT has **no try/catch** while the sibling POST at :379-404 does (`try {` at :404) — the asymmetry the auditor flagged is real.
REACHABILITY: `dataMutationPreHandler = [app.requireRole('SUPER_ADMIN'), requireDataEditReauth]` (:314) — **SUPER_ADMIN only**, via the Filter Data Management console. 82 SA users. Note `SUPER_ADMIN_DATA_EDIT` is **not** present in the live action-reauth config, so `requireDataEditReauth` currently demands nothing.
DATA: not separately queried — the defect is input-handling, and the console is live and SA-reachable.
SEVERITY-IF-REAL: **Medium, bounded — I'd rate it below the filing's implied reach.** Per the advisor's warning I am explicitly **not** applying the "SUPER_ADMIN may edit records incl. audit fields (authorized)" exemption: this finding is about *unvalidated input producing raw 500s and a stale `currentCycleId`*, which is not the authorized behavior. But it is SA-only, so it is a console-robustness/data-integrity issue, not a privilege problem. The `filterId`-repoint → stale `currentCycleId` is the part with real teeth (it manufactures exactly the M27 stranded-cycle state).
FIX-SKETCH: per-table Zod (enum unions, `z.coerce.date()` validity, month 1-12); validate FK targets exist; wrap PUTs in the POSTs' try/catch → 4xx mapping; reconcile `FilterDetails.currentCycleId` when a cycle's filterId changes.

## M53 — Retired/deactivated filters are never evicted from the offline cache
VERDICT: CONFIRMED-LIVE (server-side protocol gap is unconditional) — **but see the PROTECTED-SURFACE note**
EVIDENCE: apps/api/src/modules/sync/sync.service.ts:190-194 `fetchFilters` hard-filters:
```ts
const where: any = { template: { templateKind: 'FILTER' }, isActive: true };
```
A retired/soft-deleted filter stops matching the `where`, so **no update ever reaches the client** — it is not that a tombstone is missing, it is that the row silently vanishes from the changed-set. The cursor advances regardless. The auditor's mechanism is exactly right.
REACHABILITY: every offline tablet sync.
DATA: **151 FILTER rows are `is_active=false, status='Retired'`** (from the M37 kind/status breakdown) — i.e. 151 filters have been retired since the caches were populated. Any tablet that synced a filter before its retirement still holds it as `isActive: true`.
**Honest limit on this verdict:** I can prove the server-side protocol gap and that 151 retirements occurred, but I **cannot observe tablet IndexedDB from here**, so I cannot prove a specific stale cache exists right now. The gap itself is unconditional; the client-side consequence is inferred.
SEVERITY-IF-REAL: Medium, roughly agrees with the filing — though the filing's worst case ("operator queues cleaning ops against a filter that no longer exists") is **mitigated**: the server rejects those ops at sync time, so the outcome is a failed op, not corrupt data. The "or worse, if id reuse" speculation is unfounded (UUID PKs).
FIX-SKETCH: **NONE PROPOSED — offline-sync is a PROTECTED SURFACE per the brief.** Recording the verdict only; any change here needs an explicit, separately-authorized decision by the owner of that surface.

## M56 — UserGroup.isActive is write-only
VERDICT: CONFIRMED-LATENT
EVIDENCE: The half-wired flag is real. Dispatcher apps/api/src/modules/notification-delivery/notification-dispatcher.ts:232-237 resolves members with:
```ts
prisma.userGroupMember.findMany({ where: { groupId: { in: groupIds } }, select: { userId: true } })
```
— **no join or filter on `group.isActive`**. (Contrast :228, which *does* filter role-based recipients on `status: 'ENABLED'` — so the omission is inconsistent, not a house style.) `isActive` is accepted on PUT (user-groups/routes.ts:64) and defaults true in the schema; GET / returns groups unfiltered.
REACHABILITY: **no frontend PUT exists** — completed search of all `/api/user-groups` callers in apps/web/src (notification-rules/index.tsx:192, 516, 528 POST, 537 DELETE, 543 members GET, 549 members POST, 557 members DELETE) shows **GET/POST/DELETE/members only, never PUT**. So `isActive` can only be flipped by a hand-crafted request — the auditor's own "semi-latent" caveat is correct.
DATA: `SELECT is_active, count(*) FROM user_groups GROUP BY 1` → **1 group, is_active=true** (none deactivated). `SELECT count(*) FROM user_group_members` → **0**. `SELECT recipient_type, count(*) FROM notification_rule_recipients GROUP BY 1` → **0 rows** — **no rule uses a GROUP recipient at all.** The `groupIds.length > 0` branch never executes.
SEVERITY-IF-REAL: **Low — below the filing.** Three independent reasons it cannot bite: no PUT caller, no group members, no GROUP-type recipients. The auditor's "a half-wired flag is worse than none" design point stands on its merits.
FIX-SKETCH: either filter the dispatcher on `group: { isActive: true }` and surface inactive groups in the list, or drop `isActive` from the PUT schema and the model. Pick one.

## M59 — Stage progress bar marks the wrong stage as "current"
VERDICT: CONFIRMED-LIVE
EVIDENCE: apps/web/src/routes/cleaning-cycles/cycle-detail-view.tsx:76-78
```ts
const completedStages = events
  .filter((e:any) => e.eventType === 'STATE_TRANSITION' && e.toState)
  .map((e:any) => e.toState);          // ← .map only: NO dedupe, duplicates retained
```
and :197 `const isCurrent = !notApplicable && !done && completedStages.length > 0 && i === completedStages.length;` — a **count-based index** over a list that contains duplicates. With `[WASH_IN, WASH_OUT, DRY_IN, DRY_IN]` (length 4), index 4 = STORAGE_IN → `!done` → pulses blue as "current" (:203 `animate-pulse`), while the real next stage DRY_OUT (index 3) stays grey. Exactly as filed.
REACHABILITY: the compliance-facing cycle detail view.
DATA: **259 cycles already carry the duplicate DRY_IN double-transition:**
```sql
SELECT cc.status, count(DISTINCT cc.id) FROM cleaning_cycles cc
WHERE (SELECT count(*) FROM filter_events fe WHERE fe.cycle_id=cc.id
       AND fe.event_type='STATE_TRANSITION' AND fe.to_state='DRY_IN') > 1
GROUP BY 1;
-- IN_PROGRESS |   3
-- COMPLETED   | 245
-- TERMINATED  |  11
```
The **3 IN_PROGRESS cycles are mis-rendering right now** (for COMPLETED cycles every stage is `done`, so `isCurrent` is false and the bug is invisible — which is why it survived). The double DRY_IN is the *normal* dryer flow (SET_DURATION then SUBMIT_READINGS), not an edge case.
SEVERITY-IF-REAL: Medium, agrees with filing. It mislabels the operator's next action on a compliance-facing view, and it is the standard flow, not a corner case.
FIX-SKETCH: derive structurally — build a Set of reached stages and pick the first in-profile stage not reached and after `maxReachedIdx` (reuse the pattern already written in history.tsx:399-404); gate on `cycle.status === 'IN_PROGRESS'`.

## M64 — Reset-request dialog wedges in 'Processing...' if reauth is cancelled
VERDICT: CONFIRMED-LATENT
EVIDENCE: The mechanism is real and I confirmed the shared root cause. apps/web/src/routes/users/reset-requests.tsx:103 `setIsProcessing(true)` fires **before** :112 `await reauth.execute('PROCESS_RESET_REQUEST', …)`; `isProcessing` is reset only in `onSuccess` (:130) and `onError` (:134). apps/web/src/hooks/use-reauth.ts:165-170 `cancel` calls `pendingAction.current?.reject?.(…)` and clears state but **never invokes `onError`** — so `execute()` callers are never notified of a cancel. `closeDialog` (:68) does not reset it either. Page wires `onCancel={reauth.cancel}` (:591).
REACHABILITY: **gated on the action being reauth-enabled.** `needsReauth` (use-reauth.ts:49-52) returns false → `execute` takes the inline `else` branch (:71-91) → callback runs → onSuccess/onError fire → flag resets. No dialog, no wedge.
DATA: `SELECT config_value ? 'PROCESS_RESET_REQUEST' FROM system_config WHERE config_key='action-reauth'` → **`f` — the key is not present in the config at all** (the config holds 82 keys; this is not one of them). So `needsReauth('PROCESS_RESET_REQUEST')` is false for every role and the dialog never opens here.
SEVERITY-IF-REAL: Medium if enabled. Note this is the **same root cause as M85** — `use-reauth.cancel` not calling `onError` — but unlike M85 this action is not configured, so it cannot fire today.
FIX-SKETCH: fix once at the source — have `use-reauth.cancel` invoke the pending `onError` with `{ error: 'REAUTH_CANCELLED' }`; that closes M64 and M85 together.

## M69 — Destructive audit selection survives sort and page-size changes
VERDICT: CONFIRMED-LIVE
EVIDENCE: apps/web/src/routes/audit/index.tsx:101-103
```ts
useEffect(() => { setSelectedIds(new Set()); }, [page, search, fromDateTime, toDateTime]);
```
— `sortBy`, `sortOrder`, `perPage` are **absent from the deps**. `toggleSort` (:77-85) sets sortBy/sortOrder then `setPage(1)` (:84) — **when the user is already on page 1, `page` does not change, so the effect never fires** and `selectedIds` keeps rows that are no longer displayed. Same for `onPageSizeChange={setPerPage}` (:487). The query at :87 `new URLSearchParams({ page, limit: String(perPage), sortBy, sortOrder })` includes all three, so the rendered rows genuinely change underneath the stale selection.
REACHABILITY: **live, via SUPER_ADMIN.** `SELECT name, (permissions::jsonb ? 'AUDIT_DELETE') FROM roles WHERE is_active` → **`f` for all 8 roles, including SUPER_ADMIN.** But SUPER_ADMIN **bypasses** both the frontend `can('audit.delete')` gate and the backend `AUDIT_DELETE` check (documented in CLAUDE.md: "require `AUDIT_DELETE` (SUPER_ADMIN bypasses)"). With **82 SUPER_ADMIN users**, the "Delete Permanently" affordance is reachable today. `BULK_DELETE_AUDIT_RECORDS` reauth is configured for [ADMIN, PROJECT_LEADER] — neither of which can reach the button — so SA gets **no password prompt** either.
DATA: reachability established above; I did not attempt to trigger a deletion (read-only mandate).
SEVERITY-IF-REAL: **Medium-High — at or above the filing.** The blast radius is an irreversible, hash-chain-breaking §11 operation performed on rows the operator cannot see, by the one role that gets neither a permission gate nor a reauth prompt. The auditor called this "a real footgun" and understated it if anything.
FIX-SKETCH: add `sortBy`, `sortOrder`, `perPage` to the effect deps (or clear the selection inside `toggleSort` and the page-size handler). Consider showing selected records' timestamps in AuditDeleteDialog.

## M73 — Five save paths hit reauth-gated endpoints without useReauth
VERDICT: CONFIRMED-LIVE — **but only at 1 of the 5 claimed sites; the other 4 are unreachable/latent**
EVIDENCE: The FE/BE mismatch is real at all 5 sites (plain `apiClient.put`, no `useReauth`). What the live config + live role permissions decide is *which* can actually fire. Per-site:
  - **user-id.tsx:85 — CONFIRMED-LIVE.** `await apiClient.put('/api/config/user-id', saveData)` with no reauth wrapper; the catch at :89-92 just renders `err?.message` in a `saveMessage` banner — **no password dialog, ever**. Live config: `UPDATE_USERID_CONFIG => ["ADMIN", "PROJECT_LEADER"]`. **ADMIN holds `CONFIG_UPDATE = t`**, so ADMIN can reach the page. **3 enabled ADMIN users** → an ADMIN saving User ID config gets a hard REAUTH_REQUIRED error with no way to satisfy it. This one is real and live.
  - **permissions-tab.tsx:47 + sidebar-tab.tsx:90/99/108 — UNREACHABLE.** `UPDATE_ROLE_CONFIG => ["SUPERVISOR","PROJECT_LEADER"]`. But **SUPERVISOR has `ROLE_MANAGE = f` and `CONFIG_UPDATE = f`** → cannot reach Roles & Access. PROJECT_LEADER is not a live role. ADMIN and SUPER_ADMIN are **not** in the list → `needsReauth` false → save succeeds. No user can trigger it.
  - **reauth-tab.tsx:233 — UNREACHABLE.** `UPDATE_REAUTH_CONFIG => ["SUPERVISOR","PROJECT_LEADER"]` — same reasoning (SUPERVISOR lacks CONFIG_UPDATE).
  - **filter-data-management.tsx (all ~10 mutations) — NOT TRIGGERABLE.** Gate is `SUPER_ADMIN_DATA_EDIT`, which is **absent from the live action-reauth config entirely** → `requireDataEditReauth` demands nothing → plain PUTs succeed.
REACHABILITY: see per-site above. Verified via `isReauthRequired` = `roles.includes(role)` with **no SA bypass** (reauth-check.ts:120-125).
DATA: live action-reauth config (80/82 enabled) + `SELECT name, permissions ? 'ROLE_MANAGE', permissions ? 'CONFIG_UPDATE' FROM roles` → SUPERVISOR: f/f; ADMIN: f/t. Users: ADMIN 3 enabled.
SEVERITY-IF-REAL: **Low-Medium — below the filing.** The auditor filed this as 5 broken surfaces; **4 of the 5 cannot fire** given live roles/config, and the 5th breaks a rarely-touched admin config page for 3 users. The underlying inconsistency (sibling pages wire reauth correctly) is a legitimate maintainability point, and any of the 4 dormant sites becomes live the moment someone adds ADMIN/SUPER_ADMIN to those config keys — which, given 80/82 are already on, is plausible.
FIX-SKETCH: wrap user-id.tsx's save in `reauth.execute('UPDATE_USERID_CONFIG', …)` with the `putWithReauth` variant (copy access-matrix.tsx:119-139). Cheap hardening for the other 4: catch `err.error === 'REAUTH_REQUIRED'` and surface ReauthDialog retroactively.

## M78 — pm-schedules raw fetches skip getApiBase()
VERDICT: ALREADY_FIXED (upload) + CONFIRMED-LIVE (template/xlsx) — compound finding, halves resolve differently
EVIDENCE:
  - **Upload half (the serious one — silent no-op "success" on Capacitor): FIXED.** apps/web/src/routes/pm-schedules/index.tsx:350 now reads `await fetch(apiUrl('/api/pm-schedules/upload'), { method:'POST', headers, body: form })`. apps/web/src/lib/url-utils.ts:9-11 `apiUrl(path) => \`${getApiBase()}${path}\``.
  - **Template/xlsx half: still live.** index.tsx:237 `fetch(\`${(window as any).__API_BASE__ ?? ''}/api/pm-schedules/template.csv\`)` and :318 `const base = (window as any).__API_BASE__ ?? '';` (used at :323 for `export.xlsx`). Both read the window global directly, skipping getApiBase()'s VITE_API_URL fallback (api-base.ts:22-23).
REACHABILITY: Download-Template and Export-Excel buttons on the PM Schedules page.
DATA: Completed negative search per the advisor's request — `grep -rn VITE_API_URL apps/web` (excl. dist) → **4 hits: `.env.production:1` (the baked value), 2 comments, and `api-base.ts:22` as the ONLY read.** Nothing mirrors VITE_API_URL into `window.__API_BASE__`; the sole mirror is `initApiBaseFromStorage()` (api-base.ts:41-46, called at main.tsx:121) which copies **localStorage only** (`if (stored && !(window as any).__API_BASE__)`). **The gap does not close** — on an APK where the operator never set a server URL manually, `window.__API_BASE__` is undefined → both fetches resolve relative → WebView origin → index.html.
SEVERITY-IF-REAL: **Low — below the filing.** The dangerous part (a write silently reporting success) is already fixed. What remains is two read-only downloads that fail *visibly* (`if (!res.ok) throw new Error(...)` at :240 → caught into an error message) or yield a junk file. Real, but cosmetic beside the upload bug.
FIX-SKETCH: replace both `(window as any).__API_BASE__ ?? ''` with `getApiBase()` (or `apiUrl(...)`, as :350 already does).

## M81 — Avatar initial crashes the page on empty-string requesterName
VERDICT: CONFIRMED-LATENT
EVIDENCE: apps/web/src/routes/admin-requests/index.tsx:289 `{(req.requesterName ?? '?')[0].toUpperCase()}` — `??` guards only null/undefined; `''` passes through, `''[0]` is `undefined`, `.toUpperCase()` throws a TypeError that takes down the table render. Duplicated at :376 in the slide-over.
REACHABILITY: **the auditor's reachability claim checks out — two independent paths.**
  1. **Sanitizer path:** apps/api/src/modules/admin-requests/routes.ts:30 validates `requesterName: { type:'string', minLength: 1, maxLength: 100 }` — but the service **strips HTML afterwards**: admin-request.service.ts:24 `requesterName: stripHtml(data.requesterName)`. So `"<b></b>"` (7 chars) **passes minLength**, then sanitizes to `''`. Schema validation runs before sanitization, so the guard does not cover this.
  2. **SUPER_ADMIN path:** super-admin/routes.ts:550 `POST /data/admin-requests` and :535 `PUT /data/admin-requests/:id` both take `body: { type:'object', additionalProperties: true }` and write straight to `prisma.adminRequest` — an SA can set `requesterName: ''` directly.
DATA: `SELECT count(*) FILTER (WHERE requester_name IS NULL) nulls, count(*) FILTER (WHERE requester_name='') empties, count(*) FILTER (WHERE trim(requester_name)='') blanks, count(*) total FROM admin_requests` → **0 / 0 / 0 / 9.** All 9 rows have real names — the crash cannot fire today.
SEVERITY-IF-REAL: Low-Medium, roughly matches filing. A whole-page crash from one bad row is a bad failure mode, and the fix is a one-liner, but nothing triggers it now.
FIX-SKETCH: `(req.requesterName?.trim() || '?').charAt(0).toUpperCase()` at both :289 and :376 (or extract `initialOf(name)`).

## M85 — Cancelling reauth leaves filter-list panels stuck on 'Processing…'
VERDICT: CONFIRMED-LIVE
EVIDENCE: Root cause verified at the shared hook: apps/web/src/hooks/use-reauth.ts:165-170
```ts
const cancel = useCallback(() => {
  pendingAction.current?.reject?.({ error: 'REAUTH_CANCELLED' });   // settles executeWithResult ONLY
  setState({ isOpen:false, password:'', error:'', isVerifying:false });
  pendingAction.current = null;
}, []);
```
`reject` settles `executeWithResult` promises, but **`onError` is never invoked**, so every `execute()` caller that resets its flag only in onSuccess/onError is left hung. filter-list.tsx wires `onCancel={reauth.cancel}` (:1905) and sets submitting flags before `reauth.execute` (statusPanelSubmitting:511, rfidSubmitting:575, panelSubmitting:750, editFilterSubmitting:963, deletingBlock:365, …). Auditor's mechanism is precisely right.
REACHABILITY: **live today — this is where the "reauth is OFF by default" exemption breaks down.** The relevant actions are all enabled with real roles: `EDIT_FILTER => [SUPERVISOR, PROJECT_LEADER]`, `DELETE_FILTER => [ADMIN, SUPERVISOR, PROJECT_LEADER]`, `CREATE_FILTER => [SUPERVISOR, VIEWER, PROJECT_LEADER]`, `REPLACE_FILTER`/`RETIRE_FILTER => [SUPERVISOR, PROJECT_LEADER]`, `CREATE_ASSET_IDENTIFIER => [ADMIN, SUPERVISOR, PROJECT_LEADER]` (rfidSubmitting), `DELETE_HIERARCHY_NODE => [ADMIN, PROJECT_LEADER, SUPERVISOR]` (deletingBlock).
DATA: **SUPERVISOR holds `FILTER_EDIT = t`** (`SELECT name, permissions ? 'FILTER_EDIT' FROM roles`) and there are **6 enabled SUPERVISOR users** + **3 enabled ADMIN users**. So a SUPERVISOR who opens Edit Filter, gets the password prompt, and clicks Cancel has a permanently disabled "Processing…" panel until they close and reopen it. That is a real user-facing defect right now.
SEVERITY-IF-REAL: Medium, agrees with filing. Not data-corrupting, but it is a live daily-driver UX break for the 6 SUPERVISORs, on the app's busiest page. Confirms the auditor was right for a reason they did not check (they assumed the gate; the config proves it).
FIX-SKETCH: fix once at the source — have `use-reauth.cancel` invoke the pending `onError` with `{ error: 'REAUTH_CANCELLED' }`. That closes M85 **and M64** and immunizes every current/future `execute()` caller, rather than patching a 9-setter `onCancel` per page.

## M89 — AHU dashboard 'Recent Activity' queries filter events with the AHU id
VERDICT: CONFIRMED-LIVE
EVIDENCE: apps/web/src/routes/filter-management/ahu-dashboard.tsx:55
```ts
const { data: events } = useSWR(id ? `/api/filters/events?filterId=${id}&limit=10` : null);
```
where `id` is the **AHU's** instance id (the route param this page is keyed on — the same `id` used at :58 to fetch `childrenData`, i.e. the AHU's children).
REACHABILITY: the AHU dashboard page renders the panel on every visit.
DATA: **proof that it can never match — every filter event is keyed to a FILTER-kind instance:**
```sql
SELECT at.template_kind, count(*) FROM filter_events fe
JOIN asset_instances ai ON ai.id=fe.filter_id
JOIN asset_templates at ON at.id=ai.template_id GROUP BY 1;
-- FILTER | 5401
```
**One row: FILTER = 5401. Zero AHU-kind rows, zero of any other kind.** So `?filterId=<ahuId>` returns `[]` **100% of the time** — the panel has always rendered "No recent events" and always will. Dead UI masquerading as a feature, exactly as filed.
SEVERITY-IF-REAL: Low-Medium, roughly matches filing. No data harm, but it is a permanently blank panel that silently tells operators an AHU has no activity when its filters may be mid-cycle — mildly misleading on an operational page.
FIX-SKETCH: resolve the AHU's child filter ids server-side via a new `ahuId` param on the events endpoint (mirroring `/cleaning-record`, events-routes.ts:74-81), or remove the panel.

## Chunk 2

# chunk2 verdicts — 25 findings, verified 2026-07-15 (branch RFID, HEAD f09035f)
Method: read cited code + queried `digilog_db` read-only. No test suites run. No source edits.

## M04 — Mirror trigger binds filters to an arbitrary FILTER template (oldest active, version 1)
VERDICT: REFUTED-UNREACHABLE
EVIDENCE: Trigger body is exactly as described — `prisma/migrations/00000000000000_baseline/migration.sql:600-615` (`SELECT id INTO v_tmpl FROM asset_templates WHERE template_kind='FILTER' AND is_active=true ORDER BY created_at ASC LIMIT 1`, `RAISE EXCEPTION` when null). But the auditor's premise — *"the admin UI allows creating templates"* — is **false**. `apps/api/src/modules/assets/routes/template.routes.ts` exposes **only `app.get('/templates')`** (grep for post/put/patch/delete in that file returns nothing; the `POST /api/assets/templates` route was removed in A-01 Phase 1). `assetTemplate.create` exists only in `repositories/template.repository.ts:60` with no route caller — seed-only. A second active FILTER template cannot be created at runtime.
Second sub-claim also refuted: the "trigger-mirrored filter gets no FilterDetails row" scenario doesn't occur — the only writer of the typed table, `assets/services/filter.service.ts:39-63`, creates the `FilterDetails` sidecar inside the *same* transaction as `tx.filter.create()`.
REACHABILITY: Trigger fires only on typed-`filters` writes; sole app writer is `filterService.create/update`, which supplies FilterDetails itself. The wrong-template branch needs ≥2 active FILTER templates — no runtime path creates one.
DATA: `SELECT count(*) FILTER (WHERE is_active) FROM asset_templates WHERE template_kind='FILTER'` → **1**. The ambiguity has no rows to bite on.
SEVERITY-IF-REAL: Would be High (wrong attributeSchema on a regulated record). As filed: **not a defect today** — a documentation gap at worst. Filed as Medium/Large-effort; I'd close it. Fair caveat: it is a real *latent trap* if template-create is ever re-exposed; the `ORDER BY created_at LIMIT 1` deserves a comment, not an effort item.
FIX-SKETCH: n/a

## M07 — No CI pipeline
VERDICT: CONFIRMED-LIVE
EVIDENCE: `ls -la .github/` → only `ISSUE_TEMPLATE/`. No `workflows/` directory exists.
REACHABILITY: n/a — process finding, not a code path.
DATA: n/a
SEVERITY-IF-REAL: **Low-Medium**, below the Medium filing. Factually true and trivially verified, but it is a process gap, not a defect: nothing in the shipped product misbehaves. Note the auditor's own supporting anecdote ("the aedes import break sat unnoticed") argues for the cheap no-DB tier (typecheck + web/shared unit tests) rather than the full windows-latest + PostgreSQL-18 job it proposes.
FIX-SKETCH: `.github/workflows/ci.yml` on windows-latest: build shared+queue, `tsc --noEmit`, `vite build`, web unit tests. Add the DB tier later.

## M10 — RFID Track Record loads entire identifier audit history into memory
VERDICT: CONFIRMED-LIVE (mechanism), scale LATENT
EVIDENCE: `assets/services/identifier.service.ts:107` — `prisma.auditTrail.findMany({ where: { action: { in: ['ASSET_IDENTIFIER_CREATED','ASSET_IDENTIFIER_DELETED'] } }, orderBy: … })` with **no `take`**. Filters (rfid/filterName/ahu/user) applied in memory at `:162-170`; pagination is `enriched.slice(...)` at `:176`. Route schema `identifier.routes.ts:66` really does allow `limit` up to `1_000_000`. Only `from`/`to` reach SQL.
REACHABILITY: RFID Track Record page → `GET /api/assets/identifiers/track-record`. Real user-facing endpoint.
DATA: `SELECT count(*) FROM audit_trail WHERE action LIKE 'ASSET_IDENTIFIER%'` → **706**. A full scan of 706 rows is unnoticeable today.
SEVERITY-IF-REAL: **Low** now, Medium on a multi-year appliance. Below the Medium filing at current data volume. The 2026-07-03 "uncapped per user request" comment (`:174-175`) covers *returning* all rows; the auditor is right that it doesn't justify *fetching* all rows to serve page 1 — but nothing is broken, it's a growth curve.
FIX-SKETCH: Push `rfid`/`user` into the SQL where (JSONB path on before/afterValue); apply skip/take in DB when `limit` is provided.

## M14 — toggle-status can re-activate an archived version → two ACTIVE rows per lineage
VERDICT: CONFIRMED-LATENT
EVIDENCE: `cleaning-profiles/cleaning-profile.service.ts:272-289` — `toggleStatus(ctx, id)` does `getById` then flips `status` on **that row id** with no max-version/lineage-head check. The only guard is on the ARCHIVE direction (counts referencing filter profiles); the ACTIVATE direction is unguarded. Route `routes.ts:188` `PATCH /:id/toggle-status` takes any id.
REACHABILITY: Reachable via API with an archived version's id. The list page (`cleaning-profile-list.tsx:87-88`) only ever toggles lineage heads, so the UI does not trigger it; the version-history surface exposes archived ids, so a hand-rolled/scripted call reaches it.
DATA: `SELECT lineage_id, count(*) FROM filter_cleaning_profiles WHERE status='ACTIVE' GROUP BY 1 HAVING count(*)>1` → **0 rows**. Invariant currently intact. Material exists though: 7 ACTIVE / 44 ARCHIVED, deepest lineage has 13 versions.
SEVERITY-IF-REAL: **Medium** — agrees with the filing. If it ever fires, `filter-resolver`'s firstActive can bind a new cycle to a superseded pipeline (GMP hazard). But it is latent, not live, and requires an operator to deliberately call the API on a non-head id.
FIX-SKETCH: In `toggleStatus`, when `newStatus==='ACTIVE'`, assert the row is `max(version)` for its `lineageId` (409 otherwise), inside the same transaction.

## M18 — POST /api/dashboards/:id/assign: no existence check, no payload validation, no dupe guard
VERDICT: REFUTED-UNREACHABLE
EVIDENCE: The `/api/dashboards` module has **zero frontend callers**. `grep -rn "api/dashboards" apps/web/src` returns only `routes/home/module-flows.ts:376`, which is documentation text, not a call — and it says so explicitly: *"The /api/dashboards module … is feature-complete but parked since 2026-04-30 — no frontend page calls it."* No dashboard page exists to invoke assign/unassign.
REACHABILITY: **No callers.** Only a hand-crafted request to a parked module reaches it.
DATA: not queried — reachability alone decides this.
SEVERITY-IF-REAL: If the module were wired to a UI, the sub-claims are plausibly Low-Medium (a 500-instead-of-404 and dead-row assignments; nothing escalates privilege — `canAccessDashboard` fails closed on a malformed row, which is the safe direction). Filed Medium. This is one of the three findings the auditor burned on a parked module.
FIX-SKETCH: n/a — do not spend effort until a dashboard page exists.

## M22 — setActive bypasses the active-cycle check that DELETE enforces
VERDICT: ALREADY_FIXED
EVIDENCE: `equipment-groups/equipment-groups.service.ts` now carries `assertSafeToDeactivate(tx, group, verb)` whose own docblock states it *"Guards the isActive=false mutation that BOTH `delete()` (a soft delete) and `setActive(ctx, id, false)` perform"*, counting `cleaningCycle … { equipmentGroupId: group.id, status:'IN_PROGRESS' }` → 409 IN_USE. A `lockBlockGroups(tx, blockId)` `SELECT … FOR UPDATE` was added alongside it to close the concurrent-deactivation race on the block-keeps-one-active-group invariant.
REACHABILITY: n/a — matches "equipment-group setActive guard" on the session's already-fixed list; verified present in the tree rather than blind-stamped.
DATA: n/a
SEVERITY-IF-REAL: Was Medium. **Both halves verified closed** (I initially stamped this on the bypass half alone and went back for the rest — the auditor's second claim is the more interesting one and deserved its own check):
- **Half 1, EG_EDIT bypasses EG_DELETE** — closed by `assertSafeToDeactivate` being called from both paths.
- **Half 2, "the guard aims at the wrong cycles"** — also closed, by a mechanism I'd missed. `assertSafeToDeactivate` does **not** only count `equipmentGroupId = group.id`: after the pinned-cycle check it counts `remainingActive` sibling groups in the block and returns early if any survive, then counts `cleaningCycle { cleaningAreaId: blockId, equipmentGroupId: null, status:'IN_PROGRESS' }` → **409 IN_USE** naming the unbound cycles. That is precisely the block-fallback dependent the auditor said was unprotected. The code even matches his reasoning: zero-active is the only breaking count, since `advance()`'s `assertSingleEquipmentGroupPerBlock` rejects only >1 and a lone remaining group simply binds.
- **`setActive(true)` sibling-flip** — deliberately unguarded, and correctly so: the branch ends with exactly one active group in the block, so unbound cycles bind to it and zero-active is unreachable from there. Pinned siblings resolve from the version snapshot regardless of `isActive` — covered by the standing version-pinning design decision.
DATA (added on re-check): `SELECT count(*) FROM cleaning_cycles WHERE status='IN_PROGRESS' AND equipment_group_id IS NULL` → **13** unbound cycles exist, so half 2 was a live hazard, not a hypothetical — which is what makes the guard's unbound-cycle branch load-bearing rather than defensive.

## M25 — PUT /filters/:id with a partial body wipes the attributes JSON
VERDICT: ALREADY_FIXED
EVIDENCE: `assets/services/filter.service.ts:100-116` — a `PARTIAL-UPDATE CONTRACT` block now merges: `const merged = { ...(existing.attributes ?? {}), ...attributes }`, then deletes only keys **explicitly present-and-blank** in the input, and assigns `data.attributes = merged`. The comment narrates the exact bug the auditor described. Regression coverage exists at `services/__tests__/filter.service.test.ts:73-89` (asserting stored attrs survive, blank clears, `lastCleaningDate` handling) plus `e2e/filter-partial-update.test.ts` — read, not run.
REACHABILITY: n/a
DATA: n/a
SEVERITY-IF-REAL: Was High-ish (silent destruction of a 21 CFR record). Correctly filed as Small-effort; the fix that landed matches the auditor's own preferred option.

## M29 — Missing-ID / malformed-UUID → 500 + spurious SYSTEM_ERROR notification
VERDICT: CONFIRMED-LIVE
EVIDENCE: `grep -n "P2025\|P2002\|P2023" apps/api/src/app.ts` → **only `P2002`** (`app.ts:247`, mapped to 409). No P2025 or P2023 handling anywhere in `app.ts` or `lib/`. So `findUniqueOrThrow` in `notification-rules/routes.ts` (GET `/:id`, PUT `/:id/toggle`) and `update`/`delete` on unknown ids fall through to the 500 branch and the SYSTEM_ERROR notification dispatch.
REACHABILITY: Live routes on a wired module. Trigger is any stale id (deleted rule still in an open tab) or a non-UUID `:id`.
DATA: n/a — this is a request-shape defect, no data precondition.
SEVERITY-IF-REAL: **Low-Medium**; agrees with the Medium filing but I'd lean Low. The user-visible harm is a 500 instead of a 404 plus admin-notification noise; nothing corrupts. The systemic fix is genuinely cheap and would cover far more than notification-rules.
FIX-SKETCH: In `app.ts` beside the P2002 block: `P2025 → 404`, `P2023`/`22P02 → 400`. Add `format:'uuid'` to the `:id` param schemas.

## M32 — Notification unit tests call the service with swapped/missing args
VERDICT: CONFIRMED-LIVE (partially superseded)
EVIDENCE: Read `modules/notifications/__tests__/notification.service.test.ts`, did not run it. Signatures (`notification.service.ts`): `list(query, userRole, username)` :113, `getUnreadCount(userRole, username)` :141, `markRead(id, userRole, username)` :147, `markUnread(id, userRole, username)` :155.
- **Still broken**: `getUnreadCount('u1','ADMIN')` (:93) — args swapped, `'u1'` passed as the role. `markRead('n1')` (:~105) and `markUnread('n1')` (:119) — 1 of 3 args, leaving `userRole`/`username` undefined.
- **Already fixed since the audit**: `lib/prisma` **is** now mocked (`vi.mock('../../../lib/prisma.js', …)`, top of file) — the "unit test hits real `system_config`" claim is stale. `list(query, 'ADMIN', 'user-1')` (:55) now passes args in the correct order, and a regression test for the ADMIN null-forRole bug was added with a docblock citing this same 2026-07-13 audit.
REACHABILITY: Test-only. No product code path.
DATA: n/a
SEVERITY-IF-REAL: **Low**. Filed Medium — too high for a test-hygiene defect with no runtime impact. The auditor's strongest argument (that this masked the High ADMIN NOT-null bug) is now moot: that bug is fixed and has a dedicated regression test.
FIX-SKETCH: Correct arg order/arity in the 3 remaining calls; the mocking half needs nothing.

## M35 — http-gateway body template inserts `{message}` via raw string replace
VERDICT: CONFIRMED-LATENT
EVIDENCE: `notification-delivery/channels/sms-channel.ts:169-172` — `body = httpGatewayBodyTemplate.replace(/\{phone\}/g, to).replace(/\{message\}/g, message)`. No JSON escaping, and string-replacement `$`-pattern expansion applies (`$&`, `$'`). The URL path (`:164-165`) does `encodeURIComponent(message)`, which neutralises both hazards for `{message}`-in-URL — the auditor over-claimed there; `{phone}` in both URL and body is still raw.
REACHABILITY: POST-method http-gateway SMS only.
DATA: `SELECT config_value FROM system_config WHERE config_key='notification-sms'` → **`{}`**. SMS delivery is **not configured** — no gateway URL, no body template. Nothing sends today.
SEVERITY-IF-REAL: **Low-Medium** if SMS is ever configured; agrees with Medium then. Today: dormant. Injection ceiling is limited (the attacker controls a message body inside the operator's own outbound gateway request, not a user-facing surface), so "injects extra JSON fields" is the realistic worst case, not a privilege boundary.
FIX-SKETCH: `.replace(/\{message\}/g, () => msg)` (function form kills `$`-expansion) and `JSON.stringify(msg).slice(1,-1)` when substituting into a JSON body.

## M38 — AHU completion gate is O(filters × events)
VERDICT: CONFIRMED-LATENT
EVIDENCE: `filter-operations/ahu-completion-gate.ts:182-187` — `for (const f of all) { … const loaded = await loadLocalContext(f.id, SYSTEM_CTX); finalStageByFilter.set(f.id, computeFinalStageKey(loaded.ctx.profile)); }`. Sequential, per-sibling, and `loadLocalContext` does materialise the cycle's full event list that `computeFinalStageKey` never reads. The described waste is real.
REACHABILITY: Endpoint is genuinely called — `apps/web/src/lib/filter-ops/ahu-completion-check.ts:47` (`GET /api/filters/ahu/:ahuId/completion-status`) and `:99` (the batch variant). **But** the INTERLOCK-mode submit-checklist path the auditor leads with is not active.
DATA: `system_config['ahu-completion-process']` → **`{"mode": "POPUP"}`** — not INTERLOCK. And the loop's real bound: max in-progress filters under any one AHU is **5** (`SELECT ai.parent_id, count(*) … WHERE c.status='IN_PROGRESS' GROUP BY 1 ORDER BY 2 DESC` → 5, 4, 4). The auditor's "an AHU with 30 mid-cycle filters costs ~150 queries" is a hypothetical 6× above observed peak; actual cost is ~25 queries.
SEVERITY-IF-REAL: **Low**, well below the Medium filing. The data bounds the loop to a size where this never surfaces. Worth fixing only if AHU fan-out grows.
FIX-SKETCH: Memoize `finalStageKey` per `cycle.profileId` (one `getProfilePipeline` per distinct profile); drop `loadLocalContext` here — no events are needed.

## M41 — executeReplacement is non-atomic across three separately-committed writes
VERDICT: CONFIRMED-LATENT
EVIDENCE: `replacement-schedule/service.ts:386-392` — `filterOps.replace(ctx, oldFilterId, remarks)` commits its own retire+create transaction, then `prisma.replacementExecution.create({...})` is a **separate** statement, then the entry update is a third. No enclosing `$transaction`. A crash between them strands a physically-replaced filter with no execution row, and `retire()` throws ALREADY_RETIRED on the old filter, so it can never be re-driven.
REACHABILITY: `POST` replacement-execute route, reauth-gated on REPLACE_FILTER. Wired.
DATA: `SELECT count(*) FROM replacement_executions` → **0**. The feature has never been exercised on this install; there is no stranded filter to find, and no `qtyReplaced` divergence exists.
SEVERITY-IF-REAL: **Medium** — agrees with the filing. The unrecoverable-by-design aspect (ALREADY_REPLACED blocks the retry) is what makes it more than a cosmetic window. But the failure needs a crash inside a ~2-statement window on a feature with zero usage, so it is firmly latent.
FIX-SKETCH: Wrap steps (2)+(3) in one `prisma.$transaction`; on bookkeeping failure emit a loud audit event naming the orphaned `newFilterId` for reconciliation.

## M44 — Deviation close accepts ANY completed cycle; My Tasks requires the PM reason
VERDICT: CONFIRMED-LIVE
EVIDENCE: `pm-schedules/pm-deviations.ts:96-106` — `latestCleanMap` groups `cleaningCycle` on `{ filterId: { in }, status:'COMPLETED', completedAt: { gte: since } }`. **No `cleaningReasonKey` filter.** Both consumers read directly (not taken from the auditor's cites): the **OPEN suppression** at :177-178 — `const cleaned = await latestCleanMap(filterIds, entry.windowStart); if (filterIds.every(id => cleaned.has(id))) continue; // fully cleaned → not an open deviation` — and the **CLOSE path** at :212-213 — `const cleaned = await latestCleanMap(filterIds, since); if (!filterIds.every(id => cleaned.has(id))) continue;` before closing. So any completed cycle of any reason both suppresses creation and closes an existing deviation. Contrast `pm-schedules/pm-due-tasks.ts:44-63`, which resolves `pmReasonKeys` from `system_config['filter-cleaning-reasons']` and comments explicitly: *"A clean done with any OTHER reason leaves the task PENDING (it was not the scheduled PM)."* The two subsystems provably disagree. `latestCompleter` (:109-115) has the same omission.
REACHABILITY: Daily deviation sweep (cron 08:30) + manual run. Live.
DATA: Both preconditions hold. A PM reason **is** configured (`system_config['filter-cleaning-reasons']` contains `{"key":"PM","name":"PM"}`), so `enforcePmReason` is true in pm-due-tasks — the divergence is armed, not fallback-masked. And non-PM cleans dominate: completed cycles by reason → **FILTER 310, TEST 79, XXXX 70, PM 76**. ~81% of completed cleans would wrongly satisfy the deviation predicate. 2 OPEN deviations currently exist.
SEVERITY-IF-REAL: **Medium-High** — I rate this **above** its Medium filing and it is the most substantive finding in this chunk. A compliance record (deviations) systematically understates overdue PMs, and it disagrees with the operator-facing My Tasks page, so the two surfaces tell an inspector different stories about whether a scheduled PM happened.
FIX-SKETCH: Extract pm-due-tasks' `pmReasonKeys` resolution into a shared helper; apply `cleaningReasonKey: { in: [...pmReasonKeys] }` in `latestCleanMap`'s where clause (and `latestCompleter`), preserving the no-PM-reason-configured fallback.

## M47 — DELETE /api/roles/:name missing the documented isSystem guard
VERDICT: CONFIRMED-LIVE
EVIDENCE: `roles/role.service.ts` `delete()` (read in full) checks exactly two things — `findByName` → NotFoundError, and `countUsersByRole > 0` → 409 ROLE_HAS_USERS — then calls `roleRepository.delete(name)`. **`existing.isSystem` is never read**, though `update()` in the same file does branch on it (`if (existing.isSystem)` restricts updates to permissions/color/displayName/description). The route's own 403 response schema is therefore dead, as the auditor claims.
REACHABILITY: Live `DELETE /api/roles/:name`. Requires a system role with zero users.
DATA: `SELECT r.name, r.is_system, (SELECT count(*) FROM users u WHERE u.role=r.name) FROM roles r` → all 4 system roles currently have users (ADMIN 4, SUPER_ADMIN 82, SUPERVISOR 6, VIEWER 18), so the user-count guard incidentally blocks every one **today**. An admin can reassign VIEWER's 18 users and then delete it — the guard is circumstantial, not a real barrier. Note: the auditor cites MAINTENANCE as a seeded system role; it does not exist in this DB (the 4 above are the full set) — a minor inaccuracy that doesn't affect the verdict.
SEVERITY-IF-REAL: **Medium** — agrees with the filing. Deleting a system role breaks seed assumptions, `/api/roles/active` dropdowns in config defs, and PM/replacement workflow assignments that store role names as bare strings. It is a two-step operator action, not one click, which caps it below High.
FIX-SKETCH: In `role.service.delete()`, after `findByName`: `if (existing.isSystem) throw new AppError(403, 'SYSTEM_ROLE', 'System roles cannot be deleted');`

## M51 — Disk metrics depend on deprecated wmic, hardcode C:, fail to fabricated zeros
VERDICT: CONFIRMED-LIVE (silent-zero + hardcoded C:); wmic-absence is LATENT
EVIDENCE: `system-health/routes.ts:42-45` — `execAsync('wmic logicaldisk where "DeviceID=\'C:\'" get Size,FreeSpace /format:csv')`. Drive letter is a string literal. `:61-63` is a **bare `catch { return { total:0, used:0, free:0, usagePercent:0 }; }`** — no log, no sentinel, indistinguishable from a healthy 0%-used disk.
REACHABILITY: System Health dashboard endpoint. Live.
DATA: `which wmic` → `/c/WINDOWS/System32/Wbem/wmic`, and the command **succeeds on this machine** (returned FreeSpace 327371706368 / Size 510799114240). So the wmic-missing half is **not live here** — it is a forecast about fresh Win11 24H2+ customer installs (the EXE-packaging target). The hardcoded `C:` and the silent-zero catch are unconditionally real right now.
SEVERITY-IF-REAL: **Medium** — agrees with the filing, and the auditor's reasoning is sound: a monitoring metric that fails to a healthy-looking value is worse than no metric, and disk-full is what kills local PostgreSQL. The wmic deprecation makes this a scheduled failure for the installer product, not a hypothetical.
FIX-SKETCH: Swap the exec for `fs.statfs` (Node 18.15+, works on Windows); derive the drive from `process.cwd()`/config. In the catch: `app.log.warn(err)` and return `usagePercent: null` / `available:false` so the UI shows "unavailable".

## M54 — Profile-photo upload gated on admin permission USER_UPDATE
VERDICT: ALREADY_FIXED
EVIDENCE: `uploads/routes.ts:24-40` — the `requirePermission('USER_UPDATE')` preHandler is gone, replaced by a docblock: *"Deliberately has no permission preHandler: this is self-service by construction — the file is named after the CALLER's own id … It was gated on USER_UPDATE ('Edit Users'), an admin capability that 6 of 8 seeded roles don't hold, so every non-admin got a 403 setting their own photo."* Auth now comes from the global onRequest hook. The fix also anticipated the consequence the auditor didn't mention: widening the caller set widened who can spend disk, so a 30/hour IP-keyed rate limit was added (keyed by IP because @fastify/rate-limit's hook runs before auth populates `req.user`).
REACHABILITY: n/a
DATA: n/a
SEVERITY-IF-REAL: Was Medium (broken self-service for 4-6 of the seeded roles). Verified present in the tree, not blind-stamped from the session list.

## M57 — Password-policy complexity not enforced on admin credential resets
VERDICT: ALREADY_FIXED
EVIDENCE: `users/user.service.ts` — `validatePasswordPolicy` is imported at :5 and now called in all four paths: `create` :111, `unlock` :365, `resetPassword` :391, and `processResetRequest` approve :473. The bare `length < 8` the auditor flagged is gone, with a comment at :471-472 naming it: *"Was a bare `length < 8` check, which ignored the configured policy."*
REACHABILITY: n/a
DATA: n/a
SEVERITY-IF-REAL: Was Medium (21 CFR §11 password-controls consistency). All three cited call sites verified fixed.

## M62 — DRY_OUT stage badge is text-amber-200 on bg-amber-50
VERDICT: CONFIRMED-LIVE
EVIDENCE: `apps/web/src/routes/cleaning-cycles/cycle-detail-view.tsx:30` — `DRY_OUT: 'bg-amber-50 text-amber-200 border-amber-200/40'`, directly beneath `DRY_IN: 'bg-amber-50 text-amber-700 border-amber-200'` (:29). The inconsistency with its own sibling is on the adjacent line, which supports the auditor's read that it's a typo rather than intent. `STORAGE_OUT: 'bg-slate-100/40 text-slate-700 border-slate-200'` (:32) vs `STORAGE_IN: 'bg-slate-100 text-slate-600 border-slate-200'` (:31) — also inconsistent, though slate-700-on-slate-100/40 is still legible, so that half is cosmetic only.
REACHABILITY: Stage progress bar (done state) + every DRY_OUT transition badge in the event timeline. Renders for real users.
DATA: n/a — CSS constant, no data precondition.
SEVERITY-IF-REAL: **Low** (cosmetic/a11y), below the Medium filing — but it is exactly the "unaligned UI element" class the project instructions ask to catch, and the fix is one token.
FIX-SKETCH: `DRY_OUT: 'bg-amber-50 text-amber-700 border-amber-200'` to match DRY_IN; `STORAGE_OUT` → match STORAGE_IN.

## M65 — Delete dialogs claim data is retained / account merely disabled; backend hard-deletes
VERDICT: CONFIRMED-LIVE
EVIDENCE: Frontend `users/components/user-action-dialog.tsx:66` — *"This will permanently **disable** the user account … The user data will be **retained** for audit purposes."* Bulk dialog `user-bulk-delete-dialog.tsx:58` — *"All selected accounts will be permanently **disabled**."* Backend `users/user.repository.ts:110-126` — `delete()` runs `clearUserDeleteBlockers(tx,[id])` then **`tx.user.delete({ where: { id } })`**; `deleteMany()` does the same via `tx.user.deleteMany`. The row is destroyed; only the `audit_trail` entry survives. The dialog text is the opposite of what the code does, in both directions (disable≠delete, retained≠destroyed).
REACHABILITY: Users page single + bulk delete. Live, admin-facing.
DATA: n/a — text-vs-behavior mismatch, no data precondition.
SEVERITY-IF-REAL: **Medium** — agrees with the filing, and I'd argue it's the second-most defensible finding here. Not a code bug, but in a 21 CFR Part 11 system, telling an administrator a record is retained immediately before irreversibly destroying it is a materially misleading consent prompt. Cross-check: this is *not* covered by the "SUPER_ADMIN may edit records / hard-delete authorized" design decisions — those authorize the *behavior*, not the inaccurate description of it.
FIX-SKETCH: Rewrite both warnings: the user record and related data are permanently deleted; only the audit-trail entry (username, role, status snapshot) is retained. Keep the irreversibility warning.

## M70 — Audit search fires one request per keystroke and flashes the full-table spinner
VERDICT: CONFIRMED-LIVE
EVIDENCE: `routes/audit/index.tsx:65` `const [search, setSearch] = useState('')`; `:88` `if (search) params.set('search', search)`; `:98` `useSWR(\`/api/audit?${params}\`)` — raw state straight into the SWR key, **no debounce** (grep for `debounc` in the file: no hits), and no `keepPreviousData`. Each keystroke mints a new key → `data` undefined → `isLoading` → spinner replaces the table.
REACHABILITY: Audit page search box. Live.
DATA: n/a — UI behavior.
SEVERITY-IF-REAL: **Low**, below the Medium filing. Real and reproducible, but it's request churn + flicker on an admin page, not incorrectness. The auditor's supporting point stands and is the useful part: sibling list pages (users/list.tsx, cleaning-cycles/history.tsx) already debounce, so audit is the inconsistent outlier and the pattern to copy is in-repo.
FIX-SKETCH: Debounce `search` ~300ms before it enters the SWR key (copy users/list.tsx); pass `keepPreviousData: true` to the list useSWR.

## M74 — backup.tsx raw fetch discards structured error codes
VERDICT: CONFIRMED-LIVE
EVIDENCE: `routes/config/backup.tsx:118` — inside `reauth.execute('EXPORT_BACKUP', …)`, a raw `fetch(apiUrl(...))` with `if (!response.ok) throw new Error('Export failed')`. The structured body (`{error:'REAUTH_FAILED'}`) is discarded, so `useReauth.confirm()`'s `err.error` discrimination can't fire and the wrong-password case falls to the generic else → dialog closes, "Export failed", no retry. `handleRestore` (:193-198) is worse: a non-ok response (incl. a REAUTH_FAILED 401) is mapped into `setRestoreResult({success:false, …})` rather than thrown, so the reauth flow "succeeds" and closes while the restore silently didn't run.
Partial correction to the auditor: the base-URL half of the claim is **stale** — the call already uses `apiUrl(...)`, not a raw relative path (that's the `getApiBase()` sweep already fixed this session). The error-shape half is untouched and real.
REACHABILITY: Config → Backup, SUPER_ADMIN-facing web page.
DATA: n/a
SEVERITY-IF-REAL: **Low-Medium**; roughly the Medium filing. Confined to one SUPER_ADMIN page, and the auditor concedes the Capacitor impact is theoretical. The restore half is the part that matters — a silently-skipped restore that reports success is worse than the export half.
FIX-SKETCH: `throw await response.json()` so `err.error` survives to `useReauth`; in `handleRestore`, throw on `!response.ok` instead of mapping into `restoreResult` inside the reauth callback.

## M79 — No error state for any SWR fetch on PM schedules
VERDICT: CONFIRMED-LIVE
EVIDENCE: `routes/pm-schedules/index.tsx:206` — `const { data: entriesData, isLoading } = useSWR(...)`, **no `error`**. Same across every other fetch on the page: `pmConfig` :95, `wfConfig` :122, `countsData` :223, `instancesData` :423, `ahuListData` :426. `routes/pm-schedules/detail.tsx:15` — `const { data: schedule, isLoading } = useSWR(...)`, also no `error`, so a fetch failure lands in the `!schedule` branch and renders "No PM schedule exists for {year}".
REACHABILITY: PM Schedules list + detail. Live.
DATA: n/a — error-path rendering, no data precondition.
SEVERITY-IF-REAL: **Medium** — agrees with the filing. The `wfConfig` case is the sharpest: a failed workflow-config fetch silently degrades `isApprover`/`canReview` to the legacy permission path, so a network blip **changes which buttons render** rather than showing an error. That's a step beyond the cosmetic empty-state lie.
FIX-SKETCH: Destructure `error` on the entries + detail SWRs; render an error panel with a `mutate()` retry. For `wfConfig`, treat error as unknown and hide review/approve rather than falling back.

## M82 — Admin-requests fetch failure renders a false "No requests found"; 403 is silent
VERDICT: CONFIRMED-LIVE
EVIDENCE: `routes/admin-requests/index.tsx:65` — `const { data, isLoading } = useSWR('/api/admin-requests', { refreshInterval: 15000 })`, no `error` destructured; `:66` `const allRequests: any[] = data?.data ?? []` → on failure the page falls to the "No requests found / Requests will appear when users submit them" empty state. Same class as M79.
REACHABILITY: Admin Requests page. Live. The auditor's 403 scenario is coherent and worth keeping: permissions are baked into the JWT at login, so a role whose ADMIN_REQUEST_* grant was revoked still passes the client `RequireRole` gate but gets 403 from the backend's live check — and the global SWR handler explicitly suppresses 403 toasts — **verified**, `lib/swr-config.ts:43`: `if (error?.status !== 401 && error?.status !== 403) { _toastError?.(...) }`, so a 403 logs to console and raises nothing in the UI. The admin sees a permanent silent lie. Both links read directly.
DATA: n/a
SEVERITY-IF-REAL: **Low-Medium**, roughly the filing. Same defect class as M79 on a lower-traffic page; the 403-after-revocation path is what lifts it above pure cosmetics.
FIX-SKETCH: Destructure `error`; when `error && !data` render an error state with a Retry calling `mutate('/api/admin-requests')`.

## M87 — Cleaning-profile editor save guard is ineffective; double-click can double-submit
VERDICT: CONFIRMED-LIVE
EVIDENCE: `routes/filter-management/cleaning-profile-editor.tsx:229-256` — `setSaving(true)` (:229), then `reauth.execute(action, async (password) => {...})` (:231) invoked **without `await`**, then `setSaving(false)` (:256) runs synchronously on the next line while the POST/PUT is still in flight (or the password dialog is still open). The inner `finally { setSaving(false) }` (:254) is correct on its own; the trailing outer reset defeats it, exactly as filed.
REACHABILITY: Cleaning Profile editor Save button. Live.
DATA: n/a — race, no data precondition.
SEVERITY-IF-REAL: **Medium** — agrees with the filing, and it's the most consequential of the frontend items. A double-click on `isNew` creates two profiles; on edit it bumps two versions in a lineage whose versioning underpins cycle pinning and audit replay. That's spurious regulated data, not just a UX wart.
FIX-SKETCH: `await reauth.execute(...)` and delete the trailing `setSaving(false)` at :256; rely on the inner `finally`. Also reset `saving` when the reauth dialog is cancelled.

## M90 — filter-list memo chain defeated: filterTemplateIds is a fresh Set every render
VERDICT: CONFIRMED-LIVE (mechanism), impact LATENT
EVIDENCE: `routes/filter-management/filter-list.tsx:219-221` — `const filterTemplateIds = new Set(templates.filter(t => t.templateKind==='FILTER').map(t => t.id));` at component-body scope, **no useMemo**, so a new Set identity every render. It is read inside the `allFilters` useMemo (:242) and the `treeData` memo, which feed `enrichedFilters` and `blockCounts` — a new identity in the dep array invalidates the chain each render, making the memos pure overhead. `blocks`/`instanceMap`/`blockIds` immediately around it (:225-239) *are* memoized, so this is an inconsistency with its own neighbours, not a house style.
REACHABILITY: Filters page, every render (each search keystroke, each panel toggle).
DATA: Not measured. The auditor's "with hundreds/thousands of filters this makes the page visibly janky" is projection, not observation — I did not profile it, and the O(blocks×instances) tree build is cheap at current scale.
SEVERITY-IF-REAL: **Low**, below the Medium filing. The defeated-memo mechanism is unambiguous by inspection; the "visibly janky" consequence is unverified. Fix is one line and removes the inconsistency regardless.
FIX-SKETCH: `const filterTemplateIds = useMemo(() => new Set(templates.filter(t => t.templateKind==='FILTER').map(t => t.id)), [templates]);` (memoize `templates` off `templatesData` too); drop the unused areaTemplateId/ahuTemplateId deps from the treeData memo.

## Chunk 3

# chunk3 verdicts — 24 findings, verified at HEAD f09035f (branch RFID), 2026-07-15

Method: read the cited code + the surrounding path, grepped callers, and queried
`digilog_db` read-only for the LIVE-vs-LATENT discriminator. No test suites run.
No source edits, no commits, no data mutations.

Key site data used throughout:
- 199 active filter instances (template `CWH/AHU-E/01-00`), 376 total; 264 active
  asset_instances overall, 510 total.
- 0 PENDING cleaning_stage_approvals (270 APPROVED, 40 SUPERSEDED).
- 109 asset_identifiers; 11 bound to inactive filters.
- notification-email config = `{"port":587,"enabled":false,"provider":"smtp"}` — no OAuth2 at all.
- 2 OPEN deviations, 0 CLOSED.
- 9 replacement_schedule_entries, 0 replacement_executions, 0 entries with qty_replaced >= qty.

---

## M05 — Integration suite hard-breaks on uninstalled aedes/mqtt imports
VERDICT: CONFIRMED-LIVE
EVIDENCE: `tests/integration/windows-server-stack.test.ts:35-36` — top-level
`import { Aedes } from 'aedes'` / `import mqtt from 'mqtt'`. Neither is in
`apps/api/package.json` or root `package.json`; `ls node_modules/aedes node_modules/mqtt`
→ "No such file or directory". `describe.skipIf(GATED)` at :40 cannot help — module
resolution fails before any describe runs.
REACHABILITY: `vitest.workspace.ts:10` includes `tests/integration/vitest.config.ts`,
so any root-level `npx vitest run` loads this file. The workspace comment
("when the env var is unset its suites register as skipped") is factually wrong.
DATA: n/a — static dependency fact, no DB involvement.
SEVERITY-IF-REAL: Medium, matches the filing. Not a product bug, but it poisons the
root test command, which is exactly how a regression gets normalized as "expected red".
FIX-SKETCH: Delete the file + its `vitest.workspace.ts` entry (it tests three removed
subsystems: MQTT ingest, ts_telemetry, reports PDF — nothing salvageable). Correct the
stale Phase 5.1 note in root CLAUDE.md per the doc-sync rule.

---

## M08 — Non-atomic approval: side effects committed before request marked processed
VERDICT: REFUTED-STALE
EVIDENCE: `apps/api/src/modules/admin-requests/admin-request.service.ts:105-117` now
CLAIMS first: `prisma.adminRequest.updateMany({ where: { id, status: 'PENDING' }, data: { status: newStatus, ... } })`,
`if (claimed.count === 0) throw`. Only then (`:119-131`) does `executeApproval` run, wrapped in
a try/catch that reverts the claim scoped to `{ id, status: newStatus, processedBy: ctx.userId }`.
The in-code comment explicitly documents this as a fix for the exact ordering the auditor describes
("This used to execute first and update after…").
REACHABILITY: n/a — the described ordering no longer exists.
DATA: n/a — model no longer permits the scenario.
SEVERITY-IF-REAL: Would have been Medium. The auditor read a pre-fix shape; the finding is
tagged TOUCHED-since-07-13 and the touch is precisely this. Still not one `$transaction`, but
the filed failure mode (side effect lands, request stays PENDING, re-approvable) is closed by
claim-then-execute + scoped revert. Refuting the mechanism as filed rather than rescuing the
finding with an adjacent concern.

---

## M11 — Invalid query params return 500 INTERNAL_ERROR + SYSTEM_ERROR notification
VERDICT: CONFIRMED-LIVE
EVIDENCE: `apps/api/src/modules/assets/routes/instance.routes.ts:95` calls
`assetQuerySchema.parse(req.query)` (throwing `.parse`, not `.safeParse`).
`packages/shared/src/schemas/assets.ts:253-265`: `page: z.coerce.number().int().min(1).default(1)`,
`limit: …min(1).optional()`, `parentId: z.string().uuid().nullable().optional()`.
The Fastify querystring schema (`:38-49`) declares `page: {type:'integer', default:1}` with no
`minimum`, so `page=0` passes Fastify and dies in Zod. `grep -n "ZodError\|zod" apps/api/src/app.ts`
→ **no matches**: the global handler (app.ts:183-283) maps AppError, OfflineTimeError, 429,
FST_ERR_*, P2002 — nothing for ZodError, so it falls to the `INTERNAL_ERROR` tail at :281 and
fires the SYSTEM_ERROR dispatcher at :256.
REACHABILITY: `GET /api/instances`, gated `ASSET_VIEW`. Any authenticated holder. Same pattern
at `template.routes.ts:89`.
DATA: n/a — input-shape defect, no stored data required.
SEVERITY-IF-REAL: **Low** — I differ from the "Medium" filing. It is a self-inflicted bad
request; nothing corrupts. The real cost is a misleading 500 and SYSTEM_ERROR noise
(rate-limited 1/min at app.ts:255).
The bonus defect is the more interesting half and is **confirmed**: `instance.service.ts:59`
`where.parentId = query.parentId === 'null' ? null : query.parentId` is genuinely dead —
Zod's `.uuid()` rejects the literal string `'null'` first, so root-node filtering is
unreachable via this API.
FIX-SKETCH: `safeParse` → 400 with details (matching the POST/PUT handlers), or add a ZodError
branch to the global handler. Align parentId with the sentinel the service expects:
`z.union([z.literal('null'), z.string().uuid()])`.

---

## M15 — Cleaning-profiles PUT body schema has no stage item schema
VERDICT: CONFIRMED-LIVE
EVIDENCE: POST (`apps/api/src/modules/cleaning-profiles/routes.ts:89-105`) requires
`['name','stages']` with `name: {minLength:1, maxLength:255}`, `flowMode` enum, and typed
stage items. PUT (`:150-165`) declares only `name: {type:'string'}` (no length bounds) and
loose `stages`/`connections` arrays with no item schemas. Unknown `nodeType` reaches the
Prisma `PipelineNodeType` enum inside the versioning transaction → raw
`PrismaClientValidationError`, which the global handler does not map → 500.
REACHABILITY: `PUT /api/filter-cleaning-profiles/:id`, gated `requireAnyPermission('FCP_UPDATE','CP_PAGE_EDIT')` + reauth.
DATA: n/a — the transaction rolls back; no bad rows exist or can persist.
SEVERITY-IF-REAL: **Low** — matches the auditor's own hedge ("transaction rolls back so no
corruption"). Contract-quality issue, not a correctness one: 500 instead of 400, plus schema
drift risk between the two write paths.
FIX-SKETCH: Extract the POST stage/connection item schemas to a shared const in `routes.ts`
and reference it from the PUT body.

---

## M20 — Tablet reads SUPER_ADMIN-only /dynamic/block-change-approval
VERDICT: REFUTED-STALE
EVIDENCE: `apps/api/src/modules/config/static-routes/block-change-approval.routes.ts` exists
and is exactly the auditor's proposed fix — `GET /block-change-approval/current`, no
preHandler, returns `{ mode }` only. Its docblock names the precise bug being refuted:
"Before this route existed both surfaces read the SUPER_ADMIN-gated dynamic route, 403'd for
every other role, and silently defaulted to 'CONFIRM'…". Registered at
`config/routes.ts:32`.
REACHABILITY: Both consumers already point at the mirror —
`apps/web/src/routes/mobile/mobile-operations.tsx:442`
(`useSWR(online ? '/api/config/block-change-approval/current' : null)`) and
`apps/web/src/routes/filter-management/filter-operations.tsx:237`. Note the auditor's cited
path `apps/web/src/routes/mobile-operations.tsx` does not exist — the file is under `routes/mobile/`.
DATA: n/a — model no longer permits the 403.
SEVERITY-IF-REAL: Would have been Medium (the mode=APPROVAL→self-confirm-then-server-reject
half was the sharp end). Both halves are closed. The by-design "offline falls back to CONFIRM"
carve-out is visible in the `online ? … : null` key and is untouched by this.

---

## M23 — Filter-profiles PUT body schema drops every POST constraint
VERDICT: CONFIRMED-LIVE
EVIDENCE: POST (`apps/api/src/modules/filter-profiles/routes.ts:91-103`):
`name {minLength:1,maxLength:255}`, `cleaningProfileId {format:'uuid'}`,
`applicableTemplates {items:{type:'string'}}`, `blockRestriction` enum
`['OWN_BLOCK_ONLY','ANY_BLOCK','SPECIFIC_BLOCKS']`.
PUT (`:120-131`): `name {type:'string'}`, `cleaningProfileId {type:'string'}`,
`applicableTemplates {type:'array'}`, `blockRestriction {type:'string'}` — every constraint
gone. Same unmapped-Prisma-error → 500 path as M15 (no ZodError/PrismaClientValidationError
branch in app.ts).
REACHABILITY: `PUT /api/filter-profiles/:id`, gated `requirePermission('FP_UPDATE')` + reauth
(`UPDATE_FILTER_PROFILE`).
DATA: n/a — inputs rejected downstream; no persisted bad rows found.
SEVERITY-IF-REAL: **Low**, below the Medium filing — with one caveat worth flagging. The
empty-name sub-claim is the only one that *persists* rather than 500s: `name: ''` passes the
unconstrained PUT schema, and `data.name ?? existing.name` keeps `''` (not nullish), renaming
the profile to blank. That is a real (if trivial) data defect, unlike the other four which are
all clean rollbacks. I did not exercise it — this is read from the schema + the `??` semantics.
FIX-SKETCH: Copy the POST property constraints onto the PUT schema; declare `changeNotes`
with a maxLength.

---

## M26 — Typed soft-delete leaves the filter's RFID identifiers assigned
VERDICT: ALREADY_FIXED
EVIDENCE: The auditor cited `filter.service.ts:131` in isolation. Reading the **whole**
`softDelete` (`apps/api/src/modules/assets/services/filter.service.ts:145-205`) shows the
cascade is implemented and in-transaction:
```
const updated = await prisma.$transaction(async (tx) => {
  const f = await tx.filter.update({ where: { id }, data: { isActive: false, ... } });
  const cascadedIdentifiers = await tx.assetIdentifier.findMany({ where: { assetId: id } });
  await tx.assetIdentifier.deleteMany({ where: { assetId: id } });
  for (const ident of cascadedIdentifiers) { await auditLog({ action: 'ASSET_IDENTIFIER_DELETED', ... }) }
```
The header comment states it: "Cascades the RFID identifiers like the legacy
instance.service.softDelete does." It also implements the auditor's exact `afterValue`
suggestion (beforeValue shape matched to `identifier.service.delete()` so the RFID Track
Record report renders). Line 131 is inside `update()`, not `softDelete()` — the auditor's
line ref points at the wrong function.
REACHABILITY: `DELETE /api/hierarchy/filters/:id` → `filterService.softDelete`. Also
newly guarded: it now throws `ConflictError FILTER_CYCLE_IN_PROGRESS` rather than stranding
an IN_PROGRESS cycle.
DATA: 11 asset_identifiers bound to `is_active=false` filters (all filter-template rows).
These are **not** evidence for this finding: `retire()` deliberately does not free identifiers
(`replace()` depends on it — by-design carve-out), and any pre-fix soft-deletes predate the
cascade. Not attributable to the code path as it stands.
SEVERITY-IF-REAL: n/a. Tagged "untouched-since-07-13", but the fix landed upstream of the
finding — the untouched tag tracks the finding, not the code.

---

## M30 — Three divergent notification visibility implementations
VERDICT: CONFIRMED-LIVE
EVIDENCE: List path, non-admin branch —
`apps/api/src/modules/notifications/notification.service.ts:73`: `where.forUserId = username;`
(**forUserId only**). Bulk path, non-admin branch —
`apps/api/src/modules/notifications/notification.repository.ts:144`:
`normal = username ? { OR: [{ forUserId: username }, { targetUserId: username }] } : {};`
(**forUserId OR targetUserId**). The divergence is exactly as filed, and the repository's own
docblock (`:105-107`) claiming the builder "mirrors notification.service.ts buildVisibilityFilter
so bulk-op visibility matches list-visibility byte-for-byte" is false for this branch.
Second half also confirmed: `repository.ts:147` hardcodes
`const GATED = ['PM_SCHEDULE_QNN','GUEST_CLEANING_REQUEST']` while `service.ts:14` derives
`GATED_TYPE_KEYS = Object.keys(GATED_TYPES)` — two sources for one list.
REACHABILITY: `POST /api/notifications/bulk-read` / `/:id/read` (no permission gate) and
bulk-delete (`NOTIFICATION_DELETE`, made a real grantable perm 2026-07-01). Caller must supply
the row's UUID.
DATA: 129 of 897 notifications have `target_user_id IS NOT NULL AND for_role IS NOT NULL` —
the addressing shape the finding depends on genuinely exists at volume (e.g.
`password-expiry-sweep.ts:62` admin notices).
SEVERITY-IF-REAL: **Low**, below the Medium filing, and I agree with the auditor's own hedge.
The rows are unlistable by the subject user and UUIDs are unguessable, so this is not a
practical privilege escalation. The defensible severity comes from the duplicated GATED list
+ the false docblock: a third gated type silently desynchronizes bulk from list.
FIX-SKETCH: Extract one visibility-predicate builder shared by list where-clause, bulk
where-clause, and the row-level assert; decide explicitly that `targetUserId` does not confer
access (per list behavior). Import `GATED_TYPE_KEYS` in the repository.

---

## M33 — PUT /email wipes stored OAuth2 tokens when no masked secret is present
VERDICT: CONFIRMED-LATENT
EVIDENCE: `apps/api/src/modules/notification-delivery/routes.ts:115-129` — the token
preservation loop for `['accessToken','refreshToken','tokenExpiresAt','oauth2Configured']`
(`:122-127`) is nested inside `if (hasMaskedSecret) {` (`:116`). The upsert at `:132-136`
replaces the entire `configValue` with `body`. So when an admin types a real new clientSecret
over the mask (or saves with the secret fields empty), `hasMaskedSecret` is false, the loop
never runs, and the tokens are gone. Code fact is exactly as filed.
REACHABILITY: `PUT /api/notification-delivery/email`, gated `CONFIG_UPDATE` + reauth
(`UPDATE_EMAIL_CONFIG`). Reachable today.
DATA: **This is what makes it latent.** `SELECT config_value FROM system_config WHERE
config_key='notification-email'` → `{"port": 587, "enabled": false, "provider": "smtp"}`.
There are no `accessToken` / `refreshToken` / `tokenExpiresAt` / `oauth2Configured` /
`oauth2PendingState` keys to destroy, email is disabled, and the provider is plain SMTP —
not OAuth2. Nothing to lose until someone configures OAuth2.
SEVERITY-IF-REAL: Medium if OAuth2 is ever configured (silent outbound-email death requiring
a re-authorize); Low today. Filed as Medium — fair as a code fact, but the filing does not
say it is unreachable against current config, and it is.
FIX-SKETCH: Hoist the token-preservation loop out of the `hasMaskedSecret` branch so it always
runs for fields the client omitted; keep only the mask-substitution conditional. Add
`oauth2PendingState`/`oauth2PendingStateAt` to the preserved list.

---

## M36 — OAuth token refresh news up a throwaway PrismaClient and leaks it on error
VERDICT: CONFIRMED-LATENT
EVIDENCE: `apps/api/src/modules/notification-delivery/channels/email-channel.ts:99-111`:
```
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
const dbConfig = await prisma.systemConfig.findUnique(...);
... await prisma.systemConfig.update(...)
await prisma.$disconnect();       // :110 — skipped if either call throws
} catch { /* best effort */ }     // :111 — swallows it
```
All three claims hold: fresh client per refresh (not the `lib/prisma` singleton), `$disconnect`
outside any `finally`, empty catch. The orphaned pool holds connections until process exit.
REACHABILITY: Inside `fetchOAuth2Token`, reached only when `config.oauth2Provider === 'microsoft'`
(the `savedRefresh` branch, `:98`). **Not reachable today**: provider is `"smtp"` and
`enabled: false`, so no OAuth2 path executes at all.
DATA: same query as M33 — no OAuth2 keys in config.
SEVERITY-IF-REAL: Low even when reachable. The leak needs a DB fault *during* a token refresh;
tokens refresh on the order of hourly, not per-request, so "exhausts connections for the whole
API" overstates it. Filed as Medium (performance); I'd call it Low. Still worth the one-line fix.
FIX-SKETCH: `import { prisma } from '../../../lib/prisma.js'` and delete the dynamic import +
`$disconnect` entirely. At minimum move `$disconnect` into a `finally`.

---

## M39 — GET /batch-states fans out a full getCurrentState per filter
VERDICT: CONFIRMED-LIVE
EVIDENCE: `apps/api/src/modules/filter-operations/current-state.ts:97-110` — loads every
active filter, then `chunk.map(f => service.getCurrentState(ctx, f.id, cleaningAreaId))` in
`CHUNK_SIZE = 10` batches. The in-code comment concedes the shape: "Pre-fix sequential loop
was N+1: each getCurrentState does ~10 sequential prisma reads… Chunk size 10 keeps the prisma
pool steady… while cutting total wall time ~10×" — i.e. the 2026-05-05 fix addressed wall time,
not query volume, exactly as the auditor says.
REACHABILITY: **Verified by grep, not assumed** — two real frontend callers:
`apps/web/src/lib/offline-sync-service.ts:142`
(`await apiClient.get<{states,cachedAt}>('/api/filters/batch-states')`, the offline sync warmup)
and `apps/web/src/routes/mobile/mobile-operations.tsx:578` (the tablet operator surface).
Route registered at `apps/api/src/modules/filter-operations/routes.ts:254`, gated `ASSET_READ`,
no rate limit beyond the global 5000/min. This endpoint is on the hot path for every tablet
operator — the opposite of the `/api/dashboards` zero-caller case.
DATA: **199 active filters today** → roughly 2,000–5,000 Prisma reads per warmup call, right
now, on every operator's cache warmup. This is live, not hypothetical — though an order of
magnitude below the auditor's "300-filter site = 5,000–7,000".
SEVERITY-IF-REAL: **Medium**, agreeing with the filing, and the highest-value CONFIRMED in
this chunk — real code, real callers, real data, on the tablet hot path. I could not verify the
"interlock self-heal fires writes/notifications mid-warmup while holding FOR UPDATE locks"
sub-claim to the same standard — I read the batch loop, not the full `getCurrentState` interlock
block at `:156-187`. Treat that aggravating sub-claim as unverified; the N+1 core does not
depend on it.
FIX-SKETCH: Dedicated batch impl — one query per table across all filters (filters+details,
active cycles, distinct profiles, groups/versions, latest approvals, checklist events grouped
by cycle), assembled in memory; keep the per-filter projection identical (locked by the D5
parity test). Or add `?since=` delta support.

---

## M42 — /due uses qty-based deriveStatus while execute//tasks use the all-AHU model
VERDICT: CONFIRMED-LATENT
EVIDENCE: `apps/api/src/modules/replacement-schedule/service.ts:343-350`:
```
function deriveStatus(e: {qty, qtyReplaced, windowStart, windowEnd, status}, today) {
  if (e.qtyReplaced >= e.qty) return 'COMPLETED';
```
versus `ahuReplacementProgress` (`:462-472`) which computes `remaining` from
`activeFilterIdsByAhu(ahuId)` minus the `replacementExecution.newFilterId` set — a genuinely
different completion model. `listDueEntries` (`:416`) filters COMPLETED entries out. The
divergence is real as filed.
REACHABILITY: `GET /api/replacement-schedule/due` (dashboard + `offline-sync-service.ts:222`
warmup) and `listSchedules` (web list) both use `deriveStatus`; the tablet `/tasks` page uses
`deriveTaskStatus`.
DATA: **The bad state does not exist.** 9 `replacement_schedule_entries`, **0** with
`qty_replaced >= qty`, and **0** rows in `replacement_executions` — nothing has ever been
executed against this schedule. The divergence cannot have manifested yet.
SEVERITY-IF-REAL: Medium (a task silently vanishing from the due list while incomplete is a
real compliance-visible defect). Filed as Medium — fair on the code, but the filing reads as
though the divergence is happening; it is not, on this data.
FIX-SKETCH: Derive `/due` + `listSchedules` status from the same AHU-progress computation as
`listTaskEntries` (the batched `activeFilterIdsByAhu` + execution lookup already exists), or
retire `deriveStatus` and demote qty/qtyReplaced to display-only upload-trail columns.

---

## M45 — Unique constraint + swallowed P2002 means a re-overdue task never reopens a deviation
VERDICT: CONFIRMED-LATENT
EVIDENCE: `apps/api/prisma/schema.prisma:1306`:
`pmScheduleEntryId String @unique @map("pm_schedule_entry_id") @db.Uuid` — confirmed UNIQUE,
not merely indexed. `apps/api/src/modules/pm-schedules/pm-deviations.ts:200-202`:
`catch (e:any) { if (e?.code === 'P2002') continue; // deviation already exists for this entry — idempotent`
— confirmed unconditional skip with no status check. So a CLOSED deviation's row blocks a new
one for the same entry, silently: no deviation, no notification, no `DEVIATION_OPENED` audit.
REACHABILITY: The daily deviation sweep (cron 08:30 / manual). Requires an entry to be closed
and then re-overdue — reachable via `editApprovedEntry`/`resubmitEntry` moving the window later.
DATA: **The precondition has never occurred.** `SELECT status, count(*) FROM deviations` →
`OPEN | 2`. Zero CLOSED deviations exist, and `closed_devs WHERE pm_schedule_entry_id IS NOT NULL`
= 0. While a deviation is OPEN the P2002-skip is *correct* (the auditor concedes this). The bug
requires a CLOSED row; there are none.
SEVERITY-IF-REAL: Medium-to-High if it ever fires — a silently missing §11 deviation record with
zero signal is worse than a loud failure. Filed Medium; I'd rate it higher *if reachable*, and
it is the finding in this chunk most worth fixing before the data catches up to it.
FIX-SKETCH: On P2002, load the existing deviation; if CLOSED and its `windowEnd` differs from
the entry's current `windowEnd`, reopen it (reset lifecycle fields, new `notifiedAt` cycle).
Or replace the constraint with `@@unique([pmScheduleEntryId, windowEnd])` so each occurrence
gets its own row.

---

## M48 — Orphaned PENDING approvals are permanently undecidable and accumulate forever
VERDICT: REFUTED-STALE
EVIDENCE: Every load-bearing claim is false at HEAD.
- "the status enum has no CANCELLED/SUPERSEDED value" → `schema.prisma:1856-1864` defines
  `enum CleaningStageApprovalStatus { PENDING APPROVED REJECTED SUPERSEDED }`, with a comment
  describing exactly this orphan case ("Closed WITHOUT a decision… Set lazily by
  stageApprovalService.queue()").
- "grep confirms the only cleaningStageApproval.update calls are the approve/reject paths
  (service.ts:156, :249)" → `grep` finds **three**: `service.ts:138` (the SUPERSEDED close,
  inside `closeOrphan`), `:278`, `:379`.
- "nothing ever closes them" → `stage-approvals/service.ts:117-160` is a dedicated orphan-close
  writing `{ status: 'SUPERSEDED', decidedAt }` plus a `STAGE_APPROVAL_SUPERSEDED` audit row.
  `service.ts:176` documents that `queue()` closes rather than merely hides them. There is a
  regression test: `stage-approvals/__tests__/queue-supersede.test.ts:50`.
REACHABILITY: `queue()` closes orphans lazily on the approver's 30s SWR poll — the same poll the
auditor identified as the accumulation vector is now the drain.
DATA: **The accumulation claim is refuted by the data outright.**
`SELECT status, count(*) FROM cleaning_stage_approvals` → `APPROVED | 270`, `SUPERSEDED | 40`.
`PENDING = 0`. Forty orphans have already been closed by this mechanism; zero are stuck.
SEVERITY-IF-REAL: Would have been Medium. Tagged TOUCHED-since-07-13; the touch is this fix,
and it implements the auditor's own proposed remedy nearly verbatim.

---

## M52 — Filters watermark pagination drops rows when >500 filters match a sync window
VERDICT: CONFIRMED-LATENT
EVIDENCE: `apps/api/src/modules/sync/sync.service.ts:199-202` — predicate is a union:
`where.OR = [{ updatedAt: { gt: filterCutoff } }, { filterDetails: { is: { updatedAt: { gt: filterCutoff } } } }]`.
`:236-237` — `orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }], take: SYNC_PAGE_LIMIT`
(`SYNC_PAGE_LIMIT = 500`, `:38`). So ordering/paging is by `instance.updatedAt` alone while
matching is over the union — the mismatch the finding names is real, and
`apps/web/src/lib/sync-since.ts:86-96` does advance the cursor to the max across both fields.
Note one nuance the auditor missed: `orderBy` *does* have an `{ id: 'asc' }` tie-break, but the
cursor is still a bare `gt` on `updatedAt` with no id component, so the boundary-tie skip
sub-claim survives.
REACHABILITY: Offline hydration via the sync service. **Read-only verification only — I did not
exercise the sync path.** (Offline-sync is a protected surface; nothing here proposes touching it.)
DATA: **199 active filters, 376 total — both below the 500 page limit.** `fetchFilters` never
paginates on this site, so `hasMore` is never true and rows cannot be dropped today.
SEVERITY-IF-REAL: Medium, matching the filing, and it becomes live the moment a site crosses
500 filters — 199 is not comfortably far from that. Permanently-missing offline cache entries
would be a genuinely bad failure (silent, and self-healing only on a full re-hydrate).
FIX-SKETCH: Order/paginate by the effective watermark (`GREATEST(asset_instances.updated_at,
filter_details.updated_at)`) with keyset `(watermark, id)` and `>=` on the boundary; or have
the server return a safe `nextCursor` (min of per-branch maxima) instead of letting the FE take
the max across both.

---

## M55 — Unbounded orphan-file accumulation from photo uploads
VERDICT: CONFIRMED-LIVE (core), with the DoS framing REFUTED-STALE
EVIDENCE: Split the finding — the two halves diverge.
- **DoS half — stale.** `apps/api/src/modules/uploads/routes.ts:43`:
  `config: { rateLimit: { max: 30, timeWindow: '1 hour' } }`. The auditor's "only throttle is the
  global 5000 req/min → ~25 GB/min" is no longer true; a per-route limit was added precisely
  because the USER_UPDATE gate was dropped (`:26-32`, and "photo upload gated on USER_UPDATE"
  is on the already-fixed list). 30 × 5 MB/hr is not a disk-exhaustion vector.
- **Orphan-leak half — confirmed, and the code says so.** `:34-42`: "Nothing here ever unlinks
  a file and there is no quota, so each call permanently costs up to MAX_FILE_SIZE of disk…
  This bounds the surface; **it is not the orphan-file GC, which remains a separate open finding.**"
  Verified independently: no DELETE route in the module; `auth.service.ts:363`
  `if (data.photoUrl !== undefined) updateData.photoUrl = data.photoUrl || null;` overwrites the
  string with no unlink; `grep unlink` over the module and auth.service → no matches.
- **Audit half — confirmed.** `grep -n "auditLog\|audit" apps/api/src/modules/uploads/routes.ts`
  → **no matches**. The file-creation event writes no `audit_trail` row; only the later photoUrl
  profile change is audited.
REACHABILITY: `POST /api/uploads/photo`, any authenticated user, 30/hour.
DATA: n/a — a slow leak (one orphan per photo change), not a stored bad state I can count.
SEVERITY-IF-REAL: **Low**, well below the "performance/DoS" filing. Absent the rate-limit gap
this is disk hygiene, not a denial-of-service. The unaudited file write is the more defensible
point on a §11 system, and even that is minor (the photoUrl change *is* audited).
FIX-SKETCH: On `PUT /api/auth/profile` with a changed photoUrl, unlink the prior file if it sits
under `UPLOADS_ROOT/photos` and its filename prefix matches that user id. Add a graphile-worker
orphan sweep for `photos/` files unreferenced by any `users.photoUrl`.

---

## M58 — Contact-admin UI renders/validates fields the lookup endpoint no longer returns
VERDICT: CONFIRMED-LIVE
EVIDENCE: Both lookup handlers hardcode the dropped fields —
`apps/web/src/routes/auth/contact-admin.tsx:64` and `:122`:
`setLookupUser({ username: data.username, fullName: data.fullName ?? '', email: '', department: null, role: '', roleDisplayName: '', status: '' })`
against a response typed `{ exists, username, fullName }` (the May-16 H1 reduction, acknowledged
in the comment at `:56-59`). Downstream consumers verified live:
- `:169` `const isAlreadyEnabled = requestType === 'UNLOCK' && lookupUser?.status === 'ENABLED'`
  — `status` is always `''`, so this is **permanently false**. Its guards at `:180`
  (`return !!lookupUser && !isAlreadyEnabled`) and `:208`
  (`if (lookupUser && isAlreadyEnabled) missing.push('Account is already enabled…')`) are dead,
  and the `:470` block (`lookupUser.status === 'ENABLED'`) never renders. **The UNLOCK guard is
  defeated — users can file unlock requests for already-enabled accounts.**
- `:459` renders `{lookupUser.roleDisplayName}` and `:463` renders `{lookupUser.status}` → both
  permanently blank in the "Current User Details" panel.
- `:131-137` `currentFieldValue()` returns `lookupUser.roleDisplayName` (= `''`) for `role`, so
  the "must differ from current" check at `:178`/`:202` only functions for `fullName`.
REACHABILITY: `/auth/contact-admin`, the public pre-login request form. Every user hits this.
DATA: n/a — a client-side rendering/validation defect, no stored state.
SEVERITY-IF-REAL: **Low-to-Medium**, roughly matching the Medium filing. The dead UNLOCK guard is
the only sub-claim with real consequence (spurious unlock requests reach admins, who can still
reject them — a UX/noise defect, not a security one); the rest are cosmetic blanks. I verified
4 of the auditor's 5 sub-claims directly; the `:331` verified-requester chip rendering `' · '`
I did not read and am taking on inference from the same `''` fields.
FIX-SKETCH: Prefer honesty over restoration — retype `LookupUser` to the real `{username, fullName}`
so TS flags the drift, then delete the Email/Department/Role/Status cells, `isAlreadyEnabled` and
its branches, the role self-filter, and the "must differ" check for fields with no current value.
If the unlock guard is worth keeping, extend the endpoint to return `status` only.

---

## M63 — SWR errors render as misleading empty states across three cleaning-cycles pages
VERDICT: CONFIRMED-LIVE
EVIDENCE: `grep -n "useSWR"` across the three files — **not one call destructures `error`**:
- `cleaning-cycles/history.tsx:128` `const { data, isLoading } = useSWR(...'/api/filters/cleaning-record?'...)`
  → a 403/500 yields `records.length === 0` with `isLoading` false → "No records found".
- `cleaning-cycles/filter-lifecycle.tsx:154` `const { data: detail } = useSWR(open ? ... : null)`
  → on error `detail` stays undefined and the `!detail` branch spins forever.
  `:392-393` `/api/filters/retirements` + `/replacements` likewise yield silent empty dropdowns.
- `cleaning-cycles/timeline.tsx:28` `const { data: cycle, isLoading } = useSWR(...)` → any error
  renders "Cycle not found".
REACHABILITY: The auditor's reachability argument is the strong part and it holds:
`main.tsx:251` gates the route on ANY-of `[CYCLE_READ, VERSION_HISTORY_VIEW]` and `RequireRole`
uses `.some()`, so a VERSION_HISTORY_VIEW-only user passes the gate and every data call 403s
into a clean-looking empty page. Not hypothetical.
DATA: n/a — client-side error handling; no stored state involved.
SEVERITY-IF-REAL: **Low**, below the filing. Nothing is corrupted or hidden from someone entitled
to it; a user without CYCLE_READ sees an empty page instead of an error. Worth fixing because
"no records" on a §11 record page is an actively misleading statement, not because it is dangerous.
FIX-SKETCH: Destructure `error` from every `useSWR` in the three files and render a distinct
error state (message + retry via `mutate`); branch on `error` before the `!detail` spinner in
`CycleAccordionItem`. Separately reconsider `VERSION_HISTORY_VIEW` in the route gate.

---

## M66 — Users edit page shows an infinite spinner on fetch error
VERDICT: CONFIRMED-LIVE
EVIDENCE: `apps/web/src/routes/users/edit.tsx:67`:
`const { data: userData, mutate } = useSWR(id ? \`/api/users/${id}\` : null);` — no `error`.
`:144-156`: `if (!userData) { return (<div>…<span>Loading user data...</span>…) }`. On any
failure (deleted user, malformed uuid → Fastify 400, permission change mid-session) `userData`
stays undefined permanently and the operator sees a spinner with no recovery but Back.
REACHABILITY: `/users/:id/edit`. Reachable by any user-admin whenever the fetch fails.
DATA: n/a — client-side error handling.
SEVERITY-IF-REAL: **Low**, matching the "Small" effort tag if not the Medium framing. Cosmetic
dead-end; no data at risk.
FIX-SKETCH: Destructure `error` from the `useSWR`; render an error card with a "Back to Users"
action when set, and keep the spinner for `!userData && !error`.

---

## M72 — Redacted audit rows are indistinguishable from live rows
VERDICT: CONFIRMED-LIVE
EVIDENCE: `grep -rn "redactedAt\|redactionReason\|redacted" apps/web/src/routes/audit/` returns
**three hits, none of them a render**: `index.tsx:129` (a comment — "REDACT preserves checksum +
chain link, NULLs the payload, stamps redactedAt/By"), `:154` and `:178` (toast error strings).
The auditor's grep claim is exactly right: the frontend never reads `redactedAt`/`redactionReason`.
Backend counterpart at `apps/api/src/modules/audit/routes.ts:461-469` does NULL before/after and
stamp the fields. So a redacted record renders as a normal one with a degraded summary built from
empty before/after; no badge in table or detail modal; the redact button still shows, and a second
click round-trips prompt + reauth to a 409 ALREADY_REDACTED that lands in `console.error` only.
REACHABILITY: `/audit` page, `AUDIT_READ`. Every redacted row today.
DATA: **LIVE, confirmed by query.** `SELECT count(*) FROM audit_trail WHERE redacted_at IS NOT NULL`
→ **3** (of 17,044 total). Three redacted §11 records exist in the live audit trail *right now*
and every one of them renders in the UI as an ordinary row — no badge, no reason, no redactor,
and the redact button still offered on each. This is not latent.
SEVERITY-IF-REAL: **Medium**, matching the filing, and the most defensible non-performance
CONFIRMED here on a §11 system: an inspector cannot see from the UI that a record's payload was
redacted, by whom, or why. That is the entire point of chain-preserving redaction over deletion.
FIX-SKETCH: Render a distinct "Redacted" badge/row style when `record.redactedAt` is set (confirm
the list endpoint selects the field; add it if not), show `redactedBy`/`redactionReason` in
`AuditDetailModal`, and hide/disable the redact affordance for already-redacted rows.

---

## M76 — Filter Data Management delegation via Configuration Access is dead
VERDICT: CONFIRMED-LIVE
EVIDENCE: All three contradicting layers verified.
1. `apps/web/src/routes/config/index.tsx:307`:
   `const EXPLICIT_GRANT_KEYS = new Set(['filter-data-management']);` with the comment "Filter
   Data Management edits/deletes filter records, so it's the one card admins can hand off explicitly."
2. `apps/web/src/routes/config/filter-data-management.tsx:338`:
   `if (user?.role !== 'SUPER_ADMIN') { return (… 'Access Restricted' …) }` — a hard return for
   any non-SA, regardless of grant.
3. `apps/web/src/routes/config/access-matrix.tsx:28` lists `'block-change-approval'` etc. in the
   grantable set; the module is injected as a grantable row per the finding.
So a granted role is shown a Super Admin Settings section containing exactly one card that leads
to a hard block.
REACHABILITY: `/config` for any role granted `filter-data-management` via Configuration Access.
Whether any role holds that grant today I did not query — the contradiction is structural regardless.
SEVERITY-IF-REAL: **Low**, matching the Small effort tag. It fails *closed* (misleading UX, not a
privilege leak — the page and every `super-admin/routes.ts` endpoint stay SA-only). Note this sits
adjacent to the by-design carve-out "SUPER_ADMIN may edit records incl. audit fields via Filter Data
Management (authorized)" — that carve-out authorizes SA access; it says nothing about delegation,
so this finding is not covered by it.
FIX-SKETCH: Pick one and make the layers agree. Cheapest honest option: drop
`'filter-data-management'` from `EXPLICIT_GRANT_KEYS` and `EXTRA_MODULES`, making it truthfully
SA-only. (Real delegation would mean relaxing the page gate to the access-matrix check *and*
re-gating every `super-admin/routes.ts` preHandler — much larger, and arguably undesirable given
the §11 authorization above.)

---

## M80 — Orphaned route: /pm-schedules/:entityId has no inbound navigation
VERDICT: CONFIRMED-LIVE
EVIDENCE: `grep -rn "pm-schedules/" apps/web/src` — every hit is an API path
(`/api/pm-schedules/due`, `/ahu-configs`, `/deviations`, `/qnn/visible`), a test fixture, a
comment, or the route plumbing itself: `main.tsx:78` (the lazy import) and `main.tsx:261` (the
`<Route path="/pm-schedules/:entityId">`). **No `Link`, `navigate()`, or `href` targets it.**
`detail.tsx:11-15` confirms the page reads `useParams<{entityId}>` and fetches
`/api/pm-schedules/${entityId}?year=${year}` — reachable only by hand-typed URL.
`filter-data-management.tsx:56,228,303,1053` reference it only in comments ("mirrors
/pm-schedules/:id detail page card grid") — it mirrors the layout, it does not import it, so the
pre-deletion rule's dependency check is clean.
REACHABILITY: **No callers — and here that *is* the finding.** Not applying the
"unreachable ⇒ refuted" heuristic: the claim is precisely the unreachability, so zero inbound
navigation confirms rather than refutes.
DATA: n/a — a navigation-graph fact.
SEVERITY-IF-REAL: **Low**, matching the filing. Either dead UI or a missing affordance; the
per-AHU monthly card view and its Start-PM entry point are invisible, and Start PM is presumably
happening via My Tasks.
FIX-SKETCH: Decide, don't split the difference: (a) link the AHU name at `index.tsx:790` to
`/pm-schedules/${entry.ahuId}` (matches the `:entityId` param the detail fetch expects), or
(b) delete `detail.tsx` + `main.tsx:78,261` if My Tasks supersedes it.

---

## M83 — Admin-requests overlays and rows have no accessible semantics
VERDICT: CONFIRMED-LIVE
EVIDENCE: `grep -n 'role="dialog"\|aria-modal\|onKeyDown\|tabIndex\|aria-label\|Escape'
apps/web/src/routes/admin-requests/index.tsx` → **zero matches in the entire file.** That single
grep confirms most of the filing at once: no dialog role, no aria-modal, no focus trap, no Escape
handler, no keyboard handlers, no aria-labels anywhere.
Rows confirmed mouse-only at `:284`:
`<tr key={req.id} className="… cursor-pointer" onClick={() => { setSelectedRequest(req); … }}>`
— no `tabIndex`, no `role`, no `onKeyDown`. Keyboard users cannot open any request at all.
REACHABILITY: `/admin-requests`, the admin approval queue. Live for every keyboard/AT user.
DATA: n/a — a markup fact.
SEVERITY-IF-REAL: **Medium**, matching the filing — the strongest of the UI findings, because it
is a total functional block (not a degraded experience) for keyboard-only operators on an approval
workflow, and the codebase already ships a shared `ui/dialog.tsx` with Escape handling that this
page simply does not use.
FIX-SKETCH: Reuse the shared `Dialog` for the result dialog; give the slide-over
`role="dialog" aria-modal="true"` + aria-label, an Escape keydown handler, and focus-on-open.
Make the Review/View span a real `<button>` (or `tr role="button" tabIndex={0}` + Enter/Space).
Add the close-button aria-label, `aria-pressed` on stat filters, and scope handling for the empty `<th>`.

---

## M88 — Cleaning-profile search only searches the currently loaded page
VERDICT: CONFIRMED-LIVE
EVIDENCE: `apps/web/src/routes/filter-management/cleaning-profile-list.tsx:43`:
`const swrKey = \`/api/filter-cleaning-profiles?page=${page}&limit=${perPage}&status=${status}\`;`
— server-paginated, and the search term is **not** in the key. `:97-99`:
`const profiles = (data?.data ?? []).filter(p => !search || p.name.toLowerCase().includes(search.toLowerCase()));`
— filters only the current page's rows, in memory. A profile on page 2 is unfindable from page 1,
and the empty state claims "No profiles match your search".
Stat cards confirmed at `:133` `{profiles.reduce((s,p) => s + p.stageCount, 0)}` labelled
"Total Stages" and `:144` `{profiles.reduce((s,p) => s + p.connectionCount, 0)}` labelled
"Connections" — both computed from the filtered current page, presented as global totals.
REACHABILITY: `/filter-management/cleaning-profiles`, any role that can view cleaning profiles.
DATA: n/a — depends on profile count exceeding one page; I did not count profiles, so the
practical bite is unmeasured. The code fact is unconditional.
SEVERITY-IF-REAL: **Low**, matching the Small tag. Cosmetic-to-annoying; no data at risk.
FIX-SKETCH: Pass the search term to the server (`&search=` if supported, else fetch with a high
limit for the search case); label the stat cards "this page" or source them from a totals endpoint.

---

# Summary

| ID | Verdict | Severity (mine) |
|----|---------|-----------------|
| M05 | CONFIRMED-LIVE | Medium |
| M08 | REFUTED-STALE | — |
| M11 | CONFIRMED-LIVE | Low (filed Medium) |
| M15 | CONFIRMED-LIVE | Low (filed Medium) |
| M20 | REFUTED-STALE | — |
| M23 | CONFIRMED-LIVE | Low (filed Medium) |
| M26 | ALREADY_FIXED | — |
| M30 | CONFIRMED-LIVE | Low (filed Medium) |
| M33 | CONFIRMED-LATENT | Medium if OAuth2 configured; Low today |
| M36 | CONFIRMED-LATENT | Low (filed Medium) |
| M39 | CONFIRMED-LIVE | Medium |
| M42 | CONFIRMED-LATENT | Medium |
| M45 | CONFIRMED-LATENT | Medium-High if reachable |
| M48 | REFUTED-STALE | — |
| M52 | CONFIRMED-LATENT | Medium |
| M55 | CONFIRMED-LIVE (core) / REFUTED-STALE (DoS framing) | Low |
| M58 | CONFIRMED-LIVE | Low-Medium |
| M63 | CONFIRMED-LIVE | Low (filed Medium) |
| M66 | CONFIRMED-LIVE | Low |
| M72 | CONFIRMED-LIVE | Medium |
| M76 | CONFIRMED-LIVE | Low |
| M80 | CONFIRMED-LIVE | Low |
| M83 | CONFIRMED-LIVE | Medium |
| M88 | CONFIRMED-LIVE | Low |

Tally: 14 CONFIRMED-LIVE (1 partial), 5 CONFIRMED-LATENT, 3 REFUTED-STALE, 1 ALREADY_FIXED.
Refute/already-fixed rate 4/24 ≈ 17% — consistent with the ~20% prior. Of the 14 LIVE, only
4 rate Medium; the auditor systematically over-rated input-validation and UI-error findings by
reasoning from code shape without asking what the failure actually costs.

## Sub-claims I could NOT verify (carried, not stamped)
- **M39** — the "interlock self-heal fires writes/notifications mid-warmup while holding
  FOR UPDATE locks that contend with live operator advances" sub-claim. I read the batch loop
  (`current-state.ts:97-110`), not the interlock block at `:156-187`. The N+1 core is confirmed;
  this aggravating factor is not.
- **M76** — did not query whether any role currently holds the `filter-data-management`
  Configuration Access grant. The three-layer contradiction is structural and confirmed regardless.
- **M23** — the empty-name persistence path (`name: ''` surviving `data.name ?? existing.name`)
  is read from schema + `??` semantics, not exercised.
- **M58** — 4 of 5 sub-claims read directly; the `:331` verified-requester chip is inferred from
  the same always-`''` fields.

