import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import {
  setRuleEngineSink, emitCounters, resetEmitCounters,
  emitTelemetry, emitTelemetryBatch, emitAttributes, emitAttributesDeleted, emitAlarm, emitRuleNodeAlarm, emitInactivity, emitActivity, emitEntity,
  type RuleEngineSink,
} from '../emit.js';
import { ruleNodeOrigin, type RuleMessage } from '../message.js';
import { runInFlow } from '../context.js';

/**
 * The emit helpers (spec §5): the message each event becomes, the loop guard,
 * and the promise that they never throw into their caller.
 */
const CHAIN = '0f000000-0000-4000-8000-00000000c0de';
const NODE = '0f000000-0000-4000-8000-00000000d0de';

let queued: RuleMessage[];
let reEnter: boolean;
let accepting: boolean;
let enqueueThrows: boolean;

const sink: RuleEngineSink = {
  accepting: () => accepting,
  enqueue: (msg) => {
    if (enqueueThrows) throw new Error('queue exploded');
    queued.push(msg);
    return true;
  },
  reEnterAllowed: async (chainId) => chainId === CHAIN && reEnter,
};

beforeEach(() => {
  queued = [];
  reEnter = false;
  accepting = true;
  enqueueThrows = false;
  resetEmitCounters();
  setRuleEngineSink(sink);
});
afterEach(() => setRuleEngineSink(null));

describe('accepting', () => {
  it('no engine installed, or switched off → nothing, and no throw', async () => {
    setRuleEngineSink(null);
    expect(await emitTelemetry('i1', [{ key: 't', value: 1, ts: new Date() }], 'http')).toBe(0);
    setRuleEngineSink(sink);
    accepting = false;
    expect(await emitTelemetry('i1', [{ key: 't', value: 1, ts: new Date() }], 'http')).toBe(0);
    expect(queued).toEqual([]);
  });

  it('a queue that throws is counted as emit_errors, never thrown into the caller', async () => {
    enqueueThrows = true;
    await expect(emitTelemetry('i1', [{ key: 't', value: 1, ts: new Date() }], 'http')).resolves.toBe(0);
    expect(emitCounters().emit_errors).toBe(1);
  });
});

describe('POST_TELEMETRY_REQUEST', () => {
  it('is FLAT ({ key: value }, ThingsBoard\'s shape) with metadata.ts, one per instant; raw_<key> only where an offset changed the value', async () => {
    const ts = new Date('2026-11-03T10:00:00.000Z');
    const n = await emitTelemetry('i1', [
      { key: 'temp', value: 21.5, ts, rawValue: 20.5 },
      { key: 'hum', value: 40, ts, rawValue: 40 },
      { key: 'bat', value: 3.3, ts },
    ], 'mqtt', undefined, 'CWH/1');
    expect(n).toBe(1);
    const [m] = queued;
    expect(m.type).toBe('POST_TELEMETRY_REQUEST');
    expect(m.originator).toEqual({ type: 'INSTRUMENT', id: 'i1', code: 'CWH/1' });
    expect(m.data).toEqual({ temp: 21.5, hum: 40, bat: 3.3 });
    expect(m.metadata).toEqual({
      ts: String(ts.getTime()), transport: 'mqtt', instrumentCode: 'CWH/1', raw_temp: '20.5', rule_engine_origin: 'ingest',
    });
  });

  it('one message per instrument per instant (a gateway batch)', async () => {
    const t1 = new Date(1_000);
    const t2 = new Date(2_000);
    await emitTelemetryBatch([
      { instrumentId: 'a', key: 't', value: 1, ts: t1 },
      { instrumentId: 'a', key: 'h', value: 2, ts: t1 },
      { instrumentId: 'b', key: 't', value: 3, ts: t1 },
      { instrumentId: 'b', key: 't', value: 4, ts: t2 },
    ], 'http');
    expect(queued.map((m) => [m.originator.id, m.metadata.ts, m.data])).toEqual([
      ['a', '1000', { t: 1, h: 2 }],
      ['b', '1000', { t: 3 }],
      ['b', '2000', { t: 4 }],
    ]);
  });
});

describe('the loop guard (spec §5, ruling S-2)', () => {
  it('a rule node\'s write does not re-enter unless its chain says so', async () => {
    const origin = ruleNodeOrigin(CHAIN, NODE);
    expect(await emitTelemetry('i1', [{ key: 't', value: 1, ts: new Date() }], 'rule-engine', origin)).toBe(0);
    expect(emitCounters().loop_skipped).toBe(1);
    reEnter = true;
    expect(await emitTelemetry('i1', [{ key: 't', value: 1, ts: new Date() }], 'rule-engine', origin)).toBe(1);
    expect(queued[0].metadata.rule_engine_origin).toBe(origin);
  });

  it('applies to every event a rule node causes: attributes, deletions, alarms', async () => {
    const origin = ruleNodeOrigin(CHAIN, NODE);
    await emitAttributes('i1', { k: 'v' }, origin);
    await emitAttributesDeleted('i1', ['k'], origin);
    await emitAlarm('ALARM', alarm(), { isNewAlarm: true, origin });
    await emitRuleNodeAlarm('ENTITY_CREATED', alarm(), { ruleNodeId: NODE, origin });
    expect(queued).toEqual([]);
    expect(emitCounters().loop_skipped).toBe(4);
  });

  it('a malformed rule_node origin is skipped, not let through', async () => {
    expect(await emitTelemetry('i1', [{ key: 't', value: 1, ts: new Date() }], 'rule-engine', 'rule_node:nonsense')).toBe(0);
  });
});

describe('the re-entry depth (ruling RE-1)', () => {
  const origin = ruleNodeOrigin(CHAIN, NODE);
  const reading = () => [{ key: 't', value: 1, ts: new Date() }];

  it('inside a flow that itself re-entered (depth 1), a rule node\'s write emits NOTHING — even with Re-enter ON, and without asking the chain', async () => {
    reEnter = true;
    let asked = 0;
    const counting: RuleEngineSink = { ...sink, reEnterAllowed: async (id) => { asked++; return sink.reEnterAllowed(id); } };
    setRuleEngineSink(counting);
    await runInFlow({ reentryDepth: 1 }, async () => {
      expect(await emitTelemetry('i1', reading(), 'rule-engine', origin)).toBe(0);
      expect(await emitAttributes('i1', { k: 'v' }, origin)).toBe(0);
      expect(await emitAttributesDeleted('i1', ['k'], origin)).toBe(0);
      expect(await emitRuleNodeAlarm('ENTITY_UPDATED', alarm(), { ruleNodeId: NODE, origin })).toBe(0);
      expect(await emitRuleNodeAlarm('ALARM_CLEAR', alarm(), { ruleNodeId: NODE, origin })).toBe(0);
    });
    expect(queued).toEqual([]);
    expect(emitCounters().loop_skipped).toBe(5);
    expect(asked).toBe(0);
  });

  it('at depth 0 (a first-generation message, or outside any flow) the chain\'s switch decides, as before', async () => {
    reEnter = true;
    expect(await runInFlow({ reentryDepth: 0 }, () => emitTelemetry('i1', reading(), 'rule-engine', origin))).toBe(1);
    expect(await emitTelemetry('i1', reading(), 'rule-engine', origin)).toBe(1);
    expect(emitCounters().loop_skipped).toBe(0);
  });

  it('the depth limits rule-node writes only: ingest, system and user events inside a depth-1 flow still enter', async () => {
    await runInFlow({ reentryDepth: 1 }, async () => {
      expect(await emitTelemetry('i1', reading(), 'http')).toBe(1);
      expect(await emitAlarm('ALARM', alarm(), { isNewAlarm: true })).toBe(1);
      expect(await emitEntity('ENTITY_UPDATED', { id: 'i1', code: 'C' })).toBe(1);
    });
    expect(emitCounters().loop_skipped).toBe(0);
  });

  it('the depth survives the awaits between a handler and the emit: a timer, setImmediate, a promise ANOTHER context resolves', async () => {
    reEnter = true;
    // Resolved from a timer armed OUTSIDE the flow, as a batch writer would resolve a caller's promise.
    let release!: () => void;
    const elsewhere = new Promise<void>((r) => { release = r; });
    const outside = setTimeout(() => release(), 5);
    const n = await runInFlow({ reentryDepth: 1 }, async () => {
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setTimeout(r, 1));
      await elsewhere;
      await Promise.resolve();
      return emitTelemetry('i1', reading(), 'rule-engine', origin);
    });
    clearTimeout(outside);
    expect(n).toBe(0);
    expect(emitCounters().loop_skipped).toBe(1);
  });
});

describe('attributes', () => {
  it('a device report is POST_ATTRIBUTES_REQUEST, scope CLIENT_SCOPE', async () => {
    await emitAttributes('i1', [['fw', '1.2'], ['mode', 'auto']], 'ingest');
    expect(queued[0].type).toBe('POST_ATTRIBUTES_REQUEST');
    expect(queued[0].data).toEqual({ fw: '1.2', mode: 'auto' });
    expect(queued[0].metadata.scope).toBe('CLIENT_SCOPE');
  });

  it('a rule node\'s Save attributes is ATTRIBUTES_UPDATED, scope SERVER_SCOPE; a delete is ATTRIBUTES_DELETED', async () => {
    reEnter = true;
    const origin = ruleNodeOrigin(CHAIN, NODE);
    await emitAttributes('i1', { k: 'v' }, origin);
    await emitAttributesDeleted('i1', ['a', 'b'], origin);
    expect(queued.map((m) => [m.type, m.metadata.scope, m.data])).toEqual([
      ['ATTRIBUTES_UPDATED', 'SERVER_SCOPE', { k: 'v' }],
      ['ATTRIBUTES_DELETED', 'SERVER_SCOPE', { attributes: ['a', 'b'] }],
    ]);
  });
});

function alarm(over: Partial<Parameters<typeof emitAlarm>[1]> = {}): Parameters<typeof emitAlarm>[1] {
  return {
    id: 'al-1', instrumentId: 'i1', source: 'INSTRUMENT_LIMIT', metric: 'TEMPERATURE', limitKind: 'HIGH',
    severity: 'MAJOR', state: 'ACTIVE', triggeredValue: 30, raisedAt: new Date(5_000), ruleSnapshot: { description: 'x' }, ...over,
  };
}

describe('alarms', () => {
  it('ALARM (ruling AL-1): from the alarm\'s INSTRUMENT (with its code), metadata.alarmId, data = the alarm JSON with its id; ThingsBoard status; only the TRUE flag', async () => {
    await emitAlarm('ALARM', alarm(), { isNewAlarm: true, typeName: 'High Temperature', instrumentCode: 'CWH/1' });
    const [m] = queued;
    expect(m.originator).toEqual({ type: 'INSTRUMENT', id: 'i1', code: 'CWH/1' });
    expect(m.metadata).toMatchObject({ alarmId: 'al-1', instrumentId: 'i1', instrumentCode: 'CWH/1', isNewAlarm: 'true', rule_engine_origin: 'system' });
    // ThingsBoard writes the one flag that is true (AlarmState.pushMsg, TbAbstractAlarmNode.toAlarmMsg) — never "false".
    expect(m.metadata).not.toHaveProperty('isExistingAlarm');
    expect(m.data).toMatchObject({ id: 'al-1', type: 'High Temperature', status: 'ACTIVE_UNACK', severity: 'MAJOR', startTs: 5000, cleared: false });
  });

  it('a RULE alarm is typed by its own alarmType; CLEAR / ACK carry their flags — and come from the instrument too', async () => {
    const rule = alarm({ source: 'RULE', metric: 'CUSTOM', limitKind: null, ruleSnapshot: { alarmType: 'Door open', details: { d: 1 } } });
    await emitAlarm('ALARM_CLEAR', { ...rule, state: 'CLEARED', clearedAt: new Date(9_000) }, { typeName: 'ignored' });
    await emitAlarm('ALARM_ACK', { ...rule, acknowledgedAt: new Date(7_000), acknowledgedBy: 'qa1' }, { acknowledgedBy: 'qa1', origin: 'user' });
    expect(queued[0].data).toMatchObject({ id: 'al-1', type: 'Door open', status: 'CLEARED_UNACK', details: { d: 1 }, clearTs: 9000, endTs: 9000 });
    expect(queued[0].metadata).toMatchObject({ alarmId: 'al-1', isClearedAlarm: 'true' });
    expect(queued[1].data).toMatchObject({ id: 'al-1', status: 'ACTIVE_ACK', ackTs: 7000 });
    expect(queued[1].metadata).toMatchObject({ alarmId: 'al-1', acknowledgedBy: 'qa1', rule_engine_origin: 'user' });
    // No code given: the engine fills it in before the first node (hydrate), as for telemetry.
    for (const m of queued) expect(m.originator).toEqual({ type: 'INSTRUMENT', id: 'i1' });
  });

  it('AL-1: every alarm message — the evaluator\'s raise and clear, the acknowledge, a rule node\'s create / update / clear — has the instrument as originator', async () => {
    reEnter = true;
    const node = ruleNodeOrigin(CHAIN, NODE);
    await emitAlarm('ALARM', alarm(), { isNewAlarm: true });
    await emitAlarm('ALARM_CLEAR', alarm({ state: 'CLEARED' }), { isClearedAlarm: true });
    await emitAlarm('ALARM_ACK', alarm({ acknowledgedAt: new Date(6_000) }), { origin: 'user' });
    await emitRuleNodeAlarm('ENTITY_CREATED', alarm(), { ruleNodeId: NODE, origin: node });
    await emitRuleNodeAlarm('ENTITY_UPDATED', alarm(), { ruleNodeId: NODE, origin: node });
    await emitRuleNodeAlarm('ALARM_CLEAR', alarm({ state: 'CLEARED' }), { ruleNodeId: NODE, origin: node });
    expect(queued.map((m) => [m.type, m.originator.type, m.originator.id, m.metadata.alarmId])).toEqual([
      ['ALARM', 'INSTRUMENT', 'i1', 'al-1'], ['ALARM_CLEAR', 'INSTRUMENT', 'i1', 'al-1'], ['ALARM_ACK', 'INSTRUMENT', 'i1', 'al-1'],
      ['ENTITY_CREATED', 'INSTRUMENT', 'i1', 'al-1'], ['ENTITY_UPDATED', 'INSTRUMENT', 'i1', 'al-1'], ['ALARM_CLEAR', 'INSTRUMENT', 'i1', 'al-1'],
    ]);
  });

  it('AL-2: a RULE NODE\'s alarm action message is ThingsBoard\'s alarmActionMsg (ENTITY_CREATED / ENTITY_UPDATED / ALARM_CLEAR) from the instrument, data the alarm JSON, metadata ruleNodeId + alarmId + origin, NO profile flags', async () => {
    reEnter = true;
    const node = ruleNodeOrigin(CHAIN, NODE);
    const rule = alarm({ source: 'RULE', metric: 'CUSTOM', limitKind: null, ruleSnapshot: { alarmType: 'Door open', details: { d: 1 } } });
    await emitRuleNodeAlarm('ENTITY_CREATED', rule, { ruleNodeId: NODE, origin: node, instrumentCode: 'CWH/1' });
    await emitRuleNodeAlarm('ALARM_CLEAR', { ...rule, state: 'CLEARED', clearedAt: new Date(9_000) }, { ruleNodeId: NODE, origin: node });
    const [created, cleared] = queued;
    expect(created.originator).toEqual({ type: 'INSTRUMENT', id: 'i1', code: 'CWH/1' });
    expect(created.metadata).toEqual({ ruleNodeId: NODE, alarmId: 'al-1', rule_engine_origin: node });
    expect(created.data).toMatchObject({ id: 'al-1', type: 'Door open', status: 'ACTIVE_UNACK', details: { d: 1 } });
    expect(cleared.metadata).toEqual({ ruleNodeId: NODE, alarmId: 'al-1', rule_engine_origin: node });
    expect(cleared.data).toMatchObject({ id: 'al-1', status: 'CLEARED_UNACK', cleared: true });
  });

  it('INACTIVITY_EVENT and ACTIVITY_EVENT', async () => {
    await emitInactivity('i1', new Date(1_000), new Date(2_000));
    await emitActivity('i1', new Date(3_000));
    expect(queued.map((m) => [m.type, m.originator.type, m.data])).toEqual([
      ['INACTIVITY_EVENT', 'INSTRUMENT', { lastActivityTime: 1000, inactivityAlarmTime: 2000 }],
      ['ACTIVITY_EVENT', 'INSTRUMENT', { lastActivityTime: 3000 }],
    ]);
  });
});

describe('ENTITY_*', () => {
  it('carries the instrument\'s columns, never its token, credential or certificate', async () => {
    await emitEntity('ENTITY_CREATED', {
      id: 'i1', code: 'CWH/1', name: 'One', isActive: true, createdAt: new Date(0),
      profile: { name: 'T&RH' }, credentials: [{ tokenHash: 'h', tokenPrefix: 'p' }], token: 'secret',
      deviceCertFingerprint: 'fp', modbusRegisters: [{ key: 't' }],
    });
    const [m] = queued;
    expect(m.data).toEqual({ id: 'i1', code: 'CWH/1', name: 'One', isActive: true, createdAt: '1970-01-01T00:00:00.000Z', profileName: 'T&RH' });
    expect(m.metadata).toMatchObject({ instrumentCode: 'CWH/1', instrumentName: 'One', profileName: 'T&RH', rule_engine_origin: 'user' });
  });
});

describe('every alarm raise and clear site emits (a site added without it fails here)', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const read = (p: string) => readFileSync(resolve(here, p), 'utf8');
  const count = (src: string, re: RegExp) => (src.match(re) ?? []).length;

  it('alarm-evaluation.worker.ts: one emitAlarm per enqueueAlarmWebhook (4 raises, 6 clears)', () => {
    const src = read('../../../workers/alarm-evaluation.worker.ts');
    expect(count(src, /await enqueueAlarmWebhook\(/g)).toBe(count(src, /await emitAlarm\(/g));
    expect(count(src, /emitAlarm\('ALARM',/g)).toBe(4);
    expect(count(src, /emitAlarm\('ALARM_CLEAR',/g)).toBe(6);
    expect(count(src, /await emitInactivity\(/g)).toBe(1);
    expect(count(src, /await emitActivity\(/g)).toBe(1);
  });

  it('the acknowledge route, ingest, the device attribute report and the instrument routes emit', () => {
    expect(count(read('../../alarms/routes.ts'), /emitAlarm\('ALARM_ACK',/g)).toBe(1);
    const ingest = read('../../instruments/ingest-core.ts');
    expect(count(ingest, /await emitTelemetry\(/g)).toBe(1);
    expect(count(ingest, /await emitTelemetryBatch\(/g)).toBe(1);
    expect(count(read('../../instruments/attribute-report.ts'), /await emitAttributes\(/g)).toBe(1);
    const routes = read('../../instruments/routes.ts');
    // The single create / update / delete routes, plus the bulk upload's CREATED and UPDATED (review A M7, emitBulkEntities).
    const sites = { ENTITY_CREATED: 2, ENTITY_UPDATED: 2, ENTITY_DELETED: 1 };
    for (const [kind, n] of Object.entries(sites)) expect(count(routes, new RegExp(`emitEntity\\('${kind}'`, 'g')), kind).toBe(n);
  });
});
