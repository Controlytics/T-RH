# Session resume state — 2026-04-29 end of day

This file is a cold-start resume guide. If you (or a future Claude session) are coming back to this work, read this before doing anything else.

## What got done this session

**Documentation phase** (15 commits, on `origin/docsCleaned`):
- 224 → 62 active `.md` files (archived stale ones, refreshed surviving ones)
- New `windowsIssues.md` — 18-item Windows Server difficulty audit
- New `docs/plans/2026-04-29-windows-friendly-rewrite.md` — full 5-phase rewrite plan
- New `docs/CONTRIBUTING.md` — Change → Docs map (extracted from CLAUDE.md trim)
- New `PHASE_5_RECENT_WORK.md` capturing post-Phase-4 work
- All numerical claims verified against live code (109 perms / 91 priv / 81 reauth / 64 models / 22 enums / 30 configs / 26 pages / 37 modules / 81 routes)
- CLAUDE.md trimmed 278 → 185 lines with the Documentation Sync Rule codified

**Phase 1 of windows-friendly-rewrite** (14 commits, on `origin/feature/phase1-mosquitto-rewrite`):
- EMQX → Mosquitto MQTT broker swap, behind `USE_MOSQUITTO` feature flag
- 4 new files: `mosquitto-acl-generator.ts` (12 tests), `mosquitto-refresh-routes.ts` (11 tests), `mosquitto/mosquitto.conf`, `scripts/install-mosquitto.ps1`
- 1 new test file: `mqtt-broker-integration.test.ts` using `aedes` as in-process Mosquitto test double (3 tests)
- `docker-compose.yml` swapped emqx → eclipse-mosquitto:2.0
- `apps/api/src/transport/mqtt-client.ts` patched for flag-aware credential selection
- `start-digilog.bat` reads USE_MOSQUITTO and starts the right broker
- Audit log + atomic file write + timing-safe Bearer compare on the refresh endpoint
- Final tests: 166/167 (1 pre-existing failure in `user-id-validator.test.ts:219`, unrelated)

## Where everything is

| | Path |
|---|---|
| Main checkout | `C:\Users\hello\21cfrlogbook-DigitalFMS` (branch `RFID` at `06d86e1`) |
| Phase 1 worktree | `.worktrees/phase1-mosquitto` (branch `feature/phase1-mosquitto-rewrite` at `0f1c4de`) |
| Plan (full 5-phase) | `docs/plans/2026-04-29-windows-friendly-rewrite.md` |
| Phase 1 execution wrapper | `C:\Users\hello\.claude\plans\ancient-wishing-yeti.md` |
| Audit log of all 10 doc passes | `tasks/todo.md` |
| Doc-sync contract | `CLAUDE.md` "Documentation Sync Rule" + `docs/CONTRIBUTING.md` "Change → Docs map" |

## Branches on origin

| Branch | HEAD | Contents |
|---|---|---|
| `origin/RFID` | `5eb9db8` | Pre-session baseline. Documentation cleanup did NOT push here (intentionally); pushed to `docsCleaned` instead. |
| `origin/docsCleaned` | `30cb462` | Documentation cleanup + windowsIssues.md + the rewrite plan. Ready for review/merge. |
| `origin/feature/phase1-mosquitto-rewrite` | `0f1c4de` | Phase 1 implementation. Ready for review/merge. Branched from `docsCleaned`. |

Local `RFID` branch is at `06d86e1` (1 commit ahead of `origin/RFID` — adds `.worktrees/` + backup-file gitignore patterns).

## Stash

```
stash@{0}: On RFID: pre-phase1-rewrite-uncommitted-source-mods (2026-04-29)
```

Files in stash (pre-existing source mods you had before this session, NOT mine):
- `apps/api/src/modules/filter-operations/filter-operations.service.ts`
- `apps/web/src/routes/filter-management/filter-operations.tsx`
- `apps/web/src/routes/mobile/mobile-operations.tsx`

**Note:** Phase 2 of the rewrite plan modifies `mobile-operations.tsx` and `filter-operations.tsx`. Restore the stash AFTER Phase 1 lands and BEFORE starting Phase 2, or expect merge conflicts.

To restore: `git stash pop` (from main checkout on the right branch).

## Working-tree state at session end

Main checkout has 2 untracked + 1 modified:
- `M .claude/settings.local.json` — cleaned up from 499 → 171 lines (491 → 167 permission entries, removed stale JWTs + per-query SQL literals)
- `?? .claude/settings.local.json.backup-20260429-094623` — full original, gitignored on session save
- `?? apps/android/apps/` — pre-existing stray `sw.js` dir, not mine

Worktree at `.worktrees/phase1-mosquitto` is clean (every Phase 1 commit landed on `origin`).

## Next-session checklist (in order)

1. **Open the two PRs** if not yet merged:
   - `https://github.com/pankajexa/21cfrlogbook/pull/new/docsCleaned`
   - `https://github.com/pankajexa/21cfrlogbook/pull/new/feature/phase1-mosquitto-rewrite`
2. **Verify Phase 1 in your live environment** before merging — see `windowsIssues.md` + the migration steps in the `[Unreleased]` CHANGELOG entry on the Phase 1 branch:
   - Set `USE_MOSQUITTO=true` + `MOSQUITTO_REFRESH_TOKEN=...` + `MOSQUITTO_ADMIN_PASSWORD=...` in `.env`
   - Run `scripts/install-mosquitto.ps1`
   - Restart API
   - `curl -X POST -H "Authorization: Bearer $TOKEN" http://localhost:3000/api/internal/mqtt/refresh-acl`
   - `Restart-Service mosquitto` (or `docker compose restart mosquitto`)
   - Have a real device publish telemetry, verify ingestion still works
3. **Restore the stash** before starting Phase 2: `git stash pop`
4. **Decide on Phase 2 scope:** the full plan (`docs/plans/2026-04-29-windows-friendly-rewrite.md`) has Phases 2 (BullMQ → graphile-worker), 3 (puppeteer-core + Edge + @napi-rs/canvas), 4 (cleanup), 5 (verification). Phase 2 is ~10 tasks / ~30 subagent invocations.

## Outstanding items deferred from Phase 1

These were Important issues in the whole-branch review that did NOT block Phase 1 cut-over but should land in Phase 4 cleanup:

- `windowsIssues.md` § 3 (EMQX hard blocker) — needs a "✅ resolved by Phase 1, flag-gated" annotation
- `PHASE_5_RECENT_WORK.md` § 11 (outstanding work list) — needs Phase 1 entries added
- The aedes integration test mocks the broker; there's no test that boots the API + a real Mosquitto + verifies a device can publish through `/refresh-acl`-generated ACLs. Phase 5 e2e scope.

## Codex auth state (in case you forgot)

- `~/.codex/config.toml` has the `model` line commented out (using account-default)
- ChatGPT-account OAuth login is active (`auth.loggedIn: true` per last `setup --json`)
- The leaked OpenAI API key from earlier in the session is **revoked** per your confirmation
- `OPENAI_API_KEY` env var is **cleared** at User scope and current process scope

## To save the cleanup before stopping

```bash
cd /c/Users/hello/21cfrlogbook-DigitalFMS
git add .gitignore .claude/settings.local.json tasks/RESUME-STATE-2026-04-29.md
git commit -m "chore: save end-of-session state — settings cleanup + resume note"
git push origin RFID
```

(Optional — only if you want the cleaned settings to be tracked on RFID. Otherwise leave it as a local working-tree change. The PHASE 1 + DOCS branches are already pushed and don't need this.)
