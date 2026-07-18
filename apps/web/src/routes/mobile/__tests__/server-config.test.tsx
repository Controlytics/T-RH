import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import ServerConfigPage from '../server-config';

describe('ServerConfigPage', () => {
  beforeEach(() => { localStorage.clear(); delete (window as any).__API_BASE__; vi.restoreAllMocks(); });

  it('saves the URL when the health check succeeds', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    render(<ServerConfigPage />);
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), { target: { value: 'https://192.168.1.55:3000' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(localStorage.getItem('digilog.serverUrl')).toBe('https://192.168.1.55:3000'));
    expect((fetch as any)).toHaveBeenCalledWith('https://192.168.1.55:3000/api/health', expect.anything());
  });

  it('shows an error and saves nothing when the server is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    render(<ServerConfigPage />);
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), { target: { value: 'https://192.168.1.55:3000' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(screen.getByText(/couldn't reach/i)).toBeInTheDocument());
    expect(localStorage.getItem('digilog.serverUrl')).toBeNull();
  });

  it('rejects a URL with no scheme before hitting the network', async () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    render(<ServerConfigPage />);
    fireEvent.change(screen.getByPlaceholderText(/https:\/\//i), { target: { value: '192.168.1.55:3000' } });
    fireEvent.click(screen.getByRole('button', { name: /connect/i }));
    await waitFor(() => expect(screen.getByText(/full address/i)).toBeInTheDocument());
    expect(f).not.toHaveBeenCalled();
  });
});
