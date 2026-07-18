# Dead Code / Unused Asset Audit — 2026-07-04

**Scope:** full monorepo, branch `RFID`. Report-only — nothing deleted.
**Method:** knip (dead exports/files) + depcheck (unused deps) + madge config + 4 parallel
deep-audit agents (api / web / docs / assets-native), every "dead" claim backed by an
import-trace or grep receipt. knip calibrated as *over-reporting* (~half its "unused
exports" are used same-file — only the `export` keyword is redundant, the symbol is live).

Tiers are ordered by **actionability**, not location. Tier 0 first.

---

## TIER 0 — SECURITY / COMPLIANCE (act first)

| item | evidence | risk | recommendation |
|---|---|---|---|
| `RFID/rfid-key.jks`, `rfid_scan_app/rfid-key.jks` | Android signing keystores **tracked in git**; `.gitignore` covers `*.key`/`*.pem` but not `*.jks` | leaked signing key | `git rm --cached` both, add `*.jks`/`*.keystore` to `.gitignore`. **Rotation is a judgment call:** rotate ONLY if the key never signed a build already installed on tablets — if it did, rotating breaks in-place APK updates (Android signature-mismatch); in that case keep the key but scrub it from git history instead |
| `old/db-backups/*` (53 MB tracked) | `digilog_db_backup_2026-04-13.sql` (2.8 MB) holds bcrypt password hashes + audit-trail PII (your own memory note flags this); also 2× dropped-TimescaleDB dumps (13 MB each) + `test_dynamic*` (27 MB). `.gitignore` rule `old/db-backups/*.sql` was added *after* commit, so git still tracks them | PII/credentials in git history + repo bloat | `git rm --cached old/db-backups/*`. **Fix the gitignore rule to `old/db-backups/*`** (the current `*.sql` rule does NOT cover `test_dynamic_backup.json` — it would reappear untracked and be re-addable). History scrub (BFG) if the repo is ever shared |
| `RFID/local.properties` | machine-specific SDK path, tracked | minor (leaks local paths) | untrack (part of the RFID/ deletion below) |

---

## TIER 1 — UNTRACKED LOCAL DROPPINGS (~45 MB, not in git, trivially clearable)

All gitignored — deleting them changes nothing in git, just cleans your working tree.

| what | count | size | note |
|---|---|---|---|
| Root screenshots `*.png` (tour-*, sweep-*, step*, bug-*, mt-removal-*, dry-*, cycle-*, etc.) | 184 | 28 MB | debug captures; `/*.png` gitignored |
| `.cdp-*.log`, `.tmp_*`, `.continue.log`, `.web-build*.log`, `.apk-build*.log`, `.api-restart.log`, `.serve-apk.log`, `.tablet-screen.png`, `.tmp_tab.png` | 33 | 3.2 MB | scratch logs/pngs |
| `apps/api/Screenshots/` (untracked dir) | — | 14 MB | not gitignored yet — shows in `git status`; add to `.gitignore` or delete |

**Suggested:** `git clean -ndX` to preview, then `git clean -fdX` to clear gitignored junk (review first). Handle `apps/api/Screenshots/` separately (it's untracked-but-not-ignored).

---

## TIER 2 — CONFIRMED DEAD FILES / DIRECTORIES (zero refs, safe)

### Native / build
| path | evidence | recommendation |
|---|---|---|
| **`RFID/` (entire dir, 28 files)** | Abandoned first-draft RFID scanner (`com.digilog.rfid`), superseded by `rfid_scan_app/` (`com.rfid.scanner`, 58 files, has the `Reader_Usb.jar` SDK). RFID/ has **no SDK jar**, its `usb/RfidReader.kt` is a stub importing no UHF symbols, zero external refs (`com.digilog.rfid` appears only inside RFID/), not in CLAUDE.md's documented structure. Only later commit was a gitignore-hygiene touch. Production RFID ships via `apps/android/.../RfidPlugin.java`. | **delete dir** |
| `RFID/RFID/app/src/main/res/mipmap-*/ic_launcher.png` (5) | doubly-nested orphan launcher PNGs inside the dead dir | delete with RFID/ |
| `init-tsdb.sql` (root, 10 KB) | TimescaleDB init; `digilog_tsdb` dropped entirely 2026-06-11 (Phase 7). 0 tracked references | delete |
| `DigiLog-FilterOps.apk` (root, 11.7 MB) | build output committed at repo root; whitelisted in .gitignore. Belongs in Releases, not git | move out of git (optional) |

### Superseded installer scripts (Setup.exe M0–M8 replaced them)
Current *live* set is invoked by `installer/DigiLog.iss` → `build-installer.ps1`: `install.ps1`,
`upgrade.ps1`, `uninstall.ps1`, `provision-db.ps1`, `apply-schema.ps1`, `register-services.ps1`,
`unregister-services.ps1`, `build-bundle.ps1`, `stage-runtime.ps1`, `verify-migrations.ps1`. These are **not** in that chain:

| path | evidence | recommendation |
|---|---|---|
| `scripts/install-services-phase5.ps1` | registers `*-Phase5` NSSM services; not called by current chain | delete — but first confirm you're not still running the Phase-5 NSSM flow manually |
| `scripts/uninstall-services-phase5.ps1` | pair of above | delete (same caveat) |
| `scripts/install-windows.ps1` | calls **untracked** `install-mosquitto.ps1` (Mosquitto removed Phase 7) | delete |
| `scripts/uninstall-windows.ps1` | only referenced by dead `install-windows.ps1` | delete |
| `scripts/package-for-production.ps1` | calls dead `install-mosquitto.ps1` + `install-on-target.ps1` | delete |
| `scripts/install-on-target.ps1` | calls dead `install-mosquitto.ps1` | delete |
| `scripts/remove-rulechain-alarm-runtime-cleanup.sql` | one-time cleanup for 2026-05-17 removal; already run | move to `old/` |

### Dead test / skill helpers (removed telemetry/MQTT subsystem)
| path | evidence | recommendation |
|---|---|---|
| `.claude/skills/manual-tester/scripts/publish-mqtt.js` | connects `mqtt://localhost:1883`, EC2 node_modules path; `mqtt` dep uninstalled Phase 7 | delete |
| `.claude/skills/manual-tester/scripts/publish-http.js` | HTTP telemetry ingest to removed endpoints | delete |
| `tests/e2e-scripts/e2e-ingest.sh` | 54 mqtt/ingest/telemetry hits; subsystem gone; not in any runner | delete |

### Spent one-time TS scripts
| path | evidence | recommendation |
|---|---|---|
| `scripts/backfill-sidebar-permission-link.ts` | header "One-time backfill (2026-06-15)"; imported by nothing | delete (optional) |
| `scripts/delete-viewer-role.ts` | header "One-off … 2026-06-15"; imported by nothing | delete (optional) |
| `vitest.workspace.ts` (root) | knip "unused file"; verify not referenced by CI before removing | needs-review |

### Orphaned tracked images / assets
| path | evidence | recommendation |
|---|---|---|
| `apps/web/public/favicon.svg` | not in index.html / manifest / code | remove (probable) |
| `apps/web/public/pwa-icon.svg` | zero references | remove (probable) |
| `apps/web/public/pwa-192x192.svg`, `pwa-512x512.svg` | only the `.png` variants are referenced; these are design sources | remove (probable) |
| `tasks/8.6-part2-visual-smoke-after.png`, `-stage.png` | 0 md references | delete (low value) |
| `RFID/RFID_Scanner_User_Manual.html` | **byte-identical** to `rfid_scan_app/RFID_Scanner_User_Manual.html` | delete (part of RFID/) |

**Config bug (not dead, but note):** `apps/web/vite.config.ts` `includeAssets` lists `favicon.ico`
which does not exist (harmless — vite-plugin-pwa skips missing assets).

---

## TIER 3 — CONFIRMED DEAD CODE SYMBOLS (import-trace verified)

> These are *symbol-level* — deleting the export removes dead code but each lives inside an
> otherwise-live file. Low urgency; good hygiene. **Not** whole-file orphans (there are none in src).
>
> **Self-checking:** every item here is compiler-verified. Delete the symbol, then run
> `npx tsc -p apps/api/tsconfig.json` (or `npx vite build` for web) — if any "dead" export was
> actually referenced on a path the grep missed, the build fails loudly. Zero silent-breakage
> risk, so this tier can be actioned safely in a delete-then-typecheck loop.

### Backend (`apps/api`, `packages`)
| symbol | file:line |
|---|---|
| `CATEGORY_META` | lib/config-registry.ts:109 |
| `getClientOpId` | lib/idempotency.ts:23 |
| `getFilterCore` + `FilterCore` type | lib/filter-details.ts:39,20 |
| `clearFilterCycle` | lib/filter-details.ts:77 (also drop its `vi.mock` key) |
| `shutdownChartRenderer` | modules/reports/renderers/chart-renderer.ts:117 |
| `authPatch` | e2e/test-helper.ts:242 (unused test util) |
| `DueTasksResponse` (interface) | modules/pm-schedules/pm-types.ts:47 |
| `DueFilterStatus/DueOverallStatus/DueFilterRow/DueTaskRow/DueTasksResponse` re-export block | modules/pm-schedules/pm-schedule.service.ts:37-41 |
| `export type { CycleSlice }` re-export | packages/shared/src/pipeline-executor/transitions.ts:386 |

### Frontend (`apps/web`) — genuinely dead symbols (22)
| symbol(s) | file:line |
|---|---|
| `DialogDescription` | components/ui/dialog.tsx:82 |
| `EnhancedSelect` | components/ui/select.tsx:76 |
| `getDryerTemp` | lib/cleaning-cycle-report.ts:85 |
| `stopConnectivityEngine` | lib/connectivity.ts:142 |
| `CLEANING_STAGES` (bare export; routes use local aliases) | lib/filter-constants.ts:2 |
| `fetchQueue`, `fetchReviews` | lib/report-review.ts:28,32 |
| `markServerContact` | lib/server-contact.ts:46 |
| `lastSyncStartedAt` | lib/sync-since.ts:298 |
| `themePrimaryBg/PrimaryText/AccentText/PrimaryLightBg/ActiveTab/FocusRing/Shadow` (7) | lib/theme-styles.ts:18-49 |
| `AssetTemplateSlice` re-export | lib/local-context.ts:606 |
| `PipelineStage/PipelineConnection/FilterProfile/PmSchedule/PmScheduleEntry/PmExecution/ChecklistProfile/ChecklistQuestion/EquipmentGroup/EquipmentGroupInstrument` (10 corpse types; `FilterProfile` left over from the Filter-Profiles page removed 2026-06-29) | types/filter.ts:33-158 |

### Frontend — dead **barrel re-export lines** (17, cosmetic; underlying types alive)
- `lib/filter-ops/index.ts:17,24,34,36` — 5 type re-exports nobody imports from the barrel
- `lib/filter-ops/types.ts:39` — duplicate `PendingChecklistQuestion`
- `lib/action-tape/index.ts:33-43` — 11 type re-exports (consumers import functions only)

### Superseded-by-newer (half-wired, 2026-07-02 AHU work — verify rollout final first)
| symbol | file:line | note |
|---|---|---|
| `checkAhuCompletion` (singular) + `AhuCompletionResult` | lib/filter-ops/ahu-completion-check.ts:32,20 | replaced by `checkAhuCompletionBatch`; remove once batch confirmed final |

---

## TIER 4 — UNUSED DEPENDENCIES (verified 0 imports)

| package | workspace | evidence |
|---|---|---|
| `csv-parse` | apps/api | 0 refs in `apps/api/src` |
| `@dnd-kit/core`, `@dnd-kit/modifiers`, `@dnd-kit/sortable`, `@dnd-kit/utilities` | apps/web | 0 imports |
| `signature_pad` | apps/web | 0 imports (digital-signature capture no longer uses it) |

**False positives (KEEP):** `lucide-react` (used by `debug/components/StatusIcon.tsx`),
`tailwindcss` (imported via `app.css`), `graphile-worker` "missing" in apps/api (hoisted from
`packages/queue`), web "missing" `@capacitor/*` + `virtual:pwa-register` (plugin-provided).

---

## TIER 5 — STALE DOCS (mislead readers; rewrite, don't blind-delete)

### Fully stale user-guide docs (describe removed subsystems) — highest doc value to fix
| path | describes (all removed) |
|---|---|
| `docs/user-guide/uns/uns.md` | UNS/ISA-95 |
| `docs/user-guide/telemetry/telemetry.md` | TimescaleDB `digilog_tsdb`, MQTT ingest |
| `docs/user-guide/rule-engine/overview.md` | rule chains (77 node types) |
| `docs/user-guide/alarms/alarms.md` | alarms |
| `docs/user-guide/connectivity/mqtt.md` | Mosquitto :1883 |
| `docs/user-guide/connectivity/device-connectivity.md` | device credentials |
| `docs/user-guide/data-export/data-export.md` | `/api/export/telemetry|alarms|attributes` (no export module exists) |
| `docs/index.md` | nav TOC: "36 modules/68 models/TimescaleDB 7 hypertables" + links all 7 dead guides above |

### Root docs with warning banners but un-pruned bodies
| path | note |
|---|---|
| `README.md` | body still lists rule-chain, MQTT ingest, `packages/db`, `createdb digilog_tsdb` (banner added, body not cleaned) |
| `PROJECT_SUMMARY.md` | same pattern (10 removed-feature hits) |
| `PROJECT_ARCHITECTURE.md` | heaviest — 36 hits, full TSDB/Mosquitto/rule-chain architecture; banner insufficient |
| `docs/user-guide/{entities,templates}` | partial — drop "68 models"/telemetry-schema/alarm-rules lines |
| `docs/deployment-methods/method-{b,d,e}.md` | historical eval docs citing `eclipse-mosquitto:2.0` |

### Orphaned docs (not linked from any nav/doc)
`docs/AUDIT-TRAIL-ACTIONS.md`, `docs/CONFIG_AUDIT.md`, `docs/CHANGE_SERVE_SPA_NO_PROXY.md`,
`docs/EXE_PACKAGING_FEASIBILITY.md` (superseded by memory-linked `tasks/EXE-PACKAGING-PLAN.md`),
`docs/PHARMA_DEPLOYMENT_21CFR.md` (compliance value — keep content, just unlinked), root `bloat.md`
(one-off audit, overlaps `old/docs-superseded/bloat.md`), untracked `APPLICATION_REPORT.md`.

### Broken doc links
`docs/deployment-methods/README.md` → `method-c-wsl2-linux.md` + `method-f-cloud.md` (neither exists).
`apps/web/CLAUDE.md` → stale `routes/checklists/list.tsx` (dir gone).

### Partially-stale tests / skill (rewrite)
| path | note |
|---|---|
| `.claude/skills/manual-tester/` (whole skill) | built around removed telemetry/MQTT/alarms; 35 stale hits in SKILL.md, its 2 scripts dead. Keep only if still manual-testing surviving entity pages |
| `tests/integration/windows-server-stack.test.ts` | MQTT/TSDB portion stale; graphile-worker + PDF assertions valid → rewrite |
| `tests/e2e-scripts/e2e-full-test.sh`, `e2e-functional-test.sh` | mixed live + ingest flows |
| `scripts/verify-windows-deployment.ps1` | strip Mosquitto :1883 check + fix dead `install-on-target.ps1` call |
| root `test-engine.mjs`, `bloat.md` | 0 tracked references — verify intent |

---

## TIER 6 — KEEP BY DESIGN (do NOT delete)

- **`old/**` (157 files)** — intentional archive (except the Tier-0 db-backups security issue).
- **`future/**` (21 md)** — forward-looking design notes.
- **`docs/superpowers/**` (17), `.superpowers/sdd/work/**` (10)** — plans/specs, several memory-linked. sdd/work could move to `old/`.
- **`tasks/*.md`**: 26 memory-linked = KEEP; 67 completed one-offs = archival-candidate (hold, they carry decision provenance).
- **Compliance registry** — `audit-actions.ts` / `audit-templates.ts` entries for removed subsystems (UNS/RETENTION/RULE_CHAIN/ALARM/DEVICE_CREDENTIAL) are **deliberately retained per 21 CFR §11**. Not dead.
- **App icons/splash** — `apps/android/**/res/**` (30), `rfid_scan_app/**/res/**` (10), `apps/web/public/*.png` + `favicon.svg`... wait `logo.jpg`+PWA PNGs used. Keep.
- **~28 backend + ~21 frontend knip "unused exports" are FALSE POSITIVES** — symbol used same-file, only the `export` keyword is redundant. Deleting the symbol would break its own file. (e.g. `themeGradient`, `loadCountedFilters`, `apiClient|api` duplicate — both names imported by ~29 files, `typed-asset-dispatch` internals, all `config-registry` types.)
- **`TRANSPORT_TYPES`/`CREDENTIAL_TYPES`** (packages/shared/src/schemas/assets.ts) + **tape/types.ts** re-export shim — needs-review, not confirmed dead (still wired, semantically orphaned).

---

## NOT COVERED BY THIS AUDIT (honest scope boundary)

This pass covered TS/JS dead code, docs, images, npm deps, and native-app *duplication*. It did
**not** examine these legitimate dead-code categories — recommend a follow-up pass:

- **Prisma schema** — orphan models / enums / columns. This repo has a track record here
  (QrCode + LatestTelemetry dropped 2026-07-01; 6 models in Phase 7). More may exist; unchecked.
- **Permissions / reauth actions / config defs** — 109 perms with heavy churn (many made
  "enforced-only" or removed). Dead/unenforced perms are plausible and were not verified against routes.
- **Native-app internals** (`rfid_scan_app/`, `apps/android` Kotlin/Java) — I found the dead
  *duplicate* (`RFID/`) but did not scan the *live* apps for dead functions / unused resources
  (knip is TS-only; no Kotlin dead-code tool was run).
- **CSS / Tailwind** — unused classes/styles not analyzed.
- **Runtime-only dead code** — routes reachable but never called by any client; needs traffic analysis, not static.

---

## Headline numbers
- **Tier 0 security:** 3 items (2 signing keys, 53 MB PII db-dumps).
- **Tier 1 untracked junk:** ~45 MB / ~217 files (not in git).
- **Tier 2 confirmed-dead files:** ~40 (RFID/ dir=28, init-tsdb.sql, 6 installer scripts, 2 skill scripts, e2e-ingest.sh, 4 orphan svgs, 2 task pngs, +).
- **Tier 3 dead code symbols:** ~10 backend + 22 frontend + 17 barrel re-exports.
- **Tier 4 unused deps:** 6 (1 api + 5 web).
- **Tier 5 stale docs/tests:** ~15 docs + 4 tests/skill.
- **Knip over-report corrected:** ~half its 53 "unused exports" are false positives (used same-file).
