# Code Review — API Supporting Modules (2026-05-04)

**Branch:** `feature/phase5-verification`
**Worktree:** `.worktrees/phase5-verification`
**Reviewer scope:** `apps/api/src/modules/{config,reports,sync,data-ingestion,roles,backup}`, `apps/api/src/lib/{sanitize,reauth-check,idempotency,audit,hash-chain,config-discovery,config-registry}`, `apps/api/src/plugins/{auth,rbac,audit-logger}`, plus the decision-tape generator surface (`modules/filter-operations/tape/`, `packages/shared/src/pipeline-executor/`).

A handful of in-scope items were out of repo (Mosquitto MQTT plugins, multipart plugin, error plugin) — see *Out of scope / not present*.

---

## Critical (must fix)

### C1. `enforceReauth` is bypassable by any authenticated client
**File:** `apps/api/src/lib/reauth-check.ts:99-101`

```ts
if (req.headers['x-offline-replay'] === 'true') return { ok: true };
```

The header is read off the request with no provenance check. Any logged-in user can attach `x-offline-replay: true` from a desktop browser request and the entire dynamic re-auth policy is skipped — including the hardcoded `requiresReauth: true` configs that route through `enforceReauth` (e.g. `START_CLEANING_CYCLE`, `EXPORT_BACKUP`, `RESTORE_BACKUP`, `DELETE_REPORT`, `SIGN_REPORT`, `REJECT_REPORT`, `GENERATE_REPORT`, `UPDATE_PASSWORD_POLICY`, `UPDATE_LOGIN_SECURITY`, `UPDATE_SESSION_CONFIG`, `UPDATE_DATETIME_CONFIG`).

This is the entire reauth posture defeated by one curl flag. There's no JWT claim, signed device token, or sync-engine-only role gate behind the bypass.

**Fix:** require a server-issued `offline-replay` JWT claim or an offline-sync-only auth scope. Minimum acceptable: scope the bypass to a dedicated role (`OFFLINE_SYNC` service account) and verify `req.user.role` matches. The current "any role gets the bypass" is not defensible.

### C2. `offlinePerformedAt` is unbounded — operators can back-date or future-date events
**Files:** `apps/api/src/modules/filter-operations/cycle-write/start-cycle.ts:34`, `advance.ts:28`, `submit-checklist.ts:38, 141`

```ts
const offlineTime = data.offlinePerformedAt ? new Date(data.offlinePerformedAt) : undefined;
```

No validation that `offlinePerformedAt` is in the past, that it falls within a plausible offline-replay window (e.g. ≤72 h ago), or that the value isn't NaN. Combined with C1, an authenticated user can:

1. Send `x-offline-replay: true` (skip reauth).
2. Submit a checklist with `offlinePerformedAt: '2024-01-01T00:00:00Z'` or `'2099-12-31'`.
3. The event is persisted with the attacker-supplied timestamp inside `attributes.offlinePerformedAt` and that value is then surfaced in audits and filter-history UIs.

For 21 CFR Part 11 §11.10(e) compliance the timestamp on a record must be reliable. This isn't.

**Fix:** server must clamp `offlinePerformedAt` to `[now - syncMaxAgeHours, now]` and reject values outside that range with `400 INVALID_OFFLINE_TIMESTAMP`. Pull `syncMaxAgeHours` from a config def (probably under `session` or a new `offline-sync` def). Surfaces both a hard guarantee and an audit footprint when clients try to abuse it.

### C3. Audit "hash chain" is per-row, not chained — deletes/reorders are undetectable
**File:** `apps/api/src/lib/hash-chain.ts:1-35`

`computeChecksum()` hashes only the row's own fields; `verifyAuditChecksum()` recomputes from the same row's own fields. There is no `previousChecksum` linkage between row N and row N-1 — the file name "hash-chain" is misleading. Anyone with DB write access can:

- Delete an audit row → integrity check still passes for every remaining row.
- Reorder rows → integrity check passes.
- Insert a fabricated row with a correctly-computed self-checksum → integrity check passes.

The schema doesn't have a `previous_checksum` column either:

```bash
grep -E "previous_?checksum|chainHash" apps/api/prisma/schema.prisma
# → no matches
```

This is the central 21 CFR Part 11 audit-trail invariant. The CHANGELOG and module docstrings claim "SHA-256 hash-chained" but the code does not chain.

**Fix:** add `previousChecksum String?` to `AuditTrail`, write the previous row's checksum into each new row inside the same transaction (advisory lock or `SELECT ... ORDER BY id DESC LIMIT 1 FOR UPDATE`), and have verifier walk the chain. Document the resulting append-only invariant explicitly. Until then, the compliance posture in marketing/docs is overstated.

### C4. Reports — no entity-level authorization on `entitySlots`
**Files:** `apps/api/src/modules/reports/routes.ts:16-38`, `service.ts:48`, `data-sources/{telemetry,attribute,identifier}-source.ts`

`POST /api/reports/generate` accepts an arbitrary `entitySlots: Record<string, string>` mapping any slot name to any `assetInstance.id`. The data sources read `ctx.entitySlots[slotName]` directly and execute `SELECT … WHERE entity_id = $1` against TSDB / Prisma without checking whether the calling user is permitted to read that entity. A user with the `REPORT_GENERATE` permission can synthesize a templateId + slot map that targets ANY entity in the system and exfiltrate its telemetry / attributes / identifiers via the resulting PDF.

**Fix:** per-entity ACL check inside `service.generate`: load each entityId, verify `requirePermission('ASSET_READ')` semantics (or a dedicated `REPORT_READ_<KIND>`) for every slot value, fail with `403 FORBIDDEN_ENTITY` listing the offending slots. Same for any future `getById`/`getPdfPath` paths that don't already check ownership.

### C5. Reports — `getPdfPath`/`/:id/pdf` and `/:id/preview` don't authorize report ownership
**Files:** `apps/api/src/modules/reports/service.ts:151-164`, `routes.ts:57-79`

`getPdfPath(id)` only checks that the row exists and the file is on disk; the route only checks `REPORT_EXPORT` / `REPORT_VIEW`. Any user with that permission can pull every other user's reports by guessing UUIDs (UUIDv4 is hard to guess but the model is wrong — there's no enumeration protection at the ID generator level either). Combined with C4, this leaks data.

**Fix:** `service.getById` / `getPdfPath` should accept `ctx` and add `where: { id, OR: [{ generatedBy: ctx.userSub }, { signatures: { some: { userId: ctx.userSub } } }] }` plus a SUPER_ADMIN bypass. Or define an explicit `REPORT_VIEW_ALL` permission and require that for cross-user access.

---

## High

### H1. `findExistingByClientOpId` is unindexed JSON-path scan over `FilterEvent`
**File:** `apps/api/src/lib/idempotency.ts:43-51`

```ts
prisma.filterEvent.findFirst({
  where: { filterId, attributes: { path: ['clientOpId'], equals: clientOpId }, ... }
});
```

`grep "clientOpId\|client_op_id" apps/api/prisma/migrations/*/migration.sql` returns no index. Every offline replay → sequential scan over `FilterEvent` filtered by `filterId` (FK index) + JSONB path equality. Once `FilterEvent` grows past a few million rows (it's the largest write-heavy table on the system) every replay does a partial index scan + filter, ballooning latency to seconds. Worse, this fires on every advance/submit-checklist/start-cycle even for *online* clients that supply a `clientOpId`.

**Fix:** either (a) promote `clientOpId` to a real column on `FilterEvent` with a partial unique index `WHERE client_op_id IS NOT NULL`, or (b) add a generated column `client_op_id text GENERATED ALWAYS AS (attributes->>'clientOpId') STORED` and a partial index on it. Either way, the replay query becomes `O(log n)`.

### H2. `start-cycle` idempotency check is not cycle-scoped — clientOpId reuse across cycles short-circuits
**File:** `apps/api/src/modules/filter-operations/cycle-write/start-cycle.ts:38`

```ts
if (clientOpId && await findExistingByClientOpId(filterId, clientOpId)) {
  return service.getCurrentState(ctx, filterId);
}
```

`findExistingByClientOpId` accepts an optional `cycleId` param (per its docstring at `idempotency.ts:30-37`) but the call here passes nothing → matches FilterEvent rows from ANY past cycle. If a tablet's IndexedDB reuses a `clientOpId` (e.g. user replays a queued operation that originally completed last week, or there's a UUID collision after a tablet wipe-and-restore), the start-cycle silently no-ops and returns "current state" for whatever cycle is actually in progress (or none). The legitimate new cycle never starts. Operator doesn't realize.

**Fix:** for `startCycle`, the dedup must be scoped to "this filter + this clientOpId AND `attributes.event = 'CYCLE_STARTED'`" — the existence of any random advance/checklist event from years ago shouldn't suppress a fresh cycle start. Better: add an explicit `idempotency_key` table per (filterId, clientOpId, eventKind) with a unique constraint and let Postgres enforce it.

### H3. Backup checksum verification is bypassable — SQL/CSV formats skip checksum
**File:** `apps/api/src/modules/backup/backup.service.ts:528-541`

```ts
const fmt = backup.metadata.format ?? 'json';
if (fmt === 'json' || fmt === 'bak') {
  if (!backup.metadata.checksum) throw …
  if (computedChecksum !== backup.metadata.checksum) throw …
}
```

A malicious actor crafts `metadata.format = 'sql'` (the `format` is read from inside the same backup file the attacker controls) and the checksum check is skipped entirely. The restore then proceeds with attacker-controlled data. This defeats the integrity claim in the operator-facing description ("Validates checksum before restoring").

**Fix:** treat checksum as mandatory for ALL formats. SQL exports already record metadata in the SQL header — embed a checksum line `-- Checksum: <sha256>` and verify it. CSV ZIP exports already have `_metadata.json` — require the checksum field there. Don't trust the format declaration written by the same untrusted file.

### H4. Backup restore loads entire file into memory; no row-count or bytes ceiling
**Files:** `apps/api/src/modules/backup/routes.ts:85-94, 91-93, 136-145`

```ts
const file = await req.file({ limits: { fileSize: 100 * 1024 * 1024 } });
const chunks: Buffer[] = [];
for await (const chunk of file.file) { chunks.push(chunk); }
const rawBuffer = Buffer.concat(chunks);
```

100 MB is fine for current customers but an attacker uploading a 99 MB backup with `metadata.format='json'` causes `JSON.parse` of 99 MB → V8 string-as-buffer copies → easy to OOM the API node. The 300-second transaction timeout on `restoreFromBackup` (`backup.repository.ts:183`) lets a single attacker tie up a connection AND consume all memory. A handful of concurrent requests = denial-of-service.

**Fix:** stream-parse the backup (newline-delimited JSON or true SQL streaming) and reject more than N rows per table; lower the multipart limit to whatever the largest legitimate backup actually is (you can compute this — the live DB is sized in the docs); rate-limit restore to 1 in-flight per node.

### H5. Backup restore disables audit-trail triggers — and the hash chain (such as it is) is not re-validated post-restore
**File:** `apps/api/src/modules/backup/backup.repository.ts:147-152, 180-182`

The restore path disables `audit_trail_no_update` and `audit_trail_no_delete` triggers, runs `TRUNCATE … CASCADE` on the audit_trail table, re-inserts the backup's audit rows verbatim (including their stored `checksum` values from the original DB), then re-enables the triggers. There's no integrity verification of the restored rows. Combined with C3 (no chain), an attacker who controls the backup file can rewrite the audit history to anything they want (forge user actions, delete adverse events) — and unless an operator manually reruns checksum-verify on every row afterward, nothing detects it.

**Fix:** post-restore, run a verification pass that recomputes every audit row's checksum and produces a discrepancy report. Refuse to bring the system online if discrepancies exist. Or — better — sign the entire backup with a server-only key and refuse to import unsigned/wrong-signature backups.

### H6. Reports — Puppeteer browser is a single global with a race on the first render and no health check
**File:** `apps/api/src/modules/reports/renderers/pdf-renderer.ts:4-15`

```ts
let browser: Browser | null = null;
async function getBrowser(): Promise<Browser> {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({ … });
  }
  return browser;
}
```

Two concurrent `generate()` calls on a cold start both see `browser === null` and both launch a Chromium process. The second-to-finish overwrites `browser`; the first orphan keeps running until the process is killed. Each leaked Chromium = ~150 MB RAM. Under sustained concurrent load the server fills up.

Worse: if the Chromium process dies (OS OOM-killer, antivirus, manual `taskkill`), `browser.connected` returns false the next call — but if a `page.pdf()` is currently in flight against the dead browser it throws an `Error: Target closed`, surfaces to the caller as a generic 500, and the next call relaunches fine. Hard to debug in prod when "PDF rendering randomly fails."

**Fix:** wrap launch in a once-only async-mutex (or a top-level `browserPromise = puppeteer.launch(...)` cached at module load with explicit "rebuild on disconnect" semantics). Add an explicit health-check on `browser.process()` and reject with `503 PDF_RENDERER_UNAVAILABLE` when in failed state. Consider a bounded page pool (`p-queue` of N=2..4) to avoid Chromium memory blowups under bursty load.

### H7. Reports — orphaned PDFs leak when the audit log fails after disk write
**File:** `apps/api/src/modules/reports/service.ts:71-92`

`fs.writeFile(pdfPath, pdfBuffer)` happens BEFORE `prisma.reportInstance.create`. If the DB insert throws (constraint violation, connection drop, schema drift), the PDF file is on disk forever with no DB row referring to it. Same problem at delete time — `fs.unlink` runs, then `prisma.reportInstance.delete` could fail, leaving an orphaned DB row pointing at a missing file.

**Fix:** generate the report instance row first with a placeholder path, write the PDF inside the transaction, update the row to mark `READY` only after both succeed. Or write to a temp path and rename atomically into a path keyed by the persisted `report.id` only after `create` succeeds. Add a periodic job that scans `uploads/reports/` and deletes files with no matching `reportInstance` row.

### H8a. `assertTapeVersionFresh` returns `ok: true` when client omits `tapeVersion` — schema is the only fence
**File:** `packages/shared/src/pipeline-executor/transitions.ts:214-233`

```ts
export function assertTapeVersionFresh(ctx, submittedTapeVersion) {
  if (submittedTapeVersion === undefined || submittedTapeVersion === null) {
    return { ok: true };
  }
  …
}
```

The "non-check for backwards compat with pre-8.4 callers" comment relies on the route schema requiring `tapeVersion`. Today all four mutation routes do mark it required (`routes.ts:185, 251, 315, 466`), so a client that drops the field is rejected by Fastify's JSON-schema layer before reaching the executor — fine. But this means the executor's only enforcement is "trust the route schema." Any new mutation route added later that calls into `assertTapeVersionFresh` without `required: ['tapeVersion']` (or any direct executor invocation outside an HTTP route — e.g. internal tooling, batch scripts, future RPC handlers) silently passes the staleness guard.

In adversarial terms: the executor pretends to enforce a server-side invariant but actually delegates to a per-route schema declaration that any contributor can forget. The "backwards compat" doc justifies the leniency for old callers, but post-Phase 8.7 cutover there are no old callers — that branch is dead code that introduces a real footgun.

**Fix:** at the executor level, return `STALE_TAPE` (or `MISSING_TAPE_VERSION`) when `submittedTapeVersion` is null/undefined. Phase 8.7 notes (in `routes.ts:87-92`) explicitly mark this as the "decision-tape architecture cutover" — back-compat for pre-8.4 should be removed in the same pass.

### H8b. Decision-tape `tapeVersion = profileVersion * 1e6 + filterEventCount` aliases at >1e6 events per cycle
**File:** `packages/shared/src/pipeline-executor/actions.ts:93-98`

The cap is 1e6 events per cycle. A cycle with ≥1,000,000 events alongside a profile bump aliases to a previous version. The test suite verifies non-aliasing only up to 1000 events (`tape-generator.test.ts:500-501`). For normal cleaning cycles event counts are tiny — but the cap is an undocumented invariant. If a future feature spams events (telemetry-driven micro-events, automated quality readings every second), the staleness guard silently fails: client thinks tape is fresh, server accepts a write that should have been rejected.

The function also returns `0` for `(undefined, undefined)` per its own tests, so a buggy caller passing `null/undefined` versions all collapse to one slot.

**Fix:** either document and enforce the 1e6 cap (reject any cycle whose `filterEventCount > 1e6` with a 500 + alarm), or switch to a structurally collision-free encoding (e.g. `(profileVersion << 24) | filterEventCount` with bit-width assertions, or just `${profileVersion}.${filterEventCount}` as a string). The test at line 500-501 creates a misleading sense of safety — the boundary case at exactly `1_000_000` events is never tested.

### H9. Config auto-discovery silently skips 3 def files
**File:** `apps/api/src/lib/config-discovery.ts:13-42`

There are 30 `.def.ts` files in `apps/api/src/modules/config/defs/` (verified with `ls apps/api/src/modules/config/defs/*.def.ts | wc -l → 30`) but only 27 are imported. Missing:

- `dashboard-cards.def.ts` — has `moduleKey: 'dashboard-cards'`, `hasCustomPage: true`, `category: 'display'`
- `filter-data-management.def.ts` — has `moduleKey: 'filter-data-management'`
- `tablet-access.def.ts` — has `moduleKey: 'tablet-access'`, `category: 'security'`

For all three, the corresponding static-routes file (`static-routes/dashboard-cards.routes.ts`, `static-routes/tablet-access.routes.ts`) DOES exist and serves GET/PUT against the underlying SystemConfig key — but the def is never registered in `configRegistry`, so:

- `getManifest()` (used by `GET /api/config/registry/manifest`) doesn't list these tiles → frontend "Config" landing page can't render them dynamically (relies on hardcoded knowledge).
- `seedDefaults()` never creates the SystemConfig row for them → first read returns `null` → frontend may render nothing or default gibberish.
- `requiredRole: 'ADMIN'` in `dashboard-cards.def` (and the equivalent on `tablet-access.def`) is never applied for the manifest filter.

The doc `CLAUDE.md` claims **30 definitions + auto-discovery**. Auto-discovery isn't auto — it's a hand-maintained import list that has fallen out of sync.

**Fix:** either (a) replace the explicit `Promise.all([...])` with a real glob-based discovery (`fast-glob('modules/config/defs/*.def.ts')` + dynamic import of each, with a startup test that asserts `defs.size === fileCount`), or (b) add the three missing imports and write a vitest that asserts `configRegistry.size === <count>` matches the file system. Hand-maintained "auto-discovery" defeats the entire point of the pattern.

### H10. `normalizeActionReauthConfig` silently zeroes legacy data — operators don't notice they have no policy
**File:** `apps/api/src/lib/reauth-check.ts:45-71`

Existing logic is correct (legacy nested shape was non-functional, returning `{}` preserves the de-facto state) but the user-visible signal is missing. Operators upgrading from a pre-FX7 build silently lose their reauth policy on the first request after upgrade. The `getMyActions` endpoint returns `{ actions: [] }` and the FE happily does no reauth gating.

**Fix:** when the legacy shape is detected, log a structured warning at WARN level: `{ event: 'reauth_legacy_shape_detected', moduleKey: 'action-reauth', impact: 'reauth disabled until re-saved' }` AND emit an in-app notification (the system has a notifications module) to all SUPER_ADMINs. Don't make the operator infer from the absence of reauth dialogs.

Also: the docstring claims handling of "legacy nested shape" but doesn't enumerate how new legacy shapes (the seed file might evolve again) are detected. The detection is brittle: it only matches if the value is a non-empty array whose first element has both `action` and `roles` keys. A legacy shape with an empty `actions: []` array passes through to the flat-shape branch, which then iterates `Object.entries({actions: []})`, sees `actions` is an array of strings only if `[]` (vacuously true), and writes `{actions: []}` into the flat config — silently corrupting the new flat shape. Add an explicit reject-and-default path for any value where keys aren't recognized action constants.

### H11. RBAC plugin — permission FALLBACK auto-grants too much
**File:** `apps/api/src/plugins/rbac.ts:42-54`

```ts
const manageVariants = ['_CREATE', '_UPDATE', '_DELETE', '_VIEW', '_READ', '_EXPORT'];
for (const suffix of manageVariants) {
  if (permission.endsWith(suffix)) {
    const managePermission = permission.slice(0, -suffix.length) + '_MANAGE';
    if (perms.includes(managePermission)) { hasPermission = true; break; }
  }
}
```

Granting `*_MANAGE` is documented as implying CREATE/UPDATE/DELETE/VIEW/READ — but also `_EXPORT`. So a role with `BACKUP_MANAGE` automatically gets `BACKUP_EXPORT` (i.e. can pull a full database dump). That may not be the intent in narrowly-scoped roles. Worse: there's no `_RESTORE` in the `manageVariants` list, so `BACKUP_MANAGE` does NOT grant `BACKUP_RESTORE` — inconsistent. The fallback set is hand-coded and won't survive future permission renames.

**Fix:** make the implication map explicit and configured per permission family (declare `BACKUP_MANAGE → [BACKUP_EXPORT, BACKUP_RESTORE, BACKUP_DELETE]` in `@digilog/shared` next to the constants), so it's auditable. Don't infer implications from suffix patterns.

---

## Medium

### M1. Sync `since` endpoint has no per-entity row cap or auth scoping beyond "logged in"
**Files:** `apps/api/src/modules/sync/{routes,sync.service}.ts`

The route is mounted with no `requirePermission`, only the global JWT check (the docstring on routes.ts:5-10 explicitly notes "no permission check per task brief"). Any logged-in user can hydrate the entire org's filters / templates / cleaning profiles into their offline cache. With single-tenant deployment that's mostly fine, but it means any compromised tablet account exfiltrates the full schema config in one GET. Combined with C4/C5, the user could then craft reports against any entity they discovered.

The 500-row cap per entity is also not paired with retry-on-cap on the server — `hasMore: true` is correct, but a malicious client can hammer the endpoint with rapid pagination cursors and (a) flood the DB with 6 parallel queries × N pages, (b) trigger telemetry batcher pressure. No rate limit.

**Fix:** add `requirePermission('OFFLINE_SYNC_USE')` (or similar narrow grant). Add per-user rate limit (one /since call per ~5 s is plenty for the offline cache hydrate use case). Add a server-side max page count to prevent unbounded pagination loops.

### M2. Backup CSV value parser is heuristic and corrupts edge-case data
**File:** `apps/api/src/modules/backup/backup.service.ts:46-73`

`parseCsvContent` infers types from string content:

```ts
else if (val !== '' && !isNaN(Number(val)) && !val.includes('-') && val.length < 15) val = Number(val);
```

This silently mutates fields that happen to look numeric. Examples:
- A `username` column containing `"007"` becomes `7` after restore.
- A `code` column with `"1.5"` becomes `1.5`.
- Excludes any value with `-` (intended to skip ISO dates) but a perfectly valid identifier like `12345-678` is also blocked, so it stays a string — inconsistent.
- `length < 15` cuts off at an arbitrary point — a 16-digit credit-card-shaped string passes as a string, a 15-digit one becomes a Number losing precision past 15 digits.

These get inserted via `jsonb_populate_recordset` into typed columns, where postgres's text→type coercion mostly sorts it out for declared columns — but for JSONB columns the round-trip stores wrong types.

**Fix:** require explicit type metadata in the CSV (header row with type hints, or a per-column type lookup from `information_schema.columns` discovered the same way restore already discovers columns). Stop guessing.

### M3. Backup `parseSqlBackup` regex parser silently drops multi-line INSERTs and complex values
**File:** `apps/api/src/modules/backup/backup.service.ts:111-128`

```ts
const insertRegex = /INSERT INTO "([^"]+)"\s*\(([^)]+)\)\s*VALUES\s*\((.+?)\);/g;
```

Single-line, single-row INSERT only. The exporter (`exportSql`) only emits this shape, so a round-trip works — but if an operator hand-edits the SQL backup (or imports from a `pg_dump` that uses multi-row VALUES or unbounded text fields with newlines), the regex silently fails to match those rows and the restore proceeds with missing data. No "rows skipped" warning.

**Fix:** either require backups to come from `exportSql` only (reject anything else with a clear error), or bring in a real PG SQL parser. Don't silently drop rows.

### M4. Reports — `data:image` chart base64 inflates HTML payload, no max-series guard
**File:** `apps/api/src/modules/reports/renderers/{html-builder,chart-renderer}.ts`

Chart sections render via `data:image/png;base64,…` inlined into HTML, then handed to puppeteer which serializes it back into the PDF. Each 800x400 PNG is ~50-200 KB base64. A template with 20 chart sections × 5 series × 1000 data points per series rapidly produces multi-MB HTML strings that puppeteer's `setContent` has to parse + render. No upper bound on series count or data-point count is enforced.

**Fix:** cap series count per chart, sample-down data series with > N points before passing to chart.js, or stream the chart PNGs to disk and reference them by URL so puppeteer can fetch them lazily.

### M5. Reports — `substituteString` value coercion swallows arrays-as-strings
**File:** `apps/api/src/modules/reports/variable-resolver.ts:89-96`

```ts
if (typeof value === 'object') return JSON.stringify(value);
```

A resolved value that's an array (e.g. `ts.range` returning rows) is rendered as raw JSON inside the PDF — `[{"timestamp":"…","value":42},…]`. Operators see machine output instead of an error message. Should explicitly warn or strip-with-warning so they catch mis-templated tags during preview.

**Fix:** distinguish "array meant for table/chart" from "scalar substitution accidentally got an array" — return an empty string + log a warning when the latter happens, instead of leaking JSON into the PDF.

### M6. Ingestion rate-limit cleanup leaves bucket window open for one extra cycle
**File:** `apps/api/src/modules/data-ingestion/ingestion.service.ts:124-134`

The cleanup interval runs at the same cadence as the window (60 s), so a bucket that just hit `windowStart = T` gets cleaned at `T + 60` (the boundary), but if the next message arrives at `T + 59.999` it's mis-counted into the old bucket. Off-by-one — minor, but harder to debug than a more conservative cleanup.

**Fix:** run cleanup at `RATE_LIMIT_WINDOW_MS / 2` cadence, or use rolling windows.

### M7. Sync entity `OR` query on AssetInstance + FilterDetails is two index scans, no join hint
**File:** `apps/api/src/modules/sync/sync.service.ts:199-203`

```ts
where.OR = [
  { updatedAt: { gt: filterCutoff } },
  { filterDetails: { is: { updatedAt: { gt: filterCutoff } } } },
];
```

Prisma compiles this to an OR with a subquery on FilterDetails. With no compound index on `(filter_details.updated_at)`, large filter inventories will see this query degrade. There's also no index check in the migration history.

**Fix:** add `@@index([updatedAt])` on `FilterDetails` (and verify `AssetInstance.updatedAt` is indexed). Add an explanatory comment about the expected query plan.

### M8. `chart-renderer.ts` imports `GlobalFonts` but never uses it
**File:** `apps/api/src/modules/reports/renderers/chart-renderer.ts:1, 119`

```ts
import { createCanvas, GlobalFonts } from '@napi-rs/canvas';
…
export async function shutdownChartRenderer(): Promise<void> {
  void GlobalFonts; // pointless reference to suppress unused-import lint
}
```

`void GlobalFonts` exists only to silence ts-unused. Either register at least one font here (so charts render with a known font instead of falling back to whatever napi-rs picks per-OS) or delete the import. Current state is misleading.

### M9. Backup `getAllTables` cycles fall back to alphabetical insert — large cycle groups break
**File:** `apps/api/src/modules/backup/backup.repository.ts:99-103`

```ts
if (ready.length === 0) {
  // Cycle — append whatever is left in stable order
  sorted.push(...[...remaining].sort());
  break;
}
```

For tables in an FK cycle, restore relies on the second-pass `fixupSelfRefs`, which only handles **self-referential** columns (one table → itself). Multi-table cycles (table A FK → B, B FK → A) are not handled — the alphabetical insert order will always violate one direction of the cycle, FK violation aborts the whole transaction. The current schema may not have multi-table cycles today, but the comment "FK bypass during restore handles those safely" overstates the safety: there is no FK bypass for multi-table cycles in the current code.

**Fix:** detect multi-table cycles at restore time and either (a) wrap restore in `SET CONSTRAINTS ALL DEFERRED` (requires deferrable FKs in the schema) or (b) explicitly list cycles, NULL out the cross-table FK columns on first pass, fix up in a second pass, mirroring the self-ref logic.

### M10. `audit-logger.ts` plugin and `lib/audit.ts` standalone are two implementations of the same thing — drift already happened
**Files:** `apps/api/src/plugins/audit-logger.ts:31`, `apps/api/src/lib/audit.ts`

Two parallel audit-logging functions with near-identical logic. The plugin version (`app.auditLog`) silently exempts SUPER_ADMIN (`if (entry.userRole === 'SUPER_ADMIN') return;`); the standalone version does not. Confirmed `app.auditLog(...)` is never invoked anywhere in the repo (`grep "app\.auditLog\|fastify\.auditLog" -r` → zero hits), so today this is dead code — but it's wrong dead code that contradicts both the inline ingestion comment ("All roles are audited — 21 CFR Part 11 compliance requires complete audit trail" — `data-ingestion/ingestion.service.ts:773`) and Part 11 §11.10(e). If anyone wires it up by accident, all SUPER_ADMIN action history vanishes silently. No tests pin the two in lockstep so future refactors will diverge them more.

**Fix:** delete `audit-logger.ts` entirely; if retained, drop the SUPER_ADMIN exemption so the two implementations match. Mark `lib/audit.ts` as single source of truth in a header comment.

### M11. RBAC per-request DB hit on every protected route — no role/permission cache
**File:** `apps/api/src/plugins/rbac.ts:25-30, 80-85`

Every `requirePermission(...)` and `requireAnyPermission(...)` call does `prisma.role.findFirst({ where: { name: userRole }, select: { permissions: true } })` with no cache. Combined with L3's three round-trips in the auth plugin (`session.findFirst` + `user.findUnique` + `session.update`), every authenticated request to a protected route is **4 sequential Prisma queries** before the handler runs. On a tablet doing real-time current-state polling, that's 4× round-trip latency multiplied by every poll. Roles change rarely (admin grants/revokes are seconds-scale events at most); a 5-10 s in-memory cache keyed by role name would eliminate ~25% of per-request DB load without meaningful staleness exposure. The auth plugin already implements `roleScopeCache` (5 s TTL) and `sessionConfigCache` (60 s) — use the same pattern here.

**Fix:** add a module-level `Map<string, { perms: string[]; cachedAt: number }>` with 5 s TTL to mirror the existing `roleScopeCache`. Bonus: the cache lets you grep all `requirePermission(...)` calls and assert each touches at most one cached lookup.

---

## Low / Notes

### L1. `cycleWrite/start-cycle.ts:41` — handcrafted HTML escape is incomplete
```ts
const cleaningJustification = typeof data.cleaningJustification === "string"
  ? data.cleaningJustification.replace(/</g, "&lt;").replace(/>/g, "&gt;")
  : data.cleaningJustification;
```
Escapes only `<` and `>`. Missing `&`, `"`, `'`. Also runs in addition to the general `lib/sanitize.ts` HTML strip done elsewhere — one or the other should be the contract, not both. Suggest: remove this manual escape; rely on `stripHtml(data.cleaningJustification)` from sanitize.ts at the route boundary.

### L2. `auth.ts:42-53` — public-paths matching uses `startsWith` so `/api/health/extra-secret-endpoint` is public
```ts
if (PUBLIC_PATHS.some((p) => req.url.startsWith(p))) return;
```
`/api/health` matches `/api/health-secret` (no slash boundary). Today none of the listed prefixes shadow real routes, but `/docs` and `/uploads/photos/` could in the future. Use `=== p || startsWith(p + '/')` for safety.

### L3. `auth.ts:78-92` — session check is two separate Prisma queries per request
A `findFirst({ id, isActive: true })` then `update({ id, lastActiveAt, expiresAt })` per authenticated request — i.e. two round-trips per HTTP request, plus a third for `prisma.user.findUnique`. On a busy tablet doing real-time polling this is meaningful. Combine into a single update-and-return (or `Prisma.raw` upsert) and cache user-status (status is rarely changed) for ~10 s.

### L4. `data-ingestion/ingestion.service.ts:11` — comment refers to "Redis pub/sub" but Phase 4 retired it
The Stage 11 docstring still says "Redis pub/sub, MQTT retained, notifications" while the code emits via `bus.emit('ws:events', …)` (in-process EventEmitter). Drift between code + comment. Update the docstring.

### L5. `dynamic-routes.ts:73` — auto-derived reauth action key collides with hand-defined ones
```ts
const action = def.reauthAction ?? `UPDATE_${def.moduleKey.toUpperCase().replace(/-/g, '_')}`;
```
A new def with `moduleKey: 'datetime'` would auto-derive `UPDATE_DATETIME` — but the static config-routes `configEndpoint('datetime', …)` already maps to `UPDATE_DATETIME_CONFIG`. If the dynamic route ever fires for that key (it won't today because `datetime` is hardcoded in `configRoutes()`), the actions would split into two distinct reauth keys. Fragile. Make `reauthAction` mandatory on every def, or reject defs whose derived key collides with a known static key.

### L6. Reports `service.generate` builds resolution context with `orgId: ''`
**File:** `apps/api/src/modules/reports/service.ts:53-55`
```ts
orgId: '',
…
orgName: '',
```
Vestige of multi-tenant code; field is consumed by `data-sources/*` for downstream filtering. Always-empty means any org-scoping logic in the data sources runs vacuously. Either delete the field from `ResolutionContext` (and from the consumer signatures) or wire it from `ctx`. Right now it looks like a plug for future multi-tenant code that won't return per the system stats.

### L7. Sync `SyncSinceQuery.filterUpdatedSince` — missing-validation falls back to "full sync" rather than 400
Documented behavior at line 75-78 — but a client passing an obviously-bogus value (`'???'`) gets a full hydrate (potentially 6 × 500 = 3000 rows + entire telemetry-cache template). Better: 400 with a hint to either omit the cursor or send a valid ISO-8601.

### L8. `config-discovery.ts:66-73` — `cleanupDeadConfigKeys` is fire-and-forget on every boot
```ts
const deadKeys = ['offline-sync', 'rfid-scanner', 'role-privileges', 'sidebar-config'];
const res = await prisma.systemConfig.deleteMany({ where: { configKey: { in: deadKeys } } });
```
Deleting on every boot is correct, but the list is hand-curated and grows. A boot-time `console.info` is the only signal, no audit trail. Should write a CONFIG_CHANGED audit row for any deletion. Today an operator doing a forensic audit of the config table won't find any record of what got deleted or when.

### L9. `dynamic-routes.ts:51-55` — secret masking uses literal `'••••••••'` (8 bullets) — fragile sentinel
PUT round-trip detects "secret unchanged" by exact match against the 8-bullet string. If the FE ever changes how it renders the secret (different bullet count, different unicode bullet, anything), the PUT will overwrite the real secret with the bullet string. Fragile by design — should be a typed field or a proper "(unchanged)" sentinel object.

---

## Out-of-scope / not present in repo

- **Mosquitto MQTT plugins** — no in-tree code under `apps/api/src/modules/` or `apps/api/src/lib/` matches Mosquitto/dynsec; the integration appears to be operational (PowerShell install scripts under `scripts/`) rather than a code module. Not reviewable here.
- **Multipart plugin / error plugin** — there is no separate `plugins/multipart.ts` or `plugins/error.ts`. `@fastify/multipart` is registered inline in `app.ts:147` and the error handler is `app.setErrorHandler(...)` at the same site (line 147+). Recommend extracting both into named plugins for testability.
- **Decision-tape engine in `apps/api/src/lib/`** — not present. The engine lives in `packages/shared/src/pipeline-executor/actions.ts` (called via the thin adapter at `apps/api/src/modules/filter-operations/tape/tape-generator.ts`). H8 covers the relevant aliasing concern.
- **Permissions module** — there is no `apps/api/src/modules/permissions/` directory. Permission constants live in `packages/shared` and enforcement lives in `apps/api/src/plugins/rbac.ts` (covered above as H11).

---

## Design challenges to discuss

1. **Reauth bypass via header (C1) is not a coding bug — it's a design hole.** The intent of the bypass is "the user already typed their password to authenticate when this action was performed offline; don't ask again on replay." But the server has zero proof-of-offline-action: the header is unsigned, untimed, and any logged-in user can attach it. Adding a role check ("only the OFFLINE_SYNC service account can use this header") closes the bypass for human users but leaves the underlying shape unchanged. The real fix is one of: (a) tablet logs in, server issues a short-lived `offline-replay` JWT claim signed at login, sync engine replays each action with that claim and a server-verifiable timestamp; (b) sync engine has a dedicated service-account JWT (not the user JWT) and replays user-authored actions that carry the user's signed approval (HMAC over operation + timestamp using the user's password-derived key); (c) accept that reauth is cosmetic for offline-replayed operations and document that explicitly so customers don't believe otherwise. Either way, "just add a role check" is **not** the fix — it papers over the absence of authentication on the bypass.

2. **Audit hash-chain (C3) is a compliance question, not an engineering one.** The system markets itself as 21 CFR Part 11 compliant; the audit trail does not actually chain. Either the marketing is overstated and the docs need correcting, or the schema needs `previous_checksum` + atomic chain insertion. The schema change is non-trivial because every existing row needs to be back-filled into a chain, which itself is a one-time audit event that needs to be captured.

3. **`tapeVersion` formula (H8) couples profile-version semantics to event-count semantics in one integer.** Splitting them into a string `${profileVersion}.${filterEventCount}` removes the cap entirely, costs a few bytes per row, and survives any future cycle event volume. Worth doing before someone deploys a high-volume use case.

4. **Config auto-discovery (H9) currently isn't auto.** Pick a side: either commit to a real glob-and-import pattern (fragile under bundlers like esbuild but transparent to operators), or rename "auto-discovery" to "explicit registration" and add a vitest gate that asserts every `.def.ts` is imported. The current middle-ground silently drops three real configs.

5. **Reports — entity authorization (C4/C5) requires an opinion on cross-user report access.** The current code implicitly says "anyone with `REPORT_VIEW` can read every report and target any entity." If that's the intent, document it loudly. If not, the fix is `REPORT_VIEW_OWN` vs `REPORT_VIEW_ALL` + per-entity ACL — non-trivial work that should land before more customers.

---

## Five-line summary

The reauth bypass via `x-offline-replay: true` (C1), unbounded `offlinePerformedAt` (C2), and missing audit hash-chain (C3) are the most pressing — together they let any authenticated user back-date forged records with no detectable trail, which directly contradicts the 21 CFR Part 11 posture the project markets. Reports (C4/C5) leak data because `entitySlots` and `report.id` lookups don't authorize, and the underlying Puppeteer browser singleton (H6) plus orphaned-PDF lifecycle (H7) are operational footguns under load. Backup (H3/H4/H5) trusts attacker-supplied metadata, OOMs on 100 MB uploads, and silently rewrites the audit trail on restore. The decision-tape staleness guard `assertTapeVersionFresh` returns ok-on-null (H8a) and the `tapeVersion` integer aliases past 1e6 events per cycle (H8b); the idempotency JSON-path scan (H1) is unindexed and not cycle-scoped at start-cycle (H2). Config "auto-discovery" silently drops three real defs (H9); the legacy-shape reauth normalize warns nothing (H10); the per-request RBAC DB hit (M11) compounds with the auth plugin's three round-trips into 4 sequential queries before any handler runs.
