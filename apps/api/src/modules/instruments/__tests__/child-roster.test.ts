import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  childRosterTopic, buildChildRosterPayload, publishChildRoster, clearChildRoster,
  type RosterChild,
} from '../child-roster.js';
import { setDownlinkPublisher, DOWNLINK_PUBLISH_OPTIONS } from '../attribute-downlink.js';

/**
 * The roster's pure half — topic and payload — plus the two properties of the
 * publish that need no broker: it holds the SAME publisher singleton as the
 * attribute path, and a clear is a zero-byte retained publish.
 *
 * Wiring (which route triggers a republish, and with what membership) is in
 * `e2e/instrument-child-roster.test.ts`.
 */

const kid = (code: string, name = code, isActive = true): RosterChild => ({ code, name, isActive });
const TS = new Date('2026-08-07T05:10:00.000Z');

afterEach(() => setDownlinkPublisher(null));

describe('childRosterTopic', () => {
  it('is keyed on the gateway CODE, reproduced literally', () => {
    // The gateway subscribes `instruments/${clientid}/children` with its
    // client id = its code (2026-09-04); a slash in the code is a level the
    // template reproduces, so it must be built the same way here.
    expect(childRosterTopic('CWH/GW/01')).toBe('instruments/CWH/GW/01/children');
  });

  // A sibling of the attributes subtree, NOT a segment inside it: `codeSchema`
  // allows `[A-Za-z0-9._-]`, so a reserved segment under `…/attributes/` could
  // be collided with by a real instrument code.
  it('is a sibling of the attributes subtree', () => {
    expect(childRosterTopic('GW-1')).toBe('instruments/GW-1/children');
    expect(childRosterTopic('GW-1')).not.toContain('/attributes');
  });
});

describe('buildChildRosterPayload', () => {
  it('carries the WHOLE membership, never a delta', () => {
    const p = buildChildRosterPayload([kid('B'), kid('A')], TS);
    expect(p.children.map((c) => c.code)).toEqual(['A', 'B']);
    expect(p.ts).toBe('2026-08-07T05:10:00.000Z');
  });

  // `findMany` gives no ordering guarantee. Unordered, a gateway diffing two
  // messages would see a change every time the database felt like reordering.
  it('sorts by code so an unchanged membership serialises identically', () => {
    const a = JSON.stringify(buildChildRosterPayload([kid('X'), kid('M'), kid('C')], TS));
    const b = JSON.stringify(buildChildRosterPayload([kid('C'), kid('X'), kid('M')], TS));
    expect(a).toBe(b);
  });

  it('does not mutate the caller\'s array', () => {
    const rows = [kid('B'), kid('A')];
    buildChildRosterPayload(rows, TS);
    expect(rows.map((c) => c.code)).toEqual(['B', 'A']);
  });

  // An inactive child is still this gateway's responsibility and is expected
  // back; an unlinked one has left. Dropping the inactive one would make those
  // two indistinguishable from the broker.
  it('includes inactive children, flagged', () => {
    const p = buildChildRosterPayload([kid('A'), kid('B', 'B', false)], TS);
    expect(p.children).toEqual([
      { code: 'A', name: 'A', isActive: true },
      { code: 'B', name: 'B', isActive: false },
    ]);
  });

  // A gateway with no children must be able to LEARN that, rather than being
  // unable to tell it from a broker that lost the message.
  it('represents an empty gateway as an empty list', () => {
    expect(buildChildRosterPayload([], TS).children).toEqual([]);
  });
});

describe('publishChildRoster', () => {
  it('publishes the roster retained at QoS 1', async () => {
    const sent: { topic: string; payload: string; options: unknown }[] = [];
    setDownlinkPublisher(async (topic, payload, options) => { sent.push({ topic, payload, options }); });

    await publishChildRoster('GW-1', [kid('C-1', 'Child one')], TS);

    expect(sent).toHaveLength(1);
    expect(sent[0].topic).toBe('instruments/GW-1/children');
    // Retain is what lets a gateway that was powered off during a link learn
    // its membership on the next connect instead of waiting for another change.
    expect(sent[0].options).toEqual(DOWNLINK_PUBLISH_OPTIONS);
    expect(DOWNLINK_PUBLISH_OPTIONS).toEqual({ qos: 1, retain: true });
    expect(JSON.parse(sent[0].payload)).toEqual({
      children: [{ code: 'C-1', name: 'Child one', isActive: true }],
      ts: '2026-08-07T05:10:00.000Z',
    });
  });

  // The membership is correct in the database and unknown to the gateway. That
  // must be loud, and it must not fail the operator's edit.
  it('never throws when the broker refuses, and says so', async () => {
    const log = vi.fn();
    setDownlinkPublisher(async () => { throw new Error('broker down'); });

    await expect(publishChildRoster('GW-1', [], TS, log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('NOT DELIVERED'),
      expect.objectContaining({ topic: 'instruments/GW-1/children', err: 'broker down' }),
    );
  });

  // With MQTT_BROKER_URL unset there is no bridge and no publisher. That is a
  // supported install, not a fault, so it is silent.
  it('is a silent no-op with no publisher installed', async () => {
    const log = vi.fn();
    await expect(publishChildRoster('GW-1', [kid('C-1')], TS, log)).resolves.toBeUndefined();
    expect(log).not.toHaveBeenCalled();
  });
});

describe('clearChildRoster', () => {
  // A zero-byte retained publish is the ONLY way to clear a retained slot.
  // Without it, a deleted gateway leaves a roster naming instruments that are
  // still live and now belong to nobody.
  it('clears the slot with a zero-byte retained publish', async () => {
    const sent: { topic: string; payload: string; options: unknown }[] = [];
    setDownlinkPublisher(async (topic, payload, options) => { sent.push({ topic, payload, options }); });

    await clearChildRoster('GW-1');

    expect(sent).toEqual([{
      topic: 'instruments/GW-1/children', payload: '', options: DOWNLINK_PUBLISH_OPTIONS,
    }]);
  });

  it('never throws when the broker refuses', async () => {
    const log = vi.fn();
    setDownlinkPublisher(async () => { throw new Error('broker down'); });
    await expect(clearChildRoster('GW-1', log)).resolves.toBeUndefined();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('NOT CLEARED'), expect.anything());
  });
});

// One singleton, set and reset in one place. A second publisher would have to
// be reset separately by `test-helper.ts`, and the forgotten one would stay
// live for the next app built in the same process.
describe('publisher singleton', () => {
  it('is shared with the attribute path', async () => {
    const sent: string[] = [];
    setDownlinkPublisher(async (topic) => { sent.push(topic); });
    await publishChildRoster('GW-1', [], TS);
    setDownlinkPublisher(null);
    await publishChildRoster('GW-1', [], TS);
    expect(sent).toEqual(['instruments/GW-1/children']);
  });
});
