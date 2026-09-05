import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  attributeDownlinkTopic,
  buildAttributeDownlinkPayload,
  publishAttributeDownlink,
  setDownlinkPublisher,
  downlinkPublisherConfigured,
  DOWNLINK_PUBLISH_OPTIONS,
  type AttributeDownlink,
} from '../attribute-downlink.js';

/**
 * The topic and payload builders are pure, and tested as such: the
 * gateway-vs-standalone branch and the delete case are where this goes wrong,
 * and neither needs a broker.
 */

const TS = new Date('2026-08-06T11:40:00.000Z');

function downlink(over: Partial<AttributeDownlink> = {}): AttributeDownlink {
  return {
    code: 'TEMP-01',
    gatewayCode: null,
    attributes: { assetTag: 'AT-99412' },
    changedKey: 'assetTag',
    changedValue: 'AT-99412',
    ts: TS,
    ...over,
  };
}

describe('attributeDownlinkTopic', () => {
  it('reproduces a slash-separated code literally — the plant\'s shape', () => {
    // The device subscribes `instruments/${clientid}/attributes` with its
    // client id `CWH/RDU/001-00`; the ACL template substitutes the string as
    // is, so the slot must be built the same way, slashes and all.
    expect(attributeDownlinkTopic('CWH/RDU/001-00', null)).toBe('instruments/CWH/RDU/001-00/attributes');
    expect(attributeDownlinkTopic('CWH/RDU/001-00', 'IOTGW01')).toBe('instruments/IOTGW01/attributes/CWH/RDU/001-00');
  });

  it('addresses a standalone instrument on its own topic', () => {
    expect(attributeDownlinkTopic('TEMP-01', null)).toBe('instruments/TEMP-01/attributes');
  });

  it('addresses a child UNDER ITS GATEWAY, not on its own topic', () => {
    // A child has no broker connection of its own. Publishing to
    // `instruments/CHA-1/attributes` would retain a message nobody reads.
    expect(attributeDownlinkTopic('CHA-1', 'GWV-1')).toBe('instruments/GWV-1/attributes/CHA-1');
  });

  it('treats undefined and empty-string gateway codes as standalone', () => {
    expect(attributeDownlinkTopic('TEMP-01')).toBe('instruments/TEMP-01/attributes');
    expect(attributeDownlinkTopic('TEMP-01', undefined)).toBe('instruments/TEMP-01/attributes');
    // '' would otherwise build `instruments//attributes/TEMP-01`, which the
    // device's `instruments/${clientid}/attributes/#` subscription never sees.
    expect(attributeDownlinkTopic('TEMP-01', '')).toBe('instruments/TEMP-01/attributes');
  });

  it('gives each child its OWN slot under the gateway', () => {
    // The whole reason for the trailing segment: MQTT retains only the LAST
    // message per topic, so two children sharing one topic means a reconnecting
    // gateway loses one of them.
    expect(attributeDownlinkTopic('CHA-1', 'GWV-1'))
      .not.toBe(attributeDownlinkTopic('CHB-1', 'GWV-1'));
  });
});

describe('buildAttributeDownlinkPayload', () => {
  it('carries the COMPLETE attribute set, not just the change', () => {
    const p = buildAttributeDownlinkPayload(downlink({
      attributes: { assetTag: 'AT-99412', calibrationDue: '2027-01-01' },
      changedKey: 'assetTag',
      changedValue: 'AT-99412',
    }));
    // A device reconstructing truth from the retained message alone needs all
    // of it, not the last delta.
    expect(p.attributes).toEqual({ assetTag: 'AT-99412', calibrationDue: '2027-01-01' });
    expect(p.changed).toEqual({ assetTag: 'AT-99412' });
  });

  it('a DELETE is a null in `changed` and an absence from `attributes` — in the same message', () => {
    const p = buildAttributeDownlinkPayload(downlink({
      attributes: { assetTag: 'AT-99412' },
      changedKey: 'calibrationDue',
      changedValue: null,
    }));
    expect(p.changed).toEqual({ calibrationDue: null });
    expect('calibrationDue' in p.attributes).toBe(false);
    // Both halves must survive JSON: `{k: undefined}` would vanish and the
    // device could not distinguish a removal from a message about another key.
    expect(JSON.parse(JSON.stringify(p)).changed).toEqual({ calibrationDue: null });
  });

  it('distinguishes a removal from an empty value', () => {
    const removed = buildAttributeDownlinkPayload(downlink({ attributes: {}, changedKey: 'k', changedValue: null }));
    const emptied = buildAttributeDownlinkPayload(downlink({ attributes: { k: '' }, changedKey: 'k', changedValue: '' }));
    expect(removed.changed).toEqual({ k: null });
    expect(emptied.changed).toEqual({ k: '' });
    expect(emptied.attributes).toEqual({ k: '' });
  });

  it('serialises the injected timestamp, so the payload has no hidden clock', () => {
    expect(buildAttributeDownlinkPayload(downlink()).ts).toBe('2026-08-06T11:40:00.000Z');
  });

  it('emits an empty set when the last attribute is deleted', () => {
    const p = buildAttributeDownlinkPayload(downlink({ attributes: {}, changedKey: 'assetTag', changedValue: null }));
    expect(p.attributes).toEqual({});
    expect(p.changed).toEqual({ assetTag: null });
  });
});

describe('publishAttributeDownlink', () => {
  type Call = { topic: string; payload: string; options: unknown };
  let calls: Call[];

  beforeEach(() => {
    calls = [];
  });
  // The publisher is module-level; `test-helper.ts` builds several apps in one
  // process, so leaving one installed would leak into the next file.
  afterEach(() => setDownlinkPublisher(null));

  function capture(impl?: () => Promise<void>) {
    setDownlinkPublisher(async (topic, payload, options) => {
      calls.push({ topic, payload, options });
      if (impl) await impl();
    });
  }

  it('publishes QoS 1 and RETAINED', async () => {
    capture();
    await publishAttributeDownlink(downlink());
    // Asserting the OPTIONS, not just topic+payload: with retain flipped off, a
    // device that was powered down during the change stays permanently stale
    // and every topic/payload assertion still passes.
    expect(calls[0].options).toEqual({ qos: 1, retain: true });
    expect(DOWNLINK_PUBLISH_OPTIONS).toEqual({ qos: 1, retain: true });
  });

  it('sends the built payload on the built topic', async () => {
    capture();
    await publishAttributeDownlink(downlink({ code: 'CHA-1', gatewayCode: 'GWV-1' }));
    expect(calls[0].topic).toBe('instruments/GWV-1/attributes/CHA-1');
    expect(JSON.parse(calls[0].payload)).toEqual({
      attributes: { assetTag: 'AT-99412' },
      changed: { assetTag: 'AT-99412' },
      ts: '2026-08-06T11:40:00.000Z',
    });
  });

  it('does nothing at all when no publisher is configured', async () => {
    setDownlinkPublisher(null);
    expect(downlinkPublisherConfigured()).toBe(false);
    // MQTT_BROKER_URL unset must behave exactly as it did before downlink
    // existed: no throw, no log, no attempt.
    const logged: string[] = [];
    await expect(publishAttributeDownlink(downlink(), (m) => logged.push(m))).resolves.toBeUndefined();
    expect(logged).toEqual([]);
  });

  it('swallows a publish rejection and logs it — the write already committed', async () => {
    capture(() => Promise.reject(new Error('not authorized')));
    const logged: Array<{ msg: string; meta?: Record<string, unknown> }> = [];
    await expect(
      publishAttributeDownlink(downlink(), (msg, meta) => logged.push({ msg, meta })),
    ).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
    expect(logged[0].msg).toMatch(/NOT DELIVERED/);
    expect(logged[0].meta?.err).toBe('not authorized');
  });

  it('swallows a synchronous throw from the publisher', async () => {
    setDownlinkPublisher(() => { throw new Error('boom'); });
    const logged: string[] = [];
    await expect(publishAttributeDownlink(downlink(), (m) => logged.push(m))).resolves.toBeUndefined();
    expect(logged).toHaveLength(1);
  });

  it('gives up rather than hanging when the broker never acknowledges', async () => {
    // mqtt.js with `clean: false` queues an unacked QoS 1 publish indefinitely,
    // so without the timeout an operator's HTTP request hangs on a broker
    // outage. 2s cap; a 5s budget here leaves room on a slow machine.
    capture(() => new Promise<void>(() => { /* never settles */ }));
    const logged: string[] = [];
    const started = Date.now();
    await publishAttributeDownlink(downlink(), (m) => logged.push(m));
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(logged[0]).toMatch(/NOT DELIVERED/);
  }, 10_000);
});
