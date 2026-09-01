import useSWR from 'swr';
import { Card, CardHeader, CardTitle } from '@/components/ui/card';
import { ExportMenu } from '@/components/ExportMenu';
import { SkeletonRows } from '@/components/ui/skeleton';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { quadrantTone, type AlarmRow, type AlarmStatusTexts, type AlarmDisplayTexts } from '@/routes/alarms/alarm-display';
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
 * **The sticky Acknowledge column is dropped too**, and that IS a capability
 * this widget does not have: acknowledging is a §11 signature, needing the
 * `alarms.acknowledge` gate, the re-auth dialog and a revalidation of the list
 * afterwards. None of the three is in scope here. The Alarms page is where an
 * alarm gets signed for.
 *
 * `GET /api/alarms` gained server-side date filtering on 2026-08-31, but this
 * widget still windows on `raisedAt` in the browser over `?instrumentId=…&limit=500`
 * — deliberately unchanged here, so a restyle could not quietly alter which
 * records the page shows.
 */
export function AlarmsWidget({
  instrumentId, period, onExportPdf, statusTexts, inactivityTexts,
}: {
  instrumentId: string;
  period: { from: string; to: string };
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
}) {
  const { formatDate, formatTime, formatDateTime } = useDatetimeFormat();
  const { data, isLoading, error } = useSWR<{ data: AlarmRow[] }>(
    instrumentId ? `/api/alarms?instrumentId=${instrumentId}&limit=500` : null,
  );

  const from = new Date(period.from).getTime();
  const to = new Date(period.to).getTime();
  const rows = (data?.data ?? []).filter((a) => {
    const raised = new Date(a.raisedAt).getTime();
    return raised >= from && raised <= to;
  });

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2">
        <CardTitle className="text-base">Alarms in this period</CardTitle>
        {/* Untouched. `surface="instrument-trend"` is what makes this download
            log its own §11 `reportType`, distinct from the Alarms page's. */}
        <ExportMenu surface="instrument-trend" onExportPdf={onExportPdf} />
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
                <Th>Type</Th>
                <Th>Raised</Th>
                {/* Stacked one word per line, as on the Alarms page: on one line
                    these two are the widest headings and set their columns'
                    width. */}
                <Th><Stack>Generated</Stack><Stack>Value</Stack><UnitLine>(°C / %RH)</UnitLine></Th>
                <Th>Limit</Th>
                <Th>Cleared</Th>
                <Th><Stack>Cleared</Stack><Stack>Value</Stack><UnitLine>(°C / %RH)</UnitLine></Th>
                <Th>Status</Th>
                {/* H = hours, m = minutes — abbreviated for the same reason as
                    on the Alarms page: spelled out it is the widest header here. */}
                <Th title="H = hours, m = minutes">Duration<UnitLine>(H/m)</UnitLine></Th>
                <Th><Stack>Acknowledged</Stack><Stack>by</Stack></Th>
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
                  <AlarmLimitCell a={a} texts={inactivityTexts} />
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </Card>
  );
}

/** Nine: the Alarms page's twelve, less Instrument ID, Location and the sticky
 *  Acknowledge cell. A colSpan one short leaves a hairline of unpainted table
 *  beside the empty-state message. */
const COLUMNS = 9;
