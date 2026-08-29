import type { ReactNode } from 'react';
import type { NavCard } from './location-nav';
import { ALL_INSTRUMENTS } from './location-nav';

/**
 * The dashboard landing — two hero cards, then Blocks Overview.
 *
 * Built to a supplied reference design (`Screen-1.png`, 2026-08-29). The layout,
 * palette and card anatomy are the operator's call, not a proposal, so this
 * follows the reference rather than reinterpreting it. What IS a decision here
 * is everything the reference could not specify: it showed exactly four blocks
 * named CWH / FD / PFI / MUPS, and this installation can have any number with
 * any names, so accent colour and glyph are assigned BY POSITION from fixed
 * cycles below. Same block, same colour, every load — and a fifth block gets a
 * colour instead of falling off the end of a hardcoded list.
 *
 * Every count is live. Nothing here holds a number of its own.
 */

/* ── Accents ──────────────────────────────────────────────────────────────
   Fixed hex, not `--theme-*`. The reference gives each block its own identity
   so a supervisor can find "the orange one" at a glance across the room, and
   that only works if the colours stay put when an operator switches theme.
   Same reasoning as the `--chart-series-*` palette: identity colours are data,
   not chrome. Ordered for maximum adjacent separation, and each pairs a hue
   with a distinct glyph so colour is never the only signal. */
const BLOCK_ACCENTS = [
  { ring: '#0d9488', text: '#0f766e', wave: '#5eead4' }, // teal
  { ring: '#16a34a', text: '#15803d', wave: '#86efac' }, // green
  { ring: '#f97316', text: '#ea580c', wave: '#fdba74' }, // orange
  { ring: '#a855f7', text: '#9333ea', wave: '#d8b4fe' }, // violet
  { ring: '#0284c7', text: '#0369a1', wave: '#7dd3fc' }, // sky
  { ring: '#e11d48', text: '#be123c', wave: '#fda4af' }, // rose
] as const;

/* Glyphs cycle alongside the accents. Line icons at 24px, matching the app's
   existing stroke-1.5/2 set — a filled or duotone set here would read as a
   different product two cards along. */
const BLOCK_GLYPHS: ReactNode[] = [
  // factory
  <path key="f" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
    d="M3 21h18M5 21V9l5 3V9l5 3V6l4 2v13M9 21v-4h4v4" />,
  // leaf
  <path key="l" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
    d="M4 20c8 2 15-3 16-13-9-1-15 3-16 9a5 5 0 001 4zm0 0l7-7" />,
  // gear
  <path key="g" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
    d="M12 15a3 3 0 100-6 3 3 0 000 6zm8-3a8 8 0 01-.1 1.2l2 1.6-2 3.4-2.4-1a8 8 0 01-2 1.2L15 21H9l-.5-2.6a8 8 0 01-2-1.2l-2.4 1-2-3.4 2-1.6a8 8 0 010-2.4l-2-1.6 2-3.4 2.4 1a8 8 0 012-1.2L9 3h6l.5 2.6a8 8 0 012 1.2l2.4-1 2 3.4-2 1.6c.1.4.1.8.1 1.2z" />,
  // bolt
  <path key="b" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
    d="M13 2L4.5 13.5H11L10 22l8.5-11.5H12L13 2z" />,
  // beaker
  <path key="k" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
    d="M9 3v6.5L4.5 18A2 2 0 006.2 21h11.6a2 2 0 001.7-3L15 9.5V3M8 3h8M7.5 14h9" />,
  // building
  <path key="d" strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
    d="M4 21V5a2 2 0 012-2h7a2 2 0 012 2v16M15 21V11h3a2 2 0 012 2v8M8 7h3M8 11h3M8 15h3" />,
];

/** The wave that closes each block card in the reference. */
function CardWave({ color }: { color: string }) {
  return (
    <svg
      className="pointer-events-none absolute inset-x-0 bottom-0 h-20 w-full"
      viewBox="0 0 400 80" preserveAspectRatio="none" aria-hidden focusable="false"
    >
      {/* Two offset crests, both LOW and pale. The link sits over this, so the
          wave has to stay decoration — at the first pass it was tall and opaque
          enough to cut through "View Details", which is the one thing on the
          card a person actually clicks. */}
      <path d="M0 46c60-26 120 10 200 3s140-32 200-13v44H0z" fill={color} opacity="0.16" />
      <path d="M0 62c70-20 130 9 200 2s130-25 200-8v24H0z" fill={color} opacity="0.28" />
    </svg>
  );
}

function ViewDetails({ color }: { color: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-[13px] font-semibold" style={{ color }}>
      View Details
      <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 12h13m0 0l-5-5m5 5l-5 5" />
      </svg>
    </span>
  );
}

/** Shared card chrome. A button, so it is keyboard-reachable and announces as one. */
function CardShell({
  onClick, label, className, style, children,
}: {
  onClick: () => void;
  /** What a screen reader hears. The visible text is split across the card. */
  label: string;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={`group relative isolate overflow-hidden rounded-2xl border border-slate-200/80 bg-white text-left transition-all duration-200 hover:-translate-y-0.5 hover:shadow-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 ${className ?? ''}`}
      style={{ boxShadow: 'var(--elev-1)', ...style }}
    >
      {children}
    </button>
  );
}

export interface EntryCardsProps {
  /** nav.cards — [0] is All Instruments, the rest are Blocks. */
  cards: NavCard[];
  onSelect: (id: string) => void;
  /** Null when the viewer cannot see alarms; the Alarms card is then omitted. */
  alarms: { active: number; unacknowledged: number } | null;
  onOpenAlarms: () => void;
}

export function EntryCards({ cards, onSelect, alarms, onOpenAlarms }: EntryCardsProps) {
  const all = cards.find((c) => c.id === ALL_INSTRUMENTS);
  const blocks = cards.filter((c) => c.id !== ALL_INSTRUMENTS);
  const activeAlarms = alarms?.active ?? 0;

  return (
    <div className="space-y-8">
      {/* ── Hero row ─────────────────────────────────────────────────────── */}
      <div className={`grid gap-5 ${alarms ? 'lg:grid-cols-2' : ''}`}>
        {all && (
          <CardShell
            onClick={() => onSelect(all.id)}
            label={`All instruments — ${all.count}. View details.`}
            className="p-6 focus-visible:ring-blue-500"
          >
            <div className="flex items-start gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-blue-600 text-white shadow-sm">
                <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                    d="M12 3l9 4.5-9 4.5-9-4.5L12 3zM3 12l9 4.5 9-4.5M3 16.5L12 21l9-4.5" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[17px] font-bold text-slate-900">All Instruments</h3>
                <p className="mt-0.5 text-[13px] text-slate-500">
                  Every registered instrument across the system
                </p>
              </div>
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-blue-50 text-blue-600">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 17l5-6 4 4 6-8" />
                </svg>
              </span>
            </div>

            <p className="mt-6 text-[46px] font-extrabold leading-none tracking-tight text-blue-600 tabular-nums">
              {all.count.toLocaleString()}
            </p>
            <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Instruments
            </p>

            <div className="mt-4 flex justify-end">
              <ViewDetails color="#2563eb" />
            </div>
          </CardShell>
        )}

        {alarms && (
          <CardShell
            onClick={onOpenAlarms}
            label={`Active alarms — ${activeAlarms}. View details.`}
            className="p-6 focus-visible:ring-rose-500"
            // The pink wash from the reference. It is the only card that carries
            // a tint, which is what makes it read as the exception on the page.
            style={{ backgroundImage: 'linear-gradient(135deg, #fff 40%, #fff1f2 100%)' }}
          >
            <div className="flex items-start gap-4">
              <span className="flex h-14 w-14 shrink-0 items-center justify-center rounded-full bg-gradient-to-br from-rose-500 to-red-600 text-white shadow-sm">
                <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8}
                    d="M15 17h5l-1.4-1.4A2 2 0 0118 14.2V11a6 6 0 10-12 0v3.2c0 .5-.2 1-.6 1.4L4 17h5m6 0a3 3 0 11-6 0m6 0H9" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-[17px] font-bold text-slate-900">Active Alarms</h3>
                <p className="mt-0.5 text-[13px] text-slate-500">
                  {/* Says what to DO, and stays honest at zero. */}
                  {activeAlarms > 0 ? 'Require your attention' : 'Nothing to attend to'}
                </p>
              </div>
              <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-rose-50 text-rose-600">
                <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d="M12 9v4m0 4h.01M10.3 3.9L1.8 18a2 2 0 001.7 3h17a2 2 0 001.7-3L14.7 3.9a2 2 0 00-3.4 0z" />
                </svg>
              </span>
            </div>

            {/* Green at zero, red otherwise. A red 0 trains people to ignore red. */}
            <p
              className="mt-6 text-[46px] font-extrabold leading-none tracking-tight tabular-nums"
              style={{ color: activeAlarms > 0 ? '#e11d48' : '#059669' }}
            >
              {activeAlarms.toLocaleString()}
            </p>
            <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
              Alarms
            </p>

            <div className="mt-4 flex items-end justify-between gap-3">
              <p className="text-[12px] text-slate-500">
                {(alarms.unacknowledged ?? 0) > 0
                  ? `${alarms.unacknowledged} awaiting acknowledgement`
                  : ' '}
              </p>
              <ViewDetails color={activeAlarms > 0 ? '#e11d48' : '#059669'} />
            </div>
          </CardShell>
        )}
      </div>

      {/* ── Blocks Overview ──────────────────────────────────────────────── */}
      {blocks.length > 0 && (
        <section>
          <h2 className="text-[17px] font-bold text-slate-900">Blocks Overview</h2>
          <p className="mt-0.5 text-[13px] text-slate-500">Overview of all functional blocks</p>

          <div className="mt-4 grid gap-5 sm:grid-cols-2 xl:grid-cols-4">
            {blocks.map((b, i) => {
              const accent = BLOCK_ACCENTS[i % BLOCK_ACCENTS.length];
              const glyph = BLOCK_GLYPHS[i % BLOCK_GLYPHS.length];
              return (
                <CardShell
                  key={b.id}
                  onClick={() => onSelect(b.id)}
                  label={`${b.label} — ${b.count} instruments. View details.`}
                  className="min-h-[18rem] p-6 pb-5"
                  style={{ ['--tw-ring-color' as string]: accent.ring }}
                >
                  <CardWave color={accent.wave} />

                  {/* Above the wave. The wave is decoration and must never
                      swallow a number. */}
                  <div className="relative z-10 flex h-full flex-col">
                    <span
                      className="flex h-14 w-14 items-center justify-center rounded-full text-white shadow-sm"
                      style={{ backgroundColor: accent.ring }}
                    >
                      <svg className="h-7 w-7" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                        {glyph}
                      </svg>
                    </span>

                    <h3 className="mt-4 truncate text-[17px] font-bold text-slate-900" title={b.label}>
                      {b.label}
                    </h3>
                    <p className="mt-0.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      {b.sublabel}
                    </p>

                    <p
                      className="mt-5 text-[40px] font-extrabold leading-none tracking-tight tabular-nums"
                      style={{ color: accent.text }}
                    >
                      {b.count.toLocaleString()}
                    </p>
                    <p className="mt-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-500">
                      Instruments
                    </p>

                    <div className="mt-auto flex justify-end pt-6">
                      <ViewDetails color={accent.text} />
                    </div>
                  </div>
                </CardShell>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
