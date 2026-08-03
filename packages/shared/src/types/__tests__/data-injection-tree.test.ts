import { describe, it, expect } from 'vitest';
import { PERMISSION_TREE } from '../permission-tree.js';

describe('data-injection permission group', () => {
  const group = () => PERMISSION_TREE.find(g => g.sidebarId === 'data-injection');

  it('exists with 19 nodes, still all enforce:a (routes stay enforced even where the toggle is hidden)', () => {
    const g = group();
    expect(g).toBeDefined();
    expect(g!.nodes).toHaveLength(19);
    expect(g!.nodes.every(n => n.enforce === 'a')).toBe(true);
  });

  it('8 nodes are configurable:false — no UI yet (finding I4, final branch review)', () => {
    // gateways.tsx / profiles.tsx / instruments.tsx are read-only tables;
    // only hierarchy.tsx has full CRUD and instrument-wizard.tsx has Create.
    // Granting these toggles previously produced no button anywhere.
    const NO_UI = new Set([
      'gateways.create', 'gateways.edit', 'gateways.delete',
      'instruments.edit', 'instruments.delete',
      'comm_profiles.create', 'comm_profiles.edit', 'comm_profiles.delete',
    ]);
    // The 3 P3 alarm nodes are NOT in NO_UI — alarms.tsx (Task 13) ships the
    // queue, the ack dialog and the threshold editor, so each toggle surfaces
    // a control.
    const g = group()!;
    for (const node of g.nodes) {
      expect(node.configurable, `${node.id}.configurable`).toBe(!NO_UI.has(node.id));
    }
    expect(g.nodes.filter(n => n.configurable === true)).toHaveLength(11);
    expect(g.nodes.filter(n => n.configurable === false)).toHaveLength(8);
  });

  it('acknowledge is gated on ALARM_ACKNOWLEDGE alone, not on the view grant', () => {
    // Reading a deviation is not signing it off (§11.50). If the gate ever
    // widened to include ALARM_VIEW, every viewer would see the Acknowledge
    // button — the backend would still 403, but the UI would lie.
    const ack = group()!.nodes.find(n => n.id === 'alarms.acknowledge')!;
    expect(ack.gate).toEqual(['ALARM_ACKNOWLEDGE']);
    expect(ack.permissions).toContain('ALARM_VIEW');
    expect(ack.reauthAction).toBe('ACKNOWLEDGE_ALARM');
  });

  it('gate is the single discriminating permission, never the grant set', () => {
    const create = group()!.nodes.find(n => n.id === 'instruments.create')!;
    expect(create.gate).toEqual(['INSTRUMENT_CREATE']);
    // grant set includes read dependencies — must NOT equal the gate
    expect(create.permissions).toContain('INSTRUMENT_VIEW');
    expect(create.permissions.length).toBeGreaterThan(create.gate.length);
  });

  it('alarms.view is a visibility privilege for the group (Task 13)', () => {
    // Without this the sidebar item is hidden from a role granted ONLY alarm
    // privileges, so the Alarms page — reachable from the Data Injection hub
    // and by no other route — has no nav path for exactly the operator it
    // exists to serve. Every other page-level `.view` in the group is listed.
    const g = group()!;
    expect(g.visibilityPrivilegeIds).toContain('alarms.view');
    for (const view of ['hierarchy.view', 'gateways.view', 'instruments.view', 'comm_profiles.view']) {
      expect(g.visibilityPrivilegeIds).toContain(view);
    }
  });

  it('brings the tree to 9 groups and 57 nodes', () => {
    expect(PERMISSION_TREE).toHaveLength(9);
    expect(PERMISSION_TREE.flatMap(g => g.nodes)).toHaveLength(57);
  });
});
