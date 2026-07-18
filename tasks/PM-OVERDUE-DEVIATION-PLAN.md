# PM Overdue Deviation + Notification Workflow — Plan

Branch: RFID. Checkpoint before start: `d93c9e8`.

## Decisions (locked with user 2026-06-03)
- **Completion flow:** Acknowledge → clean → auto-close. My Tasks overdue "Perform"
  shows warning + password dialog → records acknowledgment on the deviation →
  operator runs the normal cleaning cycles → deviation auto-closes when all the
  AHU's counted filters are actually cleaned. (Derived-completion / 21 CFR intact.)
- **Notify whom:** Configurable role(s) via a PM Schedule Settings field
  (`overdueNotificationRoles`). Default `["ADMIN"]`.
- **Notifications surface:** BOTH web (existing page) and tablet (new mobile
  notification center).
- **Overdue-day display:** `today − plannedDate` (user formula). Deviation is
  *created* when the tolerance window closes (`windowEnd < now`), consistent with
  the existing /due "overdue" classification.

## Architecture (advisor-endorsed)
- The **Deviation row is the single state machine.** Notifications/closure are
  driven off its transitions; cycle-write paths (advance/submit-checklist) are
  NOT touched.
- One `sweepOverdueDeviations()` does OPEN (insert on-conflict-do-nothing per
  `pmScheduleEntryId`) + CLOSE (all counted filters have a completed cycle after
  the deviation opened). Notifications fire only on insert / only on close,
  guarded by `notifiedAt` / `completionNotifiedAt`. Idempotent by construction.
- Trigger: daily cron (`pm_overdue_check`) **+ manual admin endpoint**. NO writes
  in `GET /due` (read path only reads deviation state). Closure latency ≤ the
  /due 30s poll — acceptable.
- DB changes via **psql DDL** (db push blocked by pre-existing enum drift).

## Data model — `deviations` table (new)
- `id` uuid pk, `deviation_number` text unique (DEV-000001)
- `pm_schedule_entry_id` uuid UNIQUE (task_id), `ahu_id` uuid, `ahu_name`,
  `filter_ids` jsonb, `filter_count` int
- `scheduled_date` date, `window_end` date, `overdue_days_at_open` int
- `assigned_user_id` uuid null
- `status` text (OPEN | ACKNOWLEDGED | CLOSED)
- `acknowledged_by` uuid null, `acknowledged_at` tz null, `password_verified` bool
- `notified_at` tz null  (overdue notification guard)
- `completed_by` uuid null, `completed_at` tz null, `delay_days` int null,
  `closed_at` tz null, `completion_notified_at` tz null  (completion guard)
- `created_at` tz, `updated_at` tz
- enum additions: `NotificationType += PM_OVERDUE, PM_OVERDUE_COMPLETED`

## Phases / tasks
1. **DB**: psql DDL — `deviations` table + indexes + enum values; Prisma model +
   `prisma generate`. NotificationType union in `createNotification` extended.
2. **Sweep service** (`pm-schedules/pm-deviations.ts`): `sweepOverdueDeviations()`
   (open+close+notify, idempotent), `listDeviations()`, `acknowledgeDeviation()`,
   `getOverdueContextForEntries()` (read helper for /due). Audit logs on
   create/acknowledge/close.
3. **Wiring**: cron task `pmOverdueCheckTask` + crontab line + app.ts taskList;
   routes — `POST /deviations/sweep` (admin), `GET /deviations` (list),
   `POST /deviations/:id/acknowledge` (reauth). `/due` joins deviation context.
4. **Config**: `overdueNotificationRoles` in pm-schedule-settings def + UI.
5. **Permissions/seed**: `DEVIATION_VIEW` (+ maybe `DEVIATION_MANAGE`), reauth
   action `ACKNOWLEDGE_PM_OVERDUE`, sidebar item `deviations`, role arrays,
   shared rebuild.
6. **Web My Tasks**: overdue-by-N-days, acknowledge+password dialog → navigate to
   ops; acknowledged state badge.
7. **Web Deviations page**: list with full fields + audit columns.
8. **Tablet**: notification center (bell + unread badge + list) in mobile-wrapper;
   overdue tasks visible.
9. **Tests**: sweep idempotency (no dupes), acknowledge reauth, overdue-day math,
   close-on-completion.
10. **Verify**: psql data checks + manual sweep endpoint + Playwright (My Tasks
    dialog, Deviations page, notifications) + APK rebuild for tablet.

## Progress (2026-06-03)
- ✅ **Phase 1 (DB)** — `deviations` table (psql DDL, 26 cols incl. window_start) +
  `deviation_status` enum + `deviation_number_seq` + `NotificationType +=
  PM_OVERDUE/PM_OVERDUE_COMPLETED`. Prisma model + generate verified
  (`prisma.deviation.count()=0`). `createNotification` union extended.
- ✅ **Phase 2 (sweep service)** `pm-deviations.ts` — sweepOverdueDeviations
  (open+close+notify, idempotent), acknowledgeDeviation, listDeviations,
  getDeviationContextForEntries. `DEVIATION_OPENED/CLOSED` added to
  SYSTEM_AUDIT_ACTIONS.
- 🔄 **Phase 3 (wiring)** — DONE: `pmOverdueCheckTask` worker + app.ts taskList +
  crontab (`0 3 * * *`); routes `POST /deviations/sweep` (PM_UPDATE),
  `GET /deviations` (PM_READ), `POST /deviations/:id/acknowledge` (PM_READ +
  reauth `ACKNOWLEDGE_PM_OVERDUE`, added to shared). **LIVE-VERIFIED**: sweep
  opened 9 deviations from 10 overdue entries, 2nd sweep opened 0 (idempotent),
  9 PM_OVERDUE notifications to ADMIN with correct wording. Job runner runs in
  dev (registered pm_overdue_check). PENDING: `/due` join (overdue-days +
  acknowledged state); close-path live test.
- ✅ **Phase 3 close + reauth** — LIVE-VERIFIED: close path (insert completed
  cycle → sweep closed deviation, completedBy=acknowledger, delay_days, completion
  notification PM_OVERDUE_COMPLETED); `/due` join carries deviation context
  (deviationNumber/status/liveOverdueDays/acknowledged). Password gate verified
  (no-pw→REAUTH_REQUIRED, wrong→REAUTH_FAILED, correct→ACKNOWLEDGED).
- ✅ **Phase 4 (config + reauth)** — `overdueNotificationRoles` multiselect added
  to pm-schedule-settings def (default ["ADMIN"], dynamicOptionsSource
  /api/roles/active). Acknowledge password gate made INTRINSIC via new
  `enforceReauthAlways()` (compliance gate, not admin-toggleable) — verified it
  fires with NO action-reauth config entry. NOTE: action-reauth seed stays empty
  by design; no seed change needed. DEVIATION_VIEW perm + sidebar item moved into
  Phase 5 (built with the Deviations page).

- ✅ **Phase 5 (web)** — PLAYWRIGHT-VERIFIED. My Tasks: overdue cards show
  "Overdue by N days" + "Acknowledged by X" badges; Perform on an unacknowledged
  overdue task opens the password dialog ("These AHU-02 filters are already
  overdue by 18 days (4 filters). Please confirm with your password to
  continue." + DEV number) → correct password → acknowledge persisted →
  navigates to /filters?ahuId. New **Deviations** page (`routes/deviations/`) —
  full audit table (Deviation#/AHU/Filters/Scheduled/Overdue/Status/AckBy/
  CompletedBy/Completed/Delay) + status tabs. Sidebar item `deviations` +
  SIDEBAR_PRIVILEGE_MAP (pm.view/pm.approve) + sidebar-items.ts + main.tsx route
  (PM_READ/PM_APPROVE). Gated GET /deviations on PM_READ. 0 console errors.
  NOTE: kept existing PM_READ gating (no new DEVIATION_VIEW perm) to avoid the
  full permissions/privilege/seed dance — revisit if a dedicated perm is wanted.
  Role-config sidebarItems lists NOT seeded with 'deviations' (perm-gating
  covers roles without an explicit list; SUPER_ADMIN sees all).

- ✅ **Phase 6 (tablet)** — PLAYWRIGHT-VERIFIED at /m. Notification bell + unread
  badge (showed 42) in mobile-wrapper header; new 'notifications' view lists all
  notifications with PM_OVERDUE (warning) + PM_OVERDUE_COMPLETED (check) icons,
  exact wording, timestamps; tap → mark read (badge 42→41); "Mark all read".
  0 console errors. NEEDS APK REBUILD for the physical tablet.
- ✅ **Phase 7 (tests)** — `__tests__/pm-deviations.test.ts` 10 tests (dayDiff
  math, open+notify, P2002 idempotency, no-open-when-cleaned, skip-DISABLED,
  close+completion-notif, no-close-while-uncleaned, acknowledge records/guards).
  Full regression: API tsc clean + 167 tests pass (18 files). Plus extensive
  live + Playwright e2e across all phases.

## ✅ FEATURE COMPLETE (all 7 phases). Remaining ops:
- APK rebuild (`cap copy` + gradlew) so the tablet gets the notification center.
- Commit (still uncommitted; recovery point d93c9e8).

### Live dev-DB state after verification
- 9 deviations exist (real overdue PM entries). 3 CLOSED during close-test
  (their filters had genuine recent cleanings), a few ACKNOWLEDGED from
  reauth tests, rest OPEN. Synthetic test cleaning_cycles removed.
- PM_OVERDUE (9) + PM_OVERDUE_COMPLETED notifications exist (forRole ADMIN).

## Notes / risks
- `USE_PG_QUEUE` not set locally → cron won't fire in dev; the manual sweep
  endpoint is the dev/test path.
- `completed_by` = `acknowledged_by` if set, else the performer of the last
  completing cycle.
- Tablet change needs an APK rebuild to land on device.
