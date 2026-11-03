/**
 * Credentials in a rule chain's node configurations (rule chains, 2026-11-03;
 * spec §12 ruling S-5; Task 2 rulings T2-3 and T2-B).
 *
 * ONE rule decides what a secret is, and every path uses it — the export, the
 * read for a caller without RULE_CHAIN_MANAGE, the audit values, and the merge
 * on a save or an import. The four cannot disagree about which value is
 * hidden and which one is put back.
 *
 * A SECRET LEAF is a STRING:
 *   - outside a `credentials` object: whose key matches `SECRET_KEY`
 *     (password, passphrase, secret, token — botToken —, private key, API key,
 *     an Authorization header);
 *   - inside a `credentials` object (MQTT / REST's ThingsBoard shape): any
 *     string except `type`, `username`, `caCert` and `cert` (a user name and a
 *     public certificate are not secrets).
 * Objects and arrays are WALKED, never replaced: replacing `credentials` with
 * the string "***" would make the node fail its schema and re-import as
 * Unsupported.
 *
 * MASKING turns every non-empty secret leaf into "***" on a deep copy; the
 * stored document is never touched. MERGING (a save or an import) puts the
 * value stored for the SAME node id and type back wherever a secret leaf
 * arrives as exactly "***"; with nothing stored it stays "***" and is reported
 * as unresolved (the node refuses it at run time — Task 6).
 */
import type { RuleChainDocument, RuleChainNode } from '@digilog/shared';

export const MASKED_SECRET = '***';

const SECRET_KEY = /password|passphrase|secret|token|private[-_]?key|api[-_]?key|authorization|credentials/i;
const CREDENTIAL_PUBLIC_KEYS = new Set(['type', 'username', 'cacert', 'cert']);
const isCredentials = (key: string) => /^credentials$/i.test(key);

/** Is the string under `key` a secret? */
export function isSecretLeaf(key: string, insideCredentials: boolean): boolean {
  return insideCredentials ? !CREDENTIAL_PUBLIC_KEYS.has(key.toLowerCase()) : SECRET_KEY.test(key);
}

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function maskValue(value: unknown, inside: boolean): unknown {
  if (Array.isArray(value)) return value.map((v) => maskValue(v, inside));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = typeof v === 'string'
      ? (isSecretLeaf(key, inside) && v.length > 0 ? MASKED_SECRET : v)
      : maskValue(v, inside || isCredentials(key));
  }
  return out;
}

/** A deep copy of a configuration with every non-empty secret leaf as "***". */
export function maskSecrets<T>(config: T): T {
  return maskValue(config, false) as T;
}

/** The document with every node's configuration masked — what a caller without RULE_CHAIN_MANAGE reads. */
export function maskDocumentSecrets(doc: RuleChainDocument): RuleChainDocument {
  return { ...doc, nodes: doc.nodes.map((n) => ({ ...n, config: maskSecrets(n.config) })) };
}

/** Every secret leaf of a configuration: path → value. */
function secretLeaves(value: unknown, inside: boolean, path: string, out: Map<string, string>): void {
  if (Array.isArray(value)) {
    value.forEach((v, i) => secretLeaves(v, inside, `${path}[${i}]`, out));
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, v] of Object.entries(value)) {
    const p = path ? `${path}.${key}` : key;
    if (typeof v === 'string') {
      if (isSecretLeaf(key, inside)) out.set(p, v);
    } else {
      secretLeaves(v, inside || isCredentials(key), p, out);
    }
  }
}

/**
 * The secret leaves whose value differs between two versions of a chain, as
 * `Node "<name>": <path>` — what an UPDATED audit row records in place of the
 * values themselves (which it masks).
 */
export function changedSecrets(before: RuleChainDocument, after: RuleChainDocument): string[] {
  const leaves = (doc: RuleChainDocument) => {
    const out = new Map<string, { name: string; value: string }>();
    for (const n of doc.nodes) {
      const m = new Map<string, string>();
      secretLeaves(n.config, false, '', m);
      for (const [p, v] of m) out.set(`${n.id}\u0000${p}`, { name: n.name, value: v });
    }
    return out;
  };
  const a = leaves(before);
  const b = leaves(after);
  const changed: string[] = [];
  for (const key of new Set([...a.keys(), ...b.keys()])) {
    const x = a.get(key);
    const y = b.get(key);
    if (x?.value === y?.value) continue;
    changed.push(`Node "${(y ?? x)!.name}": ${key.split('\u0000')[1]}`);
  }
  return changed.sort();
}

function mergeValue(incoming: unknown, stored: unknown, inside: boolean, path: string, unresolved: string[]): unknown {
  if (Array.isArray(incoming)) {
    return incoming.map((v, i) => mergeValue(v, Array.isArray(stored) ? stored[i] : undefined, inside, `${path}[${i}]`, unresolved));
  }
  if (!isPlainObject(incoming)) return incoming;
  const from = isPlainObject(stored) ? stored : undefined;
  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(incoming)) {
    const p = path ? `${path}.${key}` : key;
    const s = from?.[key];
    if (typeof v === 'string') {
      if (v === MASKED_SECRET && isSecretLeaf(key, inside)) {
        if (typeof s === 'string' && s.length > 0 && s !== MASKED_SECRET) {
          out[key] = s;
        } else {
          out[key] = v;
          unresolved.push(p);
        }
      } else {
        out[key] = v;
      }
    } else {
      out[key] = mergeValue(v, s, inside || isCredentials(key), p, unresolved);
    }
  }
  return out;
}

/** A secret that arrived as "***" with nothing stored to put back. */
export interface UnresolvedSecret {
  nodeId: string;
  nodeName: string;
  paths: string[];
}

/**
 * A document AS SENT (raw — not yet strictly parsed) with every secret leaf
 * that arrived as exactly "***" replaced by the value stored for the same node
 * id AND type at the same path. A node whose id is new, or whose type changed,
 * has nothing to inherit: its "***" stays and the node is reported. Anything
 * that is not document-shaped is returned as it came, for the strict parse to
 * refuse.
 */
export function mergeMaskedSecrets(incoming: unknown, stored: RuleChainDocument | null): { document: unknown; unresolved: UnresolvedSecret[] } {
  if (!isPlainObject(incoming) || !Array.isArray(incoming.nodes)) return { document: incoming, unresolved: [] };
  const storedById = new Map<string, RuleChainNode>((stored?.nodes ?? []).map((n) => [n.id, n]));
  const unresolved: UnresolvedSecret[] = [];
  const nodes = incoming.nodes.map((node: unknown) => {
    if (!isPlainObject(node) || !isPlainObject(node.config)) return node;
    const id = typeof node.id === 'string' ? node.id : '';
    const prior = storedById.get(id);
    const inherit = prior && prior.type === node.type ? prior.config : undefined;
    const paths: string[] = [];
    const config = mergeValue(node.config, inherit, false, '', paths);
    if (paths.length > 0) {
      const name = typeof node.name === 'string' && node.name.trim() ? node.name.trim() : id || 'Unnamed node';
      unresolved.push({ nodeId: id, nodeName: name, paths });
    }
    return { ...node, config };
  });
  return { document: { ...incoming, nodes }, unresolved };
}

/** One warning per node whose credential must be entered again, for an import's `warnings`. */
export function unresolvedSecretWarnings(unresolved: readonly UnresolvedSecret[]): string[] {
  return unresolved.map((u) =>
    `Node "${u.nodeName}": credential must be entered (${u.paths.join(', ')}) — it was masked as "${MASKED_SECRET}" on export.`);
}
