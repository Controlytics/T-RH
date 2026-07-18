import { describe, it, expect } from 'vitest';

/**
 * Phase 8.4b — IDB v5 versioned-cache store shape.
 *
 * Pure-shape assertions only — full IDB integration would need fake-indexeddb,
 * which the workspace doesn't currently install. The structural pieces tested
 * here (store-name list, default version state) are the contract that the
 * sync engine + tests for syncSince() depend on.
 */

import { SYNC_ID_STORES, DEFAULT_VERSION_STATE } from '../offline-store';

describe('offline-store — IDB v5 store shape (Phase 8.4b)', () => {
  it('1. exposes the 6 sync entity stores in a stable order', () => {
    expect(SYNC_ID_STORES).toEqual([
      'syncFilterCleaningProfiles',
      'syncFilterProfiles',
      'syncEquipmentGroups',
      'syncChecklistProfiles',
      'syncAssetTemplates',
      'syncFilters',
    ]);
  });

  it('2. sync stores DO NOT collide with the legacy "filters" store', () => {
    // The legacy `filters` store at the top of offline-store.ts holds
    // CachedFilter rows in a different shape. The new sync cache uses
    // `syncFilters` to keep them physically separate — same DB, parallel
    // stores. Renaming the legacy store would require a data migration.
    expect((SYNC_ID_STORES as readonly string[])).not.toContain('filters');
    expect((SYNC_ID_STORES as readonly string[])).not.toContain('cache');
    expect((SYNC_ID_STORES as readonly string[])).not.toContain('operations');
    expect((SYNC_ID_STORES as readonly string[])).not.toContain('tombstones');
  });

  it('3. DEFAULT_VERSION_STATE has all 5 numeric cursors at 0 and watermark at null', () => {
    expect(DEFAULT_VERSION_STATE).toEqual({
      key: 'current',
      profileVersion: 0,
      filterProfileVersion: 0,
      equipmentGroupVersion: 0,
      checklistVersion: 0,
      assetTemplateVersion: 0,
      filterUpdatedSince: null,
      lastSyncedAt: null,
    });
  });

  it('4. DEFAULT_VERSION_STATE.key is the literal "current" (single-row store)', () => {
    expect(DEFAULT_VERSION_STATE.key).toBe('current');
  });
});
