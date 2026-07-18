/**
 * SMS settings page entry point.
 *
 * Audit 2026-05-04 follow-up: this file was a near-duplicate of
 * email-settings.tsx (851 vs 894 lines, drifted by ~40 lines). Both
 * files exported the same EmailSettingsPage + SmsSettingsPage symbols
 * because the actual UI lives in shared `EmailTab` + `SmsTab`
 * components inside the same module. Maintenance double = real cost
 * (the reauth wrap had to be applied twice). Re-export from the
 * canonical file so the next change lands in one place.
 *
 * The router (apps/web/src/main.tsx) imports `SmsSettingsPage` from
 * THIS path; keeping the file means we don't have to touch main.tsx,
 * we just collapse the implementation.
 */
export { EmailSettingsPage, SmsSettingsPage } from './email-settings';
