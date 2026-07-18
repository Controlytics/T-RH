# Session resume state — 2026-05-04 end

Cold-start guide for the next session. Read this and you have everything needed to pick up.

## Where we are

**Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
**Branch:** `feature/phase5-verification`
**HEAD:** `3714326`
**Origin:** both `feature/phase5-verification` and `docsCleaned` are at `3714326` (pushed)
**Working tree:** clean except `M DigiLog-FilterOps.apk` (rebuilt this session, uncommitted)

## What this session accomplished

37 commits across 9 waves. All audit findings closed. Test suite fully green for the first time since Phase 8.7.

| Wave | Scope | Outcome |
|---|---|---|
| 1–4 (Phase 8.7 cutover) | server cutover + tape contract + concurrent-op tests | 8 commits |
| 5 (follow-ups) | locking parity (terminate/bypass), tombstone tapeVersion, gitignore | 3 commits |
| 6 (APK + smoke) | APK rebuild successful (8.3 MB, sha `a7eea265…`); browser smoke blocked on Vite restart | 0 commits |
| 7a/7b/7c (P0.2 monster files) | 8 of 8 split: checklist-form, pm-schedule.service, debug, filter-operations.service, desktop+mobile filter-ops, filter-list, templates+template-editor, rule-chains/editor | 9 commits, 78+ new modules |
| 8a (§ 11 closure) | DEPLOY-WINDOWS docs, multi-filter batch checklist, Phase 2/3/4/5 e2e suites | 3 commits + 1 doc |
| 9a (audit fixes) | C1 (offline checklist expand=questions), C2 (retire/replace/bulk reauth), H1 (profile reauth), H5 (hierarchy validation), FX7 (action-reauth seed normalization), FX6 (auth UUID mismatch) | 6 commits |
| 9b (audit fixes) | M4 (checklist version history button), H3+H4 (PM exec PUT delete + Create Schedule redirect), H2 reclassification, M5+M8 (equipment soft-lock), M1+M2 (dedicated reauth actions) | 5 commits |

## Test counts (single-fork mode — only stable mode per apps/api/CLAUDE.md)

| Suite | Pre-session | Final |
|---|---|---|
| api | 1186 / 1188 | **1249 / 1257** (0 failed, 8 skipped) |
| web | 82 | **104** |
| shared | 305/306 | 305/306 (1 unrelated pre-existing) |

The "2 known failures" baseline we'd been quoting since Phase 8.7 (auth.test forgot-password + config.test PUT action-reauth) were both real bugs — both fixed this session.

## Audit closure (`tasks/AUDIT-2026-05-04-linkage-review.md`)

All 14 audit findings (C1, C2, H1–H5, M1–M8, L1–L6) resolved:
- **Fixed:** C1, C2, H1, H3, H4, H5, M1, M2, M4, M8, L2 (and dependent FX7 action-reauth seed bug)
- **Reclassified:** H2 (misclassified — page is online-only), M5 (already implemented), M3 (intentional dual-write per Phase 8.6)
- **Doc-only / deferred:** M6 (filter-profile FE CRUD — product decision), M7 (sync sidecar limitation — documented), L1/L3-L6 (false positives or no-action items)

## Pending items (carried forward)

### Hardware-bound (cannot be done from this machine)
- **Phase 8.8 tablet field QA** — APK is built, ready to install. Per `tasks/PLAN-2026-05-02-step8.8-apk-field-qa.md`: install + cycle + RFID + offline replay + concurrent-operator collisions on real tablet.
- APK file `DigiLog-FilterOps.apk` (8.3 MB, sha `a7eea265…`) is in working tree, **uncommitted** — your call whether to commit + push the binary.

### Operator-decision-bound
- **Browser smoke (Wave 6 O)** — Vite dev server (PID 6324 on :5175) is in unhealthy `ERR_EMPTY_RESPONSE` state AND is bound to the main checkout (RFID branch — pre-Phase-8 code). Choose: (a) kill PID 6324 + restart from this worktree, (b) start a second Vite on 5176 from this worktree, (c) skip (tablet QA covers same flows).
- **Local dev server contention** on :3000 (PID 6324) makes the parallel-pool test runner flaky. Single-fork mode (`npm test` now defaults to it per commit `14ea21d`) avoids the issue. Long-term, retire the shared `admin` test user pattern.

### Operational (per-deploy)
- **Drift migration `20260503162127_capture_schema_vs_db_drift`** — DEPLOY-WINDOWS.md § 10.1 documents the `prisma migrate resolve --applied` workaround for populated environments. Operators MUST run that command before any future `migrate deploy` or the deploy will fail on `filter_cleaning_profiles.lineage_id NOT NULL` and `asset_instances` column drops.
- **Pre-Wave-2 IDB queue tapeVersion=null tablets** — operators with stale offline queues will see batch failures on first sync after the upgrade. DEPLOY-WINDOWS.md § 10.2 documents the operator response (re-perform failed actions).
- **Dev-time policy on action-reauth** — FX7's seed shipped `configValue: {}` (preserves the de-facto OFF state from the old broken nested seed). Operators must opt actions in via the action-reauth admin page if they want any reauth requirement.

### Code review pending — Codex adversarial review
- **`/codex:adversarial-review` command failed** with `ENOBUFS` from Node's `child_process.spawnSync` default buffer cap. The companion script (`C:/Users/hello/.claude/plugins/cache/openai-codex/codex/1.0.2/scripts/codex-companion.mjs`) cannot snapshot the whole codebase in one shot.
- **Three workable strategies** (next session):
  1. **Fastest:** `/codex:adversarial-review --base main` — bounds review to branch delta (37 commits this session + earlier phase work)
  2. **Most thorough:** chunk by subtree — invoke per `apps/api`, `apps/web`, `packages/shared`, etc. Dispatch as background tasks; consolidate findings.
  3. **Permanent fix:** patch the companion script to use `spawn` instead of `spawnSync`, or pass `{ maxBuffer: 100*1024*1024 }`. Brittle (gets overwritten on plugin update); prefer reporting upstream.

### Pre-existing flags surfaced this session (NOT fixed)
- `pm-schedule-crud.ts:138` blocks schedule deletion if any `PmExecution.status === 'IN_PROGRESS'`. After Wave 9b deleted the orphan PUT, schedules effectively lock once a PM has been started. Documented inline in `pm-executions.ts`. Real "abandon execution" UX is a deferred product decision.
- `apps/api/src/modules/assets/services/instance.service.ts:82` guards on `&& data.attributes` truthy. If a caller passes `attributes: undefined`, validation is skipped. All current callers send `{}` so not exploitable today; defensive future fix.
- `apps/web/CLAUDE.md` "Phase 2 Pages" entry points to `routes/checklists/detail.tsx` but the actual folder is `checklist-admin/`. Stale doc reference.
- Forward-looking: if offline support is ever added to `/checklist/:entityId`, `ts_checklist_responses` (init-tsdb.sql:52-62) needs a `template_version` column.

## Where everything is

| | Path |
|---|---|
| Audit doc | `tasks/AUDIT-2026-05-04-linkage-review.md` |
| Step 8 resume | `tasks/RESUME-STATE-2026-05-02-step8.md` |
| 8.8 plan | `tasks/PLAN-2026-05-02-step8.8-apk-field-qa.md` |
| Windows-friendly rewrite plan | `docs/plans/2026-04-29-windows-friendly-rewrite.md` (all 5 phases done) |
| Test mode contract | `apps/api/CLAUDE.md` "Single-fork requirement" section |
| Deploy operator notes | `DEPLOY-WINDOWS.md` § 10.1 (drift migration) + § 10.2 (offline replay) |
| APK | `DigiLog-FilterOps.apk` at repo root (uncommitted) |
| Original APK build pipeline | `tasks/PLAN-2026-05-02-step8.8-apk-field-qa.md` § 1b |

## Next-session checklist (in order)

1. **Verify branch is current** — `git fetch && git log feature/phase5-verification..origin/feature/phase5-verification` should be empty.
2. **Run the test baseline** — `cd apps/api && npm test` should produce `1249 passed / 0 failed / 8 skipped`. If different, investigate.
3. **Decide on the APK** — commit + push `DigiLog-FilterOps.apk`, OR leave as build artifact, OR `git checkout -- DigiLog-FilterOps.apk` to restore the prior committed version.
4. **Decide on Codex review** — option 2 (`--base main`) is the fastest way to get any independent review pass. Or skip.
5. **Decide on Phase 8.8** — if a tablet is available, install the APK + run the field-QA matrix.
6. **Open PRs** — branch is on origin at `feature/phase5-verification` and `docsCleaned`. No PR opened yet this session.

## Constraint violations to remember (for future agent dispatch)

- **Agent FX3 ran `git checkout` mid-task** despite explicit "no git commands" — destroyed (then partially restored) FX2's in-flight files. Working tree was reconstructible after but it was close. Future agent prompts should reinforce "no git commands" with a hard escape clause.
- **Multiple agents had stream timeouts** — FX3 (30 min), FX7 (38 min), FX2 (48 min). They produced complete work but no completion notification. Lead must check working-tree state when an agent times out, not assume "agent died = work lost".
- **Single-fork test mode** is mandatory for `apps/api`; default-pool runs are unreliable due to shared `admin` user race + dev server contention. `npm test` defaults to single-fork now (commit `14ea21d`).

## Session telemetry

- **37 commits** since session start (`85ae3e1` → `3714326`)
- **52 tasks** dispatched across 9 waves (3 of 52 had constraint violations or stream timeouts; 0 caused permanent damage)
- **78+ new modules** created via P0.2 monster-file decomposition
- **29 new e2e tests** + **22 new unit tests** added
- **0 known failures** remaining (was 2 at session start)

## To save the cleanup before stopping

```bash
cd /c/Users/hello/21cfrlogbook-DigitalFMS/.worktrees/phase5-verification
git add tasks/RESUME-STATE-2026-05-04.md
git commit -m "docs(resume): 2026-05-04 end-of-session state"
git push origin HEAD:feature/phase5-verification HEAD:docsCleaned
```

(The APK is intentionally left uncommitted — the next session decides whether to track it.)
