import { describe, it, expect, beforeEach, vi } from 'vitest';

/**
 * Phase 8.4a — versioning regression coverage for ChecklistProfileService.
 *
 * Phase A.1 (2026-05-01) introduced snapshot-then-bump for every mutation of
 * a checklist profile or its questions. These tests pin that contract so a
 * future refactor cannot silently revert the live row to a non-versioned
 * update path.
 *
 * Mocking strategy mirrors filter-operations/__tests__/get-current-state.test.ts:
 * vi.hoisted prisma mock with vi.mock('../../../lib/prisma.js'). The service
 * uses prisma.$transaction directly, so the mock returns the same prisma
 * client as the tx callback argument — every tx.* call is the same vi.fn()
 * we assert on.
 */

const { mockPrisma, mockAuditLog } = vi.hoisted(() => {
  const checklistProfile = {
    findFirst: vi.fn(),
    findUnique: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  };
  const checklistProfileVersion = {
    create: vi.fn(),
    findUnique: vi.fn(),
    findMany: vi.fn(),
    count: vi.fn(),
  };
  const checklistQuestion = {
    findFirst: vi.fn(),
    findMany: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    aggregate: vi.fn(),
  };
  const filterPipelineStage = { count: vi.fn() };

  const prisma: any = {
    checklistProfile,
    checklistProfileVersion,
    checklistQuestion,
    filterPipelineStage,
    $queryRaw: vi.fn(),
    $transaction: vi.fn(async (cb: (tx: any) => Promise<any>) => cb(prisma)),
  };
  return { mockPrisma: prisma, mockAuditLog: vi.fn() };
});

vi.mock('../../../lib/prisma.js', () => ({ prisma: mockPrisma }));
vi.mock('../../../lib/audit.js', () => ({ auditLog: mockAuditLog }));

import { ChecklistProfileService } from '../checklist-profile.service.js';

const ctx: any = {
  userId: 'admin-user-id',
  userSub: 'admin-sub',
  userRole: 'ADMIN',
  ipAddress: '127.0.0.1',
  userAgent: 'test',
  sessionId: 'sess-1',
};

const PROFILE_ID = '11111111-1111-1111-1111-111111111111';

describe('ChecklistProfileService versioning (Phase A.1 / 8.4a)', () => {
  let service: ChecklistProfileService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuditLog.mockResolvedValue(undefined);
    // Re-bind $transaction since vi.clearAllMocks resets the implementation.
    mockPrisma.$transaction.mockImplementation(async (cb: (tx: any) => Promise<any>) => cb(mockPrisma));
    service = new ChecklistProfileService();
  });

  describe('create', () => {
    it('creates profile at version=1 and writes NO sidecar row (lazy first-version)', async () => {
      mockPrisma.checklistProfile.create.mockResolvedValue({
        id: PROFILE_ID,
        name: 'Wash-In Checklist',
        description: 'Operator pre-checks',
        version: 1,
        isActive: true,
      });

      const result = await service.create(ctx, { name: 'Wash-In Checklist', description: 'Operator pre-checks' });

      expect(result.version).toBe(1);
      // The Phase A.1 service comment (lines 159-160) is explicit: first version
      // is the live row itself — no sidecar archive on create. If a future
      // refactor flips this to eager-archive, our offline replay assumptions
      // (live row IS v1) silently break, so guard it here.
      expect(mockPrisma.checklistProfileVersion.create).not.toHaveBeenCalled();
      expect(mockPrisma.checklistProfile.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            name: 'Wash-In Checklist',
            description: 'Operator pre-checks',
            createdBy: ctx.userSub,
          }),
        }),
      );
      expect(mockAuditLog).toHaveBeenCalledTimes(1);
    });
  });

  describe('update', () => {
    it('snapshots OUTGOING state into ChecklistProfileVersion, then bumps live version', async () => {
      // The pre-update live row that snapshotProfile() reads inside the tx.
      mockPrisma.checklistProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID,
        name: 'Old Name',
        description: 'Old description',
        isActive: true,
        version: 3,
        questions: [
          {
            id: 'q1',
            question: 'Is the filter installed correctly?',
            questionType: 'YES_NO',
            required: true,
            section: 'Pre-checks',
            description: null,
            options: [],
            validation: {},
            sortOrder: 0,
          },
        ],
      });

      mockPrisma.checklistProfileVersion.create.mockResolvedValue({});
      mockPrisma.checklistProfile.update
        .mockResolvedValueOnce({ id: PROFILE_ID, version: 4 }) // bump call inside snapshotAndBump
        .mockResolvedValueOnce({                                 // actual update call
          id: PROFILE_ID,
          name: 'New Name',
          description: 'Old description',
          isActive: true,
          version: 4,
        });

      const result = await service.update(ctx, PROFILE_ID, { name: 'New Name' });

      // 1) Sidecar archived the OUTGOING (version=3) snapshot, not v4.
      expect(mockPrisma.checklistProfileVersion.create).toHaveBeenCalledTimes(1);
      const archivedCall = mockPrisma.checklistProfileVersion.create.mock.calls[0][0];
      expect(archivedCall.data.profileId).toBe(PROFILE_ID);
      expect(archivedCall.data.versionNumber).toBe(3);
      expect(archivedCall.data.snapshot).toMatchObject({
        name: 'Old Name',
        description: 'Old description',
        isActive: true,
        questions: [
          expect.objectContaining({ id: 'q1', question: 'Is the filter installed correctly?' }),
        ],
      });
      expect(archivedCall.data.createdBy).toBe(ctx.userSub);

      // 2) Live row's version was incremented inside the same transaction.
      expect(mockPrisma.checklistProfile.update).toHaveBeenCalledTimes(2);
      const bumpCall = mockPrisma.checklistProfile.update.mock.calls[0][0];
      expect(bumpCall).toEqual({
        where: { id: PROFILE_ID },
        data: { version: { increment: 1 } },
      });

      // 3) The actual content update happened second, with only the changed field.
      const updateCall = mockPrisma.checklistProfile.update.mock.calls[1][0];
      expect(updateCall.where).toEqual({ id: PROFILE_ID });
      expect(updateCall.data).toEqual({ name: 'New Name' });

      // 4) Returned the updated row.
      expect(result.version).toBe(4);
      expect(result.name).toBe('New Name');
    });

    it('addQuestion bumps version and snapshots prior state — locks down the question-mutation path that drives offline replay', async () => {
      // Pre-add live row.
      mockPrisma.checklistProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID,
        name: 'Profile A',
        description: null,
        isActive: true,
        version: 7,
        questions: [], // adding the first question
      });
      mockPrisma.checklistQuestion.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      mockPrisma.checklistProfileVersion.create.mockResolvedValue({});
      mockPrisma.checklistProfile.update.mockResolvedValue({ id: PROFILE_ID, version: 8 });
      mockPrisma.checklistQuestion.create.mockResolvedValue({
        id: 'q-new', profileId: PROFILE_ID, question: 'New Q?', sortOrder: 0,
      });

      const result = await service.addQuestion(ctx, PROFILE_ID, { question: 'New Q?' });

      // Snapshot of v7 archived BEFORE bumping or inserting the question.
      expect(mockPrisma.checklistProfileVersion.create).toHaveBeenCalledTimes(1);
      const archivedCall = mockPrisma.checklistProfileVersion.create.mock.calls[0][0];
      expect(archivedCall.data.versionNumber).toBe(7);
      expect(archivedCall.data.changeNotes).toMatch(/question added: New Q\?/);

      // Version bump happened.
      expect(mockPrisma.checklistProfile.update).toHaveBeenCalledWith({
        where: { id: PROFILE_ID },
        data: { version: { increment: 1 } },
      });

      // Question created with sortOrder=0 (max was null).
      expect(mockPrisma.checklistQuestion.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ profileId: PROFILE_ID, question: 'New Q?', sortOrder: 0 }),
        }),
      );

      expect(result.id).toBe('q-new');
    });
  });

  /**
   * Audit L116 regression coverage. Before this fix `auditLog` was called in
   * create() only — every other mutation changed operator records with no
   * §11.10(e) trail. ChecklistProfileVersion is NOT a substitute: it isn't
   * hash-chained, isn't immutable, isn't shown in the inspector UI, and
   * delete() cascade-destroys it.
   */
  describe('audit trail (§11.10(e))', () => {
    const auditCall = () => mockAuditLog.mock.calls[0][0];

    it('update() audits with before/after values', async () => {
      mockPrisma.checklistProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID, name: 'Old Name', description: 'Old desc',
        isActive: true, version: 3, questions: [],
      });
      mockPrisma.checklistProfileVersion.create.mockResolvedValue({});
      mockPrisma.checklistProfile.update
        .mockResolvedValueOnce({ id: PROFILE_ID, version: 4 })
        .mockResolvedValueOnce({ id: PROFILE_ID, name: 'New Name', description: 'Old desc', isActive: true, version: 4 });

      await service.update(ctx, PROFILE_ID, { name: 'New Name' });

      expect(mockAuditLog).toHaveBeenCalledTimes(1);
      expect(auditCall()).toMatchObject({
        userId: ctx.userId,
        action: 'UPDATED',
        targetType: 'checklist_profile',
        targetId: PROFILE_ID,
        beforeValue: { name: 'Old Name', version: 3 },
        afterValue: { name: 'New Name', version: 4 },
      });
    });

    it('delete() captures name + destroyed version count in beforeValue (the rows cascade away)', async () => {
      mockPrisma.checklistProfile.findFirst.mockResolvedValue({
        id: PROFILE_ID, name: 'Doomed Checklist', description: 'd',
        isActive: true, version: 5, questions: [{ id: 'q1' }, { id: 'q2' }],
      });
      mockPrisma.filterPipelineStage.count.mockResolvedValue(0);
      mockPrisma.$queryRaw.mockResolvedValue([{ count: 0n }]);
      mockPrisma.checklistProfileVersion.count.mockResolvedValue(4);
      mockPrisma.checklistProfile.delete.mockResolvedValue({});

      await service.delete(ctx, PROFILE_ID);

      expect(auditCall()).toMatchObject({
        action: 'DELETED',
        targetType: 'checklist_profile',
        targetId: PROFILE_ID,
        beforeValue: {
          name: 'Doomed Checklist',
          version: 5,
          questionCount: 2,
          archivedVersionsDestroyed: 4,
        },
      });
    });

    it('delete() does NOT audit when the in-use guard rejects the delete', async () => {
      mockPrisma.checklistProfile.findFirst.mockResolvedValue({
        id: PROFILE_ID, name: 'In Use', version: 1, questions: [],
      });
      mockPrisma.filterPipelineStage.count.mockResolvedValue(2);

      await expect(service.delete(ctx, PROFILE_ID)).rejects.toThrow(/referenced by/);

      expect(mockPrisma.checklistProfile.delete).not.toHaveBeenCalled();
      expect(mockAuditLog).not.toHaveBeenCalled();
    });

    it('addQuestion() audits with the owning profile name so {targetName} renders', async () => {
      mockPrisma.checklistProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID, name: 'Profile A', description: null,
        isActive: true, version: 7, questions: [],
      });
      mockPrisma.checklistQuestion.aggregate.mockResolvedValue({ _max: { sortOrder: null } });
      mockPrisma.checklistProfileVersion.create.mockResolvedValue({});
      mockPrisma.checklistProfile.update.mockResolvedValue({ id: PROFILE_ID, version: 8 });
      mockPrisma.checklistQuestion.create.mockResolvedValue({
        id: 'q-new', question: 'New Q?', questionType: 'YES_NO',
        required: false, section: null, sortOrder: 0,
      });

      await service.addQuestion(ctx, PROFILE_ID, { question: 'New Q?' });

      expect(auditCall()).toMatchObject({
        action: 'CHECKLIST_QUESTION_ADDED',
        targetType: 'checklist_profile',
        targetId: PROFILE_ID,
        // audit-helpers resolves {targetName} from afterValue.name — without it
        // the inspector row reads 'Question added to checklist ""'.
        afterValue: { name: 'Profile A', questionId: 'q-new', question: 'New Q?' },
      });
    });

    it('updateQuestion() audits before + after question state', async () => {
      mockPrisma.checklistQuestion.findFirst.mockResolvedValue({
        id: 'q1', profileId: PROFILE_ID, question: 'Old Q?', questionType: 'YES_NO',
        required: false, section: null, sortOrder: 0,
      });
      mockPrisma.checklistProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID, name: 'Profile A', description: null,
        isActive: true, version: 2, questions: [],
      });
      mockPrisma.checklistProfileVersion.create.mockResolvedValue({});
      mockPrisma.checklistProfile.update.mockResolvedValue({ id: PROFILE_ID, version: 3 });
      mockPrisma.checklistQuestion.update.mockResolvedValue({
        id: 'q1', question: 'New Q?', questionType: 'YES_NO',
        required: true, section: null, sortOrder: 0,
      });

      await service.updateQuestion(ctx, PROFILE_ID, 'q1', { question: 'New Q?', required: true });

      expect(auditCall()).toMatchObject({
        action: 'CHECKLIST_QUESTION_UPDATED',
        targetId: PROFILE_ID,
        beforeValue: { name: 'Profile A', questionId: 'q1', question: 'Old Q?', required: false },
        afterValue: { name: 'Profile A', questionId: 'q1', question: 'New Q?', required: true },
      });
    });

    it('deleteQuestion() audits the destroyed question in beforeValue', async () => {
      mockPrisma.checklistQuestion.findFirst.mockResolvedValue({
        id: 'q1', profileId: PROFILE_ID, question: 'Doomed Q?', questionType: 'TEXT',
        required: true, section: 'S1', sortOrder: 2,
      });
      mockPrisma.checklistProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID, name: 'Profile A', description: null,
        isActive: true, version: 2, questions: [],
      });
      mockPrisma.checklistProfileVersion.create.mockResolvedValue({});
      mockPrisma.checklistProfile.update.mockResolvedValue({ id: PROFILE_ID, version: 3 });
      mockPrisma.checklistQuestion.delete.mockResolvedValue({});

      await service.deleteQuestion(ctx, PROFILE_ID, 'q1');

      expect(auditCall()).toMatchObject({
        action: 'CHECKLIST_QUESTION_DELETED',
        targetId: PROFILE_ID,
        beforeValue: { name: 'Profile A', questionId: 'q1', question: 'Doomed Q?', sortOrder: 2 },
      });
    });

    it('reorderQuestions() audits the old and new order', async () => {
      mockPrisma.checklistProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID, name: 'Profile A', description: null,
        isActive: true, version: 2, questions: [],
      });
      mockPrisma.checklistQuestion.findMany.mockResolvedValue([{ id: 'q1' }, { id: 'q2' }, { id: 'q3' }]);
      mockPrisma.checklistProfileVersion.create.mockResolvedValue({});
      mockPrisma.checklistProfile.update.mockResolvedValue({ id: PROFILE_ID, version: 3 });
      mockPrisma.checklistQuestion.update.mockResolvedValue({});

      await service.reorderQuestions(ctx, PROFILE_ID, ['q3', 'q1', 'q2']);

      expect(auditCall()).toMatchObject({
        action: 'CHECKLIST_QUESTIONS_REORDERED',
        targetId: PROFILE_ID,
        beforeValue: { name: 'Profile A', questionOrder: ['q1', 'q2', 'q3'] },
        afterValue: { name: 'Profile A', questionOrder: ['q3', 'q1', 'q2'] },
      });
    });

    // Gotcha 1: auditLog's chain write must not ride inside the business tx.
    // A rollback would otherwise leave a phantom audit row for a change that
    // never persisted.
    it('does not audit when the transaction throws', async () => {
      mockPrisma.checklistProfile.findUnique.mockResolvedValue({
        id: PROFILE_ID, name: 'Profile A', version: 1, questions: [],
      });
      mockPrisma.checklistProfileVersion.create.mockRejectedValue(new Error('tx boom'));

      await expect(service.update(ctx, PROFILE_ID, { name: 'X' })).rejects.toThrow('tx boom');
      expect(mockAuditLog).not.toHaveBeenCalled();
    });
  });
});
