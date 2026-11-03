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
  toThingsboardExport, fromThingsboardExport,
  type RuleChainDocument, type ThingsboardRuleChainExport, type ThingsboardImportResult,
} from '@digilog/shared';
import { RuleChainError } from './service.js';
import { maskSecrets, mergeMaskedSecrets, unresolvedSecretWarnings } from './secrets.js';

export { MASKED_SECRET, maskSecrets } from './secrets.js';

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
