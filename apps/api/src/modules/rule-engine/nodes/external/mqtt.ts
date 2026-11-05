import type { RuleNodeHandler } from '../../context.js';
import type { RuleNodeLifecycle } from '../../registry.js';
import type { RuleMqttConfig } from '../../services.js';
import { processPattern } from '../action/support.js';
import { messageText } from './template.js';
import { maskedSecretPaths, credentialNotSetError } from './credentials.js';

export const MQTT_TYPE = 'tb:external:mqtt';

/** ThingsBoard's `TbMqttNodeConfiguration`, as the catalogue models it. */
export interface MqttNodeConfig {
  topicPattern: string;
  host?: string | null;
  port: number;
  connectTimeoutSec?: number;
  clientId?: string | null;
  appendClientIdSuffix?: boolean;
  cleanSession?: boolean;
  retainedMessage?: boolean;
  ssl?: boolean;
  parseToPlainText?: boolean;
  protocolVersion?: 'MQTT_3_1' | 'MQTT_3_1_1' | 'MQTT_5';
  credentials?: { type?: string; username?: string; password?: string; caCert?: string; cert?: string; privateKey?: string } | null;
}

/** The catalogue's protocol names → MQTT's protocol level (3 = 3.1, 4 = 3.1.1, 5 = 5). */
const PROTOCOL_LEVEL: Readonly<Record<string, number>> = { MQTT_3_1: 3, MQTT_3_1_1: 4, MQTT_5: 5 };

/** ThingsBoard publishes every message at AT_LEAST_ONCE; its node has no QoS setting (catalogue ruling, Task 1). */
export const MQTT_NODE_QOS = 1 as const;

/** The node's configuration in the shape `services.mqtt` takes. Credentials the type does not use are not passed. */
export function mqttServiceConfig(cfg: MqttNodeConfig): RuleMqttConfig {
  const c = cfg.credentials ?? { type: 'anonymous' };
  const credentials: RuleMqttConfig['credentials'] =
    c.type === 'basic' ? { type: 'basic', username: c.username, password: c.password }
      : c.type === 'cert.PEM' ? {
        type: 'cert.PEM', caCert: c.caCert, cert: c.cert, privateKey: c.privateKey,
        // ThingsBoard's CertPemCredentials calls the private key's passphrase `password`.
        privateKeyPassword: c.password,
      }
        : { type: 'anonymous' };
  return {
    host: (cfg.host ?? '').trim(),
    port: cfg.port,
    ...(cfg.clientId ? { clientId: cfg.clientId } : {}),
    appendClientIdSuffix: cfg.appendClientIdSuffix === true,
    ...(typeof cfg.connectTimeoutSec === 'number' ? { connectTimeoutSec: cfg.connectTimeoutSec } : {}),
    cleanSession: cfg.cleanSession !== false,
    ssl: cfg.ssl === true,
    protocolVersion: PROTOCOL_LEVEL[cfg.protocolVersion ?? 'MQTT_3_1_1'] ?? 4,
    credentials,
  };
}

/**
 * MQTT (`TbMqttNode`; spec §6). Publishes the message data — JSON, or a
 * string unquoted with `parseToPlainText` — to the TEMPLATED topic at QoS 1,
 * retained when `retainedMessage`. One client per node, made lazily by
 * `services.mqtt`, keyed by `ctx.nodeKey` (`<chain>:<node>` — two chains may
 * share node ids), rebuilt when the configuration changes, closed on the
 * node's destroy. `Success` once the broker has the publish; `Failure` with
 * `metadata.error` when the host is missing, the broker cannot be reached or
 * refuses it, or a credential arrived masked (`CREDENTIAL_NOT_SET`, checked
 * here before any connection — the service checks again).
 */
export const mqttHandler: RuleNodeHandler<MqttNodeConfig> = async (ctx, msg) => {
  const cfg = ctx.config;
  const masked = maskedSecretPaths(cfg as unknown as Record<string, unknown>);
  if (masked.length > 0) return ctx.tellFailure(msg, credentialNotSetError(masked));
  try {
    const topic = processPattern(cfg.topicPattern, msg);
    const payload = messageText(msg.data, cfg.parseToPlainText === true);
    await ctx.services.mqtt.publish(ctx.nodeKey, mqttServiceConfig(cfg), topic, payload, MQTT_NODE_QOS, cfg.retainedMessage === true);
  } catch (err) {
    return ctx.tellFailure(msg, err);
  }
  ctx.tellNext(msg, 'Success');
};

/** The client is the node's for as long as the node exists. */
export const mqttLifecycle: RuleNodeLifecycle<MqttNodeConfig> = {
  async onDestroy(ctx) {
    await ctx.services.mqtt.close(ctx.nodeKey);
  },
};
