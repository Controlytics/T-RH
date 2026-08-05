import { describe, it, expect } from 'vitest';
import { parseInstrumentCsv } from '../bulk-csv.js';

const HEADER = 'name,code,transport';

describe('parseInstrumentCsv', () => {
  it('parses valid rows', () => {
    const r = parseInstrumentCsv(`${HEADER}\nProbe A,PA-1,http\nProbe B,PB-1,mqtt`);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([
      { name: 'Probe A', code: 'PA-1', transport: 'http' },
      { name: 'Probe B', code: 'PB-1', transport: 'mqtt' },
    ]);
  });

  it('reports bad rows by line number but keeps the good ones (partial success)', () => {
    const r = parseInstrumentCsv(`${HEADER}\nGood,G-1,http\n,MISSING-NAME,http\nBad,B-1,carrier-pigeon`);
    expect(r.rows).toEqual([{ name: 'Good', code: 'G-1', transport: 'http' }]);
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toMatchObject({ row: 3 });
    expect(r.errors[1]).toMatchObject({ row: 4 });
    expect(r.errors[1].message).toMatch(/transport/i);
  });

  it('rejects duplicate codes within the same file', () => {
    const r = parseInstrumentCsv(`${HEADER}\nA,DUP,http\nB,DUP,http`);
    expect(r.rows).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/duplicate/i);
  });

  it('rejects a missing or misspelled header', () => {
    expect(parseInstrumentCsv('nombre,code,transport\nA,B,http').errors[0].message).toMatch(/header/i);
    expect(parseInstrumentCsv('').errors[0].message).toMatch(/header/i);
  });

  it('tolerates CRLF, blank lines and surrounding whitespace', () => {
    const r = parseInstrumentCsv(`${HEADER}\r\n Probe A , PA-1 , http \r\n\r\n`);
    expect(r.errors).toEqual([]);
    expect(r.rows).toEqual([{ name: 'Probe A', code: 'PA-1', transport: 'http' }]);
  });

  it('keeps optional columns when present', () => {
    const r = parseInstrumentCsv('name,code,transport,manufacturer\nA,A-1,http,Vaisala');
    expect(r.rows[0]).toMatchObject({ manufacturer: 'Vaisala' });
  });

  it('handles blank lines in the middle and reports correct row numbers', () => {
    const r = parseInstrumentCsv(`${HEADER}\nGood,G-1,http\n\nBad,B-1,carrier-pigeon`);
    expect(r.rows).toEqual([{ name: 'Good', code: 'G-1', transport: 'http' }]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toMatchObject({ row: 4 }); // The bad row is on line 4 in the source
  });

  it('unquotes fields wrapped in double quotes', () => {
    const r = parseInstrumentCsv(`${HEADER}\n"Probe A",PA-1,http`);
    expect(r.rows[0]).toMatchObject({ name: 'Probe A' });
    expect(r.errors).toEqual([]);
  });

  it('handles commas inside quoted fields', () => {
    const r = parseInstrumentCsv(`${HEADER}\n"Probe, north wing",PN-1,http`);
    expect(r.rows[0]).toMatchObject({ name: 'Probe, north wing' });
    expect(r.errors).toEqual([]);
  });

  it('handles escaped quotes inside quoted fields', () => {
    const r = parseInstrumentCsv(`${HEADER}\n"Probe ""alpha"" model",PA-1,http`);
    expect(r.rows[0]).toMatchObject({ name: 'Probe "alpha" model' });
    expect(r.errors).toEqual([]);
  });

  it('reports row error for unterminated quoted field', () => {
    const r = parseInstrumentCsv(`${HEADER}\n"Probe A,PA-1,http`);
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0].message).toMatch(/unterminated|quote/i);
  });
});
