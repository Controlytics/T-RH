/**
 * The ONE failure line for a page whose fetch failed (audit 2026-10-03, WEB-6).
 *
 * The same box the dashboard readings table has always rendered: "Could not
 * load instrument readings. <message>". Until this existed, eight route files
 * destructured no `error` from `useSWR`, so a 500 or a visibility-scope 403
 * rendered their EMPTY state — "No instruments registered yet" — a sentence
 * asserting that nothing exists, to someone who merely could not read it.
 *
 * `what` is the plural noun the page shows ("instruments", "audit templates");
 * the message is the server's, when it sent one.
 */
export function LoadError({ what, error, className = '' }: {
  what: string;
  error: unknown;
  className?: string;
}) {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return (
    <div role="alert" className={`rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-700 ${className}`}>
      Could not load {what}. {message}
    </div>
  );
}
