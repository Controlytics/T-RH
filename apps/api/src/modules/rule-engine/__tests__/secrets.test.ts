import { describe, it, expect } from 'vitest';
import { fromThingsboardExport, type RuleChainDocument } from '@digilog/shared';
import {
  MASKED_SECRET, isSecretLeaf, isSecretValue, maskSecrets, maskDocumentSecrets, mergeMaskedSecrets, changedSecrets,
} from '../secrets.js';
import { exportChain } from '../import-export.js';

/**
 * secrets.ts — the ONE rule for what a credential is (rulings S-5, T2-B, T2-D),
 * widened by review B I-5 and the task-6b header minor (final fix wave, FW-N1):
 *  - KEY names: ThingsBoard's GCP Pub/Sub `serviceAccountKey`, Kafka's
 *    `sasl.jaas.config`, and the header names `x-auth-key` / `x-access-key` /
 *    `x-session-id`;
 *  - VALUES: a string holding a PEM PRIVATE KEY block or a service-account
 *    `"private_key"` is a secret under ANY key (a public certificate is not —
 *    ruling N1-6).
 * A not-built node imports with its configuration verbatim, so these leaves
 * reached every GET, export and audit row in plaintext before.
 */

const PRIVATE_KEY_PEM = '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\n';
const RSA_KEY_PEM = '-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\n-----END RSA PRIVATE KEY-----';
const CERT_PEM = '-----BEGIN CERTIFICATE-----\nMIIDdzCCAl+gAwIBAgIE\n-----END CERTIFICATE-----';
/** What a GCP service-account key file holds — ThingsBoard keeps it as ONE string (`TbPubSubNodeConfiguration.serviceAccountKey`). */
const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account', project_id: 'plant-1', private_key_id: 'abc123',
  private_key: PRIVATE_KEY_PEM, client_email: 'tb@plant-1.iam.gserviceaccount.com',
});

const GCP_CLASS = 'org.thingsboard.rule.engine.gcp.pubsub.TbPubSubNode';
const KAFKA_CLASS = 'org.thingsboard.rule.engine.kafka.TbKafkaNode';
const gcpConfig = () => ({
  projectId: 'plant-1', topicName: 'readings', messageAttributes: { site: 'A' },
  serviceAccountKey: SERVICE_ACCOUNT_JSON, serviceAccountKeyFileName: 'key.json',
});
const kafkaConfig = () => ({
  topicPattern: 'readings', bootstrapServers: 'kafka:9092', retries: 0, batchSize: 16384, linger: 0, bufferMemory: 33554432,
  acks: '-1', keySerializer: 'org.apache.kafka.common.serialization.StringSerializer',
  otherProperties: {
    'security.protocol': 'SASL_SSL',
    'sasl.mechanism': 'PLAIN',
    'sasl.jaas.config': 'org.apache.kafka.common.security.plain.PlainLoginModule required username="tb" password="hunter2";',
  },
  addMetadataKeyValuesAsKafkaHeaders: false, kafkaHeadersCharset: 'UTF-8',
});

/** ThingsBoard's export of a chain holding the two vendor nodes (both `none` here: they import as themselves). */
function importedVendorChain(): RuleChainDocument {
  const r = fromThingsboardExport({
    ruleChain: { name: 'Vendors' },
    metadata: {
      firstNodeIndex: null, connections: [],
      nodes: [
        { type: GCP_CLASS, name: 'To Pub/Sub', configuration: gcpConfig(), additionalInfo: { layoutX: 1, layoutY: 1 } },
        { type: KAFKA_CLASS, name: 'To Kafka', configuration: kafkaConfig(), additionalInfo: { layoutX: 2, layoutY: 2 } },
      ],
    },
  });
  expect(r.document.nodes.map((n) => n.type)).toEqual(['tb:external:gcp-pubsub', 'tb:external:kafka']);
  return r.document;
}

describe('secret KEY names (isSecretLeaf)', () => {
  it('a header named x-auth-key, x-access-key or x-session-id is a secret, in any case; x-request-id is not', () => {
    for (const k of ['x-auth-key', 'X-Auth-Key', 'x-access-key', 'X-ACCESS-KEY', 'x-session-id', 'X-Session-Id']) expect(isSecretLeaf(k, false), k).toBe(true);
    for (const k of ['x-request-id', 'content-type', 'x-correlation-id', 'host']) expect(isSecretLeaf(k, false), k).toBe(false);
  });

  it('ThingsBoard\'s serviceAccountKey and sasl.jaas.config are secrets; sasl.mechanism and security.protocol are not', () => {
    expect(isSecretLeaf('serviceAccountKey', false)).toBe(true);
    expect(isSecretLeaf('sasl.jaas.config', false)).toBe(true);
    expect(isSecretLeaf('sasl.mechanism', false)).toBe(false);
    expect(isSecretLeaf('security.protocol', false)).toBe(false);
    // `account key` is matched at the END of the name: the key file's name is not a secret.
    expect(isSecretLeaf('serviceAccountKeyFileName', false)).toBe(false);
    expect(isSecretLeaf('storage_account_key', false)).toBe(true);
  });

  it('the rules that were already there still hold (password, token, Authorization, private key, credentials)', () => {
    for (const k of ['password', 'proxyPassword', 'botToken', 'Authorization', 'privateKey', 'apiKey', 'secretAccessKey']) expect(isSecretLeaf(k, false), k).toBe(true);
    for (const k of ['username', 'host', 'topicPattern']) expect(isSecretLeaf(k, false), k).toBe(false);
    expect(isSecretLeaf('caCert', true)).toBe(false);
    expect(isSecretLeaf('cert', true)).toBe(false);
    expect(isSecretLeaf('privateKey', true)).toBe(true);
  });
});

describe('secret VALUES (isSecretValue) — ruling N1-6', () => {
  it('a PEM PRIVATE KEY block (any algorithm) or a service-account "private_key" is a secret', () => {
    expect(isSecretValue(PRIVATE_KEY_PEM)).toBe(true);
    expect(isSecretValue(RSA_KEY_PEM)).toBe(true);
    expect(isSecretValue('-----BEGIN ENCRYPTED PRIVATE KEY-----\nAAA\n-----END ENCRYPTED PRIVATE KEY-----')).toBe(true);
    expect(isSecretValue('-----BEGIN OPENSSH PRIVATE KEY-----\nb3Blbg==\n-----END OPENSSH PRIVATE KEY-----')).toBe(true);
    expect(isSecretValue(SERVICE_ACCOUNT_JSON)).toBe(true);
    // A service-account file whose key is escaped JSON text still names "private_key".
    expect(isSecretValue('{"type":"service_account","private_key":"MIIE..."}')).toBe(true);
  });

  it('a public certificate, a plain word and an empty string are not', () => {
    expect(isSecretValue(CERT_PEM)).toBe(false);
    expect(isSecretValue('-----BEGIN CERTIFICATE REQUEST-----\nAAA\n-----END CERTIFICATE REQUEST-----')).toBe(false);
    expect(isSecretValue('private key rotation is monthly')).toBe(false);
    expect(isSecretValue('')).toBe(false);
  });
});

describe('maskSecrets with the widened rule', () => {
  it('GCP Pub/Sub: the service-account key is "***"; project, topic, attributes and the key file NAME stay', () => {
    const out = maskSecrets(gcpConfig());
    expect(out.serviceAccountKey).toBe(MASKED_SECRET);
    expect(out).toMatchObject({ projectId: 'plant-1', topicName: 'readings', messageAttributes: { site: 'A' }, serviceAccountKeyFileName: 'key.json' });
    expect(JSON.stringify(out)).not.toMatch(/PRIVATE KEY|MIIEvQ|abc123/);
  });

  it('Kafka: sasl.jaas.config is "***"; the mechanism and the protocol stay readable', () => {
    const out = maskSecrets(kafkaConfig());
    expect(out.otherProperties).toEqual({ 'security.protocol': 'SASL_SSL', 'sasl.mechanism': 'PLAIN', 'sasl.jaas.config': MASKED_SECRET });
    expect(JSON.stringify(out)).not.toContain('hunter2');
  });

  it('a PRIVATE KEY under an innocuous key is masked by its VALUE, inside an object and inside an array; a certificate is not', () => {
    const out = maskSecrets({
      tlsMaterial: PRIVATE_KEY_PEM,
      nested: { pem: RSA_KEY_PEM, ca: CERT_PEM },
      chain: [CERT_PEM, PRIVATE_KEY_PEM, 'plain'],
      credentials: { type: 'cert.PEM', caCert: CERT_PEM, cert: CERT_PEM, privateKey: PRIVATE_KEY_PEM },
    });
    expect(out).toEqual({
      tlsMaterial: MASKED_SECRET,
      nested: { pem: MASKED_SECRET, ca: CERT_PEM },
      chain: [CERT_PEM, MASKED_SECRET, 'plain'],
      credentials: { type: 'cert.PEM', caCert: CERT_PEM, cert: CERT_PEM, privateKey: MASKED_SECRET },
    });
  });

  it('the GET / audit mask (maskDocumentSecrets) of an imported later / none GCP Pub/Sub and Kafka node shows "***"', () => {
    const stored = importedVendorChain();
    const masked = maskDocumentSecrets(stored);
    expect(masked.nodes[0].config.serviceAccountKey).toBe(MASKED_SECRET);
    expect((masked.nodes[1].config.otherProperties as Record<string, string>)['sasl.jaas.config']).toBe(MASKED_SECRET);
    expect(JSON.stringify(masked)).not.toMatch(/PRIVATE KEY|hunter2/);
    // The stored document is untouched.
    expect(stored.nodes[0].config.serviceAccountKey).toBe(SERVICE_ACCOUNT_JSON);
  });

  it('the EXPORT of that chain carries "***" for both, and nothing of either secret', () => {
    const exp = exportChain({ name: 'Vendors', root: false, debugMode: false, document: importedVendorChain() });
    const cfg = exp.metadata.nodes.map((n) => n.configuration as Record<string, any>);
    expect(cfg[0].serviceAccountKey).toBe(MASKED_SECRET);
    expect(cfg[1].otherProperties['sasl.jaas.config']).toBe(MASKED_SECRET);
    expect(cfg[1].otherProperties['sasl.mechanism']).toBe('PLAIN');
    expect(JSON.stringify(exp)).not.toMatch(/PRIVATE KEY|hunter2|abc123/);
  });
});

describe('a SCRIPT is code, never a secret value (ruling N1-13)', () => {
  const N = 'c0de0000-0000-4000-8000-0000000000bb';
  const SCRIPT = 'var k = msg["private_key"]; delete msg["private_key"];\nreturn {msg: msg, metadata: metadata, msgType: msgType};';
  const DETAILS = 'var d = {}; d["private_key"] = "-----BEGIN PRIVATE KEY-----"; return d;';
  const doc = (jsScript: string, details = DETAILS): RuleChainDocument => ({
    version: 1, firstNodeId: N, connections: [],
    nodes: [
      { id: N, type: 'tb:transformation:script', name: 'Strip key', debugMode: 'off', config: { scriptLang: 'JS', jsScript }, x: 0, y: 0 },
      { id: 'c0de0000-0000-4000-8000-0000000000bc', type: 'tb:action:create-alarm', name: 'Alarm', debugMode: 'off',
        config: { alarmType: 'A', severity: 'MAJOR', scriptLang: 'JS', alarmDetailsBuildJs: details, alarmDetailsBuildTbel: details }, x: 0, y: 0 },
    ],
  });

  it('a script that mentions "private_key" (or even a PEM header) stays readable through the GET / audit mask, the export and the merge', () => {
    const stored = doc(SCRIPT);
    expect(maskSecrets(stored.nodes[0].config)).toEqual({ scriptLang: 'JS', jsScript: SCRIPT });
    const masked = maskDocumentSecrets(stored);
    expect(masked.nodes[0].config.jsScript).toBe(SCRIPT);
    expect(masked.nodes[1].config.alarmDetailsBuildJs).toBe(DETAILS);
    expect(masked.nodes[1].config.alarmDetailsBuildTbel).toBe(DETAILS);
    const exp = exportChain({ name: 'S', root: false, debugMode: false, document: stored });
    expect((exp.metadata.nodes[0].configuration as Record<string, unknown>).jsScript).toBe(SCRIPT);
    expect((exp.metadata.nodes[1].configuration as Record<string, unknown>).alarmDetailsBuildJs).toBe(DETAILS);
    // An edited script is a change of logic, not of a secret: the audit's secretsChanged lists nothing.
    expect(changedSecrets(stored, doc(`${SCRIPT}\n// edited`, `${DETAILS} // edited`))).toEqual([]);
    // A script typed as "***" is that text — nothing stored is put back over it, and nothing is "unresolved".
    const merged = mergeMaskedSecrets(doc(MASKED_SECRET), stored);
    expect((merged.document as RuleChainDocument).nodes[0].config.jsScript).toBe(MASKED_SECRET);
    expect(merged.unresolved).toEqual([]);
  });
});

describe('the merge on a save / import keeps a value-masked secret', () => {
  const N = 'c0de0000-0000-4000-8000-0000000000aa';
  const doc = (config: Record<string, unknown>): RuleChainDocument => ({
    version: 1, firstNodeId: N, connections: [],
    nodes: [{ id: N, type: 'tb:external:kafka', name: 'K', debugMode: 'off', config, x: 0, y: 0 }],
  });

  it('a PRIVATE KEY under an innocuous key, masked on GET and sent back as "***", keeps the stored key', () => {
    const stored = doc({ tlsMaterial: PRIVATE_KEY_PEM, chain: ['x', RSA_KEY_PEM] });
    const sentBack = maskDocumentSecrets(stored);
    expect(sentBack.nodes[0].config).toEqual({ tlsMaterial: MASKED_SECRET, chain: ['x', MASKED_SECRET] });
    const merged = mergeMaskedSecrets(JSON.parse(JSON.stringify(sentBack)), stored);
    expect((merged.document as RuleChainDocument).nodes[0].config).toEqual({ tlsMaterial: PRIVATE_KEY_PEM, chain: ['x', RSA_KEY_PEM] });
    expect(merged.unresolved).toEqual([]);
  });

  it('the same for the widened KEY names: serviceAccountKey and sasl.jaas.config come back as stored', () => {
    const stored = importedVendorChain();
    const merged = mergeMaskedSecrets(JSON.parse(JSON.stringify(maskDocumentSecrets(stored))), stored);
    expect((merged.document as RuleChainDocument).nodes.map((n) => n.config)).toEqual(stored.nodes.map((n) => n.config));
    expect(merged.unresolved).toEqual([]);
  });

  it('an import (nothing stored) reports a "***" under a secret KEY as a credential to enter', () => {
    const exp = exportChain({ name: 'Vendors', root: false, debugMode: false, document: importedVendorChain() });
    const again = fromThingsboardExport(JSON.parse(JSON.stringify(exp)));
    const { unresolved } = mergeMaskedSecrets(again.document, null);
    expect(unresolved.map((u) => [u.nodeName, u.paths])).toEqual([
      ['To Pub/Sub', ['serviceAccountKey']],
      ['To Kafka', ['otherProperties.sasl.jaas.config']],
    ]);
  });

  it('changedSecrets names a value-secret that changed, and not one that did not', () => {
    const before = doc({ tlsMaterial: PRIVATE_KEY_PEM, note: 'a' });
    const after = doc({ tlsMaterial: RSA_KEY_PEM, note: 'b' });
    expect(changedSecrets(before, after)).toEqual(['Node "K": tlsMaterial']);
    expect(changedSecrets(before, doc({ tlsMaterial: PRIVATE_KEY_PEM, note: 'b' }))).toEqual([]);
    // An array element has no key: its value alone makes it a secret.
    expect(changedSecrets(doc({ chain: ['x', PRIVATE_KEY_PEM] }), doc({ chain: ['x', RSA_KEY_PEM] }))).toEqual(['Node "K": chain[1]']);
  });
});
