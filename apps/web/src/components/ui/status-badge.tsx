import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * A status, said the same way on every screen.
 *
 * **Colour never travels alone.** Every badge carries a dot AND a word, because
 * this is a monitoring application read by people who may not distinguish the
 * greens from the ambers, and a colour-only status is a status that person
 * cannot read. That rule predates this component and is why it takes a `label`
 * rather than only a tone.
 *
 * Five tones, deliberately — one per meaning, not one per colour someone liked.
 * A sixth would mean two tones competing to say the same thing.
 */
export type StatusTone = 'ok' | 'warn' | 'danger' | 'info' | 'idle';

const TONE: Record<StatusTone, { bg: string; ink: string; dot: string }> = {
  ok: { bg: 'bg-[var(--status-ok-bg)]', ink: 'text-[var(--status-ok-ink)]', dot: 'bg-[var(--status-ok-dot)]' },
  warn: { bg: 'bg-[var(--status-warn-bg)]', ink: 'text-[var(--status-warn-ink)]', dot: 'bg-[var(--status-warn-dot)]' },
  danger: { bg: 'bg-[var(--status-danger-bg)]', ink: 'text-[var(--status-danger-ink)]', dot: 'bg-[var(--status-danger-dot)]' },
  info: { bg: 'bg-[var(--status-info-bg)]', ink: 'text-[var(--status-info-ink)]', dot: 'bg-[var(--status-info-dot)]' },
  idle: { bg: 'bg-[var(--status-idle-bg)]', ink: 'text-[var(--status-idle-ink)]', dot: 'bg-[var(--status-idle-dot)]' },
};

export function StatusBadge({
  tone = 'idle', label, pulse = false, className,
}: {
  tone?: StatusTone;
  /** The word. Required — this is the half a colour cannot carry. */
  label: string;
  /** For a live, currently-raised condition only. Never for a steady state:
   *  something that pulses forever stops meaning "look at me". */
  pulse?: boolean;
  className?: string;
}) {
  const t = TONE[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-pill)] px-2.5 py-1 text-[0.75rem] font-medium',
        t.bg, t.ink, className,
      )}
    >
      <span className={cn('relative flex h-1.5 w-1.5 shrink-0 rounded-full', t.dot)} aria-hidden>
        {pulse && (
          <span className={cn('absolute inline-flex h-full w-full animate-ping rounded-full opacity-75', t.dot)} />
        )}
      </span>
      {label}
    </span>
  );
}

/** A count beside a label, for a header's meta row. */
export function MetaPill({ icon, children, className }: { icon?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-[var(--radius-control)] border border-slate-200 bg-slate-50 px-2 py-1 text-[0.75rem] text-slate-600',
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
