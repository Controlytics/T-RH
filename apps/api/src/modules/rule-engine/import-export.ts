/**
 * ThingsBoard import / export for `/api/rule-chains` (spec §9, §12 ruling S-5).
 *
 * The shapes and the class mapping are `@digilog/shared`'s
 * (`toThingsboardExport` / `fromThingsboardExport`); this file adds the two
 * things only the server may decide: the CREDENTIAL MASK on every export, and
 * an import's refusal as a 400.
 *
 * The mask (ruling S-5, "masked in the editor and in exports as ThingsBoard
 * does"; ruling T2-3 on HOW): a deep copy of each node's configuration in
 * which every non-empty STRING whose key looks secret becomes `"***"`, and
 * every string inside a `credentials` object becomes `"***"` except its
 * `type`, `username`, `caCert` and `cert` (a public certificate and a user
 * name are not secrets). Objects are walked, never replaced — replacing
 * `credentials` with the string `"***"` would make the node fail its schema
 * and re-import as Unsupported. A masked value re-imports as `"***"` and the
 * editor asks for it again. The stored chain is never touched.
 */
import {
  toThingsboardExport, fromThingsboardExport,
  type RuleChainDocument, type ThingsboardRuleChainExport, type ThingsboardImportResult,
} from '@digilog/shared';
import { RuleChainError } from './service.js';

export const MASKED_SECRET = '***';

/** A key whose string value is a secret: passwords, secrets, tokens (botToken …), private and API keys, an Authorization header. */
const SECRET_KEY = /password|passphrase|secret|token|private[-_]?key|api[-_]?key|authorization|credentials/i;
/** Inside a `credentials` object, the strings that are NOT secret. */
const CREDENTIAL_PUBLIC_KEYS = new Set(['type', 'username', 'cacert', 'cert']);

function maskValue(value: unknown, insideCredentials: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => maskValue(v, insideCredentials));
  if (!value || typeof value !== 'object') return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    const secretKey = SECRET_KEY.test(key);
    if (typeof v === 'string') {
      const secret = insideCredentials ? !CREDENTIAL_PUBLIC_KEYS.has(key.toLowerCase()) : secretKey;
      out[key] = secret && v.length > 0 ? MASKED_SECRET : v;
    } else {
      out[key] = maskValue(v, insideCredentials || /^credentials$/i.test(key));
    }
  }
  return out;
}

/** A deep copy of a configuration with every secret string masked. */
export function maskSecrets<T>(config: T): T {
  return maskValue(config, false) as T;
}

/** The ThingsBoard export of a chain, every node's configuration masked. Never root on the wire unless it is. */
export function exportChain(chain: { name: string; root: boolean; debugMode: boolean; document: RuleChainDocument }): ThingsboardRuleChainExport {
  const exp = toThingsboardExport(chain.name, chain.root, chain.document);
  return {
    ...exp,
    ruleChain: { ...exp.ruleChain, debugMode: chain.debugMode },
    metadata: { ...exp.metadata, nodes: exp.metadata.nodes.map((n) => ({ ...n, configuration: maskSecrets(n.configuration) })) },
  };
}

/** `<name>.json`, safe in a Content-Disposition header (ASCII, no quotes or path characters). */
export function exportFileName(name: string): string {
  const base = name.normalize('NFKD').replace(/[^\x20-\x7e]/g, '').replace(/["\\/:*?<>|]+/g, '_').replace(/\s+/g, '_').trim();
  return `${base || 'rule_chain'}.json`;
}

/**
 * A ThingsBoard export (the object or its JSON text) as a document, or 400
 * IMPORT_INVALID with the reason. Every unknown class becomes an Unsupported
 * node with a warning (shared ruling T1-6); nothing here refuses a node.
 */
export function importChain(json: unknown): ThingsboardImportResult {
  try {
    return fromThingsboardExport(json);
  } catch (err) {
    throw new RuleChainError(400, 'IMPORT_INVALID', err instanceof Error ? err.message : 'The file is not a ThingsBoard rule chain export.');
  }
}
