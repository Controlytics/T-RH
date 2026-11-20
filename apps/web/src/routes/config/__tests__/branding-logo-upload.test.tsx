import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { brandingConfigSchema } from '@digilog/shared';

/**
 * 2026-11-20 (operator: "when im downloading a report its showing branded logo
 * error"): the stored Branding logo was a WebP, which a report cannot print, so
 * every report download was refused. The Branding page now
 *   - warns when the STORED logo cannot be printed, saying how to fix it;
 *   - saves any non-PNG / JPEG image chosen as a PNG (`printableLogoDataUrl`);
 *   - shows the "not an image" / "over 2MB" messages, which it used to put in a
 *     popup that never opened — choosing such a file did nothing on screen.
 */

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const WEBP = 'data:image/webp;base64,UklGRvS2AABXRUJQVlA4WAoAAAAQAAAA';

const mutate = vi.fn(async () => undefined);
const NULL_KEY = { data: undefined, error: undefined, mutate, isLoading: false, isValidating: false };
// Module-level constants: a fresh object per swr call re-runs the page's reset forever.
// Every field, through the schema — what `GET /api/config/branding` answers (`getConfig`).
const stored = (logoUrl: string) => brandingConfigSchema.parse({ appName: 'T&RH', companyName: 'Granules', logoText: 'TRH', logoUrl });
const STORED_WEBP = { data: stored(WEBP), error: undefined, mutate, isLoading: false, isValidating: false };
const STORED_PNG = { data: stored(PNG), error: undefined, mutate, isLoading: false, isValidating: false };
const state: { branding: typeof STORED_WEBP } = { branding: STORED_WEBP };

vi.mock('swr', () => ({
  default: (key: string | null) => (key === '/api/config/branding' ? state.branding : NULL_KEY),
  useSWRConfig: () => ({ mutate, cache: new Map() }),
  mutate,
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'me', username: 'superadmin', role: 'SUPER_ADMIN', permissions: [] } }),
}));
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: vi.fn(), isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }) }));
vi.mock('@/hooks/use-branding', () => ({ useBranding: () => ({ branding: { companyName: 'Brand Co', appName: 'Brand App' } }) }));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => ({})), put: vi.fn(), post: vi.fn(), putWithReauth: vi.fn(), postFormData: vi.fn() },
}));

/** The browser's decode + PNG encode, stubbed (jsdom has neither). */
class FakeImage {
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  naturalWidth = 0;
  naturalHeight = 0;
  set src(_v: string) {
    queueMicrotask(() => { this.naturalWidth = 1280; this.naturalHeight = 466; this.onload?.(); });
  }
}
const realCreate = document.createElement.bind(document);

beforeEach(() => {
  cleanup();
  state.branding = STORED_WEBP;
  vi.stubGlobal('Image', FakeImage);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, opts?: ElementCreationOptions) => {
    if (tag !== 'canvas') return realCreate(tag, opts);
    return { width: 0, height: 0, getContext: () => ({ drawImage: vi.fn() }), toDataURL: () => PNG };
  }) as typeof document.createElement);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function mount() {
  const { BrandingConfigPage } = await import('../branding');
  render(<MemoryRouter><BrandingConfigPage /></MemoryRouter>);
}
const fileInput = () => document.getElementById('logo-upload') as HTMLInputElement;
const save = () => screen.getByRole('button', { name: /save changes/i }) as HTMLButtonElement;
const choose = (file: File) => fireEvent.change(fileInput(), { target: { files: [file] } });

describe('Branding → Logo: a logo a report cannot print', () => {
  it('warns about a STORED WebP logo, and says how to fix it', async () => {
    await mount();
    expect(screen.getByTestId('logo-unprintable').textContent).toMatch(/Reports cannot print this logo.*Upload it again/s);
  });

  it('shows no warning for a stored PNG', async () => {
    state.branding = STORED_PNG;
    await mount();
    expect(screen.queryByTestId('logo-unprintable')).toBeNull();
  });

  it('a WebP chosen is SAVED AS A PNG: the warning goes, the preview is the PNG, Save is enabled', async () => {
    await mount();
    expect(save().disabled).toBe(true);
    choose(new File([new Uint8Array([0x52, 0x49, 0x46, 0x46])], 'logo.webp', { type: 'image/webp' }));
    await waitFor(() => expect(screen.queryByTestId('logo-unprintable')).toBeNull());
    expect(save().disabled).toBe(false);
    const shown = Array.from(document.querySelectorAll('img')).map((i) => i.getAttribute('src'));
    expect(shown).toContain(PNG);
    expect(shown).not.toContain(WEBP);
    expect(screen.queryByTestId('logo-error')).toBeNull();
  });

  it('a file that is not an image says so in the Logo card (it used to do nothing on screen)', async () => {
    await mount();
    choose(new File(['hello'], 'notes.txt', { type: 'text/plain' }));
    expect((await screen.findByTestId('logo-error')).textContent).toBe('Please select an image file');
    expect(save().disabled).toBe(true);
  });

  it('an image over 2MB says so in the Logo card', async () => {
    await mount();
    choose(new File([new Uint8Array(2 * 1024 * 1024 + 1)], 'big.png', { type: 'image/png' }));
    expect((await screen.findByTestId('logo-error')).textContent).toBe('Logo image must be less than 2MB');
  });
});
