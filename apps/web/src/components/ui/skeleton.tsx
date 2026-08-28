import { cn } from '@/lib/cn';

/**
 * A placeholder in the SHAPE of what is loading.
 *
 * A skeleton is only better than a spinner when it predicts the layout — three
 * bars where three bars will be. A generic grey block that gets replaced by
 * something a different size makes the page jump, which is worse than having
 * shown nothing.
 *
 * `aria-hidden` with a live region alongside: a screen reader should hear
 * "Loading", not a description of nine grey rectangles.
 */
export function Skeleton({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn('block animate-pulse rounded-[var(--radius-control)] bg-slate-200/80', className)}
    />
  );
}

/** Rows of a table that is still loading, matching its real column count. */
export function SkeletonRows({ rows = 5, columns = 4 }: { rows?: number; columns?: number }) {
  return (
    <>
      <span className="sr-only" role="status">Loading…</span>
      <div className="space-y-2" aria-hidden>
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex gap-3">
            {Array.from({ length: columns }, (_, c) => (
              <Skeleton
                key={c}
                className={cn('h-9 flex-1', c === 0 && 'max-w-[28%]')}
                // The first column is narrower because an identifier column
                // almost always is; a row of equal blocks predicts a table
                // nobody has.
              />
            ))}
          </div>
        ))}
      </div>
    </>
  );
}

/** A card whose content has not arrived: title, two lines, a figure. */
export function SkeletonCard({ lines = 2, className }: { lines?: number; className?: string }) {
  return (
    <div className={cn('rounded-[var(--radius-card)] border border-slate-200 bg-white p-5', className)}>
      <span className="sr-only" role="status">Loading…</span>
      <Skeleton className="h-4 w-1/3" />
      <div className="mt-3 space-y-2">
        {Array.from({ length: lines }, (_, i) => (
          <Skeleton key={i} className={cn('h-3', i === lines - 1 ? 'w-2/3' : 'w-full')} />
        ))}
      </div>
    </div>
  );
}
