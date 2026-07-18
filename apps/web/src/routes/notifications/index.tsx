import { useState, useEffect } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { apiClient } from '@/lib/api-client';
import { api } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useCan } from '@/hooks/use-can';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { usePaginationConfig } from '@/hooks/use-pagination-config';
import { Pagination } from '@/components/ui/pagination';

interface Notification {
  id: string;
  type: string;
  title: string;
  message: string;
  targetUserId?: string;
  isRead: boolean;
  readAt?: string;
  createdAt: string;
  createdBy?: string;
}

const typeColors: Record<string, string> = {
  ACCOUNT_LOCKED: 'bg-gradient-to-r from-red-500 to-rose-500 text-white',
  ACCOUNT_DISABLED: 'bg-gradient-to-r from-orange-500 to-amber-500 text-white',
  ACCOUNT_ENABLED: 'bg-gradient-to-r from-emerald-500 to-teal-500 text-white',
  PASSWORD_RESET_REQUEST: 'bg-gradient-to-r from-amber-500 to-yellow-500 text-white',
  PASSWORD_RESET_APPROVED: 'bg-gradient-to-r from-green-500 to-emerald-500 text-white',
  PASSWORD_RESET_REJECTED: 'bg-gradient-to-r from-red-500 to-pink-500 text-white',
  USER_CREATED: 'bg-gradient-to-r from-blue-500 to-indigo-500 text-white',
  USER_UPDATED: 'bg-gradient-to-r from-purple-500 to-violet-500 text-white',
  ROLE_CHANGED: 'bg-gradient-to-r from-indigo-500 to-purple-500 text-white',
  PASSWORD_EXPIRY_WARNING: 'bg-gradient-to-r from-amber-500 to-orange-500 text-white',
  PASSWORD_EXPIRED_NOTICE: 'bg-gradient-to-r from-red-500 to-rose-500 text-white',
};

const typeIcons: Record<string, React.ReactNode> = {
  ACCOUNT_LOCKED: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
    </svg>
  ),
  ACCOUNT_DISABLED: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
    </svg>
  ),
  ACCOUNT_ENABLED: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  PASSWORD_RESET_REQUEST: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
    </svg>
  ),
  PASSWORD_RESET_APPROVED: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
    </svg>
  ),
  PASSWORD_RESET_REJECTED: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
    </svg>
  ),
  USER_CREATED: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
    </svg>
  ),
  USER_UPDATED: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
    </svg>
  ),
  ROLE_CHANGED: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
    </svg>
  ),
  PASSWORD_EXPIRY_WARNING: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
    </svg>
  ),
  PASSWORD_EXPIRED_NOTICE: (
    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01M5.07 19H18.93a2 2 0 001.74-3L13.74 4a2 2 0 00-3.48 0L3.34 16a2 2 0 001.73 3z" />
    </svg>
  ),
};

export function NotificationsPage() {
  const can = useCan();
  const { formatDate: fmtDate } = useDatetimeFormat();
  const paginationOptions = usePaginationConfig();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(paginationOptions[0]);
  const [period, setPeriod] = useState('all');
  const [readFilter, setReadFilter] = useState('');
  const { mutate: globalMutate } = useSWRConfig();
  const { toast } = useToast();
  // 2026-05-26 audit fix (PA-REAUTH-4): wrap bulk + single delete
  // mutations in reauth.execute so the FE matches the BE enforceReauth
  // gate on BULK_DELETE_NOTIFICATIONS / DELETE_NOTIFICATION.
  const reauth = useReauth();

  // Selection state
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  const params = new URLSearchParams({ page: String(page), limit: String(perPage) });
  if (period && period !== 'all') params.set('period', period);
  if (readFilter) params.set('isRead', readFilter);

  const { data, mutate } = useSWR(`/api/notifications?${params}`);

  // Clear selection on page/filter change
  useEffect(() => {
    setSelectedIds(new Set());
  }, [page, period, readFilter]);

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (!data?.data) return;
    const allIds = data.data.map((n: Notification) => n.id);
    const allSelected = allIds.every((id: string) => selectedIds.has(id));
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allIds));
    }
  };

  const isAllSelected = data?.data?.length > 0 && data.data.every((n: Notification) => selectedIds.has(n.id));
  const isSomeSelected = selectedIds.size > 0;

  const markAsRead = async (id: string) => {
    try {
      await apiClient.put(`/api/notifications/${id}/read`, {});
      mutate();
      globalMutate('/api/notifications/unread-count');
    } catch (err: any) {
      toast.error('Failed to mark as read', err.message || 'Operation failed');
    }
  };

  const markAsUnread = async (id: string) => {
    try {
      await apiClient.put(`/api/notifications/${id}/unread`, {});
      mutate();
      globalMutate('/api/notifications/unread-count');
    } catch (err: any) {
      toast.error('Failed to mark as unread', err.message || 'Operation failed');
    }
  };

  const markAllAsRead = async () => {
    try {
      await apiClient.put('/api/notifications/mark-all-read', {});
      mutate();
      globalMutate('/api/notifications/unread-count');
    } catch (err: any) {
      toast.error('Failed to mark all as read', err.message || 'Operation failed');
    }
  };

  const bulkMarkRead = async () => {
    try {
      await apiClient.put('/api/notifications/bulk-read', { ids: Array.from(selectedIds) });
      setSelectedIds(new Set());
      mutate();
      globalMutate('/api/notifications/unread-count');
    } catch (err: any) {
      toast.error('Failed to bulk mark as read', err.message || 'Operation failed');
    }
  };

  const bulkMarkUnread = async () => {
    try {
      await apiClient.put('/api/notifications/bulk-unread', { ids: Array.from(selectedIds) });
      setSelectedIds(new Set());
      mutate();
      globalMutate('/api/notifications/unread-count');
    } catch (err: any) {
      toast.error('Failed to bulk mark as unread', err.message || 'Operation failed');
    }
  };

  const bulkDelete = async () => {
    await reauth.execute(
      'BULK_DELETE_NOTIFICATIONS',
      async (password?: string) => {
        const body = { ids: Array.from(selectedIds) };
        if (password) {
          await api.postWithReauth('/api/notifications/bulk-delete', body, password);
        } else {
          await apiClient.post('/api/notifications/bulk-delete', body);
        }
      },
      {
        onSuccess: () => {
          setSelectedIds(new Set());
          setShowDeleteConfirm(false);
          mutate();
          globalMutate('/api/notifications/unread-count');
        },
        onError: (err: any) => {
          toast.error('Failed to delete notifications', err.message || 'Operation failed');
        },
      },
    );
  };

  const deleteSingle = async (id: string) => {
    await reauth.execute(
      'DELETE_NOTIFICATION',
      async (password?: string) => {
        if (password) {
          await api.deleteWithReauth(`/api/notifications/${id}`, password);
        } else {
          await apiClient.delete(`/api/notifications/${id}`);
        }
      },
      {
        onSuccess: () => {
          setSelectedIds(prev => {
            const next = new Set(prev);
            next.delete(id);
            return next;
          });
          mutate();
          globalMutate('/api/notifications/unread-count');
        },
        onError: (err: any) => {
          toast.error('Failed to delete notification', err.message || 'Operation failed');
        },
      },
    );
  };

  const formatDate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return fmtDate(date);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-2xl shadow-lg" style={{ backgroundImage: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">Notifications</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {data?.unreadCount > 0 ? (
                <span className="text-amber-600 font-medium">{data.unreadCount} unread notification{data.unreadCount > 1 ? 's' : ''}</span>
              ) : (
                'All caught up!'
              )}
            </p>
          </div>
        </div>
        {data?.unreadCount > 0 && can('notifications.mark') && (
          <Button
            onClick={markAllAsRead}
            variant="outline"
            className="gap-2 border-amber-200 text-amber-700 hover:bg-amber-50"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
            Mark All as Read
          </Button>
        )}
      </div>

      {/* Selection Toolbar */}
      {isSomeSelected && (
        <div className="bg-white rounded-2xl border-2 border-indigo-200 shadow-xl p-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-indigo-100">
              <svg className="w-4 h-4 text-indigo-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <span className="text-sm font-semibold text-slate-700">{selectedIds.size} selected</span>
            <button onClick={() => setSelectedIds(new Set())} className="text-xs text-slate-500 hover:text-slate-700 underline">
              Clear Selection
            </button>
          </div>
          <div className="flex items-center gap-2">
            {can('notifications.mark') && (
              <Button variant="outline" size="sm" onClick={bulkMarkRead} className="gap-1.5 text-green-700 border-green-200 hover:bg-green-50">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Mark Read
              </Button>
            )}
            {can('notifications.mark') && (
              <Button variant="outline" size="sm" onClick={bulkMarkUnread} className="gap-1.5 text-amber-700 border-amber-200 hover:bg-amber-50">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                Mark Unread
              </Button>
            )}
            {can('notifications.delete') && (
              <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(true)} className="gap-1.5 text-red-700 border-red-200 hover:bg-red-50">
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Delete Selected
              </Button>
            )}
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="bg-white rounded-2xl border border-slate-200/60 shadow-xl shadow-slate-200/40 p-6">
        <div className="flex items-center gap-2 mb-4">
          <div className="p-2 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500">
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
            </svg>
          </div>
          <span className="font-semibold text-slate-700">Filter Notifications</span>
          {(period !== 'all' || readFilter) && (
            <span className="ml-2 px-2 py-0.5 text-xs font-medium bg-amber-100 text-amber-700 rounded-full">
              {[period !== 'all' ? 1 : 0, readFilter ? 1 : 0].reduce((a, b) => a + b, 0)} active
            </span>
          )}
        </div>
        <div className="flex flex-wrap gap-4">
          <div className="min-w-[200px]">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Time Period</label>
            <div className="relative group">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg bg-gradient-to-br from-blue-100 to-indigo-100 z-10 pointer-events-none">
                <svg className="w-4 h-4 text-indigo-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
              </div>
              <Select
                value={period}
                onChange={(e) => { setPeriod(e.target.value); setPage(1); }}
                variant="filled"
                className="pl-12 h-11"
              >
                <option value="all">All Time</option>
                <option value="today">Today</option>
                <option value="week">Last 7 Days</option>
                <option value="month">This Month</option>
                <option value="quarter">Last 90 Days</option>
                <option value="year">This Year</option>
              </Select>
            </div>
          </div>
          <div className="min-w-[180px]">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-2 block">Status</label>
            <div className="relative group">
              <div className="absolute left-3 top-1/2 -translate-y-1/2 p-1.5 rounded-lg bg-gradient-to-br from-amber-100 to-orange-100 z-10 pointer-events-none">
                <svg className="w-4 h-4 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                </svg>
              </div>
              <Select
                value={readFilter}
                onChange={(e) => { setReadFilter(e.target.value); setPage(1); }}
                variant="filled"
                className="pl-12 h-11"
              >
                <option value="">All</option>
                <option value="false">Unread</option>
                <option value="true">Read</option>
              </Select>
            </div>
          </div>
          {(period !== 'all' || readFilter) && (
            <div className="flex items-end">
              <Button
                variant="outline"
                onClick={() => {
                  setPeriod('all');
                  setReadFilter('');
                  setPage(1);
                }}
                className="h-11 gap-2 text-red-600 border-red-200 hover:bg-red-50 hover:border-red-300"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                </svg>
                Clear All
              </Button>
            </div>
          )}
        </div>
        {/* Active filters display */}
        {(period !== 'all' || readFilter) && (
          <div className="flex flex-wrap items-center gap-2 mt-4 pt-4 border-t border-slate-100">
            <span className="text-xs font-medium text-slate-500">Active filters:</span>
            {period !== 'all' && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-indigo-50 text-indigo-700 rounded-full text-xs font-medium">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" />
                </svg>
                {period === 'today' ? 'Today' : period === 'week' ? 'Last 7 Days' : period === 'month' ? 'This Month' : period === 'quarter' ? 'Last 90 Days' : 'This Year'}
                <button onClick={() => { setPeriod('all'); setPage(1); }} className="hover:text-indigo-900">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            )}
            {readFilter && (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 bg-amber-50 text-amber-700 rounded-full text-xs font-medium">
                <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                </svg>
                {readFilter === 'false' ? 'Unread' : 'Read'}
                <button onClick={() => { setReadFilter(''); setPage(1); }} className="hover:text-amber-900">
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </span>
            )}
          </div>
        )}
      </div>

      {/* Select All toggle */}
      {data?.data?.length > 0 && (
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 cursor-pointer group">
            <input
              type="checkbox"
              checked={isAllSelected}
              onChange={toggleSelectAll}
              className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
            />
            <span className="text-sm font-medium text-slate-600 group-hover:text-slate-800">
              Select All on Page
            </span>
          </label>
          {isSomeSelected && (
            <span className="text-xs text-slate-400">({selectedIds.size} selected)</span>
          )}
        </div>
      )}

      {/* Notifications List */}
      <div className="space-y-3">
        {data?.data?.map((notification: Notification) => {
          const isSelected = selectedIds.has(notification.id);
          return (
          <div
            key={notification.id}
            className={`bg-white rounded-2xl border shadow-sm p-5 transition-all hover:shadow-md ${
              isSelected
                ? 'border-indigo-300 bg-indigo-50/30 ring-1 ring-indigo-200'
                : notification.isRead
                  ? 'border-slate-200/60 opacity-75'
                  : 'border-amber-200 shadow-amber-100/50'
            }`}
          >
            <div className="flex items-start gap-4">
              {/* Checkbox */}
              <div className="flex-shrink-0 pt-1">
                <input
                  type="checkbox"
                  checked={isSelected}
                  onChange={() => toggleSelect(notification.id)}
                  className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 cursor-pointer"
                />
              </div>
              <div className={`p-3 rounded-xl ${typeColors[notification.type] ?? 'bg-slate-500 text-white'} shadow-lg`}>
                {typeIcons[notification.type] ?? (
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className={`font-semibold ${notification.isRead ? 'text-slate-600' : 'text-slate-800'}`}>
                        {notification.title}
                      </h3>
                      {!notification.isRead && (
                        <span className="w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                      )}
                    </div>
                    <p className={`text-sm mt-1 whitespace-pre-line ${notification.isRead ? 'text-slate-400' : 'text-slate-600'}`}>
                      {notification.message}
                    </p>
                    <div className="flex items-center gap-4 mt-3">
                      <Badge variant="outline" className="text-xs">
                        {notification.type.replace(/_/g, ' ')}
                      </Badge>
                      {notification.targetUserId && (
                        <span className="text-xs text-slate-400 font-mono">
                          @{notification.targetUserId}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-col items-end gap-2 shrink-0">
                    <span className="text-xs text-slate-400">{formatDate(notification.createdAt)}</span>
                    <div className="flex items-center gap-1">
                      {can('notifications.mark') && (!notification.isRead ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => markAsRead(notification.id)}
                          className="text-xs text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                        >
                          Mark Read
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => markAsUnread(notification.id)}
                          className="text-xs text-slate-500 hover:text-slate-700 hover:bg-slate-50"
                        >
                          Mark Unread
                        </Button>
                      ))}
                      {can('notifications.delete') && (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => deleteSingle(notification.id)}
                          className="text-xs text-red-500 hover:text-red-700 hover:bg-red-50"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
          );
        })}

        {/* Empty State */}
        {(!data?.data || data.data.length === 0) && (
          <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-16 text-center">
            <div className="flex flex-col items-center gap-4">
              <div className="p-4 rounded-2xl bg-slate-100">
                <svg className="w-10 h-10 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
                </svg>
              </div>
              <div>
                <p className="text-slate-600 font-semibold">No notifications found</p>
                <p className="text-sm text-slate-400 mt-1">
                  {readFilter === 'false' ? 'You\'re all caught up!' : 'Try adjusting your filters'}
                </p>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Pagination */}
      {data && data.total > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm">
          <Pagination
            page={page}
            pageSize={perPage}
            totalItems={data.total}
            onPageChange={setPage}
            onPageSizeChange={setPerPage}
            pageSizeOptions={paginationOptions}
          />
        </div>
      )}

      {/* Bulk Delete Confirmation Dialog */}
      <Dialog open={showDeleteConfirm} onClose={() => setShowDeleteConfirm(false)} className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-red-100 text-red-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            Delete Notifications
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Are you sure you want to permanently delete <span className="font-semibold text-red-700">{selectedIds.size}</span> notification{selectedIds.size > 1 ? 's' : ''}? This action cannot be undone.
          </p>
          <div className="flex items-center justify-end gap-3">
            <Button variant="outline" size="sm" onClick={() => setShowDeleteConfirm(false)}>
              Cancel
            </Button>
            <Button size="sm" onClick={bulkDelete} className="bg-red-600 hover:bg-red-700 text-white">
              Delete {selectedIds.size} Notification{selectedIds.size > 1 ? 's' : ''}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* 2026-05-26 PA-REAUTH-4: prompt for password before notification
          delete (single or bulk) when the role requires reauth for it. */}
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
      />
    </div>
  );
}
