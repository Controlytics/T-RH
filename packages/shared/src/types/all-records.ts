/**
 * "Give me every row" — the one value a caller sends when a screen must not be
 * capped.
 *
 * Operator, 2026-09-02: *"dont put any limits in any widgets or any cards or any
 * tables show this much of records, what ever records are there all records
 * should show in everywhere"*.
 *
 * ## Why a number and not an omitted parameter
 *
 * `/api/users` and `/api/instruments` DEFAULT to 20 when `limit` is absent, so
 * dropping the parameter makes a picker show fewer rows, not more. The list
 * routes have no "all" sentinel and adding one would mean a new branch in every
 * handler that reads a page size.
 *
 * ## Why a constant and not 500 sprinkled around
 *
 * 500 was sprinkled around, at ten call sites, and it was already wrong. The
 * comment that stood above `usersListQuerySchema.limit` said so in as many words:
 * the recipient pickers "need the WHOLE user list in one request and silently
 * truncating it drops selectable recipients — a real install of this codebase runs
 * 156 users, so 100 was not enough". 500 was the same bet with a bigger number,
 * and the next install that outgrows it fails the same silent way — a name simply
 * missing from a dropdown, with nothing on screen to say the list was cut.
 *
 * One constant means the next person changes one line, and `grep ALL_RECORDS`
 * lists every screen that depends on the property.
 *
 * ## Why this specific value
 *
 * Larger than any table this product can plausibly hold on one site (the biggest
 * here is 226,600 telemetry readings, and no picker reads telemetry), small enough
 * that a typo cannot ask Postgres for a number it must reject. It is a
 * SATURATION value, not a limit: the server has no ceiling since 2026-09-02
 * (`apps/api/src/lib/page-size.ts`), so this only has to exceed the data.
 *
 * **Do not use it for a paged TABLE.** Those page properly and show a total; this
 * is for pickers, dropdowns and any list that must be complete to be correct.
 */
export const ALL_RECORDS = 1_000_000;

/** `?limit=1000000` — appended by callers that build a query string by hand. */
export const ALL_RECORDS_PARAM = `limit=${ALL_RECORDS}`;
