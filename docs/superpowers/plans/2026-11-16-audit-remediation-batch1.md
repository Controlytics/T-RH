# Audit Remediation — Batch 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the clear-cut defects the 2026-11-07 audit found (Batch 1, chosen by the operator 2026-11-16), plus S6-4 with the operator's decision: every alarm acknowledgement and report approval / rejection ALWAYS requires and verifies the signer's password.

**Architecture:** Small, independent fixes, each in the module that owns the defect, each pinned by a regression test that fails today. No schema migration. No new dependency. Server decisions stay on the server (root `CLAUDE.md` "Never reconstruct server-side decision logic in the client").

**Tech Stack:** Fastify 5, Prisma 6, PostgreSQL 18, vitest 3 (API single fork on `compliance_core_db_test`), React 19 + Vite, PowerShell 5.1 installer scripts.

**Spec:** `docs/audit/2026-11-07-technical-audit.md` — the finding rows named in each task (S2-C1, S9-1, S9-5, S9-14, S2-H1, S2-H2, S6-3, S8-1, S8-5, S10-20, S8-22, S2-H7, S10-1, S6-4) and roadmap §K.

## Global Constraints

- Branch `data-layer`. **No commit, push or deploy until the operator says so**; each task ends by listing the files to stage.
- No new dependencies (audit decision B-4). No Prisma migration.
- Tests touching the database run on `compliance_core_db_test` only, single fork: `cd apps/api && npx vitest run <file> --pool=forks --poolOptions.forks.singleFork=true`. Confirm no other session holds the test DB first.
- Web tests: one FILE per invocation, judged by exit code (multi-file web runs manufacture failures).
- vitest does not typecheck: finish with `npx tsc --noEmit -p apps/api/tsconfig.json` and `npx tsc --noEmit -p apps/web/tsconfig.json` (and `npm run build -w @digilog/shared` before the API uses a shared change — the API reads `packages/shared/dist`).
- Root `CLAUDE.md` rules: list touch points before editing; test every touch point after; on any count change, update every doc that carries it (stale-stat sweep); `CHANGELOG.md` entry; feature notes in `docs/feature-notes.md`.
- Never swallow an error to silence it; never weaken an assertion to pass.

## Review Focus

1. **An upgrade over a database whose `system_config` rows predate a schema change** (create-only seed no longer rewrites them): every reader must still resolve through its schema with defaults — Task 1 pins a stored row missing a newer key.
2. **A device that sends `temperature` and `t` in the SAME message** (equal `ts`): precedence must stay alias order (`temperature`) — Task 4 keeps and extends the existing test.
3. **Limit text with a space before the sign, `NLT -15`:** stays −15; only a sign glued to a letter (`NLT-15`) is a separator — Task 3.
4. **An e-mail settings save that changes only `fromName` or the host's letter case while sending the mask:** must keep the stored secret (no false refusal) — Task 7.
5. **A directory (LDAP) user acknowledging an alarm:** the always-on check must verify against the directory exactly as `enforceReauth` did when policy-listed — Task 8 covers a local user; the LDAP path is the shared verifier, unchanged (note in the task).

---

### Task 1: Upgrades no longer overwrite stored settings or re-enable `superadmin` (S2-C1)

**Files:**
- Create: `apps/api/prisma/seed-config.ts`
- Modify: `apps/api/prisma/seed.ts:61-80` (superadmin upsert), `:166-176` (system_config loop)
- Test: `apps/api/src/lib/__tests__/seed-config.test.ts`

**Interfaces:**
- Produces: `systemConfigUpsertArgs(config: { configKey: string; configValue: unknown; configType: string; requiresReauth: boolean })` → Prisma upsert args with `update: {}`; `superadminUpsertArgs(passwordHash: string)` → upsert args with `update: {}` and the current `create` body.

- [ ] **Step 1: Write the failing test** — `seed-config.test.ts`, modelled on `seed-roles.test.ts` (pure, no DB):
  - `systemConfigUpsertArgs({configKey:'action-reauth', configValue:{}, configType:'security', requiresReauth:false}).update` toEqual `{}`; `.create.configKey` toBe `'action-reauth'`.
  - `superadminUpsertArgs('h').update` toEqual `{}`; `.create` toMatchObject `{ username:'superadmin', role:'SUPER_ADMIN', status:'ENABLED', passwordHash:'h' }`.
- [ ] **Step 2: Run it — FAIL** (module missing): `cd apps/api && npx vitest run src/lib/__tests__/seed-config.test.ts`.
- [ ] **Step 3: Implement** both functions in `seed-config.ts` (header comment states the rule: create-only, so an upgrade never rewrites what an administrator set and never re-enables `superadmin`; cite S2-C1 and 10-03 DATA-4); use them in `seed.ts`. `build-bundle.ps1` folds local imports into `seed.mjs` as it does `./seed-roles`.
- [ ] **Step 4: Run it — PASS**; also `npx vitest run src/lib/__tests__/seed-roles.test.ts`.
- [ ] **Step 5: Review Focus 1** — add to `seed-config.test.ts`: `configService.getConfig('password-policy', passwordPolicySchema)` over a stored value missing one key returns the schema default for that key (mock `configRepository.getSystemConfig`).
- [ ] **Step 6: Stage** `apps/api/prisma/seed-config.ts`, `apps/api/prisma/seed.ts`, the test.

### Task 2: One reading of the time zone (S10-20)

**Files:**
- Modify: `apps/api/prisma/seed.ts:137-146` (`timezone: 'Asia/Kolkata'`), `apps/api/src/lib/format-datetime.ts:19-23, :54-66`
- Test: `apps/api/src/lib/__tests__/format-datetime.test.ts` (create)

**Interfaces:**
- Produces: `resolveDatetimeConfig(raw: unknown): { dateFormat: string; timeFormat: string; timezone: string }` exported from `format-datetime.ts` — `datetimeConfigSchema.safeParse(raw ?? {})`, on failure `datetimeConfigSchema.parse({})`, exactly as `configService.getConfig` resolves it for the screens. `getDatetimeConfig()` uses it.

- [ ] **Step 1: Failing tests:** `resolveDatetimeConfig({dateFormat:'DD/MM/YYYY',timeFormat:'24-hour',timezone:'UTC'}).timezone` toBe `'Asia/Kolkata'` (the schema rejects UTC, the screens fall back to defaults — so must the server); `resolveDatetimeConfig(undefined).timeFormat` toBe `'24-hour'` (today's server fallback says 12-hour); a valid stored value round-trips.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement**; delete `DEFAULT_CONFIG`'s divergent `'12-hour'`; seed writes `'Asia/Kolkata'`.
- [ ] **Step 4: Run — PASS**; re-run touch points: `src/modules/alarm-webhooks/__tests__/build-variables.test.ts`, `src/modules/notification-delivery/__tests__/dispatcher-alarm-rules.test.ts`, `src/e2e/telemetry-buckets*.test.ts` (if present).
- [ ] **Step 5: Stage** the three files.

### Task 3: A minus sign glued to a word is a separator (S8-5)

**Files:**
- Modify: `packages/shared/src/types/alarm-limits.ts:120` (`FIRST_NUMBER`) and the `parseLimitValue` doc comment
- Test: `packages/shared/src/types/alarm-limits.test.ts`

- [ ] **Step 1: Failing tests:** `parseLimitValue('NLT-15')` toBe 15; `parseLimitValue('NMT-27')` toBe 27; unchanged: `'limit -40'` → −40, `'NLT -15'` → −15 (Review Focus 3), `'-5.5'` → −5.5, `'v2 limit 60'` → 2, `'60 (For Reference)'` → 60.
- [ ] **Step 2: Run — FAIL** on the first two: `cd packages/shared && npx vitest run src/types/alarm-limits.test.ts`.
- [ ] **Step 3: Implement:** the sign is optional and allowed only when no letter precedes it — `/(?:(?<![A-Za-z])[+-])?(?:\d+\.?\d*|\.\d+)/`. Document in the comment and in `docs/feature-notes.md` (limits section): `NLT-15` means 15; write `NLT -15` for minus fifteen.
- [ ] **Step 4: Run — PASS**; whole shared suite `npx vitest run` (fast).
- [ ] **Step 5: Stage** both files + feature note.

### Task 4: The freshest alias wins (S8-1)

**Files:**
- Modify: `packages/shared/src/types/telemetry-slots.ts:46-57` (`resolveSlot`), `apps/api/src/modules/instruments/data-keys.ts:66-75` (`resolvedSlotFor`), callers `instruments/routes.ts:1798, :2044`, `data-keys.ts:~110-124`
- Test: `packages/shared/src/types/telemetry-slots.test.ts`; `apps/api/src/e2e/instrument-limit-alarms.e2e.test.ts` (new case)

**Interfaces:**
- Produces: `resolveSlot<T extends { key: string; ts?: Date | string | number | null }>(aliases: string[], readings: T[]): T | null` — among readings matching ANY alias, the newest `ts` wins; equal or missing `ts` → alias order (today's rule). `resolvedSlotFor(cfg, key, instrumentKeys: readonly (string | { key: string; ts?: Date | string | null })[])` — strings behave as today (no ts → alias order).

- [ ] **Step 1: Failing tests (shared):** `resolveSlot(['temperature','temp','t'], [{key:'temperature',ts:'2026-11-16T08:00:00Z'},{key:'t',ts:'2026-11-16T11:00:00Z'}]).key` toBe `'t'`; Review Focus 2: same `ts` → `'temperature'`; no `ts` anywhere → alias order (existing test kept).
- [ ] **Step 2: Failing e2e:** in `instrument-limit-alarms.e2e.test.ts`, a second instrument with `High Temperature Limit 25`, latest `temperature`=22 three hours old and `t`=40 now, `lastSeenAt` now → `evaluateAlarms()` raises one INSTRUMENT_LIMIT TEMPERATURE HIGH alarm with `triggeredValue` 40 (audit probe P AT-1). Clean up its own rows.
- [ ] **Step 3: Run both — FAIL.**
- [ ] **Step 4: Implement** `resolveSlot` (stable: compare ts, tie → alias index); widen `resolvedSlotFor`; pass `{ key, ts }` from the latest-table rows at the three callers that hold them. `modbus/routes.ts:164` keeps plain keys (a fresh register read, no history). Update the `data-keys.ts:52-54` comment.
- [ ] **Step 5: Rebuild shared** (`npm run build -w @digilog/shared`), **run — PASS**; touch points: `src/e2e/telemetry-overview.e2e.test.ts`, `src/e2e/data-keys.e2e.test.ts`, `src/modules/instruments/__tests__/*data-keys*`, `src/e2e/alarm-sensor-range.e2e.test.ts`, `src/e2e/alarm-rs485.e2e.test.ts`.
- [ ] **Step 6: Stage.**

### Task 5: `claimClear` is atomic (S8-22)

**Files:**
- Modify: `apps/api/src/workers/alarm-evaluation.worker.ts:100-107`
- Test: `apps/api/src/e2e/alarm-claim-clear.e2e.test.ts`

- [ ] **Step 1: Failing test:** `vi.spyOn(prisma.alarm, 'findUniqueOrThrow')` rejects once inside the claim; `claimClear(id, {state:'CLEARED', …})` rejects AND the row is still `ACTIVE` afterwards (today it is CLEARED with nothing announced).
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement:** `updateMany` + `findUniqueOrThrow` inside one `prisma.$transaction(async (tx) => …)`; keep the signature `claimClear(id, data): Promise<Alarm | null>`; the spy must target `tx.alarm` — use the transaction client consistently.
- [ ] **Step 4: Run — PASS** (both existing cases too); touch points: `src/e2e/instrument-limit-alarms.e2e.test.ts`, `src/e2e/alarm-inactivity.e2e.test.ts`, `src/modules/rule-engine/__tests__/services*.test.ts` (rule-engine `services.ts:896` calls `claimClear`).
- [ ] **Step 5: Stage.**

### Task 6: Crash paths — MQTT drain and job runner (S2-H2, S2-H1)

**Files:**
- Modify: `apps/api/src/modules/instruments/listeners/mqtt-bridge.ts:434-515` (`drain`)
- Modify: `packages/queue/src/job-runner.ts` (`startJobRunner`), `apps/api/src/app.ts:500-580`
- Create: `apps/api/src/lib/job-runner-supervisor.ts`
- Test: `apps/api/src/e2e/mqtt-ingest.test.ts` (new case); `apps/api/src/lib/__tests__/job-runner-supervisor.test.ts`

**Interfaces:**
- Produces: `startJobRunner(opts & { onExit?: (err: unknown) => void })` — attaches `runner.promise.then(noop, err => { runner = null; opts.onExit?.(err) })`.
- Produces: `superviseJobRunner(start: () => Promise<void>, onStatus: (s: 'starting'|'running'|'failed', err?: unknown) => void, delaysMs = [5_000, 15_000, 30_000, 60_000]): { stop(): void; notifyExit(err: unknown): void }` — calls `start`; on failure reports `failed` and retries after the next delay (last delay repeats); `notifyExit` restarts the same way.

- [ ] **Step 1 (S2-H2) failing test:** in `mqtt-ingest.test.ts`, `vi.spyOn(prisma.instrument, 'findUnique')` rejects ONCE; publish a reading for a known code, then a second; the second is stored, the bridge logs `message FAILED`, and no unhandled rejection is raised (vitest fails the file on one).
- [ ] **Step 2 (S2-H1) failing tests:** `job-runner-supervisor.test.ts` with fake timers: `start` rejects twice then resolves → statuses `starting, failed, failed, running`, attempts spaced 5 s then 15 s; `notifyExit(err)` after running → `failed` then a new `start` after 5 s; `stop()` cancels a pending retry.
- [ ] **Step 3: Run — FAIL.**
- [ ] **Step 4: Implement:** wrap ONE loop iteration of `drain` in `try { … } catch (e) { log('message FAILED — not processed', { topic, err }) }` (keep the inner catches; the loop continues). Implement the supervisor; `app.ts` replaces its one-shot try/catch with it, sets `jobRunnerStatus` from `onStatus`, passes `onExit: supervisor.notifyExit`, and `stop()`s it before `stopJobRunner()` on shutdown. `/api/health` stays 200 (installers and the deploy depend on it) and keeps reporting `jobRunner`.
- [ ] **Step 5: Run — PASS**; touch points: `src/e2e/mqtt-attribute-report.test.ts`, `src/e2e/mqtt-rtc-sync.test.ts`; `cd packages/queue && npx vitest run src/__tests__/job-runner.test.ts` is DB-backed and NOT run (S8-13) — rely on the supervisor unit test and `tsc`.
- [ ] **Step 6:** state in `CHANGELOG.md` the residual: graphile's internal `.finally` rejections can still exit the process on a database drop (no handler can reach them without swallowing unrelated errors); the service manager restarts it and the supervisor now brings the runner back once the database answers.
- [ ] **Step 7: Stage.**

### Task 7: A kept secret never follows a new destination (S6-3)

**Files:**
- Modify: `apps/api/src/lib/mask-secrets.ts` (helper), `apps/api/src/modules/notification-delivery/routes.ts:136-160` (PUT /email), `:486-516` (PUT /sms), `apps/api/src/modules/alarm-webhooks/routes.ts:175-205`
- Test: `apps/api/src/lib/__tests__/mask-secrets.test.ts`; `apps/api/src/e2e/notification-config-audit-masking.test.ts`; `apps/api/src/e2e/alarm-webhooks.test.ts`

**Interfaces:**
- Produces: `urlOrigin(u: unknown): string | null` (lower-cased `protocol//host:port`, null when unparseable) and `sameSecretDestination(stored: Record<string, unknown>, next: Record<string, unknown>, fields: readonly string[]): boolean` (each field compared trimmed and case-insensitively; URL-valued fields by origin).
- Destinations: SMTP `password` → `['host','port']`; OAuth2 `clientSecret` / `refreshToken` → `['oauth2Provider','providerTenantId','tokenUrl']`; SMS gateway headers / URL query secrets / template secrets → `['httpGatewayUrl']` (origin); webhook headers / URL query secrets → the target `url` (origin). Twilio / Vonage tokens go to fixed vendor hosts — unchanged.
- Refusal: `400 VALIDATION_ERROR`, `message` "The destination changed: type the <field> again", `details.fieldErrors.<field>`, mirroring LDAP's `resolveBindPassword`.

- [ ] **Step 1: Failing unit tests:** `sameSecretDestination({host:'smtp.a.com',port:587},{host:'SMTP.A.com',port:587},['host','port'])` true (Review Focus 4); port 2525 → false; `urlOrigin('https://x.com/a?k=1')` = `'https://x.com:443'`.
- [ ] **Step 2: Failing e2e:** PUT /email with `password: <mask>` and only `port` changed → 400; with only `fromName` changed → 200 and the stored password kept; PUT /email with `clientSecret: <mask>` and a new `tokenUrl` → 400. Alarm webhook: update with a masked header and a new URL host → 400; same host, new path → 200.
- [ ] **Step 3: Run — FAIL.**
- [ ] **Step 4: Implement** the helper and the three call sites.
- [ ] **Step 5: Run — PASS**; touch points: `src/e2e/notification-*.test.ts`, `src/modules/notification-delivery/__tests__/*`, `src/e2e/alarm-webhooks.test.ts` in full.
- [ ] **Step 6: Stage.**

### Task 8: §11 signatures always verify the password (S6-4, operator decision 2026-11-16)

**Files:**
- Modify: `apps/api/src/modules/alarms/routes.ts:451`, `apps/api/src/modules/report-reviews/routes.ts:178-192` → `enforceReauthAlways(...)`
- Modify: `packages/shared/src/types/reauth-actions.ts:122, :130-131` (remove `ACKNOWLEDGE_ALARM`, `APPROVE_REPORT`, `REJECT_REPORT`; add them to the "deliberately absent — always on" comment beside the token actions), `packages/shared/src/types/permission-tree.ts:403, :444, :447` (drop their `reauthAction`)
- Modify: any shared constant / test that pins the reauth count 59 → 56; `configService.getMyActions` and the action-reauth PUT must tolerate a stored policy that still lists a removed key (filter to registry keys)
- Test: `apps/api/src/e2e/alarm-acknowledge.e2e.test.ts`, `apps/api/src/e2e/report-reviews.e2e.test.ts`, `packages/shared/src/types/permission-tree.test.ts:266-267`

- [ ] **Step 1: Failing e2e:** with an EMPTY re-auth policy, POST `/api/alarms/:id/acknowledge` with a wrong `x-reauth-password` → 401 (today 200, audit probe K); with none → 401 `REAUTH_REQUIRED`; with the right one → 200. Same three cases for report approve and reject.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.** The web already sends the password on all three (`acknowledge-dialog` callers `alarms/index.tsx:290`, `dashboard/selection-alarms.tsx:265`, `instruments/alarms-widget.tsx:135`; `lib/report-review.ts:115`) — no web change; verify `use-reauth`'s 401 path is not involved. Update existing e2e cases that acknowledged or decided without a password. The LDAP case (Review Focus 5) goes through the same `verifyReauthPassword` as before — no separate code.
- [ ] **Step 4: Run — PASS**; touch points: `src/e2e/alarm-acknowledge-tx.e2e.test.ts`, `src/e2e/report-reviews*.test.ts`, `src/e2e/audit*.test.ts` (signature rows), shared `permission-tree.test.ts`, `legacy-maps-derived.test.ts`, web `routes/config/__tests__/*reauth*` one file at a time.
- [ ] **Step 5: Docs:** root `CLAUDE.md` System Stats "59 reauth actions" → 56 with the dated reason, then the stale-stat sweep (`grep -rn "59 reauth\|59 re-auth"` across the active doc set); `docs/feature-notes.md` (report review + alarms notes: signatures always verify); `CHANGELOG.md`.
- [ ] **Step 6: Stage.**

### Task 9: The token refresh guard always clears (S2-H7)

**Files:**
- Modify: `apps/web/src/lib/api-client.ts:251-276`
- Test: `apps/web/src/lib/__tests__/api-client-refresh.test.ts` (create)

- [ ] **Step 1: Failing test:** with no token, `refreshToken()` resolves false; then set a token and stub `fetch` to return `{token:'new'}` → `await refreshToken()` resolves **true** (today it returns the stale false forever).
- [ ] **Step 2: Run — FAIL:** `cd apps/web && npx vitest run src/lib/__tests__/api-client-refresh.test.ts`.
- [ ] **Step 3: Implement:** move the `!token` check inside the `try` so the existing `finally` clears the guard on every path.
- [ ] **Step 4: Run — PASS**; touch point `src/lib/__tests__/api-client-reauth-shape.test.ts` (alone).
- [ ] **Step 5: Stage.**

### Task 10: Windows installer — job runner, DB handoff, upgrade health (S9-1, S9-5, S9-14)

**Files:**
- Modify: `scripts/install.ps1:192-208` (add `MAINTENANCE_CRONTAB_PATH=$InstallDir\runtime\queue\crontab.txt`), `:221-231` (pass `StopWhenDone = $true` to `provision-db.ps1`), `:267-279` (after a 200, parse the body and require `jobRunner -eq 'running'`, else FAIL with the log path)
- Modify: `scripts/upgrade.ps1` (append `MAINTENANCE_CRONTAB_PATH` when absent, the `EnvEnsure` pattern of `provision-emqx.ps1:105-139`; health URL `http://` → `https://` at `:206, :211`, with the same certificate handling as `install.ps1:272`; same `jobRunner` check)
- Test: `apps/api/src/lib/__tests__/installer-contract.test.ts` (create — reads the scripts as text)

- [ ] **Step 1: Failing contract tests:** `install.ps1` env body contains `MAINTENANCE_CRONTAB_PATH=` and the path segment `runtime\queue\crontab.txt` that `stage-runtime.ps1` stages to; `upgrade.ps1` mentions `MAINTENANCE_CRONTAB_PATH`; `upgrade.ps1` has no `http://localhost` health URL; `install.ps1`'s `provision-db.ps1` arguments include `StopWhenDone`; both scripts check `jobRunner`.
- [ ] **Step 2: Run — FAIL.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run — PASS**; PowerShell syntax check of both scripts: `powershell -NoProfile -Command "$e=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('scripts/install.ps1',[ref]$null,[ref]$e); $e.Count"` → `0` (same for `upgrade.ps1`). Do NOT run either script (no installer may run on this laptop); a clean-VM run remains owed (audit P1-3).
- [ ] **Step 5: Stage.**

### Task 11: Documentation and the record

**Files:**
- Modify: `DEPLOY-WINDOWS.md:25`, `docs/deployment-methods/method-c-ubuntu-deb.md:67-71` (S10-1: state what an upgrade now preserves — stored settings and `superadmin` — and keep a post-upgrade check of the five security settings)
- Modify: `CHANGELOG.md` (one entry for Batch 1, finding IDs, the S2-H1 residual, the S6-4 behaviour change), `docs/feature-notes.md` (Tasks 3, 4, 8), `tasks/todo.md` (audit-log entry)
- Modify: `docs/audit/2026-11-07-technical-audit.md` — append "Remediation log — Batch 1 (2026-11-16)" listing each finding as FIXED IN WORKING TREE (not committed), with its test

- [ ] **Step 1:** write the doc changes.
- [ ] **Step 2: Final verification:** `npx tsc --noEmit -p apps/api/tsconfig.json` and `-p apps/web/tsconfig.json` → 0 errors beyond the 17 / 43 pre-existing unused-symbol diagnostics (Stage 5 baseline; compare the lists, do not just count); shared suite; the API files touched by Tasks 1–8 one by one; then, with the test DB free, ONE full API run (`npx vitest run --pool=forks --poolOptions.forks.singleFork=true`) → 0 failures; web files touched, one by one.
- [ ] **Step 3:** report the results to the operator with the list of files to stage; wait for "commit".
