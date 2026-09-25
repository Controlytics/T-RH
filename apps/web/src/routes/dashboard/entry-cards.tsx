import type { ReactNode } from 'react';
import type { NavCard } from './location-nav';
import { ALL_INSTRUMENTS } from './location-nav';

/**
 * The dashboard landing — two hero cards, then Blocks Overview.
 *
 * Built to a supplied reference design (`Screen-1.png`, 2026-08-29). The layout
 * and card anatomy are the operator's call, not a proposal, so this follows the
 * reference rather than reinterpreting it. What IS a decision here is
 * everything the reference could not specify: it showed exactly four blocks
 * named CWH / FD / PFI / MUPS, and this installation can have any number with
 * any names, so accent colour is assigned BY POSITION from a fixed cycle
 * below. Same block, same colour, every load — and a fifth block gets a
 * colour instead of falling off the end of a hardcoded list.
 *
 * NO SYMBOLS (operator, 2026-09-25: "remove symbols in cards"): the glyph
 * discs, the corner icons and the link arrow are gone. A card is its colour,
 * its words and its number.
 *
 * FULL-COLOUR CARDS since 2026-09-25 (operator: "all instruments card, active
 * alarms cards, blocks cards and areas cards and background should be fully
 * colorfull"). Until then each card was white with a coloured medallion and
 * figure; now the whole card is its colour — a diagonal gradient with white
 * type, the house band pattern (`PageHero`, `--band-gradient`) applied per
 * card. The palette is still identity, not status: the same block keeps the
 * same colour whatever theme is chosen. The one card whose colour DOES carry
 * meaning is Active Alarms — green at zero, red above — and that meaning is
 * also stated in words beside the figure, so colour never travels alone.
 *
 * Every count is live. Nothing here holds a number of its own.
 */

/* ── Accents ──────────────────────────────────────────────────────────────
   Fixed hex, not `--theme-*`. The reference gives each block its own identity
   so a supervisor can find "the orange one" at a glance across the room, and
   that only works if the colours stay put when an operator switches theme.
   Same reasoning as the `--chart-series-*` palette: identity colours are data,
   not chrome. Ordered for maximum adjacent separation; the block's NAME is
   printed on every card, so colour is never the only signal.

   Both gradient ends are the 700 / 900 weights, NOT the 500s the medallions
   used to wear: white body text (the 11px eyebrows) needs 4.5:1, and the light
   end measures 5.0–6.3:1 on every pair here (checked with the same formula as
   `apps/web/scripts/contrast-check.mjs`). A brighter end would read as more
   colour and fail the eyebrow. `wave` stays pale: it is drawn translucent over
   the gradient, not written on. */
const BLOCK_ACCENTS = [
  { from: '#0f766e', to: '#134e4a', wave: '#5eead4' }, // teal
  { from: '#15803d', to: '#14532d', wave: '#86efac' }, // green
  { from: '#c2410c', to: '#7c2d12', wave: '#fdba74' }, // orange
  { from: '#7e22ce', to: '#581c87', wave: '#d8b4fe' }, // violet
  { from: '#0369a1', to: '#0c4a6e', wave: '#7dd3fc' }, // sky
  { from: '#be123c', to: '#881337', wave: '#fda4af' }, // rose
] as const;

/** Active Alarms: red when there is something to attend to, green at zero. A red
    zero trains people to ignore red. Same contrast rule as the block accents. */
const ALARM_TONES = {
  danger: { from: '#e11d48', to: '#9f1239' },
  ok: { from: '#047857', to: '#065f46' },
} as const;

/** One diagonal, the same on every card, so the row reads as one set. */
const gradient = (from: string, to: string) => `linear-gradient(135deg, ${from} 0%, ${to} 100%)`;

/** All Instruments wears the THEME, the way the page heroes do. The 78 % black
    mix is `--band-gradient`'s, proven for white text on all ten presets. */
const THEME_GRADIENT =
  'linear-gradient(135deg, color-mix(in srgb, var(--theme-gradient-from, #2a78d6) 78%, black), color-mix(in srgb, var(--theme-gradient-to, #1e3a5f) 78%, black))';

/** The wave that closes each block card in the reference. */
function CardWave({ color }: { color: string }) {
  return (
    <svg
      className="pointer-events-none absolute inset-x-0 bottom-0 h-16 w-full xl:h-20"
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

/** A soft highlight in the card's top-right corner: the sheen that makes a flat
    gradient read as a surface. Pure decoration, behind everything. */
function Sheen() {
  return (
    <>
      <span aria-hidden className="pointer-events-none absolute -right-12 -top-16 h-44 w-44 rounded-full bg-white/15 blur-2xl" />
      <span aria-hidden className="pointer-events-none absolute -left-10 bottom-6 h-28 w-28 rounded-full bg-white/10 blur-2xl" />
    </>
  );
}

/**
 * The active / inactive split under a count.
 *
 * Takes the TOTAL and the ACTIVE figure and derives inactive, rather than
 * accepting both: two independently supplied numbers can disagree with the
 * headline, and "100 instruments — 60 active, 30 inactive" is a defect an
 * operator has to reason about mid-shift.
 *
 * Colour is never the only signal. Inactive is dimmed AND labelled, so the
 * distinction survives a monochrome print of a §11 report and a colour-blind
 * reader. On the coloured ground the two are white chips: the words carry
 * the meaning, the dot only echoes it.
 */
function ActiveSplit({ total, active, large = false }: { total: number; active?: number; large?: boolean }) {
  // No split available (the "directly linked" card) — say nothing rather than
  // implying everything is active.
  if (active === undefined) return null;
  const inactive = Math.max(0, total - active);
  const size = large ? 'text-[0.875rem]' : 'text-[0.75rem]';
  return (
    <p className={`mt-3 flex flex-wrap items-center gap-2 ${size}`}>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/15 px-2.5 py-1 font-bold text-white ring-1 ring-white/20">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-emerald-300" />
        {active.toLocaleString()} active
      </span>
      <span className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-2.5 py-1 font-semibold text-white/80 ring-1 ring-white/15">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-white/50" />
        {inactive.toLocaleString()} inactive
      </span>
    </p>
  );
}

function ViewDetails({ large = false }: { large?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full bg-white/15 px-3 py-1.5 font-bold text-white ring-1 ring-white/25 transition-colors group-hover:bg-white/25 ${large ? 'text-[0.9375rem]' : 'text-[0.8125rem]'}`}>
      View Details
    </span>
  );
}

/** Shared card chrome. A button, so it is keyboard-reachable and announces as one.
    `background` is the card's whole colour — a gradient string.

    `flex flex-col` is load-bearing: a <button> CENTRES its content vertically
    by default, and the two hero cards share one grid row, so the shorter one
    (Active Alarms, no active/inactive chips) was stretched to its neighbour's
    height with its heading floating mid-card (operator, 2026-09-25: "why gap
    coming on active alarms heading top"). As a column flex box the content
    stacks from the top and each card's footer is pushed to the bottom with
    `mt-auto`, so View Details lines up across the row. */
function CardShell({
  onClick, label, background, className, style, children, ...data
}: {
  onClick: () => void;
  /** What a screen reader hears. The visible text is split across the card. */
  label: string;
  background: string;
  className?: string;
  style?: React.CSSProperties;
  children: ReactNode;
  'data-tone'?: string;
  'data-accent'?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      {...data}
      className={`group relative isolate flex flex-col overflow-hidden rounded-2xl border border-white/15 text-left text-white transition-all duration-200 hover:-translate-y-0.5 hover:shadow-elevated focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white focus-visible:ring-offset-2 ${className ?? ''}`}
      style={{ boxShadow: 'var(--elev-2)', backgroundImage: background, ...style }}
    >
      <Sheen />
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
  /**
   * Names what the lower section is listing. Required because the same
   * component renders Blocks at the top level and one Block's AREAS a level
   * down — it said "Blocks Overview" over a grid of Areas until 2026-08-29.
   *
   * `null` SUPPRESSES the heading entirely (operator, 2026-08-29: the "Areas /
   * Areas in CWH Block" pair inside a Block was restating the breadcrumb
   * directly above it). A default parameter only fires on `undefined`, so
   * passing null is what turns it off — omitting the prop still gets
   * "Blocks Overview".
   */
  sectionTitle?: string | null;
  sectionSubtitle?: string | null;
  /** True when the page ground is the DEEP one (only these cards on screen), so
      the section heading prints in white; false over the light tint. */
  dark?: boolean;
}

export function EntryCards({
  cards, onSelect, alarms, onOpenAlarms,
  sectionTitle = 'Blocks Overview',
  sectionSubtitle = 'Overview of all functional blocks',
  dark = false,
}: EntryCardsProps) {
  const all = cards.find((c) => c.id === ALL_INSTRUMENTS);
  const blocks = cards.filter((c) => c.id !== ALL_INSTRUMENTS);
  const activeAlarms = alarms?.active ?? 0;
  const alarmTone = activeAlarms > 0 ? 'danger' : 'ok';

  return (
    <div className="space-y-8">
      {/* ── Hero row ─────────────────────────────────────────────────────────
          Rendered ONLY when it has a card to hold. Below the top level there is
          no All Instruments card and no alarms tile, and an empty grid div still
          collects the parent's `space-y-8` — 2rem of dead space above the grid
          with nothing drawn in it. */}
      {(all || alarms) && (
      <div className={`grid gap-4 xl:gap-5 ${alarms ? 'lg:grid-cols-2' : ''}`}>
        {all && (
          <CardShell
            onClick={() => onSelect(all.id)}
            label={`All instruments — ${all.count}. View details.`}
            background={THEME_GRADIENT}
            className="p-5 xl:p-6"
          >
            <div className="min-w-0">
              <h3 className="text-[1.25rem] font-extrabold text-white xl:text-[1.5rem]">All Instruments</h3>
              <p className="mt-1 text-[0.9375rem] font-semibold text-white/85">
                Every registered instrument across the system
              </p>
            </div>

            <p className="mt-5 text-[2.5rem] font-black leading-none tracking-tight text-white tabular-nums lg:text-[3rem] xl:text-[3.5rem]">
              {all.count.toLocaleString()}
            </p>
            <p className="mt-2 text-[0.8125rem] font-bold uppercase tracking-[0.14em] text-white/80">
              Instruments
            </p>
            <ActiveSplit total={all.count} active={all.activeCount} large />

            <div className="mt-auto flex justify-end pt-4">
              <ViewDetails large />
            </div>
          </CardShell>
        )}

        {alarms && (
          <CardShell
            onClick={onOpenAlarms}
            label={`Active alarms — ${activeAlarms}. View details.`}
            background={gradient(ALARM_TONES[alarmTone].from, ALARM_TONES[alarmTone].to)}
            className="p-5 xl:p-6"
            data-tone={alarmTone}
          >
            <div className="min-w-0">
              <h3 className="text-[1.25rem] font-extrabold text-white xl:text-[1.5rem]">Active Alarms</h3>
              <p className="mt-1 text-[0.9375rem] font-semibold text-white/85">
                {/* Says what to DO, and stays honest at zero. */}
                {activeAlarms > 0 ? 'Require your attention' : 'Nothing to attend to'}
              </p>
            </div>

            {/* The CARD is green at zero and red otherwise (`data-tone`); the
                figure is white on both so it never fights its ground. */}
            <p className="mt-5 text-[2.5rem] font-black leading-none tracking-tight text-white tabular-nums lg:text-[3rem] xl:text-[3.5rem]">
              {activeAlarms.toLocaleString()}
            </p>
            <p className="mt-2 text-[0.8125rem] font-bold uppercase tracking-[0.14em] text-white/80">
              Alarms
            </p>

            <div className="mt-auto flex items-end justify-between gap-3 pt-4">
              <p className="text-[0.875rem] font-semibold text-white/85">
                {(alarms.unacknowledged ?? 0) > 0
                  ? `${alarms.unacknowledged} awaiting acknowledgement`
                  : ' '}
              </p>
              <ViewDetails large />
            </div>
          </CardShell>
        )}
      </div>
      )}

      {/* ── Blocks Overview ──────────────────────────────────────────────── */}
      {blocks.length > 0 && (
        <section>
          {sectionTitle && (
            <>
              <h2 className={`text-[1.125rem] font-extrabold xl:text-[1.25rem] ${dark ? 'text-white' : 'text-slate-900'}`}>{sectionTitle}</h2>
              {sectionSubtitle && (
                <p className={`mt-0.5 text-[0.875rem] font-medium ${dark ? 'text-white/75' : 'text-slate-600'}`}>{sectionSubtitle}</p>
              )}
            </>
          )}

          <div className={`${sectionTitle ? 'mt-4 ' : ''}grid gap-4 sm:grid-cols-2 xl:grid-cols-4 xl:gap-5`}>
            {blocks.map((b, i) => {
              const slot = i % BLOCK_ACCENTS.length;
              const accent = BLOCK_ACCENTS[slot];
              return (
                <CardShell
                  key={b.id}
                  onClick={() => onSelect(b.id)}
                  label={`${b.label} — ${b.count} instruments. View details.`}
                  background={gradient(accent.from, accent.to)}
                  className="p-5 xl:p-6"
                  data-accent={slot}
                >
                  <CardWave color={accent.wave} />

                  {/* Above the wave. The wave is decoration and must never
                      swallow a number. */}
                  <div className="relative z-10 flex flex-1 flex-col">
                    {/* One step larger and bolder (operator, 2026-09-25: "make
                        block text bold and increase font sizes", then "same for
                        all instruments and active alarms"). */}
                    <h3 className="truncate text-[1.25rem] font-extrabold text-white xl:text-[1.5rem]" title={b.label}>
                      {b.label}
                    </h3>
                    <p className="mt-1 text-[0.8125rem] font-bold uppercase tracking-[0.14em] text-white/80">
                      {b.sublabel}
                    </p>

                    <p className="mt-4 text-[2.25rem] font-black leading-none tracking-tight text-white tabular-nums lg:text-[2.5rem] xl:text-[3rem]">
                      {b.count.toLocaleString()}
                    </p>
                    <p className="mt-2 text-[0.8125rem] font-bold uppercase tracking-[0.14em] text-white/80">
                      Instruments
                    </p>
                    <ActiveSplit total={b.count} active={b.activeCount} large />

                    <div className="mt-auto flex justify-end pt-5 xl:pt-6">
                      <ViewDetails large />
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
