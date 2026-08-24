import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { InstrumentStatus } from '@digilog/shared';
import { statusClasses, readingAge } from '@/routes/dashboard/status';

/**
 * The trend page's identity strip.
 *
 * A gradient band in the app's existing convention (`--theme-sidebar-bg` →
 * `--theme-primary-dark`) — the same device the graphical view's plan header
 * uses. This is NOT a dark theme: it is the one accent band the house style
 * already sanctions, and it anchors a page that otherwise floats on a stack of
 * white cards.
 *
 * It carries what identifies the record — the instrument code, where it is,
 * and whether it is reporting right now — so the reader knows what they are
 * looking at before they read a single number.
 */
export function TrendHeader({
  code, name, placement, status, lastReadingTs, backTo, actions,
}: {
  code: string;
  name: string;
  /** Location · Area · Block, already assembled; empty when none is recorded. */
  placement: string;
  /** Resolved SERVER-SIDE and taken as given — this page never re-judges it. */
  status: InstrumentStatus | null;
  lastReadingTs: string | null;
  backTo: string;
  /** The combined download control. */
  actions?: ReactNode;
}) {
  const sc = status ? statusClasses(status) : null;

  return (
    <header
      className="rounded-2xl px-5 py-4 text-white shadow-sm"
      style={{ background: 'linear-gradient(135deg, var(--theme-sidebar-bg), var(--theme-primary-dark))' }}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <Link
            to={backTo}
            className="text-[11px] font-medium text-white/70 underline-offset-2 hover:text-white hover:underline focus-visible:underline focus-visible:outline-none"
          >
            &larr; Back to instrument
          </Link>
          {/* The code is an IDENTIFIER, not prose — mono, bold. */}
          <h1 className="mt-1 truncate font-mono text-2xl font-bold tracking-tight text-white">
            {code}
            <span className="ml-2 font-sans text-sm font-normal text-white/70">Trend</span>
          </h1>
          <p className="mt-0.5 truncate text-xs text-white/75">
            {name}
            {placement && <span className="text-white/55"> · {placement}</span>}
          </p>
        </div>

        <div className="flex flex-col items-end gap-2">
          {actions}
          {/* Status colour never carries meaning alone: the dot has the word
              beside it, and the word is `statusClasses`', not a second
              vocabulary invented for this header. */}
          <p className="flex items-center gap-1.5 text-xs text-white/85">
            {sc ? (
              <>
                <span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} aria-hidden="true" />
                <span className="font-semibold text-white">{sc.label}</span>
                <span className="text-white/60">·</span>
              </>
            ) : null}
            <span className="tabular-nums">
              {lastReadingTs ? `updated ${readingAge(lastReadingTs)}` : 'no readings yet'}
            </span>
          </p>
        </div>
      </div>
    </header>
  );
}
