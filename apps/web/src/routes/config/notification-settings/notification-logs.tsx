import { useState } from 'react';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { Input } from '@/components/ui/input';
import { Pagination } from '@/components/ui/pagination';
import { useDatetimeFormat } from '../../../hooks/use-datetime-format';
import { usePaginationConfig } from '../../../hooks/use-pagination-config';
import { Button } from '@/components/ui/button';
import { PageHeader } from '@/components/ui/page-header';
import { EmptyState } from '@/components/ui/empty-state';

interface LogEntry {
  id: string;
  channel: string;
  recipient: string;
  subject: string | null;
  message: string;
  status: string;
  retryCount: number;
  errorMessage: string | null;
  triggeredBy: string | null;
  createdAt: string;
  sentAt: string | null;
}

const STATUS_COLORS: Record<string, string> = {
  SENT: 'bg-green-100 text-green-700',
  DELIVERED: 'bg-green-100 text-green-700',
  PENDING: 'bg-yellow-100 text-yellow-700',
  RETRYING: 'bg-orange-100 text-orange-700',
  FAILED: 'bg-red-100 text-red-700',
};

const CHANNEL_COLORS: Record<string, string> = {
  EMAIL: 'bg-blue-100 text-blue-700',
  SMS: 'bg-purple-100 text-purple-700',
};

export function NotificationLogsPage() {
  const { formatDateTime } = useDatetimeFormat();
  const paginationOptions = usePaginationConfig();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(paginationOptions[0]);
  const [channel, setChannel] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const queryParams = new URLSearchParams({ page: String(page), limit: String(perPage) });
  if (channel) queryParams.set('channel', channel);
  if (status) queryParams.set('status', status);
  if (search) queryParams.set('search', search);

  const { data, mutate } = useSWR(`/api/notification-settings/logs?${queryParams}`);
  const { data: stats } = useSWR('/api/notification-settings/logs/stats');

  const logs: LogEntry[] = data?.data ?? [];
  const total = data?.total ?? 0;

  const handleDelete = async (id: string) => {
    try {
      await apiClient.delete(`/api/notification-settings/logs/${id}`);
      mutate();
    } catch { /* ignore */ }
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <PageHeader
          title='Notification Logs'
          description='View email and SMS delivery history'
          crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Notification Logs' }]}
          icon={
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
          }
        />
      </div>

      {/* Stats */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
          <div className="bg-white rounded-xl border border-slate-200 p-4 text-center">
            <div className="text-2xl font-bold text-slate-800">{stats.total}</div>
            <div className="text-xs text-slate-500">Total</div>
          </div>
          <div className="bg-white rounded-xl border border-green-200 p-4 text-center">
            <div className="text-2xl font-bold text-green-600">{stats.email?.sent ?? 0}</div>
            <div className="text-xs text-slate-500">Emails Sent</div>
          </div>
          <div className="bg-white rounded-xl border border-red-200 p-4 text-center">
            <div className="text-2xl font-bold text-red-600">{stats.email?.failed ?? 0}</div>
            <div className="text-xs text-slate-500">Emails Failed</div>
          </div>
          <div className="bg-white rounded-xl border border-green-200 p-4 text-center">
            <div className="text-2xl font-bold text-green-600">{stats.sms?.sent ?? 0}</div>
            <div className="text-xs text-slate-500">SMS Sent</div>
          </div>
          <div className="bg-white rounded-xl border border-red-200 p-4 text-center">
            <div className="text-2xl font-bold text-red-600">{stats.sms?.failed ?? 0}</div>
            <div className="text-xs text-slate-500">SMS Failed</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 p-4 shadow-[var(--elev-1)]">
        <div className="flex flex-wrap gap-3 items-end">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-xs font-medium text-slate-600 mb-1">Search</label>
            <Input
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              placeholder="Search by recipient or subject..."
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Channel</label>
            <select
              value={channel}
              onChange={(e) => { setChannel(e.target.value); setPage(1); }}
              className="ctl"
            >
              <option value="">All</option>
              <option value="EMAIL">Email</option>
              <option value="SMS">SMS</option>
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Status</label>
            <select
              value={status}
              onChange={(e) => { setStatus(e.target.value); setPage(1); }}
              className="ctl"
            >
              <option value="">All</option>
              <option value="SENT">Sent</option>
              <option value="FAILED">Failed</option>
              <option value="PENDING">Pending</option>
              <option value="RETRYING">Retrying</option>
            </select>
          </div>
        </div>
      </div>

      {/* Table */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200 shadow-[var(--elev-1)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="tbl w-full text-sm">
            <thead className="bg-slate-50 border-b border-slate-200">
              <tr>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Channel</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Recipient</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Subject</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Status</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Triggered By</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Time</th>
                <th className="text-left px-4 py-3 font-medium text-slate-600">Actions</th>
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-2"><EmptyState compact title="No notification logs found" /></td></tr>
              )}
              {logs.map((log) => (
                <tr key={log.id} className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setExpandedId(expandedId === log.id ? null : log.id)}>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${CHANNEL_COLORS[log.channel] ?? 'bg-slate-100 text-slate-600'}`}>{log.channel}</span>
                  </td>
                  <td className="px-4 py-3 text-slate-700 max-w-[200px] truncate">{log.recipient}</td>
                  <td className="px-4 py-3 text-slate-600 max-w-[200px] truncate">{log.subject ?? '-'}</td>
                  <td className="px-4 py-3">
                    <span className={`px-2 py-1 rounded-full text-xs font-medium ${STATUS_COLORS[log.status] ?? 'bg-slate-100'}`}>{log.status}</span>
                    {log.retryCount > 0 && <span className="ml-1 text-xs text-slate-400">(retry {log.retryCount})</span>}
                  </td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{log.triggeredBy ?? '-'}</td>
                  <td className="px-4 py-3 text-slate-500 text-xs">{formatDateTime(log.createdAt)}</td>
                  <td className="px-4 py-3">
                    <Button variant="ghost" size="sm"
                      onClick={(e) => { e.stopPropagation(); handleDelete(log.id); }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
              {logs.map((log) => expandedId === log.id && (
                <tr key={`${log.id}-detail`} className="bg-slate-50">
                  <td colSpan={7} className="px-6 py-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
                      <div>
                        <strong className="text-slate-600">Message:</strong>
                        <div className="mt-1 p-3 bg-white rounded-lg border text-slate-700 max-h-40 overflow-y-auto text-xs" style={{ whiteSpace: 'pre-wrap' }}>{log.message || ''}</div>
                      </div>
                      {log.errorMessage && (
                        <div>
                          <strong className="text-red-600">Error:</strong>
                          <div className="mt-1 p-3 bg-red-50 rounded-lg border border-red-200 text-red-700 text-xs">{log.errorMessage}</div>
                        </div>
                      )}
                      {log.sentAt && (
                        <div><strong className="text-slate-600">Sent At:</strong> <span className="text-slate-700">{formatDateTime(log.sentAt)}</span></div>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        {total > 0 && (
          <Pagination
            page={page}
            pageSize={perPage}
            totalItems={total}
            onPageChange={setPage}
            onPageSizeChange={setPerPage}
            pageSizeOptions={paginationOptions}
            className="border-t border-slate-200"
          />
        )}
      </div>
    </div>
  );
}
