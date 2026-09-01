/**
 * The alarm list's filter algebra, kept pure so it can be tested without a database.
 *
 * `GET /api/alarms` grew a search box, a date range, a type and a status filter,
 * sorting and server-side paging. All of that is only safe if two properties hold,
 * and both are easier to state here than to spot inside the route:
 *
 *  1. **Every fragment is ANDed, never merged.** Search and a location filter both
 *     want an `instrument` key; the status filter and a date range both narrow the
 *     same rows. Merged into one object, a later key silently REPLACES an earlier
 *     one and widens the result — which, since visibility scoping is applied the
 *     same way, is the shape of an access-control bug, not just a wrong list.
 *  2. **A bad filter is a 400, not a shrug.** Dropping an unparseable date would
 *     return alarms from outside the range the operator asked for, under a header
 *     that says the range was applied.
 *
 * The status filter is deliberately EXCLUDED from the default `where`: the four
 * count boxes above the table have to count the set filtered by everything except
 * the box selection itself, or choosing a box would zero the other three.
 */

/** The type vocabulary, derived from the enum pairs that actually define a type. */
export const ALARM_TYPE_TOKENS = ['TEMP_HIGH', 'TEMP_LOW', 'RH_HIGH', 'RH_LOW', 'OFFLINE', 'RS485', 'RANGE'] as const;
export type AlarmTypeToken = (typeof ALARM_TYPE_TOKENS)[number];

/**
 * The four states, on the same two independent axes the UI has always used:
 * condition (still breaching / ended) and signature (signed / not).
 */
export const ALARM_STATUS_TOKENS = ['active-unack', 'active-ack', 'cleared-unack', 'cleared-ack'] as const;
export type AlarmStatusToken = (typeof ALARM_STATUS_TOKENS)[number];

export const ALARM_SORT_KEYS = ['raisedAt', 'clearedAt', 'instrumentCode', 'type', 'status'] as const;
export type AlarmSortKey = (typeof ALARM_SORT_KEYS)[number];

export type SortDir = 'asc' | 'desc';

/**
 * Page size ceiling. A caller asking for more gets this, never an unbounded scan.
 *
 * 500 rather than something smaller because the legacy `limit` parameter — still
 * used by the dashboard's selection panel and the instrument trend page's alarms
 * widget — is an alias for `pageSize`, and those callers ask for 500. Lowering the
 * ceiling would silently truncate them.
 */
export const ALARM_PAGE_SIZE_MAX = 500;
export const ALARM_PAGE_SIZE_DEFAULT = 25;

export interface AlarmListQuery {
  search?: string;
  from?: Date;
  to?: Date;
  type?: AlarmTypeToken;
  status?: AlarmStatusToken;
  instrumentId?: string;
  /** Legacy, still used by the dashboard panel: filters the CONDITION axis alone. */
  state?: 'ACTIVE' | 'CLEARED';
  /** Legacy: filters the SIGNATURE axis alone. */
  acknowledged?: boolean;
  page: number;
  pageSize: number;
  sort: AlarmSortKey;
  dir: SortDir;
  /** Non-null when a filter is unusable; the route turns it into a 400. */
  error: { field: string; message: string } | null;
}

function parseDate(raw: unknown, field: string): { value?: Date; error?: { field: string; message: string } } {
  if (raw === undefined || raw === null || raw === '') return {};
  const d = new Date(String(raw));
  if (Number.isNaN(d.getTime())) {
    return { error: { field, message: `"${String(raw)}" is not a date this can read. Send an ISO timestamp.` } };
  }
  return { value: d };
}

export function parseAlarmListQuery(raw: Record<string, unknown>): AlarmListQuery {
  const int = (v: unknown, fallback: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : fallback;
  };

  const search = typeof raw.search === 'string' && raw.search.trim() ? raw.search.trim() : undefined;
  const from = parseDate(raw.from, 'from');
  const to = parseDate(raw.to, 'to');

  let error: AlarmListQuery['error'] = from.error ?? to.error ?? null;

  if (!error && from.value && to.value && to.value < from.value) {
    error = { field: 'to', message: 'The end of the range is before its start.' };
  }
  if (!error && raw.type !== undefined && raw.type !== '' && !ALARM_TYPE_TOKENS.includes(raw.type as AlarmTypeToken)) {
    error = { field: 'type', message: `Unknown alarm type. Expected one of: ${ALARM_TYPE_TOKENS.join(', ')}.` };
  }
  if (!error && raw.status !== undefined && raw.status !== '' && !ALARM_STATUS_TOKENS.includes(raw.status as AlarmStatusToken)) {
    error = { field: 'status', message: `Unknown status. Expected one of: ${ALARM_STATUS_TOKENS.join(', ')}.` };
  }
  // `severity` is deliberately NOT validated and NOT read. Severity stopped being
  // an administered concept on 2026-09-01 and the filter went with it, but a stale
  // bookmark or a browser still running the previous bundle can send `?severity=`.
  // ACCEPTED AND IGNORED rather than rejected: a 400 would blank the Alarms page
  // for someone mid-session over a parameter that no longer selects anything, and
  // the rule that a bad filter must be a 400 exists so a filter cannot silently
  // fail to apply — it does not apply to a filter that no longer exists.

  // An unknown SORT key falls back rather than erroring: it changes the ORDER of
  // the rows, not which rows they are, so a stale bookmark should still list alarms.
  const sort = ALARM_SORT_KEYS.includes(raw.sort as AlarmSortKey) ? (raw.sort as AlarmSortKey) : 'raisedAt';
  const dir: SortDir = raw.dir === 'asc' ? 'asc' : 'desc';

  // `limit` is the parameter this endpoint shipped with. It means the same thing
  // as `pageSize`, so it is an alias rather than a second concept; `pageSize` wins
  // when both are sent.
  const sizeRaw = raw.pageSize !== undefined ? raw.pageSize : raw.limit;

  return {
    search,
    from: from.value,
    to: to.value,
    type: raw.type ? (raw.type as AlarmTypeToken) : undefined,
    status: raw.status ? (raw.status as AlarmStatusToken) : undefined,
    instrumentId: typeof raw.instrumentId === 'string' && raw.instrumentId ? raw.instrumentId : undefined,
    state: raw.state === 'ACTIVE' || raw.state === 'CLEARED' ? raw.state : undefined,
    acknowledged: raw.acknowledged === 'true' ? true : raw.acknowledged === 'false' ? false : undefined,
    page: Math.max(1, int(raw.page, 1)),
    pageSize: Math.min(ALARM_PAGE_SIZE_MAX, Math.max(1, int(sizeRaw, ALARM_PAGE_SIZE_DEFAULT))),
    sort,
    dir,
    error,
  };
}

/** The two enum columns that define each type token. */
const TYPE_WHERE: Record<AlarmTypeToken, Record<string, unknown>> = {
  TEMP_HIGH: { metric: 'TEMPERATURE', limitKind: 'HIGH' },
  TEMP_LOW: { metric: 'TEMPERATURE', limitKind: 'LOW' },
  RH_HIGH: { metric: 'HUMIDITY', limitKind: 'HIGH' },
  RH_LOW: { metric: 'HUMIDITY', limitKind: 'LOW' },
  OFFLINE: { metric: 'OFFLINE' },
  // ONE token for both metrics, matching on `source`. An RS485 alarm's metric is
  // TEMPERATURE or HUMIDITY — the same values a limit alarm uses — so metric
  // alone cannot identify one, and splitting it into RS485_TEMP / RS485_RH would
  // make an operator asking "what sensors have failed?" choose between two
  // spellings of one question. The Type COLUMN still names the metric per row.
  RS485: { source: 'RS485_FAILURE' },
  // Also keyed on source, and for the same reason: a range failure carries
  // metric TEMPERATURE or HUMIDITY, exactly as a limit breach does. Its own
  // token rather than sharing the RS485 one — 'the probe is saturated' and
  // 'the probe is sending nonsense' send an engineer to check different things.
  RANGE: { source: 'SENSOR_RANGE' },
};

/**
 * One quadrant as a where fragment. The two axes stay separate on purpose: a
 * CLEARED-but-UNACKNOWLEDGED alarm is the overnight excursion nobody answered
 * for, and collapsing the axes would lose it.
 */
export function quadrantWhere(q: AlarmStatusToken): { state: string; acknowledgedAt: null | { not: null } } {
  const state = q.startsWith('active') ? 'ACTIVE' : 'CLEARED';
  const acknowledgedAt = q.endsWith('unack') ? null : { not: null as null };
  return { state, acknowledgedAt };
}

export interface WhereOptions {
  /**
   * Functional locations already expanded through `resolveLocationIds()` — a Block
   * covering its Areas. An EMPTY array is meaningful and is passed through as
   * `{ in: [] }`, which matches nothing: that is the honest answer for a location
   * the caller cannot see. `undefined` means no location filter was asked for.
   */
  locationIds?: string[];
  /** Include the status filter. Off for the count query; on for the row query. */
  includeStatus?: boolean;
}

export function buildAlarmWhere(q: AlarmListQuery, opts: WhereOptions = {}): { AND: Record<string, unknown>[] } {
  const AND: Record<string, unknown>[] = [];

  if (q.search) {
    // Instrument identity and where it sits. NOT the Type column: that is an enum
    // pair rendered into words at display time, so there is no text to match — it
    // has its own dropdown, and the placeholder says what this box actually reads.
    //
    // The room CODE stays searchable even though the Location column no longer
    // displays a room (2026-08-31): matching more than is shown costs a caller
    // nothing and can only return rows they could already see, whereas dropping
    // it would silently stop a plan code someone typed from finding anything.
    const contains = { contains: q.search, mode: 'insensitive' as const };
    AND.push({
      instrument: {
        OR: [
          { code: contains },
          { name: contains },
          { functionalLocation: { name: contains } },
          { room: { code: contains } },
        ],
      },
    });
  }

  if (opts.locationIds !== undefined) {
    AND.push({ instrument: { functionalLocationId: { in: opts.locationIds } } });
  }

  if (q.instrumentId) AND.push({ instrumentId: q.instrumentId });
  if (q.type) AND.push({ ...TYPE_WHERE[q.type] });

  // The legacy single-axis filters. They stay in the BASE where — not behind
  // `includeStatus` — because they predate the four-way status token and the
  // callers that send them (dashboard panel, trend widget) render no count boxes.
  if (q.state) AND.push({ state: q.state });
  if (q.acknowledged !== undefined) {
    AND.push({ acknowledgedAt: q.acknowledged ? { not: null } : null });
  }

  if (q.from || q.to) {
    // On raisedAt, which is the column the table shows and the control is labelled
    // for. Any other reading (overlap, cleared-within) would need a second date
    // column on screen to be checkable.
    const raisedAt: { gte?: Date; lte?: Date } = {};
    if (q.from) raisedAt.gte = q.from;
    if (q.to) raisedAt.lte = q.to;
    AND.push({ raisedAt });
  }

  if (opts.includeStatus && q.status) AND.push(quadrantWhere(q.status) as Record<string, unknown>);

  return { AND };
}

export function buildAlarmOrderBy(sort: AlarmSortKey, dir: SortDir): Record<string, unknown>[] {
  // raisedAt is the tiebreak on every branch. Without one, two pages of a
  // non-unique sort can show the same alarm twice and omit another entirely.
  const tiebreak = { raisedAt: 'desc' as const };
  const nullsLast = { sort: dir, nulls: 'last' as const };

  switch (sort) {
    case 'clearedAt':
      return [{ clearedAt: nullsLast }, tiebreak];
    case 'instrumentCode':
      return [{ instrument: { code: dir } }, tiebreak];
    case 'type':
      return [{ metric: dir }, { limitKind: dir }, tiebreak];
    case 'status':
      return [{ state: dir }, { acknowledgedAt: nullsLast }, tiebreak];
    case 'raisedAt':
    default:
      return [{ raisedAt: dir }];
  }
}

export function pageBounds(page: number, pageSize: number): { skip: number; take: number } {
  return { skip: (page - 1) * pageSize, take: pageSize };
}
