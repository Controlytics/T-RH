import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('swr', () => ({ default: () => ({ data: undefined, mutate: vi.fn() }) }));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => ({ user: null, login: vi.fn(), logout: vi.fn(), isAuthenticated: false }) }));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: { success: vi.fn(), error: vi.fn() } }) }));
vi.mock('@/hooks/use-datetime-format', () => ({
  useDatetimeFormat: () => ({ formatDateTime: (d: string) => d, formatDate: (d: string) => d, formatTime: (d: string) => d }),
}));
vi.mock('@/hooks/use-single-tab', () => ({ checkExistingUserSession: vi.fn(async () => null) }));
vi.mock('@/lib/api-client', () => ({ apiClient: { get: vi.fn(), post: vi.fn(), put: vi.fn() } }));
vi.mock('@/hooks/use-branding', () => ({
  useBranding: () => ({ branding: {
    appName: 'T&RH-Monitoring', appTagline: '21 CFR Part 11', logoUrl: '', logoText: 'CC', companyName: 'Controlytics',
    version: '1.0', primaryColor: '#0891b2', secondaryColor: '#0d9488', accentColor: '#14b8a6',
    gradientStart: '#0891b2', gradientMiddle: '#0d9488', gradientEnd: '#14b8a6', loginBgStart: '#164e63', loginBgEnd: '#1e3a5f',
  } }),
}));

/**
 * No test mounted a pre-login page before UI v3 (2026-09-21). Each one now
 * renders inside the shared AuthShell; this proves the wrapper change broke
 * no hook order and no import — the fault a typecheck cannot see.
 */
describe('auth pages render inside AuthShell', () => {
  it('login', async () => {
    const { LoginPage } = await import('../login');
    render(<MemoryRouter><LoginPage /></MemoryRouter>);
    expect(screen.getByTestId('auth-card')).toBeInTheDocument();
  });
  it('forgot password', async () => {
    const { ForgotPasswordPage } = await import('../forgot-password');
    render(<MemoryRouter><ForgotPasswordPage /></MemoryRouter>);
    expect(screen.getByTestId('auth-card')).toBeInTheDocument();
  });
  it('change password', async () => {
    const { ChangePasswordPage } = await import('../change-password');
    render(<MemoryRouter><ChangePasswordPage /></MemoryRouter>);
    expect(screen.getByTestId('auth-card')).toBeInTheDocument();
  });
  it('contact admin', async () => {
    const { ContactAdminPage } = await import('../contact-admin');
    render(<MemoryRouter><ContactAdminPage /></MemoryRouter>);
    expect(screen.getByTestId('auth-card')).toBeInTheDocument();
  });
});
