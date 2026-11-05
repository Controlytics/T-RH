/**
 * ThingsBoard import / export for `/api/rule-chains` (spec §9, §12 ruling S-5).
 *
 * The shapes and the class mapping are `@digilog/shared`'s
 * (`toThingsboardExport` / `fromThingsboardExport`); this file adds what only
 * the server may decide: the CREDENTIAL MASK on every export, and an import's
 * refusal as a 400. What a secret is, the mask and the merge back on a save or
 * an import are ONE rule in `secrets.ts` (rulings T2-3, T2-B). The stored chain
 * is never touched by the mask.
 */
import {
  toThingsboardExport, fromThingsboardExport, RULE_NODE_TYPE_BY_TB_CLASS, THINGSBOARD_EXPORT_NOTES_HEADER,
  type RuleChainDocument, type ThingsboardRuleChainExport, type ThingsboardImportResult,
} from '@digilog/shared';
import { RuleChainError } from './service.js';
import { maskSecrets, mergeMaskedSecrets, unresolvedSecretWarnings } from './secrets.js';

export { MASKED_SECRET, maskSecrets } from './secrets.js';

/**
 * The ThingsBoard export of a chain, every node's configuration masked. Never root on the wire unless it is.
 *
 * The rule chain's Description (`additionalInfo.description`, ruling SW-2) also names every node whose
 * credential went out as "***" — one line per node after the shared notes, each masked path named
 * (FW-N1 open item 3): the mask is applied HERE, after the shared export, so the shared notes cannot see
 * it. Only a leaf the mask TURNED into "***" is named; one already "***" (never entered here) was no
 * stored credential. `additionalInfo` stays `{ description } | null` (contract C5).
 */
export function exportChain(chain: { name: string; root: boolean; debugMode: boolean; document: RuleChainDocument }): ThingsboardRuleChainExport {
  const exp = toThingsboardExport(chain.name, chain.root, chain.document);
  const credentialNotes: string[] = [];
  const nodes = exp.metadata.nodes.map((n) => {
    const configuration = maskSecrets(n.configuration);
    const paths: string[] = [];
    maskedPaths(n.configuration, configuration, '', paths);
    if (paths.length > 0) {
      credentialNotes.push(`- Node "${n.name}" (${exportedNodeLabel(n.type)}): set ${paths.join(', ')} after import — this system never exports a stored credential.`);
    }
    return { ...n, configuration };
  });
  const shared = exp.ruleChain.additionalInfo?.description;
  const description = credentialNotes.length === 0 ? shared ?? null
    : [shared ?? THINGSBOARD_EXPORT_NOTES_HEADER, ...credentialNotes].join('\n');
  return {
    ...exp,
    ruleChain: { ...exp.ruleChain, debugMode: chain.debugMode, additionalInfo: description === null ? null : { description } },
    metadata: { ...exp.metadata, nodes },
  };
}

/** Every string leaf the mask changed (it became "***"): `a.b`, `a[0]` — the paths secrets.ts reports. */
function maskedPaths(before: unknown, after: unknown, path: string, out: string[]): void {
  if (typeof before === 'string') {
    if (after !== before) out.push(path);
    return;
  }
  if (Array.isArray(before)) {
    if (Array.isArray(after)) before.forEach((v, i) => maskedPaths(v, after[i], `${path}[${i}]`, out));
    return;
  }
  if (before === null || typeof before !== 'object' || after === null || typeof after !== 'object' || Array.isArray(after)) return;
  for (const [key, v] of Object.entries(before)) maskedPaths(v, (after as Record<string, unknown>)[key], path ? `${path}.${key}` : key, out);
}

/** An exported node's label: the catalogue's, by ThingsBoard class; an unknown class by its own name. */
function exportedNodeLabel(tbClass: string): string {
  return RULE_NODE_TYPE_BY_TB_CLASS.get(tbClass)?.label ?? tbClass.slice(tbClass.lastIndexOf('.') + 1);
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
 *
 * An import makes a NEW chain with new node ids, so a credential masked on
 * export ("***") has nothing stored to come back from: it stays "***" and the
 * node is named in `warnings` — "credential must be entered" (ruling T2-B).
 */
export function importChain(json: unknown): ThingsboardImportResult {
  let result: ThingsboardImportResult;
  try {
    result = fromThingsboardExport(json);
  } catch (err) {
    throw new RuleChainError(400, 'IMPORT_INVALID', err instanceof Error ? err.message : 'The file is not a ThingsBoard rule chain export.');
  }
  const { unresolved } = mergeMaskedSecrets(result.document, null);
  return { ...result, warnings: [...result.warnings, ...unresolvedSecretWarnings(unresolved)] };
}
