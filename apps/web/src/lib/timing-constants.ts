/**
 * Centralized timing constants for the offline pipeline.
 *
 * Why these live here: the cleanup that flushed inline `setTimeout(.., 2000)`
 * and `setInterval(.., 30_000)` calls into named exports. Future tuning of
 * sync cadence, connectivity probe frequency, or blocker re-evaluation
 * happens in one place — and if/when these become SUPER_ADMIN-configurable
 * (similar to the W1 offline-cache config), the read-from-runtime mechanism
 * has one obvious hook.
 *
 * Naming: each constant is suffixed `_MS` so the unit is unmistakable at
 * the call site (`setInterval(tick, CONNECTIVITY_POLL_INTERVAL_MS)` reads
 * better than `setInterval(tick, 15_000)`).
 */

// ─── Connectivity probe (lib/connectivity.ts) ───────────────────────────

/**
 * How long a single /api/health probe will wait before aborting. Short
 * enough that a hung server doesn't block the next 15s tick; long enough
 * that a slow but reachable server reports as online.
 */
export const CONNECTIVITY_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe cadence when the app is mounted. Drives the green/red ribbon
 * (W6) and the W4 hard-cutoff re-evaluation indirectly (markServerContact
 * fires on each successful probe).
 */
export const CONNECTIVITY_POLL_INTERVAL_MS = 15_000;

// ─── Sync engine cadence (lib/sync-engine.ts startAutoSync) ─────────────

/**
 * Periodic auto-sync tick while the app is online. Drives `syncPendingOperations`
 * (drains the offline queue) — independent from the versioned-cache `syncSince`
 * polling below.
 */
export const SYNC_AUTO_INTERVAL_MS = 30_000;

/**
 * Delay before kicking a sync after the connectivity engine flips to
 * online. Gives the network a moment to settle before we try to drain
 * the queue.
 */
export const SYNC_AFTER_ONLINE_DELAY_MS = 2_000;

/**
 * Delay before kicking a sync after the page becomes visible again
 * (operator unlocked the tablet, switched tabs, etc.). Smaller than the
 * online-event delay because visibility usually means an already-stable
 * network — the operator just unblocked the WebView.
 */
export const SYNC_AFTER_VISIBILITY_DELAY_MS = 1_000;

/**
 * Initial sync attempt after `startAutoSync` is called. Lets the React tree
 * mount and SWR caches warm before draining the queue.
 */
export const SYNC_INITIAL_DELAY_MS = 3_000;

/**
 * Per-op replay hard timeout (sync-engine `executeOperation`). Some transports
 * — notably CapacitorHttp on the APK — have no reliable request timeout, so a
 * hung replay would leave the op stuck in `syncing` AND the drain's module-level
 * `syncing` flag stuck true, freezing all further sync until the app restarts.
 * Bounding each op's wall-clock wait releases the drain; a late-completing
 * request is harmless (the op's clientOpId makes the server dedup it). Generous
 * so legitimately-slow requests never trip it — only a genuine hang does.
 */
export const SYNC_OP_REPLAY_TIMEOUT_MS = 45_000;

// ─── Versioned-cache sync (lib/sync-since.ts) ───────────────────────────

/**
 * Background poll for /api/sync/since. Drives the "Refreshing data…"
 * orange ribbon state (W5/W6) and keeps the v5 sync stores fresh while
 * the operator is online.
 */
export const SYNC_SINCE_POLL_INTERVAL_MS = 60_000;

// ─── Hard-cutoff blocker (components/hard-cutoff-blocker.tsx) ───────────

/**
 * Fallback re-evaluation cadence for the W4 read-only blocker. The
 * primary trigger is `subscribeToServerContact` (fires on every
 * markServerContact event), so this interval only matters when nothing
 * else is firing — i.e., the operator is genuinely idle and the
 * connectivity probe is also failing. Without this fallback, the
 * blocker would render late by up to a render cycle.
 */
export const HARD_CUTOFF_REEVAL_INTERVAL_MS = 30_000;

// ─── Clipboard copy UX (admin-requests, users CRUD, email-settings) ─────

/**
 * How long the "Copied!" visual indicator stays on after a clipboard
 * write succeeds before reverting to the default state. 2 seconds is
 * long enough for the operator to see the confirmation, short enough
 * that they can copy a second time without waiting.
 */
export const CLIPBOARD_COPY_RESET_MS = 2_000;
