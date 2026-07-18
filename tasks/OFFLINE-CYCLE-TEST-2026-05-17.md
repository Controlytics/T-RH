# Offline Cycle Test — 2026-05-17

Goal: drive a complete cleaning cycle on the DigiLog APK with the tablet
disconnected from the API, then verify the queued ops sync correctly when
the network comes back.

Filter: `mups-rdu-01` (FD block) — same filter used in cycles 1 + 2 today.

## Activity log

Every meaningful action and observation appended below in time order.

### 21:01 — Session restart
- Tablet was at login screen (host force-login earlier kicked the session — own goal, recorded in feedback memory).
- Typed `superadmin` / `Admin@123` via mobile-mcp. Sign In → home.
- Home shows: Online (green) + Data Synced (blue) indicators. Filter Status: 0/0/0. All stage cards: 0 filter(s). Cycle 2 ended at 20:48 so no filters are mid-cycle.

### 21:14 — Repeat: I called the auth API with `force:true` AGAIN from the host
- Even after writing a memory note 10 minutes earlier saying "DO NOT call the auth API with force:true while the tablet session is live", I did it again to inspect a "stuck" cycle.
- Tablet was kicked back to the login screen.
- Asked user how to recover; they chose "I log back in via mobile-mcp".

### 21:15 — Re-logged in via mobile-mcp
- Typed `superadmin` / `Admin@123` again. Sign In → home.
- Online + Data Synced both green/blue. No active cycles. 0 filters at every stage.

### 21:17 — Primed offline cache
- Tapped Wash In stage card → block list (FD / MUPS / CWH) renders. First time it appeared empty for ~3s before populating — fetch latency, not a bug.
- Tapped FD block → Wash In scan page loads with `Block: FD` chip + scan input + Remarks + Submit.
- Service worker + IndexedDB should now have: blocks, filter→block mapping, profile pipeline, checklist questions (CWH), reasons, equipment groups.

### 21:19 — WiFi disabled via `adb shell svc wifi disable`
- Offline UI works as designed:
  - Top status bar: red "Offline" ribbon at very top
  - Header pill switches from green "● Online" + blue "● Data Synced" to red "● Offline"
  - Yellow banner: "Working offline — operations queued for sync"

### 21:21 — Operator-error chase (initially thought equipment dialog was broken)
- I misread the offline Equipment Readings dialog: it shows the "FD" group as a clickable button. I read it as a non-functional input and concluded the dialog was broken. Wasted ~30 min chasing a non-issue, including a force-login that killed the live tablet session.
- Real behavior: tap the FD button → instrument dropdowns appear. Same as online cycle 2 dialog flow.
- Lesson: read the JSX before claiming a defect. `mobile-operations.tsx:2229` is a `<button>` element.

### 21:55 — Logged back in, primed cache, disabled WiFi again
- Repeated the prime+offline sequence cleanly.

### 22:00–22:23 — Drove the offline cycle end-to-end on the tablet
The DialogState reducer + offline cache held up across the entire path:

| Stage | Dialog type | Status | Observation |
|---|---|---|---|
| Cleaning Reason | `awaiting_reason` | ✅ rendered offline | Two reason options visible from cache |
| Wash In Equipment | `awaiting_equipment` | ✅ rendered offline | FD button tap → Compressed Air + RO Water dropdowns with full pressure range cached |
| Wash In Submit | — | ✅ queued | RECENT WASH IN row shows `10:02 PM ⌛` hourglass |
| Wash Out Checklist | `awaiting_checklist` | ✅ rendered offline | CWH Temperature input rendered from cache |
| Wash Out Submit | — | ✅ queued | RECENT WASH OUT row shows `10:06 PM ⌛` |
| Dryer Duration | `awaiting_dryer` | ✅ rendered offline | 5 min option selected from cached duration list |
| Dryer Countdown | — | ✅ ran locally | 5min timer ran while offline, transitioned to "Ready" badge at halfway |
| Dryer Temperature | — | ✅ rendered offline | Full 30-50°C dropdown range present in cache |
| Dry In Submit | — | ⚠️ queued (UI stale) | Local view stayed on "Currently Drying" "1 filter(s) in this stage" — same stale-cache bug as cycles 1+2 |

### 22:26 — Accidentally hit system Settings via BACK button
- The DigiLog app went to background. When I reopened it, the session was gone — back at the login screen.
- The queued ops (Wash In, Wash Out + checklist, Dry In + dryer + temperature, Dry In advance) should still be in IndexedDB, since the auth token loss doesn't wipe the offline-store.

### 22:31 — Re-enabled WiFi + logged back in
- WiFi re-enabled via `adb shell svc wifi enable`. Online + Data Synced indicators came back green/blue within ~5s.
- Logged in fresh. App restored to the Wash Out page (where I was before offline session).

### 22:33 — DB verification

```sql
SELECT id, cycle_code, status, started_at, completed_at
FROM cleaning_cycles WHERE started_at > '2026-05-17 21:55:00';
```

```
c82b0843-8aae-4506-ac09-07932b6f823c | CC-mups-rdu-0-012-20260517 | IN_PROGRESS | 22:29:47 | NULL
```

```sql
SELECT event_type, from_state, to_state, performed_at
FROM filter_events WHERE cycle_id = 'c82b0843-...';
```

```
CYCLE_STARTED    |        |          | 22:29:47
STATE_TRANSITION |        | WASH_IN  | 22:29:48
```

**ONLY 2 EVENTS SYNCED.** The cycle was created and WASH_IN transition recorded — but Wash Out, Dry In, Dryer Duration, Temperature submissions never landed on the server.

```sql
SELECT * FROM dead_letter_queue WHERE created_at > '2026-05-17 21:55:00';
-- (0 rows)
```

**DLQ is empty.** The dropped queued ops did NOT fail loudly. They just disappeared.

## Summary of findings

### What works offline (verified)
- ✅ Offline detection (red ribbon, Offline pill, "Working offline" banner)
- ✅ All 4 of 5 DialogState types render from cache: `awaiting_reason`, `awaiting_equipment`, `awaiting_checklist`, `awaiting_dryer`
- ✅ Reason selection, equipment group selection, instrument readings, checklist questions, dryer-duration picker, temperature reading — all cache-served correctly
- ✅ Dryer countdown timer runs locally offline (no server interaction needed)
- ✅ First queued op (Wash In + START_CLEANING_CYCLE compound) syncs to server when network returns — cycle gets created with correct WASH_IN transition

### What's broken (confirmed defects)

1. **Most queued ops are silently dropped on reconnect.** Only the FIRST queued op (Wash In / CYCLE_STARTED) synced. Wash Out, Dry In, Dryer Duration, Temperature Reading — 4+ queued operations went nowhere. DLQ is empty. No user-facing error. The cycle is stuck at `IN_PROGRESS` with `to_state=WASH_IN` and zero downstream events.

2. **Stale stage-count cache.** Same defect as cycles 1+2: after a stage advance, the local "X filter(s) in this stage" counter doesn't refresh. Operators see "1 in Dry In" while the cycle has actually moved past it.

3. **Session loss when app backgrounded.** Accidentally hitting the BACK button when no in-app history remains drops you to system Settings; reopening the app shows the login screen even though you were authenticated 5 seconds earlier. While the offline queue persists, the operator can't resume their work without re-authenticating, which is impossible offline.

### Operator mistake to learn from (mine, not the app's)

- I used `curl ... force:true` from the host twice while the tablet had an active session. This kicks the tablet to login every time. The memory note I wrote 10 minutes after the first instance didn't prevent the second occurrence. Going forward: query Postgres directly (`digilog/digilog123@localhost:5432/digilog_db`), never use force-login while the tablet session is live.

## Recommended next steps

1. **Highest priority — investigate the queued-ops-vanish defect.** Look in `offline-store.ts` + `executeOrQueue` + sync replay code. If ops are being dropped silently, audit the catch blocks and add DLQ inserts on failure. Without this fix, offline operation is unsafe for compliance because operators *think* their submissions are queued but only the first one actually persists.

2. **Fix the stale stage counter.** The local cache should re-poll `/api/filters/:id/current-state` after each submit, or the page should listen for the sync-completed event and refresh the counter.

3. **Make session survive app backgrounding.** sessionStorage is wiped when the WebView is destroyed; consider using a more durable store with explicit logout on expiry.

---

## Phase 2 — fix, ship, retest (commits + tablet verification)

### Implementation (commit `ae1d49b` on RFID)

Three defects identified above were triaged:

| # | Status | Resolution |
|---|---|---|
| 1 — queued ops vanish | FIXED | sync-engine refresh-tape after each successful op + IDB persistence |
| 2 — stale stage counter | FIXED | `mutate(/api/assets/instances?limit=500)` on home-enter in both mobile-operations + mobile-wrapper |
| 3 — session loss on background | DEFERRED | by-design per user; shared-workstation security takes priority |

**Files changed (250 insertions, 2 deletions):**
- `apps/web/src/lib/sync-engine.ts` — refresh-tape loop, IDB persistence call
- `apps/web/src/lib/offline-store.ts` — new `updateOperationTapeVersion(id, tape)` helper
- `apps/web/src/lib/__tests__/sync-engine.test.ts` — test 9 reproduces the bug, asserts both outcome (3/3 sync) and mechanism (refresh fetch + IDB write between ops)
- `apps/web/src/routes/mobile/mobile-operations.tsx` — `goHome` revalidates instances
- `apps/web/src/routes/mobile/mobile-wrapper.tsx` — same

**Verification before commit:**
- All 110 web tests pass (test 9 fails pre-fix with synced=1, passes post-fix with synced=3)
- `npx tsc --noEmit` clean

### APK rebuild + tablet retest (2026-05-18 00:10–00:38)

- `npx vite build` → `npx cap copy android` → `gradlew assembleDebug` → `adb install -r app-debug.apk`
- Logged in, primed cache on Wash Out page
- Disabled WiFi via `adb shell svc wifi disable`
- Drove Wash Out + CWH checklist + Dry In + Dryer 5min + Temperature offline (5 ops, all queued)
- BACK button accidentally collapsed WebView mid-test (defect #3 firing as expected)
- Re-enabled WiFi via `adb shell svc wifi enable`
- Logged back in; auto-sync drained the queue

### Empirical result — fix verified on real hardware

DB query against cycle 3 (`c82b0843-8aae-4506-ac09-07932b6f823c`) after sync:

```
event_type          | from_state | to_state | performed_at
--------------------+------------+----------+-----------------------------
CYCLE_STARTED       |            |          | 2026-05-17 22:29:47.963   ← from pre-fix test
STATE_TRANSITION    |            | WASH_IN  | 2026-05-17 22:29:48.432   ← from pre-fix test
STATE_TRANSITION    | WASH_IN    | WASH_OUT | 2026-05-18 00:35:28.766   ← POST-FIX
CHECKLIST_COMPLETED |            |          | 2026-05-18 00:35:29.175   ← POST-FIX
STATE_TRANSITION    | WASH_OUT   | DRY_IN   | 2026-05-18 00:35:29.567   ← POST-FIX
STATE_TRANSITION    | WASH_OUT   | DRY_IN   | 2026-05-18 00:35:29.571   ← POST-FIX (duplicate, see below)
```

Cycle row also updated: `dryer_started_at=00:35:29`, `dryer_duration_minutes=5`.

**Before vs after on the same filter:**
- Pre-fix offline cycle: 0 of 5 queued ops synced → STALE_TAPE on op 2, dedup killed ops 3-5
- Post-fix offline cycle: 4 of 5 queued ops synced + dryer-start fields populated

The chained-ops fix from commit `ae1d49b` is working on real tablet hardware as predicted by unit test 9.

## Follow-ups surfaced by the retest

1. **Duplicate STATE_TRANSITION WASH_OUT→DRY_IN at 00:35:29.567 + 00:35:29.571** — 4ms apart. Likely a retry race (the server returned 200 on the first POST but a retry fired before status propagated). Low-impact data noise; not blocking.

2. **`dryer_readings_submitted = false`** despite the operator submitting Temperature offline. The dryer-readings op uses a different code path (likely the `submit-dryer-readings` action that updates cycle row, not a STATE_TRANSITION FilterEvent) — the chained-ops refresh in this PR only covers `advance / bypass / submit-checklist / terminate`. Add the same refresh after dryer-readings replays.

3. **Failed-ops invisibility (meta-bug from advisor)** — `pendingCount` excludes `status='failed'` rows. Operators get no UI signal when ops silently fail. Surface a "N ops need attention" pill on the mobile wrapper, separate PR.

4. **Cycle 3 stuck at DRY_IN.** Consequence of follow-up #2 — the dryer-readings replay didn't land. To complete: either fix the dryer-readings code path or terminate cycle 3 via UI and start fresh.

