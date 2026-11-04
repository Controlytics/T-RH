import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, within, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router-dom';

/**
 * The Rule Chains list (rule chains, 2026-11-04). Wiring tests: the page
 * prints what `GET /api/rule-chains` and `/stats` returned, offers the write
 * controls to a RULE_CHAIN_MANAGE holder only, and every write carries a
 * reason inside `reauth.execute('UPDATE_RULE_CHAIN', …)`.
 * NOT VERIFIED HERE: how it looks (built-list.png).
 */

const ROOT = { id: 'b1a7e000-0000-4000-8000-000000000000', name: 'Root Rule Chain', root: true, debugMode: false, nodeCount: 4, updatedAt: '2026-11-03T18:10:00.000Z', updatedBy: null };
const OTHER = { id: 'c2', name: 'Alarms', root: false, debugMode: false, nodeCount: 7, updatedAt: '2026-11-04T09:30:00.000Z', updatedBy: 'qa.lead' };
const LIST = { data: [ROOT, OTHER] };
const STATS_OK = { enabled: true, queueDepth: 3, dropped: 0, processedLastMinute: 120, chains: [] };
const STATS_DROPPED = { enabled: true, queueDepth: 10000, dropped: 42, processedLastMinute: 900, chains: [] };
const STATS_OFF = { enabled: false, queueDepth: 0, dropped: 0, processedLastMinute: 0, chains: [] };

const state: { stats: unknown; role: string; permissions: string[] } = { stats: STATS_OK, role: 'SUPER_ADMIN', permissions: [] };
const mutate = vi.fn(async () => undefined);
vi.mock('swr', () => ({
  default: (key: string | null) => {
    if (key === '/api/rule-chains') return { data: LIST, error: undefined, isLoading: false, mutate };
    if (key === '/api/rule-chains/stats') return { data: state.stats, error: undefined, isLoading: false, mutate };
    return { data: undefined, error: undefined, isLoading: false, mutate };
  },
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: { role: state.role, permissions: state.permissions } }) }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDate: (d: string) => d.slice(0, 10), formatTime: (d: string) => d.slice(11, 16) }),
}));
const post = vi.fn();
const del = vi.fn();
const getRaw = vi.fn();
vi.mock('@/lib/api-client', () => ({
  apiClient: {
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
    put: vi.fn(),
    getRaw: (...a: unknown[]) => getRaw(...a),
    postWithReauth: vi.fn(), deleteWithReauth: vi.fn(), putWithReauth: vi.fn(),
  },
}));
const reauthActions: string[] = [];
vi.mock('@/hooks/use-reauth', () => ({
  reauthActionLabel: () => 'Update Rule Chain',
  useReauth: () => ({
    execute: async (action: string, cb: (p?: string) => Promise<void>, opts?: { onSuccess?: () => void; onError?: (e: unknown) => void; onCancel?: () => void }) => {
      reauthActions.push(action);
      try { await cb(); opts?.onSuccess?.(); } catch (e) { opts?.onError?.(e); }
    },
    isOpen: false, password: '', error: '', isVerifying: false,
    setPassword: vi.fn(), confirm: vi.fn(), cancel: vi.fn(), needsReauth: () => false,
  }),
}));

const { RuleChainsPage } = await import('../index');

function Where() {
  const l = useLocation();
  return <span data-testid="where">{l.pathname}</span>;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/rule-chains']}>
      <Routes>
        <Route path="/rule-chains" element={<RuleChainsPage />} />
        <Route path="/rule-chains/:id" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const rows = () => screen.getAllByTestId('rule-chain-row');
const reason = (text: string) => fireEvent.change(screen.getByLabelText('Reason'), { target: { value: text } });

beforeEach(() => {
  state.stats = STATS_OK;
  state.role = 'SUPER_ADMIN';
  state.permissions = [];
  reauthActions.length = 0;
  post.mockReset(); del.mockReset(); getRaw.mockReset(); mutate.mockClear(); toast.success.mockClear(); toast.error.mockClear();
});

describe('Rule Chains list', () => {
  it('lists the chains as returned: the seeded root with a Root badge, node counts, and "System" for no author', () => {
    mount();
    expect(rows()).toHaveLength(2);
    const [root, other] = rows();
    expect(within(root).getByText('Root Rule Chain')).toBeInTheDocument();
    expect(within(root).getByTestId('root-badge')).toHaveTextContent('Root');
    expect(within(root).getByText('4')).toBeInTheDocument();
    expect(within(root).getByText(/System/)).toBeInTheDocument();
    expect(within(other).queryByTestId('root-badge')).toBeNull();
    expect(within(other).getByText(/qa\.lead/)).toBeInTheDocument();
    expect(within(root).getByRole('link', { name: 'Root Rule Chain' })).toHaveAttribute('href', `/rule-chains/${ROOT.id}`);
  });

  it('the root offers no Delete and no Make root; another chain offers both', () => {
    mount();
    const [root, other] = rows();
    expect(within(root).queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(within(root).queryByRole('button', { name: 'Make root' })).toBeNull();
    expect(within(other).getByRole('button', { name: 'Delete' })).toBeInTheDocument();
    expect(within(other).getByRole('button', { name: 'Make root' })).toBeInTheDocument();
  });

  it('+ New creates with a name and a reason, signed UPDATE_RULE_CHAIN, and opens the new chain', async () => {
    post.mockResolvedValue({ id: 'new-1', name: 'Cold room' });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /New rule chain/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '  Cold room ' } });
    const create = screen.getByRole('button', { name: 'Create' });
    expect(create).toBeDisabled();
    reason('Cold room alarms');
    fireEvent.click(create);
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/rule-chains/new-1'));
    expect(post).toHaveBeenCalledWith('/api/rule-chains', { name: 'Cold room', reason: 'Cold room alarms' });
    expect(reauthActions).toEqual(['UPDATE_RULE_CHAIN']);
  });

  it('a refused create stays open and shows the server\'s words', async () => {
    post.mockRejectedValue(Object.assign(new Error('A rule chain named "Alarms" already exists.'), { code: 'NAME_IN_USE', status: 409 }));
    mount();
    fireEvent.click(screen.getByRole('button', { name: /New rule chain/ }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Alarms' } });
    reason('dup');
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('already exists');
    expect(screen.getByLabelText('Name')).toBeInTheDocument();
  });

  it('Make root sends the reason to /root', async () => {
    post.mockResolvedValue({ ...OTHER, root: true });
    mount();
    fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Make root' }));
    reason('Alarms chain is the entry now');
    fireEvent.click(screen.getByRole('button', { name: 'Make root chain' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/api/rule-chains/${OTHER.id}/root`, { reason: 'Alarms chain is the entry now' }));
    expect(mutate).toHaveBeenCalled();
  });

  it('Delete sends the reason in the DELETE body', async () => {
    del.mockResolvedValue(undefined);
    mount();
    fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Delete' }));
    reason('no longer used');
    fireEvent.click(screen.getByRole('button', { name: 'Delete rule chain' }));
    await waitFor(() => expect(del).toHaveBeenCalledWith(`/api/rule-chains/${OTHER.id}`, { reason: 'no longer used' }));
    expect(reauthActions).toEqual(['UPDATE_RULE_CHAIN']);
  });

  it('Export downloads the server\'s file', async () => {
    const blob = new Blob(['{}'], { type: 'application/json' });
    getRaw.mockResolvedValue({ blob: async () => blob, headers: { get: () => 'attachment; filename="Alarms.json"' } });
    const create = vi.fn(() => 'blob:x');
    const revoke = vi.fn();
    Object.assign(URL, { createObjectURL: create, revokeObjectURL: revoke });
    // jsdom cannot navigate to a blob: URL; the click is what a browser downloads on.
    const names: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { names.push(this.download); });
    mount();
    fireEvent.click(within(rows()[1]).getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(getRaw).toHaveBeenCalledWith(`/api/rule-chains/${OTHER.id}/export`));
    await waitFor(() => expect(revoke).toHaveBeenCalled());
    expect(names).toEqual(['Alarms.json']);
    click.mockRestore();
  });

  it('Import: the file is checked, its name prefilled, and the server\'s warnings shown before opening the chain', async () => {
    post.mockResolvedValue({ id: 'imp-1', warnings: ['Node "RPC": RPC Call Request has no counterpart here and will send every message to Failure.'] });
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Import/ }));
    const file = new File([JSON.stringify({ ruleChain: { name: 'TB root' }, metadata: { nodes: [], connections: [] } })], 'root.json', { type: 'application/json' });
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByLabelText('Name')).toHaveValue('TB root'));
    reason('bring the TB chain over');
    fireEvent.click(screen.getByRole('button', { name: 'Import' }));
    expect(await screen.findByTestId('import-warnings')).toHaveTextContent('RPC Call Request');
    expect(post).toHaveBeenCalledWith('/api/rule-chains/import', {
      json: { ruleChain: { name: 'TB root' }, metadata: { nodes: [], connections: [] } }, name: 'TB root', reason: 'bring the TB chain over',
    });
    fireEvent.click(screen.getByRole('button', { name: 'Open the chain' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/rule-chains/imp-1'));
  });

  it('Import refuses a file that is not a rule chain export, before any request', async () => {
    mount();
    fireEvent.click(screen.getByRole('button', { name: /Import/ }));
    fireEvent.change(screen.getByLabelText('File'), { target: { files: [new File(['{"a":1}'], 'x.json')] } });
    expect(await screen.findByText(/not a ThingsBoard rule chain export/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Import' })).toBeDisabled();
  });

  it('a RULE_CHAIN_READ holder sees the chains and Export, and no write control', () => {
    state.role = 'QA_VIEWER';
    state.permissions = ['RULE_CHAIN_READ'];
    mount();
    expect(rows()).toHaveLength(2);
    expect(screen.queryByRole('button', { name: /New rule chain/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Import/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Make root' })).toBeNull();
    expect(within(rows()[1]).getByRole('button', { name: 'Export' })).toBeInTheDocument();
  });
});

describe('the engine stats', () => {
  it('show the queue and the minute\'s count; no banner while all is well', () => {
    mount();
    expect(screen.getByTestId('stat-queue')).toHaveTextContent('3');
    expect(screen.getByTestId('stat-processed')).toHaveTextContent('120');
    expect(screen.queryByTestId('rule-engine-banner')).toBeNull();
  });

  it('a banner names the DROPPED messages when there are any', () => {
    state.stats = STATS_DROPPED;
    mount();
    expect(screen.getByTestId('stat-dropped')).toHaveTextContent('42 dropped');
  });

  it('a banner says the engine is off', () => {
    state.stats = STATS_OFF;
    mount();
    expect(screen.getByTestId('rule-engine-banner')).toHaveTextContent('Rule engine off');
    expect(screen.queryByTestId('stat-dropped')).toBeNull();
  });
});
