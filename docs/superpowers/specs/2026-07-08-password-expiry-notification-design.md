# Password Expiry Notification — Design

**Date:** 2026-07-08
**Branch:** RFID
**Status:** Approved

## Goal

Add **one** admin-configurable setting in *General & Password Settings* that
drives per-user password-expiry warnings. If an admin sets it to `5`, then each
affected user receives a notification **every day for the 5 days before** their
password expires, a one-time **"password expired"** notice on the expiry day,
and the existing login block still enforces the actual expiry. Only the user
whose password is expiring receives these notifications.

## Requirements

1. New setting `expiryNotificationDays` (integer, `0` = feature off, default `0`)
   in the *Expiry* group of *General & Password Settings*.
2. When `expiryNotificationDays = N` and `passwordExpiryDays > 0`, an affected
   non-SUPER_ADMIN user gets **one warning per day** on each of the `N` days
   before expiry (days `N, N-1, … 1` remaining).
3. On the expiry day (0 days remaining / already expired), a **one-time** "password
   has expired" notice is sent to **both the user and the ADMIN role** (the user is
   blocked at login once expired and can't otherwise see it; the admin can reset it).
   Fired once per expiry event, not daily; each side deduped independently.
4. Notifications are **per-user** — `forUserId = username`. No other user sees
   them.
5. SUPER_ADMIN is excluded (already exempt from expiry). `passwordExpiryDays = 0`
   or `expiryNotificationDays = 0` disables the feature.
6. Idempotent: a restart, backfill, or manual re-run must not duplicate a day's
   notification.

## Existing pieces reused

| Piece | Location | Note |
|---|---|---|
| Expiry setting | `password-policy.def.ts` → `passwordExpiryDays` | config key `password-policy` in `systemConfig` |
| Expiry math | `lib/password-expiry.ts` `isPasswordExpired()` | anchor = `max(passwordChangedAt‖createdAt, policy.updatedAt)`; expiry = `anchor + days` |
| Login enforcement | `auth.service.ts` | sets `forcePasswordChange`, audits `PASSWORD_EXPIRED`, blocks login; SA exempt |
| Notifications | `createNotification()` + `NotificationType` enum | `forUserId` targets one user |
| Daily cron model | `pm-overdue.worker.ts` + `crontab.txt` + `app.ts` taskList | idempotent daily sweep — the pattern this feature copies |

## Design

### 1. Config setting
Add to the *Expiry* group in `password-policy.def.ts`:
```
{ key: 'expiryNotificationDays', type: 'number', label: 'Password Expiry Notification (days)',
  min: 0, max: 90, default: 0, group: 'Expiry' }
```
Mirror in the zod schema (`packages/shared/src/schemas/config.ts`) and render on
the custom page (`config/password-policy.tsx`).

### 2. Expiry math helper
Add to `lib/password-expiry.ts`, reusing the **same anchor logic** as
`isPasswordExpired` so warnings and the block agree exactly:
```ts
// whole days from now until expiry; negative = already expired; null = no expiry
export function daysUntilPasswordExpiry(
  passwordChangedAt: Date | null, createdAt: Date,
  passwordExpiryDays: number | undefined | null, policyUpdatedAt: Date | null,
): number | null
```
Factor the shared anchor computation out of `isPasswordExpired` so both
functions call it (single source of truth for the anchor).

### 3. Notification types
Add two values to the `NotificationType` Prisma enum:
`PASSWORD_EXPIRY_WARNING`, `PASSWORD_EXPIRED_NOTICE`. Hand-authored migration
`ALTER TYPE "NotificationType" ADD VALUE …` (both). Add both to the
`createNotification` union type.

### 4. Daily sweep
New `sweepPasswordExpiryNotifications()` (own lib module). Logic:
- Read `password-policy` config → `passwordExpiryDays`, `expiryNotificationDays`,
  policy `updatedAt`. If either day-value ≤ 0, no-op.
- Load active, non-SUPER_ADMIN users (`passwordChangedAt`, `createdAt`,
  `username`, `status = ENABLED`).
- For each user compute `daysLeft = daysUntilPasswordExpiry(...)`.
  - **Warning** (`1 ≤ daysLeft ≤ expiryNotificationDays`): create a
    `PASSWORD_EXPIRY_WARNING` for that user **unless** one already exists for
    them with `createdAt ≥ startOfToday` → one per user per day.
  - **Expired** (`daysLeft ≤ 0`): create a `PASSWORD_EXPIRED_NOTICE` **unless**
    one already exists for them with `createdAt ≥ anchor` → one per expiry event
    (a later password change moves the anchor and re-enables).
- Return `{ warned, expired }` counts.

### 5. Cron wiring
- `workers/password-expiry.worker.ts` → calls the sweep, warn-logs on error
  (mirrors `pm-overdue.worker.ts`).
- `crontab.txt`: `0 0 * * * password_expiry_check ?id=password_expiry_check&max=1&fill=0s`.
- Register `password_expiry_check: passwordExpiryCheckTask` in `app.ts` taskList.

### 6. Manual trigger (on demand)
The single graphile-worker Runner (and crontab) starts with the API in `app.ts`
with **no `USE_PG_QUEUE` gate**, so the daily cron fires in any running instance.
An admin-only endpoint (CONFIG_UPDATE) runs the same sweep on demand (e.g. to test
without waiting for midnight) — mirrors PM's `POST /api/pm-schedules/deviations/sweep`.

### 7. Error handling
- Sweep never throws out of the worker (caught + warn-logged), matching the PM
  worker — a bad run doesn't crash the runner.
- Missing/malformed config → treated as feature-off (no-op), not an error.

## Testing

- **Unit** — `daysUntilPasswordExpiry`: no-expiry (`0`/null) → null; exactly on
  the boundary; already expired → negative; policy-updatedAt floor grants a fresh
  window.
- **Integration** — seed users at controlled `passwordChangedAt` offsets, set
  policy (`passwordExpiryDays`, `expiryNotificationDays`), run the sweep, assert:
  one warning per eligible user; none for out-of-window / SA / disabled users;
  a second run the same day adds no duplicate; expired user gets exactly one
  notice.

## Out of scope

- Email/SMS delivery of the warning (in-app notification only; the existing
  notification-delivery channels can pick it up separately if configured).
- Changing the expiry-enforcement logic itself.

## Touchpoints / docs

- Counts: +1 config setting, +2 `NotificationType` enum values, +1 worker task,
  +1 crontab line.
- Update `CHANGELOG.md`; add a memory note; `tasks/todo.md` audit entry.
