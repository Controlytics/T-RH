import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import type { ReactElement } from 'react';

/**
 * Performance audit 2026-11-17, G4-01 (CRITICAL): a configuration form whose GET
 * FAILED stayed on screen holding its DEFAULTS, and Save wrote them over the
 * stored settings (reproduced: Telemetry Retention 36 → 12 months). On LDAP,
 * User ID, Pagination and Export Options Save did not even need an edit; on
 * Action Re-authentication one tick + Save switched re-authentication off for
 * every other action.
 *
 * Every page here is mounted with each fetch FAILING, then with each fetch still
 * PENDING, and must offer no enabled Save in either state; a failure must say so
 * and offer Try again (`components/ui/settings-load-gate.tsx`).
 */

const FAILED = new Error('The database is not answering right now.');
const mutate = vi.fn(async () => undefined);
const state: { mode: 'error' | 'loading'; overrides: Record<string, unknown> } = { mode: 'error', overrides: {} };
const MANIFEST = [{
  moduleKey: 'telemetry-retention', moduleName: 'Telemetry Retention', description: '', icon: '', category: 'system',
  requiresReauth: false, hasCustomPage: false, reauthAction: 'UPDATE_CONFIG_PAGE',
  settings: [{ key: 'retentionMonths', type: 'number', label: 'Keep readings for (months)', default: 12 }],
}];
const NULL_KEY = { data: undefined, error: undefined, mutate, isLoading: false, isValidating: false };
const ERRORED = { data: undefined, error: FAILED, mutate, isLoading: false, isValidating: false };
const PENDING = { data: undefined, error: undefined, mutate, isLoading: true, isValidating: true };

vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === null) return NULL_KEY;
    if (key in state.overrides) return { data: state.overrides[key], error: undefined, mutate, isLoading: false, isValidating: false };
    return state.mode === 'error' ? ERRORED : PENDING;
  },
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
vi.mock('@/hooks/use-attribute-labels', () => ({
  useAttributeLabels: () => ({ labelFor: (k: string) => k, settingsHidden: { instrumentId: false, keys: [] }, isHiddenInSettings: () => false }),
}));
vi.mock('@/lib/api-client', () => ({
  apiClient: { get: vi.fn(async () => []), put: vi.fn(), post: vi.fn(), patch: vi.fn(), delete: vi.fn(), putWithReauth: vi.fn(), postWithReauth: vi.fn() },
}));

const ROLES = [{ name: 'ADMIN', displayName: 'Admin', hierarchyLevel: 80 }, { name: 'OPERATOR', displayName: 'Operator', hierarchyLevel: 20 }];
const noop = () => undefined;

const PAGES: Array<[string, () => Promise<ReactElement>]> = [
  ['Dynamic config (Telemetry Retention)', async () => {
    const { DynamicConfigPage } = await import('../dynamic-config');
    state.overrides['/api/config/registry/manifest'] = MANIFEST;
    return (
      <MemoryRouter initialEntries={['/config/dynamic/telemetry-retention']}>
        <Routes><Route path="/config/dynamic/:moduleKey" element={<DynamicConfigPage />} /></Routes>
      </MemoryRouter>
    );
  }],
  ['Dynamic config (registry not loaded)', async () => {
    const { DynamicConfigPage } = await import('../dynamic-config');
    return (
      <MemoryRouter initialEntries={['/config/dynamic/telemetry-retention']}>
        <Routes><Route path="/config/dynamic/:moduleKey" element={<DynamicConfigPage />} /></Routes>
      </MemoryRouter>
    );
  }],
  ['LDAP', async () => { const { default: LdapConfigPage } = await import('../ldap'); return <LdapConfigPage />; }],
  ['User ID', async () => { const { UserIdConfigPage } = await import('../user-id'); return <UserIdConfigPage />; }],
  ['Pagination', async () => { const { PaginationConfigPage } = await import('../pagination'); return <PaginationConfigPage />; }],
  ['Export Options', async () => { const { ExportOptionsPage } = await import('../export-options'); return <ExportOptionsPage />; }],
  ['Configuration Access', async () => { const { AccessMatrixPage } = await import('../access-matrix'); return <AccessMatrixPage />; }],
  ['Report Page Titles', async () => { const { ReportPageTitlesPage } = await import('../report-page-titles'); return <ReportPageTitlesPage />; }],
  ['Action Re-authentication', async () => { const { ActionReauthPage } = await import('../action-reauth'); return <ActionReauthPage />; }],
  ['Branding', async () => { const { BrandingConfigPage } = await import('../branding'); return <BrandingConfigPage />; }],
  ['Date / Time', async () => { const { DatetimeConfigPage } = await import('../datetime'); return <DatetimeConfigPage />; }],
  ['Password Policy', async () => { const { PasswordPolicyPage } = await import('../password-policy'); return <PasswordPolicyPage />; }],
  ['E-mail settings', async () => { const { EmailSettingsPage } = await import('../notification-settings/email-settings'); return <EmailSettingsPage />; }],
  ['SMS settings', async () => { const { SmsSettingsPage } = await import('../notification-settings/email-settings'); return <SmsSettingsPage />; }],
  ['Report Settings', async () => { const { ReportSettingsConfigPage } = await import('../report-settings'); return <ReportSettingsConfigPage />; }],
  ['Field IDs', async () => { const { FieldIdsPage } = await import('../field-ids'); return <FieldIdsPage />; }],
  ['Roles & Access → Permissions', async () => {
    const { PermissionsTab } = await import('../roles-components/permissions-tab');
    return <PermissionsTab selectableRoles={ROLES as never} onStateChange={noop} />;
  }],
  ['Roles & Access → Sidebar', async () => {
    const { SidebarTab } = await import('../roles-components/sidebar-tab');
    return <SidebarTab activeRoles={ROLES as never} onStateChange={noop} />;
  }],
  ['Roles & Access → Re-authentication', async () => {
    const { ReauthTab } = await import('../roles-components/reauth-tab');
    return <ReauthTab selectableRoles={ROLES as never} onStateChange={noop} />;
  }],
  ['Roles & Access → Panels', async () => { const { PanelAccessTab } = await import('../roles-components/panel-access-tab'); return <PanelAccessTab />; }],
  ['Roles & Access → Instrument visibility', async () => { const { InstrumentScopeTab } = await import('../roles-components/instrument-scope-tab'); return <InstrumentScopeTab />; }],
  ['Roles & Access → Attribute access', async () => { const { AttributeAccessTab } = await import('../roles-components/attribute-access-tab'); return <AttributeAccessTab />; }],
  ['Roles & Access → Per-user attribute access', async () => { const { UserAttributeAccess } = await import('../roles-components/user-attribute-access'); return <UserAttributeAccess />; }],
];

async function mount(build: () => Promise<ReactElement>) {
  const el = await build();
  // Pages that are not already inside a router get one.
  render(el.type === MemoryRouter ? el : <MemoryRouter>{el}</MemoryRouter>);
}

function enabledSaveButtons() {
  return screen.queryAllByRole('button', { name: /save|update/i }).filter((b) => !(b as HTMLButtonElement).disabled);
}

beforeEach(() => {
  cleanup();
  mutate.mockClear();
  state.overrides = {};
});

describe('G4-01: a configuration page whose load FAILED offers no Save', () => {
  it.each(PAGES)('%s', async (_name, build) => {
    state.mode = 'error';
    await mount(build);
    expect(enabledSaveButtons()).toEqual([]);
    const retry = screen.getByRole('button', { name: /try again/i });
    fireEvent.click(retry);
    expect(mutate).toHaveBeenCalled();
  });
});

describe('G4-01: nor does one whose load is still PENDING', () => {
  it.each(PAGES)('%s', async (_name, build) => {
    state.mode = 'loading';
    await mount(build);
    expect(enabledSaveButtons()).toEqual([]);
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });
});
