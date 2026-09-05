/**
 * Publish the CHILD ATTRIBUTES BUNDLE for every gateway, once.
 *
 * The bundle (`instruments/<gw>/children/attributes`, 2026-09-05) is republished
 * by the API on every child attribute or membership change. A gateway that has
 * seen no change since the slot was introduced has NO retained bundle yet; this
 * script seeds it from the database so a gateway subscribing today is handed
 * its children's attributes rather than silence until the next edit.
 *
 * Dry run by default — prints what it would publish. `--apply` publishes.
 *
 *   npx tsx apps/api/scripts/publish-child-attribute-bundles.ts            # dry run
 *   npx tsx apps/api/scripts/publish-child-attribute-bundles.ts --apply
 *
 * Reads MQTT_BROKER_URL / MQTT_USERNAME / MQTT_PASSWORD from apps/api/.env,
 * the same credentials the bridge publishes with (its `instruments/#` grant).
 */
import 'dotenv/config';
import mqtt from 'mqtt';
import { prisma } from '../src/lib/prisma.js';
import { DOWNLINK_PUBLISH_OPTIONS } from '../src/modules/instruments/attribute-downlink.js';
import {
  buildChildAttributesBundle, childAttributesBundleTopic, loadBundleChildren,
} from '../src/modules/instruments/child-attributes-bundle.js';

const APPLY = process.argv.includes('--apply');
const BROKER = process.env.MQTT_BROKER_URL;

async function main() {
  if (!BROKER) throw new Error('MQTT_BROKER_URL is not set');
  const gateways = await prisma.instrument.findMany({ where: { isGateway: true }, select: { id: true, code: true } });
  const publishes: { topic: string; payload: string; children: number }[] = [];
  const ts = new Date();
  for (const gw of gateways) {
    const children = await loadBundleChildren(gw.id);
    publishes.push({
      topic: childAttributesBundleTopic(gw.code),
      payload: JSON.stringify(buildChildAttributesBundle(gw.code, children, null, ts)),
      children: children.length,
    });
  }
  console.log(`broker: ${BROKER}`);
  console.log(`gateways: ${gateways.length}`);
  for (const p of publishes) console.log(`  ${p.topic}  ${p.children} child(ren), ${p.payload.length} bytes`);
  if (!APPLY) { console.log('\nDry run only. Re-run with --apply to publish.'); return; }

  const client = await mqtt.connectAsync(BROKER, {
    clientId: `digilog-bundle-seed-${process.pid}`,
    username: process.env.MQTT_USERNAME,
    password: process.env.MQTT_PASSWORD,
    clean: true,
    connectTimeout: 8_000,
  });
  let dropped = false;
  client.on('close', () => { dropped = true; });
  let published = 0;
  try {
    for (const p of publishes) {
      await client.publishAsync(p.topic, p.payload, DOWNLINK_PUBLISH_OPTIONS);
      published++;
      if (dropped) throw new Error(`broker dropped the connection after ${p.topic} — check the acl.conf publish grant`);
    }
  } finally {
    await client.endAsync();
  }
  console.log(`\npublished ${published} bundle(s)`);
}

main()
  .catch((e) => { console.error(e); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());
