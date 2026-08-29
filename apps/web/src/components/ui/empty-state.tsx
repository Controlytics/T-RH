import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

/**
 * What a screen shows when it has nothing to show.
 *
 * An empty screen is an instruction, not a blank. It has to answer why there is
 * nothing here and what to do about it — and those are different answers for
 * "nothing exists yet" and "your filter matched nothing", which is why `action`
 * is optional and the copy is the caller's.
 *
 * Errors are NOT empty states and do not belong here: an empty list is a normal
 * condition, a failed request is a fault, and telling an operator "no
 * instruments found" when the API returned 500 sends them to create something
 * that already exists.
 */
export function EmptyState({
  icon, title, description, action, compact = false, className,
}: {
  icon?: ReactNode;
  /** What is not here. Plain: "No instruments yet". */
  title: string;
  /** What to do about it, in one or two lines. */
  description?: string;
  action?: ReactNode;
  /** For inside a card, where the full treatment would dwarf its container. */
  compact?: boolean;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center text-center',
        compact ? 'gap-2 px-4 py-8' : 'gap-3 px-6 py-14',
        className,
      )}
    >
      {icon && (
        <span
          className={cn(
            'flex items-center justify-center rounded-full bg-slate-100 text-slate-400',
            compact ? 'h-10 w-10' : 'h-14 w-14',
          )}
        >
          {icon}
        </span>
      )}
      <p className={cn('font-semibold text-slate-800', compact ? 'text-[0.875rem]' : 'text-[1rem]')}>{title}</p>
      {description && (
        <p className={cn('max-w-sm text-slate-500', compact ? 'text-[0.75rem]' : 'text-[0.8125rem]')}>{description}</p>
      )}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

/**
 * A failed request, which is a different thing from an empty one.
 *
 * Says what failed and offers the retry, rather than apologising. An error that
 * apologises but does not say what to do next has spent the operator's attention
 * on nothing.
 */
export function ErrorState({
  title = 'Could not load this', detail, onRetry, className,
}: {
  title?: string;
  detail?: string;
  onRetry?: () => void;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'flex flex-col items-center gap-2 rounded-[var(--radius-card)] border border-rose-200 bg-rose-50 px-6 py-8 text-center',
        className,
      )}
    >
      <svg aria-hidden viewBox="0 0 20 20" className="h-6 w-6 fill-rose-600">
        <path d="M10 2 19 18H1L10 2Zm0 5.5a1 1 0 0 0-1 1v4a1 1 0 1 0 2 0v-4a1 1 0 0 0-1-1Zm0 7.25a1.1 1.1 0 1 0 0 2.2 1.1 1.1 0 0 0 0-2.2Z" />
      </svg>
      <p className="text-[0.9375rem] font-semibold text-rose-900">{title}</p>
      {detail && <p className="max-w-md text-[0.8125rem] text-rose-800">{detail}</p>}
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="mt-1 rounded-[var(--radius-control)] border border-rose-300 bg-white px-3 py-1.5 text-[0.8125rem] font-medium text-rose-800 hover:bg-rose-100"
        >
          Try again
        </button>
      )}
    </div>
  );
}
