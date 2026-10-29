import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

/**
 * The Dashboards list (2026-10-29). Wiring tests: the page prints what the
 * server returned, offers the SUPER_ADMIN-only controls to a SUPER_ADMIN only,
 * and every write runs inside `reauth.execute('UPDATE_DASHBOARD', ...)`.
 * NOT VERIFIED HERE: how it looks (see concept-a-list.png).
 */

const rowA = {
  id: 'd-1', title: 'QC Block', description: 'Dissolution rooms',
  sourceSummary: { mode: 'profile', label: 'Pressure Sensors' }, widgetCount: 5,
  updatedAt: '2026-10-29T17:04:00.000Z',
  assignments: { roles: ['QA Reviewer'], users: [{ id: 'u-1', username: 'rsharma', fullName: 'R. Sharma' }] },
};
const rowB = {
  id: 'd-2', title: 'Plant Overview', description: null,
  sourceSummary: { mode: 'all', label: 'All instruments' }, widgetCount: 6,
  updatedAt: '2026-10-28T15:10:00.000Z',
  assignments: { roles: [], users: [] },
};
// A non-SA gets the same rows WITHOUT `assignments`, as the server sends them.
const strip = ({ assignments: _a, ...rest }: typeof rowA) => rest;

// Module-level constants: a fresh object per SWR call hangs vitest.
const SA_LIST = { data: [rowA, rowB] };
const USER_LIST = { data: [strip(rowA)] };
const EMPTY_LIST = { data: [] as unknown[] };
const state = { role: 'SUPER_ADMIN', list: SA_LIST as { data: unknown[] } };
const mutate = vi.fn();

const ROLE_LIST = { data: [{ id: 'r1', name: 'SUPER_ADMIN', displayName: 'Super Admin' }, { id: 'r2', name: 'QA Reviewer', displayName: 'QA Reviewer' }], error: undefined, isLoading: false };
const USER_OPTIONS = { data: { data: [{ id: 'u-1', username: 'rsharma', fullName: 'R. Sharma' }] }, error: undefined, isLoading: false };
vi.mock('swr', () => ({
  default: (key: string) => {
    if (key === '/api/dashboards') return { data: state.list, error: undefined, isLoading: false, mutate };
    if (key === '/api/roles/active') return ROLE_LIST;
    if (key && key.startsWith('/api/users?')) return USER_OPTIONS;
    return { data: undefined, error: undefined, isLoading: false, mutate: vi.fn() };
  },
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { role: state.role } }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (d: string) => d.slice(0, 10), formatTime: (d: string) => d.slice(11, 16) }),
}));
const post = vi.fn();
const del = vi.fn();
const put = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
    put: (...a: unknown[]) => put(...a),
    postWithReauth: vi.fn(), deleteWithReauth: vi.fn(), putWithReauth: vi.fn(),
  },
}));
/** Pass-through: the real hook prompts on a 401 this mock cannot produce. Records the action. */
const reauthActions: string[] = [];
vi.mock('@/hooks/use-reauth', () => ({
  useReauth: () => ({
    execute: async (
      action: string,
      cb: (p?: string) => Promise<void>,
      opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void },
    ) => {
      reauthActions.push(action);
      try { await cb(); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { DashboardsPage } = await import('../index');

function Where() {
  const l = useLocation();
  return <div data-testid="where">{l.pathname}{l.search}</div>;
}
function mount() {
  return render(
    <MemoryRouter initialEntries={['/dashboards']}>
      <Routes>
        <Route path="/dashboards" element={<DashboardsPage />} />
        <Route path="/dashboards/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}
const headers = () => screen.getAllByRole('columnheader').map((h) => h.textContent);

describe('DashboardsPage', () => {
  beforeEach(() => {
    state.role = 'SUPER_ADMIN'; state.list = SA_LIST;
    reauthActions.length = 0;
    mutate.mockReset().mockResolvedValue(undefined);
    post.mockReset(); del.mockReset().mockResolvedValue({ success: true }); put.mockReset();
  });

  it('a SUPER_ADMIN sees every column and the server rows', () => {
    mount();
    expect(screen.getByRole('heading', { name: 'Dashboards' })).toBeInTheDocument();
    expect(headers()).toEqual(['Title', 'Instruments', 'Widgets', 'Assigned to', 'Updated', 'Actions']);
    const [first, second] = screen.getAllByTestId('dashboard-row');
    expect(within(first).getByRole('link', { name: 'QC Block' })).toHaveAttribute('href', '/dashboards/d-1');
    expect(within(first).getByText('Dissolution rooms')).toBeInTheDocument();
    expect(within(first).getByTestId('source-chip')).toHaveTextContent('Pressure Sensors');
    expect(within(first).getByText('5')).toBeInTheDocument();
    // role chip, then the user's FULL name
    const chips = Array.from(first.querySelectorAll('[data-chip]')).map((c) => `${c.getAttribute('data-chip')}:${c.textContent}`);
    expect(chips).toEqual(['role:QA Reviewer', 'user:R. Sharma']);
    expect(within(first).getByText('2026-10-29')).toBeInTheDocument();
    expect(within(first).getByText('17:04')).toBeInTheDocument();
    expect(within(second).getByText('Not assigned')).toBeInTheDocument();
    for (const name of ['Assign', 'Duplicate', 'Rename', 'Delete']) expect(within(first).getByRole('button', { name })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /New dashboard/ })).toBeInTheDocument();
    expect(screen.getByTestId('page-hero').contains(screen.getByRole('button', { name: /New dashboard/ }))).toBe(true);
  });

  it('each row action is a square icon button, never a text button squeezed to 32px', () => {
    // The default size's horizontal padding beside a 32px width left the icon a
    // 0px box: every action drew as an empty square in the built-CSS render.
    mount();
    const first = screen.getAllByTestId('dashboard-row')[0];
    for (const name of ['Assign', 'Duplicate', 'Rename', 'Delete']) {
      const b = within(first).getByRole('button', { name });
      expect(b.className).toMatch(/(^|\s)w-8(\s|$)/);
      expect(b.className).not.toMatch(/(^|\s)px-\d/);
      expect(b.querySelector('svg')).not.toBeNull();
    }
  });

  it('anyone else sees no New, no row actions and no Assigned-to column', () => {
    state.role = 'QA'; state.list = USER_LIST;
    mount();
    expect(headers()).toEqual(['Title', 'Instruments', 'Widgets', 'Updated']);
    expect(screen.queryByRole('button', { name: /New dashboard/ })).toBeNull();
    for (const name of ['Assign', 'Duplicate', 'Rename', 'Delete']) expect(screen.queryByRole('button', { name })).toBeNull();
    expect(screen.getByRole('link', { name: 'QC Block' })).toBeInTheDocument();
  });

  it('says the right thing when there is nothing to show', () => {
    state.list = EMPTY_LIST;
    const { unmount } = mount();
    expect(screen.getByText('No dashboards yet. Create the first one.')).toBeInTheDocument();
    unmount();
    state.role = 'QA';
    mount();
    expect(screen.getByText('No dashboard has been assigned to you.')).toBeInTheDocument();
  });

  it('Delete confirms in a dialog naming the dashboard, then DELETEs inside reauth UPDATE_DASHBOARD', async () => {
    mount();
    fireEvent.click(within(screen.getAllByTestId('dashboard-row')[0]).getByRole('button', { name: 'Delete' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText(/QC Block/)).toBeInTheDocument();
    expect(del).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete dashboard' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/api/dashboards/d-1'));
    expect(reauthActions).toEqual(['UPDATE_DASHBOARD']);
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('Cancel in the delete confirm deletes nothing', () => {
    mount();
    fireEvent.click(within(screen.getAllByTestId('dashboard-row')[0]).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(del).not.toHaveBeenCalled();
    expect(reauthActions).toEqual([]);
  });

  it('New creates under UPDATE_DASHBOARD and goes to the new dashboard in edit mode', async () => {
    post.mockResolvedValue({ id: 'd-new', title: 'Fresh' });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /New dashboard/ }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Title/ }), { target: { value: '  Fresh  ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create dashboard' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/dashboards/d-new?edit=1'));
    expect(post).toHaveBeenCalledWith('/api/dashboards', { title: 'Fresh' });
    expect(reauthActions).toEqual(['UPDATE_DASHBOARD']);
  });

  it('Rename PUTs the new title with the updatedAt the row was loaded with', async () => {
    put.mockResolvedValue({});
    mount();
    fireEvent.click(within(screen.getAllByTestId('dashboard-row')[0]).getByRole('button', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog');
    const title = within(dialog).getByRole('textbox', { name: /Title/ });
    expect(title).toHaveValue('QC Block');
    fireEvent.change(title, { target: { value: 'QC Block 2' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/dashboards/d-1', {
      title: 'QC Block 2', description: 'Dissolution rooms', expectedUpdatedAt: rowA.updatedAt,
    }));
    expect(reauthActions).toEqual(['UPDATE_DASHBOARD']);
  });

  it('Duplicate POSTs to the duplicate route under UPDATE_DASHBOARD', async () => {
    post.mockResolvedValue({ id: 'd-3', title: 'QC Block (copy)' });
    mount();
    fireEvent.click(within(screen.getAllByTestId('dashboard-row')[0]).getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/api/dashboards/d-1/duplicate', {}));
    expect(reauthActions).toEqual(['UPDATE_DASHBOARD']);
    await waitFor(() => expect(mutate).toHaveBeenCalled());
  });
  it('Assign opens the dialog on the row, saves under UPDATE_DASHBOARD and re-reads the list', async () => {
    put.mockResolvedValue({ roles: ['QA'], users: [] });
    mount();
    fireEvent.click(within(screen.getAllByTestId('dashboard-row')[0]).getByRole('button', { name: 'Assign' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('QC Block')).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: 'QA Reviewer' })).toBeChecked();
    expect(within(dialog).queryByRole('checkbox', { name: /Super Admin/ })).toBeNull();
    fireEvent.click(within(dialog).getByRole('checkbox', { name: /R\. Sharma/ }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/api/dashboards/d-1/assignments', { roles: ['QA Reviewer'], userIds: [] }));
    expect(reauthActions).toEqual(['UPDATE_DASHBOARD']);
    await waitFor(() => expect(mutate).toHaveBeenCalled());
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a refused Rename (409) re-reads the list, and the next attempt carries the FRESH updatedAt', async () => {
    const FRESH = '2026-10-29T18:30:00.000Z';
    put.mockRejectedValueOnce(Object.assign(new Error('This dashboard was changed by someone else.'), { code: 'DASHBOARD_CHANGED' }));
    put.mockResolvedValue({});
    // The re-read the page asks for is what changes the list the next render sees.
    mutate.mockImplementation(async () => { state.list = { data: [{ ...rowA, updatedAt: FRESH }, rowB] }; });
    mount();
    fireEvent.click(within(screen.getAllByTestId('dashboard-row')[0]).getByRole('button', { name: 'Rename' }));
    const dialog = screen.getByRole('dialog');
    fireEvent.change(within(dialog).getByRole('textbox', { name: /Title/ }), { target: { value: 'Renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('changed by someone else');
    expect(mutate).toHaveBeenCalledTimes(1);
    expect((put.mock.calls[0][1] as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(rowA.updatedAt);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect((put.mock.calls[1][1] as { expectedUpdatedAt: string }).expectedUpdatedAt).toBe(FRESH);
  });

  it('Duplicate cannot be repeated while it is in flight: the row actions are disabled and one copy is made', async () => {
    let finish: (v: unknown) => void = () => {};
    post.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    mount();
    const row = () => within(screen.getAllByTestId('dashboard-row')[0]);
    fireEvent.click(row().getByRole('button', { name: 'Duplicate' }));
    await waitFor(() => expect(row().getByRole('button', { name: 'Duplicate' })).toBeDisabled());
    for (const name of ['Assign', 'Rename', 'Delete']) expect(row().getByRole('button', { name })).toBeDisabled();
    fireEvent.click(row().getByRole('button', { name: 'Duplicate' }));
    expect(post).toHaveBeenCalledTimes(1);
    finish({ id: 'd-3', title: 'QC Block (copy)' });
    await waitFor(() => expect(row().getByRole('button', { name: 'Duplicate' })).not.toBeDisabled());
    expect(post).toHaveBeenCalledTimes(1);
  });
});
