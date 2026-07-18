/**
 * Sync Engine — Replays queued offline operations when back online.
 *
 * Order on each tick:
 *   1. Refresh JWT (so an 8h-expired token doesn't 401 the whole batch)
 *   2. Drain tombstones (deletes/terminations first — keeps audit consistent)
 *   3. Drain queued mutations (FIFO)
 *   4. Compact synced operations older than retention window
 *
 * Every replayed call carries:
 *   - x-offline-replay-token: <jwt>     (HMAC-signed grant — replaces the
 *                                       2026-05-04 audit C1 boolean header
 *                                       bypass; obtained via
 *                                       POST /api/auth/offline-grant after a
 *                                       password challenge at login)
 *   - x-client-op-id: <uuid>            (idempotency key — backend dedups)
 *   - body.offlinePerformedAt           (preserves real action time in audit;
 *                                       server validates per audit C2 — see
 *                                       apps/api/src/lib/offline-time-window.ts)
 */
import { apiClient } from './api-client';
import {
  getPendingOperations,
  updateOperationStatus,
  updateOperationTapeVersion,
  clearSyncedOperations,
  getPendingTombstones,
  updateTombstoneStatus,
  clearSyncedTombstones,
  compactSyncedOperations,
  evictLruCache,
  requeueStuckSyncing,
} from './offline-store';
import { onConnectivityChange } from './connectivity';
import {
  SYNC_AUTO_INTERVAL_MS,
  SYNC_AFTER_ONLINE_DELAY_MS,
  SYNC_AFTER_VISIBILITY_DELAY_MS,
  SYNC_INITIAL_DELAY_MS,
  SYNC_OP_REPLAY_TIMEOUT_MS,
} from './timing-constants';

/**
 * Bound a replay op's wall-clock wait. Rejects with an `OP_TIMEOUT`-coded error
 * if `p` hasn't settled within `ms`. It does NOT abort the underlying request —
 * CapacitorHttp on the APK ignores AbortSignal, so a race is the portable
 * mechanism, and the op's clientOpId makes a late-completing request an
 * idempotent no-op. The point is to release the drain loop (which resets the
 * module `syncing` flag) so a hung request can't freeze all sync until the app
 * restarts. Exported for direct unit-testing.
 */
export function withReplayTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const err: any = new Error(`Replay timed out after ${ms}ms — ${label}`);
      err.code = 'OP_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([p, timeout]).finally(() => { if (timer) clearTimeout(timer); });
}

/**
 * Audit 2026-05-04 fix C1: read the offline-replay grant token from session
 * (or backup in localStorage if the tab was reloaded) and shape it as a
 * header object spread by every replay call. Returns {} if no token (or
 * the token is expired), in which case the backend rejects with
 * REAUTH_REQUIRED — operator must re-login to mint a fresh grant.
 *
 * Deep-review fix (2026-05-13): the grant's `expiresAt` was being persisted
 * by use-auth.ts:92,94 but never read here. Sending an expired token
 * produced a noisy `OFFLINE_REPLAY_TOKEN_EXPIRED` server-side 401 with no
 * client-side cleanup — every subsequent request would keep re-sending the
 * dead token and getting rejected. Now we validate the expiry before
 * sending: if missing/in-the-past (with a 60s safety buffer for in-flight
 * races), we clear the stale storage entries AND return {} so the server
 * routes through the REAUTH_REQUIRED path. Same loud failure mode as
 * "never had a grant," but now WITHOUT spamming dead tokens on every retry.
 */
const REPLAY_GRANT_EXPIRY_BUFFER_MS = 60_000;

function getOfflineReplayHeader(): Record<string, string> {
  const token = sessionStorage.getItem('offline_replay_token')
    || localStorage.getItem('offline_replay_token_backup');
  if (!token) return {};

  const expiresAt = sessionStorage.getItem('offline_replay_expires')
    || localStorage.getItem('offline_replay_expires_backup');
  if (expiresAt) {
    const expiresAtMs = Date.parse(expiresAt);
    if (Number.isFinite(expiresAtMs) && expiresAtMs - REPLAY_GRANT_EXPIRY_BUFFER_MS <= Date.now()) {
      // eslint-disable-next-line no-console -- intentional structured log
      console.warn(
        '[sync-engine] offline-replay grant expired at',
        expiresAt,
        '— clearing storage; operator must re-login to mint a fresh grant',
      );
      sessionStorage.removeItem('offline_replay_token');
      sessionStorage.removeItem('offline_replay_expires');
      localStorage.removeItem('offline_replay_token_backup');
      localStorage.removeItem('offline_replay_expires_backup');
      return {};
    }
  }

  return { 'x-offline-replay-token': token };
}

/**
 * Sync stage taxonomy (W5 — offline-safety series). The ribbon (W6) consumes
 * these to show what the engine is currently doing. Stages are emitted as
 * `{ type: 'stage', stage: <name>, message?, current?, total? }` events so a
 * subscriber listening for legacy types (start/progress/complete) ignores
 * them naturally.
 *
 *   token-refresh    JWT refresh before the drain. Brief.
 *   tombstone-drain  Sending queued deletions (block-change cancels, cycle
 *                    terminates) ahead of regular ops.
 *   sending-ops      Replaying queued cycle writes one by one. Includes
 *                    `current` (1-indexed) and `total`.
 *   fetching-snapshot Post-drain refresh of canonical server state via the
 *                    sync-since polling layer; emitted by sync-since.ts after
 *                    each successful versioned fetch.
 *   idle             Default state when no sync is in flight.
 */
export type SyncStage =
  | 'token-refresh'
  | 'tombstone-drain'
  | 'sending-ops'
  | 'fetching-snapshot'
  | 'idle';

export type SyncEvent =
  | { type: 'start'; total?: number; synced?: number; error?: string }
  | { type: 'progress'; synced?: number; total?: number; error?: string }
  | { type: 'complete'; synced?: number; total?: number; error?: string }
  | { type: 'error'; synced?: number; total?: number; error?: string }
  | { type: 'interrupted'; synced?: number; total?: number; error?: string }
  | { type: 'stage'; stage: SyncStage; message?: string; current?: number; total?: number }
  // 2026-05-20 fix: emitted when the offline-replay grant is missing/expired
  // AND there are pending ops. UI catches this to surface a password prompt
  // so the operator can mint a fresh grant without losing the queue. Pre-fix
  // the sync engine just retried each op 5 times → marked them `failed` →
  // dropped operator's work silently because the "Data Synced" badge was
  // driven by op-status not grant-state.
  | { type: 'needs-reauth'; pendingCount: number; reason: 'missing' | 'expired' | 'rejected' };

type SyncListener = (event: SyncEvent) => void;

const MAX_RETRIES = 5;

let syncing = false;
const listeners: Set<SyncListener> = new Set();

export function onSyncEvent(listener: SyncListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notify(event: SyncEvent) {
  listeners.forEach(l => l(event));
}

/**
 * Emit a stage event. Thin helper so call sites don't have to repeat the
 * `{ type: 'stage', stage }` boilerplate.
 */
function notifyStage(stage: SyncStage, extras?: { message?: string; current?: number; total?: number }) {
  notify({ type: 'stage', stage, ...extras });
}

/**
 * Exported wrapper of `notifyStage` so the versioned-cache sync layer
 * (sync-since.ts) can emit `fetching-snapshot` ribbon events without having
 * its own listener set. Single ribbon listens to one stream.
 */
export function emitSyncStage(stage: SyncStage, extras?: { message?: string; current?: number; total?: number }) {
  notifyStage(stage, extras);
}

/**
 * Execute a single queued operation.
 * Sends x-offline-replay header so the backend skips re-authentication.
 * For 'start-and-advance' compound ops: runs start-cycle first, then advance.
 */
/**
 * Phase 5b B2: pre-replay cycle status check.
 *
 * For operations that require an active IN_PROGRESS cycle (advance, bypass,
 * submit-checklist, terminate), verify the cycle is still alive before we
 * replay. Catches the case where another user terminated/bypassed the cycle
 * while this tablet was offline. Without this check, the replay would land
 * a confusing `400 NO_CYCLE` and the queue would either retry forever or
 * mark as failed without context.
 */
const CYCLE_BOUND_OPS = new Set(['advance', 'advance-with-checklist', 'bypass', 'submit-checklist', 'terminate']);

async function ensureCycleAlive(filterId: string, opType: string): Promise<void> {
  if (!CYCLE_BOUND_OPS.has(opType)) return;
  let state: any;
  try {
    state = await apiClient.get<any>(`/api/filters/${filterId}/current-state`);
  } catch (e: any) {
    // If the current-state fetch itself fails (e.g. 404 filter retired), let the
    // replay proceed and surface the underlying error from there.
    return;
  }
  if (state?.currentCycle == null) {
    const err: any = new Error(`Cycle is no longer active for this filter — operation cannot be replayed`);
    err.code = 'CYCLE_ENDED';
    err.stranded = true;
    throw err;
  }
}

async function executeOperation(op: { type: string; filterId: string; payload: Record<string, any>; createdAt: string; clientOpId?: string; tapeVersion?: number | null }): Promise<void> {
  // Pre-replay guard: cycle-bound ops require the cycle to still be IN_PROGRESS.
  await ensureCycleAlive(op.filterId, op.type);

  // x-client-op-id makes replay idempotent — backend stores it on FilterEvent.attributes
  // and returns the cached response if the same id arrives twice. For start-and-advance
  // we suffix to differentiate the two underlying mutations.
  const headers: Record<string, string> = {
    ...getOfflineReplayHeader(),
    ...(op.clientOpId ? { 'x-client-op-id': op.clientOpId } : {}),
  };
  const offlineTime = op.createdAt;
  // Phase 8.7 (Wave 2 — server commit f8fae1d): cycle-bound POSTs now REQUIRE
  // tapeVersion in the body. New queued ops (post-Wave 2 cutover) carry the
  // tapeVersion captured at queue time via use-offline.ts:executeOrQueue.
  // Pre-8.3 IDB rows still on disk have tapeVersion=null and will fail with
  // 400 SCHEMA_ERROR on replay — that's an acceptable migration cost (the
  // op is marked failed and the operator must re-perform the action against
  // a fresh /current-state). start-cycle and start-and-advance's start step
  // are NOT cycle-bound writes, so we omit tapeVersion on those.
  const cycleBoundForVersion = CYCLE_BOUND_OPS.has(op.type);
  const tapeVersion = cycleBoundForVersion && op.tapeVersion !== null && op.tapeVersion !== undefined
    ? { tapeVersion: op.tapeVersion }
    : {};

  // Cycle-start whose first stage carries a mandatory checklist (2026-07-16).
  // Identical to start-and-advance except the advance half posts the ATOMIC
  // advance-with-checklist, so a replayed cycle-start can never land a stage
  // entry without its attestation.
  if (op.type === 'start-and-advance-with-checklist') {
    const { cyclePayload, advancePayload } = op.payload as { cyclePayload: Record<string, any>; advancePayload: Record<string, any> };
    try {
      await apiClient.post(
        `/api/filters/${op.filterId}/start-cycle`,
        { ...cyclePayload, offlinePerformedAt: offlineTime, clientOpId: op.clientOpId ? `${op.clientOpId}:start` : undefined },
        { ...headers, ...(op.clientOpId ? { 'x-client-op-id': `${op.clientOpId}:start` } : {}) },
      );
    } catch (e: any) {
      const code = e?.code || e?.error || '';
      // CYCLE_ACTIVE is a benign race — start succeeded earlier, continue.
      if (code !== 'CYCLE_ACTIVE') throw e;
    }
    // The stored tapeVersion is pre-start-cycle and meaningless; derive a fresh
    // one, same as the start-and-advance leg below.
    let sacTape: number | undefined;
    try {
      const fresh = await apiClient.get<any>(`/api/filters/${op.filterId}/current-state`);
      if (typeof fresh?.tapeVersion === 'number') sacTape = fresh.tapeVersion;
    } catch { /* fall through; the advance will surface the 400 */ }
    await apiClient.post(
      `/api/filters/${op.filterId}/advance-with-checklist`,
      {
        ...advancePayload,
        ...(sacTape !== undefined ? { tapeVersion: sacTape } : {}),
        offlinePerformedAt: offlineTime,
        clientOpId: op.clientOpId ? `${op.clientOpId}:advance` : undefined,
      },
      { ...headers, ...(op.clientOpId ? { 'x-client-op-id': `${op.clientOpId}:advance` } : {}) },
    );
    return;
  }

  if (op.type === 'start-and-advance') {
    const { cyclePayload, advancePayload } = op.payload as { cyclePayload: Record<string, any>; advancePayload: Record<string, any> };
    try {
      await apiClient.post(
        `/api/filters/${op.filterId}/start-cycle`,
        { ...cyclePayload, offlinePerformedAt: offlineTime, clientOpId: op.clientOpId ? `${op.clientOpId}:start` : undefined },
        { ...headers, ...(op.clientOpId ? { 'x-client-op-id': `${op.clientOpId}:start` } : {}) },
      );
    } catch (e: any) {
      const code = e?.code || e?.error || '';
      // CYCLE_ACTIVE is a benign race — start succeeded earlier, just continue with advance
      if (code !== 'CYCLE_ACTIVE') throw e;
    }
    // Phase 8.7 cutover (Wave 2 — server commit f8fae1d): /advance now
    // requires `tapeVersion`. The op row's stored tapeVersion (if any) is
    // pre-start-cycle and meaningless. Fetch the freshly-derived tapeVersion
    // via /current-state and include it on the advance leg. Self-sufficient
    // — no need to thread the field through the queue row for compound ops.
    let saTapeVersion: number | undefined;
    try {
      const fresh = await apiClient.get<any>(`/api/filters/${op.filterId}/current-state`);
      if (typeof fresh?.tapeVersion === 'number') saTapeVersion = fresh.tapeVersion;
    } catch { /* fall through; advance will surface the 400 */ }
    const advanceBody = saTapeVersion !== undefined
      ? { ...advancePayload, tapeVersion: saTapeVersion, offlinePerformedAt: offlineTime, clientOpId: op.clientOpId ? `${op.clientOpId}:advance` : undefined }
      : { ...advancePayload, offlinePerformedAt: offlineTime, clientOpId: op.clientOpId ? `${op.clientOpId}:advance` : undefined };
    await apiClient.post(
      `/api/filters/${op.filterId}/advance`,
      advanceBody,
      { ...headers, ...(op.clientOpId ? { 'x-client-op-id': `${op.clientOpId}:advance` } : {}) },
    );
    return;
  }

  const url = op.type === 'terminate'
    ? `/api/filters/${op.filterId}/terminate-cycle`
    : `/api/filters/${op.filterId}/${op.type}`;

  await apiClient.post(url, { ...op.payload, ...tapeVersion, offlinePerformedAt: offlineTime, clientOpId: op.clientOpId }, headers);
}

/**
 * Drain tombstones (deletes/terminations queued offline) before mutations.
 * Doing this first keeps audit history consistent — e.g. terminate-then-restart
 * is replayed in the right order.
 */
async function syncTombstones(): Promise<void> {
  let pending: any[];
  try { pending = await getPendingTombstones(); } catch { return; }
  if (pending.length === 0) return;

  for (const t of pending) {
    try {
      await updateTombstoneStatus(t.id, 'syncing');
      const headers: Record<string, string> = {
        ...getOfflineReplayHeader(),
        'x-client-op-id': t.clientOpId,
      };
      if (t.entityType === 'cycle') {
        // Phase 8.7 follow-up (2026-05-03): two corrections to the cycle
        // tombstone replay body.
        //   1. Field name: server schema requires `justification` (minLength
        //      10), not `reason`. Pre-fix tombstones would 400 SCHEMA_ERROR
        //      on the missing required property regardless of tape state.
        //      We accept both `payload.justification` and the legacy
        //      `payload.reason` for any pre-existing on-disk rows queued
        //      before this fix; the default 'Offline terminate' is 16
        //      chars, satisfying the minLength constraint.
        //   2. tapeVersion: server route now REQUIRES this field (commit
        //      f8fae1d). Forward when the tombstone captured one at queue
        //      time; omit the body field entirely when null/undefined so
        //      the request still parses (the 8.3 backward-compat window
        //      treated missing tapeVersion as no-check; under 8.7 the
        //      server schema rejects with 400 SCHEMA_ERROR — that is an
        //      acceptable migration cost for tombstones queued without
        //      tape capture, identical to the operations-store policy).
        const justification = t.payload?.justification ?? t.payload?.reason ?? 'Offline terminate';
        const tapeVersionField = t.tapeVersion !== null && t.tapeVersion !== undefined
          ? { tapeVersion: t.tapeVersion }
          : {};
        await apiClient.post(
          `/api/filters/${t.payload?.filterId ?? ''}/terminate-cycle`,
          { justification, ...tapeVersionField, clientOpId: t.clientOpId },
          headers,
        );
      } else if (t.entityType === 'block-change-request') {
        await apiClient.delete(`/api/block-change-requests/${t.entityId}`);
      }
      await updateTombstoneStatus(t.id, 'synced');
    } catch (e: any) {
      const errMsg = e?.message ?? e?.error ?? 'Tombstone sync failed';
      await updateTombstoneStatus(t.id, t.retryCount >= MAX_RETRIES - 1 ? 'failed' : 'pending', errMsg);
    }
  }
  // IDB cleanup runs AFTER tombstones have been replayed to the server.
  // Failure here is benign for immediate correctness (rows stay marked
  // 'synced' and the next drain will skip them anyway) but indicates
  // IndexedDB trouble — quota exhaustion, locked db, etc. Surface so
  // operators can diagnose silent storage failures.
  await clearSyncedTombstones().catch(err => {
    // eslint-disable-next-line no-console -- intentional structured log
    console.warn(
      '[sync-engine] clearSyncedTombstones failed —',
      err instanceof Error ? err.message : String(err),
    );
  });
}

/**
 * Refresh JWT before draining the queue. Long offline sessions can outlast
 * the 8h token, which would 401 every queued op. If refresh itself 401s,
 * keep the queue intact and surface the error so the UI can prompt re-login.
 *
 * Audit 2026-05-04 fix #4 (web-plumbing review H — JWT refresh fragmentation):
 * delegates to apiClient.refreshToken() so all three former refresh sites
 * (use-auth interval, this pre-sync hook, any future on-401 retry) share a
 * single in-flight Promise — concurrent callers don't double-fire and the
 * call always reaches the API host (relative-URL fetch was a no-op on
 * Capacitor APK). Pass-through wrapper keeps the existing `{ok, error}`
 * shape that syncPendingOperations expects.
 */
async function refreshTokenBeforeSync(): Promise<{ ok: boolean; error?: string }> {
  const token = sessionStorage.getItem('access_token');
  if (!token) return { ok: false, error: 'No token in storage' };
  const ok = await apiClient.refreshToken();
  return ok ? { ok: true } : { ok: false, error: 'Token refresh failed' };
}

export async function syncPendingOperations(): Promise<{ synced: number; failed: number }> {
  if (syncing) return { synced: 0, failed: 0 };

  let pending: any[];
  try {
    pending = await getPendingOperations();
  } catch {
    return { synced: 0, failed: 0 };
  }
  if (pending.length === 0) return { synced: 0, failed: 0 };

  // Quick connectivity test before draining the queue. On the APK, every
  // fetch() (here and inside apiClient) is routed through CapacitorHttp
  // automatically because `capacitor.config.ts` has `CapacitorHttp.enabled:
  // true` — that patches global fetch at WebView startup. So apiClient has
  // no special TLS handling; it inherits CapacitorHttp the same way a raw
  // fetch in connectivity.ts does.
  try {
    await apiClient.get('/api/health');
  } catch {
    // Server not reachable — skip sync
    return { synced: 0, failed: 0 };
  }

  // Refresh JWT before draining — long offline sessions can outlive the 8h token.
  // If refresh fails with anything other than network error, surface and bail.
  notifyStage('token-refresh');
  const refresh = await refreshTokenBeforeSync();
  if (!refresh.ok) {
    notifyStage('idle');
    notify({ type: 'error', error: `Token refresh failed: ${refresh.error}. Re-login required to sync.` });
    return { synced: 0, failed: 0 };
  }

  // 2026-05-20 fix — pre-flight offline-replay grant check.
  //
  // Pre-fix: if the grant was never minted (use-auth.ts swallowed errors with
  // console.warn) or expired during a long offline shift, every cycle-write
  // op would 401 REAUTH_REQUIRED on replay. The retry loop burned 5 attempts
  // per op → marked `failed` (terminal) → operator's work vanished silently
  // because "Data Synced" badge looks at op-status not grant-state. Observed
  // 2026-05-20 with operator 101114 (Siva): start-cycle at 11:07 burnt 5
  // retries and went `failed`; downstream advance + checklist ops landed
  // CYCLE_ENDED because the missing start-cycle meant the cycle never existed.
  //
  // Fix: check grant presence + freshness once, BEFORE draining. If missing,
  // emit `needs-reauth` event and bail — ops stay in `pending`, retry budget
  // intact. UI catches the event and shows a password dialog; on success,
  // `offline_replay_token` is restocked and the next drain proceeds normally.
  const grantHeader = getOfflineReplayHeader();
  const hasGrant = !!grantHeader['x-offline-replay-token'];
  if (!hasGrant) {
    notifyStage('idle');
    // Determine if it's a missing token or a freshly expired one (storage
    // entries cleared above in getOfflineReplayHeader on expiry). We can't
    // tell which post-clear, so report as 'missing' which the UI handles
    // identically (prompt for password to re-mint).
    notify({ type: 'needs-reauth', pendingCount: pending.length, reason: 'missing' });
    notify({
      type: 'error',
      error: `${pending.length} queued op(s) waiting on re-authentication. Tap to enter password.`,
    });
    return { synced: 0, failed: 0 };
  }

  // Drain tombstones first so deletes apply before any mutation that follows
  notifyStage('tombstone-drain');
  await syncTombstones();

  syncing = true;
  notifyStage('sending-ops', { current: 0, total: pending.length });
  notify({ type: 'start', total: pending.length });

  let synced = 0;
  let failed = 0;

  // Phase 8.4 I-3: dedupe STALE_TAPE per filter per drain.
  //   - First STALE_TAPE for a filter: emit one toast, then short-circuit
  //     every other queued op for the same filterId by marking them failed
  //     immediately without hitting the network. They would all fail with
  //     the same currentTapeVersion mismatch, so spamming the network and
  //     the toast list is wasted work.
  //   - Subsequent STALE_TAPE errors for filters already in the set: still
  //     mark op failed but suppress the toast.
  const staleTapeFiltersThisDrain = new Set<string>();

  // 2026-06-06: filters whose start-cycle op FAILED this drain (e.g. a
  // cross-block start rejected with 409 BLOCK_CHANGE_REQUIRED). Their dependent
  // advance/checklist/bypass ops must be skipped — the cycle was never created,
  // so firing them hits the server with no cycle and surfaces the misleading
  // "No active cleaning cycle". CYCLE_ACTIVE failures are excluded below (the
  // cycle exists in that case, so dependents are valid).
  const failedStartFilters = new Set<string>();

  for (let opIdx = 0; opIdx < pending.length; opIdx++) {
    const op = pending[opIdx];
    // Skip dependent cycle ops for a filter whose start-cycle already failed
    // this drain. Mark failed without an HTTP round-trip (would 400 NO_CYCLE).
    if (
      op.filterId
      && failedStartFilters.has(op.filterId)
      && (op.type === 'advance' || op.type === 'advance-with-checklist' || op.type === 'submit-checklist' || op.type === 'bypass')
    ) {
      await updateOperationStatus(
        op.id,
        'failed',
        'Skipped — the cleaning cycle was never started, so this step has nothing to attach to. Re-perform the cleaning for this filter.',
      );
      failed++;
      continue;
    }
    // Short-circuit: if a previous op for this filter already STALE_TAPE'd,
    // every further cycle-bound op for the same filter is doomed to the
    // same fate. Mark failed without an HTTP round-trip and without a
    // duplicate toast.
    if (op.filterId && staleTapeFiltersThisDrain.has(op.filterId)) {
      await updateOperationStatus(
        op.id,
        'failed',
        `Stale tape: another operator changed this cycle. Refresh and retry. (skipped — earlier op for the same filter already STALE_TAPE'd)`,
      );
      failed++;
      continue;
    }
    try {
      await updateOperationStatus(op.id, 'syncing');
      notifyStage('sending-ops', { current: synced + 1, total: pending.length, message: op.filterName });
      // Hard-bound the replay so a hung request (no reliable transport timeout
      // on CapacitorHttp) can't strand this op in 'syncing' and freeze the drain.
      await withReplayTimeout(executeOperation(op), SYNC_OP_REPLAY_TIMEOUT_MS, op.filterName);
      await updateOperationStatus(op.id, 'synced');
      synced++;
      notify({ type: 'progress', synced, total: pending.length });

      // 2026-05-17 chained-offline-ops fix: after each successful op, refresh
      // the tapeVersion on any subsequent queued ops for the same filter.
      // The downstream ops captured their tapeVersion at queue time against
      // the LOCAL placeholder cycle (synthesizeEvents returns [] for a fresh
      // cycle, so locally `filterEventCount = 0`). The server has more events
      // recorded (CYCLE_STARTED + STATE_TRANSITION at minimum, plus this op's
      // event(s)). Sending the stale tapeVersion would 409 STALE_TAPE on the
      // very next op, and the dedup set above would mark every remaining op
      // for the same filter failed without trying — surfacing as "only Wash
      // In synced" on the tablet. The fetch fail-soft: if /current-state
      // errors, fall through with the stored tape; STALE_TAPE handling below
      // is the safety net.
      if (op.filterId) {
        const hasMoreForFilter = pending
          .slice(opIdx + 1)
          .some((p) => p.filterId === op.filterId && CYCLE_BOUND_OPS.has(p.type));
        if (hasMoreForFilter) {
          try {
            const fresh = await apiClient.get<any>(`/api/filters/${op.filterId}/current-state`);
            if (typeof fresh?.tapeVersion === 'number') {
              for (let j = opIdx + 1; j < pending.length; j++) {
                const later = pending[j];
                if (later.filterId === op.filterId && CYCLE_BOUND_OPS.has(later.type)) {
                  later.tapeVersion = fresh.tapeVersion;
                  // Persist to IDB so a mid-drain failure (network drop, app
                  // background) doesn't leave the next drain replaying the
                  // stale on-disk tape — that would resurface the original
                  // "only first op syncs" symptom on the very next attempt.
                  // updateOperationTapeVersion is best-effort by the same
                  // logic as the fetch above: if IDB write fails, the
                  // in-memory rewrite still saves THIS drain.
                  try {
                    await updateOperationTapeVersion(later.id, fresh.tapeVersion);
                  } catch (idbErr) {
                    // eslint-disable-next-line no-console -- intentional structured log
                    console.warn(
                      '[sync-engine] updateOperationTapeVersion failed for',
                      later.id,
                      '— in-memory tape rewrite still applies for this drain',
                      idbErr instanceof Error ? idbErr.message : String(idbErr),
                    );
                  }
                }
              }
            }
          } catch {
            /* fetch failure here is non-fatal — STALE_TAPE branch below
               surfaces the underlying staleness if it materialises */
          }
        }
      }
    } catch (e: any) {
      // Extract error message — apiClient throws plain objects for API errors
      const errMsg = e?.message ?? e?.error ?? 'Sync failed';
      const msg = String(errMsg).toLowerCase();

      // Per-op replay hard timeout (OP_TIMEOUT): the request hung past
      // SYNC_OP_REPLAY_TIMEOUT_MS. A hang is not the op's fault (slow/dead
      // transport with no request timeout), and it's ambiguous whether the
      // request actually reached the server — so keep the op 'pending' WITHOUT
      // burning retry budget (mirrors the interrupted-replay rule) and STOP the
      // drain. Breaking lets the loop finish so the module `syncing` flag resets
      // below — the whole point, since otherwise a hung request freezes all sync
      // until app restart. A late-completing request dedups on clientOpId, and
      // the whole batch (incl. any dependents) simply retries on the next tick.
      // MUST precede the start-cycle-failure / network / generic branches: a
      // timeout is not a definitive start failure and must not fall through to
      // the retry-burning generic handler.
      if (e?.code === 'OP_TIMEOUT') {
        await updateOperationStatus(op.id, 'pending'); // no error arg → retryCount preserved
        failed++;
        notify({ type: 'interrupted', error: 'Sync timed out — will retry shortly' });
        break;
      }

      // 2026-06-06: a failed start-cycle means no cycle was created — record the
      // filter so its dependent advance/checklist/bypass ops are skipped (see
      // the short-circuit at the top of the loop). This stops the cross-block
      // "start rejected → advance fires → NO_CYCLE" cascade. CYCLE_ACTIVE is
      // excluded: the cycle already exists, so dependents remain valid.
      if (
        op.type === 'start-cycle'
        && op.filterId
        && e?.code !== 'CYCLE_ACTIVE'
        && e?.error !== 'CYCLE_ACTIVE'
      ) {
        failedStartFilters.add(op.filterId);
      }

      // Network error: server went away mid-sync, stop trying
      const isNetErr = msg.includes('fetch') || msg.includes('network')
        || msg.includes('econnrefused') || msg.includes('load failed')
        || msg.includes('abort');
      if (isNetErr) {
        await updateOperationStatus(op.id, 'pending', errMsg);
        failed++;
        notify({ type: 'interrupted', error: 'Sync interrupted — will retry in 30s' });
        break;
      }

      // Phase B2: stranded ops (cycle ended on server) — mark failed immediately,
      // don't retry. The user has to reconcile manually (cycle is gone).
      //
      // 2026-05-25 extension: NO_CYCLE has the same root cause and same correct
      // treatment. Pre-fix it fell through to the default 5-retry loop because
      // it wasn't enumerated here. Symptom on the tablet:
      //   - operator completes cycle X, FE thinks it's still open due to a
      //     queued op that was captured pre-completion
      //   - sync drains the stale op → server returns NO_CYCLE
      //   - retry loop re-fires the same op (and the checklist dialog re-opens
      //     in some FE paths) up to 5 times
      //   - operator sees the "no cleaning cycle found" error repeatedly +
      //     the checklist looks like it's "repeating offline"
      // Treating NO_CYCLE as terminal here drops the stale op once, emits one
      // toast, and clears the queue. Operator can start a fresh cycle.
      if (e?.stranded || e?.code === 'CYCLE_ENDED' || e?.code === 'NO_CYCLE') {
        // #10 fix: the cycle this queued action targeted has already ended on the
        // server. For a COMPLETING action (final advance / last checklist) that
        // usually means the action ALREADY SUCCEEDED and completed the cycle — the
        // lost HTTP response is exactly why it got re-queued. It can equally mean
        // another operator terminated the cycle. Either way the queued action no
        // longer applies and NO data is lost. The cycle-scoped idempotency can't
        // confirm a completing op post-completion (dedup needs the now-null cycle),
        // so we report NEUTRALLY instead of the old "operation discarded" toast,
        // which wrongly implied the operator's completed work vanished.
        await updateOperationStatus(op.id, 'failed', `The cleaning cycle already ended on the server — this queued action no longer applies (no data lost).`);
        failed++;
        notify({ type: 'error', error: `${op.filterName}: cycle already ended — queued action skipped (no data lost; verify the filter's status)` });
        continue;
      }

      // Phase 8.3: stale tape — another operator changed the cycle while
      // this op sat queued. Retrying with the same stored tapeVersion will
      // just keep failing, so drop the op and surface a refresh-prompt
      // toast. The fresh state arrives on the next /current-state fetch.
      //
      // Phase 8.4 I-3: emit ONE toast per filter per drain. Mark every
      // subsequent op for the same filter as failed without spamming.
      if (e?.code === 'STALE_TAPE') {
        const isFirstStaleForFilter = !!op.filterId && !staleTapeFiltersThisDrain.has(op.filterId);
        if (op.filterId) staleTapeFiltersThisDrain.add(op.filterId);
        await updateOperationStatus(op.id, 'failed', `Stale tape: another operator changed this cycle. Refresh and retry. (${errMsg})`);
        failed++;
        if (isFirstStaleForFilter) {
          notify({ type: 'error', error: `${op.filterName}: another operator changed this cycle. Refreshing...` });
        }
        continue;
      }

      // 2026-05-20 fix — REAUTH_REQUIRED / REAUTH_FAILED handling.
      //
      // These errors mean the offline-replay grant is missing/expired/wrong,
      // NOT that this specific op is bad. Retrying the same op 5 times in a
      // row with the same dead grant will fail every time, then mark the op
      // `failed` (terminal) and drop the operator's work silently. Same root
      // cause as the pre-drain pre-flight above, but reached only when the
      // grant existed at pre-flight but the server now rejects it (e.g. user
      // changed their password mid-shift).
      //
      // Treatment: stop the drain immediately, keep op + every subsequent
      // op in 'pending' state (retry budget intact). Emit a needs-reauth
      // event so the UI prompts for password — same recovery as the pre-flight.
      const isReauthErr = e?.error === 'REAUTH_REQUIRED' || e?.error === 'REAUTH_FAILED'
        || msg.includes('reauth') || msg.includes('re-authentication') || msg.includes('re-auth');
      if (isReauthErr) {
        await updateOperationStatus(op.id, 'pending', errMsg);
        failed++;
        notifyStage('idle');
        notify({ type: 'needs-reauth', pendingCount: pending.length - synced, reason: 'rejected' });
        notify({ type: 'error', error: `Sync paused: ${errMsg}. Re-enter password to resume.` });
        break;
      }

      // API error: retry up to MAX_RETRIES, then mark as permanently failed
      await updateOperationStatus(op.id, op.retryCount >= MAX_RETRIES - 1 ? 'failed' : 'pending', errMsg);
      failed++;
      notify({ type: 'error', error: `${op.filterName}: ${errMsg}` });
    }
  }

  // IDB cleanup after queue drain. Same rationale as clearSyncedTombstones
  // above — silent failure masks IndexedDB quota / lock issues. Operators
  // need to see these to diagnose stuck offline-mode storage.
  await clearSyncedOperations().catch(err => {
    // eslint-disable-next-line no-console -- intentional structured log
    console.warn('[sync-engine] clearSyncedOperations failed —', err instanceof Error ? err.message : String(err));
  });
  // Periodic compaction + LRU eviction — keeps IndexedDB from growing unbounded
  await compactSyncedOperations().catch(err => {
    // eslint-disable-next-line no-console -- intentional structured log
    console.warn('[sync-engine] compactSyncedOperations failed —', err instanceof Error ? err.message : String(err));
  });
  await evictLruCache().catch(err => {
    // eslint-disable-next-line no-console -- intentional structured log
    console.warn('[sync-engine] evictLruCache failed —', err instanceof Error ? err.message : String(err));
  });
  // Note: don't wipe filter-state caches here. Next /current-state fetch from the
  // UI will overwrite the cache with fresh server data; blanket clearing breaks
  // users who go offline again before that fetch happens.

  syncing = false;
  notifyStage('idle');
  notify({ type: 'complete', synced, total: pending.length });

  return { synced, failed };
}

// Auto-sync: online event + periodic retry + visibilitychange
let cleanup: (() => void) | null = null;
let retryInterval: ReturnType<typeof setInterval> | null = null;
const pendingTimers = new Set<ReturnType<typeof setTimeout>>();

const scheduleSync = (delayMs: number) => {
  const t = setTimeout(() => {
    pendingTimers.delete(t);
    syncPendingOperations();
  }, delayMs);
  pendingTimers.add(t);
};

export function startAutoSync(): void {
  if (cleanup) return;

  const onlineCleanup = onConnectivityChange((online) => {
    if (online) scheduleSync(SYNC_AFTER_ONLINE_DELAY_MS);
  });

  retryInterval = setInterval(async () => {
    try {
      const pending = await getPendingOperations();
      if (pending.length > 0) syncPendingOperations();
    } catch (err) {
      // The 30-second retry tick polls IndexedDB for queued ops. Silent
      // catch here hid stuck offline-mode failures (the queue stops
      // draining if IDB throws and nobody reports why). The retry itself
      // is fire-and-forget, but operators looking at the console need a
      // diagnostic — surface the cause; the next tick will try again.
      // eslint-disable-next-line no-console -- intentional structured log
      console.warn(
        '[sync-engine] retry tick: getPendingOperations failed —',
        err instanceof Error ? err.message : String(err),
      );
    }
  }, SYNC_AUTO_INTERVAL_MS);

  const handleVisibility = () => {
    if (document.visibilityState === 'visible') scheduleSync(SYNC_AFTER_VISIBILITY_DELAY_MS);
  };
  document.addEventListener('visibilitychange', handleVisibility);

  cleanup = () => {
    onlineCleanup();
    if (retryInterval) { clearInterval(retryInterval); retryInterval = null; }
    document.removeEventListener('visibilitychange', handleVisibility);
    pendingTimers.forEach(clearTimeout);
    pendingTimers.clear();
  };

  // Recover ops/tombstones orphaned in 'syncing' by a prior session that was
  // killed mid-replay (tablet OOM / 429-storm auto-close). Requeue them to
  // 'pending' BEFORE the first drain so they aren't silently lost. Safe: any
  // that already committed replay as idempotent no-ops (clientOpId dedup).
  // Scheduling the initial drain in .finally() guarantees the requeue lands first.
  requeueStuckSyncing()
    .then((n) => {
      if (n > 0) {
        // eslint-disable-next-line no-console -- operator-facing recovery diagnostic
        console.warn(`[sync-engine] requeued ${n} operation(s) stuck in 'syncing' from a prior interrupted session`);
      }
    })
    .catch((err) => {
      // eslint-disable-next-line no-console -- surface IDB failure; drain still scheduled
      console.warn('[sync-engine] requeueStuckSyncing failed —', err instanceof Error ? err.message : String(err));
    })
    .finally(() => scheduleSync(SYNC_INITIAL_DELAY_MS));
}

export function stopAutoSync(): void {
  if (cleanup) { cleanup(); cleanup = null; }
}
