/**
 * The ENRICHMENT rule nodes (rule chains, Task 5) — each handler driven
 * through the registry exactly as the engine finds it (`getHandler(type)`),
 * on a `fakeContext` whose services are stubbed per case. A handler that
 * throws is the engine's `Failure` (engine.ts) — recorded here as `thrown`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { RULE_NODE_TYPES, newRuleNodeConfig } from '@digilog/shared';
import { clearRegistry, getHandler } from '../registry.js';
import { registerEnrichmentNodes } from '../nodes/enrichment/index.js';
import { clearDeltaCaches } from '../nodes/enrichment/calculate-delta.js';
import { NO_RELATED_DEVICE } from '../nodes/enrichment/related-device-attributes.js';
import { withFetched } from '../nodes/enrichment/fetch.js';
import { newMessage, type RuleMessage } from '../message.js';
import { fakeContext, testMessage } from '../../../test-support/rule-engine.js';
import type { RuleServices } from '../services.js';

type Overrides = Parameters<typeof fakeContext>[0] extends infer O ? O extends { services?: infer S } ? S : never : never;

async function run(type: string, config: Record<string, unknown>, msg: RuleMessage, services: Overrides = {}, ids: { nodeId?: string; chainId?: string } = {}) {
  const { ctx, calls } = fakeContext({ type, config, services, ...ids });
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

beforeAll(() => {
  clearRegistry();
  registerEnrichmentNodes();
});

describe('registration', () => {
  it('every BUILT enrichment node has a handler, and no later / none node has one', () => {
    const enrichment = RULE_NODE_TYPES.filter((s) => s.group === 'enrichment');
    expect(enrichment.filter((s) => s.status === 'built').map((s) => s.id).sort()).toEqual([
      'tb:enrichment:calculate-delta', 'tb:enrichment:originator-attributes', 'tb:enrichment:originator-fields',
      'tb:enrichment:originator-telemetry', 'tb:enrichment:related-device-attributes', 'tb:enrichment:tenant-attributes',
      'tb:enrichment:tenant-details',
    ]);
    for (const s of enrichment) expect(!!getHandler(s.id), s.id).toBe(s.status === 'built');
  });
});

// ─── Calculate delta ─────────────────────────────────────────────────────────

describe('Calculate delta', () => {
  const T = 'tb:enrichment:calculate-delta';
  const cfg = { inputValueKey: 'pulse', outputValueKey: 'delta', addPeriodBetweenMsgs: true, periodValueKey: 'period' };
  const nodeId = '11111111-1111-4111-8111-111111111111';
  const chainId = '22222222-2222-4222-8222-222222222222';
  const msgAt = (value: unknown, ts: number, originator = 'instrument-1') =>
    testMessage({ pulse: value, other: 1 }, { metadata: { ts: String(ts) }, originator: { id: originator } });
  let history: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    clearDeltaCaches();
    history = vi.fn(async () => ({}));
  });

  it('a message of another type, or without the input key, goes to Other unchanged', async () => {
    const a = await run(T, cfg, testMessage({ pulse: 1 }, { type: 'POST_ATTRIBUTES_REQUEST' }), { telemetry: { history } });
    expect(a.relation).toBe('Other');
    const b = await run(T, cfg, testMessage({ temp: 1 }), { telemetry: { history } });
    expect(b.relation).toBe('Other');
    expect(history).not.toHaveBeenCalled();
  });

  it('the first value: delta 0, period 0; then the cache gives value − previous and the time between', async () => {
    const first = await run(T, cfg, msgAt(100, 1_000_000), { telemetry: { history } }, { nodeId, chainId });
    expect(first.relation).toBe('Success');
    expect(first.out!.data).toEqual({ pulse: 100, other: 1, delta: 0, period: 0 });
    const second = await run(T, cfg, msgAt(130, 1_060_000), { telemetry: { history } }, { nodeId, chainId });
    expect(second.out!.data).toEqual({ pulse: 130, other: 1, delta: 30, period: 60_000 });
    // Only the cache miss read the database.
    expect(history).toHaveBeenCalledTimes(1);
  });

  it('a cache miss reads the newest stored reading strictly BEFORE this one (ingest already stored this one)', async () => {
    history.mockResolvedValueOnce({ pulse: [{ ts: 900_000, value: 70 }] });
    const r = await run(T, cfg, msgAt(100, 1_000_000), { telemetry: { history } }, { nodeId, chainId });
    expect(history).toHaveBeenCalledWith('instrument-1', ['pulse'], new Date(0), new Date(999_999), 'NONE', 'DESC', 1);
    expect(r.out!.data).toMatchObject({ delta: 30, period: 100_000 });
  });

  it('ThingsBoard\'s flat message: top-level keys at metadata.ts; a { ts, values } body is not looked into', async () => {
    history.mockResolvedValueOnce({ pulse: [{ ts: 1_000, value: '5' }] });
    const flat = await run(T, cfg, msgAt(12, 5_000), { telemetry: { history } });
    expect(history.mock.calls[0][3]).toEqual(new Date(4_999));
    expect(flat.out!.data).toEqual({ pulse: 12, other: 1, delta: 7, period: 4_000 });
    const nested = newMessage('POST_TELEMETRY_REQUEST', { type: 'INSTRUMENT', id: 'instrument-1' }, { ts: 5_000, values: { pulse: 12 } });
    expect((await run(T, cfg, nested, { telemetry: { history } })).relation).toBe('Other');
  });

  it('a negative delta fails ("Delta value is negative!") — and passes when that switch is off', async () => {
    await run(T, cfg, msgAt(100, 1_000), { telemetry: { history } }, { nodeId, chainId });
    const neg = await run(T, cfg, msgAt(90, 2_000), { telemetry: { history } }, { nodeId, chainId });
    expect(neg.thrown?.message).toBe('Delta value is negative!');
    const ok = await run(T, { ...cfg, tellFailureIfDeltaIsNegative: false }, msgAt(80, 3_000), { telemetry: { history } }, { nodeId, chainId });
    // The failed message still moved the cache on (ThingsBoard updates it before judging).
    expect(ok.out!.data).toMatchObject({ delta: -10 });
  });

  it('rounds HALF_UP to `round` places; a zero delta with excludeZeroDeltas passes on unchanged', async () => {
    await run(T, { ...cfg, round: 2 }, msgAt(0.1, 1_000), { telemetry: { history } }, { nodeId, chainId });
    const r = await run(T, { ...cfg, round: 2 }, msgAt(0.3, 2_000), { telemetry: { history } }, { nodeId, chainId });
    expect(r.out!.data).toMatchObject({ delta: 0.2 });
    const z = await run(T, { ...cfg, excludeZeroDeltas: true }, msgAt(0.3, 3_000), { telemetry: { history } }, { nodeId, chainId });
    expect(z.relation).toBe('Success');
    expect(z.out!.data).toEqual({ pulse: 0.3, other: 1 });
  });

  it('TB-P 6: the current value is read as Jackson\'s asDouble() — text that is not a number is 0, true is 1 — never a Failure', async () => {
    const lenient = { ...cfg, tellFailureIfDeltaIsNegative: false };
    await run(T, lenient, msgAt(10, 1_000), { telemetry: { history } }, { nodeId, chainId });
    const na = await run(T, lenient, msgAt('n/a', 2_000), { telemetry: { history } }, { nodeId, chainId });
    expect(na.thrown).toBeNull();
    expect(na.out!.data).toMatchObject({ pulse: 'n/a', delta: -10 });
    // The cache moved on to 0 (ThingsBoard caches the asDouble value).
    const after = await run(T, lenient, msgAt(5, 3_000), { telemetry: { history } }, { nodeId, chainId });
    expect(after.out!.data).toMatchObject({ delta: 5 });
    const delta = async (value: unknown) => {
      clearDeltaCaches();
      await run(T, lenient, msgAt(0, 1_000), { telemetry: { history } }, { nodeId, chainId });
      return ((await run(T, lenient, msgAt(value, 2_000), { telemetry: { history } }, { nodeId, chainId })).out!.data as { delta: number }).delta;
    };
    expect(await delta(true)).toBe(1);
    expect(await delta(false)).toBe(0);
    expect(await delta(null)).toBe(0);
    expect(await delta({ a: 1 })).toBe(0);
    expect(await delta(' 12.5 ')).toBe(12.5);       // trimmed, as NumberInput.parseAsDouble
    expect(await delta('1e2')).toBe(100);
    expect(await delta('7f')).toBe(7);              // Double.parseDouble takes a float suffix
    expect(await delta('0x10')).toBe(0);            // ... and not a hex integer
    expect(await delta('')).toBe(0);
  });

  it('a value whose delta is not finite ("NaN", "Infinity") fails: BigDecimal holds neither', async () => {
    await run(T, cfg, msgAt(1, 1_000), { telemetry: { history } }, { nodeId, chainId });
    const r = await run(T, cfg, msgAt('NaN', 2_000), { telemetry: { history } }, { nodeId, chainId });
    expect(r.thrown?.message).toMatch(/^DELTA_NOT_FINITE/);
  });

  it('the PREVIOUS value read from the database is judged as ThingsBoard\'s extractValue: unparseable text, a boolean or JSON fail', async () => {
    const prev = async (value: unknown) => {
      clearDeltaCaches();
      history.mockResolvedValueOnce({ pulse: [{ ts: 500, value }] });
      return run(T, cfg, msgAt(100, 1_000), { telemetry: { history } }, { nodeId, chainId });
    };
    expect((await prev(' 40 ')).out!.data).toMatchObject({ delta: 60 });
    expect((await prev('n/a')).thrown?.message).toBe('Calculation failed. Unable to parse value [n/a] of telemetry [pulse] to Double');
    expect((await prev(true)).thrown?.message).toBe('Calculation failed. Boolean values are not supported!');
    expect((await prev({ a: 1 })).thrown?.message).toBe('Calculation failed. JSON values are not supported!');
  });

  it('useCache off: every message reads the database', async () => {
    const off = { ...cfg, useCache: false };
    await run(T, off, msgAt(1, 1_000), { telemetry: { history } }, { nodeId, chainId });
    await run(T, off, msgAt(2, 2_000), { telemetry: { history } }, { nodeId, chainId });
    expect(history).toHaveBeenCalledTimes(2);
  });

  it('another originator is cached separately; a non-instrument originator has only the cache', async () => {
    await run(T, cfg, msgAt(10, 1_000, 'a'), { telemetry: { history } }, { nodeId, chainId });
    const b = await run(T, cfg, msgAt(50, 2_000, 'b'), { telemetry: { history } }, { nodeId, chainId });
    expect(b.out!.data).toMatchObject({ delta: 0 });
    const sys = newMessage('POST_TELEMETRY_REQUEST', { type: 'SYSTEM', id: 'SYSTEM' }, { pulse: 3 });
    const s = await run(T, cfg, sys, { telemetry: { history } }, { nodeId, chainId });
    expect(s.out!.data).toMatchObject({ delta: 0 });
    expect(history).toHaveBeenCalledTimes(2);
  });
});

// ─── where fetched values go (fetch.ts) ──────────────────────────────────────

describe('withFetched', () => {
  it('a JSON null VALUE fetched into the METADATA is the TEXT "null", never dropped (as ThingsBoard writes it; M-10); into the DATA it stays null', () => {
    const msg = testMessage({ a: 1 });
    expect(withFetched(msg, 'METADATA', [['gone', null], ['n', 2], ['o', { x: 1 }]], 'test').metadata).toMatchObject({ gone: 'null', n: '2', o: '{"x":1}' });
    expect(withFetched(msg, 'DATA', [['gone', null]], 'test').data).toEqual({ a: 1, gone: null });
  });
});

// ─── Originator attributes / Related device attributes ──────────────────────

describe('Originator attributes', () => {
  const T = 'tb:enrichment:originator-attributes';
  const attrs = { Location: 'Room 1', fw: '1.2', limit: '25' };
  const get = vi.fn(async (_id: string, keys?: string[]) => Object.fromEntries(Object.entries(attrs).filter(([k]) => !keys || keys.includes(k))));
  const latest = vi.fn(async (_id: string, keys: string[]) => Object.fromEntries(
    keys.filter((k) => k === 'temp').map((k) => [k, { value: 21.5, ts: new Date(5_000) }]),
  ));
  beforeEach(() => { get.mockClear(); latest.mockClear(); });

  it('adds each scope with ThingsBoard\'s prefix (cs_, shared_, ss_) and readings bare, to the metadata', async () => {
    const r = await run(T, {
      clientAttributeNames: ['fw'], sharedAttributeNames: ['Location'], serverAttributeNames: ['limit'], latestTsKeyNames: ['temp'],
    }, testMessage({ a: 1 }), { attributes: { get }, telemetry: { latest } });
    expect(r.relation).toBe('Success');
    expect(r.out!.metadata).toMatchObject({ cs_fw: '1.2', shared_Location: 'Room 1', ss_limit: '25', temp: '21.5' });
    expect(r.out!.data).toEqual({ a: 1 });
  });

  it('to the data (top level); a reading with its ts on request; data that is not an object fails', async () => {
    const flat = await run(T, { serverAttributeNames: ['limit'], latestTsKeyNames: ['temp'], fetchTo: 'DATA', getLatestValueWithTs: true },
      testMessage({ a: 1 }), { attributes: { get }, telemetry: { latest } });
    expect(flat.out!.data).toEqual({ a: 1, ss_limit: 25, temp: { ts: 5_000, value: 21.5 } });
    const arr = await run(T, { serverAttributeNames: ['limit'], fetchTo: 'DATA' }, testMessage([1]), { attributes: { get }, telemetry: { latest } });
    expect(arr.thrown?.message).toMatch(/^DATA_NOT_OBJECT/);
  });

  it('into the DATA an attribute value is typed as ThingsBoard adds it (JacksonUtil.addKvEntry): a number or boolean whose text is exactly how it prints; anything else stays text (M-3)', async () => {
    const typed = { n: '25', d: '0.5', neg: '-3.25', tiny: '1e-7', t: 'true', f: 'false', zeros: '007', dec: '1.50', blank: ' 25', big: '12345678901234567890', word: 'Room 1', json: '{"a":1}', caps: 'TRUE' };
    const getTyped = vi.fn(async () => typed);
    const r = await run(T, { serverAttributeNames: Object.keys(typed), fetchTo: 'DATA' }, testMessage({}), { attributes: { get: getTyped } });
    expect(r.out!.data).toEqual({
      ss_n: 25, ss_d: 0.5, ss_neg: -3.25, ss_tiny: 1e-7, ss_t: true, ss_f: false,
      ss_zeros: '007', ss_dec: '1.50', ss_blank: ' 25', ss_big: '12345678901234567890', ss_word: 'Room 1', ss_json: '{"a":1}', ss_caps: 'TRUE',
    });
    // To the METADATA every value stays its text.
    const md = await run(T, { serverAttributeNames: ['n', 't'] }, testMessage({}), { attributes: { get: getTyped } });
    expect(md.out!.metadata).toMatchObject({ ss_n: '25', ss_t: 'true' });
  });

  it('a missing key FAILS the ENRICHED message with ThingsBoard\u2019s per-scope wording (the default), or is left out when that switch is off', async () => {
    const cfg = { serverAttributeNames: ['limit', 'nope'], latestTsKeyNames: ['temp', 'hum'] };
    const fail = await run(T, cfg, testMessage({}), { attributes: { get }, telemetry: { latest } });
    expect(fail.thrown).toBeNull();
    expect(fail.calls.next).toHaveLength(0);
    expect(fail.calls.failures).toHaveLength(1);
    // TbAbstractGetAttributesNode.reportFailures (master e48b5780): unprefixed keys per scope, LATEST_TS for readings.
    expect(fail.calls.failures[0].error).toBe(
      'The following attribute/telemetry keys is not present in the DB: \n\t[SERVER_SCOPE]:[nope]\n\t[LATEST_TS]:[hum]\n',
    );
    // The message that fails is the enriched one: what WAS found is on it.
    expect(fail.calls.failures[0].msg.metadata).toMatchObject({ ss_limit: '25', temp: '21.5' });
    const scopes = await run(T, { clientAttributeNames: ['c1'], sharedAttributeNames: ['s1', 'fw'], serverAttributeNames: ['x1', 'x2'], fetchTo: 'DATA' },
      testMessage({ a: 1 }), { attributes: { get }, telemetry: { latest } });
    expect(scopes.calls.failures[0].error).toBe(
      'The following attribute/telemetry keys is not present in the DB: \n\t[CLIENT_SCOPE]:[c1]\n\t[SHARED_SCOPE]:[s1]\n\t[SERVER_SCOPE]:[x1, x2]\n',
    );
    expect(scopes.calls.failures[0].msg.data).toEqual({ a: 1, shared_fw: 1.2 });
    const pass = await run(T, { ...cfg, tellFailureIfAbsent: false }, testMessage({}), { attributes: { get }, telemetry: { latest } });
    expect(pass.out!.metadata).toMatchObject({ ss_limit: '25', temp: '21.5' });
    expect(pass.out!.metadata).not.toHaveProperty('ss_nope');
  });

  it('keys may be patterns; nothing asked for = no reads (latest([]) would mean EVERY key)', async () => {
    const r = await run(T, { serverAttributeNames: ['${which}'] }, testMessage({}, { metadata: { which: 'fw' } }), { attributes: { get }, telemetry: { latest } });
    expect(r.out!.metadata.ss_fw).toBe('1.2');
    expect(latest).not.toHaveBeenCalled();
    await run(T, {}, testMessage({}), { attributes: { get }, telemetry: { latest } });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('a non-instrument originator fails', async () => {
    const r = await run(T, { serverAttributeNames: ['fw'] }, newMessage('X', { type: 'SYSTEM', id: 'SYSTEM' }, {}));
    expect(r.thrown?.message).toMatch(/^ORIGINATOR_NOT_INSTRUMENT/);
  });
});

describe('Related device attributes (the gateway link)', () => {
  const T = 'tb:enrichment:related-device-attributes';
  const get = vi.fn(async (id: string) => ({ Site: `site of ${id}` }));
  beforeEach(() => get.mockClear());

  it('TO: the gateway the originator is on', async () => {
    const gatewayOf = vi.fn(async () => ({ id: 'gw-1' }) as never);
    const r = await run(T, { serverAttributeNames: ['Site'], deviceRelationsQuery: { direction: 'TO' } }, testMessage({}),
      { attributes: { get }, instruments: { gatewayOf } });
    expect(gatewayOf).toHaveBeenCalledWith('instrument-1');
    expect(r.out!.metadata.ss_Site).toBe('site of gw-1');
  });

  it('TO is the catalogue default (ruling CV-2): with the shipped config the GATEWAY is read', async () => {
    expect((newRuleNodeConfig(T).deviceRelationsQuery as { direction: string }).direction).toBe('TO');
    const gatewayOf = vi.fn(async () => ({ id: 'gw-2' }) as never);
    const findFirst = vi.fn(async () => ({ id: 'child-1' }));
    const prisma = { instrument: { findFirst } } as unknown as RuleServices['prisma'];
    const r = await run(T, { serverAttributeNames: ['Site'] }, testMessage({}), { attributes: { get }, instruments: { gatewayOf }, prisma });
    expect(gatewayOf).toHaveBeenCalledWith('instrument-1');
    expect(findFirst).not.toHaveBeenCalled();
    expect(r.out!.metadata.ss_Site).toBe('site of gw-2');
    // An imported query without a direction reads the gateway too.
    const bare = await run(T, { serverAttributeNames: ['Site'], deviceRelationsQuery: { maxLevel: 1 } }, testMessage({}), { attributes: { get }, instruments: { gatewayOf }, prisma });
    expect(bare.out!.metadata.ss_Site).toBe('site of gw-2');
  });

  it('FROM (chosen): the first instrument on the originator gateway, by code', async () => {
    const findFirst = vi.fn(async () => ({ id: 'child-1' }));
    const prisma = { instrument: { findFirst } } as unknown as RuleServices['prisma'];
    const r = await run(T, { serverAttributeNames: ['Site'], deviceRelationsQuery: { direction: 'FROM' } }, testMessage({}), { attributes: { get }, prisma });
    expect(findFirst).toHaveBeenCalledWith({ where: { gatewayId: 'instrument-1' }, orderBy: { code: 'asc' }, select: { id: true } });
    expect(r.out!.metadata.ss_Site).toBe('site of child-1');
  });

  it('a missing key fails the ENRICHED message here too (the shared fetch, M-11)', async () => {
    const gatewayOf = vi.fn(async () => ({ id: 'gw-1' }) as never);
    const r = await run(T, { serverAttributeNames: ['Site', 'nope'], deviceRelationsQuery: { direction: 'TO' } }, testMessage({}),
      { attributes: { get }, instruments: { gatewayOf } });
    expect(r.thrown).toBeNull();
    expect(r.calls.failures.map((f) => f.error)).toEqual(['The following attribute/telemetry keys is not present in the DB: \n\t[SERVER_SCOPE]:[nope]\n']);
    expect(r.calls.failures[0].msg.metadata.ss_Site).toBe('site of gw-1');
  });

  it('no related instrument fails with ThingsBoard\'s wording', async () => {
    const r = await run(T, { deviceRelationsQuery: { direction: 'TO' } }, testMessage({}), { instruments: { gatewayOf: async () => null } });
    expect(r.thrown?.message).toBe(NO_RELATED_DEVICE);
  });
});

// ─── Originator fields ───────────────────────────────────────────────────────

describe('Originator fields', () => {
  const T = 'tb:enrichment:originator-fields';
  const fields = vi.fn(async () => ({
    id: 'instrument-1', name: 'Fridge 1', code: 'F-1', label: 'Fridge 1', type: 'T&RH', profileName: 'T&RH',
    functionalLocation: 'QC', isGateway: 'false', createdTime: '1700000000000', additionalInfo: '',
  }));

  it('maps fields to keys in the metadata; target keys may be patterns; empty fields kept unless ignored', async () => {
    const r = await run(T, { dataMapping: { name: 'originatorName', profileName: '${p}', additionalInfo: 'info' } },
      testMessage({}, { metadata: { p: 'prof' } }), { instruments: { fields } });
    expect(r.out!.metadata).toMatchObject({ originatorName: 'Fridge 1', prof: 'T&RH', info: '' });
    const ig = await run(T, { dataMapping: { additionalInfo: 'info', code: 'c' }, ignoreNullStrings: true, fetchTo: 'DATA' },
      testMessage({ x: 1 }), { instruments: { fields } });
    expect(ig.out!.data).toEqual({ x: 1, c: 'F-1' });
  });

  it('an unknown field name fails, naming it and the fields there are', async () => {
    const r = await run(T, { dataMapping: { colour: 'c' } }, testMessage({}), { instruments: { fields } });
    expect(r.thrown?.message).toMatch(/^ORIGINATOR_FIELD_UNKNOWN: "colour"/);
  });

  it('a vanished instrument fails', async () => {
    const r = await run(T, { dataMapping: { name: 'n' } }, testMessage({}), { instruments: { fields: async () => null } });
    expect(r.thrown?.message).toMatch(/^INSTRUMENT_NOT_FOUND/);
  });
});

// ─── Originator telemetry ────────────────────────────────────────────────────

describe('Originator telemetry', () => {
  const T = 'tb:enrichment:originator-telemetry';
  const NOW = Date.UTC(2026, 10, 4, 12, 0, 0);
  let history: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    history = vi.fn(async () => ({ temp: [{ ts: NOW - 90_000, value: 21.5 }] }));
  });
  afterEach(() => vi.useRealTimers());

  it('FIRST over the default window [now − 2 min, now − 1 min]: the earliest reading, QUOTED as ThingsBoard writes it (TB-P 4)', async () => {
    const r = await run(T, { latestTsKeyNames: ['temp', 'hum'] }, testMessage({}), { telemetry: { history } });
    expect(history).toHaveBeenCalledWith('instrument-1', ['temp', 'hum'], new Date(NOW - 120_000), new Date(NOW - 60_000), 'NONE', 'ASC', 1);
    // updateMetadata: resultNode.get(key).toString() of a TEXT node — TbGetTelemetryNodeTest expects "\"22.4\"".
    expect(r.out!.metadata.temp).toBe('"21.5"');
    expect(r.out!.metadata).not.toHaveProperty('hum');
  });

  it('FIRST / LAST text is getValueAsString: Java\'s Double.toString for a fraction, the text of a string, JSON for an object', async () => {
    const one = async (value: unknown) => {
      history.mockResolvedValueOnce({ temp: [{ ts: NOW - 90_000, value }] });
      return (await run(T, { latestTsKeyNames: ['temp'], fetchMode: 'LAST' }, testMessage({}), { telemetry: { history } })).out!.metadata.temp;
    };
    expect(await one(22)).toBe('"22"');
    expect(await one(0.0001)).toBe('"1.0E-4"');
    expect(await one('NA "x"')).toBe('"NA \\"x\\""');
    expect(await one(true)).toBe('"true"');
    expect(await one({ a: 1 })).toBe('"{\\"a\\":1}"');
    // An imported `fetchTo: DATA` (not a ThingsBoard option for this node) gets the bare text.
    const data = await run(T, { latestTsKeyNames: ['temp'], fetchTo: 'DATA' }, testMessage({ x: 1 }), { telemetry: { history } });
    expect(data.out!.data).toEqual({ x: 1, temp: '21.5' });
  });

  it('TB-P 4: NO keys configured fails every message with ThingsBoard\'s init error, before any read', async () => {
    const r = await run(T, { latestTsKeyNames: [] }, testMessage({}), { telemetry: { history } });
    expect(r.thrown?.message).toBe('Telemetry should be specified!');
    expect(history).not.toHaveBeenCalled();
    // Keys that are configured but come out blank pass on unchanged (ThingsBoard queries them and finds nothing).
    const blank = await run(T, { latestTsKeyNames: ['${nothing}'] }, testMessage({}, { metadata: { nothing: ' ' } }), { telemetry: { history } });
    expect(blank.relation).toBe('Success');
  });

  it('LAST reads newest first; ALL returns [{ ts, value }] in order and limit, as JSON in the metadata', async () => {
    await run(T, { latestTsKeyNames: ['temp'], fetchMode: 'LAST' }, testMessage({}), { telemetry: { history } });
    expect(history.mock.calls[0].slice(4)).toEqual(['NONE', 'DESC', 1]);
    const all = await run(T, { latestTsKeyNames: ['temp'], fetchMode: 'ALL', orderBy: 'DESC', limit: 5, startInterval: 1, startIntervalTimeUnit: 'HOURS', endInterval: 0 },
      testMessage({}), { telemetry: { history } });
    expect(history.mock.calls[1].slice(2)).toEqual([new Date(NOW - 3_600_000), new Date(NOW), 'NONE', 'DESC', 5]);
    expect(JSON.parse(all.out!.metadata.temp)).toEqual([{ ts: NOW - 90_000, value: 21.5 }]);
  });

  it('ALL with an aggregation passes it through', async () => {
    await run(T, { latestTsKeyNames: ['temp'], fetchMode: 'ALL', aggregation: 'AVG' }, testMessage({}), { telemetry: { history } });
    expect(history.mock.calls[0][4]).toBe('AVG');
  });

  it('a window from metadata patterns (ms instants); a bad one or a reversed one fails', async () => {
    const md = { s: String(NOW - 10_000), e: String(NOW) };
    await run(T, { latestTsKeyNames: ['temp'], useMetadataIntervalPatterns: true, startIntervalPattern: '${s}', endIntervalPattern: '${e}' },
      testMessage({}, { metadata: md }), { telemetry: { history } });
    expect(history.mock.calls[0].slice(2, 4)).toEqual([new Date(NOW - 10_000), new Date(NOW)]);
    const bad = await run(T, { latestTsKeyNames: ['temp'], useMetadataIntervalPatterns: true, startIntervalPattern: '${missing}', endIntervalPattern: '${e}' },
      testMessage({}, { metadata: md }), { telemetry: { history } });
    expect(bad.thrown?.message).toMatch(/^INTERVAL_PATTERN_INVALID/);
    const rev = await run(T, { latestTsKeyNames: ['temp'], startInterval: 1, endInterval: 5 }, testMessage({}), { telemetry: { history } });
    expect(rev.thrown?.message).toBe('Interval start should be less than Interval end');
  });
});

// ─── Tenant (application) attributes and details ────────────────────────────

describe('Tenant attributes (Application attributes)', () => {
  const T = 'tb:enrichment:tenant-attributes';
  const appAttributes = vi.fn(async () => ({ alarmThreshold: '30', site: 'Plant 2' }));

  it('maps application attributes to keys; a source the list lacks is left out', async () => {
    const r = await run(T, { dataMapping: { alarmThreshold: 'threshold', missing: 'm', site: '${dest}' } },
      testMessage({}, { metadata: { dest: 'siteName' } }), { appAttributes });
    expect(r.relation).toBe('Success');
    expect(r.out!.metadata).toMatchObject({ threshold: '30', siteName: 'Plant 2' });
    expect(r.out!.metadata).not.toHaveProperty('m');
  });

  it('anything but ATTRIBUTES fails, naming why', async () => {
    const r = await run(T, { dataMapping: { a: 'b' }, dataToFetch: 'LATEST_TELEMETRY' }, testMessage({}), { appAttributes });
    expect(r.thrown?.message).toMatch(/^TENANT_DATA_UNSUPPORTED/);
  });
});

describe('Tenant details (Application details)', () => {
  const T = 'tb:enrichment:tenant-details';
  const appDetails = vi.fn(async () => ({ TITLE: 'Granules India Limited', APP_NAME: 'T&RH', SERVER_NAME: 'host-1', SERVER_VERSION: '' }));

  it('adds tenant_<camelCase> keys to the DATA by default; unknown and empty details are left out', async () => {
    const r = await run(T, { detailsList: ['TITLE', 'SERVER_NAME', 'SERVER_VERSION', 'COUNTRY'] }, testMessage({ x: 1 }), { appDetails });
    expect(r.out!.data).toEqual({ x: 1, tenant_title: 'Granules India Limited', tenant_serverName: 'host-1' });
  });

  it('to the metadata on request; an empty list reads nothing', async () => {
    const r = await run(T, { detailsList: ['APP_NAME'], fetchTo: 'METADATA' }, testMessage({}), { appDetails });
    expect(r.out!.metadata.tenant_appName).toBe('T&RH');
    appDetails.mockClear();
    await run(T, {}, testMessage({}), { appDetails });
    expect(appDetails).not.toHaveBeenCalled();
  });
});
