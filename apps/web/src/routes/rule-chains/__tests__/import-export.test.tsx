import { describe, it, expect, vi, afterEach } from 'vitest';

/**
 * ThingsBoard JSON in and out (rule chains, 2026-11-04). The browser only
 * checks a file IS a rule chain export (and reads its name); the server maps
 * it. The export is the server's file, under the server's file name.
 */

const getRaw = vi.fn();
vi.mock('@/lib/api-client', () => ({ apiClient: { getRaw: (...a: unknown[]) => getRaw(...a) } }));

const { readImportFile, exportFileName, downloadChainExport, ImportFileError, IMPORT_MAX_BYTES } = await import('../import-export');

const file = (text: string, name = 'chain.json') => new File([text], name, { type: 'application/json' });

describe('readImportFile', () => {
  it('reads a ThingsBoard export and its chain name', async () => {
    const json = { ruleChain: { name: ' Root Rule Chain ' }, metadata: { firstNodeIndex: 0, nodes: [], connections: [] } };
    await expect(readImportFile(file(JSON.stringify(json)))).resolves.toEqual({ json, name: 'Root Rule Chain' });
  });

  it('an export without a chain name reads with name null', async () => {
    await expect(readImportFile(file('{"metadata":{"nodes":[]}}'))).resolves.toMatchObject({ name: null });
  });

  it('refuses a file that is not JSON', async () => {
    await expect(readImportFile(file('<xml/>'))).rejects.toThrow(/not JSON/);
    await expect(readImportFile(file('<xml/>'))).rejects.toBeInstanceOf(ImportFileError);
  });

  it('refuses JSON that is not a rule chain export', async () => {
    await expect(readImportFile(file('{"nodes":[]}'))).rejects.toThrow(/no metadata.nodes/);
    await expect(readImportFile(file('[1,2]'))).rejects.toThrow(/no metadata.nodes/);
  });

  it('refuses a file over the size cap without reading it', async () => {
    const big = { size: IMPORT_MAX_BYTES + 1, text: vi.fn() } as unknown as File;
    await expect(readImportFile(big)).rejects.toThrow(/larger than 5 MB/);
    expect((big as unknown as { text: ReturnType<typeof vi.fn> }).text).not.toHaveBeenCalled();
  });
});

describe('exportFileName', () => {
  it('takes the server\'s file name', () => {
    expect(exportFileName('attachment; filename="Root_Rule_Chain.json"', 'x')).toBe('Root_Rule_Chain.json');
    expect(exportFileName('attachment; filename=plain.json', 'x')).toBe('plain.json');
  });

  it('falls back to a safe name of the chain', () => {
    expect(exportFileName(null, 'Cold room / alarms')).toBe('Cold room _ alarms.json');
    expect(exportFileName(null, '///')).toBe('_.json');
  });
});

describe('downloadChainExport', () => {
  afterEach(() => vi.restoreAllMocks());

  it('downloads GET /:id/export under the server\'s name', async () => {
    getRaw.mockResolvedValue({ blob: async () => new Blob(['{}']), headers: { get: () => 'attachment; filename="Alarms.json"' } });
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    const names: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    await expect(downloadChainExport('c-2', 'Alarms')).resolves.toBe('Alarms.json');
    expect(getRaw).toHaveBeenCalledWith('/api/rule-chains/c-2/export');
    expect(names).toEqual(['Alarms.json']);
  });
});
