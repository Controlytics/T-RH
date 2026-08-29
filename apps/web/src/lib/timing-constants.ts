// Timing constants shared across the UI.
//
// 2026-08-29 (audit cleanup): this file was 102 lines defining ten constants,
// of which exactly ONE was imported anywhere. The other nine —
// CONNECTIVITY_PROBE_TIMEOUT_MS, CONNECTIVITY_POLL_INTERVAL_MS,
// SYNC_AUTO_INTERVAL_MS, SYNC_AFTER_ONLINE_DELAY_MS,
// SYNC_AFTER_VISIBILITY_DELAY_MS, SYNC_INITIAL_DELAY_MS,
// SYNC_OP_REPLAY_TIMEOUT_MS, SYNC_SINCE_POLL_INTERVAL_MS and
// HARD_CUTOFF_REEVAL_INTERVAL_MS — configured an IndexedDB offline queue and a
// connectivity poller that went with the mobile/offline domain in the Phase 0
// strip. Nine importers of this module, all of them pulling only the constant
// below.
//
// They are deliberately NOT resurrected here as documentation: a tuned timing
// value for a subsystem that does not exist is a trap, because it reads as a
// decision someone still relies on. If offline sync ever returns it will want
// its own numbers argued from its own behaviour. Recoverable from git history
// (`git log -- apps/web/src/lib/timing-constants.ts`) if that ever happens.

// ─── Clipboard copy UX (admin-requests, users CRUD, email-settings) ─────

/**
 * How long the "Copied!" visual indicator stays on after a clipboard
 * write succeeds before reverting to the default state. 2 seconds is
 * long enough for the operator to see the confirmation, short enough
 * that they can copy a second time without waiting.
 */
export const CLIPBOARD_COPY_RESET_MS = 2_000;
