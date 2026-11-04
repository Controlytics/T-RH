import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import type { Alarm } from '@prisma/client';
import { BUILT_RULE_NODE_TYPES } from '@digilog/shared';
import { getHandler, registerNode } from '../registry.js';
import { registerTransformationNodes } from '../nodes/transformation/index.js';
import { createRuleEngine } from '../engine.js';
import { chainOf, docOf, nodeOf, memoryDeps, fakeServices, fakeContext, testMessage, type FakeContextOptions } from '../../../test-support/rule-engine.js';
import type { RuleContext } from '../context.js';
import type { RuleMessage } from '../message.js';
import type { RuleInstrument } from '../services.js';

/**
 * The TRANSFORMATION rule nodes (rule chains, Task 4; spec §7 Transformation).
 * ThingsBoard's semantics, read off its master source 2026-11-04 — each
 * describe names the ThingsBoard class. Deduplication runs under fake timers;
 * one case runs it through a STARTED engine so the window's output is seen to
 * leave the node's own connections.
 */
beforeAll(() => registerTransformationNodes());

const restores: (() => void)[] = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
  vi.useRealTimers();
});

async function run(type: string, msg: RuleMessage, opts: Omit<FakeContextOptions, 'type'> = {}) {
  const registered = getHandler(type);
  if (!registered) throw new Error(`no handler registered for ${type}`);
  const { ctx, calls } = fakeContext({ ...opts, type });
  try {
    await registered.handler(ctx, msg);
  } catch (err) {
    ctx.tellFailure(msg, err);
  }
  return { ctx, calls };
}

const instrument = (over: Partial<RuleInstrument> = {}): RuleInstrument => ({
  id: 'instrument-1', code: 'TEST-001', name: 'TEST-001', isActive: true, isGateway: false, gatewayId: null,
  profileId: 'profile-1', profileName: 'T&RH', functionalLocationId: null, functionalLocationName: null,
  description: null, createdAt: new Date(0), ...over,
});

describe('registerTransformationNodes', () => {
  it('registers a handler for every BUILT transformation node of the catalogue', () => {
    const built = BUILT_RULE_NODE_TYPES.filter((s) => s.group === 'transformation').map((s) => s.id);
    expect(built).toHaveLength(9);
    for (const id of built) expect(getHandler(id), id).toBeDefined();
  });
});

describe('Change originator (TbChangeOriginatorNode)', () => {
  const T = 'tb:transformation:change-originator';
  const alarmMsg = () => testMessage({ id: 'alarm-1' }, { type: 'ALARM', originator: { type: 'ALARM', id: 'alarm-1', code: undefined }, metadata: { instrumentCode: 'GW-CHILD' } });
  const alarmRow = { id: 'alarm-1', instrumentId: 'child-1' } as unknown as Alarm;
  const child = instrument({ id: 'child-1', code: 'CH-1', gatewayId: 'gw-1' });
  const gateway = instrument({ id: 'gw-1', code: 'GW-1', isGateway: true });
  const services = {
    alarms: { byId: async (id: string) => (id === 'alarm-1' ? alarmRow : null) },
    instruments: {
      byId: async (id: string) => [child, gateway].find((i) => i.id === id) ?? null,
      byCode: async (code: string) => [child, gateway].find((i) => i.code.toLowerCase() === code.toLowerCase()) ?? null,
      gatewayOf: async (id: string) => (id === 'child-1' ? gateway : null),
    },
  };

  it('ALARM_ORIGINATOR (the default): the alarm\'s instrument becomes the originator; id, data and metadata kept', async () => {
    const msg = alarmMsg();
    const { calls } = await run(T, msg, { services });
    expect(calls.relations()).toEqual(['Success']);
    const out = calls.next[0].msg;
    expect(out.originator).toEqual({ type: 'INSTRUMENT', id: 'child-1', code: 'CH-1' });
    expect(out.id).toBe(msg.id);
    expect(out.data).toEqual(msg.data);
    expect(out.metadata).toEqual(msg.metadata);
    expect(msg.originator.type).toBe('ALARM');
  });

  it('ALARM_ORIGINATOR on a non-alarm originator → Failure ("Unexpected originator EntityType …")', async () => {
    const { calls } = await run(T, testMessage({}), { services });
    expect(calls.failures.map((f) => f.error)).toEqual(['Unexpected originator EntityType INSTRUMENT']);
  });

  it('an alarm that is gone → Failure ("Failed to find new originator!")', async () => {
    const msg = testMessage({}, { originator: { type: 'ALARM', id: 'gone', code: undefined } });
    const { calls } = await run(T, msg, { services });
    expect(calls.failures.map((f) => f.error)).toEqual(['Failed to find new originator!']);
  });

  it('ENTITY: the instrument whose CODE the pattern makes (metadata ${…} and data $[…]), ignoring case', async () => {
    const byMeta = await run(T, testMessage({}, { metadata: { target: 'gw-1' } }), { services, config: { originatorSource: 'ENTITY', entityType: 'DEVICE', entityNamePattern: '${target}' } });
    expect(byMeta.calls.next[0].msg.originator).toEqual({ type: 'INSTRUMENT', id: 'gw-1', code: 'GW-1' });
    const byData = await run(T, testMessage({ dev: { code: 'CH' } }), { services, config: { originatorSource: 'ENTITY', entityType: 'DEVICE', entityNamePattern: '$[dev.code]-1' } });
    expect(byData.calls.next[0].msg.originator.id).toBe('child-1');
  });

  it('ENTITY: no such instrument → Failure; no pattern or a non-instrument type → Failure (ThingsBoard refuses both at init)', async () => {
    const none = await run(T, testMessage({}), { services, config: { originatorSource: 'ENTITY', entityType: 'DEVICE', entityNamePattern: 'NOPE' } });
    expect(none.calls.failures.map((f) => f.error)).toEqual(["Failed to find instrument with code 'NOPE'"]);
    const blank = await run(T, testMessage({}), { services, config: { originatorSource: 'ENTITY', entityType: 'DEVICE', entityNamePattern: ' ' } });
    expect(blank.calls.failures[0].error).toBe("CONFIG_INVALID: Name pattern should be specified if 'Entity by name pattern' source is selected.");
    const asset = await run(T, testMessage({}), { services, config: { originatorSource: 'ENTITY', entityType: 'ASSET', entityNamePattern: 'GW-1' } });
    expect(asset.calls.failures[0].error).toMatch(/^CONFIG_INVALID: .*ASSET/);
  });

  it('RELATED: the instrument\'s gateway (the gateway link is the one relation here); none → Failure', async () => {
    const withGw = await run(T, testMessage({}, { originator: { id: 'child-1', code: 'CH-1' } }), { services, config: { originatorSource: 'RELATED' } });
    expect(withGw.calls.next[0].msg.originator).toEqual({ type: 'INSTRUMENT', id: 'gw-1', code: 'GW-1' });
    const without = await run(T, testMessage({}, { originator: { id: 'gw-1', code: 'GW-1' } }), { services, config: { originatorSource: 'RELATED' } });
    expect(without.calls.failures.map((f) => f.error)).toEqual(['Failed to find new originator!']);
  });

  it('TENANT → the system; CUSTOMER → Failure (there are no customers)', async () => {
    const tenant = await run(T, testMessage({}), { services, config: { originatorSource: 'TENANT' } });
    expect(tenant.calls.next[0].msg.originator).toEqual({ type: 'SYSTEM', id: 'SYSTEM' });
    const customer = await run(T, testMessage({}), { services, config: { originatorSource: 'CUSTOMER' } });
    expect(customer.calls.relations()).toEqual(['Failure']);
    expect(customer.calls.failures[0].error).toMatch(/customers/);
  });

  it('a new originator equal to the current one passes the SAME message', async () => {
    const msg = testMessage({}, { originator: { id: 'gw-1', code: 'GW-1' } });
    const { calls } = await run(T, msg, { services, config: { originatorSource: 'ENTITY', entityType: 'DEVICE', entityNamePattern: 'GW-1' } });
    expect(calls.next[0].msg).toBe(msg);
  });
});

describe('Copy key-value pairs (TbCopyKeysNode)', () => {
  const T = 'tb:transformation:copy-key-value-pairs';

  it('DATA → METADATA: matching keys (a key is a FULL-match regular expression); strings raw, others as JSON', async () => {
    const msg = testMessage({ temperature: 21.5, tempMax: { v: 30 }, label: 'Room A', xtemp: 1 }, { type: 'REST_API_REQUEST' });
    const { calls } = await run(T, msg, { config: { copyFrom: 'DATA', keys: ['temp.*', 'label'] } });
    const out = calls.next[0].msg;
    expect(out.metadata.temperature).toBe('21.5');
    expect(out.metadata.tempMax).toBe('{"v":30}');
    expect(out.metadata.label).toBe('Room A');
    expect(out.metadata.xtemp).toBeUndefined();
    expect(out.data).toEqual(msg.data);
    expect(out.id).toBe(msg.id);
  });

  it('METADATA → DATA: the value is copied as a STRING, never parsed', async () => {
    const msg = testMessage({ t: 1 }, { metadata: { limit: '42', flag: 'true' } });
    const { calls } = await run(T, msg, { config: { copyFrom: 'METADATA', keys: ['limit', 'flag'] } });
    expect(calls.next[0].msg.data).toEqual({ t: 1, limit: '42', flag: 'true' });
  });

  it('nothing matched, or data that is not a JSON object: the SAME message passes', async () => {
    const msg = testMessage({ t: 1 });
    expect((await run(T, msg, { config: { copyFrom: 'DATA', keys: ['nope'] } })).calls.next[0].msg).toBe(msg);
    const arr = testMessage([1, 2], { type: 'REST_API_REQUEST', metadata: { limit: '42' } });
    expect((await run(T, arr, { config: { copyFrom: 'METADATA', keys: ['limit'] } })).calls.next[0].msg).toBe(arr);
  });

  it('a key that is not a valid regular expression → Failure', async () => {
    const { calls } = await run(T, testMessage({ t: 1 }), { config: { copyFrom: 'DATA', keys: ['t('] } });
    expect(calls.relations()).toEqual(['Failure']);
    expect(calls.failures[0].error).toMatch(/^CONFIG_INVALID: /);
  });
});

describe('Delete key-value pairs (TbDeleteKeysNode)', () => {
  const T = 'tb:transformation:delete-key-value-pairs';

  it('DATA: removes the matching keys', async () => {
    const msg = testMessage({ temperature: 21, tempRaw: 20, humidity: 40 });
    const { calls } = await run(T, msg, { config: { deleteFrom: 'DATA', keys: ['temp.*'] } });
    expect(calls.next[0].msg.data).toEqual({ humidity: 40 });
    expect(msg.data).toEqual({ temperature: 21, tempRaw: 20, humidity: 40 });
  });

  it('METADATA: removes the matching keys, whatever the data is', async () => {
    const msg = testMessage('plain text', { metadata: { secret: 'x', ts: '1' } });
    const { calls } = await run(T, msg, { config: { deleteFrom: 'METADATA', keys: ['secret'] } });
    expect(calls.next[0].msg.metadata.secret).toBeUndefined();
    expect(calls.next[0].msg.metadata.ts).toBe('1');
  });

  it('nothing to delete: the SAME message passes', async () => {
    const msg = testMessage({ a: 1 });
    expect((await run(T, msg, { config: { deleteFrom: 'DATA', keys: ['b'] } })).calls.next[0].msg).toBe(msg);
  });
});

describe('Rename keys (TbRenameKeysNode)', () => {
  const T = 'tb:transformation:rename-keys';

  it('DATA and METADATA: each mapped key takes its new name', async () => {
    const d = await run(T, testMessage({ temperatureCelsius: 21, h: 40 }));
    expect(d.calls.next[0].msg.data).toEqual({ h: 40, temperature: 21 });
    const m = await run(T, testMessage({}, { metadata: { old: 'v' } }), { config: { renameIn: 'METADATA', renameKeysMapping: { old: 'new' } } });
    expect(m.calls.next[0].msg.metadata.new).toBe('v');
    expect(m.calls.next[0].msg.metadata.old).toBeUndefined();
  });

  it('the mapping applies in order: {a: b, b: c} moves a\'s value to c', async () => {
    const { calls } = await run(T, testMessage({ a: 1, b: 2 }), { config: { renameIn: 'DATA', renameKeysMapping: { a: 'b', b: 'c' } } });
    expect(calls.next[0].msg.data).toEqual({ c: 1 });
  });

  it('a key renamed to ITSELF is kept (ThingsBoard deletes it — a deliberate deviation)', async () => {
    const { calls } = await run(T, testMessage({ a: 1 }), { config: { renameIn: 'DATA', renameKeysMapping: { a: 'a' } } });
    expect(calls.next[0].msg.data).toEqual({ a: 1 });
  });

  it('no mapped key present, or data that is not an object: the SAME message passes', async () => {
    const msg = testMessage({ x: 1 });
    expect((await run(T, msg)).calls.next[0].msg).toBe(msg);
    const arr = testMessage([1], { type: 'REST_API_REQUEST' });
    expect((await run(T, arr)).calls.next[0].msg).toBe(arr);
  });
});

describe('JSON path (TbJsonPathNode)', () => {
  const T = 'tb:transformation:json-path';
  /** A telemetry message is FLAT, as in ThingsBoard (ruling M-1): data { key: value }, metadata.ts epoch ms. */
  const telemetry = () => testMessage({ temperature: 21, humidity: 40 }, { metadata: { ts: '1793000000000' } });
  /** A nested document — what a REST request (or a REST call's response) carries. */
  const doc = () => testMessage({ values: { temp: 21, hum: 40 }, list: [{ a: 1 }, { a: 2 }] }, { type: 'REST_API_REQUEST' });

  it('`$.temperature` on a telemetry message replaces the data with the reading; id and metadata kept', async () => {
    const msg = telemetry();
    const { calls } = await run(T, msg, { config: { jsonPath: '$.temperature' } });
    expect(calls.relations()).toEqual(['Success']);
    expect(calls.next[0].msg.data).toBe(21);
    expect(calls.next[0].msg.id).toBe(msg.id);
    expect(calls.next[0].msg.metadata).toEqual(msg.metadata);
  });

  it('a definite path into a nested document: a value, an object, or null', async () => {
    expect((await run(T, doc(), { config: { jsonPath: '$.values.temp' } })).calls.next[0].msg.data).toBe(21);
    expect((await run(T, doc(), { config: { jsonPath: '$.values' } })).calls.next[0].msg.data).toEqual({ temp: 21, hum: 40 });
    expect((await run(T, testMessage({ n: null }, { type: 'REST_API_REQUEST' }), { config: { jsonPath: '$.n' } })).calls.next[0].msg.data).toBeNull();
  });

  it('an indefinite path gives the list of matches (empty when nothing matches)', async () => {
    expect((await run(T, doc(), { config: { jsonPath: '$..a' } })).calls.next[0].msg.data).toEqual([1, 2]);
    expect((await run(T, doc(), { config: { jsonPath: '$.list[?(@.a > 1)]' } })).calls.next[0].msg.data).toEqual([{ a: 2 }]);
    expect((await run(T, doc(), { config: { jsonPath: '$.list[*].zzz' } })).calls.next[0].msg.data).toEqual([]);
    expect((await run(T, telemetry(), { config: { jsonPath: '$.*' } })).calls.next[0].msg.data).toEqual([21, 40]);
  });

  it('a definite path that is missing → Failure (PathNotFoundException)', async () => {
    const { calls } = await run(T, telemetry(), { config: { jsonPath: '$.pressure' } });
    expect(calls.failures.map((f) => f.error)).toEqual(['No results for path: $.pressure']);
  });

  it('`$` passes the SAME message; a path without `$` is read from the root, as Jayway does', async () => {
    const msg = telemetry();
    expect((await run(T, msg)).calls.next[0].msg).toBe(msg);
    expect((await run(T, telemetry(), { config: { jsonPath: 'humidity' } })).calls.next[0].msg.data).toBe(40);
  });

  it('a malformed path → Failure, never the whole document', async () => {
    for (const jsonPath of ['$[', '$.values[', '$.values]', '$..', '$.values.', '$ .values', "$['values"]) {
      const { calls } = await run(T, doc(), { config: { jsonPath } });
      expect(calls.relations(), jsonPath).toEqual(['Failure']);
      expect(calls.failures[0].error, jsonPath).toMatch(/^Invalid JSON path/);
    }
  });
});

describe('Script — transformation (TbTransformMsgNode)', () => {
  const T = 'tb:transformation:script';

  it('one result: data, metadata and type replaced, the id kept', async () => {
    const msg = testMessage({ t: 21 });
    const { calls } = await run(T, msg, { config: { jsScript: "return { msg: { tF: msg.t * 9 / 5 + 32 }, metadata: { unit: 'F' }, msgType: 'CUSTOM_F' };" } });
    const out = calls.next[0].msg;
    expect(calls.relations()).toEqual(['Success']);
    expect(out.data).toEqual({ tF: 69.8 });
    expect(out.metadata).toEqual({ unit: 'F' });
    expect(out.type).toBe('CUSTOM_F');
    expect(out.id).toBe(msg.id);
  });

  it('a part the script leaves out keeps the original', async () => {
    const msg = testMessage({ t: 21 }, { metadata: { keep: 'me' } });
    const { calls } = await run(T, msg, { config: { jsScript: 'return { msg: { t: 22 } };' } });
    expect(calls.next[0].msg.metadata.keep).toBe('me');
    expect(calls.next[0].msg.type).toBe('POST_TELEMETRY_REQUEST');
  });

  it('an array of results: one message each, each with a NEW id', async () => {
    const msg = testMessage({ list: [1, 2] });
    const { calls } = await run(T, msg, { config: { jsScript: 'return msg.list.map(function (v) { return { msg: { v: v } }; });' } });
    expect(calls.next.map((n) => n.msg.data)).toEqual([{ v: 1 }, { v: 2 }]);
    expect(calls.relations()).toEqual(['Success', 'Success']);
    const ids = calls.next.map((n) => n.msg.id);
    expect(new Set([...ids, msg.id]).size).toBe(3);
  });

  it('an empty array → Failure ("Message or messages list are empty!"); a throw → Failure', async () => {
    expect((await run(T, testMessage({}), { config: { jsScript: 'return [];' } })).calls.failures.map((f) => f.error)).toEqual(['Message or messages list are empty!']);
    expect((await run(T, testMessage({}), { config: { jsScript: "throw new Error('nope');" } })).calls.relations()).toEqual(['Failure']);
  });

  it('runs the JavaScript even when an import says scriptLang TBEL', async () => {
    const { calls } = await run(T, testMessage({ t: 1 }), { config: { scriptLang: 'TBEL', tbelScript: 'return {};', jsScript: 'return { msg: { t: 2 } };' } });
    expect(calls.next[0].msg.data).toEqual({ t: 2 });
  });
});

describe('Split array msg (TbSplitArrayMsgNode)', () => {
  const T = 'tb:transformation:split-array-msg';

  it('N elements → N messages under Success, each element its data, each a NEW id', async () => {
    const msg = testMessage([{ t: 1 }, { t: 2 }, { t: 3 }], { type: 'REST_API_REQUEST' });
    const { calls } = await run(T, msg);
    expect(calls.next.map((n) => n.msg.data)).toEqual([{ t: 1 }, { t: 2 }, { t: 3 }]);
    expect(calls.relations()).toEqual(['Success', 'Success', 'Success']);
    expect(new Set([...calls.next.map((n) => n.msg.id), msg.id]).size).toBe(4);
    expect(calls.next.every((n) => n.msg.metadata.instrumentCode === 'TEST-001')).toBe(true);
  });

  it('one element → that element, the id kept; an empty array → nothing (the message ends)', async () => {
    const one = testMessage([5], { type: 'REST_API_REQUEST' });
    const { calls } = await run(T, one);
    expect(calls.next.map((n) => n.msg.data)).toEqual([5]);
    expect(calls.next[0].msg.id).toBe(one.id);
    expect((await run(T, testMessage([], { type: 'REST_API_REQUEST' }))).calls.relations()).toEqual([]);
  });

  it('data that is not an array → Failure ("Msg data is not a JSON Array!")', async () => {
    const { calls } = await run(T, testMessage({ a: 1 }));
    expect(calls.failures.map((f) => f.error)).toEqual(['Msg data is not a JSON Array!']);
  });
});

describe('To email (TbMsgToEmailNode)', () => {
  const T = 'tb:transformation:to-email';

  it('the default config builds a SEND_EMAIL message from ${metadata} and $[data] templates', async () => {
    const msg = testMessage({ temperature: 31.5 }, { metadata: { userEmail: 'qa@example.com' } });
    const { calls } = await run(T, msg);
    expect(calls.relations()).toEqual(['Success']);
    const out = calls.next[0].msg;
    expect(out.type).toBe('SEND_EMAIL');
    expect(out.id).toBe(msg.id);
    expect(out.originator).toEqual(msg.originator);
    expect(out.metadata).toEqual(msg.metadata);
    expect(out.data).toEqual({
      from: 'info@testmail.org', to: 'qa@example.com', cc: null, bcc: null,
      subject: 'Instrument TEST-001 temperature high',
      body: 'Instrument TEST-001 has high temperature 31.5',
      html: false, isHtml: false,
    });
  });

  it('the brief\'s `${metadata.instrumentCode}` is NOT a ThingsBoard placeholder: it stays as written', async () => {
    const { calls } = await run(T, testMessage({}), { config: { subjectTemplate: 'x ${metadata.instrumentCode}' } });
    expect((calls.next[0].msg.data as { subject: string }).subject).toBe('x ${metadata.instrumentCode}');
  });

  it('placeholders: unknown ones stay literal; $[a.b] reads nested data; a JSON null reads "null"; objects stay literal; ${*} and $[*]', async () => {
    const msg = testMessage({ a: { b: 'deep' }, n: null, o: { x: 1 } }, { metadata: { k: 'v' } });
    const { calls } = await run(T, msg, { config: { bodyTemplate: '${nope}|$[a.b]|$[n]|$[o]|$[missing]|${k}|$[*]|${*}' } });
    expect((calls.next[0].msg.data as { body: string }).body).toBe(
      `\${nope}|deep|null|$[o]|$[missing]|v|${JSON.stringify(msg.data)}|${JSON.stringify(msg.metadata)}`,
    );
  });

  it('cc / bcc templates are filled; a blank one is null', async () => {
    const { calls } = await run(T, testMessage({}, { metadata: { boss: 'boss@example.com' } }), { config: { ccTemplate: '${boss}', bccTemplate: '' } });
    const data = calls.next[0].msg.data as { cc: string | null; bcc: string | null };
    expect(data.cc).toBe('boss@example.com');
    expect(data.bcc).toBeNull();
  });

  it('body type: "true" is HTML; "dynamic" reads the isHtml template (true, ignoring case; anything else false)', async () => {
    const html = (await run(T, testMessage({}), { config: { mailBodyType: 'true' } })).calls.next[0].msg.data as { html: boolean; isHtml: boolean };
    expect([html.html, html.isHtml]).toEqual([true, true]);
    for (const [flag, want] of [['true', true], ['TRUE', true], ['yes', false], ['', false]] as const) {
      const { calls } = await run(T, testMessage({}, { metadata: { flag } }), { config: { mailBodyType: 'dynamic', isHtmlTemplate: '${flag}' } });
      expect((calls.next[0].msg.data as { html: boolean }).html, flag).toBe(want);
    }
  });

  it('%d{…} in subject and body prints NOW in the emailTimezone (SimpleDateFormat letters)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-04T23:30:05.007Z'));
    const msg = testMessage({}, { metadata: { emailTimezone: 'Asia/Kolkata' } });
    const { calls } = await run(T, msg, { config: { subjectTemplate: "Report %d{yyyy-MM-dd'T'HH:mm:ss.SSS} %d{EEE MMM d} %d{h:mm a}", bodyTemplate: '%d{yy/M/dd HH:mm XXX}' } });
    const data = calls.next[0].msg.data as { subject: string; body: string };
    expect(data.subject).toBe('Report 2026-11-05T05:00:05.007 Thu Nov 5 5:00 AM');
    expect(data.body).toBe('26/11/05 05:00 +05:30');
    const utc = await run(T, testMessage({}, { metadata: { emailTimezone: 'UTC' } }), { config: { subjectTemplate: '%d{yyyy-MM-dd HH:mm Z}' } });
    expect((utc.calls.next[0].msg.data as { subject: string }).subject).toBe('2026-11-04 23:30 +0000');
  });

  it('%d{w W F}: week in year, week in month, day-of-week in month (Java\'s default locale: weeks start Sunday, week 1 holds the 1st)', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const at = async (iso: string, pattern: string) => {
      vi.setSystemTime(new Date(iso));
      const { calls } = await run(T, testMessage({}, { metadata: { emailTimezone: 'UTC' } }), { config: { subjectTemplate: `%d{${pattern}}` } });
      return (calls.next[0].msg.data as { subject: string }).subject;
    };
    // Thu 2026-11-05: week 45 of 2026 (week 1 = Sun 28 Dec 2025 – Sat 3 Jan 2026); November starts on a Sunday.
    expect(await at('2026-11-05T12:00:00Z', 'w W F')).toBe('45 1 1');
    // Wed 31 Dec 2025 lies in the week holding 1 Jan 2026: week 1 — with yyyy still 2025, exactly as Java prints it.
    expect(await at('2025-12-31T12:00:00Z', 'yyyy-ww')).toBe('2025-01');
    expect(await at('2026-01-03T12:00:00Z', 'w')).toBe('1');
    expect(await at('2026-01-04T12:00:00Z', 'w')).toBe('2');
    // August 2026 starts on a SATURDAY: the 1st is week 1, Sunday the 2nd starts week 2.
    expect(await at('2026-08-01T12:00:00Z', 'W F')).toBe('1 1');
    expect(await at('2026-08-02T12:00:00Z', 'W F')).toBe('2 1');
    expect(await at('2026-08-07T12:00:00Z', 'F')).toBe('1');
    expect(await at('2026-08-08T12:00:00Z', 'FF')).toBe('02');
  });

  it('a %d pattern letter SimpleDateFormat does not know → Failure', async () => {
    const { calls } = await run(T, testMessage({}), { config: { subjectTemplate: '%d{yyyy-qq}' } });
    expect(calls.relations()).toEqual(['Failure']);
    expect(calls.failures[0].error).toMatch(/Illegal pattern character 'q'/);
  });
});

describe('Deduplication (TbMsgDeduplicationNode)', () => {
  const T = 'tb:transformation:deduplication';
  const t0 = new Date('2026-11-04T10:00:00.000Z').getTime();

  /** Move the fake clock FORWARD to an absolute time, running every timer due on the way (never `setSystemTime`: it shifts pending timers). */
  const at = (ms: number) => {
    const step = ms - Date.now();
    if (step < 0) throw new Error('the test clock only moves forward');
    vi.advanceTimersByTime(step);
  };

  function start() {
    vi.useFakeTimers();
    vi.setSystemTime(t0);
  }

  /** One context per node: the same chain and node ids for every message, as in the engine. */
  function node(config: Record<string, unknown>, ids = { nodeId: '0f000000-0000-4000-8000-0000000d0001', chainId: '0f000000-0000-4000-8000-0000000d0002' }) {
    const registered = getHandler(T)!;
    const { ctx, calls } = fakeContext({ type: T, config, ...ids });
    restores.push(() => { void registered.onDestroy?.(ctx); });
    const send = async (msg: RuleMessage, atMs = Date.now()) => {
      at(atMs);
      try { await registered.handler(ctx, msg); } catch (err) { ctx.tellFailure(msg, err); }
    };
    return { ctx, calls, send, registered };
  }

  const reading = (t: number | string, originatorId = 'instrument-1', metadata: Record<string, string> = {}) =>
    testMessage({ t }, { originator: { id: originatorId }, metadata });
  const tOf = (calls: { next: { msg: RuleMessage }[] }) => calls.next.map((n) => `${n.msg.originator.id}:${(n.msg.data as { t: unknown }).t}`);

  it('FIRST: nothing leaves until the window closes (interval + 1 ms after the first); then the first, with a NEW id, on Success', async () => {
    start();
    const { calls, send } = node({ interval: 60, strategy: 'FIRST' });
    const first = reading(1);
    await send(first, t0);
    await send(reading(2), t0 + 10_000);
    await send(reading(3), t0 + 20_000);
    expect(calls.relations()).toEqual([]);
    at(t0 + 60_000);
    expect(calls.relations()).toEqual([]);
    at(t0 + 60_001);
    expect(calls.relations()).toEqual(['Success']);
    const out = calls.next[0].msg;
    expect(out.data).toEqual({ t: 1 });
    expect(out.id).not.toBe(first.id);
    expect(out.type).toBe(first.type);
    expect(out.originator).toEqual(first.originator);
    expect(out.metadata).toEqual(first.metadata);
    expect(out._stack).toBeUndefined();
  });

  it('LAST: the last message of the window', async () => {
    start();
    const { calls, send } = node({ interval: 60, strategy: 'LAST' });
    await send(reading(1), t0);
    await send(reading(2), t0 + 10_000);
    await send(reading(3), t0 + 20_000);
    at(t0 + 60_001);
    expect(tOf(calls)).toEqual(['instrument-1:3']);
  });

  it('ALL: one message of the out type, data = [{ msg, metadata }] per message, metadata { ts: now }', async () => {
    start();
    const { calls, send } = node({ interval: 60, strategy: 'ALL', outMsgType: 'POST_ATTRIBUTES_REQUEST' });
    const a = reading(1);
    const b = reading(2);
    await send(a, t0);
    await send(b, t0 + 5_000);
    at(t0 + 60_001);
    expect(calls.next).toHaveLength(1);
    const out = calls.next[0].msg;
    expect(out.type).toBe('POST_ATTRIBUTES_REQUEST');
    expect(out.originator).toEqual({ type: 'INSTRUMENT', id: 'instrument-1', code: 'TEST-001' });
    expect(out.data).toEqual([{ msg: { t: 1 }, metadata: a.metadata }, { msg: { t: 2 }, metadata: b.metadata }]);
    expect(out.metadata).toEqual({ ts: String(t0 + 60_001) });
    expect(out.id).not.toBe(a.id);
  });

  it('ALL with no output type set sends POST_TELEMETRY_REQUEST (ThingsBoard\'s editor default)', async () => {
    start();
    const { calls, send } = node({ interval: 1, strategy: 'ALL' });
    await send(reading(1), t0);
    at(t0 + 1_001);
    expect(calls.next[0].msg.type).toBe('POST_TELEMETRY_REQUEST');
  });

  it('windows are per ORIGINATOR', async () => {
    start();
    const { calls, send } = node({ interval: 60, strategy: 'FIRST' });
    await send(reading(1, 'A'), t0);
    await send(reading(2, 'B'), t0 + 1_000);
    await send(reading(3, 'A'), t0 + 2_000);
    at(t0 + 60_001);
    expect(tOf(calls)).toEqual(['A:1']);
    at(t0 + 61_001);
    expect(tOf(calls)).toEqual(['A:1', 'B:2']);
  });

  it('a message whose metadata ts lies past the window waits for a later tick (ticks run every interval + 1 ms)', async () => {
    start();
    const { calls, send } = node({ interval: 60, strategy: 'FIRST' });
    await send(reading(1, 'instrument-1', { ts: String(t0) }), t0);
    await send(reading(2, 'instrument-1', { ts: String(t0 + 70_000) }), t0 + 1_000);
    at(t0 + 60_001);
    expect(tOf(calls)).toEqual(['instrument-1:1']);
    // Its pack, [t0 + 70 s, t0 + 130 s), is not over at the next tick (t0 + 120.002 s) …
    at(t0 + 120_002);
    expect(tOf(calls)).toEqual(['instrument-1:1']);
    // … and leaves at the one after it.
    at(t0 + 180_003);
    expect(tOf(calls)).toEqual(['instrument-1:1', 'instrument-1:2']);
  });

  it('FIRST picks by the metadata ts when it is a number, not by arrival', async () => {
    start();
    const { calls, send } = node({ interval: 60, strategy: 'FIRST' });
    await send(reading('late', 'instrument-1', { ts: String(t0 + 30_000) }), t0);
    await send(reading('early', 'instrument-1', { ts: String(t0 + 1_000) }), t0 + 2_000);
    // The pack starts at the EARLIEST ts (t0 + 1 s) and is due at t0 + 61 s: not yet at the first tick …
    at(t0 + 60_001);
    expect(calls.next).toEqual([]);
    // … but at the next one, with both messages in it.
    at(t0 + 120_002);
    expect(tOf(calls)).toEqual(['instrument-1:early']);
  });

  it('a tie keeps the one that arrived first, for FIRST and for LAST (ThingsBoard compares strictly)', async () => {
    start();
    for (const strategy of ['FIRST', 'LAST']) {
      const { calls, send, ctx, registered } = node({ interval: 1, strategy });
      const ts = String(Date.now());
      await send(reading('a', 'instrument-1', { ts }));
      await send(reading('b', 'instrument-1', { ts }));
      at(Date.now() + 1_001);
      expect(tOf(calls), strategy).toEqual(['instrument-1:a']);
      await registered.onDestroy?.(ctx);
    }
  });

  it('a metadata ts that is not a whole number counts as the arrival time', async () => {
    start();
    const { calls, send } = node({ interval: 60, strategy: 'LAST' });
    await send(reading(1, 'instrument-1', { ts: '1.5e12' }), t0);
    await send(reading(2, 'instrument-1', { ts: 'soon' }), t0 + 1_000);
    at(t0 + 60_001);
    expect(tOf(calls)).toEqual(['instrument-1:2']);
  });

  it('more than maxPendingMsgs waiting for one originator → Failure for the extra message', async () => {
    start();
    const { ctx, calls, send } = node({ interval: 60, strategy: 'FIRST', maxPendingMsgs: 2 });
    await send(reading(1), t0);
    await send(reading(2), t0);
    await send(reading(3), t0);
    expect(calls.failures.map((f) => f.error)).toEqual([`[${ctx.node.id}] Max limit of pending messages reached for deduplication id: [instrument-1]`]);
    at(t0 + 60_001);
    expect(tOf(calls)).toEqual(['instrument-1:1']);
  });

  it('onDestroy drops what is waiting and its timer (the node changed or went away)', async () => {
    start();
    const { ctx, calls, send, registered } = node({ interval: 60, strategy: 'FIRST' });
    await send(reading(1), t0);
    await registered.onDestroy?.(ctx);
    at(t0 + 120_000);
    expect(calls.next).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('the same node id in two chains keeps two windows', async () => {
    start();
    const nodeId = '0f000000-0000-4000-8000-0000000d0009';
    const one = node({ interval: 60 }, { nodeId, chainId: '0f000000-0000-4000-8000-0000000d00a1' });
    const two = node({ interval: 60 }, { nodeId, chainId: '0f000000-0000-4000-8000-0000000d00a2' });
    await one.send(reading(1), t0);
    await two.send(reading(2), t0);
    at(t0 + 60_001);
    expect(tOf(one.calls)).toEqual(['instrument-1:1']);
    expect(tOf(two.calls)).toEqual(['instrument-1:2']);
  });

  it('after onInit, the window\'s output leaves through the INIT context (it belongs to no message\'s flow)', async () => {
    start();
    const registered = getHandler(T)!;
    const ids = { nodeId: '0f000000-0000-4000-8000-0000000d0011', chainId: '0f000000-0000-4000-8000-0000000d0012' };
    const init = fakeContext({ type: T, config: { interval: 60 }, ...ids });
    const perMessage = fakeContext({ type: T, config: { interval: 60 }, ...ids });
    restores.push(() => { void registered.onDestroy?.(init.ctx); });
    await registered.onInit?.(init.ctx as RuleContext);
    await registered.handler(perMessage.ctx, reading(1));
    at(t0 + 60_001);
    expect(tOf(init.calls)).toEqual(['instrument-1:1']);
    expect(perMessage.calls.next).toEqual([]);
  });

  it('through a STARTED engine: the window\'s one output leaves the node\'s own connections', async () => {
    const log: RuleMessage[] = [];
    restores.push(registerNode('test:t4-dedup-sink', (_ctx, msg) => { log.push(msg); }));
    const dedup = nodeOf(T, 'Dedup', { config: { interval: 1, strategy: 'LAST' } });
    const sink = nodeOf('test:t4-dedup-sink', 'Sink');
    const mem = memoryDeps([chainOf('c', docOf([dedup, sink], [[dedup, 'Success', sink]]), { root: true })]);
    const engine = createRuleEngine({ ...mem.deps, services: () => Object.assign(fakeServices(), { dispose: async () => undefined }) });
    await engine.start();
    try {
      // Distinct reading times, as telemetry carries: three enqueues inside one millisecond would TIE on arrival time.
      const base = Date.now();
      for (const t of [1, 2, 3]) expect(engine.enqueue(reading(t, 'instrument-1', { ts: String(base + t) }))).toBe(true);
      const deadline = Date.now() + 5_000;
      while (log.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      await new Promise((r) => setTimeout(r, 100));
      await engine.drain();
      expect(log.map((m) => m.data)).toEqual([{ t: 3 }]);
    } finally {
      await engine.stop();
    }
  });
});
