import { describe, it, expect, beforeAll } from 'vitest';
import type { Alarm } from '@prisma/client';
import { BUILT_RULE_NODE_TYPES, RULE_MESSAGE_TYPES, messageTypeSwitchLabel } from '@digilog/shared';
import { getHandler } from '../registry.js';
import { registerFilterNodes } from '../nodes/filter/index.js';
import { fakeContext, fakeServices, testMessage, type FakeContextOptions } from '../../../test-support/rule-engine.js';
import type { RuleMessage } from '../message.js';
import type { RuleInstrument } from '../services.js';

/**
 * The FILTER rule nodes (rule chains, Task 4; spec §7 Filter). ThingsBoard's
 * semantics, read off its master source 2026-11-04 — each describe names the
 * ThingsBoard class. Every case drives the REGISTERED handler through
 * `fakeContext`, so what is tested is what `registerFilterNodes()` installs.
 */
beforeAll(() => registerFilterNodes());

/** Runs the registered handler as the engine does: a THROW is a `tellFailure` with the thrown error (context.ts). */
async function run(type: string, msg: RuleMessage, opts: Omit<FakeContextOptions, 'type'> = {}) {
  const registered = getHandler(type);
  if (!registered) throw new Error(`no handler registered for ${type}`);
  const { ctx, calls } = fakeContext({ ...opts, type });
  try {
    await registered.handler(ctx, msg);
  } catch (err) {
    ctx.tellFailure(msg, err);
  }
  return calls;
}

const instrument = (over: Partial<RuleInstrument> = {}): RuleInstrument => ({
  id: 'instrument-1', code: 'TEST-001', name: 'TEST-001', isActive: true, isGateway: false, gatewayId: null,
  profileId: 'profile-1', profileName: 'T&RH', functionalLocationId: null, functionalLocationName: null,
  description: null, createdAt: new Date(0), ...over,
});

describe('registerFilterNodes', () => {
  it('registers a handler for every BUILT filter node of the catalogue', () => {
    const built = BUILT_RULE_NODE_TYPES.filter((s) => s.group === 'filter').map((s) => s.id);
    expect(built).toHaveLength(10);
    for (const id of built) expect(getHandler(id), id).toBeDefined();
  });
});

describe('Alarm status filter (TbCheckAlarmStatusNode)', () => {
  const T = 'tb:filter:alarm-status-filter';
  const alarmRow = (state: 'ACTIVE' | 'CLEARED', acked: boolean) =>
    ({ id: 'alarm-9', state, acknowledgedAt: acked ? new Date() : null, instrumentId: 'instrument-1' }) as unknown as Alarm;
  const alarmMsg = (data: unknown = { id: 'alarm-9', type: 'High temp' }) =>
    testMessage(data, { type: 'ALARM', originator: { type: 'ALARM', id: 'alarm-9', code: undefined } });

  it.each([
    ['ACTIVE', false, 'ACTIVE_UNACK'],
    ['ACTIVE', true, 'ACTIVE_ACK'],
    ['CLEARED', false, 'CLEARED_UNACK'],
    ['CLEARED', true, 'CLEARED_ACK'],
  ] as const)('a %s alarm, acknowledged=%s, has status %s: True when listed, False when not', async (state, acked, status) => {
    const byId = async () => alarmRow(state, acked);
    const yes = await run(T, alarmMsg(), { config: { alarmStatusList: [status] }, services: { alarms: { byId } } });
    expect(yes.relations()).toEqual(['True']);
    const others = ['ACTIVE_UNACK', 'ACTIVE_ACK', 'CLEARED_UNACK', 'CLEARED_ACK'].filter((s) => s !== status);
    const no = await run(T, alarmMsg(), { config: { alarmStatusList: others }, services: { alarms: { byId } } });
    expect(no.relations()).toEqual(['False']);
  });

  it('reads the LATEST alarm by the id in the message DATA (ThingsBoard parses the data as the alarm)', async () => {
    const asked: string[] = [];
    const calls = await run(T, alarmMsg({ id: 'from-data' }), {
      config: { alarmStatusList: ['ACTIVE_UNACK'] },
      services: { alarms: { byId: async (id: string) => { asked.push(id); return alarmRow('ACTIVE', false); } } },
    });
    expect(asked).toEqual(['from-data']);
    expect(calls.relations()).toEqual(['True']);
  });

  it('an alarm that no longer exists goes to Failure ("No such alarm found.")', async () => {
    const calls = await run(T, alarmMsg(), { services: { alarms: { byId: async () => null } } });
    expect(calls.failures.map((f) => f.error)).toEqual(['No such alarm found.']);
  });

  it('data that is not an alarm goes to Failure', async () => {
    const calls = await run(T, alarmMsg({ temperature: 21 }), { services: { alarms: { byId: async () => alarmRow('ACTIVE', false) } } });
    expect(calls.relations()).toEqual(['Failure']);
    expect(calls.failures[0].error).toMatch(/not an alarm/);
  });

  it('the default config passes the two ACTIVE statuses', async () => {
    const calls = await run(T, alarmMsg(), { services: { alarms: { byId: async () => alarmRow('ACTIVE', true) } } });
    expect(calls.relations()).toEqual(['True']);
  });
});

describe('Check fields presence (TbCheckMessageNode)', () => {
  const T = 'tb:filter:check-fields-presence';
  const msg = () => testMessage({ temperature: 21, humidity: null }, { metadata: { deviceType: 'T&RH' } });

  it('checkAllKeys: True only when every data key AND every metadata key is present', async () => {
    const all = await run(T, msg(), { config: { messageNames: ['temperature', 'humidity'], metadataNames: ['deviceType'], checkAllKeys: true } });
    expect(all.relations()).toEqual(['True']);
    const missingData = await run(T, msg(), { config: { messageNames: ['temperature', 'pressure'], metadataNames: ['deviceType'], checkAllKeys: true } });
    expect(missingData.relations()).toEqual(['False']);
    const missingMeta = await run(T, msg(), { config: { messageNames: ['temperature'], metadataNames: ['nope'], checkAllKeys: true } });
    expect(missingMeta.relations()).toEqual(['False']);
  });

  it('a key whose value is null is PRESENT (ThingsBoard: containsKey)', async () => {
    const calls = await run(T, msg(), { config: { messageNames: ['humidity'], checkAllKeys: true } });
    expect(calls.relations()).toEqual(['True']);
  });

  it('checkAllKeys off: one present key, data or metadata, is enough', async () => {
    const data = await run(T, msg(), { config: { messageNames: ['pressure', 'temperature'], metadataNames: ['nope'], checkAllKeys: false } });
    expect(data.relations()).toEqual(['True']);
    const meta = await run(T, msg(), { config: { messageNames: ['pressure'], metadataNames: ['deviceType'], checkAllKeys: false } });
    expect(meta.relations()).toEqual(['True']);
    const none = await run(T, msg(), { config: { messageNames: ['pressure'], metadataNames: ['nope'], checkAllKeys: false } });
    expect(none.relations()).toEqual(['False']);
  });

  it('both lists empty: True with checkAllKeys, False without (ThingsBoard master has no init check)', async () => {
    expect((await run(T, msg(), { config: { checkAllKeys: true } })).relations()).toEqual(['True']);
    expect((await run(T, msg(), { config: { checkAllKeys: false } })).relations()).toEqual(['False']);
  });

  it('data keys asked of data that is not a JSON object → Failure; metadata-only checks do not read the data', async () => {
    const arr = testMessage([1, 2], { metadata: { deviceType: 'x' } });
    const bad = await run(T, arr, { config: { messageNames: ['temperature'], checkAllKeys: true } });
    expect(bad.relations()).toEqual(['Failure']);
    const metaOnly = await run(T, testMessage([1, 2], { metadata: { deviceType: 'x' } }), { config: { metadataNames: ['deviceType'], checkAllKeys: true } });
    expect(metaOnly.relations()).toEqual(['True']);
  });
});

describe('Check relation presence — the gateway link (TbCheckRelationNode, narrowed)', () => {
  const T = 'tb:filter:check-relation-presence';
  const gateway = instrument({ id: 'gw-1', code: 'GW-1', isGateway: true });
  const child = instrument({ id: 'child-1', code: 'CH-1', gatewayId: 'gw-1' });
  const lone = instrument({ id: 'lone-1', code: 'LONE-1' });
  const all = [gateway, child, lone];
  const services = {
    instruments: { byId: async (id: string) => all.find((i) => i.id === id) ?? null },
    prisma: {
      instrument: {
        findFirst: async (args: { where: { gatewayId: string } }) => all.find((i) => i.gatewayId === args.where.gatewayId) ? { id: 'x' } : null,
      },
    } as never,
  };
  const from = (i: RuleInstrument) => testMessage({}, { originator: { type: 'INSTRUMENT', id: i.id, code: i.code } });

  it('FROM, any entity: True when the ORIGINATOR is a gateway with an instrument on it (ThingsBoard: findByFrom(originator))', async () => {
    const cfg = { direction: 'FROM', checkForSingleEntity: false };
    expect((await run(T, from(gateway), { config: cfg, services })).relations()).toEqual(['True']);
    expect((await run(T, from(lone), { config: cfg, services })).relations()).toEqual(['False']);
    expect((await run(T, from(child), { config: cfg, services })).relations()).toEqual(['False']);
  });

  it('TO, any entity: True when the originator is ON a gateway (ThingsBoard: findByTo(originator))', async () => {
    const cfg = { direction: 'TO', checkForSingleEntity: false };
    expect((await run(T, from(child), { config: cfg, services })).relations()).toEqual(['True']);
    expect((await run(T, from(gateway), { config: cfg, services })).relations()).toEqual(['False']);
  });

  it('FROM one instrument: True when the originator is THAT instrument\'s gateway', async () => {
    const cfg = { direction: 'FROM', checkForSingleEntity: true, entityType: 'DEVICE', entityId: 'child-1' };
    expect((await run(T, from(gateway), { config: cfg, services })).relations()).toEqual(['True']);
    expect((await run(T, from(lone), { config: cfg, services })).relations()).toEqual(['False']);
  });

  it('TO one instrument: True when that instrument is the originator\'s gateway', async () => {
    const cfg = { direction: 'TO', checkForSingleEntity: true, entityType: 'DEVICE', entityId: 'gw-1' };
    expect((await run(T, from(child), { config: cfg, services })).relations()).toEqual(['True']);
    expect((await run(T, from(lone), { config: cfg, services })).relations()).toEqual(['False']);
  });

  it('the relation type is not consulted: the gateway link answers every type', async () => {
    const cfg = { direction: 'TO', checkForSingleEntity: false, relationType: 'Manages' };
    expect((await run(T, from(child), { config: cfg, services })).relations()).toEqual(['True']);
  });

  it('a non-instrument originator has no relations → False', async () => {
    const alarm = testMessage({}, { originator: { type: 'ALARM', id: 'a-1', code: undefined } });
    expect((await run(T, alarm, { config: { direction: 'TO', checkForSingleEntity: false }, services })).relations()).toEqual(['False']);
  });

  it('one instrument asked for but not chosen → Failure (ThingsBoard refuses it at init: "Entity should be specified!")', async () => {
    const calls = await run(T, from(child), { config: { direction: 'FROM', checkForSingleEntity: true }, services });
    expect(calls.failures.map((f) => f.error)).toEqual(['CONFIG_INVALID: Entity should be specified!']);
  });

  it('a chosen instrument that does not exist, or a non-instrument entity type → Failure', async () => {
    const missing = await run(T, from(child), { config: { direction: 'TO', checkForSingleEntity: true, entityType: 'DEVICE', entityId: 'nope' }, services });
    expect(missing.relations()).toEqual(['Failure']);
    expect(missing.failures[0].error).toMatch(/^CONFIG_INVALID: .*nope/);
    const asset = await run(T, from(child), { config: { direction: 'TO', checkForSingleEntity: true, entityType: 'ASSET', entityId: 'gw-1' }, services });
    expect(asset.relations()).toEqual(['Failure']);
    expect(asset.failures[0].error).toMatch(/^CONFIG_INVALID: .*ASSET/);
  });
});

describe('Device profile switch (TbDeviceTypeSwitchNode)', () => {
  const T = 'tb:filter:device-profile-switch';

  it('routes under the originator instrument\'s PROFILE NAME, read from the instrument, not from metadata', async () => {
    const msg = testMessage({}, { metadata: { profileName: 'Stale name' } });
    const calls = await run(T, msg, { services: { instruments: { byId: async () => instrument({ profileName: 'T&RH Logger' }) } } });
    expect(calls.relations()).toEqual(['T&RH Logger']);
    expect(calls.next[0].msg).toBe(msg);
  });

  it('a non-instrument originator → Failure with ThingsBoard\'s wording', async () => {
    const msg = testMessage({}, { originator: { type: 'ALARM', id: 'a-1', code: undefined } });
    const calls = await run(T, msg);
    expect(calls.failures.map((f) => f.error)).toEqual(["Unsupported originator type: Alarm! Only Instrument type is allowed."]);
  });

  it('an instrument without a profile (or gone) → Failure', async () => {
    const none = await run(T, testMessage({}), { services: { instruments: { byId: async () => null } } });
    expect(none.failures.map((f) => f.error)).toEqual(["Instrument profile for entity id: instrument-1 wasn't found!"]);
    const blank = await run(T, testMessage({}), { services: { instruments: { byId: async () => instrument({ profileName: null }) } } });
    expect(blank.relations()).toEqual(['Failure']);
  });
});

describe('Entity type filter (TbOriginatorTypeFilterNode)', () => {
  const T = 'tb:filter:entity-type-filter';
  const of = (type: string) => testMessage({}, { originator: { type: type as never, id: 'x', code: undefined } });

  it('True when the originator type is chosen, False otherwise', async () => {
    expect((await run(T, of('INSTRUMENT'), { config: { originatorTypes: ['INSTRUMENT', 'ALARM'] } })).relations()).toEqual(['True']);
    expect((await run(T, of('ALARM'), { config: { originatorTypes: ['INSTRUMENT', 'ALARM'] } })).relations()).toEqual(['True']);
    expect((await run(T, of('USER'), { config: { originatorTypes: ['INSTRUMENT', 'ALARM'] } })).relations()).toEqual(['False']);
  });

  it('ThingsBoard\'s DEVICE and TENANT read as Instrument and System; ASSET matches nothing', async () => {
    expect((await run(T, of('INSTRUMENT'), { config: { originatorTypes: ['DEVICE'] } })).relations()).toEqual(['True']);
    expect((await run(T, of('SYSTEM'), { config: { originatorTypes: ['TENANT'] } })).relations()).toEqual(['True']);
    expect((await run(T, of('INSTRUMENT'), { config: { originatorTypes: ['ASSET'] } })).relations()).toEqual(['False']);
  });

  it('the default config passes instruments', async () => {
    expect((await run(T, of('INSTRUMENT'))).relations()).toEqual(['True']);
  });
});

describe('Entity type switch (TbOriginatorTypeSwitchNode)', () => {
  const T = 'tb:filter:entity-type-switch';
  it.each([
    ['INSTRUMENT', 'Instrument'], ['ALARM', 'Alarm'], ['USER', 'User'], ['SYSTEM', 'System'], ['RULE_NODE', 'Rule node'],
  ])('%s → %s', async (type, label) => {
    const calls = await run(T, testMessage({}, { originator: { type: type as never, id: 'x', code: undefined } }));
    expect(calls.relations()).toEqual([label]);
  });

  it('an originator type outside the five → Failure', async () => {
    const calls = await run(T, testMessage({}, { originator: { type: 'ASSET' as never, id: 'x', code: undefined } }));
    expect(calls.failures.map((f) => f.error)).toEqual(['Unsupported originator type: ASSET']);
  });
});

describe('Message type filter (TbMsgTypeFilterNode)', () => {
  const T = 'tb:filter:message-type-filter';
  it('True for a chosen type, False otherwise; the default passes telemetry and attributes', async () => {
    expect((await run(T, testMessage({}, { type: 'POST_TELEMETRY_REQUEST' }))).relations()).toEqual(['True']);
    expect((await run(T, testMessage({}, { type: 'POST_ATTRIBUTES_REQUEST' }))).relations()).toEqual(['True']);
    expect((await run(T, testMessage({}, { type: 'ALARM' }))).relations()).toEqual(['False']);
    expect((await run(T, testMessage({}, { type: 'CUSTOM_X' }), { config: { messageTypes: ['CUSTOM_X'] } })).relations()).toEqual(['True']);
  });
});

describe('Message type switch (TbMsgTypeSwitchNode)', () => {
  const T = 'tb:filter:message-type-switch';
  it('routes POST_TELEMETRY_REQUEST to "Post telemetry" and an unknown type to "Other"', async () => {
    expect((await run(T, testMessage({}, { type: 'POST_TELEMETRY_REQUEST' }))).relations()).toEqual(['Post telemetry']);
    expect((await run(T, testMessage({}, { type: 'REST_API_REQUEST' }))).relations()).toEqual(['REST API request']);
    expect((await run(T, testMessage({}, { type: 'ALARM_CLEAR' }))).relations()).toEqual(['Alarm Cleared']);
    expect((await run(T, testMessage({}, { type: 'MY_OWN' }))).relations()).toEqual(['Other']);
    expect((await run(T, testMessage({}, { type: 'toString' }))).relations()).toEqual(['Other']);
  });

  it('every message type this system raises routes under ThingsBoard\'s label (Other when it has none)', async () => {
    for (const type of RULE_MESSAGE_TYPES) {
      expect((await run(T, testMessage({}, { type }))).relations(), type).toEqual([messageTypeSwitchLabel(type)]);
    }
    expect(messageTypeSwitchLabel('GENERATOR_NODE_SELF_MSG')).toBe('Other');
  });
});

describe('Script — filter (TbJsFilterNode)', () => {
  const T = 'tb:filter:script';
  it('`return msg.t > 20`: True for 21, False for 19; the message passes unchanged', async () => {
    const hot = testMessage({ t: 21 });
    const yes = await run(T, hot, { config: { jsScript: 'return msg.t > 20;' } });
    expect(yes.relations()).toEqual(['True']);
    expect(yes.next[0].msg).toBe(hot);
    expect((await run(T, testMessage({ t: 19 }), { config: { jsScript: 'return msg.t > 20;' } })).relations()).toEqual(['False']);
  });

  it('the script sees metadata and msgType', async () => {
    const calls = await run(T, testMessage({}, { type: 'ALARM' }), { config: { jsScript: "return metadata.instrumentCode === 'TEST-001' && msgType === 'ALARM';" } });
    expect(calls.relations()).toEqual(['True']);
  });

  it('a script that throws → Failure with metadata.error; one that returns a non-boolean → Failure', async () => {
    const thrown = await run(T, testMessage({}), { config: { jsScript: "throw new Error('bad reading');" } });
    expect(thrown.relations()).toEqual(['Failure']);
    expect(thrown.failures[0].error).toContain('bad reading');
    const notBool = await run(T, testMessage({}), { config: { jsScript: 'return 1;' } });
    expect(notBool.relations()).toEqual(['Failure']);
  });

  it('runs the JavaScript even when an import says scriptLang TBEL', async () => {
    const calls = await run(T, testMessage({ t: 30 }), { config: { scriptLang: 'TBEL', tbelScript: 'return false;', jsScript: 'return msg.t > 20;' } });
    expect(calls.relations()).toEqual(['True']);
  });

  it('runs through ctx.runScript: three time-outs in a row and the node\'s script is switched off (SCRIPT_DISABLED)', async () => {
    const services = fakeServices({}, { scriptTimeoutMs: 50 });
    const ids = { nodeId: '0f000000-0000-4000-8000-0000000f0001', chainId: '0f000000-0000-4000-8000-0000000f0002' };
    const errors: string[] = [];
    for (let i = 0; i < 4; i++) {
      const calls = await run(T, testMessage({}), { ...ids, services, config: { jsScript: 'while (true) {}' } });
      expect(calls.relations()).toEqual(['Failure']);
      errors.push(calls.failures[0].error);
    }
    expect(errors.slice(0, 3).every((e) => e.startsWith('SCRIPT_TIMEOUT'))).toBe(true);
    expect(errors[3]).toMatch(/^SCRIPT_DISABLED/);
  });
});

describe('Switch (TbJsSwitchNode)', () => {
  const T = 'tb:filter:switch';
  it('returning [\'a\', \'b\'] sends the message down both', async () => {
    const calls = await run(T, testMessage({}), { config: { jsScript: "return ['a', 'b'];" } });
    expect(calls.next).toHaveLength(1);
    expect(calls.relations()).toEqual(['a', 'b']);
  });

  it('a single string is one relation; a repeated name is one relation (ThingsBoard passes a Set)', async () => {
    expect((await run(T, testMessage({}), { config: { jsScript: "return 'hot';" } })).relations()).toEqual(['hot']);
    expect((await run(T, testMessage({}), { config: { jsScript: "return ['a', 'b', 'a'];" } })).relations()).toEqual(['a', 'b']);
  });

  it('an empty array routes nowhere (the message ends)', async () => {
    const calls = await run(T, testMessage({}), { config: { jsScript: 'return [];' } });
    expect(calls.relations()).toEqual([]);
    expect(calls.failures).toEqual([]);
  });

  it('the default script: telemetry → two, anything else → one and nine', async () => {
    expect((await run(T, testMessage({}, { type: 'POST_TELEMETRY_REQUEST' }))).relations()).toEqual(['two']);
    expect((await run(T, testMessage({}, { type: 'ALARM' }))).relations()).toEqual(['one', 'nine']);
  });

  it('a throw or a non-string result → Failure', async () => {
    expect((await run(T, testMessage({}), { config: { jsScript: "throw new Error('x');" } })).relations()).toEqual(['Failure']);
    expect((await run(T, testMessage({}), { config: { jsScript: 'return [1];' } })).relations()).toEqual(['Failure']);
  });
});
