import { describe, it, expect } from 'vitest';
import type { Node } from '@xyflow/react';
import type { RuleChainDocument } from '@digilog/shared';
import { buildFlowEdges, buildFlowNodes, inputPosition, removalOf, type RuleFlowNode } from '../flow-mapping';
import {
  INPUT_NODE_ID, RULE_GROUP_COLORS, RULE_GROUP_INK, RULE_INPUT_COLOR, RULE_UNSUPPORTED_COLOR, contrastRatio,
} from '../types';

/**
 * How a chain document is drawn (rule chains, 2026-11-04): the Input, one
 * card per node, ONE edge per (from, to) pair carrying every relation of the
 * pair, and what React Flow measured kept across a redraw.
 */

const S = '11111111-1111-4111-8111-111111111111';
const T = '22222222-2222-4222-8222-222222222222';
const U = '33333333-3333-4333-8333-333333333333';
const DOC: RuleChainDocument = {
  version: 1,
  firstNodeId: S,
  nodes: [
    { id: S, type: 'tb:filter:message-type-switch', name: 'Switch', debugMode: 'off', config: {}, x: 500, y: 300 },
    { id: T, type: 'tb:action:save-timeseries', name: 'Save', debugMode: 'all', config: {}, x: 900, y: 250 },
    { id: U, type: 'tb:unsupported', name: 'SQS', debugMode: 'off', config: { tbClass: 'org.thingsboard.rule.engine.aws.sqs.TbSqsNode', configuration: {} }, x: 900, y: 450 },
  ],
  connections: [
    { from: S, to: T, relation: 'Post telemetry' },
    { from: S, to: T, relation: 'Post attributes' },
    { from: T, to: U, relation: 'Failure' },
  ],
};

describe('nodes', () => {
  it('the Input comes first, left of the first node, and is neither deletable nor draggable', () => {
    const [input, ...rest] = buildFlowNodes(DOC, [], { canEdit: true });
    expect(input).toMatchObject({ id: INPUT_NODE_ID, type: 'chainInput', position: { x: 240, y: 300 }, deletable: false, draggable: false });
    expect(rest.map((n) => n.id)).toEqual([S, T, U]);
    expect(inputPosition({ ...DOC, firstNodeId: null })).toEqual({ x: 240, y: 300 });
  });

  it('an Unsupported node is not supported and names its ThingsBoard class', () => {
    const nodes = buildFlowNodes(DOC, [], { canEdit: true }) as RuleFlowNode[];
    const u = nodes.find((n) => n.id === U)!;
    expect(u.data.supported).toBe(false);
    expect(u.data.tbClass).toBe('org.thingsboard.rule.engine.aws.sqs.TbSqsNode');
    const s = nodes.find((n) => n.id === S)!;
    expect(s.data.supported).toBe(true);
    expect(s.data.tbClass).toBe('org.thingsboard.rule.engine.filter.TbMsgTypeSwitchNode');
  });

  it('keeps what React Flow measured and selected when the document is redrawn', () => {
    const first = buildFlowNodes(DOC, [], { canEdit: true });
    const measured: Node[] = first.map((n) => (n.id === T ? { ...n, measured: { width: 216, height: 64 }, selected: true } : n));
    const moved = { ...DOC, nodes: DOC.nodes.map((n) => (n.id === T ? { ...n, x: 950 } : n)) };
    const again = buildFlowNodes(moved, measured, { canEdit: true });
    const t = again.find((n) => n.id === T)!;
    expect(t.measured).toEqual({ width: 216, height: 64 });
    expect(t.selected).toBe(true);
    expect(t.position).toEqual({ x: 950, y: 250 });
  });

  it('a read-only viewer cannot drag or delete a node', () => {
    const nodes = buildFlowNodes(DOC, [], { canEdit: false });
    expect(nodes.filter((n) => n.id !== INPUT_NODE_ID).every((n) => n.draggable === false && n.deletable === false)).toBe(true);
  });
});

describe('edges', () => {
  it('one edge per pair, labelled with every relation; the Input\'s link to the first node', () => {
    const edges = buildFlowEdges(DOC, [], true);
    expect(edges.map((e) => [e.source, e.target, e.label ?? null])).toEqual([
      [INPUT_NODE_ID, S, null],
      [S, T, 'Post telemetry / Post attributes'],
      [T, U, 'Failure'],
    ]);
    expect(edges[1].data?.relations).toEqual(['Post telemetry', 'Post attributes']);
  });

  it('a Failure-only link is drawn as one', () => {
    const edges = buildFlowEdges(DOC, [], true);
    expect(edges[2].className).toBe('rc-edge-failure');
    expect(edges[1].className).toBeUndefined();
  });

  it('no first node, no Input link', () => {
    expect(buildFlowEdges({ ...DOC, firstNodeId: null }, [], true).some((e) => e.source === INPUT_NODE_ID)).toBe(false);
  });
});

describe('what a Delete removes', () => {
  it('nodes (never the Input), pairs, and the Input\'s link', () => {
    const nodes = buildFlowNodes(DOC, [], { canEdit: true });
    const edges = buildFlowEdges(DOC, [], true);
    expect(removalOf([nodes[0], nodes[2]], [edges[0], edges[1]])).toEqual({
      nodeIds: [T], pairs: [{ from: S, to: T }], input: true,
    });
  });
});

describe('group colours', () => {
  it('ThingsBoard\'s six, each readable with the dark ink (at least 4.5:1)', () => {
    expect(RULE_GROUP_COLORS).toEqual({
      filter: '#f1e861', enrichment: '#cdf1b5', transformation: '#79cef1', action: '#f1928f', external: '#fbc4ff', flow: '#d6cdf8',
    });
    for (const colour of [...Object.values(RULE_GROUP_COLORS), RULE_UNSUPPORTED_COLOR, RULE_INPUT_COLOR]) {
      expect(contrastRatio(colour, RULE_GROUP_INK)).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the contrast helper agrees with WCAG\'s ends', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrastRatio('#777777', '#777777')).toBeCloseTo(1, 5);
  });
});
