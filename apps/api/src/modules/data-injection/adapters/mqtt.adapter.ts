/**
 * MQTT adapter — the app is a CLIENT of an external broker (spec D2).
 *
 * Connection details come from the P1 CommunicationProfile config, WITH secrets
 * unmasked. That value must never be returned over HTTP or written to an audit
 * row; this is the one legitimate consumer of the raw form.
 *
 * SUBSCRIPTION ANCHORING. The adapter subscribes per gateway to
 * `<baseTopic>/#` and stamps each message with the gateway that subscription
 * belongs to. The gateway is therefore never parsed out of the topic — it
 * cannot be, because hierarchy depth varies per site and
 * `…/<hierarchy>/<gateway>/<category>` is indistinguishable from
 * `…/<gateway>/<instrument>/<category>`. See topic-router.ts.
 */
import mqtt, { type MqttClient } from 'mqtt';
import type {
  IProtocolAdapter, InboundMessage, AdapterHealth, ProfileWithSecrets,
} from './protocol-adapter.js';
import { tailOf } from '../topic-router.js';

export interface MqttSubscription {
  gatewayId: string;
  gatewaySlug: string;
  /** Everything up to and including the gateway, e.g. `acme/india/area-02/gw-001`. */
  baseTopic: string;
}

interface MqttConfig {
  brokerUrl?: string;
  username?: string;
  password?: string;
  clientId?: string;
  qos?: 0 | 1 | 2;
  separator?: string;
  subscriptions?: MqttSubscription[];
  /** Extra raw filters. Messages matching only these carry no gateway. */
  extraFilters?: string[];
}

export function createMqttAdapter(): IProtocolAdapter {
  let client: MqttClient | null = null;
  let profileId = '';
  let subscriptions: MqttSubscription[] = [];
  let separator = '/';
  const health: AdapterHealth = {
    connected: false, lastMessageAt: null, lastErrorAt: null,
    lastError: null, messagesReceived: 0, reconnectCount: 0,
  };

  /**
   * Longest matching base wins, so `test/gw-10` is preferred over `test/gw-1`
   * for `test/gw-10/...`. tailOf compares segment-wise, so `test/gw-1` does not
   * match `test/gw-10/...` at all — but ordering still matters once one base is
   * a genuine ancestor of another.
   */
  const matchSubscription = (topic: string): MqttSubscription | null => {
    let best: MqttSubscription | null = null;
    for (const s of subscriptions) {
      if (tailOf(topic, s.baseTopic, separator) === null) continue;
      if (!best || s.baseTopic.length > best.baseTopic.length) best = s;
    }
    return best;
  };

  return {
    protocolKey: 'mqtt',

    async start(profile: ProfileWithSecrets, onMessage) {
      profileId = profile.id;
      const cfg = profile.config as MqttConfig;
      if (!cfg.brokerUrl) throw new Error(`Profile '${profile.name}' has no brokerUrl.`);

      subscriptions = cfg.subscriptions ?? [];
      separator = cfg.separator ?? '/';
      const qos = (cfg.qos ?? 1) as 0 | 1 | 2;
      const filters = [
        ...subscriptions.map(s => `${s.baseTopic}${separator}#`),
        ...(cfg.extraFilters ?? []),
      ];

      client = mqtt.connect(cfg.brokerUrl, {
        username: cfg.username,
        password: cfg.password,
        clientId: cfg.clientId ?? `compliance-core-${profile.id.slice(0, 8)}`,
        reconnectPeriod: 1000,     // mqtt.js backs off internally
        connectTimeout: 15_000,
        clean: true,
      });

      client.on('connect', () => {
        health.connected = true;
        // Subscribing to nothing is legitimate — a profile with no gateways yet.
        if (filters.length > 0) client!.subscribe(filters, { qos });
      });
      client.on('reconnect', () => { health.reconnectCount++; });
      client.on('close', () => { health.connected = false; });
      client.on('error', (err) => {
        health.lastError = err.message;
        health.lastErrorAt = new Date();
      });
      client.on('message', (topic, payload, packet) => {
        health.messagesReceived++;
        health.lastMessageAt = new Date();
        const sub = matchSubscription(topic);
        // No match ⇒ the message belongs to no known gateway. Emitted anyway with
        // empty anchors so the ingestion service dead-letters it as
        // UNROUTABLE_TOPIC. Dropping it here would hide a misconfiguration.
        void onMessage({
          protocolKey: 'mqtt', profileId, topic, payload,
          receivedAt: new Date(), qos: packet.qos, retained: packet.retain,
          gatewaySlug: sub?.gatewaySlug ?? '',
          gatewayId: sub?.gatewayId ?? '',
          baseTopic: sub?.baseTopic ?? '',
        }).catch((e: unknown) => {
          // A handler failure must never take down the connection. Record it and
          // keep consuming — one poison payload cannot be allowed to stop ingest.
          health.lastError = (e as Error).message;
          health.lastErrorAt = new Date();
        });
      });

      // Resolve once connected OR once the first connection attempt fails, so a
      // dead or rejecting broker does not hang API startup forever.
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        client!.once('connect', done);
        client!.once('error', done);
        setTimeout(done, 15_000);
      });
    },

    async stop() {
      if (!client) return;
      await new Promise<void>(r => client!.end(false, {}, () => r()));
      client = null;
      health.connected = false;
    },

    health: () => ({ ...health }),

    async publish(topic, payload, opts) {
      if (!client) throw new Error('MQTT adapter is not started.');
      await new Promise<void>((resolve, reject) => {
        client!.publish(
          topic, payload,
          { qos: (opts?.qos ?? 1) as 0 | 1 | 2, retain: opts?.retain ?? false },
          err => (err ? reject(err) : resolve()),
        );
      });
    },
  };
}
