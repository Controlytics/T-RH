import { mergeMaskedSecrets } from '../../secrets.js';

/**
 * A credential that was MASKED on export (rule chains, 2026-11-03; spec §12
 * ruling S-5, Task 2 ruling T2-B). An imported chain keeps every secret leaf
 * that arrived as `"***"` when nothing was stored to put back; a node holding
 * one must not send `"***"` as a password or a token.
 *
 * WHICH leaves are secrets is `secrets.ts`'s ONE rule — the same one that
 * masked them — so this cannot disagree with the export about a field:
 * `credentials.password`, `credentials.privateKey`, `headers.Authorization`,
 * `botToken` …
 *
 * Returns the paths of every secret leaf that is exactly `"***"`, in the
 * configuration's own order; `[]` when nothing is masked.
 */
export function maskedSecretPaths(config: Record<string, unknown>): string[] {
  const { unresolved } = mergeMaskedSecrets({ nodes: [{ id: '', type: '', name: '', config }] }, null);
  return unresolved[0]?.paths ?? [];
}

/** `CREDENTIAL_NOT_SET: <path>[, <path>…]` — the message ends on Failure with this, before anything is sent. */
export function credentialNotSetError(paths: string[]): Error {
  return new Error(`CREDENTIAL_NOT_SET: ${paths.join(', ')}`);
}
