/**
 * The HELPERS every node group shares (final fix wave, FW-N3, 2026-11-05):
 * the script a node runs (ruling TB-L), the ONE template rule (TP-1), the ONE
 * metadata-ts reader (M-1) and the Math CUSTOM function lookup (M-9).
 *
 * Every handler here is the REAL one, found through the registry exactly as the
 * engine finds it — never a stand-in under a shipped type id.
 */
import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { RULE_SCRIPT_KEYS } from '@digilog/shared';
import { clearRegistry, getHandler } from '../registry.js';
import { registerActionNodes } from '../nodes/action/index.js';
import { registerFilterNodes } from '../nodes/filter/index.js';
import { registerTransformationNodes } from '../nodes/transformation/index.js';
import { registerEnrichmentNodes } from '../nodes/enrichment/index.js';
import { registerExternalNodes } from '../nodes/external/index.js';
import { jsScriptOf, metadataTs, nodeScriptOf, processPattern } from '../nodes/action/support.js';
import { importChain } from '../import-export.js';
import { compileExpression, evaluateExpression } from '../nodes/action/math-expression.js';
import { newMessageId, type RuleMessage } from '../message.js';
import type { RuleServices } from '../services.js';
import { fakeContext, testMessage } from '../../../test-support/rule-engine.js';

type Overrides = Parameters<typeof fakeContext>[0] extends infer O ? O extends { services?: infer S } ? S : never : never;

async function run(type: string, config: Record<string, unknown>, msg: RuleMessage, services: Overrides = {}) {
  const { ctx, calls } = fakeContext({ type, config, services });
  const reg = getHandler(type);
  if (!reg) throw new Error(`no handler registered for ${type}`);
  let thrown: Error | null = null;
  try {
    await reg.handler(ctx, msg);
  } catch (e) {
    thrown = e as Error;
  }
  return { ctx, calls, thrown };
}

beforeAll(() => {
  clearRegistry();
  registerActionNodes();
  registerFilterNodes();
  registerTransformationNodes();
  registerEnrichmentNodes();
  registerExternalNodes();
});

afterEach(() => { vi.useRealTimers(); });

// ─── TB-L: the script a node runs ────────────────────────────────────────────

interface TbNode { name: string; type: string; configuration: Record<string, unknown> }
const FIXTURE_42 = JSON.parse(readFileSync(new URL('./fixtures/thingsboard-root-chain-4.2.json', import.meta.url), 'utf8')) as {
  metadata: { nodes: TbNode[] };
};
const fixtureNode = (name: string) => FIXTURE_42.metadata.nodes.find((n) => n.name === name)!;

describe('ruling TB-L — every script node runs the script scriptLang selects, as JavaScript', () => {
  it('ThingsBoard\'s own v4.2 root chain imports, and its "Log Other" RUNS on the REAL Log handler', async () => {
    const imported = importChain(JSON.parse(JSON.stringify(FIXTURE_42))).document.nodes.find((n) => n.name === 'Log Other')!;
    const r = await run(imported.type, imported.config, testMessage({ t: 21.5 }));
    expect(r.thrown).toBeNull();
    expect(r.calls.logs[0].text).toContain('Incoming message:\n{"t":21.5}');
    expect(r.calls.relations()).toEqual(['Success']);
  });

  it('the same "Log Other" STORED as ThingsBoard wrote it (scriptLang TBEL — a document saved before TB-L) runs on the REAL Log handler', async () => {
    const raw = fixtureNode('Log Other');
    expect(raw.configuration.scriptLang).toBe('TBEL');
    const r = await run('tb:action:log', raw.configuration, testMessage({ t: 7 }));
    expect(r.thrown).toBeNull();
    expect(r.calls.logs[0].text).toContain('Incoming message:\n{"t":7}');
  });

  it('Log: a stored TBEL node runs its TBEL text, never the JavaScript beside it; a JS node runs its JavaScript', async () => {
    const tbel = await run('tb:action:log', { scriptLang: 'TBEL', tbelScript: "return 'tbel ' + msg.t;", jsScript: "return 'js ' + msg.t;" }, testMessage({ t: 1 }));
    expect(tbel.calls.logs).toEqual([{ level: 'info', text: 'tbel 1' }]);
    const js = await run('tb:action:log', { scriptLang: 'JS', tbelScript: "return 'tbel ' + msg.t;", jsScript: "return 'js ' + msg.t;" }, testMessage({ t: 2 }));
    expect(js.calls.logs).toEqual([{ level: 'info', text: 'js 2' }]);
  });

  it('Log: TBEL with a blank TBEL script runs the JavaScript one (ThingsBoard could not start it; shared ruling N1-2)', async () => {
    const r = await run('tb:action:log', { scriptLang: 'TBEL', tbelScript: '  ', jsScript: "return 'js ran';" }, testMessage({}));
    expect(r.calls.logs).toEqual([{ level: 'info', text: 'js ran' }]);
  });

  it('Create alarm: a stored TBEL node builds the alarm details with its TBEL script, on the REAL handler', async () => {
    const findFirst = vi.fn(async () => null);
    const createOrUpdate = vi.fn(async () => ({
      alarm: {
        id: 'alarm-1', instrumentId: 'instrument-1', source: 'RULE', metric: 'CUSTOM', severity: 'CRITICAL', state: 'ACTIVE',
        limitKind: null, triggeredValue: null, clearedValue: null, raisedAt: new Date(1_000), clearedAt: null,
        acknowledgedAt: null, acknowledgedBy: null, acknowledgeReason: null, ruleSnapshot: { alarmType: 'General Alarm', details: {} },
      } as never,
      created: true,
    }));
    const r = await run('tb:action:create-alarm', {
      scriptLang: 'TBEL',
      alarmDetailsBuildTbel: 'return { from: "tbel", t: msg.t };',
      alarmDetailsBuildJs: 'return { from: "js" };',
    }, testMessage({ t: 31 }), { prisma: { alarm: { findFirst } } as unknown as RuleServices['prisma'], alarms: { createOrUpdate } });
    expect(r.thrown).toBeNull();
    expect((createOrUpdate.mock.calls[0] as unknown as [{ details: unknown }])[0].details).toEqual({ from: 'tbel', t: 31 });
  });

  it('Generator: a stored TBEL node STARTS and generates from its TBEL script', async () => {
    vi.useFakeTimers();
    const T = 'tb:action:generator';
    const { ctx, calls } = fakeContext({
      type: T,
      config: {
        periodInSeconds: 1, scriptLang: 'TBEL',
        tbelScript: "return { msg: { from: 'tbel' }, metadata: {}, msgType: 'TBEL_TICK' };",
        jsScript: "return { msg: { from: 'js' }, metadata: {}, msgType: 'JS_TICK' };",
      },
    });
    await getHandler(T)!.onInit!(ctx);
    try {
      vi.advanceTimersByTime(1_000);
      expect(calls.next.map((n) => [n.msg.type, n.msg.data])).toEqual([['TBEL_TICK', { from: 'tbel' }]]);
    } finally {
      await getHandler(T)!.onDestroy!(ctx);
    }
  });

  it('Filter script, Switch and Script transform follow the SAME rule (filter/support.ts)', async () => {
    const both = (tbel: string, js: string) => ({ scriptLang: 'TBEL', tbelScript: tbel, jsScript: js });
    const filter = await run('tb:filter:script', both('return false;', 'return true;'), testMessage({}));
    expect(filter.calls.relations()).toEqual(['False']);
    const sw = await run('tb:filter:switch', both("return ['tbel'];", "return ['js'];"), testMessage({}));
    expect(sw.calls.relations()).toEqual(['tbel']);
    const tr = await run('tb:transformation:script', both('return { msg: { by: 1 } };', 'return { msg: { by: 2 } };'), testMessage({}));
    expect(tr.calls.next[0].msg.data).toEqual({ by: 1 });
  });

  it('jsScriptOf (alarm-support\'s call, by JavaScript key) is the same rule: the key names its TBEL twin', () => {
    expect(jsScriptOf({ scriptLang: 'TBEL', alarmDetailsBuildJs: 'j', alarmDetailsBuildTbel: 't' }, 'alarmDetailsBuildJs')).toBe('t');
    expect(jsScriptOf({ scriptLang: 'JS', alarmDetailsBuildJs: 'j', alarmDetailsBuildTbel: 't' }, 'alarmDetailsBuildJs')).toBe('j');
    expect(jsScriptOf({ scriptLang: 'TBEL', jsScript: 'j', tbelScript: 't' }, 'jsScript')).toBe('t');
    // Every type that shares a JavaScript key shares its TBEL twin, so the key alone decides.
    const twins = new Map<string, Set<string>>();
    for (const [js, tbel] of Object.values(RULE_SCRIPT_KEYS)) twins.set(js, (twins.get(js) ?? new Set()).add(tbel));
    for (const set of twins.values()) expect(set.size).toBe(1);
    expect(() => jsScriptOf({ jsScript: 'x' }, 'notAScriptKey')).toThrow(/^SCRIPT_REQUIRED/);
  });

  it('no script to run → SCRIPT_REQUIRED naming the key; there is no TBEL refusal anywhere', () => {
    expect(() => nodeScriptOf('tb:action:log', { scriptLang: 'JS', jsScript: ' ' })).toThrow('SCRIPT_REQUIRED: the node has no script (jsScript)');
    expect(() => nodeScriptOf('tb:action:log', { scriptLang: 'TBEL', tbelScript: '' })).toThrow('SCRIPT_REQUIRED: the node has no script (jsScript)');
    expect(nodeScriptOf('tb:action:clear-alarm', { scriptLang: 'TBEL', alarmDetailsBuildTbel: 'return {};' })).toBe('return {};');
  });
});

// ─── TP-1: ONE template rule for every caller ────────────────────────────────

describe('ruling TP-1 — processPattern is ThingsBoard\'s TbNodeUtils.processPattern, in ONE pass', () => {
  const msg = {
    metadata: { deviceName: 'F-1', n: '3' },
    data: { temp: 21.5, nested: { a: { b: 'deep' } }, flag: true, nil: null, obj: { x: 1 }, list: [1, 2] },
  };

  it('${key} reads metadata, $[path] walks data objects; strings raw, booleans as text, JSON null as "null"', () => {
    expect(processPattern('${deviceName} is $[temp] (${n}/${n}) $[nested.a.b] $[flag] $[nil]', msg)).toBe('F-1 is 21.5 (3/3) deep true null');
  });

  it('${*} is the whole metadata as JSON, $[*] the whole data as JSON — as ThingsBoard prints them', () => {
    expect(processPattern('${*}', msg)).toBe(JSON.stringify(msg.metadata));
    expect(processPattern('$[*]', msg)).toBe(JSON.stringify(msg.data));
    expect(processPattern('${*}|$[*]', { metadata: {}, data: 'text' })).toBe('{}|"text"');
  });

  it('the trailing-dot rule (Java String.split drops trailing empty strings): $[a.] and $[a..] read a', () => {
    expect(processPattern('$[temp.]|$[temp..]|$[nested.a.b.]', msg)).toBe('21.5|21.5|deep');
  });

  it('leaves as written: a missing key, an object, an array, an empty step, a non-object data, a span over a line break', () => {
    expect(processPattern('${nope}|$[nope]|$[obj]|$[list]|$[list.0]|$[nested..a]|$[.temp]|$[]|$[.]', msg))
      .toBe('${nope}|$[nope]|$[obj]|$[list]|$[list.0]|$[nested..a]|$[.temp]|$[]|$[.]');
    expect(processPattern('$[0]|${n}', { metadata: { n: '1' }, data: [1] })).toBe('$[0]|1');
    expect(processPattern('$[te\nmp]', { metadata: {}, data: { 'te\nmp': 1 } })).toBe('$[te\nmp]');
  });

  it('OWN keys only: an inherited property is not a value', () => {
    const m = { metadata: { ts: '1' }, data: JSON.parse('{"a":{"b":2}}') as unknown };
    expect(processPattern('$[constructor]|$[a.toString]|$[a.b]|${constructor}|${hasOwnProperty}', m))
      .toBe('$[constructor]|$[a.toString]|2|${constructor}|${hasOwnProperty}');
    // An inherited VALUE is not read either (JSON never carries one; a test object can).
    const inherited = Object.assign(Object.create({ leak: 'x', nested: { v: 1 } }) as Record<string, unknown>, { mine: { leak: 'y' } });
    expect(processPattern('$[leak]|$[nested.v]|$[mine.leak]', { metadata: {}, data: inherited })).toBe('$[leak]|$[nested.v]|y');
  });

  it('ONE pass: a substituted value is never expanded again — metadata → metadata, metadata → data, data → anything', () => {
    const m = { metadata: { a: '${b}', b: 'B', c: '$[t]' }, data: { t: 5, s: '${b}', u: '$[t]' } };
    expect(processPattern('${a}|${c}|$[s]|$[u]|${b}|$[t]', m)).toBe('${b}|$[t]|${b}|$[t]|B|5');
    // A placeholder BUILT by a substitution is not one either: ThingsBoard would read data[v] here.
    expect(processPattern('$[${k}]', { metadata: { k: 't' }, data: { t: 9 } })).toBe('$[t]');
  });

  it('an unresolved placeholder does not swallow the text after it', () => {
    expect(processPattern('${a${b}|$[x ${b}', { metadata: { b: 'B' }, data: {} })).toBe('${aB|$[x B');
    expect(processPattern('$${n}$[temp]$', msg)).toBe('$321.5$');
  });

  it('numbers print as Jackson\'s asText: a whole number as is, any other as Java\'s Double.toString', () => {
    const m = { metadata: {}, data: { i: 12345678, small: 0.0001, big: 12345678.9, f: 21.25 } };
    expect(processPattern('$[i]|$[small]|$[big]|$[f]', m)).toBe('12345678|1.0E-4|1.23456789E7|21.25');
  });

  it('escapeJson (ThingsBoard\'s escapeJsonValues, Jackson quoteAsString): each ${key} / $[key] value escaped; ${*} / $[*] go in as JSON', () => {
    const m = { metadata: { q: 'a"b\\c\n\t\u0001\u001f/é' }, data: { s: 'x"y', n: 1.5 } };
    expect(processPattern('${q}|$[s]|$[n]', m, { escapeJson: true })).toBe('a\\"b\\\\c\\n\\t\\u0001\\u001F/é|x\\"y|1.5');
    expect(processPattern('${q}', m)).toBe(m.metadata.q);
    const body = processPattern('{"q":"${q}","s":"$[s]","meta":${*},"data":$[*]}', m, { escapeJson: true });
    expect(JSON.parse(body)).toEqual({ q: m.metadata.q, s: 'x"y', meta: m.metadata, data: m.data });
  });

  it('a non-string pattern is the empty text', () => {
    expect(processPattern(undefined as unknown as string, msg)).toBe('');
  });

  it('the TRANSFORMATION group (To email) uses it: one pass, no metadata re-expansion', async () => {
    const r = await run('tb:transformation:to-email', { subjectTemplate: '${a}|${b}|$[c]' },
      testMessage({ c: '${b}' }, { metadata: { a: '${b}', b: 'B' } }));
    expect((r.calls.next[0].msg.data as { subject: string }).subject).toBe('${b}|B|${b}');
  });

  it('the ENRICHMENT / ACTION group (support.ts callers — Originator attributes keys) uses it: a metadata value naming $[…] is not read from the data', async () => {
    const get = vi.fn(async () => ({}));
    await run('tb:enrichment:originator-attributes', { serverAttributeNames: ['${which}'], tellFailureIfAbsent: false },
      testMessage({ k: 'fw' }, { metadata: { which: '$[k]' } }), { attributes: { get } });
    expect(get).toHaveBeenCalledWith('instrument-1', ['$[k]']);
  });

  it('the EXTERNAL group (Send SMS) uses it: ${*} / $[*] print JSON, one pass', async () => {
    const sms = vi.fn(async () => ({ sent: ['+1'], failed: [] }));
    const msgIn = testMessage({ t: 1 }, { metadata: { a: '${b}', b: 'B' } });
    await run('tb:external:send-sms', { numbersToTemplate: '+1', smsMessageTemplate: '${a}|$[*]|${*}' }, msgIn, { notifications: { sms } });
    expect((sms.mock.calls[0] as unknown as [{ message: string }])[0].message).toBe(`\${b}|{"t":1}|${JSON.stringify(msgIn.metadata)}`);
  });
});

// ─── M-1: ONE metadata-ts reader ─────────────────────────────────────────────

describe('M-1 — metadataTs is ThingsBoard\'s TbMsg.getMetaDataTs (Long.parseLong, else the message\'s own time)', () => {
  const at = (ts: string | undefined, id = newMessageId(1_700_000_000_999)) =>
    metadataTs({ id, metadata: ts === undefined ? {} : { ts } });

  it('a whole number, with an optional sign — as Long.parseLong reads it', () => {
    expect(at('1700000000123')).toBe(1_700_000_000_123);
    expect(at('+1700000000123')).toBe(1_700_000_000_123);
    expect(at('-5')).toBe(-5);
    expect(at('007')).toBe(7);
    expect(Object.is(at('-0'), 0)).toBe(true);
  });

  it('anything Long.parseLong refuses falls back to the message\'s own time (its id): no trim, no fraction, no exponent, no unsafe integer', () => {
    for (const ts of [' 123', '123 ', '', '+', '-', '1.5e12', '12.0', 'soon', '0x10', '9007199254740993', '99999999999999999999']) {
      expect(at(ts), JSON.stringify(ts)).toBe(1_700_000_000_999);
    }
    expect(at(undefined)).toBe(1_700_000_000_999);
  });

  it('no ts and no time in the id → now', () => {
    const before = Date.now();
    expect(metadataTs({ id: 'not-a-v7-id', metadata: {} })).toBeGreaterThanOrEqual(before);
  });
});

// ─── M-9: the Math CUSTOM function table is own-property only ────────────────

describe('M-9 — a Math CUSTOM expression names only the OWN functions of its table', () => {
  it('constructor(x), toString(x), hasOwnProperty(x) are unknown functions, not "takes undefined argument(s)"', () => {
    for (const fn of ['constructor', 'toString', 'hasOwnProperty', 'valueOf', '__proto__']) {
      expect(() => compileExpression(`${fn}(x)`), fn).toThrow(`MATH_EXPRESSION_INVALID: unknown function "${fn}" in "${fn}(x)"`);
    }
  });

  it('a real function still parses and evaluates', () => {
    expect(evaluateExpression(compileExpression('sqrt(x) + pow(2, 3)'), { x: 16 })).toBe(12);
  });
});
