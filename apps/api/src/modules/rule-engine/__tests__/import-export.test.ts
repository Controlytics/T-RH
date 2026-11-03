import { describe, it, expect, afterEach } from 'vitest';
import { defaultRootChainDocument, messageTypeSwitchLabel, toThingsboardExport, DEFAULT_ROOT_CHAIN_NODE_IDS } from '@digilog/shared';
import { importChain } from '../import-export.js';
import { createRuleEngine } from '../engine.js';
import { registerNode } from '../registry.js';
import { newMessage } from '../message.js';
import { chainOf, memoryDeps, fakeServices } from '../../../test-support/rule-engine.js';

/**
 * A chain exported to ThingsBoard JSON and imported back RUNS (Task 3): the
 * engine routes it by the imported node types and relation labels exactly as
 * it routes the shipped one. And the capacity claim of spec §6: 1,000
 * messages through the shipped root chain in under 2 s.
 *
 * The shipped chain's four node types have no handlers until Tasks 4 / 5, so
 * the stand-ins here do what those nodes do to ROUTING: the Message Type
 * Switch answers ThingsBoard's label for the type; the Save / Log nodes end
 * the message. The throughput figure is therefore the ENGINE's cost (queue,
 * routing, copies, contexts) — not a database write per message.
 */
const restores: (() => void)[] = [];
afterEach(() => { while (restores.length) restores.pop()!(); });

function standIns(hits: Record<string, number>) {
  const end = (name: string) => () => { hits[name] = (hits[name] ?? 0) + 1; };
  restores.push(registerNode('tb:filter:message-type-switch', (ctx, msg) => ctx.tellNext(msg, messageTypeSwitchLabel(msg.type))));
  restores.push(registerNode('tb:action:save-timeseries', end('timeseries')));
  restores.push(registerNode('tb:action:save-attributes', end('attributes')));
  restores.push(registerNode('tb:action:log', end('log')));
}

function importedRoot() {
  const exported = toThingsboardExport('Root Rule Chain', true, defaultRootChainDocument());
  const imported = importChain(JSON.parse(JSON.stringify(exported)));
  expect(imported.warnings).toEqual([]);
  return chainOf(imported.name, imported.document, { root: true, strict: true });
}

const telemetry = (instrument: string, i: number) =>
  newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: instrument }, { ts: i, values: { t: i } }, { ts: String(i) });

describe('an imported ThingsBoard chain runs', () => {
  it('routes by the imported types and labels: telemetry → Save Timeseries, attributes → Save Attributes, other → Log', async () => {
    const hits: Record<string, number> = {};
    standIns(hits);
    const root = importedRoot();
    // Import mints fresh node ids; the routing is by label, not by the shipped ids.
    expect(root.document.nodes.map((n) => n.id)).not.toContain(DEFAULT_ROOT_CHAIN_NODE_IDS.messageTypeSwitch);
    const mem = memoryDeps([root]);
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.processNow(telemetry('i1', 1));
    await engine.processNow(newMessage('POST_ATTRIBUTES_REQUEST', { type: 'INSTRUMENT', id: 'i1' }, { a: '1' }));
    // A type ThingsBoard has no label for is "Other" → Log.
    await engine.processNow(newMessage('MY_CUSTOM_EVENT', { type: 'INSTRUMENT', id: 'i1' }, {}));
    // ENTITY_CREATED ("Entity Created") and ALARM ("Alarm") HAVE labels, and the
    // default chain connects neither: they end at the switch.
    await engine.processNow(newMessage('ENTITY_CREATED', { type: 'INSTRUMENT', id: 'i1' }, {}));
    await engine.processNow(newMessage('ALARM', { type: 'ALARM', id: 'a1' }, {}));
    expect(hits).toEqual({ timeseries: 1, attributes: 1, log: 1 });
  });
});

describe('capacity (spec §6)', () => {
  it('1,000 messages from 320 instruments through the shipped root chain in under 2 s', async () => {
    const hits: Record<string, number> = {};
    standIns(hits);
    const root = chainOf('Root Rule Chain', defaultRootChainDocument(), { root: true, strict: true });
    const mem = memoryDeps([root]);
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      const started = performance.now();
      for (let i = 0; i < 1_000; i++) expect(engine.enqueue(telemetry(`inst-${i % 320}`, i))).toBe(true);
      await engine.drain();
      const ms = performance.now() - started;
      expect(hits.timeseries).toBe(1_000);
      expect(engine.stats().processedLastMinute).toBe(1_000);
      expect(engine.stats().dropped).toBe(0);
      // Reported in the task report; the bound is the spec's.
      console.log(`[rule-engine throughput] 1000 messages through the shipped root chain: ${ms.toFixed(0)} ms`);
      expect(ms).toBeLessThan(2_000);
    } finally {
      await engine.stop();
    }
  });
});
