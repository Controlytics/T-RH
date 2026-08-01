import { describe, it, expect } from 'vitest';
import { PERMISSION_TREE } from '../permission-tree.js';

describe('data-injection permission group', () => {
  const group = () => PERMISSION_TREE.find(g => g.sidebarId === 'data-injection');

  it('exists with 16 nodes, all configurable and all enforce:a', () => {
    const g = group();
    expect(g).toBeDefined();
    expect(g!.nodes).toHaveLength(16);
    expect(g!.nodes.every(n => n.configurable === true)).toBe(true);
    expect(g!.nodes.every(n => n.enforce === 'a')).toBe(true);
  });

  it('gate is the single discriminating permission, never the grant set', () => {
    const create = group()!.nodes.find(n => n.id === 'instruments.create')!;
    expect(create.gate).toEqual(['INSTRUMENT_CREATE']);
    // grant set includes read dependencies — must NOT equal the gate
    expect(create.permissions).toContain('INSTRUMENT_VIEW');
    expect(create.permissions.length).toBeGreaterThan(create.gate.length);
  });

  it('brings the tree to 9 groups and 54 nodes', () => {
    expect(PERMISSION_TREE).toHaveLength(9);
    expect(PERMISSION_TREE.flatMap(g => g.nodes)).toHaveLength(54);
  });
});
