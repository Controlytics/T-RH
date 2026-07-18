import { useState } from 'react';
import { useParams } from 'react-router-dom';
import useSWR from 'swr';
import { useDatetimeFormat } from '../../hooks/use-datetime-format';
import { useReportLabels } from '../../hooks/use-report-labels';
import { ReportPageWrapper } from '@/components/report-page-wrapper';
import { Pagination } from '@/components/ui/pagination';
import { usePaginationDefaults } from '@/hooks/use-pagination-config';
import type { CleaningCycle, FilterEvent, PaginatedResponse } from '../../types/filter';

const TRACE_COLS = ['code', 'reason', 'status', 'started', 'completed', 'seq'];

export function FilterTraceabilityPage() {
  const { id } = useParams<{ id: string }>();
  const { formatDateTime, formatDate, formatTime } = useDatetimeFormat();
  const { labelsFor } = useReportLabels();
  const L = labelsFor('filter-traceability');
  const traceHead = TRACE_COLS.map((k) => L.columns[k]);
  const { options: paginationOptions, defaultLimit } = usePaginationDefaults();
  const [tab, setTab] = useState<'events' | 'cycles' | 'deviations'>('events');
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(defaultLimit);

  const { data: filterState } = useSWR(id ? `/api/filters/${id}/current-state` : null);
  const { data: events } = useSWR<PaginatedResponse<FilterEvent>>(tab === 'events' && id ? `/api/filters/events?filterId=${id}&page=${page}&limit=${perPage}` : null);
  const { data: cycles } = useSWR<PaginatedResponse<CleaningCycle>>(tab === 'cycles' && id ? `/api/filters/cycles?filterId=${id}&page=${page}&limit=${perPage}` : null);
  const { data: deviations } = useSWR<PaginatedResponse<FilterEvent>>(tab === 'deviations' && id ? `/api/filters/events?filterId=${id}&eventType=BYPASS_DEVIATION&page=${page}&limit=${perPage}` : null);

  const currentData = tab === 'events' ? events : tab === 'cycles' ? cycles : deviations;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <h1 className="text-2xl font-bold text-slate-800 mb-2">{filterState?.filterName ?? 'Filter'} — {L.title}</h1>
        <div className="flex gap-4 text-sm text-slate-500">
          {filterState?.currentState && (
            <span>State: <span className="text-cyan-600">{filterState.currentState.replace(/_/g, ' ')}</span></span>
          )}
          {filterState?.filterSet && <span>Set: <span className="text-slate-700">{filterState.filterSet.replace('SET_', '')}</span></span>}
          <span>Total Cycles: <span className="text-slate-700">{filterState?.totalCycles ?? 0}</span></span>
        </div>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 bg-white border border-slate-200 rounded-lg p-1 w-fit">
        {(['events', 'cycles', 'deviations'] as const).map(t => (
          <button key={t} onClick={() => { setTab(t); setPage(1); }}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${tab === t ? 'bg-cyan-600 text-white' : 'text-slate-500 hover:text-slate-700'}`}>
            {t === 'events' ? 'Event Log' : t === 'cycles' ? 'Cycle History' : 'Deviations'}
          </button>
        ))}
      </div>

      {/* Content */}
      <ReportPageWrapper
        title={L.title}
        totalRecords={currentData?.total ?? 0}
        page={page}
        totalPages={currentData?.totalPages ?? 1}
      >
      {tab === 'events' && (
        <div className="space-y-2">
          {(events?.data ?? []).map((e) => (
            <div key={e.id} className={`bg-white border-l-4 rounded-lg p-4 ${e.eventType === 'BYPASS_DEVIATION' ? 'border-red-500' : 'border-cyan-600'}`}>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-slate-800">{e.eventType.replace(/_/g, ' ')}</span>
                <span className="text-xs text-slate-400">{formatDateTime(e.performedAt)}</span>
              </div>
              {(e.fromState || e.toState) && (
                <div className="text-sm text-slate-600">
                  {e.fromState ? e.fromState.replace(/_/g, ' ') : (e.toState ? 'To Be Cleaned' : '')} {e.toState && '→'} <span className="text-cyan-600">{e.toState?.replace(/_/g, ' ')}</span>
                </div>
              )}
              {e.remarks && <div className="text-sm text-slate-400 mt-1 italic">{e.remarks}</div>}
              <div className="text-xs text-slate-300 mt-1 font-mono">Checksum: {e.checksum?.slice(0, 16)}...</div>
            </div>
          ))}
          {(events?.data ?? []).length === 0 && <div className="text-center py-8 text-slate-400">No events recorded</div>}
        </div>
      )}

      {tab === 'cycles' && (
        <div className="overflow-x-auto">
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-slate-200 text-slate-500 text-sm">
                {traceHead.map((h, i) => (
                  <th key={i} className="py-3 px-4">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {(cycles?.data ?? []).map((c) => (
                <tr key={c.id} className="border-b border-slate-200 hover:bg-slate-50">
                  <td className="py-3 px-4 font-mono text-cyan-600 text-sm">{c.cycleCode}</td>
                  <td className="py-3 px-4 text-slate-600 text-sm">{c.cleaningReasonLabel}</td>
                  <td className="py-3 px-4">
                    <span className={`px-2 py-0.5 text-xs rounded-full ${c.status === 'COMPLETED' ? 'bg-green-50 text-green-700' : c.status === 'IN_PROGRESS' ? 'bg-blue-50 text-blue-700' : 'bg-red-50 text-red-700'}`}>
                      {c.status}
                    </span>
                  </td>
                  <td className="py-3 px-4 text-slate-500 text-sm">{formatDate(c.startedAt)}</td>
                  <td className="py-3 px-4 text-slate-500 text-sm">{c.completedAt ? formatDate(c.completedAt) : '-'}</td>
                  <td className="py-3 px-4 text-slate-500">#{c.sequenceNumber}</td>
                </tr>
              ))}
              {(cycles?.data ?? []).length === 0 && <tr><td colSpan={6} className="py-8 text-center text-slate-400">No cycles</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'deviations' && (
        <div className="space-y-2">
          {(deviations?.data ?? []).map((e) => (
            <div key={e.id} className="bg-white border-l-4 border-red-500 rounded-lg p-4">
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm font-semibold text-red-700">BYPASS DEVIATION</span>
                <span className="text-xs text-slate-400">{formatDateTime(e.performedAt)}</span>
              </div>
              <div className="text-sm text-slate-600">
                {e.fromState?.replace(/_/g, ' ')} → <span className="text-red-600">{e.toState?.replace(/_/g, ' ')}</span>
              </div>
              {e.remarks && <div className="text-sm text-slate-500 mt-1">{e.remarks}</div>}
              {e.deviationDetails && (
                <div className="mt-2 px-3 py-2 bg-red-50 rounded text-xs text-red-700">
                  {JSON.stringify(e.deviationDetails)}
                </div>
              )}
            </div>
          ))}
          {(deviations?.data ?? []).length === 0 && <div className="text-center py-8 text-slate-400">No deviations recorded</div>}
        </div>
      )}
      </ReportPageWrapper>

      {/* Pagination */}
      {(currentData?.total ?? 0) > 0 && (
        <div className="bg-white rounded-xl border border-slate-200">
          <Pagination
            page={page}
            pageSize={perPage}
            totalItems={currentData?.total ?? 0}
            onPageChange={setPage}
            onPageSizeChange={setPerPage}
            pageSizeOptions={paginationOptions}
          />
        </div>
      )}
    </div>
  );
}
