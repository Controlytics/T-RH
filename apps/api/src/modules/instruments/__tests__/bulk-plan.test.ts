import { describe, it, expect } from 'vitest';
import { planBulkUpload, remarkRequired, type ExistingInstrument, type BulkPlanInput } from '../bulk-plan.js';
import { parseInstrumentCsv } from '../bulk-csv.js';

/**
 * A bulk upload naming an Instrument ID that already exists UPDATES it
 * (2026-10-28, operator: "when user doing bulk upload with already exiting
 * instrument ids and like attributes values changed and uploaded then already
 * existed error was coming, there i need like what values are changed those
 * data should update"). `planBulkUpload` is the ONE rule the preview and the
 * upload both run, so what the operator reviewed is what is written.
 */
const PROFILE = 'p-1';
const COLUMNS = [
  { key: 'Location', label: 'Location' },
  { key: 'High Temperature Limit', label: 'High Temperature Limit' },
  { key: 'Temp Off set', label: 'Temp Off set' },
];

function existing(over: Partial<ExistingInstrument> = {}): ExistingInstrument {
  return {
    id: 'i-1', code: 'CWH/RDU/001-00', profileId: PROFILE, profileName: 'T&RH Sensors', visible: true,
    attributes: [{ key: 'Location', value: 'Room A' }, { key: 'High Temperature Limit', value: '25' }],
    ...over,
  };
}

function plan(csv: string, over: Partial<BulkPlanInput> = {}, instruments: ExistingInstrument[] = [existing()]) {
  const parsed = parseInstrumentCsv(csv, COLUMNS);
  return planBulkUpload({
    rows: parsed.rows, rowNumbers: parsed.rowNumbers, codeHeading: parsed.codeHeading,
    headings: parsed.headings, identityColumns: parsed.identityColumns,
    profileId: PROFILE,
    existing: new Map(instruments.map((i) => [i.code.toLowerCase(), i])),
    isOffset: (k) => k === 'Temp Off set',
    mayUpdate: true,
    accessRefusal: () => null,
    ...over,
  });
}

describe('planBulkUpload', () => {
  it('a new Instrument ID is a create, carrying its filled attributes', () => {
    const r = plan('Instrument ID,Location\nNEW-1,Room B');
    expect(r.errors).toEqual([]);
    expect(r.plans).toEqual([{ kind: 'create', index: 0, row: 2, code: 'NEW-1', attributes: { Location: 'Room B' } }]);
  });

  it('an existing ID with a changed value is an update naming the value it replaces', () => {
    const r = plan('Instrument ID,Location,High Temperature Limit\nCWH/RDU/001-00,Room A,27');
    expect(r.errors).toEqual([]);
    expect(r.plans).toEqual([{
      kind: 'update', index: 0, row: 2, id: 'i-1', code: 'CWH/RDU/001-00',
      changes: [{ key: 'High Temperature Limit', column: 'High Temperature Limit', from: '25', to: '27' }],
    }]);
  });

  it('an existing ID whose cells all match, or are blank, is unchanged — never an error', () => {
    const r = plan('Instrument ID,Location,High Temperature Limit\nCWH/RDU/001-00,Room A,');
    expect(r.errors).toEqual([]);
    expect(r.plans).toEqual([{ kind: 'unchanged', index: 0, row: 2, id: 'i-1', code: 'CWH/RDU/001-00' }]);
  });

  it('a BLANK cell keeps the stored value — clearing is not something a file can do', () => {
    const r = plan('Instrument ID,Location,High Temperature Limit\nCWH/RDU/001-00,,27');
    expect(r.plans[0].kind).toBe('update');
    if (r.plans[0].kind !== 'update') throw new Error('unreachable');
    expect(r.plans[0].changes.map((c) => c.key)).toEqual(['High Temperature Limit']);
  });

  it('matches the ID ignoring case and keeps the stored spelling', () => {
    const r = plan('Instrument ID,Location\ncwh/rdu/001-00,Room C');
    expect(r.plans[0]).toMatchObject({ kind: 'update', id: 'i-1', code: 'CWH/RDU/001-00' });
  });

  it('writes to the STORED key when it differs only by case — never a second attribute', () => {
    const r = plan('Instrument ID,Location\nCWH/RDU/001-00,Room C', {}, [existing({ attributes: [{ key: 'location', value: 'Room A' }] })]);
    if (r.plans[0].kind !== 'update') throw new Error(`expected an update, got ${r.plans[0].kind}`);
    expect(r.plans[0].changes).toEqual([{ key: 'location', column: 'Location', from: 'Room A', to: 'Room C' }]);
  });

  it('prefers the EXACT key when the instrument carries both spellings', () => {
    const r = plan('Instrument ID,Location\nCWH/RDU/001-00,Room C', {}, [existing({
      attributes: [{ key: 'LOCATION', value: 'x' }, { key: 'Location', value: 'Room A' }],
    })]);
    if (r.plans[0].kind !== 'update') throw new Error('expected an update');
    expect(r.plans[0].changes[0]).toMatchObject({ key: 'Location', from: 'Room A' });
  });

  it('a key the instrument does not carry yet is a first fill: from is null', () => {
    const r = plan('Instrument ID,Location\nCWH/RDU/001-00,Room A', {}, [existing({ attributes: [] })]);
    if (r.plans[0].kind !== 'update') throw new Error('expected an update');
    expect(r.plans[0].changes).toEqual([{ key: 'Location', column: 'Location', from: null, to: 'Room A' }]);
  });

  it('whitespace around a stored value is not a change', () => {
    const r = plan('Instrument ID,Location\nCWH/RDU/001-00,Room A', {}, [existing({ attributes: [{ key: 'Location', value: ' Room A ' }] })]);
    expect(r.plans[0].kind).toBe('unchanged');
  });

  it('an offset is compared signed: "2" against a stored "+2" is unchanged, "-1" is a change', () => {
    const stored = [existing({ attributes: [{ key: 'Temp Off set', value: '+2' }] })];
    expect(plan('Instrument ID,Temp Off set\nCWH/RDU/001-00,2', {}, stored).plans[0].kind).toBe('unchanged');
    const r = plan('Instrument ID,Temp Off set\nCWH/RDU/001-00,-1', {}, stored);
    if (r.plans[0].kind !== 'update') throw new Error('expected an update');
    expect(r.plans[0].changes[0]).toMatchObject({ from: '+2', to: '-1' });
  });

  it('a bad offset fails its row, on its cell, for a create AND for an update', () => {
    const r = plan('Instrument ID,Temp Off set\nCWH/RDU/001-00,abc\nNEW-2,abc');
    expect(r.plans).toEqual([]);
    expect(r.errors.map((e) => [e.row, e.column])).toEqual([[2, 'Temp Off set'], [3, 'Temp Off set']]);
  });

  it('a create formats its offset with the sign written', () => {
    const r = plan('Instrument ID,Temp Off set\nNEW-3,2');
    expect(r.plans[0]).toMatchObject({ kind: 'create', attributes: { 'Temp Off set': '+2' } });
  });

  it('an ID outside the caller\'s view is the old "already exists" error and reveals nothing', () => {
    const r = plan('Instrument ID,Location\nCWH/RDU/001-00,Room C', {}, [existing({ visible: false })]);
    expect(r.plans).toEqual([]);
    expect(r.errors).toEqual([{ row: 2, column: 'Instrument ID', message: 'Instrument ID "CWH/RDU/001-00" already exists' }]);
  });

  it('an ID in ANOTHER profile is refused on its row — the upload never moves an instrument', () => {
    const r = plan('Instrument ID,Location\nCWH/RDU/001-00,Room C', {}, [existing({ profileId: 'p-2', profileName: 'Gateways' })]);
    expect(r.plans).toEqual([]);
    expect(r.errors[0]).toMatchObject({ row: 2, column: 'Instrument ID' });
    expect(r.errors[0].message).toMatch(/profile "Gateways"/);
  });

  it('a role without Instrument Update cannot change one — but an unchanged row is no error', () => {
    const r = plan('Instrument ID,Location\nCWH/RDU/001-00,Room C', { mayUpdate: false });
    expect(r.plans).toEqual([]);
    expect(r.errors[0].message).toMatch(/may not change/);
    expect(plan('Instrument ID,Location\nCWH/RDU/001-00,Room A', { mayUpdate: false }).plans[0].kind).toBe('unchanged');
  });

  it('a refused cell fails the WHOLE row, named by its heading; isNewKey follows the stored row', () => {
    const asked: [string, boolean][] = [];
    const r = plan('Instrument ID,Location,High Temperature Limit\nCWH/RDU/001-00,Room C,27', {
      accessRefusal: (key, isNewKey) => { asked.push([key, isNewKey]); return key === 'High Temperature Limit' ? 'You may view "High Temperature Limit" but not change it.' : null; },
    });
    expect(r.plans).toEqual([]);
    expect(r.errors).toEqual([{ row: 2, column: 'High Temperature Limit', message: 'You may view "High Temperature Limit" but not change it.' }]);
    expect(asked).toEqual([['Location', false], ['High Temperature Limit', false]]);
  });

  it('warns once that identity columns do not change an existing instrument', () => {
    const r = plan('name,code,model,Location\nX,CWH/RDU/001-00,M1,Room C\nY,NEW-4,M2,');
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/"name", "model"/);
    // A file that only creates says nothing about it.
    expect(plan('name,code,model\nY,NEW-5,M2').warnings).toEqual([]);
  });

  it('keeps the source order across creates, updates and unchanged rows', () => {
    const r = plan('Instrument ID,Location\nNEW-6,x\nCWH/RDU/001-00,Room A\nNEW-7,y');
    expect(r.plans.map((p) => [p.kind, p.row, p.index])).toEqual([['create', 2, 0], ['unchanged', 3, 1], ['create', 4, 2]]);
  });
});

describe('remarkRequired', () => {
  it('is true only when a change OVERWRITES a recorded value — a first fill asks for none', () => {
    const fill = plan('Instrument ID,Location\nCWH/RDU/001-00,Room A', {}, [existing({ attributes: [] })]);
    expect(remarkRequired(fill.plans)).toBe(false);
    expect(remarkRequired(plan('Instrument ID,Location\nCWH/RDU/001-00,Room C').plans)).toBe(true);
    expect(remarkRequired(plan('Instrument ID,Location\nNEW-8,x').plans)).toBe(false);
  });

  it('an empty stored value is still a recorded one — the single attribute routes ask for a remark there too', () => {
    const r = plan('Instrument ID,Location\nCWH/RDU/001-00,Room A', {}, [existing({ attributes: [{ key: 'Location', value: '' }] })]);
    expect(remarkRequired(r.plans)).toBe(true);
  });
});
