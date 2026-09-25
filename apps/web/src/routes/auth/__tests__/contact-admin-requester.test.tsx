import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/use-branding', () => ({
  useBranding: () => ({ branding: {
    appName: 'T&RH-Monitoring', appTagline: '21 CFR Part 11', logoUrl: '', logoText: 'CC', companyName: 'Controlytics',
    version: '1.0', primaryColor: '#0891b2', secondaryColor: '#0d9488', accentColor: '#14b8a6',
    gradientStart: '#0891b2', gradientMiddle: '#0d9488', gradientEnd: '#14b8a6', loginBgStart: '#164e63', loginBgEnd: '#1e3a5f',
  } }),
}));

/**
 * The requester's Employee ID is typed, not verified (operator, 2026-09-25:
 * "there i dont need verification"). Until then the form hid Request Type
 * behind a Verify button that called `/api/admin-requests/user-lookup`. These
 * cases fail on that version: the select was not in the document until the
 * lookup succeeded, and a Verify button was.
 */
describe('contact admin — requester Employee ID is not looked up', () => {
  const fetchMock = vi.fn();
  const realFetch = globalThis.fetch;

  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/roles/active')) {
        return new Response(JSON.stringify([{ name: 'OPERATOR', displayName: 'Operator' }]), { status: 200 });
      }
      if (url.endsWith('/api/admin-requests')) {
        return new Response(JSON.stringify({ success: true, requestId: 'r1' }), { status: 201 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
  });
  afterEach(() => { globalThis.fetch = realFetch; });

  it('shows Request Type at once and offers no Verify button before a type is chosen', async () => {
    const { ContactAdminPage } = await import('../contact-admin');
    render(<MemoryRouter><ContactAdminPage /></MemoryRouter>);
    expect(screen.getByLabelText('Request Type')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /verify/i })).toBeNull();
    expect(screen.queryByText(/verify your employee id/i)).toBeNull();
  });

  it('submits the typed Employee ID without any user-lookup request', async () => {
    const { ContactAdminPage } = await import('../contact-admin');
    render(<MemoryRouter><ContactAdminPage /></MemoryRouter>);

    fireEvent.change(screen.getByLabelText('Your Employee ID'), { target: { value: 'EMP-777' } });
    fireEvent.change(screen.getByLabelText('Request Type'), { target: { value: 'CREATE_USER' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. jdoe01'), { target: { value: 'newuser01' } });
    fireEvent.change(screen.getByPlaceholderText('John Doe'), { target: { value: 'New User' } });
    await waitFor(() => expect(screen.getByRole('option', { name: 'Operator' })).toBeInTheDocument());
    fireEvent.change(screen.getByRole('option', { name: 'Operator' }).closest('select') as HTMLSelectElement, { target: { value: 'OPERATOR' } });
    fireEvent.change(screen.getByLabelText('Your Name'), { target: { value: 'Requester' } });
    fireEvent.change(screen.getByPlaceholderText('Explain why you need this request...'), { target: { value: 'New starter' } });

    fireEvent.click(screen.getByRole('button', { name: /submit request/i }));
    await waitFor(() => expect(screen.getByText('Request Submitted')).toBeInTheDocument());

    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('user-lookup'))).toBe(false);
    const submit = fetchMock.mock.calls.find(c => String(c[0]).endsWith('/api/admin-requests'));
    expect(submit).toBeDefined();
    const body = JSON.parse(String((submit![1] as RequestInit).body));
    expect(body.requesterEmployeeId).toBe('EMP-777');
  });

  it('refuses to submit with the Employee ID blank', async () => {
    const { ContactAdminPage } = await import('../contact-admin');
    render(<MemoryRouter><ContactAdminPage /></MemoryRouter>);
    fireEvent.change(screen.getByLabelText('Request Type'), { target: { value: 'UNLOCK' } });
    fireEvent.click(screen.getByRole('button', { name: /submit request/i }));
    expect(await screen.findByText(/Please fill in the required details:.*Your Employee ID/)).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(c => String(c[0]).endsWith('/api/admin-requests'))).toBe(false);
  });
});
