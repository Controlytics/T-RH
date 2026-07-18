import { describe, it, expect, beforeEach, vi } from 'vitest';

const { mockTemplateRepo, mockAuditLog } = vi.hoisted(() => ({
  mockTemplateRepo: {
    findMany: vi.fn(),
    findById: vi.fn(),
    findByName: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    softDelete: vi.fn(),
    createVersion: vi.fn(),
    findVersions: vi.fn(),
    // Step 4 (2026-05-02): added so the delete guard can check FilterProfile
    // bindings without hitting prisma directly — keeps unit tests hermetic.
    findFilterProfileBindings: vi.fn(),
  },
  mockAuditLog: vi.fn(),
}));

vi.mock('../../repositories/template.repository.js', () => ({ templateRepository: mockTemplateRepo }));
vi.mock('../../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));

import { templateService } from '../template.service.js';

const ctx = { userId: 'admin', userSub: 'sub-1', userRole: 'ADMIN', ipAddress: '127.0.0.1', userAgent: 'test', sessionId: 'sess-1' };

describe('templateService', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
  });

  describe('list', () => {
    it('returns paginated templates', async () => {
      mockTemplateRepo.findMany.mockResolvedValue({ templates: [{ id: 't1' }], total: 1 });
      const result = await templateService.list({ page: 1, limit: 10 });
      expect(result.data).toHaveLength(1);
      expect(result.totalPages).toBe(1);
    });

    it('applies search filter', async () => {
      mockTemplateRepo.findMany.mockResolvedValue({ templates: [], total: 0 });
      await templateService.list({ page: 1, limit: 10, search: 'pump' });
      const where = mockTemplateRepo.findMany.mock.calls[0][0];
      expect(where.name).toEqual(expect.objectContaining({ contains: 'pump' }));
    });
  });

  describe('getById', () => {
    it('returns template', async () => {
      mockTemplateRepo.findById.mockResolvedValue({ id: 't1', name: 'Pump' });
      const result = await templateService.getById('t1');
      expect(result.name).toBe('Pump');
    });

    it('throws NotFoundError', async () => {
      mockTemplateRepo.findById.mockResolvedValue(null);
      await expect(templateService.getById('missing')).rejects.toThrow('not found');
    });
  });

  describe('create', () => {
    it('creates template with version 1', async () => {
      mockTemplateRepo.findByName.mockResolvedValue(null);
      const template = {
        id: 't1', name: 'Pump', description: 'A pump', version: 1,
        attributeSchema: [], telemetrySchema: [], expectedIdentifiers: [],
        expectedRelationships: [], statusLifecycle: null,
        checklistSchema: [], maxParentConnections: 1, maxConnections: 10,
      };
      mockTemplateRepo.create.mockResolvedValue(template);
      mockTemplateRepo.createVersion.mockResolvedValue({});

      const result = await templateService.create({ name: 'Pump', description: 'A pump' }, ctx);
      expect(result.name).toBe('Pump');
      expect(mockTemplateRepo.createVersion).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 1 }));
      expect(mockAuditLog).toHaveBeenCalledTimes(2); // version + template created
    });

    it('rejects duplicate name', async () => {
      mockTemplateRepo.findByName.mockResolvedValue({ id: 'existing' });
      await expect(templateService.create({ name: 'Dup' }, ctx)).rejects.toThrow('already exists');
    });
  });

  describe('update', () => {
    it('increments version and creates snapshot', async () => {
      const existing = {
        id: 't1', name: 'Pump', version: 2, description: 'Old',
        attributeSchema: [], telemetrySchema: [], expectedIdentifiers: [],
        expectedRelationships: [], statusLifecycle: null,
        checklistSchema: [], maxParentConnections: 1, maxConnections: 10,
      };
      mockTemplateRepo.findById.mockResolvedValue(existing);
      mockTemplateRepo.findByName.mockResolvedValue(null);
      mockTemplateRepo.update.mockResolvedValue({ ...existing, name: 'Pump V3', version: 3 });
      mockTemplateRepo.createVersion.mockResolvedValue({});

      const result = await templateService.update('t1', { name: 'Pump V3' }, ctx);
      expect(result.version).toBe(3);
      expect(mockTemplateRepo.createVersion).toHaveBeenCalledWith(expect.objectContaining({ versionNumber: 3 }));
    });

    it('rejects rename to existing name', async () => {
      mockTemplateRepo.findById.mockResolvedValue({ id: 't1', name: 'Old', version: 1 });
      mockTemplateRepo.findByName.mockResolvedValue({ id: 't2' }); // different template has that name
      await expect(templateService.update('t1', { name: 'Taken' }, ctx)).rejects.toThrow('already exists');
    });
  });

  describe('delete', () => {
    it('soft deletes template when no FilterProfile binds it', async () => {
      mockTemplateRepo.findById.mockResolvedValue({ id: 't1', name: 'P', isActive: true });
      mockTemplateRepo.findFilterProfileBindings.mockResolvedValue([]);
      mockTemplateRepo.softDelete.mockResolvedValue({});

      await templateService.delete('t1', ctx);
      expect(mockTemplateRepo.findFilterProfileBindings).toHaveBeenCalledWith('t1');
      expect(mockTemplateRepo.softDelete).toHaveBeenCalledWith('t1', 'admin');
    });

    // Step 4 guard (2026-05-02): block delete with 409 IN_USE when any
    // FilterProfile binds the template via filter_profile_applicable_templates.
    // Step 4 UX follow-up: error includes structured `details.bindings` so the
    // FE can render a clickable list instead of regex-parsing the message.
    it('rejects with 409 TEMPLATE_IN_USE + structured bindings when FilterProfile bindings exist', async () => {
      mockTemplateRepo.findById.mockResolvedValue({ id: 't1', name: 'Block-T', isActive: true });
      mockTemplateRepo.findFilterProfileBindings.mockResolvedValue([
        { profileId: 'fp1', templateId: 't1', profile: { id: 'fp1', name: 'Standard FP' } },
        { profileId: 'fp2', templateId: 't1', profile: { id: 'fp2', name: 'Strict FP' } },
      ]);

      try {
        await templateService.delete('t1', ctx);
        throw new Error('expected delete to throw');
      } catch (err: any) {
        expect(err.statusCode).toBe(409);
        expect(err.code).toBe('TEMPLATE_IN_USE');
        expect(err.message).toMatch(/still bound by 2 filter profile\(s\) \[Standard FP, Strict FP\]/);
        expect(err.details).toEqual({
          bindings: [
            { id: 'fp1', name: 'Standard FP' },
            { id: 'fp2', name: 'Strict FP' },
          ],
        });
      }
      expect(mockTemplateRepo.softDelete).not.toHaveBeenCalled();
    });
  });

});
