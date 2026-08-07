import { SIGNAL_STYLES, type Signal } from './signal';

/**
 * The signature element of the instruments pages: a three-bar mast that reads
 * as signal strength, because that is exactly what it is.
 *
 * It exists instead of another coloured pill because the list is scanned, not
 * read — bar height is legible in peripheral vision at a glance down a column,
 * where a fourth pill of a different colour is not. Colour and height carry the
 * same fact twice, deliberately: the colours alone would fail anyone who cannot
 * separate red from green.
 *
 * `title` carries the sentence, so the whole thing stays hoverable without
 * spending a row on prose.
 */
export function SignalMast({ signal, className = '' }: { signal: Signal; className?: string }) {
  const s = SIGNAL_STYLES[signal.state];
  const heights = ['h-1.5', 'h-2.5', 'h-3.5'];
  return (
    <span
      className={`inline-flex items-end gap-0.5 ${className}`}
      title={signal.label}
      role="img"
      aria-label={signal.label}
    >
      {heights.map((h, i) => (
        <span
          key={h}
          className={`w-1 rounded-sm ${h} ${i < signal.bars ? s.bar : s.barDim}`}
        />
      ))}
    </span>
  );
}

/** The mast plus its age, the pairing used in every table row. */
export function SignalCell({ signal }: { signal: Signal }) {
  const s = SIGNAL_STYLES[signal.state];
  // 'never' has no age to show — its state IS its age. Stacking "Never" over
  // "Never" was the first thing that read as a rendering fault.
  const never = signal.state === 'never';
  return (
    <span className="inline-flex items-center gap-2" title={signal.label}>
      <SignalMast signal={signal} />
      <span className="flex flex-col leading-tight">
        <span className={`text-xs font-semibold ${never ? 'text-slate-400' : 'text-slate-700'}`}>
          {never ? 'Never seen' : s.label}
        </span>
        {!never && <span className="text-[11px] text-slate-400">{signal.age}</span>}
      </span>
    </span>
  );
}

/** The same state as a standalone chip, for the detail page's hero. */
export function SignalChip({ signal }: { signal: Signal }) {
  const s = SIGNAL_STYLES[signal.state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${s.chip}`}
      title={signal.label}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${s.dot}`} />
      {signal.state === 'never' ? 'Never seen' : s.label}
      {signal.state !== 'never' && <span className="font-normal opacity-70">· {signal.age}</span>}
    </span>
  );
}
