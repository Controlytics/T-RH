# Manual Test Guide — Golden Paths

Step-by-step scripts that QA can run without prior context to verify the primary flows work. All of these have been implemented and demonstrated (commit history on branch `RFID` through 2026-04-20 confirms). If any step fails, the system is broken — do not rationalise.

For the full 25 × 25 TC/EG library, see `tests/manual-test-cases/` and `tests/test-execution-guides/`.

Prereqs for every scenario:

- Browser: latest Chrome on a decent network
- API is running on `http://localhost:3000` (or the configured dev host)
- Web is running on `http://localhost:5173`
- Logged in as `superadmin` / `Admin@123` (seeded) unless the scenario says otherwise
- Android tablet / emulator with `DigiLog-FilterOps.apk` installed for RFID + offline scenarios

---

## 1. First login + session

1. Navigate to `/login`.
2. Enter `superadmin` / `Admin@123`.
3. Expect redirect to `/` (dashboard).
4. Sidebar shows every module you have access to; header shows notification bell + user menu.
5. Open a **second** tab on `/` — expect a "Session already open elsewhere" block (single-tab rule).
6. Close second tab; first tab continues to work.

## 2. Create a filter instance

1. Go to `/assets/templates`, create or pick a filter template with a couple of attributes (e.g. `MicrobialLoad`, `DifferentialPressure`).
2. Go to `/assets` → Create instance.
3. Verify the create dialog renders fields from the template's `attributeSchema` (not a hardcoded form).
4. Required fields block submission.
5. After creation, the new filter appears in the list and in `/filter-list`.

## 3. Run a cleaning cycle (online, desktop)

1. In `/filters`, pick a filter with an assigned cleaning profile.
2. Click **Start Cycle**. Pick a reason (loaded from `/api/filters/reasons`).
3. Advance through stages. A CHECKLIST stage triggers a dialog — answer and submit.
4. Attempt `Advance` with a pending checklist — server must block with 409 / 400.
5. At the last stage, cycle auto-completes and transitions to the END node.
6. Check `/cleaning-cycles` — the new cycle is listed with its full timeline.
7. Open the cycle detail — every stage event is present with user, timestamp, and any deviation remark.

## 4. Bypass a stage (deviation)

1. Start a new cycle.
2. On a stage, click **Bypass**. Enter a reason (remarks mandatory).
3. Confirm audit log captures the bypass with who/when/why.

## 5. Offline replay (tablet)

1. Install the APK; launch and log into `/m`.
2. Wait for "Data Synced" indicator to show (means filters + templates + reasons + identifiers are cached).
3. Turn the tablet to airplane mode.
4. Start a cycle on a filter and advance through two stages. Submit a checklist.
5. The pending counter increments; actions stay visible locally.
6. Turn airplane mode off.
7. Within ~15 s (the health-poll interval) the sync engine replays queued ops FIFO. Counter goes to 0.
8. Open `/cleaning-cycles` in the web UI — the cycle is present, and each event's timestamp matches the time the tablet recorded (not the replay time) because the server honours `offlinePerformedAt`.

## 6. RFID scan (tablet)

1. On `/m`, tap **Scan** on a filter card. The scan dialog opens.
2. Present an assigned tag to the reader. The tag debounces at 300 ms; the dialog confirms the filter name and parent AHU.
3. Present a non-assigned tag — expect an error popup ("identifier not mapped") rather than random characters leaking into the dialog.
4. On a non-RFID input (e.g., the reason text field), scanning must **not** pollute the field — RFID keyboard guard blocks it.

## 7. PM schedule upload + approval

1. As an admin, go to `/pm-schedules`.
2. Download the CSV template (`GET /api/pm-schedules/template.csv`).
3. Fill in one row with a future date and upload.
4. The row appears in the pending list.
5. As an approver (another user), go to `/approvals` and approve the entry with a mandatory remark.
6. The entry moves to the approved list; the scheduled task appears under the assigned user's `/my-tasks`.

## 8. Admin request → approval

1. As an admin with `USER_CREATE` permission, go to `/admin-requests`.
2. Create a "Create User" request with a requester Employee ID (required).
3. Log in as a super-admin approver.
4. Approve the request. Confirm the new user actually exists (`/users`) — the approval **executes** the creation.
5. Check `/audit` — one audit row for the request creation, another for the executed action. UUID is hidden.

## 9. Block change request (cross-block)

1. As a user, request a block change on a filter you don't own.
2. As the block owner, open the approvals popup and approve with a mandatory remark.
3. The request is consumed (single-use — retrying should fail).
4. The filter's block is updated.

## 10. Report generation + signature

1. In `/report-templates`, pick an active template.
2. Go to `/reports/generate`, select the template, choose a date range, click Generate.
3. Back in `/reports`, the report shows as pending. Open it.
4. Click Sign — reauth prompt (21 CFR). Enter password.
5. The report shows as signed with your name + timestamp + signature line.
6. Download PDF — verify header/footer use the configured report-settings (logo, company, page numbers).

## 11. Backup + restore (destructive — do NOT run on prod)

1. In `/config/backup`, click **Export**. Wait for the ZIP (covers all 64 tables).
2. Import the ZIP back as a restore.
3. After restore, check `/config/roles` — the roles table may need reseeding if permissions look stale (known quirk).

## 12. Theme switch

1. In `/config/branding`, change the theme preset to `Sunset`.
2. Save. All CSS variables (`--theme-primary`, etc.) update across the app without reload.
3. Log out and back in — the theme persists.

---

## Pass criteria

Each scenario above is considered **pass** when every step succeeds and no console errors or audit gaps are observed. Intermittent failures indicate a bug that must be root-caused — do not retry in a loop and claim success. (`CLAUDE.md` is explicit about this.)
