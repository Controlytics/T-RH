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
import { jsScriptOf, nodeScriptOf } from '../nodes/action/support.js';
import { importChain } from '../import-export.js';
import type { RuleMessage } from '../message.js';
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
