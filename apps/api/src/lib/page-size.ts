/**
 * How many records a caller gets — the ONE definition, and it has NO CEILING.
 *
 * Operator, 2026-09-02: *"dont put any limits in any widgets or any cards or any
 * tables show this much of records, what ever records are there all records
 * should show in everywhere"* — clarified as the BACKEND limits, not the pager.
 *
 * ## Why a silent ceiling was the wrong shape
 *
 * Every site this replaced was a `Math.min(requested, N)`. A client asking for
 * 5,000 rows got 500 and **was told nothing** — same length of array, no flag, no
 * header, no error. There is no way for a caller to tell "there were exactly 500"
 * from "there were 40,000 and you were given the newest 500".
 *
 * This repo has been bitten by precisely that twice, and both are recorded:
 * the trend chart's `ORDER BY ts DESC` cap, which plotted the last DAY of a 7-day
 * range while the axis claimed a week; and the Alarms page's client-side counts
 * over `?limit=500`, whose four state boxes described the newest 500 alarms while
 * reading as plant-wide totals. **A `limit` and a range meeting in one query is
 * the shape to distrust**, and a ceiling that truncates in silence is the engine
 * of it. On a §11 system the failure is not slowness, it is a record that quietly
 * describes less than it claims to.
 *
 * ## What replaces it
 *
 * The caller's number is honoured. `total` is still returned beside the rows
 * everywhere this is used, so a client can always tell whether it holds the whole
 * set — that, not a cap, is what makes truncation detectable.
 *
 * ## The cost, stated rather than defended
 *
 * A caller may now ask for an entire table in one response. On this installation
 * that is 154 alarms, 4,632 audit rows, 101 instruments — nothing. The one table
 * where it is a real cost is `instrument_telemetry_history` at 226,600 rows
 * (~2,300 per instrument today, but growing at 1,000–5,000 per instrument per day
 * once ingest resumes). Asking for all of it in one request will be slow and will
 * hold the whole result in memory, on the server and in the browser both. That is
 * now the caller's decision to make, which is the point — the previous design made
 * it silently, and made it wrong.
 *
 * These are authenticated, permission-gated endpoints on a single-site install, so
 * the DoS reasoning the audit route carried ("any AUDIT_READ caller can pull the
 * entire table") describes a caller who is already trusted to read every row of it
 * one page at a time.
 *
 * @param requested what the caller asked for — anything unparseable falls to `def`
 * @param def       the page size when the caller asks for none. UNCHANGED at every
 *                  call site: removing a ceiling must not also move a default, or
 *                  every existing client silently changes behaviour.
 */
export function resolvePageSize(requested: unknown, def: number): number {
  const n = typeof requested === 'number' ? requested : Number(requested);
  if (!Number.isFinite(n)) return def;
  const floored = Math.floor(n);
  // The lower bound STAYS. It is not a cap — a take of 0 or -1 is a malformed
  // request, and Prisma/Postgres treat a negative LIMIT as an error rather than as
  // "everything", so letting one through turns a typo into a 500.
  return floored < 1 ? def : floored;
}
