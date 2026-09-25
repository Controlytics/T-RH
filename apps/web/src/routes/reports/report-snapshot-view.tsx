import type { ReactNode } from 'react';
import type { ReportSnapshot, SnapshotSection, TableCell as SnapshotCell } from '@/lib/pdf-report';

/**
 * The approved report's DATA, on screen, as tables (operator, 2026-09-25:
 * "once approved then if user click on that row, that report data should be
 * shown in below that row in table format").
 *
 * It renders the SAME frozen snapshot the approver signed and the download
 * replays — `ReportSnapshot` v2, section by section — so what opens under
 * the row is what is in the signed PDF, never a re-query that could pick up
 * late telemetry or a renamed alarm type. A `table` section is a bordered
 * grid (`.tbl-grid`, the readings table's structure); a `pairs` section is a
 * two-column grid of label / value; a `title` is a heading; a `note` a line
 * in its colour; a chart `image` is shown as drawn; a `page-break` is a rule.
 * Pure: no fetch, no state, so it is tested by rendering a snapshot.
 */
const NOTE_INK: Record<string, string> = {
  red: 'text-rose-700',
  amber: 'text-amber-700',
  green: 'text-emerald-700',
  grey: 'text-slate-600',
  gray: 'text-slate-600',
  blue: 'text-sky-700',
};

function cellText(c: SnapshotCell): string {
  return typeof c === 'string' ? c : c.content;
}
function cellSpan(c: SnapshotCell): number | undefined {
  return typeof c === 'string' ? undefined : c.colSpan;
}

function Section({ s, index }: { s: SnapshotSection; index: number }): ReactNode {
  switch (s.kind) {
    case 'title':
      return <h4 className="mt-4 text-[0.9375rem] font-bold text-slate-900 first:mt-0">{s.text}</h4>;
    case 'note':
      return <p className={`mt-2 text-sm font-medium ${NOTE_INK[s.color as string] ?? 'text-slate-600'}`}>{s.text}</p>;
    case 'page-break':
      return <hr className="my-4 border-slate-200" />;
    case 'image':
      return (
        <img
          src={s.dataUrl}
          alt=""
          className="mt-3 max-w-full rounded-md border border-slate-200"
          style={{ width: `${Math.min(s.widthMm * 3.5, 900)}px` }}
        />
      );
    case 'pairs':
      return (
        <div className="mt-3">
          {s.title && <h4 className="mb-2 text-[0.9375rem] font-bold text-slate-900">{s.title}</h4>}
          <table className="tbl-grid w-max min-w-[20rem] border-collapse text-[0.9375rem]" data-section={index} data-kind="pairs">
            <tbody>
              {s.pairs.map(([k, v], i) => (
                <tr key={`${k}-${i}`}>
                  <th scope="row" className="px-3 py-1.5 text-left font-bold text-slate-700">{k}</th>
                  <td className="px-3 py-1.5 font-semibold text-slate-900">{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case 'table':
      return (
        <div className="mt-3 overflow-x-auto">
          {s.title && <h4 className="mb-2 text-[0.9375rem] font-bold text-slate-900">{s.title}</h4>}
          <table className="tbl-grid w-full border-collapse text-[0.9375rem]" data-section={index} data-kind="table">
            {s.head.length > 0 && (
              <thead className="text-left text-[0.75rem] font-bold uppercase tracking-wider text-white" style={{ background: 'var(--band-gradient)' }}>
                <tr>
                  {s.head.map((h, i) => <th key={i} className="px-3 py-2">{h}</th>)}
                </tr>
              </thead>
            )}
            <tbody>
              {s.body.map((row, ri) => (
                <tr key={ri}>
                  {row.map((c, ci) => (
                    <td
                      key={ci}
                      colSpan={cellSpan(c)}
                      className={`px-3 py-1.5 tabular-nums text-slate-800 ${s.bold?.[ri]?.[ci] ? 'font-extrabold text-slate-900' : 'font-medium'}`}
                    >
                      {cellText(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    default:
      return null;
  }
}

export function ReportSnapshotView({ snapshot }: { snapshot: ReportSnapshot }) {
  return (
    <div data-testid="report-snapshot" className="space-y-1">
      <p className="text-[0.9375rem] font-extrabold text-slate-900">{snapshot.title}</p>
      {snapshot.subtitle && <p className="text-sm font-medium text-slate-600">{snapshot.subtitle}</p>}
      {snapshot.sections.map((s, i) => <Section key={i} s={s} index={i} />)}
    </div>
  );
}
