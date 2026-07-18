import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    filterCleaningProfile: { findFirst: vi.fn(), findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    filterPipelineConnection: { createMany: vi.fn() },
    $transaction: vi.fn(),
  },
}));
vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: vi.fn().mockResolvedValue(undefined) }));

import { CleaningProfileService } from '../cleaning-profile.service.js';

const service = new CleaningProfileService();
const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' } as any;

/**
 * Enterprise-audit finding M12 (2026-07-15): every connection check lived inside
 * `if (connections.length > 0)`, so an edgeless graph skipped validation and
 * saved as ACTIVE. The stage chain is walked over connections, so a cycle
 * started against such a profile can never advance.
 *
 * Two reachable doors, both closed here:
 *  - POST with `connections: []` (or omitted — the body schema never required it).
 *  - PUT with `{connections: []}` and no `stages`, which skipped validatePipeline
 *    entirely and published a new ACTIVE version carrying the old stages.
 *
 * Nothing legitimate is being rejected: create() hardcodes status ACTIVE (there
 * is no draft state), and all 51 profiles in the live DB carry >= 3 connections
 * (verified 2026-07-15), so an edgeless pipeline has never been a real state.
 */

const START = { nodeType: 'START', sortOrder: 0 };
const END = { nodeType: 'END', sortOrder: 1 };
const TWO_STAGES = [START, END];
const ONE_EDGE = [{ fromIndex: 0, toIndex: 1, label: 'Next' }];

/** An existing persisted version: START -> END, stages carrying real ids. */
function existingProfile() {
  return {
    id: 'p1',
    lineageId: 'lin-1',
    name: 'Existing',
    version: 1,
    status: 'ACTIVE',
    stages: [
      { id: 'stage-a', nodeType: 'START', sortOrder: 0, stateKey: null, configuration: {} },
      { id: 'stage-b', nodeType: 'END', sortOrder: 1, stateKey: null, configuration: {} },
    ],
    connections: [{ id: 'c1', fromStageId: 'stage-a', toStageId: 'stage-b', label: 'Next' }],
  };
}

describe('cleaning profile — a pipeline with no connections is rejected', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.filterCleaningProfile.findFirst.mockResolvedValue(existingProfile());
  });

  describe('create', () => {
    it('rejects an explicitly empty connections array', async () => {
      await expect(
        service.create(ctx, { name: 'Edgeless', stages: TWO_STAGES, connections: [] }),
      ).rejects.toThrow(/at least one connection/i);
      // Must fail BEFORE anything is written.
      expect(mockPrisma.filterCleaningProfile.create).not.toHaveBeenCalled();
    });

    it('rejects an omitted connections array (the POST schema never required it)', async () => {
      await expect(
        service.create(ctx, { name: 'Edgeless', stages: TWO_STAGES }),
      ).rejects.toThrow(/at least one connection/i);
      expect(mockPrisma.filterCleaningProfile.create).not.toHaveBeenCalled();
    });

    it('still accepts a connected pipeline', async () => {
      mockPrisma.filterCleaningProfile.create.mockResolvedValue({
        id: 'new-1',
        stages: [{ id: 's0', sortOrder: 0 }, { id: 's1', sortOrder: 1 }],
      });
      mockPrisma.filterPipelineConnection.createMany.mockResolvedValue({ count: 1 });

      await service.create(ctx, { name: 'Good', stages: TWO_STAGES, connections: ONE_EDGE });
      expect(mockPrisma.filterCleaningProfile.create).toHaveBeenCalled();
    });
  });

  describe('update', () => {
    it('rejects stripping every connection via {connections: []} with no stages', async () => {
      // The worst door: no `data.stages` meant validatePipeline was never called.
      await expect(
        service.update(ctx, 'p1', { connections: [] }),
      ).rejects.toThrow(/at least one connection/i);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejects stages + an empty connections array', async () => {
      await expect(
        service.update(ctx, 'p1', { stages: TWO_STAGES, connections: [] }),
      ).rejects.toThrow(/at least one connection/i);
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('accepts a metadata-only edit, validating the retained pipeline', async () => {
      // Regression guard for the fix itself: validating the EFFECTIVE pipeline
      // must resolve the stored connections' stage UUIDs via sortOrder, or a
      // rename would be rejected for a graph the user never touched.
      mockPrisma.$transaction.mockResolvedValue({ id: 'p2' });
      mockPrisma.filterCleaningProfile.findFirst.mockResolvedValue(existingProfile());

      await service.update(ctx, 'p1', { name: 'Renamed' });
      expect(mockPrisma.$transaction).toHaveBeenCalled();
    });
  });
});
