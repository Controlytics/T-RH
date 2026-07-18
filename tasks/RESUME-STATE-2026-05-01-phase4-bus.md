# Resume State — 2026-05-01 — Phase 4 (Redis retirement) complete

## Where the tree is
- **Worktree:** `C:\Users\hello\21cfrlogbook-DigitalFMS\.worktrees\phase5-verification`
- **Branch:** `feature/phase5-verification`
- **HEAD:** `19a5454` — `docs: full sync after Phase 4 — Redis fully retired`
- **Working tree:** clean (no uncommitted tracked changes)
- **Untracked:** ~50 PNG screenshots from earlier UI walks; safe to ignore.

## Push status
GitHub (`github.com:443`) **unreachable from this network** — has been the entire session. ~30 commits ahead of `origin/docsCleaned`, all sitting locally. Push when network returns:
```
git push origin feature/phase5-verification
```

## What just shipped (this session)
1. **Phase A.1** — ChecklistProfile universal versioning (snapshot-then-bump, `cycle.checklistVersionPins`, version routes, immutable replay) — commit `2d587ba`.
2. **Phase 5b.4 + 5b.5** — SELECT FOR UPDATE on cycle in advance/bypass; PG invariants (one in-progress cycle per filter, FilterEvent.filterId == cycle.filterId, AssetRelationship pair invariant) — commit `f9643ed`.
3. **Phase 5b B2** — pre-replay `ensureCycleAlive()` + `CYCLE_BOUND_OPS` set in sync-engine; stranded ops fail fast — commit `e79c2be`.
4. **Step 2** — `relationshipType` String → enum with bidirectional pair trigger — commits `51e1110`, `714afd4`.
5. **Phase 4** — Redis fully retired (`ioredis` uninstalled, `internal-bus.ts` EventEmitter wrapper, `rpc-cache.ts` Map+TTL, all ws/trace/rpc/debug-recorder paths migrated, env vars removed, deployment-check Redis row dropped, 6 test files migrated) — commits `cd03de3`, `19a5454`.

## Verification done
- `apps/api/dist/app.js` builds clean (TypeScript).
- `npm test --workspace apps/api` — bus migration tests pass; only pre-existing failures remain.
- 13-page UI walk on local dev (login → dashboard → alarms → debug-traces → filter-ops → system-health → notifications → cleaning-cycles → audit → filters → checklists → cleaning-profiles → config). Zero new console errors. The single 409 console message is intentional `SESSION_CONFLICT` protocol signaling that login.tsx handles via the active-session dialog — not a bug, not Phase-4-induced.
- System Health Db tables = 66 (matches schema). No Redis row in deployment-check output.

## What's next (in priority order)
1. **Push the local commits** when GitHub network returns.
2. ~~**Phase A.2** — FilterCleaningProfile versioning~~ ✅ **DONE 2026-05-01** — `lineageId` + version-history endpoints. See CHANGELOG entry "Phase A.2: FilterCleaningProfile lineage-based versioning."
3. **Phase A.3** — FilterProfile versioning.
4. **Phase A.4** — cleaning-reasons + equipment-group versioning.
5. **Step 4** — applicableTemplates JSONB → join table (touchpoint inventory pending).
6. **Step 7** — multi-version pipeline rollout (deferred for product/regulatory call).
7. **Steps 8 + 9** — decision-tape architecture and cycle-as-event-fold (multi-week, blocked on Step 8).

## Files most-likely-needed for the next session
- `apps/api/src/lib/internal-bus.ts` — bus interface; swap implementation here for multi-process scale-out.
- `apps/api/src/lib/rpc-cache.ts` — TTL cache; replace with PG LISTEN/NOTIFY + table when scaling.
- `apps/api/src/modules/checklist-profiles/checklist-profile.service.ts` — versioning template for A.2/A.3/A.4.
- `apps/api/prisma/schema.prisma` — 66 models, 23 enums, includes `ChecklistProfileVersion` reference for next versioning targets.
- `apps/api/prisma/sql/invariants.sql` — DDL for the row-level invariants; add new ones here.
- `tasks/STEP-5B-A-VERSIONING-PLAN.md` — full plan for the universal versioning rollout.
- `tasks/STEP-6-FILTERDETAILS-PLAN.md` — closed; reference pattern only.

## Local-dev sanity check on resume
```powershell
# 1. Confirm services
Get-Service DigiLogAPI-Phase5, DigiLogWeb-Phase5

# 2. Curl health
curl.exe -sk -o NUL -w "%{http_code}`n" https://localhost:3000/health  # 200

# 3. Login UI
# -> https://localhost:5175/login   (superadmin / Admin@123)

# 4. Verify Redis is actually gone
findstr /S /M "ioredis" apps\api\src apps\api\package.json
# Should return: <nothing>
```

## Known network constraint
GitHub push has failed for the entire conversation. If still failing on resume, run:
```
git remote -v
git config --get http.proxy
ping github.com
```
If unreachable, defer push until network returns; commits stay safe locally.
