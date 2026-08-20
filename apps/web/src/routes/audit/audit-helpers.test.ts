import { describe, it, expect } from 'vitest';
import { getAuditSummary, formatActionLabel, friendlyTargetType, diffAuditValues, maskAuditValue, prettyFieldName, isRedacted, redactionDetail, redactionNote } from './audit-helpers';
import { getDefaultTemplates } from '@digilog/shared';

const T = getDefaultTemplates();

// Generic record rendering: the summary must read as a sentence an inspector
// can follow, with no internal snake_case and no unsubstituted placeholders.
describe('audit-helpers — generic record rendering', () => {
  it('renders generic CREATED/UPDATED/DELETED by record type from targetType', () => {
    const grp = { action: 'CREATED', userId: 'EMP-004', targetType: 'user_group', afterValue: { name: 'QA Leads' } };
    expect(getAuditSummary(grp, T)).toBe('New User Group "QA Leads" created by EMP-004');
    const art = { action: 'UPDATED', userId: 'EMP-004', targetType: 'help_article', afterValue: { name: 'Getting Started' } };
    expect(getAuditSummary(art, T)).toBe('Help Article "Getting Started" updated by EMP-004');
    const fl = { action: 'DELETED', userId: 'EMP-004', targetType: 'functional_location', afterValue: { name: 'Block A' } };
    expect(getAuditSummary(fl, T)).toBe('Functional Location "Block A" deleted by EMP-004');
  });

  it('omits empty quotes when a record carries no name', () => {
    const row = { action: 'UPDATED', userId: 'EMP-123', targetType: 'role', afterValue: {} };
    expect(getAuditSummary(row, T)).not.toContain('""');
    expect(getAuditSummary(row, T)).toBe('Role updated by EMP-123');
  });

  it('renders specific templates rather than raw title-case', () => {
    const help = { action: 'HELP_ARTICLE_CREATED', userId: 'EMP-004', targetType: 'help_article', afterValue: { name: 'Getting Started' } };
    expect(getAuditSummary(help, T)).toBe('Help article "Getting Started" created by EMP-004');
  });

  it('friendlyTargetType title-cases the targetType, never showing snake_case', () => {
    expect(friendlyTargetType({ targetType: 'user_group' })).toBe('User Group');
    expect(friendlyTargetType({ targetType: 'functional_location' })).toBe('Functional Location');
    expect(friendlyTargetType({})).toBe('-');
  });

  // Guards the recurring bug this file was written for: a template placeholder
  // with no substitution in audit-helpers renders LITERALLY, in the trail and in
  // the exported 21 CFR §11 record. Asserted over the whole live registry so a
  // newly-added template cannot reintroduce it.
  it('no template leaves a literal {token} for the inspector', () => {
    const row = {
      userId: 'EMP-001', targetType: 'instrument', targetId: 'PROBE-01',
      beforeValue: { name: 'X', code: 'PROBE-01', reason: 'r', gateway: 'GW-1' },
      afterValue: { name: 'X', code: 'PROBE-01', reason: 'r', gateway: 'GW-1',
                    attribute: 'temp_decimals', location: 'Block A', room: 'R-1', floorplan: 'Plan 1' },
    };
    for (const action of Object.keys(T)) {
      expect(getAuditSummary({ ...row, action }, T), `${action} left a literal placeholder`)
        .not.toMatch(/\{[a-zA-Z]+\}/);
    }
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
// 2026-08-06: the eight INSTRUMENT_* templates use {instrument}/{gateway}, but
// audit-helpers had no substitution for either — every instrument row rendered
// the literal "{instrument}" in the trail. Row shapes below are copied exactly
// from the auditLog() calls in apps/api/src/modules/instruments/routes.ts,
// which are NOT consistent about which key carries the code (some use
// afterValue.code, some afterValue.instrument) — the fix must read both.
describe('audit-helpers — instrument/gateway rendering', () => {
  it('INSTRUMENT_CREATED reads the code from afterValue.code', () => {
    const row = { action: 'INSTRUMENT_CREATED', userId: 'EMP-004',
      afterValue: { name: 'Probe 1', code: 'PROBE-01', transport: 'HTTP' } };
    expect(getAuditSummary(row, T)).toBe('Instrument "PROBE-01" created by EMP-004');
  });

  it('INSTRUMENT_DELETED reads the code from beforeValue.code', () => {
    const row = { action: 'INSTRUMENT_DELETED', userId: 'EMP-004',
      beforeValue: { name: 'Probe 1', code: 'PROBE-01', transport: 'HTTP' } };
    expect(getAuditSummary(row, T)).toBe('Instrument "PROBE-01" deleted by EMP-004');
  });

  it('INSTRUMENT_TOKEN_REGENERATED reads the code from afterValue.code', () => {
    const row = { action: 'INSTRUMENT_TOKEN_REGENERATED', userId: 'EMP-004',
      afterValue: { code: 'PROBE-01', tokenPrefix: 'a1b2c3' } };
    expect(getAuditSummary(row, T)).toBe('Access token for instrument "PROBE-01" regenerated by EMP-004 — the previous token was revoked');
  });

  it('INSTRUMENT_GATEWAY_ENABLED reads the code from afterValue.instrument', () => {
    const row = { action: 'INSTRUMENT_GATEWAY_ENABLED', userId: 'EMP-004',
      afterValue: { instrument: 'GW-01', isGateway: true } };
    expect(getAuditSummary(row, T)).toBe('Instrument "GW-01" enabled as a gateway by EMP-004');
  });

  it('INSTRUMENT_GATEWAY_DISABLED reads the code from afterValue.instrument', () => {
    const row = { action: 'INSTRUMENT_GATEWAY_DISABLED', userId: 'EMP-004',
      beforeValue: { instrument: 'GW-01', isGateway: true }, afterValue: { instrument: 'GW-01', isGateway: false } };
    expect(getAuditSummary(row, T)).toBe('Gateway mode disabled on instrument "GW-01" by EMP-004');
  });

  it('INSTRUMENT_LINKED_TO_GATEWAY reads both {instrument} and {gateway} from afterValue', () => {
    const row = { action: 'INSTRUMENT_LINKED_TO_GATEWAY', userId: 'EMP-004',
      afterValue: { instrument: 'PROBE-01', gateway: 'GW-01', gatewayId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' } };
    expect(getAuditSummary(row, T)).toBe('Instrument "PROBE-01" linked to gateway "GW-01" by EMP-004');
  });

  it('INSTRUMENT_UNLINKED_FROM_GATEWAY falls back to beforeValue.gateway (afterValue.gateway is null on unlink)', () => {
    const row = { action: 'INSTRUMENT_UNLINKED_FROM_GATEWAY', userId: 'EMP-004',
      beforeValue: { instrument: 'PROBE-01', gateway: 'GW-01', gatewayId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
      afterValue: { instrument: 'PROBE-01', gateway: null, gatewayId: null } };
    expect(getAuditSummary(row, T)).toBe('Instrument "PROBE-01" unlinked from gateway "GW-01" by EMP-004');
  });

  it('INSTRUMENT_UPDATED reads the code from afterValue.code', () => {
    const row = { action: 'INSTRUMENT_UPDATED', userId: 'EMP-004', targetId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      beforeValue: { code: 'PROBE-01', description: 'old' },
      afterValue: { code: 'PROBE-01', description: 'new' } };
    expect(getAuditSummary(row, T)).toBe('Instrument "PROBE-01" updated by EMP-004');
  });

  // audit_trail is immutable: the gateway-wiring emitters wrote `instrument`
  // before they were converged onto `code` (2026-08-06), so those rows exist
  // forever and must keep rendering. This is the regression guard on that.
  it('still renders historic gateway rows that carry `instrument` instead of `code`', () => {
    const row = { action: 'INSTRUMENT_LINKED_TO_GATEWAY', userId: 'EMP-004',
      afterValue: { instrument: 'PROBE-01', gateway: 'GW-01' } };
    expect(getAuditSummary(row, T)).toBe('Instrument "PROBE-01" linked to gateway "GW-01" by EMP-004');
  });

  it('a historic INSTRUMENT_UPDATED with neither key falls back to the raw targetId, never the literal placeholder', () => {
    // Pre-2026-08-06 shape: the UPDATE emitter carried only
    // name/transport/isActive/expectedIntervalSec/location/area/block — no
    // code, no "instrument" key. This is a row that genuinely lacks the data;
    // per the "raw UUID over guessing" rule the fallback is targetId.
    const row = { action: 'INSTRUMENT_UPDATED', userId: 'EMP-004', targetId: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
      beforeValue: { name: 'Probe 1', transport: 'HTTP' }, afterValue: { name: 'Probe 1 Renamed', transport: 'HTTP' } };
    const s = getAuditSummary(row, T);
    expect(s).not.toContain('{instrument}');
    expect(s).toBe('Instrument "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb" updated by EMP-004');
  });

  // Attributes (2026-08-06). Same failure mode as {instrument} above: a template
  // placeholder with no substitution in audit-helpers renders literally, so the
  // trail would read 'Attribute "{attribute}" ...' for every row.
  it('INSTRUMENT_ATTRIBUTE_SET names the key, from afterValue.attribute', () => {
    const row = { action: 'INSTRUMENT_ATTRIBUTE_SET', userId: 'EMP-004',
      afterValue: { code: 'PROBE-01', attribute: 'Calibration Due', value: '2027-01-31' } };
    expect(getAuditSummary(row, T))
      .toBe('Attribute "Calibration Due" on instrument "PROBE-01" set by EMP-004');
  });

  it('INSTRUMENT_ATTRIBUTE_REMOVED reads the key from beforeValue (there is no after)', () => {
    const row = { action: 'INSTRUMENT_ATTRIBUTE_REMOVED', userId: 'EMP-004',
      beforeValue: { code: 'PROBE-01', attribute: 'Asset Tag', value: 'AT-9931' } };
    expect(getAuditSummary(row, T))
      .toBe('Attribute "Asset Tag" removed from instrument "PROBE-01" by EMP-004');
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
