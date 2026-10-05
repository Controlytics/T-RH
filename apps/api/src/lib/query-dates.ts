/**
 * One reader for the `startDate` / `endDate` query parameters a list route
 * accepts (audit 2026-10-03, API-12).
 *
 * Until then `new Date(query.startDate)` went straight into a Prisma `where`:
 * `?startDate=yesterday` became `Invalid Date`, Prisma threw a validation
 * error with no `code`, the global handler answered 500 and fired a
 * SYSTEM_ERROR notification to every admin — for a typo in a filter box. The
 * alarms list already answered 400 by field for the same input; this is that
 * rule, shared, so the audit and notification lists cannot drift from it.
 *
 * A DATE-ONLY `endDate` (`YYYY-MM-DD`) means the END of that day. The browser
 * sends full ISO instants, but an API caller writing `endDate=2026-10-05`
 * means "through the 5th", and `new Date('2026-10-05')` is MIDNIGHT at the
 * start of it — so `lte` would exclude the whole day asked for. The day is
 * taken in UTC, the same zone `new Date('YYYY-MM-DD')` uses for the start
 * bound, so a `startDate=2026-10-05&endDate=2026-10-05` pair spans exactly
 * one calendar day rather than one instant.
 */
export type DateBound = 'start' | 'end';

export type DateBoundResult =
  | { ok: true; date: Date }
  | { ok: false; message: string };

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function parseDateBound(value: string, bound: DateBound): DateBoundResult {
  const raw = value.trim();
  if (!raw) return { ok: false, message: 'must be a date' };
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    return { ok: false, message: `"${value}" is not a date (ISO 8601 expected)` };
  }
  if (bound === 'end' && DATE_ONLY.test(raw)) {
    date.setUTCHours(23, 59, 59, 999);
  }
  return { ok: true, date };
}

/**
 * Resolve both bounds at once, answering the field-keyed error map a 400
 * response carries. A reversed range is refused too — the alarms list's rule;
 * a silent empty page for `from > to` reads as "no records", which is false.
 */
export function parseDateRange(
  startDate: string | undefined,
  endDate: string | undefined,
): { ok: true; gte?: Date; lte?: Date } | { ok: false; fieldErrors: Record<string, string[]> } {
  const fieldErrors: Record<string, string[]> = {};
  let gte: Date | undefined;
  let lte: Date | undefined;
  if (startDate !== undefined) {
    const r = parseDateBound(startDate, 'start');
    if (r.ok) gte = r.date; else fieldErrors.startDate = [r.message];
  }
  if (endDate !== undefined) {
    const r = parseDateBound(endDate, 'end');
    if (r.ok) lte = r.date; else fieldErrors.endDate = [r.message];
  }
  if (gte && lte && gte > lte) {
    fieldErrors.endDate = [...(fieldErrors.endDate ?? []), 'endDate is before startDate'];
  }
  if (Object.keys(fieldErrors).length > 0) return { ok: false, fieldErrors };
  return { ok: true, gte, lte };
}
