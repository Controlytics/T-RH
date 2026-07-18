/**
 * Offline Store — IndexedDB wrapper for offline-first operations.
 * Stores: filter cache, operation queue, sync status, tombstones.
 */

const DB_NAME = 'digilog-offline';
// Phase 8.3: bumped 2 -> 3 to add `tapeVersion` to OfflineOperation rows.
// Phase 8.4 (M-3, 2026-05-02): bumped 3 -> 4. The server schema now
// REQUIRES `tapeVersion` on cycle-bound writes, so leaving rows with
// `tapeVersion === undefined` would produce 400 SCHEMA_ERROR on replay.
// The v3 -> v4 upgrade walks the operations store and normalizes any
// row with undefined tapeVersion to null in place. Null still skips the
// staleness check on the server (the schema has nullable handling), so
// pre-8.3 leftover ops still drain — they're just not fresher than the
// queue assumed at write time.
//
// Phase 8.4b (Option D, 2026-05-02): bumped 4 -> 5. Adds 6 new object stores
// for the versioned local cache fed by GET /api/sync/since:
//   - syncFilterCleaningProfiles (keyPath id)
//   - syncFilterProfiles (keyPath id)
//   - syncEquipmentGroups (keyPath id)
//   - syncChecklistProfiles (keyPath id) — populated in 8.4a follow-up
//   - syncAssetTemplates (keyPath id) — populated in 8.4a follow-up
//   - syncFilters (keyPath id) — note: NOT named "filters" because the
//       legacy `filters` store at top of this file holds CachedFilter rows
//       in a different shape. Renaming would require migrating live data;
//       the new store is a parallel, additive cache.
//   - syncVersionState (keyPath key) — single-row store ('current' key)
//       holding {profileVersion, filterProfileVersion, equipmentGroupVersion,
//       checklistVersion, assetTemplateVersion, filterUpdatedSince}.
// A-01 coupled-cluster Step 1 (2026-05-29): v6 adds 4 kind-scoped typed
// caches (cache_blocks / cache_areas / cache_ahus / cache_filters_typed)
// alongside the existing legacy mixed-kind `filters` store. Dual-cache
// during the migration window lets consumers migrate one at a time.
// Legacy `filters` store drops in Step 7 once all consumers migrate.
const DB_VERSION = 6;

// Single source of truth for offline-critical TTLs. Long shifts (>= 12h)
// require everything that participates in cleaning to outlive a full day,
// otherwise mid-shift cache evictions break dialogs offline.

// Audit 2026-05-04 fix #3 (web-plumbing review C2/C3): Capacitor-aware
// connectivity check — navigator.onLine lies on Android WebViews.
import { isOnline as connIsOnline } from './connectivity';

export const OFFLINE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — legacy default (kept for static callers)
export const SHORT_TTL_MS = 30 * 60 * 1000;        // 30 min — for non-critical UI caches
export const SYNCED_OP_RETENTION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
export const CACHE_LRU_CAP = 1000; // max entries in `cache` store before LRU eviction

// W2 (offline-safety series): runtime-mutable cache TTL driven by the
// SUPER_ADMIN `cacheStalenessHours` config (see offline-cache.def.ts +
// /api/config/offline-cache/current). Starts at 24h so a freshly loaded app
// with no config response yet still behaves correctly; `use-offline-config`
// re-seeds this on app boot once the config arrives.
//
// `getRuntimeOfflineTtlMs()` is the live value all cache reads and writes
// consult. `getCachedData()` recomputes expiry as min(storedExpiresAt,
// cachedAt + runtimeTtl) so config changes apply to entries already on disk
// — the operator doesn't have to wait for the old expiresAt to drain.
let _runtimeOfflineTtlMs = 24 * 60 * 60 * 1000;
export function setRuntimeOfflineTtlMs(ms: number): void {
  if (Number.isFinite(ms) && ms > 0) {
    _runtimeOfflineTtlMs = ms;
  }
}
export function getRuntimeOfflineTtlMs(): number {
  return _runtimeOfflineTtlMs;
}

interface OfflineOperation {
  id: string;
  /** Stable client-generated UUID — sent as x-client-op-id so backend can dedup retries */
  clientOpId: string;
  /**
   * `advance-with-checklist` (2026-07-16) — atomic advance + post-stage checklist.
   * Replays via the generic `/api/filters/:id/${op.type}` mapping in sync-engine,
   * and is registered in its CYCLE_BOUND_OPS + failed-start dependent-skip lists.
   */
  type: 'advance' | 'advance-with-checklist' | 'start-cycle' | 'submit-checklist' | 'bypass' | 'terminate' | 'start-and-advance' | 'start-and-advance-with-checklist';
  filterId: string;
  filterName: string;
  payload: Record<string, any>;
  createdAt: string;
  status: 'pending' | 'syncing' | 'synced' | 'failed';
  error?: string;
  retryCount: number;
  syncedAt?: string;
  /**
   * Tape version observed at queue time. Sent on the replay so the server
   * can reject (409 STALE_TAPE) if another writer changed the cycle while
   * this op sat queued.
   *
   * Phase 8.4 (M-3, 2026-05-02): tightened from `?: number | null` (3
   * states: undefined / null / number) to `: number | null` (2 states).
   * The v3 -> v4 IDB upgrade backfills any pre-existing row with
   * undefined to null in place, so every live op in the store has a
   * deterministic shape. `null` still means "no staleness check" — used
   * for pre-8.3 leftover ops and for non-cycle-bound writes (start-cycle,
   * the start-step of start-and-advance).
   */
  tapeVersion: number | null;
}

interface Tombstone {
  id: string;
  /** Stable client-generated UUID for idempotent replay */
  clientOpId: string;
  /** Logical entity being deleted/cancelled — used for sync ordering and dedup */
  entityType: 'cycle' | 'block-change-request';
  entityId: string;
  /** Optional context for replay */
  payload?: Record<string, any>;
  createdAt: string;
  status: 'pending' | 'syncing' | 'synced' | 'failed';
  error?: string;
  retryCount: number;
  /**
   * Phase 8.7 follow-up (2026-05-03): tape version observed at queue time
   * for entityType='cycle' tombstones. The server's
   * `POST /api/filters/:id/terminate-cycle` route REQUIRES `tapeVersion` in
   * the body since commit f8fae1d, so any cycle tombstone replayed without
   * this field would 400 SCHEMA_ERROR.
   *
   * Optional (no IDB schema bump): there are currently zero live callers
   * that queue cycle terminate tombstones — every UI terminate path goes
   * through `useOffline.executeOrQueue('terminate', ...)` which queues to
   * the `operations` store, not `tombstones`. So no on-disk rows exist
   * that need migration. Future callers MUST capture this field at queue
   * time (mirror the cycle-bound pattern in use-offline.ts:108-115 — read
   * from `filter-state-{filterId}` cache). The sync engine forwards the
   * value when present and omits the body field when absent/null.
   *
   * `block-change-request` tombstones never need this field (deletes a
   * separate entity with no tape concept).
   */
  tapeVersion?: number | null;
}

interface CachedFilter {
  id: string;
  name: string;
  templateId: string;
  filterSet: string | null;
  currentLifecycleState: string | null;
  currentCycleId: string | null;
  attributes: Record<string, any>;
  parentId: string | null;
  isActive: boolean;
  status: string;
}

interface CachedData {
  key: string;
  data: any;
  cachedAt: string;
  /** Last-access time, used for LRU eviction */
  lastAccessedAt: string;
  expiresAt: string;
}

/**
 * Phase 8.4 M-3 — pure helper used by the v3 -> v4 IDB upgrade.
 *
 * Mutates `row` in place if its `tapeVersion` is undefined (the pre-8.3 +
 * pre-8.4-tightening shape) and returns `true` so the caller knows to
 * `cursor.update(row)`. Otherwise returns `false` (no write needed).
 *
 * Exported for direct unit-testing — exercising the cursor inside a real
 * IDB upgrade transaction would require a heavyweight fake-indexeddb dev
 * dep we don't have, but the migration policy itself is tiny and worth
 * testing explicitly.
 */
export function normalizeOpForV4(row: { tapeVersion?: number | null }): boolean {
  if (row.tapeVersion === undefined) {
    (row as { tapeVersion: number | null }).tapeVersion = null;
    return true;
  }
  return false;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      const upgradeTx = req.transaction; // versionchange transaction — must use this for cursor work below
      const oldVersion = (event as IDBVersionChangeEvent).oldVersion ?? 0;

      // Schema bootstrap (idempotent): create stores/indexes that don't exist.
      if (!db.objectStoreNames.contains('operations')) {
        const opStore = db.createObjectStore('operations', { keyPath: 'id' });
        opStore.createIndex('status', 'status', { unique: false });
        opStore.createIndex('createdAt', 'createdAt', { unique: false });
      }
      if (!db.objectStoreNames.contains('cache')) {
        db.createObjectStore('cache', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('filters')) {
        db.createObjectStore('filters', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('tombstones')) {
        const tsStore = db.createObjectStore('tombstones', { keyPath: 'id' });
        tsStore.createIndex('status', 'status', { unique: false });
        tsStore.createIndex('createdAt', 'createdAt', { unique: false });
      }

      // Phase 8.4 M-3 (2026-05-02): v3 -> v4 normalizes any pre-8.3
      // OfflineOperation row with undefined tapeVersion to explicit null.
      // The TypeScript type was tightened from `?: number | null` to
      // `: number | null`, so the on-disk shape must match. Cursor-iterate
      // the operations store inside the versionchange transaction.
      if (oldVersion < 4 && upgradeTx) {
        const opStore = upgradeTx.objectStore('operations');
        const cursorReq = opStore.openCursor();
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result;
          if (!cursor) return;
          const row = cursor.value as OfflineOperation;
          if (normalizeOpForV4(row)) cursor.update(row);
          cursor.continue();
        };
      }

      // Phase 8.4b (Option D, 2026-05-02): v4 -> v5 adds the 7 versioned-
      // local-cache stores. Idempotent — only creates stores that don't yet
      // exist. Each store is keyPath: 'id' except syncVersionState which is
      // keyed by 'key' (single-row store with key='current').
      if (oldVersion < 5) {
        for (const name of SYNC_ID_STORES) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' });
          }
        }
        if (!db.objectStoreNames.contains('syncVersionState')) {
          db.createObjectStore('syncVersionState', { keyPath: 'key' });
        }
      }

      // A-01 coupled-cluster Step 1 (2026-05-29): v5 -> v6 adds 4 typed
      // caches mirroring the typed-hierarchy tables. Populated by
      // offline-sync-service (Step 2) alongside the legacy mixed `filters`
      // store. Existing consumers continue to read the legacy store; new
      // consumers (mobile-wrapper, mobile-operations, filter-operations,
      // use-filter-operations-offline-cache) migrate to typed stores in
      // Steps 3-6. The legacy `filters` store drops in Step 7.
      if (oldVersion < 6) {
        for (const name of ['cache_blocks', 'cache_areas', 'cache_ahus', 'cache_filters_typed']) {
          if (!db.objectStoreNames.contains(name)) {
            db.createObjectStore(name, { keyPath: 'id' });
          }
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Generate a UUID v4 — used for clientOpId on every queued operation */
export function generateClientOpId(): string {
  if (typeof crypto !== 'undefined' && (crypto as any).randomUUID) {
    return (crypto as any).randomUUID();
  }
  // Fallback for older WebViews — RFC 4122 v4 from Math.random
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// === Cache Operations ===

// Clear all filter-state-* and dryer-temp-* cache entries (after sync replay)
export async function clearFilterStateCaches(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('cache', 'readwrite');
  const store = tx.objectStore('cache');
  const req = store.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const items = req.result ?? [];
      for (const item of items) {
        if (item.key?.startsWith('filter-state-') || item.key?.startsWith('dryer-temp-')) {
          store.delete(item.key);
        }
      }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function cacheData(key: string, data: any, ttlMs?: number): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('cache', 'readwrite');
  const now = new Date();
  // W2: default TTL is the runtime configurable value (SUPER_ADMIN-tunable
  // via the offline-cache config). Callers that pass an explicit ttlMs
  // (e.g. SHORT_TTL_MS for non-critical UI caches that genuinely want a
  // tighter window) still get their override honored.
  const effectiveTtl = ttlMs ?? getRuntimeOfflineTtlMs();
  tx.objectStore('cache').put({
    key,
    data,
    cachedAt: now.toISOString(),
    lastAccessedAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + effectiveTtl).toISOString(),
  });
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
}

export async function getCachedData<T>(key: string): Promise<T | null> {
  const db = await openDB();
  const tx = db.transaction('cache', 'readwrite');
  const store = tx.objectStore('cache');
  const req = store.get(key);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const result = req.result as CachedData | undefined;
      if (!result) { resolve(null); return; }
      // When offline, always return cached data regardless of expiry — better
      // stale data than no data when the operator can't reach the server.
      // Audit 2026-05-04 fix #3 (web-plumbing review C2): use the Capacitor-
      // aware connectivity engine, not raw navigator.onLine. On Android
      // WebViews navigator.onLine lies; this gate would silently drop fresh
      // cache rows for tablets that THINK they're online but aren't.
      if (connIsOnline()) {
        const now = Date.now();
        const cachedAtMs = new Date(result.cachedAt).getTime();
        const storedExpiresAtMs = new Date(result.expiresAt).getTime();
        // W2: also enforce the live runtime TTL, not just the expiresAt
        // captured at write time. If SUPER_ADMIN tightens cacheStalenessHours
        // from 24h to 1h, an entry written 2h ago should be considered stale
        // even though its stored expiresAt is still 22h in the future. The
        // effective expiry is min(storedExpiresAt, cachedAt + runtimeTtl).
        const runtimeExpiresAtMs = cachedAtMs + getRuntimeOfflineTtlMs();
        const effectiveExpiresAtMs = Math.min(storedExpiresAtMs, runtimeExpiresAtMs);
        if (effectiveExpiresAtMs < now) { resolve(null); return; }
      }
      // Touch lastAccessedAt for LRU
      result.lastAccessedAt = new Date().toISOString();
      store.put(result);
      resolve(result.data as T);
    };
    req.onerror = () => reject(req.error);
  });
}

/**
 * LRU eviction — caps `cache` store at CACHE_LRU_CAP entries.
 * Filter-state-* and identifier-map are exempt because they're operationally critical.
 */
export async function evictLruCache(): Promise<{ evicted: number; total: number }> {
  const db = await openDB();
  const tx = db.transaction('cache', 'readwrite');
  const store = tx.objectStore('cache');
  const req = store.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const items = (req.result ?? []) as CachedData[];
      if (items.length <= CACHE_LRU_CAP) { resolve({ evicted: 0, total: items.length }); return; }
      const exempt = (key: string) => key.startsWith('filter-state-') || key === 'identifier-map' || key === 'cleaning-profile-assignment' || key.startsWith('active-profile-');
      const evictable = items
        .filter(i => !exempt(i.key))
        .sort((a, b) => new Date(a.lastAccessedAt ?? a.cachedAt).getTime() - new Date(b.lastAccessedAt ?? b.cachedAt).getTime());
      const target = items.length - CACHE_LRU_CAP;
      const toEvict = evictable.slice(0, target);
      for (const item of toEvict) store.delete(item.key);
      resolve({ evicted: toEvict.length, total: items.length });
    };
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * Periodic compaction — removes synced operations older than SYNCED_OP_RETENTION_MS.
 * Failed operations are kept for operator visibility.
 */
export async function compactSyncedOperations(): Promise<{ removed: number }> {
  const db = await openDB();
  const tx = db.transaction('operations', 'readwrite');
  const store = tx.objectStore('operations');
  const req = store.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const ops = (req.result ?? []) as OfflineOperation[];
      const cutoff = Date.now() - SYNCED_OP_RETENTION_MS;
      let removed = 0;
      for (const op of ops) {
        if (op.status === 'synced') {
          const ts = op.syncedAt ? new Date(op.syncedAt).getTime() : new Date(op.createdAt).getTime();
          if (ts < cutoff) { store.delete(op.id); removed++; }
        }
      }
      resolve({ removed });
    };
    req.onerror = () => reject(req.error);
    tx.onerror = () => reject(tx.error);
  });
}

// === A-01 Wave 5 — Typed-Kind Caches (Step 1, 2026-05-29) ============================
//
// Per-kind cache stores mirror the typed-hierarchy tables exposed at
// /api/hierarchy/{blocks,areas,ahus,filters}. Populated by offline-sync-
// service.ts alongside the legacy mixed `filters` store. Consumer files
// (mobile-wrapper, mobile-operations, filter-operations, the offline-cache
// hook) migrate to these stores one-per-step in the coupled-cluster plan.
//
// No `templateId` / `templateKind` discriminator field — the cache name IS
// the kind. This eliminates the bug class that plagued PM, cleaning-profile-
// assignment, and the mobile pages where filter instances got mis-classified
// as AHUs because of name-substring matching against legacy template names.

export interface CachedBlock {
  id: string;
  name: string;
  description: string | null;
  status: string;
  attributes: Record<string, unknown>;
  customAttributes?: Record<string, unknown>;
  
  isActive: boolean;
}
export interface CachedArea extends CachedBlock { blockId: string | null; }
export interface CachedAhu  extends CachedBlock { areaId:  string | null; }
// 2026-05-29 (Step 4 unblock): the four cycle-state fields below live on
// FilterDetails (NOT on the typed `filters` table — see schema.prisma:514-520
// for the D-03 rationale). The /api/hierarchy/filters endpoint LEFT JOINs
// FilterDetails and flattens these onto each row so operator UIs reading
// from the typed cache get the same fields they used to read off
// /api/assets/instances. When A-01 Phase 2 merges FilterDetails INTO the
// typed `filters` table these fields move home and this comment can go.
export interface CachedFilterTyped extends CachedBlock {
  ahuId: string | null;
  currentLifecycleState: string | null;
  currentCycleId: string | null;
  filterProfileId: string | null;
  filterSet: string | null;
}

async function cacheTypedRows<T extends { id: string }>(storeName: string, rows: T[]): Promise<void> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  store.clear();
  for (const r of rows) store.put(r);
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
}

async function getCachedTypedRows<T>(storeName: string): Promise<T[]> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  const req = tx.objectStore(storeName).getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export const cacheBlocks       = (rows: CachedBlock[])       => cacheTypedRows('cache_blocks', rows);
export const cacheAreas        = (rows: CachedArea[])        => cacheTypedRows('cache_areas', rows);
export const cacheAhus         = (rows: CachedAhu[])         => cacheTypedRows('cache_ahus', rows);
export const cacheFiltersTyped = (rows: CachedFilterTyped[]) => cacheTypedRows('cache_filters_typed', rows);

export const getCachedBlocks       = () => getCachedTypedRows<CachedBlock>('cache_blocks');
export const getCachedAreas        = () => getCachedTypedRows<CachedArea>('cache_areas');
export const getCachedAhus         = () => getCachedTypedRows<CachedAhu>('cache_ahus');
export const getCachedFiltersTyped = () => getCachedTypedRows<CachedFilterTyped>('cache_filters_typed');

// === Filter Cache (legacy mixed-kind store — drops in Step 7) ===

export async function cacheFilters(filters: CachedFilter[]): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('filters', 'readwrite');
  const store = tx.objectStore('filters');
  store.clear();
  for (const f of filters) store.put(f);
  return new Promise((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
}

export async function getCachedFilters(): Promise<CachedFilter[]> {
  const db = await openDB();
  const tx = db.transaction('filters', 'readonly');
  const req = tx.objectStore('filters').getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

// Update a single filter's state locally (optimistic update for offline)
export async function updateFilterStateLocally(filterId: string, newState: string, markCycleActive?: boolean): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('filters', 'readwrite');
  const store = tx.objectStore('filters');
  const req = store.get(filterId);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const filter = req.result;
      if (filter) {
        filter.currentLifecycleState = newState;
        // When a cycle is started offline, mark it so subsequent stages don't re-ask for reason
        if (markCycleActive && !filter.currentCycleId) {
          filter.currentCycleId = `offline-cycle-${Date.now()}`;
        }
        store.put(filter);
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// Clear the currentCycleId and currentLifecycleState for a filter (when cycle completes offline)
export async function clearOfflineCycleId(filterId: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('filters', 'readwrite');
  const store = tx.objectStore('filters');
  const req = store.get(filterId);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const filter = req.result;
      if (filter) {
        filter.currentCycleId = null;
        filter.currentLifecycleState = null;
        store.put(filter);
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// === Operation Queue ===

/**
 * Input shape for `queueOperation`: the on-store row type (`OfflineOperation`)
 * minus the engine-managed fields, with `tapeVersion` widened to allow
 * `undefined` from callers that haven't been threaded through yet. The
 * persistence layer always normalizes to `number | null` (M-3 / v4).
 */
type QueueInput = Omit<OfflineOperation, 'id' | 'clientOpId' | 'createdAt' | 'status' | 'retryCount' | 'tapeVersion'> & {
  tapeVersion?: number | null;
  // #9 fix: the caller (use-offline) may supply the clientOpId it ALSO sent on a
  // failed online attempt, so a lost-response online commit and this queued replay
  // share one idempotency key (server dedups instead of 409 / duplicate cycle).
  // Omitted for purely-offline ops → a fresh id is generated.
  clientOpId?: string;
};

export async function queueOperation(op: QueueInput): Promise<string> {
  const db = await openDB();
  const id = `op-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clientOpId = op.clientOpId ?? generateClientOpId();
  const tx = db.transaction('operations', 'readwrite');
  // Phase 8.4 M-3: persist tapeVersion as `number | null` only — no undefined
  // on the wire. The IDB upgrade also normalizes any pre-existing v3 rows
  // with undefined tapeVersion. Callers that don't supply tapeVersion (pre-
  // cutover paths, non-cycle-bound writes) get null; the sync engine
  // omits the body field entirely when null.
  tx.objectStore('operations').put({
    ...op,
    id,
    clientOpId,
    createdAt: new Date().toISOString(),
    status: 'pending',
    retryCount: 0,
    tapeVersion: op.tapeVersion ?? null,
  });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingOperations(): Promise<OfflineOperation[]> {
  const db = await openDB();
  const tx = db.transaction('operations', 'readonly');
  const index = tx.objectStore('operations').index('status');
  const req = index.getAll('pending');
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllOperations(): Promise<OfflineOperation[]> {
  const db = await openDB();
  const tx = db.transaction('operations', 'readonly');
  const req = tx.objectStore('operations').getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const ops = (req.result ?? []) as OfflineOperation[];
      ops.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      resolve(ops);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function updateOperationStatus(id: string, status: OfflineOperation['status'], error?: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('operations', 'readwrite');
  const store = tx.objectStore('operations');
  const req = store.get(id);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const op = req.result;
      if (op) {
        op.status = status;
        if (status === 'synced') op.syncedAt = new Date().toISOString();
        if (error) op.error = error;
        // Increment retry count on every failure (pending retry or final failure)
        if (status === 'failed' || (status === 'pending' && error)) {
          op.retryCount = (op.retryCount ?? 0) + 1;
        }
        store.put(op);
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
  });
}

/**
 * Flip a stuck 'syncing' row back to 'pending' for re-drain. Pure policy (mirrors
 * `normalizeOpForV4` — exported so it can be unit-tested without a full IDB harness).
 * Deliberately does NOT bump `retryCount`: an interrupted replay is not a failure,
 * so it must not burn the op's retry budget. Returns the mutated row.
 */
export function markSyncingRowPending<T extends { status: string }>(row: T): T {
  row.status = 'pending';
  return row;
}

function requeueSyncingInStore(db: IDBDatabase, storeName: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    const store = tx.objectStore(storeName);
    const req = store.index('status').getAll('syncing');
    let count = 0;
    req.onsuccess = () => {
      for (const row of (req.result ?? [])) {
        store.put(markSyncingRowPending(row));
        count++;
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve(count);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * Requeue operations + tombstones stuck in 'syncing' back to 'pending'.
 *
 * An op is flipped to 'syncing' immediately before its network POST (sync-engine).
 * If the app is killed mid-replay — the documented tablet OOM / 429-retry-storm
 * auto-close — nothing ever resets it: getPendingOperations/getPendingTombstones
 * read only the 'pending' index, so the row is orphaned forever and the operator's
 * cleaning action is silently lost while the UI still shows "Data Synced".
 *
 * Called once at boot (startAutoSync) BEFORE the first drain, so any 'syncing' row
 * present is necessarily an orphan from a prior interrupted session — the current
 * session hasn't started a drain yet. Re-replay is safe: every op carries a
 * clientOpId the server dedups, so an op that actually committed before the crash
 * replays as an idempotent no-op. Returns the number of rows requeued.
 */
export async function requeueStuckSyncing(): Promise<number> {
  const db = await openDB();
  let total = await requeueSyncingInStore(db, 'operations');
  if (db.objectStoreNames.contains('tombstones')) {
    total += await requeueSyncingInStore(db, 'tombstones');
  }
  return total;
}

/**
 * Delete a single queued operation by id. Used by the "couldn't sync" review
 * panel when an operator dismisses a terminal-failed op (e.g. cycle already
 * ended / stale tape) they've decided not to re-perform.
 */
export async function deleteOperation(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('operations', 'readwrite');
  tx.objectStore('operations').delete(id);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/**
 * 2026-05-17 chained-offline-ops fix: persist a freshly-fetched tapeVersion
 * onto a queued op row. The sync-engine calls this after a successful drain
 * step refreshes `/api/filters/:id/current-state`, so any downstream queued op
 * for the same filter carries the correct tape on its NEXT replay — even if
 * the current drain breaks mid-way (network drop, app backgrounded). Without
 * IDB persistence the in-memory rewrite is lost on re-drain and the operator
 * sees the same "only first op syncs" failure pattern that motivated this fix.
 */
export async function updateOperationTapeVersion(id: string, tapeVersion: number): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('operations', 'readwrite');
  const store = tx.objectStore('operations');
  const req = store.get(id);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const op = req.result;
      if (op) {
        op.tapeVersion = tapeVersion;
        store.put(op);
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
  });
}

// === Tombstones (for offline deletes/terminations — sync engine processes these first) ===

export async function queueTombstone(t: Omit<Tombstone, 'id' | 'clientOpId' | 'createdAt' | 'status' | 'retryCount'>): Promise<string> {
  const db = await openDB();
  const id = `ts-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const clientOpId = generateClientOpId();
  const tx = db.transaction('tombstones', 'readwrite');
  tx.objectStore('tombstones').put({
    ...t,
    id,
    clientOpId,
    createdAt: new Date().toISOString(),
    status: 'pending',
    retryCount: 0,
  });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(id);
    tx.onerror = () => reject(tx.error);
  });
}

export async function getPendingTombstones(): Promise<Tombstone[]> {
  const db = await openDB();
  const tx = db.transaction('tombstones', 'readonly');
  if (!db.objectStoreNames.contains('tombstones')) return [];
  const idx = tx.objectStore('tombstones').index('status');
  const req = idx.getAll('pending');
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result ?? []);
    req.onerror = () => reject(req.error);
  });
}

export async function updateTombstoneStatus(id: string, status: Tombstone['status'], error?: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('tombstones', 'readwrite');
  const store = tx.objectStore('tombstones');
  const req = store.get(id);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const t = req.result;
      if (t) {
        t.status = status;
        if (error) t.error = error;
        if (status === 'failed' || (status === 'pending' && error)) {
          t.retryCount = (t.retryCount ?? 0) + 1;
        }
        store.put(t);
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
  });
}

export async function clearSyncedTombstones(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('tombstones', 'readwrite');
  const store = tx.objectStore('tombstones');
  const req = store.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const ts = req.result ?? [];
      for (const t of ts) if (t.status === 'synced') store.delete(t.id);
      resolve();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
  });
}

export async function clearSyncedOperations(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('operations', 'readwrite');
  const store = tx.objectStore('operations');
  const req = store.getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const ops = req.result ?? [];
      for (const op of ops) {
        if (op.status === 'synced') store.delete(op.id);
      }
      resolve();
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
  });
}

export async function clearAllOperations(): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('operations', 'readwrite');
  tx.objectStore('operations').clear();
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// === Phase 8.4b — Versioned local-cache stores (Option D) ===

/**
 * Names of the v5 sync stores that share keyPath 'id'. Listed once to keep
 * the upgrade path, type union, and helper functions in lockstep.
 */
export const SYNC_ID_STORES = [
  'syncFilterCleaningProfiles',
  'syncFilterProfiles',
  'syncEquipmentGroups',
  'syncChecklistProfiles',
  'syncAssetTemplates',
  'syncFilters',
] as const;

export type SyncEntityStore = typeof SYNC_ID_STORES[number];

export interface VersionState {
  /** Single-row store key — always 'current' for this app. */
  key: 'current';
  profileVersion: number;
  filterProfileVersion: number;
  equipmentGroupVersion: number;
  checklistVersion: number;
  assetTemplateVersion: number;
  /** ISO-8601 timestamp; null = no rows seen yet (full sync on first call). */
  filterUpdatedSince: string | null;
  /** ISO-8601 of the last successful syncSince() call. */
  lastSyncedAt: string | null;
}

/** The default cursors for a fresh client. */
export const DEFAULT_VERSION_STATE: VersionState = {
  key: 'current',
  profileVersion: 0,
  filterProfileVersion: 0,
  equipmentGroupVersion: 0,
  checklistVersion: 0,
  assetTemplateVersion: 0,
  filterUpdatedSince: null,
  lastSyncedAt: null,
};

/**
 * Bulk-write rows into one of the v5 sync stores. Uses `put` so individual
 * rows update by primary key without disturbing the rest of the cache. Does
 * NOT clear the store first — `syncSince()` is incremental, the FE only
 * receives rows newer than the cursor. (For full re-sync, the caller can
 * reset versionState to defaults; the next call returns everything.)
 */
export async function cacheEntities<T extends { id: string }>(
  storeName: SyncEntityStore,
  rows: T[],
): Promise<void> {
  if (rows.length === 0) return;
  const db = await openDB();
  const tx = db.transaction(storeName, 'readwrite');
  const store = tx.objectStore(storeName);
  for (const row of rows) store.put(row);
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

export async function getCachedEntity<T = any>(
  storeName: SyncEntityStore,
  id: string,
): Promise<T | null> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  const req = tx.objectStore(storeName).get(id);
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve((req.result ?? null) as T | null);
    req.onerror = () => reject(req.error);
  });
}

export async function getAllCachedEntities<T = any>(
  storeName: SyncEntityStore,
): Promise<T[]> {
  const db = await openDB();
  const tx = db.transaction(storeName, 'readonly');
  const req = tx.objectStore(storeName).getAll();
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve((req.result ?? []) as T[]);
    req.onerror = () => reject(req.error);
  });
}

/** Read the current versionState row, returning DEFAULT_VERSION_STATE on miss. */
export async function getVersionState(): Promise<VersionState> {
  const db = await openDB();
  const tx = db.transaction('syncVersionState', 'readonly');
  const req = tx.objectStore('syncVersionState').get('current');
  return new Promise((resolve, reject) => {
    req.onsuccess = () => {
      const row = req.result as VersionState | undefined;
      resolve(row ?? { ...DEFAULT_VERSION_STATE });
    };
    req.onerror = () => reject(req.error);
  });
}

/** Replace the versionState row. Caller passes the merged shape. */
export async function setVersionState(state: VersionState): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('syncVersionState', 'readwrite');
  tx.objectStore('syncVersionState').put({ ...state, key: 'current' });
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// === Online/Offline Detection ===
//
// Audit 2026-05-04 fix #3: these helpers were unused (use-offline.ts already
// imports the Capacitor-aware variants from connectivity.ts). Re-exporting
// the connectivity API here so any future caller importing from this file
// gets the right behavior automatically.

export const isOnline = connIsOnline;

export function onOnlineStatusChange(callback: (online: boolean) => void): () => void {
  const handleOnline = () => callback(true);
  const handleOffline = () => callback(false);
  window.addEventListener('online', handleOnline);
  window.addEventListener('offline', handleOffline);
  return () => {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
  };
}
