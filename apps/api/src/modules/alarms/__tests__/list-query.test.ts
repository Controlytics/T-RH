import { describe, it, expect } from 'vitest';
import {
  ALARM_TYPE_TOKENS, ALARM_STATUS_TOKENS,
  parseAlarmListQuery, buildAlarmWhere, buildAlarmOrderBy, quadrantWhere, pageBounds,
} from '../list-query.js';

describe('parseAlarmListQuery', () => {
  it('defaults to page 1 and the shipped page size', () => {
    const q = parseAlarmListQuery({});
    expect(q).toMatchObject({ page: 1, pageSize: 25, sort: 'raisedAt', dir: 'desc' });
    expect(q.error).toBeNull();
  });

  it('clamps a page size above the ceiling instead of accepting it', () => {
    expect(parseAlarmListQuery({ pageSize: 5000 }).pageSize).toBe(500);
    expect(parseAlarmListQuery({ pageSize: 0 }).pageSize).toBe(1);
  });

  it('honours the legacy `limit` as an alias for pageSize', () => {
    // The dashboard panel and the trend page's alarms widget still send `limit`.
    // Dropping it would silently truncate them to the default page.
    expect(parseAlarmListQuery({ limit: 500 }).pageSize).toBe(500);
    expect(parseAlarmListQuery({ limit: '25' }).pageSize).toBe(25);
    expect(parseAlarmListQuery({ limit: 500, pageSize: 10 }).pageSize).toBe(10);
  });

  it('keeps the legacy single-axis state and acknowledged filters', () => {
    expect(parseAlarmListQuery({ state: 'ACTIVE' }).state).toBe('ACTIVE');
    expect(parseAlarmListQuery({ acknowledged: 'false' }).acknowledged).toBe(false);
    expect(parseAlarmListQuery({ acknowledged: 'true' }).acknowledged).toBe(true);
    expect(parseAlarmListQuery({}).acknowledged).toBeUndefined();
  });

  it('ACCEPTS AND IGNORES the retired `severity` parameter instead of refusing it', () => {
    // Severity stopped being administered on 2026-09-01 and the Alarms page filter
    // went with it, but a stale bookmark or a browser still running the previous
    // bundle can send `?severity=`. Three separate claims, because three separate
    // things could go wrong:
    //   1. a VALID old value is not an error — a 400 would blank the page for
    //      someone mid-session over a filter that no longer selects anything;
    //   2. an INVALID one is not an error either — re-declaring the old enum on the
    //      route schema would 400 on a parameter nothing reads;
    //   3. it does not reach the WHERE — accepted must mean ignored, not applied.
    // (3) is the one that would be a real defect: silently filtering on a column
    // the UI can no longer set would hide alarms under a header claiming otherwise.
    for (const v of ['CRITICAL', 'LOUD', '']) {
      const q = parseAlarmListQuery({ severity: v });
      expect(q.error, `severity=${v} should not be an error`).toBeNull();
      expect(buildAlarmWhere(q).AND, `severity=${v} should not reach the where`).toEqual([]);
    }
  });

  it('rejects an unparseable date rather than silently ignoring it', () => {
    // Silently dropping the bound would return alarms from outside the range the
    // operator asked for, under a header that says the range was applied.
    const q = parseAlarmListQuery({ from: 'yesterday' });
    expect(q.error).toEqual({ field: 'from', message: expect.stringContaining('date') });
  });

  it('rejects a range that ends before it starts', () => {
    const q = parseAlarmListQuery({ from: '2026-08-27T10:00:00.000Z', to: '2026-08-27T09:00:00.000Z' });
    expect(q.error?.field).toBe('to');
  });

  it('rejects an unknown type or status token', () => {
    expect(parseAlarmListQuery({ type: 'TEMP_SIDEWAYS' }).error?.field).toBe('type');
    expect(parseAlarmListQuery({ status: 'pending' }).error?.field).toBe('status');
  });

  it('accepts every token it advertises', () => {
    for (const t of ALARM_TYPE_TOKENS) expect(parseAlarmListQuery({ type: t }).error).toBeNull();
    for (const s of ALARM_STATUS_TOKENS) expect(parseAlarmListQuery({ status: s }).error).toBeNull();
  });

  it('falls back to the default sort for an unknown key rather than erroring', () => {
    // A stale bookmark should still list alarms; only a filter that would change
    // WHICH rows are returned is worth a 400.
    expect(parseAlarmListQuery({ sort: 'colour' }).sort).toBe('raisedAt');
  });

  it('trims the search term and treats whitespace as absent', () => {
    expect(parseAlarmListQuery({ search: '  CWH  ' }).search).toBe('CWH');
    expect(parseAlarmListQuery({ search: '   ' }).search).toBeUndefined();
  });
});

describe('buildAlarmWhere', () => {
  const base = parseAlarmListQuery({});

  it('is an empty AND when nothing is filtered', () => {
    expect(buildAlarmWhere(base)).toEqual({ AND: [] });
  });

  it('ANDs every fragment rather than merging keys', () => {
    // Search and a location filter both want an `instrument` key. Merged into one
    // object, the later one would replace the earlier and silently widen the result.
    const q = parseAlarmListQuery({ search: 'CWH' });
    const where = buildAlarmWhere(q, { locationIds: ['loc-1', 'loc-2'] });
    expect(where.AND).toHaveLength(2);
    expect(JSON.stringify(where)).toContain('loc-1');
    expect(JSON.stringify(where)).toContain('CWH');
  });

  it('searches instrument code, name, functional location and room code', () => {
    const where = buildAlarmWhere(parseAlarmListQuery({ search: 'blender' }));
    const or = (where.AND[0] as { instrument: { OR: Record<string, unknown>[] } }).instrument.OR;
    expect(or).toHaveLength(4);
    for (const clause of or) {
      expect(JSON.stringify(clause)).toContain('"mode":"insensitive"');
    }
  });

  it('maps each type token onto the enum columns that define it', () => {
    const of = (type: string) => buildAlarmWhere(parseAlarmListQuery({ type })).AND[0];
    expect(of('TEMP_HIGH')).toEqual({ metric: 'TEMPERATURE', limitKind: 'HIGH' });
    expect(of('TEMP_LOW')).toEqual({ metric: 'TEMPERATURE', limitKind: 'LOW' });
    expect(of('RH_HIGH')).toEqual({ metric: 'HUMIDITY', limitKind: 'HIGH' });
    expect(of('RH_LOW')).toEqual({ metric: 'HUMIDITY', limitKind: 'LOW' });
    expect(of('OFFLINE')).toEqual({ metric: 'OFFLINE' });
    // These two carry metric TEMPERATURE or HUMIDITY like a limit alarm does, so
    // `source` is the only column that identifies them.
    expect(of('RS485')).toEqual({ source: 'RS485_FAILURE' });
    expect(of('RANGE')).toEqual({ source: 'SENSOR_RANGE' });
  });

  it('puts the date range on raisedAt, which is the column the operator can see', () => {
    const q = parseAlarmListQuery({ from: '2026-08-27T00:00:00.000Z', to: '2026-08-27T23:59:00.000Z' });
    const frag = buildAlarmWhere(q).AND[0] as { raisedAt: { gte?: Date; lte?: Date } };
    expect(frag.raisedAt.gte).toEqual(new Date('2026-08-27T00:00:00.000Z'));
    expect(frag.raisedAt.lte).toEqual(new Date('2026-08-27T23:59:00.000Z'));
  });

  it('applies one bound when only one is given', () => {
    const frag = buildAlarmWhere(parseAlarmListQuery({ from: '2026-08-27T00:00:00.000Z' })).AND[0];
    expect(frag).toEqual({ raisedAt: { gte: new Date('2026-08-27T00:00:00.000Z') } });
  });

  it('matches nothing when a location resolves to no ids', () => {
    // `{ in: [] }` matches nothing, which is the honest answer for a location the
    // caller cannot see. Omitting the fragment would return every alarm instead.
    const where = buildAlarmWhere(base, { locationIds: [] });
    expect(where.AND[0]).toEqual({ instrument: { functionalLocationId: { in: [] } } });
  });

  it('omits the location fragment entirely when no location was asked for', () => {
    expect(buildAlarmWhere(base, {}).AND).toEqual([]);
  });

  it('keeps the legacy state/acknowledged filters in the base where', () => {
    // Unlike the four-way status token, these are NOT excluded from the count
    // query — the callers that send them render no count boxes.
    const q = parseAlarmListQuery({ state: 'ACTIVE', acknowledged: 'false' });
    expect(buildAlarmWhere(q).AND).toEqual([{ state: 'ACTIVE' }, { acknowledgedAt: null }]);
  });

  it('includes the status fragment only when includeStatus is set', () => {
    const q = parseAlarmListQuery({ status: 'cleared-unack' });
    expect(buildAlarmWhere(q).AND).toEqual([]);
    expect(buildAlarmWhere(q, { includeStatus: true }).AND).toEqual([
      { state: 'CLEARED', acknowledgedAt: null },
    ]);
  });
});

describe('quadrantWhere', () => {
  it('splits on the two independent axes, condition and signature', () => {
    expect(quadrantWhere('active-unack')).toEqual({ state: 'ACTIVE', acknowledgedAt: null });
    expect(quadrantWhere('active-ack')).toEqual({ state: 'ACTIVE', acknowledgedAt: { not: null } });
    expect(quadrantWhere('cleared-unack')).toEqual({ state: 'CLEARED', acknowledgedAt: null });
    expect(quadrantWhere('cleared-ack')).toEqual({ state: 'CLEARED', acknowledgedAt: { not: null } });
  });

  it('covers every alarm exactly once, so the four counts sum to the total', () => {
    const rows = [
      { state: 'ACTIVE', acknowledgedAt: null },
      { state: 'ACTIVE', acknowledgedAt: new Date() },
      { state: 'CLEARED', acknowledgedAt: null },
      { state: 'CLEARED', acknowledgedAt: new Date() },
    ];
    const matches = (w: ReturnType<typeof quadrantWhere>, r: (typeof rows)[number]) =>
      w.state === r.state && (w.acknowledgedAt === null ? r.acknowledgedAt === null : r.acknowledgedAt !== null);
    for (const r of rows) {
      const hits = ALARM_STATUS_TOKENS.filter((t) => matches(quadrantWhere(t), r));
      expect(hits).toHaveLength(1);
    }
  });
});

describe('buildAlarmOrderBy', () => {
  it('defaults to newest first', () => {
    expect(buildAlarmOrderBy('raisedAt', 'desc')).toEqual([{ raisedAt: 'desc' }]);
  });

  it('breaks every tie on raisedAt so paging cannot repeat or drop a row', () => {
    // Without a unique-enough tiebreak, two pages of a non-unique sort can show
    // the same alarm twice and omit another entirely.
    for (const key of ['clearedAt', 'instrumentCode', 'type', 'status'] as const) {
      const order = buildAlarmOrderBy(key, 'asc');
      expect(order[order.length - 1]).toEqual({ raisedAt: 'desc' });
    }
  });

  it('sorts by the related instrument code, not the raw foreign key', () => {
    expect(buildAlarmOrderBy('instrumentCode', 'asc')[0]).toEqual({ instrument: { code: 'asc' } });
  });

  it('sorts type by metric then bound, which is what the column renders', () => {
    expect(buildAlarmOrderBy('type', 'asc').slice(0, 2)).toEqual([
      { metric: 'asc' }, { limitKind: 'asc' },
    ]);
  });

  it('keeps nullable timestamps last in both directions', () => {
    // A still-active alarm has no cleared time. Postgres would float those NULLs
    // to the top on DESC, burying the rows the sort was asked about.
    expect(buildAlarmOrderBy('clearedAt', 'desc')[0]).toEqual({ clearedAt: { sort: 'desc', nulls: 'last' } });
    expect(buildAlarmOrderBy('clearedAt', 'asc')[0]).toEqual({ clearedAt: { sort: 'asc', nulls: 'last' } });
  });
});

describe('pageBounds', () => {
  it('turns a 1-based page into a skip/take', () => {
    expect(pageBounds(1, 25)).toEqual({ skip: 0, take: 25 });
    expect(pageBounds(3, 10)).toEqual({ skip: 20, take: 10 });
  });
});
