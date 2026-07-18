import { describe, it, expect } from 'vitest';
import { resolveStartEquipmentGroupPin } from '../start-cycle.js';

// #eqpin (2026-07-04): the equipment-group version pin must be captured at cycle
// START, so an admin edit to instrument operating-ranges mid-cycle can't change
// the out-of-range determination for an in-flight cycle. These are the rules for
// what gets bound + pinned at start.
describe('resolveStartEquipmentGroupPin', () => {
  it('explicit group → binds + pins its current version', () => {
    expect(resolveStartEquipmentGroupPin({ id: 'g1', version: 4 }, [])).toEqual({
      equipmentGroupId: 'g1',
      equipmentGroupVersionPin: 4,
    });
  });

  it('THE FIX: no explicit group + block has exactly ONE active group → binds + pins it at start', () => {
    // Previously this stayed { null, null } and lazy-bound to the LIVE version at
    // the first readings advance — drifting if the group was edited in between.
    expect(resolveStartEquipmentGroupPin(null, [{ id: 'gA', version: 1 }])).toEqual({
      equipmentGroupId: 'gA',
      equipmentGroupVersionPin: 1,
    });
  });

  it('no explicit group + block has NO active groups → unbound (no readings expected)', () => {
    expect(resolveStartEquipmentGroupPin(null, [])).toEqual({
      equipmentGroupId: null,
      equipmentGroupVersionPin: null,
    });
  });

  it('no explicit group + block has >1 active groups → unbound (ambiguous; advance() errors on readings)', () => {
    expect(resolveStartEquipmentGroupPin(null, [
      { id: 'gA', version: 1 },
      { id: 'gB', version: 2 },
    ])).toEqual({ equipmentGroupId: null, equipmentGroupVersionPin: null });
  });

  it('explicit group takes precedence even if the block also has groups', () => {
    expect(resolveStartEquipmentGroupPin({ id: 'g1', version: 7 }, [{ id: 'gA', version: 1 }])).toEqual({
      equipmentGroupId: 'g1',
      equipmentGroupVersionPin: 7,
    });
  });
});
