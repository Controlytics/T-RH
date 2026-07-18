# Resume — 2026-04-30 evening (Step 1 done + doc-sync done; nothing committed)

If you're reading this in a NEW or post-compact session, this is your cold-start guide.

## TL;DR

Mid-execution of a 9-step architectural refactor plan. **Step 1 (templateKind enum → admin-editable lookup table) is done and live, AND its doc-sync is also done** (per `feedback_doc_sync_each_phase`). Plus a backlog of earlier deep-fix work also uncommitted.

`feature/phase5-verification` is at `d1ce9f5` (last committed). **~55 files modified + 6 new files, NONE committed yet** per user's "Q4: don't commit" instruction.

The DB has been reset (force-reset) and re-seeded once already during step 1; data on the live system is what step 1 created.

The Step 1 doc-sync (per the always-update-on-feature-change rule) touched: CHANGELOG.md, root CLAUDE.md, apps/api/CLAUDE.md, packages/shared/CLAUDE.md, BACKEND_GUIDE.md, API_REFERENCE.md, FRONTEND_GUIDE.md, PROJECT_SUMMARY.md, PROJECT_ARCHITECTURE.md, tasks/todo.md, plus a new future/architectural-refactor-9-steps.md.

---

## Branch + worktree state

**Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
**Branch:** `feature/phase5-verification`
**HEAD:** `d1ce9f5` (last commit; everything since is uncommitted)

### Recent commit chain (read top→bottom = newest to oldest)
```
d1ce9f5 feat(deploy): NSSM-managed Windows services for API + frontend  (runaway agent — already approved by user)
1697f99 fix(api): resolve 4 TypeScript build errors                     (runaway agent — fixes are real)
99c0270 docs: capture Phase 5.1 reviewer cycle                          (autonomous)
98023bd docs: fix Phase 5 doc-sync follow-ups
29712d6 docs: Phase 5 full doc-sync sweep
24620c0 test(integration): fix MQTT race, surface cleanup errors        (Phase 5.1 final)
ad07280 fix(verify): restore TLS state, avoid 2>&1 on psql              (Phase 5.2 final)
```

### Uncommitted (45 modified + 5 untracked)
**Step 1 work:**
- `apps/api/prisma/schema.prisma` — TemplateKind enum dropped + new TemplateKind model
- `apps/api/prisma/seed.ts` — seeds 6 system kinds
- `apps/api/src/app.ts` — registers `/api/template-kinds`
- `apps/api/src/modules/template-kinds/routes.ts` — NEW file (CRUD module)
- `apps/api/src/modules/assets/routes/template.routes.ts` — body schema accepts templateKind as string (not enum)
- `apps/api/src/modules/assets/services/template.service.ts` — passes templateKind through create + update
- `apps/api/src/modules/assets/repositories/template.repository.ts` — bug fix: type signature had it but `data:{}` block was dropping it; now persists templateKind (this was the silent failure that the live API test caught)
- `packages/shared/src/schemas/assets.ts` — SYSTEM_TEMPLATE_KIND_CODES + create/update zod schemas + templateKindCodeSchema regex
- `packages/shared/src/index.ts` — barrel exports for new schemas
- `apps/web/src/routes/assets/template-types.ts` — TemplateKind type, FormData.templateKind, emptyForm() default
- `apps/web/src/routes/assets/templates.tsx` — Kind column, kindLabelByCode lookup, hydrates+sends templateKind
- `apps/web/src/routes/assets/components/template-form-editor.tsx` — SWR-driven dropdown with system-fallback
- `apps/web/src/routes/config/template-kinds.tsx` — NEW config page (CRUD UI)
- `apps/web/src/main.tsx` — route registered with CONFIG_UPDATE perm gate
- 10 frontend lookup-site rewrites (`templates.find(t => t.name === 'Block')` → `templateKind === 'BLOCK'`) across filter-list, filter-operations, mobile-operations, mobile-wrapper

**Earlier deep-fix work still uncommitted (from before step 1):**
- 8 backend exception-swallow sites fixed with structured logging
- 1 real bug fix in `org-detail-routes.ts` (DELETE returning 200 success when row didn't exist; now returns proper 404)
- `instance.service.ts` parent-org inheritance fix (eliminates orphan-entity drift)
- `template.repository.ts` ordering by isActive/instances-count/createdAt (real templates surface above e2e fixtures)
- `session.def.ts` 15-min idle timeout documented as 21 CFR Part 11 default
- `start-digilog.bat` rewritten dynamic paths + Memurai non-fatal
- `backfill-orphan-entity-orgs.sql` (NEW) — idempotent SQL backfill for orphan entities
- `assignments-tab.tsx` (NEW) — Entity Assignments UI tab
- `entity-detail-panel.tsx` — wired Assignments tab
- `tabs/index.ts` — exports AssignmentsTab
- `dashboards/routes.ts` — future-scope STATUS docblock
- `future/feature-dashboards.md` (NEW) — future-scope plan doc
- 4 doc files — `/api/filter/cycles` → `/api/filters/cycles` doc drift fix
- 10 frontend `templates?limit=100` → `?limit=1000` (tour fix)
- `apps/api/.env` — multiple env vars (ALLOWED_ORIGINS for HTTPS, USE_MOSQUITTO=true, MOSQUITTO_*, NODE_ENV=production)
- `apps/web/src/hooks/use-entity-websocket.ts` — exception logging
- `packages/shared/src/schemas/assets.ts` — `assetQuerySchema/templateQuerySchema.limit.max(1000)` (was 100)

**Untracked (5 new files):**
```
apps/api/src/modules/template-kinds/
apps/web/src/routes/assets/components/tabs/assignments-tab.tsx
apps/web/src/routes/config/template-kinds.tsx
future/feature-dashboards.md
scripts/backfill-orphan-entity-orgs.sql
```

---

## Live system state

**Services (NSSM-registered Windows services from runaway agent's `d1ce9f5`):**
- `DigiLogAPI-Phase5` — Running, on `https://localhost:3000`
- `DigiLogWeb-Phase5` — Running, on `https://localhost:5175`
- `mosquitto` — Running, on `tcp://localhost:1883`

**Databases:**
- `digilog_db` — Postgres 18, currently empty except for fresh seed: 6 roles, superadmin user, default config, 6 system template kinds, **4 canonical entity templates** (Block/Area/AHU/Filter), 0 entities, 0 cycles, 0 events. Reset via `prisma db push --force-reset` during step 1.
- `digilog_tsdb` — TimescaleDB. All 6 hypertables truncated.

**Login:** `superadmin` / `Admin@123` (per seed)

**Env (`apps/api/.env` snapshot of relevant lines):**
- `NODE_ENV=production`
- `USE_MOSQUITTO=true`
- `MOSQUITTO_ADMIN_PASSWORD=DigiLogPhase5MosquittoAdmin2026`
- `MOSQUITTO_REFRESH_TOKEN=DigiLogPhase5RefreshToken2026`
- `MOSQUITTO_DYNSEC_PATH=C:/Users/hello/21cfrlogbook-DigitalFMS/.worktrees/phase5-verification/mosquitto/dynamic-security.json`
- `ALLOWED_ORIGINS=https://localhost:5175,https://localhost:3000,https://192.168.1.22:5175,https://192.168.1.22:3000,http://localhost:5175,http://localhost:5173,http://localhost:3000,capacitor://localhost`

**Mosquitto dynsec:** regenerated during the tour with the password above. The dynsec lives at the repo path AND a copy at `C:\Program Files\mosquitto\dynamic-security.json` (the broker reads from there). After every `POST /api/internal/mqtt/refresh-acl`, the copy step + Restart-Service mosquitto must happen.

---

## The 9-step refactor plan (from user's Option B/skip-#5 decision)

| Step | Item | Status | Why this position |
|---|---|---|---|
| **1** | templateKind enum | ✅ DONE | Foundational |
| 2 | relationshipType Prisma enum + bidirectional check | pending | Small, independent |
| 3 | AssetInstance.organizationId NOT NULL | pending | Schema-level; before step 6 |
| 4 | applicableTemplates JSONB → join table (allowedBlocks stays JSONB) | pending | Small |
| 5 | INVESTIGATE two checklist systems before deciding | pending | No-op possible |
| 6 | FilterDetails 1:1 split off AssetInstance | pending | Invasive |
| 7 | Multi-version pipeline rollout (per-block) | pending | Feature add |
| 8 | Decision-tape architecture | pending | Biggest |
| 9 | Cycle as event fold (event-source CleaningCycle) | pending | Depends on #8 |

(Skipping original #5 = filter_events partitioning per user's call.)

User's hard rules:
- "delete all data and create again" — DB resets are OK
- "don't worry about migration" — schema-level rebuilds are OK
- "operational expectation and functionality should remain as expected" — features must keep working
- Q4 standing instruction: **don't commit yet** — accumulate uncommitted work

For each step, pattern is:
1. Enumerate touchpoints (UI, backend, all user types)
2. Implement
3. Reset DB if needed + reseed
4. Test all touchpoints across user types

---

## What's running RIGHT NOW (live state)

The Configuration → Template Kinds page works. URL: `https://localhost:5175/config/template-kinds`. Shows all 6 system kinds with 🔒 System badges. +New Kind button. Templates list at `/assets/templates` shows the Kind column. Create-template form has the Kind dropdown.

If you reset the DB again (which step 2 may require), seed.ts now creates the 6 system kinds automatically. The 4 canonical templates need to be re-created via API or via UI; here's the curl to do all 4 (using the actual current Mosquitto/JWT setup):

```powershell
$login = Invoke-RestMethod -Uri "https://localhost:3000/api/auth/login" -Method Post -ContentType "application/json" -Body '{"username":"superadmin","password":"Admin@123","force":true}'
$tok = $login.token
$names=@('Block','Area','AHU','Filter'); $kinds=@('BLOCK','AREA','AHU','FILTER')
for ($i=0;$i -lt 4;$i++) {
  $body = "{`"name`":`"$($names[$i])`",`"templateKind`":`"$($kinds[$i])`",`"category`":`"Building`",`"attributeSchema`":[],`"telemetrySchema`":[],`"expectedIdentifiers`":[],`"expectedRelationships`":[],`"statusLifecycle`":[],`"alarmRules`":[],`"checklistSchema`":[]}"
  Invoke-RestMethod -Uri "https://localhost:3000/api/assets/templates" -Method Post -ContentType "application/json" -Headers @{Authorization="Bearer $tok"} -Body $body
}
```

(Cert-trust setup may be needed; see prior tour resume notes for the `TrustAllCerts` boilerplate.)

---

## Resume prompt to use post-compact

```
Resume the 9-step refactor plan from tasks/RESUME-STATE-2026-04-30-step1-templateKind-done.md.
Step 1 (templateKind admin-editable lookup) is done. We have 44 files modified +
5 untracked, NOT committed (per Q4 = don't commit yet).

Branch: feature/phase5-verification at d1ce9f5 + 45 uncommitted file changes.
Live: DigiLogAPI-Phase5 + DigiLogWeb-Phase5 + mosquitto all Running.
Login: superadmin / Admin@123.

Next: Step 2 — relationshipType Prisma enum + bidirectional check. Touchpoints
to enumerate before code: schema (relationshipType is currently String VarChar(50)
on AssetRelationship at line 536), all services that write relationships
(assets, filter-operations, hierarchy), entity-detail Relationships tab in UI,
and the existing INVERSE_RELATIONSHIP_MAP in packages/shared. Strong constraint:
preserve bidirectional pair invariant.
```

---

## Things to NOT touch

- `main` branch (user instruction long-standing)
- Files in `apps/web/dist/`, `apps/api/dist/` (compiled — regenerate, don't edit)
- The 6 system template kind rows in DB (their `code` is API-protected)
- The runaway agent's commits `1697f99` + `d1ce9f5` (user explicitly chose to keep these)
- The `nssm-path.txt` + `logs/` dirs (gitignored, locally generated)

## Pre-existing issues NOT addressed (for awareness)

- `ts_telemetry` Stage-9 write loss (per prior resume notes; separate investigation)
- AWS SNS spawn-aws-CLI in `notification-delivery/channels/sms-channel.ts:75` (only affects sites that opt into AWS SMS channel)
- POSIX SIGTERM/SIGINT handlers in `app.ts` (Windows NSSM force-kills; works but graceful-shutdown code never runs)

## Memory entries that informed this session

- `feedback_doc_sync_each_phase` — per-phase doc-sync rule
- `feedback_test_no_mock_db` (implicit) — no-mock-DB rule for tests
- `feedback_codemod_className_merge` — merge instead of duplicate
- `feedback_pre_deletion_rule` — read content before deleting

Safe to compact now.
