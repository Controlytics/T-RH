import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('@/hooks/use-branding', () => ({
  useBranding: () => ({ branding: { loginBgStart: '#164e63', loginBgEnd: '#1e3a5f', gradientStart: '#0891b2', gradientEnd: '#0d9488' } }),
}));
const { AuthShell } = await import('../auth-shell');

describe('AuthShell', () => {
  it('centres its content in one card over the band', () => {
    render(<AuthShell><form aria-label="Sign in" /></AuthShell>);
    const card = screen.getByTestId('auth-card');
    expect(card.contains(screen.getByRole('form', { name: 'Sign in' }))).toBe(true);
    expect(card.className).toMatch(/max-w-md/);
  });

  it('can be the wider card', () => {
    render(<AuthShell width="lg"><p>x</p></AuthShell>);
    expect(screen.getByTestId('auth-card').className).toMatch(/max-w-lg/);
  });
});
