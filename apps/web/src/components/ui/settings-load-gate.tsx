import type { ReactNode } from 'react';
import { ErrorState } from './empty-state';

/**
 * A settings form renders ONLY once the stored settings have arrived
 * (performance audit 2026-11-17, G4-01 — CRITICAL).
 *
 * Every configuration form seeds its fields from defaults (or `{}`) and then
 * overwrites them with the stored row when the GET answers. When the GET FAILED
 * — a database that was not answering, a pool that was exhausted — the form
 * stayed on screen holding the DEFAULTS, looking exactly like real settings, and
 * Save wrote them over the real ones. Reproduced on the perf copy: one edit and
 * a Save on Telemetry Retention after a failed load turned 36 months into 12.
 * On the LDAP, User ID and Pagination pages Save did not even need an edit.
 *
 * The rule, in one place so no page re-derives it:
 * - `data !== undefined` → the form. A revalidation that fails AFTER a good
 *   load keeps the form: what it holds came from the server, and hiding it
 *   mid-edit would throw the operator's work away for a transient error.
 * - no data and an error → this error with Try again; no form, so no Save.
 * - no data, no error → loading; no form, so no Save.
 *
 * `null` is a loaded answer (a row that does not exist yet), not "not loaded".
 */
export function SettingsLoadGate({ what, data, error, onRetry, children }: {
  /** What failed to load, as the end of "Could not load …" — e.g. "the LDAP settings". */
  what: string;
  data: unknown;
  error: unknown;
  onRetry: () => void;
  children: ReactNode;
}) {
  if (data !== undefined) return <>{children}</>;
  if (error) {
    const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    return (
      <ErrorState
        title={`Could not load ${what}`}
        detail={`${message ? `${message} ` : ''}Nothing has been changed. The form opens once the stored settings load, so a save can never replace them with defaults.`}
        onRetry={onRetry}
      />
    );
  }
  return (
    <div role="status" aria-live="polite" className="rounded-[var(--radius-card)] border border-slate-200 bg-white px-6 py-8 text-center text-[0.875rem] text-slate-500">
      Loading {what}…
    </div>
  );
}
