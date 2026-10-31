/**
 * A REFUSAL is the server's answer to this request — a 4xx: a window over the
 * bucket cap (400), no permission (403), gone (404) — and asking again returns
 * the same answer. 408 (timeout) and 429 (busy) are not refusals. Anything else
 * (a 5xx, a network error, a proxy's HTML page during a restart) is a FAILURE
 * worth retrying.
 *
 * The ONE rule, read by the widget data hooks' retry policy (a refusal is never
 * retried and never reported), by the held-answer rule (`answerState`: a
 * refusal never keeps what it holds) — fix round 1, I-1 / I-3 — and by the
 * floor plan's fixed-plan decision (`fixedPlanState`: a refused plan list is a
 * plan the viewer cannot see). It lives here, not beside the widgets, because
 * the dashboard's own floor view reads it too.
 */
export function isRefusal(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' && status >= 400 && status < 500 && status !== 408 && status !== 429;
}
