import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render as rtlRender, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

const render = (ui: ReactElement) => rtlRender(<MemoryRouter>{ui}</MemoryRouter>);

/**
 * The location's instrument panel writes `PUT /api/functional-locations/:id/
 * instruments`, a route gated by `enforceReauth('UPDATE_FUNCTIONAL_LOCATION')`.
 * Until 2026-10-12 (audit finding 2) it sent a bare `apiClient.put`, so a role
 * that requires re-authentication got a 401 on every save and unlink. Both now
 * go through the page's `reauth.executeWithResult`, like every other write on
 * these pages; a cancelled password prompt is not reported as a failure.
 */

const linkable = [
  { id: 'i1', code: 'A-01', name: 'A-01', functionalLocationId: 'b1', functionalLocationPath: 'Block' },
  { id: 'i2', code: 'A-02', name: 'A-02', functionalLocationId: 'b1', functionalLocationPath: 'Block' },
];
const toast = { success: vi.fn(), error: vi.fn() };
const put = vi.fn();
const putWithReauth = vi.fn();
vi.mock('swr', () => ({
  default: () => ({ data: { data: linkable }, mutate: vi.fn() }),
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast }) }));
vi.mock('@/lib/api-client', () => ({
  apiClient: { put: (...a: unknown[]) => put(...a), putWithReauth: (...a: unknown[]) => putWithReauth(...a) },
}));

const { InstrumentPanel } = await import('../instrument-panel');

type Reauth = Parameters<typeof InstrumentPanel>[0]['reauth'];

function reauthStub(mode: 'password' | 'cancel') {
  const executeWithResult = vi.fn(async (_action: string, cb: (pw?: string) => Promise<unknown>) => {
    if (mode === 'cancel') throw { error: 'REAUTH_CANCELLED' };
    return cb('secret');
  });
  return { executeWithResult } as unknown as Reauth & { executeWithResult: typeof executeWithResult };
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  putWithReauth.mockResolvedValue({ linked: 0, unlinked: 1, moved: 0 });
  put.mockResolvedValue({ linked: 0, unlinked: 1, moved: 0 });
});

describe('InstrumentPanel writes through re-authentication', () => {
  it('Unlink asks for the UPDATE_FUNCTIONAL_LOCATION signature and sends the password', async () => {
    const reauth = reauthStub('password');
    render(<InstrumentPanel locationId="b1" locationPath="Block" canEdit onChanged={vi.fn()} reauth={reauth} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[0]);
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledTimes(1));
    expect(reauth.executeWithResult).toHaveBeenCalledWith('UPDATE_FUNCTIONAL_LOCATION', expect.any(Function));
    expect(putWithReauth).toHaveBeenCalledWith('/api/functional-locations/b1/instruments', { instrumentIds: ['i2'] }, 'secret');
    expect(put).not.toHaveBeenCalled();
    expect(toast.success).toHaveBeenCalled();
  });

  it('Save in the picker goes through the same signature', async () => {
    const reauth = reauthStub('password');
    render(<InstrumentPanel locationId="b1" locationPath="Block" canEdit onChanged={vi.fn()} reauth={reauth} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add instruments' }));
    fireEvent.click(await screen.findByRole('button', { name: /^Save/ }));
    await waitFor(() => expect(putWithReauth).toHaveBeenCalledTimes(1));
    expect(reauth.executeWithResult).toHaveBeenCalledWith('UPDATE_FUNCTIONAL_LOCATION', expect.any(Function));
  });

  it('a cancelled password prompt sends nothing and shows no error', async () => {
    const reauth = reauthStub('cancel');
    render(<InstrumentPanel locationId="b1" locationPath="Block" canEdit onChanged={vi.fn()} reauth={reauth} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Unlink' })[0]);
    await waitFor(() => expect(reauth.executeWithResult).toHaveBeenCalled());
    expect(put).not.toHaveBeenCalled();
    expect(putWithReauth).not.toHaveBeenCalled();
    expect(toast.error).not.toHaveBeenCalled();
  });
});
