import { useState, useEffect, type ReactNode } from 'react';
import useSWR from 'swr';
import type { TrendWidgetTexts } from '@digilog/shared';
import type { DatetimeFormatOverride } from '@/hooks/use-datetime-format';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { useCan } from '@/hooks/use-can';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { AcknowledgeDialog } from '@/routes/alarms/acknowledge-dialog';
import { ExportMenu } from '@/components/ExportMenu';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { usePaginationDefaults } from '@/hooks/use-pagination-config';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import {
  quadrantTone, needsAcknowledgement, instrumentLabel,
  ALARM_QUADRANTS, alarmTypeOptions,
  type AlarmRow, type AlarmStatusTexts, type AlarmDisplayTexts, type AlarmQuadrant,
} from '@/routes/alarms/alarm-display';
import {
  AlarmTableHead, Th, Stack, UnitLine, ALARM_ROW_CLASS, AlarmTableMessage,
  AlarmTypeCell, AlarmTimeCell, AlarmValueCell, AlarmLimitCell,
  AlarmClearedValueCell, AlarmStatusCell, AlarmDurationCell, AlarmAckByCell,
} from '@/routes/alarms/alarm-table';

/**
 * This instrument's alarms for the current period.
 *
 * Drawn from the SAME cell vocabulary as the Alarms page
 * (`routes/alarms/alarm-table.tsx`) — the banner, the state marker, the status
 * pill and every cell are one definition, not a copy. It was a copy until
 * 2026-09-01, and the copy had drifted in the way copies do: it keyed its status
 * pill off SEVERITY, the exact bug the Alarms page had fixed the day before, so
 * on this installation (where every alarm is CRITICAL) every pill in the widget
 * rendered red and the column said nothing.
 *
 * Every word still comes from `alarm-display.ts`, the same vocabulary the Alarms
 * page uses, so this widget cannot describe the same event differently.
 *
 * **Two columns are deliberately dropped: Instrument ID and Location.** This
 * widget is scoped to ONE instrument, named in the page header above it, so both
 * would repeat the same value on every row. The remaining nine keep the Alarms
 * page's ordering and wording exactly.
 *
 * **Acknowledging IS available here** (operator, 2026-09-01) and carries the
 * full §11 flow: the `alarms.acknowledge` gate, the re-auth dialog, and a
 * revalidation afterwards. It was absent when this widget first shipped, and
 * this comment said so — correctly at the time, because none of those three
 * existed here and a button that renders but cannot complete a signature
 * invites an operator to try and fail. All three arrived with the button.
 *
 * Its column is NOT sticky, unlike the Alarms page's. That one is pinned
 * because twelve columns overflow a laptop and the single action was what fell
 * off the end; this table is ten columns and full width, so pinning would be
 * chrome solving nothing.
 *
 * `GET /api/alarms` gained server-side date filtering on 2026-08-31, but this
 * widget still windows on `raisedAt` in the browser over `?instrumentId=…&limit=500`
 * — deliberately unchanged here, so a restyle could not quietly alter which
 * records the page shows.
 */
export function AlarmsWidget({
  instrumentId, period, limits, onExportPdf, statusTexts, inactivityTexts,
  labels, dateTimeFormat, settingsButton = null,
}: {
  instrumentId: string;
  period: { from: string; to: string };
  /** This instrument's current bounds. The widget covers ONE instrument, so it
   *  can fill the Limit cell for the sources that carry no bound themselves. */
  limits?: { tempMin?: number | null; tempMax?: number | null; rhMin?: number | null; rhMax?: number | null } | null;
  onExportPdf: () => void;
  /** Configured status wording, from the same `/api/config/alarm-limits/status-texts`
   *  the Alarms page reads — `undefined` while loading, in which case `statusText()`
   *  falls back to the shipped defaults on its own. Never a second vocabulary. */
  statusTexts: AlarmStatusTexts | undefined;
  /** Every administered wording an alarm row can need — the inactivity cells and
   *  the RS485 failure word — from the same endpoints the Alarms page reads. Same
   *  rule throughout: a missing entry falls back to the shipped wording, never to
   *  a blank. */
  inactivityTexts: AlarmDisplayTexts | undefined;
  /**
   * This widget's ADMINISTERED title and nine column headings.
   *
   * The whole resolved bag rather than nine props: `trendWidgetLabel()` has
   * already turned a blank field into the shipped wording, so every value here is
   * non-empty and nothing in this file may default one. A `?? 'Status'` anywhere
   * below would be a second definition of a default that already lives in
   * `@digilog/shared`.
   */
  labels: TrendWidgetTexts['labels'];
  /** This widget's own date/time format override. Blank fields inherit the
   *  site-wide setting, which is what an unconfigured widget carries. */
  dateTimeFormat?: DatetimeFormatOverride;
  /** The SUPER_ADMIN edit affordance for those labels, rendered by the page. */
  settingsButton?: ReactNode;
}) {
  const { formatDate, formatTime, formatDateTime } = useDatetimeFormat(dateTimeFormat);
  const can = useCan();
  const { toast } = useToast();
  // From the SAME names the Type column renders (`AlarmTypeCell` takes
  // `inactivityTexts`), never a second lookup — a rename must reach the
  // filter and the column together or the control cannot select what it lists.
  const typeOptions = alarmTypeOptions(inactivityTexts?.typeNames);
  const [search, setSearch] = useState('');
  const [type, setType] = useState('');
  const [status, setStatus] = useState<AlarmQuadrant | ''>('');
  const [target, setTarget] = useState<AlarmRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState('');

  /**
   * Acknowledging here is the SAME §11 signature as on the Alarms page, and is
   * wired the same way on purpose: the `alarms.acknowledge` gate, the re-auth
   * dialog that captures the password and the reason, `postWithReauth`, and a
   * revalidation afterwards.
   *
   * The widget shipped WITHOUT this on 2026-09-01 and it was the right call at
   * the time — it had none of those four, and a button that renders but cannot
   * complete a signature invites an operator to try and fail. It is here now
   * because all four came with it, not because the button was added alone.
   *
   * The error stays in the dialog rather than becoming a toast: the password is
   * still on screen and has to be corrected in place. A 409 means someone else
   * signed for this alarm first.
   */
  const acknowledge = async (reason: string, password: string) => {
    if (!target) return;
    setSubmitting(true);
    setDialogError('');
    try {
      await apiClient.postWithReauth(`/api/alarms/${target.id}/acknowledge`, { reason }, password);
      toast.success('Alarm acknowledged', `Signed for ${instrumentLabel(target)}.`);
      setTarget(null);
      // This widget's own list only. The Alarms page holds a different query and
      // revalidates itself when it is next shown.
      await mutate();
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : 'Could not acknowledge this alarm.');
    } finally {
      setSubmitting(false);
    }
  };
  /**
   * Filtering happens on the SERVER, through the same parameters the Alarms
   * page uses — not over the rows already in hand.
   *
   * That page was rebuilt on 2026-08-31 for exactly this: it filtered a capped
   * window in the browser, so its counts described the newest 500 alarms while
   * reading as totals. A search box here that narrowed `rows` would repeat it
   * one surface down — it would look like it had searched the record and would
   * actually have searched a slice of it.
   *
   * `instrumentId` and the period still scope the query; these three narrow it
   * further. Empty strings are omitted rather than sent, so an untouched control
   * cannot become a filter.
   *
   * **THE PERIOD MOVED TO THE SERVER TOO (2026-09-01), and it was the last thing
   * here still done in the browser.** This fetched `limit: '500'` and then dropped
   * rows outside the period with an `Array.filter`, which is the defect the
   * paragraph above describes — a `limit` and a range meeting in one query — on
   * the very surface whose comment says filtering happens on the server. An
   * instrument with more than 500 alarms showed a "period" that was really its
   * newest 500, silently. It also made paging impossible: the server would have
   * paged 500-row windows and the browser would have thinned each one, so the page
   * numbers and the row counts would have described different populations.
   */
  const { defaultLimit } = usePaginationDefaults();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultLimit);

  const query = new URLSearchParams({
    instrumentId,
    from: period.from,
    to: period.to,
    page: String(page),
    pageSize: String(pageSize),
  });
  if (search.trim()) query.set('search', search.trim());
  if (type) query.set('type', type);
  if (status) query.set('status', status);

  const { data, isLoading, error, mutate } = useSWR<{ data: AlarmRow[]; total: number }>(
    instrumentId ? `/api/alarms?${query.toString()}` : null,
  );

  /**
   * Any change to WHICH alarms match invalidates the page number — page 4 of a
   * five-page result is an empty table once a filter narrows it to two. The same
   * rule and the same reason as the Alarms page.
   */
  useEffect(() => {
    setPage(1);
  }, [instrumentId, period.from, period.to, search, type, status, pageSize]);

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  return (
    <Card>
      {/* `flex-row` is LOAD-BEARING: `CardHeader`'s own base class is
          `flex flex-col`, and `flex-nowrap` does not override it — they are
          different property groups, so tailwind-merge leaves both standing and
          the title stacks above the toolbar. This header must state the
          direction explicitly. */}
      <CardHeader className="flex flex-row flex-nowrap items-center justify-between gap-3 space-y-0">
        <CardTitle className="truncate text-base">{labels.alarmsTitle}</CardTitle>

        {/* One row, never wrapping (operator, 2026-09-01). The title truncates
            before the controls do: a search box that has dropped onto its own
            line reads as a second section rather than as this card's toolbar. */}
        <div className="flex flex-nowrap items-center gap-2">
          {/* Search. The placeholder names what the SERVER actually matches, as
              on the Alarms page — Type is an enum rendered into words at display
              time, so there is no text to match and it has its own control. */}
          <div className="relative">
            <svg
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400"
              fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
            </svg>
            <input
              type="search"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search…"
              aria-label="Search this instrument's alarms"
              className="ctl w-36 pl-9 text-[0.8125rem]"
              /* Named and autocomplete-off for the same reason as the Alarms
                 page's box: an unnamed text input beside a password field is
                 what Chrome reaches for when it looks for a username to fill. */
              name="widget-alarm-search"
              autoComplete="off"
            />
          </div>

          {/* Labelled from the ADMINISTERED type names, so a rename on the
              config page reaches this control and the Type column together. */}
          <select
            value={type}
            onChange={(e) => setType(e.target.value)}
            aria-label="Filter by alarm type"
            className="ctl max-w-[8.5rem] text-[0.8125rem]"
          >
            <option value="">All types</option>
            {typeOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>

          {/* The four states, from the one catalogue the Alarms page reads. */}
          <select
            value={status}
            onChange={(e) => setStatus(e.target.value as AlarmQuadrant | '')}
            aria-label="Filter by status"
            className="ctl max-w-[9rem] text-[0.8125rem]"
          >
            <option value="">All statuses</option>
            {ALARM_QUADRANTS.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}
          </select>

          {/* Icon only (operator, 2026-09-01). `surface="instrument-trend"` is
              untouched — it is what makes this download log its own §11
              `reportType`, distinct from the Alarms page's. */}
          <ExportMenu surface="instrument-trend" iconOnly onExportPdf={onExportPdf} />
          {settingsButton}
        </div>
      </CardHeader>

      {/* The Card supplies the border and the radius; this wrapper only clips
          the banner's top corners and its own bottom ones to them, and scrolls
          the table sideways rather than the page. */}
      <div className="overflow-hidden rounded-b-[var(--radius-card)] border-t border-slate-200/60">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <AlarmTableHead>
              <tr>
                {/* No sortKey on any of these. The Alarms page sorts on the
                    SERVER; this widget holds one instrument's alarms for one
                    period and has no server sort behind it, and a header that
                    reordered only what is already in hand would claim a sort of
                    the record it is not doing. */}
                {/* Every heading is ADMINISTERED. `Heading` stacks a multi-word
                    name one word per line, which is what the three widest of
                    these already did by hand — on one line they set their
                    columns' width. A single-word heading is unwrapped, so the
                    shipped wording renders exactly as it did before.

                    The bracketed UNIT LEGENDS and the H/m tooltip are NOT
                    administered and deliberately survive a rename: they explain
                    the cells, not the column's name, and a rename that dropped
                    them would leave a column of bare numbers with no units. */}
                <Th><Heading text={labels.alarmsTypeHeading} /></Th>
                <Th><Heading text={labels.alarmsRaisedHeading} /></Th>
                <Th><Heading text={labels.alarmsGeneratedValueHeading} /><UnitLine>(°C / %RH)</UnitLine></Th>
                <Th><Heading text={labels.alarmsLimitHeading} /></Th>
                <Th><Heading text={labels.alarmsClearedHeading} /></Th>
                <Th><Heading text={labels.alarmsClearedValueHeading} /><UnitLine>(°C / %RH)</UnitLine></Th>
                <Th><Heading text={labels.alarmsStatusHeading} /></Th>
                <Th title="H = hours, m = minutes"><Heading text={labels.alarmsDurationHeading} /><UnitLine>(H/m)</UnitLine></Th>
                <Th><Heading text={labels.alarmsAcknowledgedByHeading} /></Th>
                {/* Not sticky, unlike the Alarms page. That column is pinned
                    there because twelve columns overflow a laptop and the one
                    ACTION was what fell off the end. This table is nine columns
                    and full width since the tables were stacked, so a pinned
                    column would be chrome with nothing to solve. */}
                <Th />
              </tr>
            </AlarmTableHead>
            <tbody className="divide-y divide-slate-100">
              {isLoading && !data && (
                <AlarmTableMessage colSpan={COLUMNS} className="px-4 py-4">
                  <SkeletonRows rows={3} columns={5} />
                </AlarmTableMessage>
              )}
              {/* Two DIFFERENT failures, worded differently on purpose — the same
                  distinction the Alarms page draws. Saying "no alarms in this
                  window" when the list could not be READ is a statement about
                  the record, and on a monitoring screen it reads as "nothing is
                  wrong". */}
              {error && rows.length === 0 && (
                <AlarmTableMessage colSpan={COLUMNS}>
                  The alarms for this period could not be loaded, so this table is not showing the current state.
                </AlarmTableMessage>
              )}
              {!isLoading && !error && rows.length === 0 && (
                <AlarmTableMessage colSpan={COLUMNS}>No alarms raised in this window.</AlarmTableMessage>
              )}
              {rows.map((a) => (
                <tr key={a.id} className={ALARM_ROW_CLASS}>
                  {/* The state marker rides on Type, the leading column here.
                      On the Alarms page it rides on Instrument ID, which this
                      widget drops — without re-homing it, the restyle would have
                      lost the one cue that finds an unanswered row without
                      reading across to the Status column. */}
                  <AlarmTypeCell a={a} texts={inactivityTexts} marker={quadrantTone(a)} />
                  <AlarmTimeCell value={a.raisedAt} formatDate={formatDate} formatTime={formatTime} />
                  <AlarmValueCell a={a} texts={inactivityTexts} />
                  <AlarmLimitCell a={a} texts={inactivityTexts} limits={limits} />
                  <AlarmTimeCell
                    value={a.clearedAt}
                    formatDate={formatDate}
                    formatTime={formatTime}
                    emptyTitle="Still breaching — not cleared"
                  />
                  <AlarmClearedValueCell a={a} texts={inactivityTexts} />
                  <AlarmStatusCell a={a} texts={statusTexts} />
                  <AlarmDurationCell a={a} />
                  <AlarmAckByCell a={a} formatDateTime={formatDateTime} />
                  <td className="whitespace-nowrap px-4 py-3 text-right">
                    {needsAcknowledgement(a) && can('alarms.acknowledge') && (
                      <Button size="sm" variant="outline" onClick={() => { setDialogError(''); setTarget(a); }}>
                        Acknowledge
                      </Button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Server-side paging, over the server's own `total` — never `rows.length`,
            which is one page and would make the count describe the page rather
            than the period. Changing Rows also resizes the panel it sits in on the
            dashboard, since panel height follows content. */}
        {total > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            totalItems={total}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        )}
      </div>

      <AcknowledgeDialog
        alarm={target}
        open={target !== null}
        submitting={submitting}
        error={dialogError}
        onSubmit={acknowledge}
        onClose={() => setTarget(null)}
        inactivityTexts={inactivityTexts}
      />
    </Card>
  );
}

/**
 * One administered heading, one word per line when it has more than one.
 *
 * `Th` sets `whitespace-nowrap`, so a two-word heading on one line is the widest
 * cell in the table and drags its column out with it — which is why "Generated
 * Value", "Cleared Value" and "Acknowledged by" were already hand-stacked here
 * and on the Alarms page. Stacking is applied uniformly rather than to a
 * hardcoded three, so a rename cannot produce a heading nobody thought to stack.
 *
 * A single word renders as a bare text node, exactly as before — the shipped
 * headings are byte-for-byte what they were.
 */
function Heading({ text }: { text: string }) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= 1) return <>{text}</>;
  return <>{words.map((w, i) => <Stack key={`${w}-${i}`}>{w}</Stack>)}</>;
}

/** Nine: the Alarms page's twelve, less Instrument ID, Location and the sticky
 *  Acknowledge cell. A colSpan one short leaves a hairline of unpainted table
 *  beside the empty-state message. */
const COLUMNS = 10;
