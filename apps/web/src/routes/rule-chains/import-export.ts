import { apiClient } from '@/lib/api-client';

/**
 * ThingsBoard JSON in and out (rule chains, 2026-11-04).
 *
 * The browser converts nothing: an import sends the file's JSON to `POST
 * /api/rule-chains/import`, which maps ThingsBoard's classes onto this
 * system's node types and answers with the warnings; an export downloads `GET
 * /api/rule-chains/:id/export`, which the server writes in ThingsBoard's
 * shape with every credential masked.
 */

export class ImportFileError extends Error {}

/** The largest file the picker reads (a 300-node chain with scripts is well under it). */
export const IMPORT_MAX_BYTES = 5 * 1024 * 1024;

function readText(file: Blob): Promise<string> {
  if (typeof file.text === 'function') return file.text();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('The file could not be read.'));
    reader.readAsText(file);
  });
}

/**
 * The file as JSON, and the chain name ThingsBoard wrote in it (to prefill the
 * name box). Not JSON, or not a ThingsBoard rule chain export at all, is an
 * {@link ImportFileError} with a sentence for the dialog; everything finer
 * (node classes, configs) is the server's to judge.
 */
export async function readImportFile(file: File): Promise<{ json: unknown; name: string | null }> {
  if (file.size > IMPORT_MAX_BYTES) throw new ImportFileError('The file is larger than 5 MB. It is not a rule chain export.');
  let json: unknown;
  try {
    json = JSON.parse(await readText(file));
  } catch {
    throw new ImportFileError('The file is not JSON. Choose a ThingsBoard rule chain export (.json).');
  }
  const meta = (json as { metadata?: { nodes?: unknown } } | null)?.metadata;
  if (!meta || !Array.isArray(meta.nodes)) {
    throw new ImportFileError('The file is JSON but not a ThingsBoard rule chain export: it has no metadata.nodes list.');
  }
  const name = (json as { ruleChain?: { name?: unknown } }).ruleChain?.name;
  return { json, name: typeof name === 'string' && name.trim() !== '' ? name.trim() : null };
}

/** `attachment; filename="x.json"` → `x.json`; anything else → `<fallback>.json`. */
export function exportFileName(contentDisposition: string | null, fallback: string): string {
  const quoted = contentDisposition?.match(/filename="([^"]+)"/i)?.[1];
  const bare = contentDisposition?.match(/filename=([^;]+)/i)?.[1]?.trim();
  const name = quoted || bare;
  if (name) return name;
  const safe = fallback.replace(/[^A-Za-z0-9 ._-]+/g, '_').trim() || 'rule-chain';
  return `${safe}.json`;
}

/** Downloads the server's export of one chain, under the file name the server gave it. */
export async function downloadChainExport(id: string, fallbackName: string): Promise<string> {
  const res = await apiClient.getRaw(`/api/rule-chains/${id}/export`);
  const blob = await res.blob();
  const filename = exportFileName(res.headers.get('Content-Disposition'), fallbackName);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return filename;
}
