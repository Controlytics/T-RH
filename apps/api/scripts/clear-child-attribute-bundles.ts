/**
 * ONE-OFF: clear the retained `instruments/<gw>/children/attributes` message
 * for every gateway.
 *
 * Until 2026-09-05 that topic held a RETAINED bundle of every child's
 * attributes (seeded by the now-deleted `publish-child-attribute-bundles.ts`).
 * The operator asked for change events only — "when ever any instrument
 * attribute value was changed send at that time only" — so the topic is no
 * longer retained, and a subscriber must not be handed the old dump. A
 * zero-byte retained publish is the one way MQTT clears a retained message.
 *
 *   npx tsx apps/api/scripts/clear-child-attribute-bundles.ts            # dry run
 *   npx tsx apps/api/scripts/clear-child-attribute-bundles.ts --apply
 */
import mqtt from 'mqtt';
import { prisma } from '../src/lib/prisma.js';
import { DOWNLINK_PUBLISH_OPTIONS } from '../src/modules/instruments/attribute-downlink.js';
import { childAttributesBundleTopic } from '../src/modules/instruments/child-attributes-bundle.js';

const APPLY = process.argv.includes('--apply');
const BROKER = process.env.MQTT_BROKER_URL;

async function main() {
  if (!BROKER) throw new Error('MQTT_BROKER_URL is not set');
  const gateways = await prisma.instrument.findMany({ where: { isGateway: true }, select: { code: true } });
  const topics = gateways.map((g) => childAttributesBundleTopic(g.code));
  console.log(`broker: ${BROKER}`);
  for (const t of topics) console.log(`  clear ${t}`);
  if (!APPLY) { console.log('\nDry run only. Re-run with --apply to clear.'); return; }
  const client = await mqtt.connectAsync(BROKER, {
    clientId: `digilog-bundle-clear-${process.pid}`,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clean: true,
    connectTimeout: 8_000,
  });
  try {
    for (const t of topics) await client.publishAsync(t, '', DOWNLINK_PUBLISH_OPTIONS);
  } finally {
    await client.endAsync();
  }
  console.log(`\ncleared ${topics.length} retained slot(s)`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
