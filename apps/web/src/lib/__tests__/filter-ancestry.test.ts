import { describe, expect, test } from 'vitest';
import { resolveAncestry, type AncestryInstance } from '../filter-ancestry';

/**
 * Kinds come from the asset TEMPLATE, not the instance: /api/assets/instances
 * carries templateId but not templateKind. Tests mirror that by resolving kind
 * through a lookup rather than reading it off the row.
 */
const kinds: Record<string, string> = {
  'tpl-block': 'BLOCK',
  'tpl-area': 'AREA',
  'tpl-ahu': 'AHU',
  'tpl-filter': 'FILTER',
  'tpl-other': 'OTHER',
};
const kindOf = (i: AncestryInstance) => kinds[i.templateId ?? ''] ?? null;

const inst = (id: string, templateId: string, parentId: string | null = null): AncestryInstance => ({
  id,
  templateId,
  parentId,
});

const indexOf = (...rows: AncestryInstance[]) => new Map(rows.map((r) => [r.id, r]));

describe('resolveAncestry', () => {
  test('resolves the normal Block > Area > AHU > Filter chain', () => {
    const block = inst('b1', 'tpl-block');
    const area = inst('ar1', 'tpl-area', 'b1');
    const ahu = inst('ahu1', 'tpl-ahu', 'ar1');
    const filter = inst('f1', 'tpl-filter', 'ahu1');

    expect(resolveAncestry(filter, indexOf(block, area, ahu, filter), kindOf)).toEqual({
      ahuId: 'ahu1',
      areaId: 'ar1',
      blockId: 'b1',
    });
  });

  test('resolves a Block > AHU > Filter chain that skips the Area', () => {
    // The live TEST-MIRROR-BLOCK/AHU26 and MUPS/RCB shape (28 filters).
    // Positional walking mislabelled the BLOCK as the area and reported
    // blockId: null, so the filters vanished when a block was selected.
    const block = inst('b1', 'tpl-block');
    const ahu = inst('ahu1', 'tpl-ahu', 'b1');
    const filter = inst('f1', 'tpl-filter', 'ahu1');

    expect(resolveAncestry(filter, indexOf(block, ahu, filter), kindOf)).toEqual({
      ahuId: 'ahu1',
      areaId: null,
      blockId: 'b1',
    });
  });

  test('resolves an Area > AHU > Filter chain with no block above it', () => {
    const area = inst('ar1', 'tpl-area');
    const ahu = inst('ahu1', 'tpl-ahu', 'ar1');
    const filter = inst('f1', 'tpl-filter', 'ahu1');

    expect(resolveAncestry(filter, indexOf(area, ahu, filter), kindOf)).toEqual({
      ahuId: 'ahu1',
      areaId: 'ar1',
      blockId: null,
    });
  });

  test('returns all-null for a parentless filter rather than throwing', () => {
    const filter = inst('f1', 'tpl-filter', null);

    expect(resolveAncestry(filter, indexOf(filter), kindOf)).toEqual({
      ahuId: null,
      areaId: null,
      blockId: null,
    });
  });

  test('returns all-null when the parent id points at a missing row', () => {
    const filter = inst('f1', 'tpl-filter', 'ghost');

    expect(resolveAncestry(filter, indexOf(filter), kindOf)).toEqual({
      ahuId: null,
      areaId: null,
      blockId: null,
    });
  });

  test('walks past an ancestor of an unrecognised kind', () => {
    const block = inst('b1', 'tpl-block');
    const other = inst('o1', 'tpl-other', 'b1');
    const ahu = inst('ahu1', 'tpl-ahu', 'o1');
    const filter = inst('f1', 'tpl-filter', 'ahu1');

    expect(resolveAncestry(filter, indexOf(block, other, ahu, filter), kindOf)).toEqual({
      ahuId: 'ahu1',
      areaId: null,
      blockId: 'b1',
    });
  });

  test('keeps the NEAREST ancestor of each kind when a kind repeats', () => {
    const outerArea = inst('ar-outer', 'tpl-area');
    const innerArea = inst('ar-inner', 'tpl-area', 'ar-outer');
    const ahu = inst('ahu1', 'tpl-ahu', 'ar-inner');
    const filter = inst('f1', 'tpl-filter', 'ahu1');

    expect(resolveAncestry(filter, indexOf(outerArea, innerArea, ahu, filter), kindOf).areaId).toBe(
      'ar-inner',
    );
  });

  test('terminates on a parent cycle instead of hanging', () => {
    // Defensive: a cycle in the data must not spin the tablet's render loop.
    const a = inst('a', 'tpl-area', 'b');
    const b = inst('b', 'tpl-area', 'a');
    const ahu = inst('ahu1', 'tpl-ahu', 'a');
    const filter = inst('f1', 'tpl-filter', 'ahu1');

    const result = resolveAncestry(filter, indexOf(a, b, ahu, filter), kindOf);

    expect(result.ahuId).toBe('ahu1');
    expect(result.blockId).toBeNull();
  });

  test('ignores a FILTER ancestor rather than treating it as a container', () => {
    const block = inst('b1', 'tpl-block');
    const ahu = inst('ahu1', 'tpl-ahu', 'b1');
    const parentFilter = inst('f-parent', 'tpl-filter', 'ahu1');
    const filter = inst('f1', 'tpl-filter', 'f-parent');

    const result = resolveAncestry(filter, indexOf(block, ahu, parentFilter, filter), kindOf);

    expect(result).toEqual({ ahuId: 'ahu1', areaId: null, blockId: 'b1' });
  });
});
