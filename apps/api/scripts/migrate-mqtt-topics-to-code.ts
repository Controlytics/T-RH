/**
 * Move every retained MQTT downlink slot from the UUID-keyed topics to the
 * CODE-keyed ones (2026-09-04, operator: "i want client id as CWH/RDU/001-00").
 *
 * WHAT IS PARKED ON THE BROKER AND WHY IT MATTERS. The bridge publishes three
 * kinds of RETAINED message — an instrument's attribute state, a child's
 * attribute state under its gateway, and a gateway's child roster — and a
 * retained message lives on the broker until it is overwritten or cleared.
 * Between 2026-08-07 and 2026-09-04 those slots were keyed on UUIDs:
 *
 *     instruments/<uuid>/attributes
 *     instruments/<gatewayUuid>/attributes/<childUuid>
 *     instruments/<gatewayUuid>/children
 *
 * After this change nothing subscribes there — a device's client id is now its
 * code, and the ACL admits it only to `instruments/<code>/...`. Left alone the
 * old slots are stranded: stale metadata that nothing can read but that any
 * operator looking at Monitoring → Retained Messages will take for current
 * state. And the NEW slots are empty until the next attribute edit or link on
 * each instrument, which for a hundred untouched instruments is never. So:
 *
 *   1. CLEAR each old slot with a zero-byte retained publish — the one way a
 *      retained message is removed, and the same primitive `clearChildRoster`
 *      uses.
 *   2. REPUBLISH the current state on the code-keyed slot, so a device that
 *      subscribes tomorrow is handed what the database says today.
 *
 * The payload shape is the wire shape the routes produce (`{attributes,
 * changed, ts}`); `changed` is `{}` here because this is a re-statement of the
 * full set, not an edit — `changed[key] === null` would assert a removal that
 * did not happen.
 *
 * Connects as the BRIDGE (`MQTT_USERNAME` / `MQTT_PASSWORD` from apps/api/.env),
 * which is the only client the ACL lets publish on the attributes/children
 * trees — so run it AFTER `etc/acl.conf` carries the `instruments/#` grant and
 * EMQX has been restarted, or every publish is denied. With
 * `deny_action = disconnect` that shows up as the connection dropping, and the
 * script reports it rather than exiting 0.
 *
 * Not audited: nothing in the database changes. The database is the record;
 * the broker is a cache of it that this script refreshes.
 *
 * Usage:
 *   npx tsx apps/api/scripts/migrate-mqtt-topics-to-code.ts            # dry run
 *   npx tsx apps/api/scripts/migrate-mqtt-topics-to-code.ts --apply
 */
import mqtt from 'mqtt';
import { prisma } from '../src/lib/prisma.js';
import { attributeDownlinkTopic, DOWNLINK_PUBLISH_OPTIONS } from '../src/modules/instruments/attribute-downlink.js';
import { childRosterTopic, buildChildRosterPayload } from '../src/modules/instruments/child-roster.js';

const APPLY = process.argv.includes('--apply');
const BROKER = process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';

async function main() {
  const instruments = await prisma.instrument.findMany({
    select: {
      id: true, code: true, name: true, isGateway: true, isActive: true, gatewayId: true,
      gateway: { select: { id: true, code: true } },
      attributes: { select: { key: true, value: true } },
    },
    orderBy: { code: 'asc' },
  });
  const byId = new Map(instruments.map((i) => [i.id, i]));

  const clears: string[] = [];
  const publishes: Array<{ topic: string; payload: string }> = [];
  const ts = new Date().toISOString();

  for (const i of instruments) {
    // Old, UUID-keyed slot for this instrument's attributes.
    clears.push(attributeDownlinkTopic(i.id, i.gateway?.id ?? null));
    // New, code-keyed slot, carrying the full current attribute set.
    publishes.push({
      topic: attributeDownlinkTopic(i.code, i.gateway?.code ?? null),
      payload: JSON.stringify({
        attributes: Object.fromEntries(i.attributes.map((a) => [a.key, a.value])),
        changed: {},
        ts,
      }),
    });
    if (i.isGateway) {
      clears.push(childRosterTopic(i.id));
      const children = instruments
        .filter((c) => c.gatewayId === i.id)
        .map((c) => ({ code: c.code, name: c.name, isActive: c.isActive }));
      publishes.push({
        topic: childRosterTopic(i.code),
        payload: JSON.stringify(buildChildRosterPayload(children, new Date(ts))),
      });
    }
  }

  console.log(`MODE: ${APPLY ? 'APPLY (publishes)' : 'DRY RUN (no broker traffic)'}`);
  console.log(`broker: ${BROKER}`);
  console.log(`instruments: ${instruments.length} (${instruments.filter((i) => i.isGateway).length} gateway)`);
  console.log(`old UUID slots to clear: ${clears.length}`);
  console.log(`new code slots to publish: ${publishes.length}`);
  for (const t of clears.slice(0, 3)) console.log(`  clear    ${t}`);
  for (const p of publishes.slice(0, 3)) console.log(`  publish  ${p.topic}  (${p.payload.length} bytes)`);
  if (clears.length > 3) console.log('  ...');
  void byId;

  if (!APPLY) {
    console.log('\nDry run only. Re-run with --apply to execute.');
    return;
  }

  const client = await mqtt.connectAsync(BROKER, {
    clientId: `digilog-topic-migration-${process.pid}`,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clean: true,
    connectTimeout: 8_000,
  });
  let dropped = false;
  client.on('close', () => { dropped = true; });

  let cleared = 0;
  let published = 0;
  try {
    for (const topic of clears) {
      await client.publishAsync(topic, '', DOWNLINK_PUBLISH_OPTIONS);
      cleared++;
      if (dropped) throw new Error(`broker dropped the connection after clearing ${topic} — is the bridge's publish grant instruments/# in acl.conf, and has EMQX been restarted?`);
    }
    for (const p of publishes) {
      await client.publishAsync(p.topic, p.payload, DOWNLINK_PUBLISH_OPTIONS);
      published++;
      if (dropped) throw new Error(`broker dropped the connection after publishing ${p.topic} — check the acl.conf publish grant`);
    }
  } finally {
    await client.endAsync();
  }
  console.log(`\ncleared ${cleared} old slot(s), published ${published} new slot(s)`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
