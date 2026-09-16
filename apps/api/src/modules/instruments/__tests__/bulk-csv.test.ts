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
    const r = parseInstrumentCsv(`${HEADER}\nGood,G-1\nMissing code,\nBad,G-1`);
    expect(r.rows).toEqual([{ name: 'Good', code: 'G-1' }]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatchObject({ row: 3 });
    expect(r.errors[1]).toMatchObject({ row: 4 });
    expect(r.errors[1].message).toMatch(/repeated/i);
  });

  /**
   * 2026-09-16, operator: "if upload failed then show a popup where it
   * failed and reason, in which line which cell like that". Every row error
   * that is ABOUT a cell names its column — as the heading appears in the
   * operator's own file, so they can find it in their spreadsheet — and the
   * wording says Instrument ID, not `code`.
   */
  describe('errors name the cell', () => {
    it('a blank or repeated Instrument ID names the column as the file spells it', () => {
      const r = parseInstrumentCsv('Instrument ID,Building\nPA-1,x\n,y\nPA-1,z');
      expect(r.errors).toEqual([
        { row: 3, column: 'Instrument ID', message: 'Instrument ID is required' },
        { row: 4, column: 'Instrument ID', message: 'Instrument ID "PA-1" is repeated in this file' },
      ]);
      // A legacy file headed `code` is told about `code`. (A wholly blank line
      // is skipped, so the blank cell sits beside a filled one.)
      const legacy = parseInstrumentCsv('code,Building\n,x\nPA-1,y');
      expect(legacy.errors[0]).toEqual({ row: 2, column: 'code', message: 'Instrument ID is required' });
    });

    it('a missing Instrument ID heading names row 1 and the column it expected', () => {
      const r = parseInstrumentCsv('Building\nCWH');
      expect(r.errors).toEqual([{ row: 1, column: 'Instrument ID', message: 'Missing header column(s): Instrument ID' }]);
    });

    it('an unterminated quote is a ROW fault and names no cell', () => {
      const r = parseInstrumentCsv(`${HEADER}\n"Probe A,PA-1`);
      expect(r.errors[0].column).toBeUndefined();
    });
  });

  it('returns a rowNumbers sidecar aligned to rows, skipping blanks and bad rows', () => {
    // Only the sidecar can attribute a LATER failure (a code that already
    // exists in the database) back to the operator's spreadsheet row.
    const r = parseInstrumentCsv(`${HEADER}\nGood,G-1\n\nMissing code,\nAlso Good,G-2`);
    expect(r.rows.map((x) => x.code)).toEqual(['G-1', 'G-2']);
    expect(r.rowNumbers).toEqual([2, 5]);
    expect(r.rowNumbers).toHaveLength(r.rows.length);
  });

  it('accepts any code text — the MQTT wildcard guard was removed on 2026-09-16 (operator)', () => {
    // A `+` code cannot publish on MQTT (the broker refuses a wildcard in a
    // publish topic); the operator chose to accept it anyway, with that
    // consequence stated. The importer therefore keeps the row.
    const r = parseInstrumentCsv(`${HEADER}\nWild,CWH/+/001\nGood,CWH/RDU/001-00`);
    expect(r.errors).toEqual([]);
    expect(r.rows.map((x) => x.code)).toEqual(['CWH/+/001', 'CWH/RDU/001-00']);
  });

  it('rejects duplicate codes within the same file', () => {
    const r = parseInstrumentCsv(`${HEADER}\nA,DUP,http\nB,DUP,http`);
    expect(r.rows).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/repeated/i);
  });

  it('rejects a missing or misspelled code header', () => {
    expect(parseInstrumentCsv('name,kode\nA,B').errors[0].message).toMatch(/header/i);
    expect(parseInstrumentCsv('').errors[0].message).toMatch(/header/i);
  });

  // 2026-09-16: the template lost its `name` column — the create form has set
  // name = code since the 2026-08-07 trim, and bulk requiring one was a leftover.
  // An absent or blank name is the code; a name given is kept.
  // The template is headed "Instrument ID" (2026-09-16, operator: "in bulk
  // option in template Instrument ID field") — the same words the create form
  // uses. `code` is still accepted for files operators already have.
  it('reads "Instrument ID" as the code column, case-insensitively, and still accepts "code"', () => {
    expect(parseInstrumentCsv('Instrument ID\nCWH/RDU/002-00').rows).toEqual([{ name: 'CWH/RDU/002-00', code: 'CWH/RDU/002-00' }]);
    expect(parseInstrumentCsv('instrument id,Building\nPA-1,CWH', [{ key: 'Building', label: 'Building' }]).rows[0])
      .toEqual({ name: 'PA-1', code: 'PA-1', attributes: { Building: 'CWH' } });
    expect(parseInstrumentCsv('code\nPA-1').rows).toEqual([{ name: 'PA-1', code: 'PA-1' }]);
    expect(parseInstrumentCsv('Building\nCWH').errors[0].message).toMatch(/Instrument ID/);
  });

  it('defaults the name to the code when the column is absent or the cell is blank', () => {
    expect(parseInstrumentCsv('code\nCWH/RDU/002-00').rows).toEqual([{ name: 'CWH/RDU/002-00', code: 'CWH/RDU/002-00' }]);
    expect(parseInstrumentCsv('name,code\n,PA-1\nProbe,PB-1').rows).toEqual([
      { name: 'PA-1', code: 'PA-1' }, { name: 'Probe', code: 'PB-1' },
    ]);
  });

  /**
   * Attribute columns (2026-09-16, operator: "in bulk upload template only
   * attributes display names should come"). The template is headed by each
   * key's administered DISPLAY NAME; the parser maps a header back to the KEY
   * — by display name or by the key itself, case-insensitively — and the key is
   * what gets stored. A header that is neither is ignored with ONE warning, so a
   * typo in a heading cannot silently create an attribute nobody asked for.
   */
  describe('attribute columns', () => {
    const columns = [
      { key: 'Enable_Temp_NMT', label: 'High temperature alarm enabled' },
      { key: 'Building', label: 'Building' },
      { key: 'Room', label: 'Cleanroom number' },
    ];

    it('maps a display-name header to its KEY and keeps the cell as an attribute', () => {
      const r = parseInstrumentCsv('code,High temperature alarm enabled,Building\nPA-1,1,CWH Block', columns);
      expect(r.errors).toEqual([]);
      expect(r.rows[0].attributes).toEqual({ Enable_Temp_NMT: '1', Building: 'CWH Block' });
    });

    it('accepts the raw key as a header too, case-insensitively', () => {
      const r = parseInstrumentCsv('code,enable_temp_nmt,cleanroom NUMBER\nPA-1,0,101', columns);
      expect(r.rows[0].attributes).toEqual({ Enable_Temp_NMT: '0', Room: '101' });
    });

    it('leaves a blank cell out rather than storing an empty attribute', () => {
      const r = parseInstrumentCsv('code,Building,Cleanroom number\nPA-1,,101', columns);
      expect(r.rows[0].attributes).toEqual({ Room: '101' });
    });

    it('carries no attributes key at all for a row with nothing filled', () => {
      const r = parseInstrumentCsv('code,Building\nPA-1,', columns);
      expect(r.rows[0]).toEqual({ name: 'PA-1', code: 'PA-1' });
    });

    it('warns ONCE about a header that is neither a standard column nor an attribute, and ignores it', () => {
      const r = parseInstrumentCsv('code,Buidling,Colour\nPA-1,x,y\nPB-1,x,y', columns);
      expect(r.errors).toEqual([]);
      expect(r.rows.map((x) => x.attributes)).toEqual([undefined, undefined]);
      expect(r.warnings).toHaveLength(1);
      expect(r.warnings[0]).toMatch(/Buidling/);
      expect(r.warnings[0]).toMatch(/Colour/);
    });

    it('does not read attribute columns when none are declared', () => {
      const r = parseInstrumentCsv('code,Building\nPA-1,CWH Block');
      expect(r.rows[0]).toEqual({ name: 'PA-1', code: 'PA-1' });
      expect(r.warnings).toHaveLength(1);
    });
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
