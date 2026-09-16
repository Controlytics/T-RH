import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

/**
 * The Attribute Access picker prints the administered DISPLAY NAME of each key
 * (2026-09-16) but the rule it saves is still keyed on the KEY — a role's
 * editable set is stored by key, so a rename must change what the admin reads
 * and nothing about what is written.
 */
const labels = { current: {} as Record<string, string> };
const access = {
  roles: [{ role: 'OPERATOR', mode: 'SELECTED', keys: [], requireReauth: false, canUpdateInstruments: true }],
  availableKeys: ['Building', 'Enable_Temp_NMT'],
};
const mutate = vi.fn();
vi.mock('swr', () => ({
  default: (key: string) => {
    if (key === '/api/config/attribute-labels/current') return { data: { labels: labels.current }, mutate };
    if (key === '/api/roles/attribute-access') return { data: access, mutate };
    return { data: undefined, mutate };
  },
}));
const put = vi.fn().mockResolvedValue({});
vi.mock('@/lib/api-client', () => ({ apiClient: { put: (...a: unknown[]) => put(...a) } }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));

const { AttributeAccessTab } = await import('../attribute-access-tab');

describe('AttributeAccessTab — display names', () => {
  it('shows the display name with the key beside it, and a bare key as itself', () => {
    labels.current = { Enable_Temp_NMT: 'High temperature alarm enabled' };
    render(<AttributeAccessTab />);
    expect(screen.getByText('High temperature alarm enabled')).toBeInTheDocument();
    expect(screen.getByText('(Enable_Temp_NMT)')).toBeInTheDocument();
    expect(screen.getAllByText('Building')).toHaveLength(1);
  });

  it('saves the KEY, not the display name, when a named key is ticked', async () => {
    labels.current = { Enable_Temp_NMT: 'High temperature alarm enabled' };
    render(<AttributeAccessTab />);
    fireEvent.click(screen.getByLabelText(/High temperature alarm enabled/));
    fireEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() => expect(put).toHaveBeenCalledWith(
      '/api/roles/attribute-access/OPERATOR',
      expect.objectContaining({ keys: ['Enable_Temp_NMT'] }),
    ));
  });
});
