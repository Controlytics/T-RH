import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import useSWR from 'swr';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { useSensorWords, useAlarmTypeNames } from '@/hooks/use-failure-text';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { SkeletonRows } from '@/components/ui/skeleton';
import { Pagination } from '@/components/ui/pagination';
import { usePanelToolbarSlot } from './panel-card';
import {
  AlarmWidgetFilters, applyWidgetFilters, EMPTY_WIDGET_FILTERS, ACTIVE_QUADRANTS,
  type AlarmWidgetFilterValue,
} from '@/routes/alarms/alarm-widget-filters';
import { usePaginationDefaults } from '@/hooks/use-pagination-config';
import { AcknowledgeDialog } from '@/routes/alarms/acknowledge-dialog';
import {
  quadrantTone, needsAcknowledgement, instrumentLabel,
  mapStatusTextsResponse, mapInactivityTextsResponse,
  type AlarmRow, type AlarmStatusTexts, type AlarmStatusTextsResponse,
  type AlarmDisplayTexts, type InactivityTextsResponse,
} from '@/routes/alarms/alarm-display';
import {
  AlarmTableHead, Th, Stack, UnitLine, ALARM_ROW_CLASS, AlarmTableMessage,
  AlarmInstrumentCell, AlarmTypeCell, AlarmLocationCell, AlarmTimeCell,
  AlarmValueCell, AlarmLimitCell, AlarmStatusCell, AlarmAckByCell,
} from '@/routes/alarms/alarm-table';

/**
 * Active alarms on the instruments in the current drill-down.
 *
 * The existing Alarms COUNT card is a top-level navigation destination and stays
 * as it is; this is the list, and unlike that card it follows the selection —
 * which is why the count card was written to appear only at the top level in the
 * first place ("a global alarm count would be misleading" deeper in the tree).
 *
 * Scoped twice over on the server: by the caller's instrument visibility, and by
 * the location filter. The second narrows within the first and can never escape it.
 *
 * **Built on the SHARED alarm cells** (`routes/alarms/alarm-table.tsx`), the same
 * vocabulary the Alarms page and the trend page's widget render — rebuilt from a
 * bespoke `<ul>` on 2026-09-01. Two hand-maintained tables for one kind of record
 * drift, and this repo has watched it happen: the trend widget keyed its status
 * pill off SEVERITY, the exact defect the Alarms page had fixed the day before,
 * and on an installation where every alarm is CRITICAL that painted every pill
 * red. **Do not copy markup out of that module — import it.**
 *
 * Every word comes from `alarm-display.ts` and the administered configs behind
 * it, so this panel cannot describe an event differently from the page it links
 * to.
 *
 * **Acknowledging IS available here** (operator, 2026-09-01) and carries the
 * full §11 flow: the `alarms.acknowledge` gate, the re-auth dialog that captures
 * the password and the reason, `postWithReauth`, and a revalidation afterwards.
 * The panel shipped WITHOUT it earlier the same day and that was right at the
 * time — it had none of those four, and a button that renders but cannot
 * complete a signature invites an operator to try and fail. It is here now
 * because all four came with it, not because the button was added alone.
 */

/**
 * NINE columns — eight of the Alarms page's twelve, plus its unlabelled action
 * cell.
 *
 * The three that are missing are missing for one reason: this panel queries
 * `state=ACTIVE` only, so `clearedAt` is null on every row it can ever show.
 * **Cleared, Cleared Value and Duration would be structurally blank** — three
 * columns of dashes, in a panel that lives inside a resizable `PanelCard` rather
 * than at full page width. **If the query below ever widens beyond ACTIVE, add
 * those three back**; the cells for them are already exported and take the same
 * props as their neighbours here.
 *
 * Instrument ID and Location are KEPT, unlike the trend page's widget, which
 * drops both: that one is scoped to a single instrument named in the page header
 * above it, and this one spans every instrument in the selection.
 */
const COLUMNS = 9;

export function SelectionAlarms({ functionalLocationId }: { functionalLocationId?: string }) {
  const { formatDate, formatTime, formatDateTime } = useDatetimeFormat();
  const can = useCan();
  const { toast } = useToast();
  const [target, setTarget] = useState<AlarmRow | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [dialogError, setDialogError] = useState('');

  /*
   * The SAME administered wording the Alarms page reads, wired the same way.
   *
   * Every cell takes its `texts` as optional and falls back to the shipped
   * defaults, so omitting these would compile and would look entirely correct —
   * right up until somebody renames an alarm type or the RS485 failure word and
   * it reaches two of the three alarm surfaces. Three screens, one vocabulary.
   *
   * Both are narrow, all-authenticated-users reads; the configs themselves are
   * SUPER_ADMIN-only. Undefined while loading degrades to the shipped wording,
   * never to a blank cell.
   */
  const { data: statusTextsResponse } = useSWR<AlarmStatusTextsResponse>(
    '/api/config/alarm-limits/status-texts',
  );
  const statusTexts: AlarmStatusTexts | undefined =
    statusTextsResponse ? mapStatusTextsResponse(statusTextsResponse) : undefined;

  const { data: inactivityTextsResponse } = useSWR<InactivityTextsResponse>(
    '/api/config/inactivity-alarms/display-texts',
  );
  const sensorWords = useSensorWords();
  const typeNames = useAlarmTypeNames();
  const texts: AlarmDisplayTexts = {
    ...(inactivityTextsResponse ? mapInactivityTextsResponse(inactivityTextsResponse) : {}),
    sensorFailure: sensorWords.failure,
    outOfRange: sensorWords.outOfRange,
    typeNames,
  };

  /**
   * PAGED (operator, 2026-09-01). It fetched a flat `limit: '25'` and showed
   * whatever came back, so on a selection with more than 25 active alarms the
   * panel silently showed the newest 25 and said nothing — there was no count on
   * screen to contradict it and no way to reach the rest without leaving for the
   * Alarms page.
   *
   * The `state=ACTIVE` scope and the location scope are UNCHANGED. Only how many
   * rows are shown at once has changed, and the pagination now states the total,
   * so what the panel is showing is legible rather than assumed.
   *
   * `defaultLimit` is the administered page size, the same one the Alarms page
   * opens at, rather than a second hardcoded 25 that would drift from it.
   */
  const { defaultLimit } = usePaginationDefaults();
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(defaultLimit);

  /**
   * The SAME three filters the trend page's alarms widget carries (operator,
   * 2026-09-01), through the same component — search, type and status, every one
   * of them a real query parameter rather than a narrowing of the rows in hand.
   * On a paged panel a client-side filter would narrow ONE PAGE while reading as
   * a filter of the selection.
   */
  const [filters, setFilters] = useState<AlarmWidgetFilterValue>(EMPTY_WIDGET_FILTERS);
  const toolbarSlot = usePanelToolbarSlot();

  const qs = new URLSearchParams({
    state: 'ACTIVE',
    page: String(page),
    pageSize: String(pageSize),
  });
  if (functionalLocationId) qs.set('functionalLocationId', functionalLocationId);
  applyWidgetFilters(qs, filters);

  const { data, error, mutate } = useSWR<{ data: AlarmRow[]; total: number }>(
    `/api/alarms?${qs.toString()}`,
    { refreshInterval: 30_000 },
  );

  /**
   * Drilling into another location changes WHICH alarms match, so the page number
   * stops meaning anything — page 3 of the old selection is very often past the
   * end of the new one, and the panel would open empty on a location that has
   * alarms.
   */
  useEffect(() => {
    setPage(1);
  }, [functionalLocationId, pageSize, filters.search, filters.type, filters.status]);

  /**
   * Acknowledging here is the SAME §11 signature as on the Alarms page, and is
   * wired the same way on purpose: the `alarms.acknowledge` gate, the re-auth
   * dialog that captures the password and the reason, `postWithReauth`, and a
   * revalidation afterwards.
   *
   * The error stays in the DIALOG rather than becoming a toast: the password is
   * still on screen and has to be corrected in place, and a toast over a modal
   * puts the message where the correction is not. A 409 means someone else
   * signed for this alarm first.
   *
   * `mutate()` revalidates THIS panel's own key only. The Alarms page holds a
   * different query and revalidates itself when it is next shown — reaching for
   * its key from here would mean naming a URL this component does not build,
   * which is the kind of coupling that silently stops working when either
   * query changes.
   */
  const acknowledge = async (reason: string, password: string) => {
    if (!target) return;
    setSubmitting(true);
    setDialogError('');
    try {
      await apiClient.postWithReauth(`/api/alarms/${target.id}/acknowledge`, { reason }, password);
      toast.success('Alarm acknowledged', `Signed for ${instrumentLabel(target)}.`);
      setTarget(null);
      await mutate();
    } catch (e) {
      setDialogError(e instanceof Error ? e.message : 'Could not acknowledge this alarm.');
    } finally {
      setSubmitting(false);
    }
  };

  // A permission error must not render as "no alarms" — that reads as "nothing is
  // wrong" to someone who simply cannot see them. Same reasoning as the count
  // card's `canSeeAlarms` guard.
  if (error) return null;

  const rows = data?.data ?? [];
  const total = data?.total ?? 0;

  const filterBar = (
    <AlarmWidgetFilters
      value={filters}
      onChange={setFilters}
      typeNames={typeNames}
      /* TWO options, not four. This panel's query is pinned to `state=ACTIVE`,
         and `quadrantWhere` emits `state: 'CLEARED'` for the other two — ANDed
         together they match nothing, always. Offering them would be two controls
         that can only ever empty the table, and they would read as a filter that
         found nothing rather than one that could not. */
      statusOptions={ACTIVE_QUADRANTS}
      searchLabel="Search the active alarms in this selection"
      searchName="selection-alarm-search"
    />
  );
  const toolbar = toolbarSlot ? createPortal(filterBar, toolbarSlot) : filterBar;

  return (
    <section className="space-y-2">
      {/* No heading here: PanelCard supplies it, and the operator may have
          renamed it. A second hard-coded title would contradict theirs.

          The toolbar goes UP INTO that same header (operator, 2026-09-01) so the
          title and the filters share one line. Rendered inline when there is no
          PanelCard around it — a panel that dropped its search box when mounted
          on its own would be broken in exactly the place tests look. */}
      {toolbar}
      {/* TRANSPARENT, not bg-white. This sits inside a PanelCard that already
          draws the border, the rounding and — the point of that change — the
          operator's chosen tint. An opaque box here painted over the tint, so
          only the card's border appeared to change colour.

          The inner wrapper clips the shared banner's corners to this one and
          scrolls the table sideways rather than the panel. */}
      <div className="overflow-hidden rounded-xl border border-slate-200/70">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <AlarmTableHead>
              <tr>
                {/* No `sortKey` on any of these. The Alarms page sorts on the
                    SERVER; this panel takes the newest 25 active alarms in the
                    selection and has no server sort behind it, so a header that
                    reordered only the rows already in hand would claim a sort of
                    the record it is not doing. */}
                <Th>Instrument ID</Th>
                <Th>Type</Th>
                <Th>Location</Th>
                <Th>Raised</Th>
                {/* Stacked one word per line, and the bracketed unit legend under
                    the name — both exactly as the Alarms page has them. `Th` is
                    `whitespace-nowrap`, so an unstacked two-word heading is the
                    widest cell in the table and drags its column out with it,
                    which matters more here than on a full-width page. */}
                <Th><Stack>Generated</Stack><Stack>Value</Stack><UnitLine>(°C / %RH)</UnitLine></Th>
                <Th>Limit</Th>
                <Th>Status</Th>
                <Th><Stack>Acknowledged</Stack><Stack>by</Stack></Th>
                {/* The action column, unlabelled as on the Alarms page.
                    **NOT sticky, and the reason is not the column count.** That
                    page pins its action cell because twelve columns overflow a
                    laptop; nine can overflow a narrow panel just as easily, so
                    that argument would point the other way here. What decides it
                    is the TINT: a sticky cell must carry an OPAQUE background or
                    the rows scroll through it, and this panel sits on the
                    operator's chosen PanelCard colour — the same reason the
                    wrapper below is transparent rather than `bg-white`. A white
                    stripe pinned down the right edge would paint over the tint
                    that change exists to show. The panel scrolls sideways
                    instead. */}
                <Th />
              </tr>
            </AlarmTableHead>
            <tbody className="divide-y divide-slate-100">
              {!data && (
                <AlarmTableMessage colSpan={COLUMNS} className="px-4 py-4">
                  <SkeletonRows rows={3} columns={4} />
                </AlarmTableMessage>
              )}
              {data && rows.length === 0 && (
                <AlarmTableMessage colSpan={COLUMNS} className="px-4 py-6 text-sm text-slate-500">
                  No active alarms here.
                </AlarmTableMessage>
              )}
              {rows.map((a) => (
                <tr key={a.id} className={ALARM_ROW_CLASS}>
                  {/* The state marker rides on the LEADING cell — Instrument ID
                      here, as on the Alarms page, since this panel keeps that
                      column. It is what finds an unanswered row without reading
                      across to the Status column. */}
                  <AlarmInstrumentCell a={a} marker={quadrantTone(a)} />
                  <AlarmTypeCell a={a} texts={texts} />
                  {/* The FUNCTIONAL location, never the drawn room. */}
                  <AlarmLocationCell a={a} />
                  <AlarmTimeCell value={a.raisedAt} formatDate={formatDate} formatTime={formatTime} />
                  <AlarmValueCell a={a} texts={texts} />
                  {/* No `limits` prop: this panel spans many instruments, so
                      there is no single set of current bounds to pass — exactly
                      as on the Alarms page. The cell falls back to a dash for the
                      sources that carry no bound of their own. */}
                  <AlarmLimitCell a={a} texts={texts} />
                  {/* Keyed off `quadrantTone(a)` inside the cell, NEVER off
                      severity. That is the single reason this pill is a shared
                      component and not two lines of JSX here. */}
                  <AlarmStatusCell a={a} texts={statusTexts} />
                  <AlarmAckByCell a={a} formatDateTime={formatDateTime} />
                  {/* Gated TWICE, and both halves matter: `needsAcknowledgement`
                      so an already-signed alarm offers nothing to sign, and
                      `can('alarms.acknowledge')` — the discriminating backend
                      gate — so a role without the permission is not shown a
                      button the server will refuse. Hiding it is presentation;
                      the server's 403 is the control. */}
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

        {/* The server's `total`, never `rows.length` — that is one page, and a
            count taken from it would describe the page while reading as the
            selection. This panel's whole defect was a cap nobody could see.
            Rendered only when there is something to page: an empty panel saying
            "Showing 0-0 of 0" is noisier than the "No active alarms" line above. */}
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

      {/* `inactivityTexts` is the SAME bag the rows render from, not a second
          lookup: the dialog restates the alarm being signed for, and that
          restatement must read identically to the row the operator clicked. */}
      <AcknowledgeDialog
        alarm={target}
        open={target !== null}
        submitting={submitting}
        error={dialogError}
        onSubmit={acknowledge}
        onClose={() => setTarget(null)}
        inactivityTexts={texts}
      />
    </section>
  );
}

/*
 * **The Acknowledge column arrived with its whole flow, not as a button**
 * (operator, 2026-09-01).
 *
 * Acknowledging an alarm is a §11.200 electronic signature and needs four
 * things: the `alarms.acknowledge` gate, the re-auth dialog that captures the
 * password and the reason, `postWithReauth`, and a revalidation afterwards.
 * This panel shipped WITHOUT the button earlier the same day precisely because
 * it had none of them — a button that renders but cannot complete a signature
 * invites an operator to try and fail on a compliance screen. That reasoning has
 * not been withdrawn; it has been satisfied. **If you ever strip one of the four,
 * strip the button in the same pass.**
 *
 * **The "All alarms →" link was REMOVED (operator, 2026-09-01)**, and the reason
 * it was there has largely gone with it: the note here used to justify it as the
 * route to "the filters, the four state counts and the paging this panel
 * deliberately does not have" — but this panel gained server-side paging and a
 * total earlier the same day, so two thirds of that sentence had already stopped
 * being true. The Alarms page still owns the full record and its four state
 * counts, and is still reachable from the sidebar; it no longer needs a second
 * door out of a dashboard panel.
 *
 * The panel is therefore heading-less and link-less by design: `PanelCard`
 * supplies the title, and everything else in it acts on the rows it shows.
 *
 * There is no severity badge. Severity stopped being an administered concept on
 * 2026-09-01 and was removed from every display surface; this row's badge was
 * its last one on the dashboard, `severityTone` no longer exists, and the API no
 * longer sends the field. Every row here is `state=ACTIVE`, so the badge was not
 * carrying the row's state either — the Status pill is.
 */
