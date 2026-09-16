import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

/**
 * The bulk-upload template (2026-09-16, operator: "in bulk upload template
 * only attributes display names should come"). The file is headed by `code`
 * and then the chosen profile's attributes — each under its administered
 * DISPLAY NAME, the key itself where none is set — headed as the template
 * prints it: `Instrument ID`, then the attributes. No `name` column: the create
 * form has set name = code since the trim, and the importer now does the same.
 */
const PROFILES = { data: [{ id: 'p-1', name: 'T&RH Sensors' }, { id: 'p-2', name: 'Empty' }] };
const PROFILE_KEYS: Record<string, string> = { 'p-1': 'Building\nEnable_Temp_NMT\nRoom', 'p-2': '' };
const LABELS = { current: {} as Record<string, string> };

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/instrument-profiles') return { data: PROFILES };
    if (typeof key === 'string' && key.startsWith('/api/instrument-profiles/')) {
      const id = key.slice('/api/instrument-profiles/'.length);
      return { data: { id, attributeKeys: PROFILE_KEYS[id] ?? '' } };
    }
    if (key === '/api/config/attribute-labels/current') return { data: { labels: LABELS.current } };
    return { data: undefined };
  },
}));
vi.mock('@/lib/api-client', () => ({ apiClient: { post: vi.fn(), get: vi.fn(), put: vi.fn(), delete: vi.fn() } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

const { InstrumentBulkCreatePage } = await import('../bulk-create');

/** Captures what `download()` would have saved, by reading the Blob it made. */
const saved: { name: string; text: Promise<string> }[] = [];
beforeEach(() => {
  saved.length = 0;
  LABELS.current = {};
  vi.stubGlobal('URL', {
    ...URL,
    // jsdom's Blob has no `.text()`; FileReader is what it does implement.
    createObjectURL: (blob: Blob) => {
      const text = new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result ?? ''));
        r.onerror = () => reject(r.error);
        r.readAsText(blob);
      });
      saved.push({ name: '', text });
      return 'blob:x';
    },
    revokeObjectURL: () => undefined,
  });
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    if (saved.length) saved[saved.length - 1].name = this.download;
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const renderPage = (search = '') => render(
  <MemoryRouter initialEntries={[`/instruments/bulk${search}`]}><InstrumentBulkCreatePage /></MemoryRouter>,
);
const choose = (id: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: /profile/i }), { target: { value: id } });
const downloadTemplate = () => fireEvent.click(screen.getByRole('button', { name: /download template/i }));

describe('InstrumentBulkCreatePage — the template', () => {
  it('is headed by Instrument ID and the profile attributes under their DISPLAY NAMES, no name column', async () => {
    LABELS.current = { Enable_Temp_NMT: 'High temperature alarm enabled', Room: 'Cleanroom number' };
    renderPage();
    choose('p-1');
    downloadTemplate();
    await waitFor(() => expect(saved).toHaveLength(1));
    const text = await saved[0].text;
    const [header, sample] = text.split('\n');
    expect(header).toBe('Instrument ID,Building,High temperature alarm enabled,Cleanroom number');
    expect(sample.startsWith('CWH/RDU/001-00,')).toBe(true);
    expect(saved[0].name).toBe('instrument-template.csv');
  });

  it('falls back to the key as the heading when no display name is set', async () => {
    renderPage();
    choose('p-1');
    downloadTemplate();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect((await saved[0].text).split('\n')[0]).toBe('Instrument ID,Building,Enable_Temp_NMT,Room');
  });

  it('is just the Instrument ID column for a profile that asks for no attributes', async () => {
    renderPage();
    choose('p-2');
    downloadTemplate();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect((await saved[0].text).split('\n')[0]).toBe('Instrument ID');
  });

  it('cannot be downloaded before a profile is chosen — the columns depend on it', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /download template/i })).toBeDisabled();
  });

  it('uses the preset profile from the URL', async () => {
    LABELS.current = { Room: 'Cleanroom number' };
    renderPage('?profileId=p-1');
    downloadTemplate();
    await waitFor(() => expect(saved).toHaveLength(1));
    expect((await saved[0].text).split('\n')[0]).toBe('Instrument ID,Building,Enable_Temp_NMT,Cleanroom number');
  });
});
