import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { useBranding } from '@/hooks/use-branding';

/**
 * The frame of every pre-login screen (UI v3, 2026-09-21): full-bleed
 * theme gradient with two soft circles, one centred white card. The four
 * auth pages each drew their own background before — one on slate-100, one
 * on a three-stop gradient, two on a diagonal — so the product's first
 * screen and its second did not match.
 *
 * The gradient reads the Branding login colours, as before, so the Login
 * Background section of Configuration → Branding still does what it says.
 */
export function AuthShell({ children, width = 'md' }: { children: ReactNode; width?: 'md' | 'lg' }) {
  const { branding } = useBranding();
  return (
    <div
      data-testid="auth-shell"
      className="relative flex min-h-screen items-center justify-center overflow-hidden p-6"
      style={{ background: `linear-gradient(135deg, ${branding.loginBgStart}, ${branding.loginBgEnd})` }}
    >
      <span aria-hidden className="pointer-events-none absolute -left-24 -top-24 h-96 w-96 rounded-full bg-white/[0.07]" />
      <span aria-hidden className="pointer-events-none absolute -bottom-32 -right-16 h-[28rem] w-[28rem] rounded-full bg-white/[0.05]" />
      <div
        data-testid="auth-card"
        className={cn(
          'relative w-full overflow-hidden rounded-[var(--radius-card)] bg-white shadow-[var(--elev-3)]',
          width === 'lg' ? 'max-w-lg' : 'max-w-md',
        )}
      >
        <div className="h-1.5" style={{ background: `linear-gradient(90deg, ${branding.gradientStart}, ${branding.gradientEnd})` }} />
        {children}
      </div>
    </div>
  );
}
