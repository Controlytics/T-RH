import { useEffect, useState, type ReactNode } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { InstrumentStatus } from '@digilog/shared';
import { statusClasses } from '@/routes/dashboard/status';
import { ExportMenu } from '@/components/ExportMenu';

/**
 * One quantity's trend chart, as a card — the trend page's two big charts.
 *
 * Rebuilt 2026-08-31 to an operator reference image (`trends.png` at the repo
 * root): a pastel ringed quantity icon, the title, a status pill, a
 * "<location> • <code>" subtitle, and two square icon buttons at the right for
 * DOWNLOAD and FULLSCREEN.
 *
 * Three rules survive the restyle and are the ones to read before touching it:
 *
 * - **The status pill is NOT "Live".** The reference hardcodes a green "Live"
 *   pill on both cards. Most instruments on this installation are not
 *   reporting, and a green "Live" over a silent probe is a false claim about a
 *   §11 record. The pill prints `statusClasses(status).label` — the app's own
 *   vocabulary, where STALE reads "Offline" — from the SERVER-resolved
 *   `overview.status`, the same value `TrendHeader` and both band gauges are
 *   already fed. One instrument, one status word, four places printing it.
 *
 * - **The subtitle is deduped, not concatenated.** Every `floorplan_rooms.code`
 *   on this installation is its own instrument's code with `label` blank, so a
 *   literal `<room> • <code>` renders `X • X`. `chartCardSubtitle` drops any
 *   part that repeats the code — the same defect the Alarms page's Location
 *   column was fixed for on 2026-08-31.
 *
 * - **Fullscreen belongs to the CARD, not the chart.** `TimeSeriesChart` still
 *   owns its own fullscreen in the `plain` variant (the dashboard's room view);
 *   in `trend` it is suppressed there and lives here, because the reference puts
 *   the control in this header and what should fill the screen is the whole card
 *   — chart, sampling note and summary strip together, not a bare plot.
 */

/**
 * "Dissolution & UV Room • CWH/RDU/006-00".
 *
 * Pure and exported because the deduplication is the only interesting thing it
 * does, and it cannot be checked by looking at a rendered page on an
 * installation where the duplicate case is the normal one.
 *
 * Blank/whitespace parts are dropped, anything equal to the code is dropped
 * (case-insensitively — a room code and an instrument code differing only in
 * case is still the same string repeated), duplicates among the parts are
 * dropped, and the code always comes LAST so the identifier terminates the
 * line. An instrument with no recorded placement gets the code alone, never a
 * leading separator.
 */
export function chartCardSubtitle(parts: (string | null | undefined)[], code: string): string {
  const seen = new Set<string>([code.trim().toLowerCase()]);
  const kept: string[] = [];
  for (const part of parts) {
    if (typeof part !== 'string') continue;
    const text = part.trim();
    if (text === '') continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
  }
  return [...kept, code.trim()].filter((p) => p !== '').join(' • ');
}

export interface TrendChartCardProps {
  /** "Temperature Trend" / "Humidity Trend". */
  title: string;
  /** The quantity's glyph, drawn inside the pastel disc. */
  icon: ReactNode;
  /** Series identity — the palette slot this quantity owns app-wide. */
  accent: string;
  /**
   * The INSTRUMENT's server-resolved status, taken as given. This page never
   * re-judges it; `null` while the overview has not loaded, which prints no
   * pill at all rather than guessing one.
   */
  status: InstrumentStatus | null;
  /** Where the instrument is — room label, functional location, free-text
   *  placement; whatever the page has. Deduped against `code`. */
  locationParts: (string | null | undefined)[];
  code: string;
  /** Fires the per-chart §11 report download. */
  onExportPdf: () => void;
  children: ReactNode;
}

export function TrendChartCard({
  title, icon, accent, status, locationParts, code, onExportPdf, children,
}: TrendChartCardProps) {
  const [fullscreen, setFullscreen] = useState(false);
  const sc = status ? statusClasses(status) : null;
  const subtitle = chartCardSubtitle(locationParts, code);

  // Escape leaves fullscreen — the same rule `TimeSeriesChart` follows for its
  // own. A fixed full-viewport overlay with no keyboard way out is a trap for
  // anyone not using a mouse.
  useEffect(() => {
    if (!fullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setFullscreen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [fullscreen]);

  const iconBtn =
    'inline-flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 bg-white text-slate-500 transition-colors hover:bg-slate-50 hover:text-slate-700';

  return (
    <section
      className={
        fullscreen
          ? 'fixed inset-0 z-50 flex flex-col overflow-auto bg-white p-5'
          : 'overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]'
      }
    >
      <header className="flex flex-wrap items-start justify-between gap-3 px-5 py-4">
        <div className="flex min-w-0 items-center gap-3.5">
          {/* The pastel disc. A tint of the quantity's own series colour, so the
              icon, the line below it and the gauge above all read as one
              quantity — the reference's discs are both the same lilac. */}
          <span
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full"
            style={{ backgroundColor: `color-mix(in srgb, ${accent} 14%, #ffffff)`, color: accent }}
            aria-hidden="true"
          >
            {icon}
          </span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2.5">
              <h3 className="truncate text-lg font-bold tracking-tight text-slate-900">{title}</h3>
              {/* Status colour never travels alone — the word rides with it.
                  Nothing is printed while the status is unknown: an absent pill
                  says "not loaded", a grey one would say "nothing to judge". */}
              {sc && (
                <span
                  data-testid="trend-chart-status"
                  className={`inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-semibold ${sc.bg} ${sc.text} ${sc.border}`}
                >
                  <span className={`h-1.5 w-1.5 rounded-full ${sc.dot}`} aria-hidden="true" />
                  {sc.label}
                </span>
              )}
            </div>
            <p data-testid="trend-chart-subtitle" className="mt-0.5 truncate text-[0.8125rem] text-slate-500">
              {subtitle}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* The per-chart download. It keeps its own `reportType` — three
              downloads on this page all logged as "Instrument Trend" would leave
              a §11 audit trail that cannot say which report a row was. */}
          <ExportMenu surface="instrument-trend" iconOnly onExportPdf={onExportPdf} />
          <button
            type="button"
            className={iconBtn}
            onClick={() => setFullscreen((v) => !v)}
            aria-pressed={fullscreen}
            aria-label={fullscreen ? `Exit fullscreen — ${title}` : `Fullscreen — ${title}`}
            title={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
          >
            {fullscreen
              ? <Minimize2 className="h-4 w-4" aria-hidden="true" />
              : <Maximize2 className="h-4 w-4" aria-hidden="true" />}
          </button>
        </div>
      </header>

      <div className="px-4 pb-4">{children}</div>
    </section>
  );
}
