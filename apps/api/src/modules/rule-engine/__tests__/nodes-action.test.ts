/**
 * The ACTION rule nodes (rule chains, Task 5), and the helpers they share with
 * the enrichment group (templates, rounding, the message time) and the Math
 * function's expression parser. Handlers are driven through the registry as
 * the engine finds them; a throw is the engine's `Failure` (`thrown` here).
 * Lifecycle nodes (Generator, Message count) run under fake timers here — the
 * e2e never fakes time.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { RULE_NODE_TYPES } from '@digilog/shared';
import { clearRegistry, getHandler } from '../registry.js';
import { registerActionNodes } from '../nodes/action/index.js';
import { metadataTs, processPattern, roundHalfUp } from '../nodes/action/support.js';
import { compileExpression, evaluateExpression } from '../nodes/action/math-expression.js';
import { telemetryTsOf } from '../nodes/action/save-timeseries.js';
import { newMessage, newMessageId, type RuleMessage } from '../message.js';
import { alarmMessageData, emitAlarm, emitRuleNodeAlarm, setRuleEngineSink } from '../emit.js';
import { fakeContext, testMessage } from '../../../test-support/rule-engine.js';
import type { RuleServices } from '../services.js';

type Overrides = Parameters<typeof fakeContext>[0] extends infer O ? O extends { services?: infer S } ? S : never : never;

function contextFor(type: string, config: Record<string, unknown>, services: Overrides = {}, ids: { nodeId?: string; chainId?: string } = {}) {
  return fakeContext({ type, config, services, ...ids });
}

async function run(type: string, config: Record<string, unknown>, msg: RuleMessage, services: Overrides = {}, ids: { nodeId?: string; chainId?: string } = {}) {
  const { ctx, calls } = contextFor(type, config, services, ids);
  const reg = getHandler(type);
  if (!reg) throw new Error(`no handler registered for ${type}`);
  let thrown: Error | null = null;
  try {
    await reg.handler(ctx, msg);
  } catch (e) {
    thrown = e as Error;
  }
  return { ctx, calls, thrown, out: calls.next[0]?.msg, relation: calls.next[0]?.relations.join(',') };
}

const NODE = '33333333-3333-4333-8333-333333333333';
const CHAIN = '44444444-4444-4444-8444-444444444444';

beforeAll(() => {
  clearRegistry();
  registerActionNodes();
});

describe('registration', () => {
  it('every BUILT action node has a handler, and no later / none node has one', () => {
    const action = RULE_NODE_TYPES.filter((s) => s.group === 'action');
    expect(action.filter((s) => s.status === 'built').map((s) => s.id).sort()).toEqual([
      'tb:action:clear-alarm', 'tb:action:create-alarm', 'tb:action:delay', 'tb:action:delete-attributes', 'tb:action:device-profile',
      'tb:action:generator', 'tb:action:log', 'tb:action:math-function', 'tb:action:message-count', 'tb:action:save-attributes',
      'tb:action:save-timeseries',
    ]);
    for (const s of action) expect(!!getHandler(s.id), s.id).toBe(s.status === 'built');
    expect(getHandler('tb:action:generator')!.onInit).toBeTypeOf('function');
    expect(getHandler('tb:action:message-count')!.onInit).toBeTypeOf('function');
  });
});

// ─── shared helpers ──────────────────────────────────────────────────────────

describe('processPattern (ThingsBoard\'s TbNodeUtils)', () => {
  const msg = { metadata: { deviceName: 'F-1', n: '3' }, data: { temp: 21.5, nested: { a: { b: 'deep' } }, flag: true, nil: null, obj: { x: 1 } } };

  it('${metadata} and $[data] with dot paths; every occurrence', () => {
    expect(processPattern('${deviceName} is $[temp] (${n}/${n}) $[nested.a.b] $[flag] $[nil]', msg)).toBe('F-1 is 21.5 (3/3) deep true null');
  });

  it('a missing key, an object value or non-object data leaves the pattern as written', () => {
    expect(processPattern('${nope} $[nope] $[obj] $[nested..a]', msg)).toBe('${nope} $[nope] $[obj] $[nested..a]');
    expect(processPattern('$[0]', { metadata: {}, data: [1] })).toBe('$[0]');
  });
});

describe('roundHalfUp (BigDecimal HALF_UP on the shortest decimal text)', () => {
  it('rounds half away from zero, without binary drift', () => {
    expect(roundHalfUp(1.005, 2)).toBe(1.01);
    expect(roundHalfUp(2.5, 0)).toBe(3);
    expect(roundHalfUp(-2.5, 0)).toBe(-3);
    expect(roundHalfUp(0.125, 2)).toBe(0.13);
    expect(roundHalfUp(0.30000000000000004, 2)).toBe(0.3);
    expect(roundHalfUp(12, 3)).toBe(12);
    expect(roundHalfUp(0.0000001, 2)).toBe(0);
  });
});

describe('metadataTs', () => {
  it('metadata.ts, else the time in the message id, else now', () => {
    expect(metadataTs({ id: 'x', metadata: { ts: '1700000000123' } })).toBe(1700000000123);
    expect(metadataTs({ id: newMessageId(1_700_000_000_999), metadata: { ts: 'soon' } })).toBe(1_700_000_000_999);
    const now = Date.now();
    expect(metadataTs({ id: 'not-a-v7-id', metadata: {} })).toBeGreaterThanOrEqual(now);
  });
});

// ─── the CUSTOM expression (exp4j's grammar) ────────────────────────────────

describe('Math expressions (exp4j grammar, no script VM)', () => {
  const ev = (expr: string, vars: Record<string, number> = {}) => evaluateExpression(compileExpression(expr), vars);

  it('precedence, parentheses, % and ^ as POWER (right-associative), unary minus below ^', () => {
    expect(ev('1 + 2 * 3')).toBe(7);
    expect(ev('(1 + 2) * 3')).toBe(9);
    expect(ev('7 % 4')).toBe(3);
    expect(ev('2^3^2')).toBe(512);
    expect(ev('-2^2')).toBe(-4);
    expect(ev('2^-1')).toBe(0.5);
    expect(ev('2 * -3')).toBe(-6);
    expect(ev('1.5e2 + .5')).toBe(150.5);
  });

  it('variables, implicit multiplication, constants and exp4j\'s functions', () => {
    expect(ev('(x - 32) / 1.8', { x: 212 })).toBe(100);
    expect(ev('2x + 3(x - 1)', { x: 4 })).toBe(17);
    expect(ev('pi')).toBe(Math.PI);
    expect(ev('e')).toBe(Math.E);
    expect(ev('pow(x, 2) + sqrt(16) + log2(8) + abs(-1) + signum(-3)', { x: 3 })).toBe(9 + 4 + 3 + 1 - 1);
    expect(ev('todegree(toradian(90))')).toBeCloseTo(90, 10);
    // an argument named like a constant wins over it
    expect(ev('e * 2', { e: 5 })).toBe(10);
  });

  it('refuses division by zero, an unknown name and bad syntax', () => {
    expect(() => ev('1 / x', { x: 0 })).toThrow(/MATH_DIVISION_BY_ZERO/);
    expect(() => ev('5 % 0')).toThrow(/MATH_DIVISION_BY_ZERO/);
    expect(() => ev('x + y', { x: 1 })).toThrow(/unknown name "y"/);
    expect(() => compileExpression('(1 + 2')).toThrow(/MATH_EXPRESSION_INVALID/);
    expect(() => compileExpression('1 + * 2')).toThrow(/MATH_EXPRESSION_INVALID/);
    expect(() => compileExpression('sin(1, 2)')).toThrow(/MATH_EXPRESSION_INVALID/);
    expect(() => compileExpression('x; y')).toThrow(/MATH_EXPRESSION_INVALID/);
  });
});

// ─── Math function ───────────────────────────────────────────────────────────

describe('Math function', () => {
  const T = 'tb:action:math-function';
  const body = (key: string, name = key) => ({ name, type: 'MESSAGE_BODY', key });

  it('ADD on two message-body keys → the result key in the body (precision 2)', async () => {
    const r = await run(T, {
      operation: 'ADD', arguments: [body('a'), body('b')], result: { type: 'MESSAGE_BODY', key: 'sum', resultValuePrecision: 2 },
    }, testMessage({ a: 1.111, b: '2.222' }));
    expect(r.relation).toBe('Success');
    expect(r.out!.data).toEqual({ a: 1.111, b: '2.222', sum: 3.33 });
  });

  it('the shipped CUSTOM (x − 32) / 1.8 over a flat reading', async () => {
    const r = await run(T, {}, testMessage({ temperature: 212 }, { metadata: { ts: '5' } }));
    expect(r.out!.data).toEqual({ temperature: 212, temperatureCelsius: 100 });
  });

  it('metadata and CONSTANT arguments; precision 0 TRUNCATES toward zero, as ThingsBoard\'s (long) cast (TB-P 1)', async () => {
    const r = await run(T, {
      operation: 'MULT', arguments: [{ type: 'MESSAGE_METADATA', key: 'k' }, { type: 'CONSTANT', key: '2.5' }],
      result: { type: 'MESSAGE_METADATA', key: 'out', resultValuePrecision: 0 },
    }, testMessage({}, { metadata: { k: '3' } }));
    // 3 × 2.5 = 7.5 → 7 (ThingsBoard's integer path: `(long) value`, no rounding).
    expect(r.out!.metadata.out).toBe('7');
    const neg = await run(T, {
      operation: 'SUB', arguments: [{ type: 'CONSTANT', key: '0' }, { type: 'CONSTANT', key: '7.9' }],
      result: { type: 'MESSAGE_BODY', key: 'r', resultValuePrecision: 0 },
    }, testMessage({}));
    expect((neg.out!.data as { r: number }).r).toBe(-7);
  });

  it('an integer-result function (GET_EXP, CEIL, FLOOR) takes the integer path at ANY precision; others round HALF_UP', async () => {
    const one = async (operation: string, v: number, precision: number) => (await run(T, {
      operation, arguments: [body('v')], result: { type: 'MESSAGE_METADATA', key: 'out', resultValuePrecision: precision },
    }, testMessage({ v }))).out!.metadata.out;
    expect(await one('FLOOR', 7.9, 2)).toBe('7');            // Long.toString, never "7.0"
    expect(await one('CEIL', -7.9, 3)).toBe('-7');
    expect(await one('ABS', -2.345, 2)).toBe('2.35');         // HALF_UP at 2
  });

  it('a metadata result on the double path is Java\'s Double.toString: "5.0", "1.0E7", "1.0E-4"', async () => {
    const one = async (v: number, precision: number) => (await run(T, {
      operation: 'ABS', arguments: [body('v')], result: { type: 'MESSAGE_METADATA', key: 'out', resultValuePrecision: precision },
    }, testMessage({ v }))).out!.metadata.out;
    expect(await one(5, 2)).toBe('5.0');
    expect(await one(1234.5, 2)).toBe('1234.5');
    expect(await one(12345678.9, 1)).toBe('1.23456789E7');
    expect(await one(10_000_000, 1)).toBe('1.0E7');
    expect(await one(0.0001, 4)).toBe('1.0E-4');
    expect(await one(0.001, 3)).toBe('0.001');
  });

  it('attribute and latest-reading arguments; a missing one takes its defaultValue, else fails', async () => {
    const get = vi.fn(async () => ({ offset: '1.5' }));
    const latest = vi.fn(async () => ({}));
    const ok = await run(T, {
      operation: 'SUB',
      arguments: [{ type: 'TIME_SERIES', key: 'temp', defaultValue: 20 }, { type: 'ATTRIBUTE', key: 'offset' }],
      result: { type: 'MESSAGE_BODY', key: 'r', resultValuePrecision: 1 },
    }, testMessage({}), { attributes: { get }, telemetry: { latest } });
    expect(ok.out!.data).toEqual({ r: 18.5 });
    const bad = await run(T, {
      operation: 'ABS', arguments: [{ type: 'TIME_SERIES', key: 'temp' }], result: { type: 'MESSAGE_BODY', key: 'r' },
    }, testMessage({}), { telemetry: { latest } });
    expect(bad.thrown?.message).toMatch(/temp/);
    const noBody = await run(T, { operation: 'ABS', arguments: [body('gone')], result: { type: 'MESSAGE_BODY', key: 'r' } }, testMessage({ x: 1 }));
    expect(noBody.thrown?.message).toContain("Message body has no 'gone'");
  });

  it('an ATTRIBUTE result saves through the attribute writer (as the node), and can be added to the body', async () => {
    const save = vi.fn(async () => ['dewPoint']);
    const r = await run(T, {
      operation: 'SQRT', arguments: [body('x')],
      result: { type: 'ATTRIBUTE', key: '${k}', resultValuePrecision: 2, attributeScope: 'SHARED_SCOPE', addToBody: true },
    }, testMessage({ x: 2 }, { metadata: { k: 'dewPoint' } }), { attributes: { save } }, { nodeId: NODE, chainId: CHAIN });
    // No Attributes Updated message: TbMathNode.saveAttribute passes no notification callback.
    expect(save).toHaveBeenCalledWith('instrument-1', { dewPoint: '1.41' }, `rule_node:${CHAIN}:${NODE}`, false, 'SHARED_SCOPE', { updated: 'none' });
    expect(r.out!.data).toEqual({ x: 2, dewPoint: 1.41 });
    // Precision 0: the attribute is the TRUNCATED whole number.
    const whole = await run(T, { operation: 'DIV', arguments: [body('a'), body('b')], result: { type: 'ATTRIBUTE', key: 'q', resultValuePrecision: 0 } },
      testMessage({ a: 23, b: 3 }), { attributes: { save } });
    expect((save.mock.calls[1] as unknown[])[1]).toEqual({ q: '7' });
    expect(whole.relation).toBe('Success');
  });

  it('a TIME_SERIES result is written at the server time, and can be added to the metadata', async () => {
    const write = vi.fn(async () => undefined);
    const before = Date.now();
    const r = await run(T, {
      operation: 'MAX', arguments: [body('a'), body('b')], result: { type: 'TIME_SERIES', key: 'peak', addToMetadata: true, resultValuePrecision: 0 },
    }, testMessage({ a: 3, b: 7 }, { metadata: { rule_engine_origin: 'rest_api' } }), { telemetry: { write } }, { nodeId: NODE, chainId: CHAIN });
    const [id, readings, origin, opts] = write.mock.calls[0] as unknown as [string, { key: string; value: unknown; ts: Date }[], string, unknown];
    expect([id, origin]).toEqual(['instrument-1', `rule_node:${CHAIN}:${NODE}`]);
    // Review A I2: the message the node processed rides to the write path, for a rewrite's audit wording.
    expect(opts).toEqual({ message: { id: r.out!.id, origin: 'rest_api' } });
    expect(readings).toHaveLength(1);
    expect(readings[0]).toMatchObject({ key: 'peak', value: 7 });
    expect(readings[0].ts.getTime()).toBeGreaterThanOrEqual(before);
    expect(r.out!.metadata.peak).toBe('7');
  });

  it('a TIME_SERIES result stores the UNROUNDED result (ThingsBoard\'s DoubleDataEntry(result)); only the copies on the message are rounded', async () => {
    const write = vi.fn(async () => undefined);
    const r = await run(T, {
      operation: 'DIV', arguments: [body('a'), body('b')], result: { type: 'TIME_SERIES', key: 'ratio', resultValuePrecision: 2, addToBody: true, addToMetadata: true },
    }, testMessage({ a: 10, b: 3 }), { telemetry: { write } });
    const [, readings] = write.mock.calls[0] as unknown as [string, { key: string; value: unknown }[]];
    expect(readings[0].value).toBe(10 / 3);
    expect((r.out!.data as { ratio: number }).ratio).toBe(3.33);
    expect(r.out!.metadata.ratio).toBe('3.33');
  });

  it('Java semantics for FLOOR_DIV, FLOOR_MOD, GET_EXP, RAD, SIGNUM; a non-finite result fails', async () => {
    const one = async (operation: string, values: number[]) => (await run(T, {
      operation, arguments: values.map((_, i) => body(`v${i}`)), result: { type: 'MESSAGE_BODY', key: 'r', resultValuePrecision: 4 },
    }, testMessage(Object.fromEntries(values.map((v, i) => [`v${i}`, v]))))).out?.data as Record<string, number> | undefined;
    expect((await one('FLOOR_DIV', [-7, 2]))!.r).toBe(-4);
    expect((await one('FLOOR_MOD', [-7, 2]))!.r).toBe(1);
    expect((await one('FLOOR_DIV', [7.9, 2.9]))!.r).toBe(3);
    expect((await one('GET_EXP', [8]))!.r).toBe(3);
    expect((await one('GET_EXP', [0.3]))!.r).toBe(-2);
    expect((await one('RAD', [180]))!.r).toBe(3.1416);
    expect((await one('SIGNUM', [-0.5]))!.r).toBe(-1);
    const nan = await run(T, { operation: 'SQRT', arguments: [body('v')], result: { type: 'MESSAGE_BODY', key: 'r' } }, testMessage({ v: -1 }));
    expect(nan.thrown?.message).toMatch(/^MATH_RESULT_NOT_FINITE/);
    const div = await run(T, { operation: 'FLOOR_DIV', arguments: [body('a'), body('b')], result: { type: 'MESSAGE_BODY', key: 'r' } }, testMessage({ a: 1, b: 0 }));
    expect(div.thrown?.message).toMatch(/^MATH_DIVISION_BY_ZERO/);
  });
});

// ─── Create alarm / Clear alarm ─────────────────────────────────────────────

const alarmRow = (over: Record<string, unknown> = {}) => ({
  id: 'alarm-1', instrumentId: 'instrument-1', source: 'RULE', metric: 'CUSTOM', severity: 'CRITICAL', state: 'ACTIVE',
  limitKind: null, triggeredValue: null, clearedValue: null, raisedAt: new Date(1_000), clearedAt: null,
  acknowledgedAt: null, acknowledgedBy: null, acknowledgeReason: null,
  ruleSnapshot: { alarmType: 'General Alarm', nodeId: NODE, chainId: CHAIN, details: {} }, ...over,
});

const prismaWithOpen = (open: unknown) => {
  const findFirst = vi.fn(async () => open);
  return { findFirst, prisma: { alarm: { findFirst } } as unknown as RuleServices['prisma'] };
};

describe('Create alarm', () => {
  const T = 'tb:action:create-alarm';

  it('no open alarm: creates one (shipped config) → ALARM message, isNewAlarm, relation Created', async () => {
    const { prisma, findFirst } = prismaWithOpen(null);
    const createOrUpdate = vi.fn(async () => ({ alarm: alarmRow() as never, created: true }));
    const r = await run(T, {}, testMessage({ t: 30 }), { prisma, alarms: { createOrUpdate } }, { nodeId: NODE, chainId: CHAIN });
    expect(findFirst).toHaveBeenCalledWith({
      where: { instrumentId: 'instrument-1', source: 'RULE', state: 'ACTIVE', ruleSnapshot: { path: ['alarmType'], equals: 'General Alarm' } },
      select: { ruleSnapshot: true },
    });
    expect(createOrUpdate).toHaveBeenCalledWith({ instrumentId: 'instrument-1', alarmType: 'General Alarm', severity: 'CRITICAL', details: {}, nodeId: NODE, chainId: CHAIN });
    expect(r.relation).toBe('Created');
    expect(r.out!.type).toBe('ALARM');
    expect(r.out!.metadata.isNewAlarm).toBe('true');
    expect(r.out!.metadata).not.toHaveProperty('isExistingAlarm');
    expect(r.out!.data).toMatchObject({ id: 'alarm-1', type: 'General Alarm', status: 'ACTIVE_UNACK', originator: { entityType: 'INSTRUMENT', id: 'instrument-1' } });
  });

  it('an open alarm: its details reach the script as metadata.prevAlarmDetails → Updated, isExistingAlarm', async () => {
    const { prisma } = prismaWithOpen({ ruleSnapshot: { alarmType: 'Hot', details: { count: 1 } } });
    const createOrUpdate = vi.fn(async () => ({ alarm: alarmRow() as never, created: false }));
    const r = await run(T, {
      alarmType: 'Hot',
      alarmDetailsBuildJs: 'var d = JSON.parse(metadata.prevAlarmDetails || "{}"); d.count = (d.count || 0) + 1; d.t = msg.t; return d;',
    }, testMessage({ t: 31 }), { prisma, alarms: { createOrUpdate } });
    expect(createOrUpdate.mock.calls[0][0]).toMatchObject({ alarmType: 'Hot', details: { count: 2, t: 31 } });
    expect(r.relation).toBe('Updated');
    expect(r.out!.metadata.isExistingAlarm).toBe('true');
    // The outgoing metadata is the INCOMING metadata plus the flag — never prevAlarmDetails.
    expect(r.out!.metadata).not.toHaveProperty('prevAlarmDetails');
  });

  it('ruling AL-3: a repeat that changes nothing is still Updated — ALARM, the alarm JSON, isExistingAlarm (ThingsBoard\'s updateAlarm sets endTs = now, so every repeat is modified)', async () => {
    const { prisma } = prismaWithOpen({ ruleSnapshot: { alarmType: 'Hot', details: { count: 1 } } });
    const createOrUpdate = vi.fn(async () => ({ alarm: alarmRow() as never, created: false, unchanged: true as const }));
    const msg = testMessage({ t: 31 });
    const r = await run(T, { alarmType: 'Hot' }, msg, { prisma, alarms: { createOrUpdate } });
    expect(r.calls.relations()).toEqual(['Updated']);
    expect(r.out!.type).toBe('ALARM');
    expect(r.out!.data).toMatchObject({ id: 'alarm-1' });
    expect(r.out!.metadata.isExistingAlarm).toBe('true');
  });

  it('the type is a pattern; a dynamic severity is a pattern that must name a severity', async () => {
    const { prisma } = prismaWithOpen(null);
    const createOrUpdate = vi.fn(async () => ({ alarm: alarmRow() as never, created: true }));
    await run(T, { alarmType: '${instrumentCode} high', dynamicSeverity: true, severity: '${sev}' },
      testMessage({}, { metadata: { sev: ' major ' } }), { prisma, alarms: { createOrUpdate } });
    expect(createOrUpdate.mock.calls[0][0]).toMatchObject({ alarmType: 'TEST-001 high', severity: 'MAJOR' });
    await run(T, { dynamicSeverity: true, severity: '$[s]' }, testMessage({ s: 'warning' }), { prisma, alarms: { createOrUpdate } });
    expect(createOrUpdate.mock.calls[1][0]).toMatchObject({ severity: 'WARNING' });
    const bad = await run(T, { dynamicSeverity: true, severity: '${sev}' }, testMessage({}, { metadata: { sev: 'loud' } }), { prisma, alarms: { createOrUpdate } });
    expect(bad.thrown?.message).toMatch(/^ALARM_SEVERITY_INVALID: "loud"/);
    expect(createOrUpdate).toHaveBeenCalledTimes(2);
  });

  it('useMessageAlarmData: type, severity and details from the message alarm; overwriteAlarmDetails runs the script', async () => {
    const { prisma } = prismaWithOpen(null);
    const createOrUpdate = vi.fn(async () => ({ alarm: alarmRow() as never, created: true }));
    const alarmMsg = newMessage('ALARM', { type: 'ALARM', id: 'a-9' },
      { type: 'Door', severity: 'MAJOR', details: { door: 'A' }, originator: { entityType: 'INSTRUMENT', id: 'inst-9' } });
    await run(T, { useMessageAlarmData: true }, alarmMsg, { prisma, alarms: { createOrUpdate } });
    expect(createOrUpdate.mock.calls[0][0]).toMatchObject({ instrumentId: 'inst-9', alarmType: 'Door', severity: 'MAJOR', details: { door: 'A' } });
    // TB-P 8: on CREATE ThingsBoard builds the details with NO previous alarm (buildAlarmDetails(msg, null)) —
    // the message alarm's own details are not handed to the script as prevAlarmDetails.
    const script = 'return { prev: metadata.prevAlarmDetails === undefined ? "none" : JSON.parse(metadata.prevAlarmDetails) };';
    await run(T, { useMessageAlarmData: true, overwriteAlarmDetails: true, alarmDetailsBuildJs: script }, alarmMsg, { prisma, alarms: { createOrUpdate } });
    expect(createOrUpdate.mock.calls[1][0]).toMatchObject({ details: { prev: 'none' } });
    // On UPDATE the open alarm's details are (updateAlarm passes existingAlarm.getDetails()).
    await run(T, { useMessageAlarmData: true, overwriteAlarmDetails: true, alarmDetailsBuildJs: script }, alarmMsg,
      { prisma: prismaWithOpen({ ruleSnapshot: { alarmType: 'Door', details: { open: 1 } } }).prisma, alarms: { createOrUpdate } });
    expect(createOrUpdate.mock.calls[2][0]).toMatchObject({ details: { prev: { open: 1 } } });
    const noType = await run(T, { useMessageAlarmData: true }, testMessage({ severity: 'MAJOR' }), { prisma, alarms: { createOrUpdate } });
    expect(noType.thrown?.message).toMatch(/^ALARM_DATA_INVALID/);
  });

  it('on create, an incoming metadata.prevAlarmDetails reaches the script as it came (ThingsBoard hands the message over unchanged)', async () => {
    const { prisma } = prismaWithOpen(null);
    const createOrUpdate = vi.fn(async () => ({ alarm: alarmRow() as never, created: true }));
    await run(T, { alarmDetailsBuildJs: 'return { seen: metadata.prevAlarmDetails };' },
      testMessage({}, { metadata: { prevAlarmDetails: '{"upstream":1}' } }), { prisma, alarms: { createOrUpdate } });
    expect(createOrUpdate.mock.calls[0][0]).toMatchObject({ details: { seen: '{"upstream":1}' } });
  });

  it('a non-instrument originator and a blank type fail; a TBEL-stored node runs its TBEL script AS JAVASCRIPT (ruling TB-L), a blank one its JavaScript', async () => {
    const sys = await run(T, {}, newMessage('X', { type: 'SYSTEM', id: 'SYSTEM' }, {}));
    expect(sys.thrown?.message).toMatch(/^ORIGINATOR_NOT_INSTRUMENT/);
    const { prisma } = prismaWithOpen(null);
    const blank = await run(T, { alarmType: '${nothing}' }, testMessage({}, { metadata: { nothing: '  ' } }), { prisma });
    expect(blank.thrown?.message).toMatch(/^ALARM_TYPE_REQUIRED/);
    const createOrUpdate = vi.fn(async () => ({ alarm: alarmRow() as never, created: true }));
    const scripts = { alarmDetailsBuildJs: "return { ran: 'js' };" };
    const tbel = await run(T, { ...scripts, scriptLang: 'TBEL', alarmDetailsBuildTbel: "return { ran: 'tbel' };" }, testMessage({}), { prisma, alarms: { createOrUpdate } });
    expect(tbel.thrown).toBeNull();
    expect(createOrUpdate.mock.calls[0][0]).toMatchObject({ details: { ran: 'tbel' } });
    await run(T, { ...scripts, scriptLang: 'TBEL', alarmDetailsBuildTbel: '  ' }, testMessage({}), { prisma, alarms: { createOrUpdate } });
    expect(createOrUpdate.mock.calls[1][0]).toMatchObject({ details: { ran: 'js' } });
  });
});

describe('Clear alarm', () => {
  const T = 'tb:action:clear-alarm';

  it('an open alarm of the type: cleared (details from the script) → ALARM message, isClearedAlarm, relation Cleared', async () => {
    const { prisma } = prismaWithOpen({ ruleSnapshot: { alarmType: 'Hot', details: { count: 4 } } });
    // What services.alarms.clear hands back: the raise details kept, the clear script's beside them.
    const clear = vi.fn(async () => alarmRow({
      state: 'CLEARED', clearedAt: new Date(2_000),
      ruleSnapshot: { alarmType: 'Hot', nodeId: NODE, chainId: CHAIN, details: { count: 4 }, clearDetails: { was: 4 } },
    }) as never);
    const r = await run(T, { alarmType: 'Hot', alarmDetailsBuildJs: 'return { was: JSON.parse(metadata.prevAlarmDetails).count };' },
      testMessage({}), { prisma, alarms: { clear } }, { nodeId: NODE, chainId: CHAIN });
    expect(clear).toHaveBeenCalledWith('instrument-1', 'Hot', { was: 4 }, `rule_node:${CHAIN}:${NODE}`);
    expect(r.relation).toBe('Cleared');
    expect(r.out!.type).toBe('ALARM');
    expect(r.out!.metadata.isClearedAlarm).toBe('true');
    // TB-P 2: ThingsBoard's clear_alarm REPLACES the alarm's details with the clear script's —
    // the Cleared message carries those, not the details from before the clear.
    expect(r.out!.data).toMatchObject({ cleared: true, status: 'CLEARED_UNACK', details: { was: 4 } });
  });

  it('alarmMessageData — ONE rule for the Cleared message and the ALARM_CLEAR emit: a RULE alarm\'s clearDetails win once it has them', () => {
    const raised = alarmRow({ ruleSnapshot: { alarmType: 'Hot', details: { t: 31 } } });
    expect(alarmMessageData(raised as never).details).toEqual({ t: 31 });
    const cleared = alarmRow({ state: 'CLEARED', ruleSnapshot: { alarmType: 'Hot', details: { t: 31 }, clearDetails: { closedAt: 19 } } });
    expect(alarmMessageData(cleared as never).details).toEqual({ closedAt: 19 });
    // A clear script that returned nothing stored {} — that IS the alarm's details now.
    expect(alarmMessageData(alarmRow({ state: 'CLEARED', ruleSnapshot: { alarmType: 'Hot', details: { t: 1 }, clearDetails: {} } }) as never).details).toEqual({});
    // The evaluator's alarms keep their whole snapshot as details.
    expect(alarmMessageData(alarmRow({ source: 'INSTRUMENT_LIMIT', ruleSnapshot: { limit: 30, clearDetails: 'x' } }) as never).details)
      .toEqual({ limit: 30, clearDetails: 'x' });
  });

  it('nothing open → False, nothing cleared; a lost race (clear returns null) → False', async () => {
    const clear = vi.fn(async () => null);
    const none = await run(T, { alarmType: 'Hot' }, testMessage({}), { prisma: prismaWithOpen(null).prisma, alarms: { clear } });
    expect(none.relation).toBe('False');
    expect(clear).not.toHaveBeenCalled();
    const raced = await run(T, { alarmType: 'Hot' }, testMessage({}), { prisma: prismaWithOpen({ ruleSnapshot: { details: {} } }).prisma, alarms: { clear } });
    expect(raced.relation).toBe('False');
  });

  it('an ALARM originator: that alarm, by id — a RULE alarm is cleared under its own type; any other source is False', async () => {
    const clear = vi.fn(async () => alarmRow({ state: 'CLEARED' }) as never);
    const byId = vi.fn(async (id: string) => (id === 'rule-1'
      ? alarmRow({ id: 'rule-1', ruleSnapshot: { alarmType: 'Door', details: { d: 1 } } })
      : alarmRow({ id, source: 'INSTRUMENT_LIMIT', ruleSnapshot: {} })) as never);
    const msgOf = (id: string) => newMessage('ALARM', { type: 'ALARM', id }, {}, { instrumentId: 'instrument-1' });
    const r = await run(T, { alarmType: 'ignored' }, msgOf('rule-1'), { alarms: { clear, byId } });
    expect(clear.mock.calls[0].slice(0, 2)).toEqual(['instrument-1', 'Door']);
    expect(r.relation).toBe('Cleared');
    const other = await run(T, { alarmType: 'x' }, msgOf('limit-1'), { alarms: { clear, byId } });
    expect(other.relation).toBe('False');
    expect(clear).toHaveBeenCalledTimes(1);
  });
});

// ─── Delay ───────────────────────────────────────────────────────────────────

describe('Delay (durable)', () => {
  const T = 'tb:action:delay';
  const pending = (n: number) => ({ $queryRaw: vi.fn(async () => [{ n }]) }) as unknown as RuleServices['prisma'];

  it('hands the message to the durable queue at now + period, resuming AFTER this node; nothing goes out now', async () => {
    const enqueue = vi.fn(async () => undefined);
    const msg = testMessage({ a: 1 });
    const before = Date.now();
    const r = await run(T, { periodInSeconds: 90 }, msg, { durable: { enqueue }, prisma: pending(0) }, { nodeId: NODE, chainId: CHAIN });
    expect(r.thrown).toBeNull();
    expect(r.calls.next).toHaveLength(0);
    const [m, chainId, nodeId, runAt] = enqueue.mock.calls[0] as unknown as [RuleMessage, string, string, Date];
    expect([m, chainId, nodeId]).toEqual([msg, CHAIN, NODE]);
    expect(runAt.getTime() - before).toBeGreaterThanOrEqual(90_000);
    expect(runAt.getTime() - Date.now()).toBeLessThanOrEqual(90_000);
  });

  it('the period from a metadata pattern; a pattern that is not a whole number of seconds fails', async () => {
    const enqueue = vi.fn(async () => undefined);
    await run(T, { useMetadataPeriodInSecondsPatterns: true, periodInSecondsPattern: '${wait}' }, testMessage({}, { metadata: { wait: '5' } }),
      { durable: { enqueue }, prisma: pending(0) });
    expect((enqueue.mock.calls[0] as unknown as [unknown, unknown, unknown, Date])[3].getTime() - Date.now()).toBeGreaterThan(4_000);
    const bad = await run(T, { useMetadataPeriodInSecondsPatterns: true, periodInSecondsPattern: '${wait}' }, testMessage({}), { durable: { enqueue }, prisma: pending(0) });
    expect(bad.thrown?.message).toMatch(/^DELAY_PERIOD_INVALID/);
  });

  it('at maxPendingMsgs messages already waiting at this node, the next one fails (ThingsBoard\'s wording)', async () => {
    const enqueue = vi.fn(async () => undefined);
    const r = await run(T, { maxPendingMsgs: 3 }, testMessage({}), { durable: { enqueue }, prisma: pending(3) });
    expect(r.thrown?.message).toBe('Max limit of pending messages reached!');
    expect(enqueue).not.toHaveBeenCalled();
  });
});

// ─── Attributes ──────────────────────────────────────────────────────────────

describe('Save attributes', () => {
  const T = 'tb:action:save-attributes';
  const attrs = (data: unknown, opts: Parameters<typeof testMessage>[1] = {}) => testMessage(data, { type: 'POST_ATTRIBUTES_REQUEST', ...opts });

  it('saves the data as text through the attribute writer, as this node; the message passes on', async () => {
    const save = vi.fn(async () => ['fw']);
    const msg = attrs({ fw: '1.2', n: 5, b: true, o: { k: 1 } });
    const r = await run(T, { notifyDevice: true }, msg, { attributes: { save } }, { nodeId: NODE, chainId: CHAIN });
    expect(save).toHaveBeenCalledWith('instrument-1', { fw: '1.2', n: '5', b: 'true', o: '{"k":1}' }, `rule_node:${CHAIN}:${NODE}`, true, 'SERVER_SCOPE', { updated: 'none' });
    expect(r.relation).toBe('Success');
    expect(r.out).toBe(msg);
  });

  it('TB-P 7: the Attributes Updated message follows the node\'s two toggles, as in ThingsBoard', async () => {
    const save = vi.fn(async () => ['a']);
    const updatedOf = async (config: Record<string, unknown>, metadata: Record<string, unknown> = {}) => {
      save.mockClear();
      await run(T, config, attrs({ a: '1' }, { metadata: { rule_engine_origin: 'rest_api', ...metadata } }), { attributes: { save } });
      return ((save.mock.calls[0] as unknown[])[5] as { updated: string }).updated;
    };
    // sendAttributesUpdatedNotification off (ThingsBoard's default): none.
    expect(await updatedOf({})).toBe('none');
    // On: the changed keys; with updateAttributesOnlyOnValueChange OFF, every key of the message.
    expect(await updatedOf({ sendAttributesUpdatedNotification: true })).toBe('changed');
    expect(await updatedOf({ sendAttributesUpdatedNotification: true, updateAttributesOnlyOnValueChange: false })).toBe('all');
    // Never for the client scope — the node's, or the one the message names (checkSendNotification).
    expect(await updatedOf({ sendAttributesUpdatedNotification: true, scope: 'CLIENT_SCOPE' })).toBe('none');
    expect(await updatedOf({ sendAttributesUpdatedNotification: true }, { scope: 'CLIENT_SCOPE' })).toBe('none');
    expect(await updatedOf({ sendAttributesUpdatedNotification: true, scope: 'CLIENT_SCOPE' }, { scope: 'SHARED_SCOPE' })).toBe('changed');
  });

  it('the message\'s own metadata.scope wins over the node\'s', async () => {
    const save = vi.fn(async () => []);
    await run(T, { scope: 'SHARED_SCOPE' }, attrs({ a: 'b' }, { metadata: { scope: 'CLIENT_SCOPE', rule_engine_origin: 'rest_api' } }), { attributes: { save } });
    expect((save.mock.calls[0] as unknown[])[4]).toBe('CLIENT_SCOPE');
  });

  it('S-3: a message ingest already stored is NOT written again while the skip is ON — and is when it is OFF', async () => {
    const save = vi.fn(async () => []);
    const ingest = attrs({ a: 'b' }, { metadata: { rule_engine_origin: 'ingest' } });
    const skipped = await run(T, {}, ingest, { attributes: { save } });
    expect(save).not.toHaveBeenCalled();
    expect(skipped.relation).toBe('Success');
    const { ctx, calls } = fakeContext({ type: T, services: { attributes: { save }, config: () => ({ ...ctx0(), skipSaveNodesForIngestOrigin: false }) } });
    await getHandler(T)!.handler(ctx, ingest);
    expect(save).toHaveBeenCalledTimes(1);
    expect(calls.relations()).toEqual(['Success']);
  });

  it('another message type, a null value, a non-object body and a non-instrument originator fail', async () => {
    const save = vi.fn(async () => []);
    expect((await run(T, {}, testMessage({ a: 1 }), { attributes: { save } })).thrown?.message).toBe('Unsupported msg type: POST_TELEMETRY_REQUEST');
    expect((await run(T, {}, attrs({ a: null }), { attributes: { save } })).thrown?.message).toMatch(/null/);
    expect((await run(T, {}, attrs([1]), { attributes: { save } })).thrown?.message).toMatch(/^DATA_NOT_OBJECT/);
    expect((await run(T, {}, newMessage('POST_ATTRIBUTES_REQUEST', { type: 'SYSTEM', id: 'SYSTEM' }, { a: 'b' }), { attributes: { save } })).thrown?.message)
      .toMatch(/^ORIGINATOR_NOT_INSTRUMENT/);
    expect(save).not.toHaveBeenCalled();
  });
});

describe('Delete attributes', () => {
  const T = 'tb:action:delete-attributes';

  it('deletes the keys (patterns allowed) through the attribute writer, as this node; the message passes on', async () => {
    const del = vi.fn(async () => ['fw']);
    const msg = testMessage({ k: 'Location' }, { metadata: { which: 'fw' } });
    const r = await run(T, { keys: ['${which}', '$[k]', ' '], scope: 'SHARED_SCOPE' }, msg, { attributes: { delete: del } }, { nodeId: NODE, chainId: CHAIN });
    // ThingsBoard's defaults (TbMsgDeleteAttributesNodeConfiguration): no Attributes Deleted message, the device not told.
    expect(del).toHaveBeenCalledWith('instrument-1', ['fw', 'Location'], `rule_node:${CHAIN}:${NODE}`, 'SHARED_SCOPE', { sendDeleted: false, notifyDevice: false });
    expect(r.relation).toBe('Success');
    expect(r.out).toBe(msg);
  });

  it('P-10: the two toggles are honoured as ThingsBoard honours them — the message by its toggle; the device by its toggle OR metadata.notifyDevice (Boolean.parseBoolean)', async () => {
    const del = vi.fn(async () => ['fw']);
    const optsOf = async (config: Record<string, unknown>, metadata: Record<string, unknown> = {}) => {
      del.mockClear();
      await run(T, { keys: ['fw'], ...config }, testMessage({}, { metadata }), { attributes: { delete: del } });
      return (del.mock.calls[0] as unknown[])[4];
    };
    expect(await optsOf({ sendAttributesDeletedNotification: true })).toEqual({ sendDeleted: true, notifyDevice: false });
    expect(await optsOf({ notifyDevice: true })).toEqual({ sendDeleted: false, notifyDevice: true });
    expect(await optsOf({}, { notifyDevice: 'TRUE' })).toEqual({ sendDeleted: false, notifyDevice: true });
    for (const v of ['yes', '1', '', 'false', ' true']) expect(await optsOf({}, { notifyDevice: v }), v).toEqual({ sendDeleted: false, notifyDevice: false });
  });

  it('no keys: nothing deleted, the message passes on', async () => {
    const del = vi.fn(async () => []);
    const r = await run(T, {}, testMessage({}), { attributes: { delete: del } });
    expect(del).not.toHaveBeenCalled();
    expect(r.relation).toBe('Success');
  });
});

// ─── Save time series ────────────────────────────────────────────────────────

const ctx0 = () => ({
  enabled: true, skipSaveNodesForIngestOrigin: true, scriptTimeoutMs: 2_000, queueCapacity: 10_000, concurrency: 8,
  debugRetentionHours: 24, debugMaxEventsPerNode: 1_000, httpTimeoutMs: 10_000, hopLimit: 200,
});

describe('Save time series', () => {
  const T = 'tb:action:save-timeseries';
  const skipOff = () => ({ ...ctx0(), skipSaveNodesForIngestOrigin: false });

  it('a flat body at metadata.ts; a { ts, values } body at its ts; an array of them', async () => {
    const write = vi.fn(async () => undefined);
    const flat = testMessage({ t: 1, h: 'x' }, { metadata: { ts: '1000', rule_engine_origin: 'rest_api' } });
    await run(T, {}, flat, { telemetry: { write } }, { nodeId: NODE, chainId: CHAIN });
    // Review A I2: the message id and its origin ride along — a rewrite is audited as the rule engine naming them.
    expect(write.mock.calls[0]).toEqual(['instrument-1', [{ key: 't', value: 1, ts: new Date(1000) }, { key: 'h', value: 'x', ts: new Date(1000) }],
      `rule_node:${CHAIN}:${NODE}`, { skipLatest: false, message: { id: flat.id, origin: 'rest_api' } }]);
    await run(T, {}, testMessage({ ts: 2000, values: { t: 2 } }), { telemetry: { write } });
    expect((write.mock.calls[1] as unknown[])[1]).toEqual([{ key: 't', value: 2, ts: new Date(2000) }]);
    await run(T, {}, testMessage([{ ts: 3000, values: { t: 3 } }, { ts: 4000, values: { t: 4 } }]), { telemetry: { write } });
    expect((write.mock.calls[2] as unknown[])[1]).toEqual([{ key: 't', value: 3, ts: new Date(3000) }, { key: 't', value: 4, ts: new Date(4000) }]);
  });

  it('skipLatestPersistence reaches the write path as { skipLatest: true } (history only)', async () => {
    const write = vi.fn(async () => undefined);
    await run(T, { skipLatestPersistence: true }, testMessage({ t: 1 }, { metadata: { ts: '1000' } }), { telemetry: { write } });
    expect((write.mock.calls[0] as unknown[])[3]).toMatchObject({ skipLatest: true });
  });

  it('useServerTs stamps a flat body with now; a body\'s own ts is kept', async () => {
    const write = vi.fn(async () => undefined);
    const before = Date.now();
    await run(T, { useServerTs: true }, testMessage({ t: 1 }, { metadata: { ts: '1000' } }), { telemetry: { write } });
    expect(((write.mock.calls[0] as unknown[])[1] as { ts: Date }[])[0].ts.getTime()).toBeGreaterThanOrEqual(before);
    await run(T, { useServerTs: true }, testMessage({ ts: 2000, values: { t: 2 } }), { telemetry: { write } });
    expect(((write.mock.calls[1] as unknown[])[1] as { ts: Date }[])[0].ts).toEqual(new Date(2000));
  });

  it('S-3: an ingest-origin message is not written while the skip is ON (it passes on Success) — and is when OFF', async () => {
    const write = vi.fn(async () => undefined);
    const ingest = testMessage({ ts: 1, values: { t: 1 } }, { metadata: { rule_engine_origin: 'ingest' } });
    const skipped = await run(T, {}, ingest, { telemetry: { write } });
    expect(write).not.toHaveBeenCalled();
    expect(skipped.relation).toBe('Success');
    const written = await run(T, {}, ingest, { telemetry: { write }, config: skipOff });
    expect(write).toHaveBeenCalledTimes(1);
    expect(written.relation).toBe('Success');
    // A message from anywhere else is written whatever the switch says.
    await run(T, {}, testMessage({ t: 5 }, { metadata: { rule_engine_origin: 'rest_api' } }), { telemetry: { write } });
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('another type, a null value, a body that is not telemetry and a non-instrument originator fail — the null / body with ThingsBoard\'s JsonConverter wording', async () => {
    const write = vi.fn(async () => undefined);
    const failed = async (msg: RuleMessage) => (await run(T, {}, msg, { telemetry: { write } })).thrown?.message;
    expect(await failed(testMessage({ t: 1 }, { type: 'POST_ATTRIBUTES_REQUEST' }))).toBe('Unsupported msg type: POST_ATTRIBUTES_REQUEST');
    // parseObject wraps the error with the WHOLE object it was reading (per array element), not the value.
    expect(await failed(testMessage({ t: null }))).toBe('Can\'t parse value: {"t":null}');
    expect(await failed(testMessage({ h: 40, t: null }))).toBe('Can\'t parse value: {"h":40,"t":null}');
    expect(await failed(testMessage({ ts: 1000, values: { t: null } }))).toBe('Can\'t parse value: {"ts":1000,"values":{"t":null}}');
    expect(await failed(testMessage([{ t: 1 }, { u: null }]))).toBe('Can\'t parse value: {"u":null}');
    expect(await failed(testMessage('21.5'))).toBe('Can\'t parse value: "21.5"');
    expect(await failed(testMessage([{ t: 1 }, 7]))).toBe('Can\'t parse value: 7');
    expect(await failed(newMessage('POST_TELEMETRY_REQUEST', { type: 'SYSTEM', id: 'SYSTEM' }, { t: 1 }))).toMatch(/^ORIGINATOR_NOT_INSTRUMENT/);
    expect(write).not.toHaveBeenCalled();
  });

  it('M-2: an object with BOTH ts and values is the timed shape whatever their types — a whole-number STRING ts is an instant (Gson getAsLong); anything else fails, never junk readings named ts / values', async () => {
    const write = vi.fn(async () => undefined);
    const readings = async (data: unknown) => {
      write.mockClear();
      const r = await run(T, {}, testMessage(data, { metadata: { ts: '5' } }), { telemetry: { write } });
      return r.thrown ? r.thrown.message : (write.mock.calls[0] as unknown[])[1];
    };
    expect(await readings({ ts: '1699999999999', values: { t: 1 } })).toEqual([{ key: 't', value: 1, ts: new Date(1699999999999) }]);
    expect(await readings({ ts: '+1699999999999', values: { t: 1 } })).toEqual([{ key: 't', value: 1, ts: new Date(1699999999999) }]);
    // A JSON number with a fraction: Java's longValue(), toward zero.
    expect(await readings({ ts: 1699999999999.9, values: { t: 1 } })).toEqual([{ key: 't', value: 1, ts: new Date(1699999999999) }]);
    // Long.parseLong refuses a space, a fraction, an exponent, a blank; Gson refuses a boolean, null, an array, an object.
    for (const ts of [' 1699999999999', '1699999999999.0', '1.7e12', '', 'soon', true, null, [1], { at: 1 }, '9223372036854775808']) {
      expect(await readings({ ts, values: { t: 1 } }), JSON.stringify(ts)).toBe(`Can't parse value: ${JSON.stringify({ ts, values: { t: 1 } })}`);
    }
    // `values` must be an object.
    expect(await readings({ ts: 1000, values: 5 })).toBe('Can\'t parse value: {"ts":1000,"values":5}');
    // The reader itself is Gson's getAsLong: a whole long (toward zero), never a fraction.
    expect([telemetryTsOf(1699999999999.9), telemetryTsOf(-2.7), telemetryTsOf('-12'), telemetryTsOf('12x')]).toEqual([1699999999999, -2, -12, null]);
    // Only BOTH keys make the timed shape: `ts` alone is an ordinary reading at metadata.ts.
    expect(await readings({ ts: 'soon', t: 1 })).toEqual([{ key: 'ts', value: 'soon', ts: new Date(5) }, { key: 't', value: 1, ts: new Date(5) }]);
  });

  it('TB-P 3: an EMPTY body fails with ThingsBoard\'s wording, "Msg body is empty: " + the data', async () => {
    const write = vi.fn(async () => undefined);
    const empty = async (data: unknown) => (await run(T, {}, testMessage(data), { telemetry: { write } })).thrown?.message;
    expect(await empty({})).toBe('Msg body is empty: {}');
    expect(await empty([])).toBe('Msg body is empty: []');
    expect(await empty({ ts: 1000, values: {} })).toBe('Msg body is empty: {"ts":1000,"values":{}}');
    expect(await empty([{}])).toBe('Msg body is empty: [{}]');
    expect(write).not.toHaveBeenCalled();
    // An ingest-origin message under the S-3 skip is not parsed at all (it passes, as ThingsBoard's short-circuit does).
    expect((await run(T, {}, testMessage({}, { metadata: { rule_engine_origin: 'ingest' } }), { telemetry: { write } })).relation).toBe('Success');
  });
});

// ─── Log ─────────────────────────────────────────────────────────────────────

describe('Log', () => {
  const T = 'tb:action:log';

  it('logs the script\'s string at info and passes the message on unchanged', async () => {
    const msg = testMessage({ t: 1 });
    const r = await run(T, { jsScript: "return 'temp is ' + msg.t + ' on ' + metadata.instrumentCode;" }, msg);
    expect(r.calls.logs).toEqual([{ level: 'info', text: 'temp is 1 on TEST-001' }]);
    expect(r.relation).toBe('Success');
    expect(r.out).toBe(msg);
  });

  it('a non-string result is logged as JSON; a throwing script fails; a TBEL-stored node runs its TBEL script as JavaScript (ruling TB-L)', async () => {
    const r = await run(T, { jsScript: 'return { a: msg.t };' }, testMessage({ t: 2 }));
    expect(r.calls.logs[0].text).toBe('{"a":2}');
    expect((await run(T, { jsScript: "throw new Error('nope');" }, testMessage({}))).thrown?.message).toContain('nope');
    const tbel = await run(T, { scriptLang: 'TBEL', jsScript: "return 'js';", tbelScript: "return 'tbel ' + msg.t;" }, testMessage({ t: 3 }));
    expect(tbel.thrown).toBeNull();
    expect(tbel.calls.logs).toEqual([{ level: 'info', text: 'tbel 3' }]);
    expect((await run(T, { scriptLang: 'TBEL', jsScript: "return 'js';", tbelScript: '' }, testMessage({}))).calls.logs).toEqual([{ level: 'info', text: 'js' }]);
  });
});

// ─── Device profile ──────────────────────────────────────────────────────────

describe('Device profile (ruling DP-1: routes as ThingsBoard\'s TbDeviceProfileNode)', () => {
  const T = 'tb:action:device-profile';
  /** The message `emitAlarm` really builds — the contract between the emit path and this node. */
  async function emitted(kind: 'ALARM' | 'ALARM_CLEAR' | 'ALARM_ACK', flags: Parameters<typeof emitAlarm>[2] = {}): Promise<RuleMessage> {
    const queued: RuleMessage[] = [];
    setRuleEngineSink({ accepting: () => true, enqueue: (m) => { queued.push(m); return true; }, reEnterAllowed: async () => true });
    try {
      await emitAlarm(kind, {
        id: 'al-9', instrumentId: 'instrument-1', source: 'INSTRUMENT_LIMIT', metric: 'TEMPERATURE', limitKind: 'HIGH', severity: 'MAJOR',
        state: kind === 'ALARM_CLEAR' ? 'CLEARED' : 'ACTIVE', triggeredValue: 30, raisedAt: new Date(5_000),
        ...(kind === 'ALARM_ACK' ? { acknowledgedAt: new Date(6_000), acknowledgedBy: 'qa1' } : {}),
      }, { instrumentCode: 'TEST-001', ...flags });
    } finally {
      setRuleEngineSink(null);
    }
    expect(queued).toHaveLength(1);
    return queued[0];
  }

  it('the catalogue carries ThingsBoard\'s six relations, the four alarm labels among them', () => {
    expect(RULE_NODE_TYPES.find((s) => s.id === T)?.relations).toEqual(['Alarm Created', 'Alarm Updated', 'Alarm Severity Updated', 'Alarm Cleared', 'Success', 'Failure']);
  });

  it('the EVALUATOR\'s raise (origin system, isNewAlarm) leaves on "Alarm Created" ONLY, unchanged', async () => {
    const msg = await emitted('ALARM', { isNewAlarm: true });
    const r = await run(T, {}, msg);
    expect(r.calls.relations()).toEqual(['Alarm Created']);
    expect(r.out).toBe(msg);
  });

  it('the EVALUATOR\'s clear leaves on "Alarm Cleared" ONLY — as type ALARM, as ThingsBoard\'s AlarmState sends all four', async () => {
    const msg = await emitted('ALARM_CLEAR', { isClearedAlarm: true });
    const r = await run(T, {}, msg);
    expect(r.calls.relations()).toEqual(['Alarm Cleared']);
    expect(r.out).toMatchObject({ id: msg.id, type: 'ALARM', originator: msg.originator, metadata: msg.metadata, data: msg.data });
    expect(r.out!.metadata.isClearedAlarm).toBe('true');
  });

  it('ThingsBoard\'s flag order for the two acts the evaluator never does: isSeverityUpdated before isExistingAlarm', async () => {
    const base = await emitted('ALARM', {});
    const sys = (metadata: Record<string, string>) => ({ ...base, metadata: { ...base.metadata, ...metadata } });
    expect((await run(T, {}, sys({ isExistingAlarm: 'true', isSeverityUpdated: 'true' }))).calls.relations()).toEqual(['Alarm Severity Updated']);
    expect((await run(T, {}, sys({ isExistingAlarm: 'true' }))).calls.relations()).toEqual(['Alarm Updated']);
    // An ALARM with no true flag (or a "false" one) is not a profile alarm.
    expect((await run(T, {}, sys({}))).calls.relations()).toEqual(['Success']);
    expect((await run(T, {}, sys({ isNewAlarm: 'false' }))).calls.relations()).toEqual(['Success']);
  });

  it('everything else on Success, unchanged: the acknowledge (origin user), a RULE NODE\'s alarm action messages (AL-2), telemetry, activity events', async () => {
    const node = 'rule_node:44444444-4444-4444-8444-444444444444:33333333-3333-4333-8333-333333333333';
    /** What a rule node's createOrUpdate / clear really sends to the root (ruling AL-2). */
    const fromRuleNode = async (kind: 'ENTITY_CREATED' | 'ENTITY_UPDATED' | 'ALARM_CLEAR'): Promise<RuleMessage> => {
      const queued: RuleMessage[] = [];
      setRuleEngineSink({ accepting: () => true, enqueue: (m) => { queued.push(m); return true; }, reEnterAllowed: async () => true });
      try {
        await emitRuleNodeAlarm(kind, { id: 'al-r', instrumentId: 'instrument-1', source: 'RULE', metric: 'CUSTOM', severity: 'MINOR', state: kind === 'ALARM_CLEAR' ? 'CLEARED' : 'ACTIVE', raisedAt: new Date(5_000) },
          { ruleNodeId: '33333333-3333-4333-8333-333333333333', origin: node });
      } finally {
        setRuleEngineSink(null);
      }
      return queued[0];
    };
    const others = [
      await emitted('ALARM_ACK', { origin: 'user', acknowledgedBy: 'qa1' }),
      await fromRuleNode('ENTITY_CREATED'),
      await fromRuleNode('ENTITY_UPDATED'),
      await fromRuleNode('ALARM_CLEAR'),
      testMessage({ t: 1 }, { metadata: { rule_engine_origin: 'ingest' } }),
      testMessage({}, { type: 'POST_ATTRIBUTES_REQUEST' }),
      testMessage({ lastActivityTime: 1 }, { type: 'INACTIVITY_EVENT', metadata: { rule_engine_origin: 'system' } }),
      testMessage({ lastActivityTime: 1 }, { type: 'ACTIVITY_EVENT', metadata: { rule_engine_origin: 'system' } }),
      // A system alarm whose originator is not an instrument: ThingsBoard sends a non-device originator on Success.
      newMessage('ALARM', { type: 'ALARM', id: 'a' }, {}, { rule_engine_origin: 'system', isNewAlarm: 'true' }),
    ];
    for (const msg of others) {
      const r = await run(T, { persistAlarmRulesState: true }, msg);
      expect(r.calls.relations(), `${msg.type} from ${msg.metadata.rule_engine_origin}`).toEqual(['Success']);
      expect(r.out).toBe(msg);
    }
  });
});

// ─── every script goes through ctx.runScript (the per-node disable) ─────────

describe('scripts run through ctx.runScript', () => {
  it('Log, Create alarm and Clear alarm fail with the context\'s SCRIPT_DISABLED instead of running the VM themselves', async () => {
    const disabled = vi.fn(() => { throw new Error('SCRIPT_DISABLED: timed out 3 times in a row'); });
    const cases: [string, Record<string, unknown>, Overrides][] = [
      ['tb:action:log', {}, {}],
      ['tb:action:create-alarm', {}, { prisma: prismaWithOpen(null).prisma }],
      ['tb:action:clear-alarm', { alarmType: 'Hot' }, { prisma: prismaWithOpen({ ruleSnapshot: { details: {} } }).prisma }],
    ];
    for (const [type, config, services] of cases) {
      const { ctx, calls } = contextFor(type, config, services);
      ctx.runScript = disabled as unknown as typeof ctx.runScript;
      // As the engine calls a handler: a synchronous throw is a rejection too.
      await expect(Promise.resolve().then(() => getHandler(type)!.handler(ctx, testMessage({ t: 1 }))), type).rejects.toThrow(/^SCRIPT_DISABLED/);
      expect(calls.next, type).toHaveLength(0);
    }
    expect(disabled.mock.calls.map((c) => (c as unknown[])[0])).toEqual(['log', 'details', 'details']);
  });

  it('the Generator\'s tick runs its script through the lifecycle context, with the previous output as the message', async () => {
    vi.useFakeTimers();
    try {
      const { ctx, calls } = contextFor('tb:action:generator', { periodInSeconds: 1, msgCount: 2, jsScript: 'return { msg: { n: 1 }, msgType: "X" };' });
      const seen: RuleMessage[] = [];
      const real = ctx.runScript.bind(ctx);
      ctx.runScript = ((kind: 'generator', script: string, m: RuleMessage) => { seen.push(m); return real(kind, script, m); }) as typeof ctx.runScript;
      await getHandler('tb:action:generator')!.onInit!(ctx);
      vi.advanceTimersByTime(2_000);
      await getHandler('tb:action:generator')!.onDestroy!(ctx);
      expect(seen.map((m) => [m.type, m.data])).toEqual([['', {}], ['X', { n: 1 }]]);
      expect(calls.next).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ─── Generator and Message count (lifecycle, fake timers) ───────────────────

describe('Generator', () => {
  const T = 'tb:action:generator';
  beforeEach(() => vi.useFakeTimers());
  afterEach(async () => {
    vi.useRealTimers();
  });

  async function start(config: Record<string, unknown>, services: Overrides = {}) {
    const { ctx, calls } = contextFor(T, config, services, { nodeId: NODE, chainId: CHAIN });
    await getHandler(T)!.onInit!(ctx);
    return { ctx, calls, stop: () => getHandler(T)!.onDestroy!(ctx) };
  }

  it('onInit arms a timer: each period the shipped script\'s message goes out on Success, from this rule node', async () => {
    const g = await start({ periodInSeconds: 2 });
    try {
      expect(g.calls.next).toHaveLength(0);
      vi.advanceTimersByTime(1_999);
      expect(g.calls.next).toHaveLength(0);
      vi.advanceTimersByTime(1);
      expect(g.calls.next).toHaveLength(1);
      const [{ msg, relations }] = g.calls.next;
      expect(relations).toEqual(['Success']);
      expect(msg.type).toBe('POST_TELEMETRY_REQUEST');
      expect(msg.originator).toEqual({ type: 'RULE_NODE', id: NODE });
      expect(msg.data).toEqual({ temp: 42, humidity: 77 });
      expect(msg.metadata).toMatchObject({ data: '40' });
      vi.advanceTimersByTime(4_000);
      expect(g.calls.next).toHaveLength(3);
    } finally {
      await g.stop();
    }
  });

  it('a script that names no msgType emits GENERATOR_NODE_SELF_MSG; prevMsg carries the last one; msgCount stops it', async () => {
    const g = await start({ periodInSeconds: 1, msgCount: 3, jsScript: 'return { msg: { n: (prevMsg.n || 0) + 1 }, metadata: { last: String(prevMsgType) } };' });
    try {
      vi.advanceTimersByTime(10_000);
      expect(g.calls.next.map((c) => c.msg.type)).toEqual(['GENERATOR_NODE_SELF_MSG', 'GENERATOR_NODE_SELF_MSG', 'GENERATOR_NODE_SELF_MSG']);
      expect(g.calls.next.map((c) => (c.msg.data as { n: number }).n)).toEqual([1, 2, 3]);
      expect(g.calls.next[1].msg.metadata.last).toBe('GENERATOR_NODE_SELF_MSG');
    } finally {
      await g.stop();
    }
  });

  it('onDestroy stops the timer; an incoming message is ended (a Generator has no input)', async () => {
    const g = await start({ periodInSeconds: 1 });
    vi.advanceTimersByTime(1_000);
    await g.stop();
    vi.advanceTimersByTime(5_000);
    expect(g.calls.next).toHaveLength(1);
    const r = await run(T, {}, testMessage({}));
    expect(r.calls.relations()).toEqual([]);
    expect(r.thrown).toBeNull();
  });

  it('an instrument originator; one without an id, or an unknown type, refuses to start', async () => {
    const g = await start({ periodInSeconds: 1, originatorType: 'DEVICE', originatorId: 'inst-7' });
    try {
      vi.advanceTimersByTime(1_000);
      expect(g.calls.next[0].msg.originator).toEqual({ type: 'INSTRUMENT', id: 'inst-7' });
    } finally {
      await g.stop();
    }
    await expect(start({ periodInSeconds: 1, originatorType: 'INSTRUMENT', originatorId: null })).rejects.toThrow(/GENERATOR_ORIGINATOR/);
    await expect(start({ periodInSeconds: 1, originatorType: 'ASSET', originatorId: 'x' })).rejects.toThrow(/GENERATOR_ORIGINATOR/);
    // Ruling TB-L: a TBEL-stored Generator starts and runs its TBEL script as JavaScript.
    const tbel = await start({ periodInSeconds: 1, scriptLang: 'TBEL', jsScript: "return { msg: { from: 'js' } };", tbelScript: "return { msg: { from: 'tbel' } };" });
    try {
      vi.advanceTimersByTime(1_000);
      expect(tbel.calls.next[0].msg.data).toEqual({ from: 'tbel' });
    } finally {
      await tbel.stop();
    }
  });

  it('a script that throws sends a Failure and keeps going', async () => {
    const g = await start({ periodInSeconds: 1, msgCount: 2, jsScript: "throw new Error('broken');" });
    try {
      vi.advanceTimersByTime(5_000);
      expect(g.calls.failures).toHaveLength(2);
      expect(g.calls.failures[0].error).toContain('broken');
      expect(g.calls.failures[0].msg.type).toBe('GENERATOR_NODE_SELF_MSG');
    } finally {
      await g.stop();
    }
  });
});

describe('Message count', () => {
  const T = 'tb:action:message-count';
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts the messages it receives (ending each) and every interval emits the count from the SYSTEM', async () => {
    const { ctx, calls } = contextFor(T, { interval: 5, telemetryPrefix: 'messageCount' }, {}, { nodeId: NODE, chainId: CHAIN });
    const reg = getHandler(T)!;
    await reg.onInit!(ctx);
    try {
      for (let i = 0; i < 3; i++) await reg.handler(ctx, testMessage({ i }));
      expect(calls.next).toHaveLength(0);
      vi.advanceTimersByTime(5_000);
      expect(calls.next).toHaveLength(1);
      const [{ msg, relations }] = calls.next;
      expect(relations).toEqual(['Success']);
      expect(msg.type).toBe('POST_TELEMETRY_REQUEST');
      expect(msg.originator).toEqual({ type: 'SYSTEM', id: 'SYSTEM' });
      expect(msg.data).toEqual({ [`messageCount_${NODE}`]: 3 });
      expect(msg.metadata.delta).toBe('5000');
      vi.advanceTimersByTime(5_000);
      expect(calls.next[1].msg.data).toEqual({ [`messageCount_${NODE}`]: 0 });
    } finally {
      await reg.onDestroy!(ctx);
    }
    vi.advanceTimersByTime(20_000);
    expect(calls.next).toHaveLength(2);
  });
});
