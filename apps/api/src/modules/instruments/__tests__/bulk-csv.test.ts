import { describe, it, expect } from 'vitest';
import { parseInstrumentCsv } from '../bulk-csv.js';

const HEADER = 'name,code';

describe('parseInstrumentCsv', () => {
  it('parses valid rows', () => {
    const r = parseInstrumentCsv(`${HEADER}\nProbe A,PA-1\nProbe B,PB-1`);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { name: 'Probe A', code: 'PA-1' },
      { name: 'Probe B', code: 'PB-1' },
    ]);
  });

  it('reports bad rows by line number but keeps the good ones (partial success)', () => {
    const r = parseInstrumentCsv(`${HEADER}\nGood,G-1\n,MISSING-NAME\nBad,G-1`);
    expect(r.rows).toEqual([{ name: 'Good', code: 'G-1' }]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatchObject({ row: 3 });
    expect(r.errors[1]).toMatchObject({ row: 4 });
    expect(r.errors[1].message).toMatch(/duplicate/i);
  });

  it('returns a rowNumbers sidecar aligned to rows, skipping blanks and bad rows', () => {
    // Only the sidecar can attribute a LATER failure (a code that already
    // exists in the database) back to the operator's spreadsheet row.
    const r = parseInstrumentCsv(`${HEADER}\nGood,G-1\n\n,MISSING-NAME\nAlso Good,G-2`);
    expect(r.rows.map((x) => x.code)).toEqual(['G-1', 'G-2']);
    expect(r.rowNumbers).toEqual([2, 5]);
    expect(r.rowNumbers).toHaveLength(r.rows.length);
  });

  it('refuses a code that cannot be an MQTT client id, as an error row, and keeps the rest', () => {
    // Same rule as the create form (`instrumentCodeTopicViolation`); a slash is
    // fine, a wildcard is not. Refused here so it is an error ROW, not an
    // exception out of createWithCredential that fails the whole upload.
    const r = parseInstrumentCsv(`${HEADER}\nBad,CWH/+/001\nGood,CWH/RDU/001-00`);
    expect(r.rows).toEqual([{ name: 'Good', code: 'CWH/RDU/001-00' }]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].row).toBe(2);
    expect(r.errors[0].message).toMatch(/\+/);
  });

  it('rejects duplicate codes within the same file', () => {
    const r = parseInstrumentCsv(`${HEADER}\nA,DUP,http\nB,DUP,http`);
    expect(r.rows).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/duplicate/i);
  });

  it('rejects a missing or misspelled header', () => {
    expect(parseInstrumentCsv('nombre,code\nA,B').errors[0].message).toMatch(/header/i);
    expect(parseInstrumentCsv('').errors[0].message).toMatch(/header/i);
  });

  it('tolerates CRLF, blank lines and surrounding whitespace', () => {
    const r = parseInstrumentCsv(`${HEADER}\r\n Probe A , PA-1 \r\n\r\n`);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{ name: 'Probe A', code: 'PA-1' }]);
  });

  it('keeps optional columns when present', () => {
    const r = parseInstrumentCsv('name,code,manufacturer\nA,A-1,Vaisala');
    expect(r.rows[0]).toMatchObject({ manufacturer: 'Vaisala' });
  });

  it('handles blank lines in the middle and reports correct row numbers', () => {
    const r = parseInstrumentCsv(`${HEADER}\nGood,G-1\n\nBad,G-1`);
    expect(r.rows).toEqual([{ name: 'Good', code: 'G-1' }]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ row: 4 }); // The bad row is on line 4 in the source
  });

  it('unquotes fields wrapped in double quotes', () => {
    const r = parseInstrumentCsv(`${HEADER}\n"Probe A",PA-1`);
    expect(r.rows[0]).toMatchObject({ name: 'Probe A' });
    expect(r.errors).toEqual([]);
  });

  it('handles commas inside quoted fields', () => {
    const r = parseInstrumentCsv(`${HEADER}\n"Probe, north wing",PN-1`);
    expect(r.rows[0]).toMatchObject({ name: 'Probe, north wing' });
    expect(r.errors).toEqual([]);
  });

  it('handles escaped quotes inside quoted fields', () => {
    const r = parseInstrumentCsv(`${HEADER}\n"Probe ""alpha"" model",PA-1`);
    expect(r.rows[0]).toMatchObject({ name: 'Probe "alpha" model' });
    expect(r.errors).toEqual([]);
  });

  // The `transport` column was REQUIRED until 2026-08-06. Every spreadsheet an
  // operator has saved still carries it, so it must keep importing — but doing
  // so silently would let a typo'd value look meaningful forever. Hence: rows
  // land, and ONE whole-file warning is raised.
  describe('legacy `transport` column', () => {
    it('still imports, ignoring the column rather than failing the row', () => {
      const r = parseInstrumentCsv('name,code,transport\nProbe A,PA-1,http\nProbe B,PB-1,carrier-pigeon');
      expect(r.errors).toEqual([]);
      expect(r.rows).toEqual([
        { name: 'Probe A', code: 'PA-1' },
        { name: 'Probe B', code: 'PB-1' },
      ]);
      // Even a value that used to be a hard error no longer reaches the draft.
      expect(r.rows[1]).not.toHaveProperty('transport');
    });

    it('warns exactly once per import, not once per row', () => {
      const r = parseInstrumentCsv('name,code,transport\nA,A-1,http\nB,B-1,http\nC,C-1,http');
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/transport/i);
      expect(r.errors).toEqual([]);
    });

    it('raises the warning even when every row then fails', () => {
      const r = parseInstrumentCsv('name,code,transport\n,,http');
      expect(r.warnings).toHaveLength(1);
      expect(r.errors).toHaveLength(1);
    });

    it('says nothing when the column is absent', () => {
      expect(parseInstrumentCsv(`${HEADER}\nA,A-1`).warnings).toEqual([]);
    });
  });

  it('reports row error for unterminated quoted field', () => {
    const r = parseInstrumentCsv(`${HEADER}\n"Probe A,PA-1`);
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/unterminated|quote/i);
  });
});
