import { ALARM_QUADRANTS, QUADRANT_TONE, type AlarmQuadrant, type QuadrantTone } from './alarm-display';

/**
 * The four state counts, which are also the page's primary filter.
 *
 * They are buttons rather than read-outs because the number and the list under it
 * answer the same question — clicking "8 Cleared Unacknowledged" should show those
 * eight. Choosing a card again clears the choice, so the page can always get back
 * to showing everything.
 *
 * The counts come from the SERVER, computed over every alarm matching the other
 * filters — not from the rows in hand. Counting the fetched page would make each
 * card describe one page of alarms while claiming to describe the plant.
 *
 * There is deliberately no trend line or "from yesterday" figure here, though the
 * design they came from had both: nothing in this system stores alarm-state
 * history, so either would have to be inferred from the rows on screen, and an
 * invented trend on a monitoring screen is worse than no trend.
 */

interface Palette {
  card: string;
  icon: string;
  label: string;
  value: string;
  ring: string;
}

const PALETTE: Record<QuadrantTone, Palette> = {
  danger: {
    card: 'border-rose-200/80 bg-gradient-to-br from-rose-50 via-rose-50/70 to-white',
    icon: 'bg-gradient-to-br from-rose-500 to-red-600',
    label: 'text-rose-600',
    value: 'text-rose-700',
    ring: 'ring-rose-400',
  },
  info: {
    card: 'border-sky-200/80 bg-gradient-to-br from-sky-50 via-sky-50/70 to-white',
    icon: 'bg-gradient-to-br from-sky-500 to-blue-600',
    label: 'text-sky-700',
    value: 'text-sky-700',
    ring: 'ring-sky-400',
  },
  warn: {
    card: 'border-amber-200/80 bg-gradient-to-br from-amber-50 via-amber-50/70 to-white',
    icon: 'bg-gradient-to-br from-amber-500 to-orange-600',
    label: 'text-amber-700',
    value: 'text-amber-700',
    ring: 'ring-amber-400',
  },
  ok: {
    card: 'border-emerald-200/80 bg-gradient-to-br from-emerald-50 via-emerald-50/70 to-white',
    icon: 'bg-gradient-to-br from-emerald-500 to-green-600',
    label: 'text-emerald-700',
    value: 'text-emerald-700',
    ring: 'ring-emerald-400',
  },
};

/** Each state's glyph, so the card is not colour alone. */
const ICON: Record<AlarmQuadrant, string> = {
  // A ringing bell: nobody has answered this yet.
  'active-unack': 'M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0',
  // A shield with a tick: still breaching, but signed for and being worked.
  'active-ack': 'M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751A11.959 11.959 0 0112 2.714z',
  // A clipboard: the condition ended, the paperwork did not.
  'cleared-unack': 'M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z',
  // A closed circle: over, and answered for.
  'cleared-ack': 'M9 12.75L11.25 15 15 9.75M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
};

export function AlarmStatCards({
  counts, selected, onSelect,
}: {
  counts: Record<AlarmQuadrant, number>;
  selected: AlarmQuadrant | null;
  onSelect: (q: AlarmQuadrant | null) => void;
}) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
      {ALARM_QUADRANTS.map((q) => {
        const p = PALETTE[QUADRANT_TONE[q.id]];
        const isSelected = selected === q.id;
        return (
          <button
            key={q.id}
            type="button"
            aria-pressed={isSelected}
            title={isSelected ? 'Showing only these — click to show all alarms' : `Show only ${q.label.toLowerCase()} alarms`}
            onClick={() => onSelect(isSelected ? null : q.id)}
            className={`group flex items-center gap-4 rounded-2xl border px-5 py-4 text-left shadow-[var(--elev-1)] transition-all hover:shadow-[var(--elev-2)] ${p.card} ${
              isSelected ? `ring-2 ring-offset-1 ${p.ring}` : ''
            }`}
          >
            <span className={`flex h-12 w-12 shrink-0 items-center justify-center rounded-full text-white shadow-[var(--elev-1)] ${p.icon}`} aria-hidden>
              <svg className="h-6 w-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={ICON[q.id]} />
              </svg>
            </span>
            <span className="min-w-0">
              <span className={`block text-[0.7rem] font-bold uppercase leading-tight tracking-wider ${p.label}`}>
                {q.label}
              </span>
              <span className={`mt-0.5 block text-3xl font-bold leading-none tabular-nums ${p.value}`}>
                {counts[q.id]}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
