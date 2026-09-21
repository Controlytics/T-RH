import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { cn } from '@/lib/cn';
import type { StatusTone } from './status-badge';

/**
 * A screen-level figure (UI v3, 2026-09-21): icon medallion, eyebrow, ONE
 * number, optional link — the card of `cc-dashboard.png` and `Alarms.png`.
 *
 * `tone` tints the ground with the STATUS ground and paints a 3px top rail in
 * the status dot; `neutral` uses the theme tint. Status colour never travels
 * alone here either: the eyebrow is the word beside the colour.
 *
 * Deliberately absent: the mockups' sparkline and "↑ 2 from yesterday".
 * Nothing in this system stores alarm-state history, and a trend line drawn
 * from nothing would be a fabrication on a §11 screen. One number.
 */
const GROUND: Record<StatusTone | 'neutral', { bg: string; rail: string; medallion: string }> = {
  neutral: { bg: 'bg-[var(--surface-tint-1)]', rail: 'bg-[var(--theme-primary,#2a78d6)]', medallion: '' },
  ok: { bg: 'bg-[var(--status-ok-bg)]', rail: 'bg-[var(--status-ok-dot)]', medallion: 'bg-[var(--status-ok-dot)]' },
  warn: { bg: 'bg-[var(--status-warn-bg)]', rail: 'bg-[var(--status-warn-dot)]', medallion: 'bg-[var(--status-warn-dot)]' },
  danger: { bg: 'bg-[var(--status-danger-bg)]', rail: 'bg-[var(--status-danger-dot)]', medallion: 'bg-[var(--status-danger-dot)]' },
  info: { bg: 'bg-[var(--status-info-bg)]', rail: 'bg-[var(--status-info-dot)]', medallion: 'bg-[var(--status-info-dot)]' },
  idle: { bg: 'bg-[var(--status-idle-bg)]', rail: 'bg-[var(--status-idle-dot)]', medallion: 'bg-[var(--status-idle-dot)]' },
};

export function StatCard({
  eyebrow, value, icon, tone = 'neutral', to, linkLabel = 'View details', className,
}: {
  eyebrow: string;
  value: ReactNode;
  icon: ReactNode;
  tone?: StatusTone | 'neutral';
  to?: string;
  linkLabel?: string;
  className?: string;
}) {
  const g = GROUND[tone];
  return (
    <div
      data-testid="stat-card"
      data-tone={tone}
      className={cn(
        'relative overflow-hidden rounded-[var(--radius-card)] border border-slate-200/70 px-5 pb-4 pt-5 shadow-[var(--elev-1)]',
        g.bg, className,
      )}
    >
      <span aria-hidden className={cn('absolute inset-x-0 top-0 h-[3px]', g.rail)} />
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[0.625rem] font-semibold uppercase tracking-[0.12em] text-slate-500">{eyebrow}</p>
          <p className="mt-2 text-[length:var(--text-figure)] font-semibold leading-[var(--text-figure--line-height)] tabular-nums text-slate-900">
            {value}
          </p>
        </div>
        <span
          aria-hidden
          className={cn('flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white shadow-[var(--elev-1)]', g.medallion)}
          style={tone === 'neutral' ? { background: 'var(--band-gradient)' } : undefined}
        >
          {icon}
        </span>
      </div>
      {to && (
        <Link to={to} className="mt-3 inline-flex items-center gap-1 text-[0.8125rem] font-medium text-[var(--theme-primary,#2a78d6)] hover:underline">
          {linkLabel}
          <span aria-hidden>›</span>
        </Link>
      )}
    </div>
  );
}
