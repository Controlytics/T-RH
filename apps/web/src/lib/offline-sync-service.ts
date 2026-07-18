/**
 * Offline Sync Service — Caches ALL master data needed for offline filter operations.
 * Called once after login while online. Stores everything in IndexedDB.
 *
 * Data cached:
 * 1. Filter instances (all active, non-retired)
 * 2. Filter states (current-state for each filter — pipeline, cycle, equipment, checklists)
 * 3. Cleaning reasons
 * 4. Equipment groups with instruments
 * 5. Identifier map (RFID/barcode → filterId)
 * 6. Templates
 * 7. PM due tasks
 * 8. Checklist profiles with questions
 * 9. Cleaning profiles (which block has which profile)
 */

import { apiClient } from './api-client';
import {
  cacheData,
  cacheFilters,
  // A-01 coupled-cluster Step 2 (2026-05-29): typed-kind caches populated
  // alongside the legacy mixed `filters` store. New consumers will read
  // from these typed stores; existing carve-out consumers continue with the
  // legacy mixed cache until they migrate (Steps 3-6).
  cacheBlocks,
  cacheAreas,
  cacheAhus,
  cacheFiltersTyped,
} from './offline-store';
import { withDerivedPendingChecklist } from './offline-cache';

export interface SyncProgress {
  step: string;
  current: number;
  total: number;
  done: boolean;
  error?: string;
  /** Audit 2026-05-04 fix #2: list of steps that soft-failed (caught
   * exception but advanced anyway). Populated only on the final `done`
   * progress event so the caller can render "Synced with warnings: …"
   * instead of a misleading green check. */
  partialFailures?: string[];
}

type ProgressCallback = (progress: SyncProgress) => void;

const CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours (offline data should last a full shift)

async function cacheItem(key: string, data: any) {
  await cacheData(key, data, CACHE_TTL);
}

/**
 * Full sync — fetches and caches ALL data needed for offline operations.
 * Call this after login while online.
 * Returns true if all data was synced successfully.
 */
export async function syncAllDataForOffline(onProgress?: ProgressCallback): Promise<boolean> {
  const steps = [
    'Syncing templates...',
    'Syncing filters...',
    'Syncing filter states...',
    'Syncing cleaning reasons...',
    'Syncing equipment groups...',
    'Syncing identifiers...',
    'Syncing PM schedules...',
    'Syncing checklist profiles...',
    'Syncing cleaning profiles...',
  ];
  let currentStep = 0;
  const total = steps.length;
  // Audit 2026-05-04 fix #2 (web-plumbing review C1): track soft failures
  // (caught exceptions on individual sync steps) so the final `done` event
  // can surface them. Previously every per-step `catch { /* skip */ }`
  // silently advanced and the function reported "All data synced" —
  // operators saw a green check while master-data caches were stale.
  const softFailures: string[] = [];
  const recordSoftFailure = (label: string, err: any) => {
    softFailures.push(label);
    console.warn(`[offline-sync] soft failure on "${label}":`, err?.message ?? err);
  };

  const report = (step: string, done = false, error?: string, partialFailures?: string[]) => {
    onProgress?.({ step, current: currentStep, total, done, error, partialFailures });
  };

  try {
    // 1. Templates
    // A-01 Wave 5 carve-out (2026-05-29): cannot migrate to /api/hierarchy/*
    // because the 'templates' IDB cache is consumed by mobile-operations.tsx
    // and filter-operations.tsx (both carve-outs) using templateKind
    // discriminators ('BLOCK', 'FILTER', 'AHU', 'AREA') to tell entity kinds
    // apart in a mixed instances array. The hierarchy endpoints only serve
    // one typed kind per endpoint, so they can't rebuild this mixed cache.
    // Unblocked when those two carve-out files migrate off templateId/templateKind.
    report(steps[currentStep]);
    const templatesRes = await apiClient.get<any>('/api/assets/templates');
    await cacheItem('templates', templatesRes?.data ?? []);
    currentStep++;

    // 2. Filter instances
    // A-01 Wave 5 carve-out (2026-05-29): cannot migrate to /api/hierarchy/filters
    // because CachedFilter (offline-store.ts) requires `templateId` and the
    // hierarchy Filter model dropped that column (D-03 fix, 2026-05-25).
    // filter-operations.tsx also reads `offlineInstances` and uses
    // `f.templateId === blockTemplateId` to discriminate entity kinds in a
    // mixed array — that pattern requires ALL entity kinds in one list.
    // Migration is gated on filter-operations.tsx + mobile-operations.tsx
    // moving off the templateId discriminator and CachedFilter dropping templateId.
    report(steps[currentStep]);
    const instancesRes = await apiClient.get<any>('/api/assets/instances');
    const instances = instancesRes?.data ?? [];
    await cacheFilters(instances); // stores in 'filters' IndexedDB store
    await cacheItem('instances-raw', instances); // also cache raw for reference

    // A-01 coupled-cluster Step 2 (2026-05-29): silently dual-cache from the
    // typed-hierarchy endpoints. Soft-fail so a hierarchy outage doesn't
    // break the (still-canonical) legacy sync above. When consumers migrate
    // (Steps 3-6) they'll read from these typed stores; until then they're
    // populated-but-unused inventory.
    try {
      const [blocksRes, areasRes, ahusRes, filtersTypedRes] = await Promise.all([
        apiClient.get<any>('/api/hierarchy/blocks'),
        apiClient.get<any>('/api/hierarchy/areas?limit=500'),
        apiClient.get<any>('/api/hierarchy/ahus?limit=500'),
        apiClient.get<any>('/api/hierarchy/filters'),
      ]);
      await Promise.all([
        cacheBlocks(blocksRes?.data ?? []),
        cacheAreas(areasRes?.data ?? []),
        cacheAhus(ahusRes?.data ?? []),
        cacheFiltersTyped(filtersTypedRes?.data ?? []),
      ]);
    } catch (err) {
      recordSoftFailure('typed-hierarchy-caches', err);
    }
    currentStep++;

    // 3. Filter states (batch — single API call for ALL filters)
    report(steps[currentStep]);
    try {
      const batchResult = await apiClient.get<{ states: Record<string, any>; cachedAt: string }>('/api/filters/batch-states');
      if (batchResult?.states) {
        const stateEntries = Object.entries(batchResult.states);
        for (const [filterId, stateObj] of stateEntries) {
          // Derive pendingChecklist from the tape before caching — the server
          // stopped emitting it post-Phase-8.7, and an empty one makes the
          // offline executor silently skip required checklists. See
          // withDerivedPendingChecklist docblock (offline-cache.ts).
          await cacheItem(`filter-state-${filterId}`, withDerivedPendingChecklist(stateObj));
        }
      }
    } catch (err) {
      // Batch endpoint might not exist — fall back to individual calls.
      // The batch failure itself is a soft failure (degraded path); the
      // per-filter loop tolerates individual misses.
      recordSoftFailure('filter-states-batch', err);
      // Bug fix 2026-05-10: was matching `t.name === 'Filter'` which breaks
      // when admin renames the template or creates a variant. Match by
      // stable `templateKind === 'FILTER'`. Instance API includes
      // `template.templateKind` (instance.repository.ts:16) so we don't
      // even need the templates response — but keep the templateId fallback
      // path in case the instance projection ever drops it.
      const filterTemplateIds = new Set(
        (templatesRes?.data ?? [])
          .filter((t: any) => t.templateKind === 'FILTER')
          .map((t: any) => t.id),
      );
      const filters = instances.filter((i: any) =>
        (i.template?.templateKind === 'FILTER' || filterTemplateIds.has(i.templateId)) && i.isActive !== false && i.status !== 'Retired'
      );
      let perFilterMisses = 0;
      for (const f of filters) {
        try {
          const st = await apiClient.get<any>(`/api/filters/${f.id}/current-state`);
          await cacheItem(`filter-state-${f.id}`, withDerivedPendingChecklist(st));
        } catch { perFilterMisses++; }
      }
      if (perFilterMisses > 0) {
        recordSoftFailure(`filter-states-individual (${perFilterMisses} miss${perFilterMisses === 1 ? '' : 'es'})`, null);
      }
    }
    currentStep++;

    // 4. Cleaning reasons
    report(steps[currentStep]);
    const reasonsRes = await apiClient.get<any>('/api/filters/reasons');
    const reasons = (reasonsRes as any)?.reasons ?? reasonsRes ?? [];
    await cacheItem('cleaning-reasons', reasons);
    currentStep++;

    // 5. Equipment groups (with instruments)
    report(steps[currentStep]);
    const equipRes = await apiClient.get<any>('/api/equipment-groups');
    const equipGroups = Array.isArray(equipRes) ? equipRes : equipRes?.data ?? [];
    await cacheItem('equipment-groups', equipGroups);
    currentStep++;

    // 6. Identifier map (RFID/barcode → filterId+filterName)
    // A-01 Wave 5 note (2026-05-29): identifiers remain on /api/assets/identifiers.
    // There is no /api/hierarchy/identifiers endpoint — identifiers are a
    // cross-cutting concern (one identifier per asset, independent of typed-table
    // kind). No migration needed here.
    report(steps[currentStep]);
    const identRes = await apiClient.get<any[]>('/api/assets/identifiers');
    const identList = Array.isArray(identRes) ? identRes : [];
    const identMap: Record<string, { filterId: string; filterName: string }> = {};
    for (const ident of identList) {
      if (ident.identifierValue && ident.assetId) {
        const entry = { filterId: ident.assetId, filterName: ident.asset?.name || ident.assetId };
        identMap[ident.identifierValue] = entry;
        identMap[ident.identifierValue.toUpperCase()] = entry;
        identMap[ident.identifierValue.toLowerCase()] = entry;
      }
    }
    await cacheItem('identifier-map', identMap);
    currentStep++;

    // 7. PM schedules (due tasks)
    report(steps[currentStep]);
    try {
      const pmRes = await apiClient.get<any>('/api/pm-schedules/due');
      await cacheItem('due-tasks', pmRes);
    } catch (err) {
      // PM endpoint may legitimately 403 for some roles — soft failure, not fatal.
      recordSoftFailure('pm-schedules', err);
    }
    currentStep++;

    // 8. Checklist profiles (with questions)
    report(steps[currentStep]);
    try {
      const checklistRes = await apiClient.get<any>('/api/checklist-profiles?limit=100&isActive=true&expand=questions');
      await cacheItem('checklist-profiles', checklistRes?.data ?? []);
    } catch (err) {
      recordSoftFailure('checklist-profiles', err);
    }
    currentStep++;

    // 9. Cleaning profiles (with stages and connections)
    report(steps[currentStep]);
    try {
      const profilesRes = await apiClient.get<any>('/api/filter-cleaning-profiles?limit=100&status=ACTIVE');
      const profiles = profilesRes?.data ?? [];
      await cacheItem('cleaning-profiles', profiles);
      // Also cache each profile's full pipeline (stages + connections)
      let perProfileMisses = 0;
      for (const p of profiles) {
        try {
          const fullProfile = await apiClient.get<any>(`/api/filter-cleaning-profiles/${p.id}`);
          await cacheItem(`cleaning-profile-${p.id}`, fullProfile);
        } catch { perProfileMisses++; }
      }
      if (perProfileMisses > 0) {
        recordSoftFailure(`cleaning-profile-pipelines (${perProfileMisses} miss${perProfileMisses === 1 ? '' : 'es'})`, null);
      }
    } catch (err) {
      recordSoftFailure('cleaning-profiles', err);
    }
    currentStep++;

    // Audit 2026-05-04 fix #2: report partial failures explicitly. The
    // function still returns true if no STEP threw all the way out (the
    // overall sync ran end-to-end), but the caller now sees the list of
    // steps that soft-failed and can surface "Synced with warnings".
    if (softFailures.length > 0) {
      report(`Synced with warnings: ${softFailures.length} step(s) failed`, true, undefined, softFailures);
      return false;
    }
    report('All data synced', true);
    return true;
  } catch (err: any) {
    report(
      `Sync failed: ${err?.message || 'Unknown error'}`,
      false,
      err?.message,
      softFailures.length > 0 ? softFailures : undefined,
    );
    return false;
  }
}
