import { describe, it, expect } from 'vitest';
import { getAuditSummary, formatActionLabel, friendlyTargetType, diffAuditValues, maskAuditValue, prettyFieldName, isRedacted, redactionDetail, redactionNote } from './audit-helpers';
import { getDefaultTemplates } from '@digilog/shared';

const T = getDefaultTemplates();

// 2026-07-08: audit rows for Block/Area/AHU/Filter must name the specific kind
// and describe hierarchy links understandably — no "entity"/"asset" jargon.
describe('audit-helpers — Block/Area/AHU/Filter rendering', () => {
  it('names the kind on create (Filter), not "entity"', () => {
    const row = { action: 'ASSET_CREATED', userId: 'EMP-004', targetType: 'asset_instance', afterValue: { name: 'MF3', templateKind: 'FILTER' } };
    expect(getAuditSummary(row, T)).toBe('New Filter "MF3" created by EMP-004');
    expect(formatActionLabel(row.action, row.afterValue)).toBe('Filter Created');
  });

  it('folds the parent into the single create row (created under parent)', () => {
    const row = { action: 'ASSET_CREATED', userId: 'EMP-004', targetType: 'asset_instance',
      afterValue: { name: 'L8', templateKind: 'AHU', parentName: 'B1', parentKind: 'BLOCK' } };
    expect(getAuditSummary(row, T)).toBe('New AHU "L8" created under Block "B1" by EMP-004');
  });

  it('omits the parent clause when there is no parent', () => {
    const row = { action: 'ASSET_CREATED', userId: 'EMP-004', targetType: 'asset_instance', afterValue: { name: 'B1', templateKind: 'BLOCK' } };
    expect(getAuditSummary(row, T)).toBe('New Block "B1" created by EMP-004');
  });

  it('names Block / AHU too', () => {
    const block = { action: 'ASSET_CREATED', userId: 'EMP-004', targetType: 'asset_instance', afterValue: { name: 'B1', templateKind: 'BLOCK' } };
    expect(getAuditSummary(block, T)).toBe('New Block "B1" created by EMP-004');
    const ahu = { action: 'ASSET_CREATED', userId: 'EMP-004', targetType: 'asset_instance', afterValue: { name: 'L8', templateKind: 'AHU' } };
    expect(getAuditSummary(ahu, T)).toBe('New AHU "L8" created by EMP-004');
  });

  it('renders a hierarchy link as "child placed under parent" with kinds', () => {
    const row = { action: 'ASSET_RELATIONSHIP_CREATED', userId: 'EMP-004', targetType: 'asset_relationship',
      afterValue: { sourceName: 'L8', sourceKind: 'AHU', name: 'MF3', targetKind: 'FILTER' } };
    expect(getAuditSummary(row, T)).toBe('Filter "MF3" placed under AHU "L8" by EMP-004');
    expect(formatActionLabel(row.action, row.afterValue)).toBe('Placed Under Parent');
  });

  it('typed filter rows carrying `kind` (not templateKind) still resolve to Filter', () => {
    const row = { action: 'ASSET_CREATED', userId: 'EMP-004', targetType: 'asset_instance', afterValue: { name: 'MF3', kind: 'FILTER' } };
    expect(getAuditSummary(row, T)).toBe('New Filter "MF3" created by EMP-004');
  });

  it('falls back gracefully for old rows without a kind — no entity/asset words', () => {
    const row = { action: 'ASSET_CREATED', userId: 'EMP-004', targetType: 'asset_instance', afterValue: { name: 'MF3' } };
    const s = getAuditSummary(row, T);
    expect(s).toBe('New record "MF3" created by EMP-004');
    expect(s).not.toMatch(/entity|asset/i);
  });

  it('renders generic CREATED/UPDATED by record type from targetType', () => {
    const cp = { action: 'CREATED', userId: 'EMP-004', targetType: 'cleaning_profile', afterValue: { name: 'CP-1' } };
    expect(getAuditSummary(cp, T)).toBe('New Cleaning Profile "CP-1" created by EMP-004');
    const fp = { action: 'UPDATED', userId: 'EMP-004', targetType: 'filter_profile', afterValue: { name: 'FP-1' } };
    expect(getAuditSummary(fp, T)).toBe('Filter Profile "FP-1" updated by EMP-004');
    const pm = { action: 'DELETED', userId: 'EMP-004', targetType: 'pm_schedule', afterValue: { name: 'AHU-9' } };
    expect(getAuditSummary(pm, T)).toBe('PM Schedule "AHU-9" deleted by EMP-004');
  });

  it('omits empty quotes when a record has no name (PM review/approve)', () => {
    const rev = { action: 'PM_SCHEDULE_REVIEWED', userId: 'EMP-123', targetType: 'pm_schedule', afterValue: { ahuName: 'AHU-024' } };
    expect(getAuditSummary(rev, T)).toBe('PM schedule reviewed by EMP-123');
    expect(getAuditSummary(rev, T)).not.toContain('""');
    const app = { action: 'PM_SCHEDULE_APPROVED', userId: 'EMP-003', targetType: 'pm_schedule', afterValue: { ahuName: 'AHU-88' } };
    expect(getAuditSummary(app, T)).toBe('PM schedule approved by EMP-003');
  });

  it('renders newly-added specific templates (no more raw title-case)', () => {
    const dev = { action: 'DEVIATION_OPENED', userId: 'EMP-004', targetType: 'deviation', afterValue: { ahuName: 'L8', name: 'L8' } };
    expect(getAuditSummary(dev, T)).toBe('Overdue-PM deviation opened for AHU "L8" by EMP-004');
    const help = { action: 'HELP_ARTICLE_CREATED', userId: 'EMP-004', targetType: 'help_article', afterValue: { name: 'Getting Started' } };
    expect(getAuditSummary(help, T)).toBe('Help article "Getting Started" created by EMP-004');
  });

  it('friendlyTargetType avoids internal "asset" words', () => {
    expect(friendlyTargetType({ targetType: 'asset_instance', afterValue: { templateKind: 'BLOCK' } })).toBe('Block');
    expect(friendlyTargetType({ targetType: 'asset_instance', afterValue: {} })).toBe('Record');
    expect(friendlyTargetType({ targetType: 'asset_relationship' })).toBe('Hierarchy Link');
  });
});

describe('audit-helpers — before/after diff', () => {
  it('returns only the fields that changed, old → new', () => {
    expect(diffAuditValues({ name: 'A', filterSize: '10' }, { name: 'A', filterSize: '12' }))
      .toEqual([{ field: 'Filter Size', from: '10', to: '12' }]);
  });

  it('returns empty when nothing changed', () => {
    expect(diffAuditValues({ name: 'A' }, { name: 'A' })).toEqual([]);
  });

  it('masks sensitive values', () => {
    expect(diffAuditValues({ password: 'old' }, { password: 'new' }))
      .toEqual([{ field: 'Password', from: '••••••', to: '••••••' }]);
  });

  it('skips id / uuid-valued keys', () => {
    const before = { userId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', name: 'A' };
    const after = { userId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', name: 'B' };
    expect(diffAuditValues(before, after)).toEqual([{ field: 'Name', from: 'A', to: 'B' }]);
  });

  it('maskAuditValue handles null and objects', () => {
    expect(maskAuditValue('name', null)).toBe('-');
    expect(maskAuditValue('meta', { a: 1 })).toBe('{"a":1}');
    expect(prettyFieldName('current_lifecycle_state')).toBe('Current Lifecycle State');
  });

  it('skips camelCase *Id keys even when the value is not a UUID', () => {
    // filterId is a non-UUID (numeric) id — must be skipped by key name, not just value.
    expect(diffAuditValues({ filterId: 5, name: 'A' }, { filterId: 6, name: 'A' })).toEqual([]);
    expect(diffAuditValues({ blockId: 'X1', name: 'A' }, { blockId: 'X2', name: 'B' }))
      .toEqual([{ field: 'Name', from: 'A', to: 'B' }]);
  });

  it('flattens object-valued fields one level (attributes → per-field)', () => {
    expect(diffAuditValues({ attributes: { micronSize: '3', filterSize: '10' } },
                           { attributes: { micronSize: '5', filterSize: '10' } }))
      .toEqual([{ field: 'Micron Size', from: '3', to: '5' }]);
  });
});

// 2026-07-15: STAGE_APPROVAL_SUPERSEDED — a §11 approval request closed WITHOUT a
// decision must render as a readable sentence for the inspector. {currentState} had
// no substitution when the template was added, which is the same defect the
// 2026-05-20 ({reason}) and 2026-06-22 ({stageKey}/{filterName}) fixes cleaned up.
describe('audit-helpers — stage approval superseded rendering', () => {
  // The exact afterValue shape stageApprovalService.supersedeOrphan writes.
  const row = {
    action: 'STAGE_APPROVAL_SUPERSEDED',
    userId: 'superadmin',
    targetType: 'cleaning_stage_approval',
    beforeValue: { status: 'PENDING' },
    afterValue: {
      status: 'SUPERSEDED',
      stageKey: 'DRY_OUT',
      filterName: 'L8/AHU-89/SA/00-01',
      currentState: 'CLEANING_CYCLE_COMPLETED',
      reason: 'the filter advanced past this gated stage before the approval was decided, so it can no longer be approved or rejected',
    },
  };

  it('renders every placeholder — no literal {token} reaches the inspector', () => {
    const s = getAuditSummary(row, T);
    expect(s).not.toMatch(/\{[a-zA-Z]+\}/);
    expect(s).toContain('L8/AHU-89/SA/00-01');
    expect(s).toContain('Dry Out');
    // Prettified, not the raw enum key.
    expect(s).toContain('Cleaning Cycle Completed');
    expect(s).not.toContain('CLEANING_CYCLE_COMPLETED');
    expect(s).toContain('closed without a decision');
  });

  it('says WHY the request ended undecided', () => {
    expect(getAuditSummary(row, T)).toContain('can no longer be approved or rejected');
  });

  it('degrades cleanly when an older row carries no currentState', () => {
    const partial = { ...row, afterValue: { ...row.afterValue, currentState: undefined } };
    const s = getAuditSummary(partial, T);
    expect(s).not.toMatch(/\{[a-zA-Z]+\}/);
  });
});

// M72 (2026-07-15): 3 redacted rows existed in the live audit trail and every
// one rendered as an ordinary record — no badge, no reason, no redactor. These
// helpers back the badge/banner/export note that make a redaction visible.
describe('audit-helpers — redaction visibility', () => {
  const redacted = {
    action: 'LOGIN_SUCCESS',
    userId: 'EMP-004',
    beforeValue: null,
    afterValue: null,
    redactedAt: '2026-07-02T09:52:20.847Z',
    redactedBy: 'f8e5e6e9-db1b-4f87-99f4-dec13cb1cccb',
    redactedByName: 'superadmin',
    redactionReason: 'contained personal data',
  };

  it('flags a row carrying redactedAt', () => {
    expect(isRedacted(redacted)).toBe(true);
  });

  it('does not flag an ordinary row', () => {
    expect(isRedacted({ action: 'LOGIN_SUCCESS', redactedAt: null })).toBe(false);
    expect(isRedacted({ action: 'LOGIN_SUCCESS' })).toBe(false);
    expect(isRedacted(null)).toBe(false);
  });

  it('names the redactor and the reason', () => {
    expect(redactionDetail(redacted)).toEqual({ by: 'superadmin', reason: 'contained personal data' });
  });

  it('falls back to the raw id when the redactor account was deleted', () => {
    // User delete is a hard delete, so redactedByName can come back unresolved.
    // Attribution must degrade to the id, never vanish.
    const { redactedByName, ...noName } = redacted;
    expect(redactionDetail(noName).by).toBe('f8e5e6e9-db1b-4f87-99f4-dec13cb1cccb');
  });

  it('never renders an empty redactor or reason', () => {
    const bare = { redactedAt: '2026-07-02T09:52:20.847Z' };
    expect(redactionDetail(bare)).toEqual({ by: 'unknown user', reason: 'no reason recorded' });
  });

  it('builds a one-line note for flat PDF/Excel cells', () => {
    expect(redactionNote(redacted)).toBe('[REDACTED by superadmin: contained personal data]');
  });

  // The summary of a redacted row is built from a NULLed payload, so on its own
  // it reads exactly like a live record — this is what made the rows invisible.
  it('leaves the summary indistinguishable, which is why the note is required', () => {
    expect(getAuditSummary(redacted, T)).toBe(getAuditSummary({ action: 'LOGIN_SUCCESS', userId: 'EMP-004' }, T));
  });
});
