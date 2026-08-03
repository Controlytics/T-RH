import { SEVERITY_LABELS, type AlarmSeverity } from './alarm-shared';

/*
 * Severity is encoded by icon AND text, with colour only reinforcing them.
 * A colour-only pill is unreadable to a red/green-colour-blind operator and
 * carries no information at all on a monochrome printout of the queue.
 *
 * Lives outside alarms.tsx so the instrument detail page can render it without
 * pulling the whole lazy-loaded alarm queue route into its chunk.
 */
const SEVERITY_STYLE: Record<AlarmSeverity, { pill: string; icon: string }> = {
  CRITICAL: {
    pill: 'bg-red-50 text-red-800 border-red-300',
    // Warning triangle
    icon: 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z',
  },
  MAJOR: {
    pill: 'bg-orange-50 text-orange-800 border-orange-300',
    // Exclamation in a circle
    icon: 'M12 9v3.75m9-1.5a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z',
  },
  MINOR: {
    pill: 'bg-amber-50 text-amber-800 border-amber-300',
    // Bell
    icon: 'M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0',
  },
  INFO: {
    pill: 'bg-slate-100 text-slate-700 border-slate-300',
    // Information circle
    icon: 'M11.25 11.25l.041-.02a.75.75 0 011.063.852l-.708 2.836a.75.75 0 001.063.853l.041-.021M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-3.75h.008v.008H12V8.25z',
  },
};

export function SeverityPill({ severity }: { severity: AlarmSeverity }) {
  const style = SEVERITY_STYLE[severity];
  return (
    <span className={`inline-flex items-center gap-1 rounded border px-2 py-0.5 text-xs font-medium ${style.pill}`}>
      <svg className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d={style.icon} />
      </svg>
      {SEVERITY_LABELS[severity]}
    </span>
  );
}
