import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { apiClient, api } from '../../lib/api-client';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useDatetimeFormat } from '../../hooks/use-datetime-format';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function PmScheduleDetailPage() {
  const { formatDateTime, formatDate } = useDatetimeFormat();
  const { entityId } = useParams<{ entityId: string }>();
  const [year, setYear] = useState(new Date().getFullYear());
  const { data: schedule, isLoading } = useSWR(entityId ? `/api/pm-schedules/${entityId}?year=${year}` : null);
  const [starting, setStarting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reauth = useReauth();

  // Audit 2026-05-09 fix: starting a PM creates the immutable PmExecution
  // row — comparable to start-cycle which IS reauth-gated. Backend mirror
  // in execution-routes.ts.
  const startPm = (entryId: string) => {
    setStarting(entryId);
    const body = { scheduleEntryId: entryId, entityId };
    reauth.execute(
      'START_PM_TASK',
      async (password?: string) => {
        if (password) await api.postWithReauth('/api/pm-executions', body, password);
        else await apiClient.post('/api/pm-executions', body);
      },
      {
        onSuccess: () => { mutate(`/api/pm-schedules/${entityId}?year=${year}`); setStarting(null); },
        onError: (e: any) => { setError(e.message || 'Failed to start PM'); setStarting(null); },
      },
    );
  };

  if (isLoading) return <div className="flex justify-center py-24"><div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" /></div>;

  return (
    <div className="p-6 space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Dismiss error" className="text-red-600 hover:text-red-600 ml-4">&times;</button>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800">PM Schedule</h1>
        <div className="flex items-center gap-3">
          <button onClick={() => setYear(y => y - 1)} aria-label="Previous year" className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg">←</button>
          <span className="text-lg font-semibold text-slate-800">{year}</span>
          <button onClick={() => setYear(y => y + 1)} aria-label="Next year" className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg">→</button>
        </div>
      </div>

      {!schedule ? (
        <div className="bg-white border border-slate-200 rounded-xl p-8 text-center">
          <p className="text-slate-500">No PM schedule exists for {year}.</p>
          <p className="text-xs text-slate-400 mt-2">Schedules are created by uploading a CSV/XLSX from the PM Schedules list (entries are routed to QA for approval).</p>
          <Link
            to="/pm-schedules"
            className="inline-flex items-center gap-2 mt-4 px-4 py-2 bg-cyan-600 text-white rounded-lg hover:bg-cyan-500 transition-colors"
          >
            Go to PM Schedules
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7m0 0l-7 7m7-7H3" />
            </svg>
          </Link>
        </div>
      ) : (
        <>
          <div className="flex items-center gap-4 text-sm text-slate-500">
            <span>Version: <span className="text-slate-700">v{schedule.version}</span></span>
            <span className={`px-2 py-0.5 text-xs rounded-full ${schedule.status === 'ACTIVE' ? 'bg-green-50 text-green-700' : 'bg-slate-100 text-slate-500'}`}>{schedule.status}</span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
            {(schedule.entries ?? []).map((entry: any) => {
              const exec = entry.execution;
              const now = new Date();
              const windowEnd = new Date(entry.windowEnd);
              const windowStart = new Date(entry.windowStart);
              const isOverdue = !exec && now > windowEnd;
              const isDue = !exec && now >= windowStart && now <= windowEnd;
              const isCompleted = exec?.status === 'COMPLETED';
              const isInProgress = exec?.status === 'IN_PROGRESS';

              return (
                <div key={entry.id} className={`bg-white border rounded-xl p-4 ${isOverdue ? 'border-red-600' : isDue ? 'border-amber-600' : isCompleted ? 'border-green-600' : isInProgress ? 'border-blue-600' : 'border-slate-200'}`}>
                  <div className="flex items-center justify-between mb-3">
                    <span className="text-lg font-semibold text-slate-800">{MONTHS[entry.month - 1]}</span>
                    {isCompleted && <span className="px-2 py-0.5 text-xs bg-green-50 text-green-700 rounded-full">Completed</span>}
                    {isInProgress && <span className="px-2 py-0.5 text-xs bg-blue-50 text-blue-700 rounded-full">In Progress</span>}
                    {isOverdue && <span className="px-2 py-0.5 text-xs bg-red-50 text-red-700 rounded-full">Overdue</span>}
                    {isDue && <span className="px-2 py-0.5 text-xs bg-amber-50 text-amber-700 rounded-full">Due</span>}
                  </div>
                  <div className="text-sm text-slate-500 space-y-1">
                    <div>Planned: <span className="text-slate-600">{formatDate(entry.plannedDate)}</span></div>
                    <div>Window: <span className="text-slate-600">{formatDate(entry.windowStart)} - {formatDate(entry.windowEnd)}</span></div>
                    <div>Tolerance: <span className="text-slate-600">{entry.toleranceDays} days</span></div>
                  </div>
                  {exec && (
                    <div className="mt-2 pt-2 border-t border-slate-200 text-sm text-slate-500">
                      {exec.startedAt && <div>Started: {formatDateTime(exec.startedAt)}</div>}
                      {exec.completedAt && <div>Done: {formatDateTime(exec.completedAt)}</div>}
                      {exec.isWithinWindow === false && <span className="text-xs text-amber-600">Out of window</span>}
                    </div>
                  )}
                  {!exec && (isDue || isOverdue) && (
                    <button onClick={() => startPm(entry.id)} disabled={starting === entry.id}
                      className="mt-3 w-full py-2 bg-cyan-600 text-white rounded-lg text-sm hover:bg-cyan-500 disabled:opacity-50">
                      {starting === entry.id ? 'Starting...' : 'Start PM'}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setStarting(null); }}
        actionLabel="Start PM Task"
      />
    </div>
  );
}
