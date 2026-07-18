import { describe, it, expect } from 'vitest';
import { buildAhuBlockMap, filtersInBlock } from '../ahu-block-map';

describe('buildAhuBlockMap', () => {
  it('maps an AHU directly under a block', () => {
    const map = buildAhuBlockMap([{ id: 'ahu1', blockId: 'blkA', areaId: null }], []);
    expect(map).toEqual({ ahu1: 'blkA' });
  });

  it('resolves an area-nested AHU through its area block', () => {
    const map = buildAhuBlockMap(
      [{ id: 'ahu2', blockId: null, areaId: 'areaX' }],
      [{ id: 'areaX', blockId: 'blkB' }],
    );
    expect(map).toEqual({ ahu2: 'blkB' });
  });

  it('prefers a direct blockId over the area path', () => {
    const map = buildAhuBlockMap(
      [{ id: 'ahu3', blockId: 'blkDirect', areaId: 'areaY' }],
      [{ id: 'areaY', blockId: 'blkViaArea' }],
    );
    expect(map.ahu3).toBe('blkDirect');
  });

  it('omits AHUs whose block cannot be resolved', () => {
    const map = buildAhuBlockMap([{ id: 'ahu4', blockId: null, areaId: 'missing' }], []);
    expect(map).toEqual({});
  });
});

describe('filtersInBlock', () => {
  const rows = [
    { id: 'f1', ahuId: 'ahu1' },
    { id: 'f2', ahuId: 'ahu2' },
    { id: 'f3', ahuId: 'ahu1' },
    { id: 'f4', ahuId: null },
  ];
  const map = { ahu1: 'blkA', ahu2: 'blkB' };

  it('keeps only rows whose AHU maps to the block', () => {
    expect(filtersInBlock(rows, 'blkA', map).map((r) => r.id)).toEqual(['f1', 'f3']);
  });

  it('safe-degrades to all rows when the map is empty (offline/loading, block selected)', () => {
    expect(filtersInBlock(rows, 'blkA', {})).toEqual(rows);
  });

  it('returns none when no block is selected (do not show all)', () => {
    expect(filtersInBlock(rows, null, map)).toEqual([]);
    expect(filtersInBlock(rows, undefined, map)).toEqual([]);
  });
});
