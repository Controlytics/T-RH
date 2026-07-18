import { describe, it, expect, vi, beforeEach } from 'vitest';
import { validateAndBuildFilterAttributes } from '../filter-fields.service.js';
import { prisma } from '../../../../lib/prisma.js';

vi.mock('../../../../lib/prisma.js', () => ({
  prisma: { systemConfig: { findUnique: vi.fn() } },
}));

const OPTS = { ahuType: ['Process', 'Non Process'], filterType: ['HEPA', 'PRE'], micronSize: ['5', '10'], filterSize: ['610×610×292mm', '24×24×12in'] };

beforeEach(() => {
  (prisma.systemConfig.findUnique as any).mockResolvedValue({ configValue: { value: OPTS } });
});

describe('validateAndBuildFilterAttributes', () => {
  it('accepts in-list values (case-insensitive) and builds attributes', async () => {
    const r = await validateAndBuildFilterAttributes({ ahuType: 'process', filterType: 'HEPA', micronSize: '5' });
    expect(r.errors).toEqual([]);
    expect(r.attributes).toEqual({ ahuType: 'Process', filterType: 'HEPA', micronSize: '5' });
  });

  it('stores filterSize as FREE TEXT (no list validation, any non-empty value accepted)', async () => {
    // Not in the OPTS.filterSize list — free text must still be accepted, no error.
    const r = await validateAndBuildFilterAttributes({ filterSize: '999×999×40mm custom' });
    expect(r.errors).toEqual([]);
    expect(r.attributes).toEqual({ filterSize: '999×999×40mm custom' });
    // Blank filterSize is simply omitted.
    const blank = await validateAndBuildFilterAttributes({ filterSize: '   ' });
    expect(blank.attributes).toEqual({});
  });

  it('keeps micronSize (list-validated) and filterSize (free text) independent', async () => {
    const r = await validateAndBuildFilterAttributes({ micronSize: '5', filterSize: '24×24×12in' });
    expect(r.errors).toEqual([]);
    expect(r.attributes).toEqual({ micronSize: '5', filterSize: '24×24×12in' });
  });

  it('rejects an out-of-list value with field/value/message', async () => {
    const r = await validateAndBuildFilterAttributes({ filterType: 'CARBON' });
    expect(r.attributes).toEqual({});
    expect(r.errors).toEqual([
      { field: 'filterType', value: 'CARBON', message: 'must be one of: HEPA, PRE' },
    ]);
  });

  it('stores lastCleaningDate NA and ISO date, rejects garbage', async () => {
    expect((await validateAndBuildFilterAttributes({ lastCleaningDate: 'NA' })).attributes).toEqual({ lastCleaningDate: 'NA' });
    expect((await validateAndBuildFilterAttributes({ lastCleaningDate: '2026-04-15' })).attributes).toEqual({ lastCleaningDate: '2026-04-15' });
    const bad = await validateAndBuildFilterAttributes({ lastCleaningDate: '15/04/2026' });
    expect(bad.errors[0]).toEqual({ field: 'lastCleaningDate', value: '15/04/2026', message: 'must be a date (YYYY-MM-DD) or NA' });
    const rollover = await validateAndBuildFilterAttributes({ lastCleaningDate: '2026-02-30' });
    expect(rollover.attributes).toEqual({});
    expect(rollover.errors[0]).toEqual({ field: 'lastCleaningDate', value: '2026-02-30', message: 'must be a date (YYYY-MM-DD) or NA' });
  });

  it('omits empty/blank optional fields without error', async () => {
    const r = await validateAndBuildFilterAttributes({ ahuType: '', filterType: undefined, micronSize: null, lastCleaningDate: '' });
    expect(r.errors).toEqual([]);
    expect(r.attributes).toEqual({});
  });
});
