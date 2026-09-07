import { PageHeader } from '@/components/ui/page-header';
import { InstrumentHistoryWidget } from '@/routes/instruments/history-widget';

/**
 * Data Report (2026-09-07). Operator: *"in dashboard Instruments history widget
 * was there that widget removed there and add one side bar option Data Report,
 * in that it should come"*.
 *
 * A header and the Instrument History widget — Block / Area / instrument
 * selection, the merged readings of the selection over a period, and the Data
 * Report download for every selected instrument. The widget carries all of the
 * behaviour (`routes/instruments/history-widget.tsx`); this file only gives it
 * a screen and a name. The name is printed ONCE, here: the widget has no title
 * of its own, for the same reason the dashboard card used to suppress it.
 *
 * Gated on INSTRUMENT_READ (route and sidebar both, through the `data-report`
 * tree group): it shows instrument readings, so it is governed by the
 * permission that already governs them. The download keeps its own
 * DOWNLOAD_REPORT re-auth and audit row inside the widget.
 */
export function DataReportPage() {
  return (
    <div>
      <PageHeader
        className="mb-6"
        title="Data Report"
        description="Readings of a Block, an Area or chosen instruments over a period, and the Data Report download for the selection."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Data Report' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M9 17v-4m3 4v-8m3 8v-2m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
        }
      />
      <InstrumentHistoryWidget />
    </div>
  );
}
