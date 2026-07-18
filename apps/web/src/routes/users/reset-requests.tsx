import { useState } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardHeader, CardTitle, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { type PasswordPolicyConfig } from '@digilog/shared';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { generatePassword, DEFAULT_PASSWORD_POLICY } from '../../lib/password-utils';
import { CLIPBOARD_COPY_RESET_MS } from '@/lib/timing-constants';

interface ResetRequest {
  id: string;
  userId: string;
  userFullName?: string;
  userEmail?: string;
  userDepartment?: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED';
  requestedAt: string;
  processedAt?: string;
  processedBy?: string;
  notes?: string;
}

export function ResetRequestsPage() {
  const { formatDate, formatTime, formatDateTime } = useDatetimeFormat();
  const reauth = useReauth();
  const { data, mutate } = useSWR<{ data: ResetRequest[] }>('/api/users/reset-requests');
  const { data: policyData } = useSWR<PasswordPolicyConfig>('/api/config/password-policy', { revalidateOnMount: true, dedupingInterval: 5000 });
  const policy = { ...DEFAULT_PASSWORD_POLICY, ...policyData };

  const [selectedRequest, setSelectedRequest] = useState<ResetRequest | null>(null);
  const [actionDialog, setActionDialog] = useState<'approve' | 'reject' | null>(null);
  const [newPassword, setNewPassword] = useState('');
  const [notes, setNotes] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  const pendingRequests = data?.data.filter(r => r.status === 'PENDING') ?? [];
  const processedRequests = data?.data.filter(r => r.status !== 'PENDING') ?? [];

  const openApproveDialog = (request: ResetRequest) => {
    setSelectedRequest(request);
    setActionDialog('approve');
    const pwd = generatePassword(policy);
    setNewPassword(pwd);
    setNotes('');
    setShowPassword(false);
    setCopied(false);
    setError('');
  };

  const openRejectDialog = (request: ResetRequest) => {
    setSelectedRequest(request);
    setActionDialog('reject');
    setNotes('');
    setError('');
  };

  const closeDialog = () => {
    setSelectedRequest(null);
    setActionDialog(null);
    setNewPassword('');
    setNotes('');
    setError('');
  };

  const regeneratePassword = () => {
    const pwd = generatePassword(policy);
    setNewPassword(pwd);
    setCopied(false);
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(newPassword);
      setCopied(true);
      setTimeout(() => setCopied(false), CLIPBOARD_COPY_RESET_MS);
    } catch {
      const textArea = document.createElement('textarea');
      textArea.value = newPassword;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      setCopied(true);
      setTimeout(() => setCopied(false), CLIPBOARD_COPY_RESET_MS);
    }
  };

  const handleProcess = async () => {
    if (!selectedRequest || !actionDialog) return;

    setError('');
    setIsProcessing(true);

    const body = {
      action: actionDialog,
      newPassword: actionDialog === 'approve' ? newPassword : undefined,
      notes: notes || undefined,
    };

    try {
      await reauth.execute(
        'PROCESS_RESET_REQUEST',
        async (password?: string) => {
          if (password) {
            await apiClient.postWithReauth(`/api/users/reset-requests/${selectedRequest.id}/process`, body, password);
          } else {
            await apiClient.post(`/api/users/reset-requests/${selectedRequest.id}/process`, body);
          }
        },
        {
          onSuccess: () => {
            setSuccessMessage(
              actionDialog === 'approve'
                ? `Password reset approved for ${selectedRequest.userId}. Make sure to share the temporary password securely.`
                : `Password reset request rejected for ${selectedRequest.userId}.`
            );
            closeDialog();
            mutate();
            setIsProcessing(false);
          },
          onError: (err: any) => {
            setError(err.message || 'Failed to process request');
            setIsProcessing(false);
          },
          // M64: cancelling the password prompt left this dialog wedged on
          // 'Processing…'. Unwind silently — the operator chose to back out.
          onCancel: () => setIsProcessing(false),
        },
      );
    } catch (err: any) {
      setError(err.message || 'Failed to process request');
      setIsProcessing(false);
    }
  };

  const getStatusBadge = (status: string) => {
    switch (status) {
      case 'PENDING':
        return <Badge className="bg-gradient-to-r from-amber-400 to-orange-400 text-white border-0 shadow-sm">Pending</Badge>;
      case 'APPROVED':
        return <Badge className="bg-gradient-to-r from-emerald-400 to-teal-400 text-white border-0 shadow-sm">Approved</Badge>;
      case 'REJECTED':
        return <Badge className="bg-gradient-to-r from-red-400 to-rose-400 text-white border-0 shadow-sm">Rejected</Badge>;
      default:
        return <Badge variant="outline">{status}</Badge>;
    }
  };

  return (
    <div className="space-y-8 animate-fade-in">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-amber-500 to-orange-500 shadow-lg shadow-amber-500/20">
              <svg className="w-6 h-6 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
              </svg>
            </div>
            <div>
              <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">Password Reset Requests</h1>
              <p className="text-sm text-slate-500 mt-0.5">Review and process password reset requests from users</p>
            </div>
          </div>
        </div>
        <Link to="/users">
          <Button variant="outline" className="gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 19l-7-7m0 0l7-7m-7 7h18" />
            </svg>
            Back to Users
          </Button>
        </Link>
      </div>

      {/* Success Message */}
      {successMessage && (
        <div className="flex items-center gap-3 rounded-2xl bg-gradient-to-r from-emerald-50 to-teal-50 border border-emerald-200/60 p-4 shadow-sm">
          <div className="p-2 rounded-xl bg-emerald-100">
            <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-sm text-emerald-700 flex-1">{successMessage}</p>
          <button
            className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-100 transition-colors"
            onClick={() => setSuccessMessage('')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}

      {/* Pending Requests */}
      <div className="bg-white rounded-2xl border border-slate-200/60 shadow-xl shadow-slate-200/40 overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-100">
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <div className="flex items-center gap-3">
              <h2 className="text-lg font-semibold text-slate-800">Pending Requests</h2>
              {pendingRequests.length > 0 && (
                <span className="px-2.5 py-1 text-xs font-bold rounded-full bg-gradient-to-r from-amber-500 to-orange-500 text-white shadow-sm">
                  {pendingRequests.length}
                </span>
              )}
            </div>
          </div>
        </div>
        <div className="p-6">
          {pendingRequests.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <p className="text-slate-600 font-medium">All caught up!</p>
              <p className="text-sm text-slate-400 mt-1">No pending password reset requests</p>
            </div>
          ) : (
            <div className="space-y-4">
              {pendingRequests.map((request) => (
                <div
                  key={request.id}
                  className="group flex items-center justify-between p-5 rounded-2xl bg-gradient-to-r from-slate-50 to-white border border-slate-200/60 hover:border-amber-200 hover:shadow-lg hover:shadow-amber-100/50 transition-all duration-200"
                >
                  <div className="flex items-center gap-4">
                    <div className="w-14 h-14 rounded-2xl bg-gradient-to-br from-amber-400 to-orange-500 flex items-center justify-center shadow-lg shadow-amber-500/20">
                      <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 7a2 2 0 012 2m4 0a6 6 0 01-7.743 5.743L11 17H9v2H7v2H4a1 1 0 01-1-1v-2.586a1 1 0 01.293-.707l5.964-5.964A6 6 0 1121 9z" />
                      </svg>
                    </div>
                    <div>
                      <p className="font-semibold text-lg text-slate-800">{request.userFullName || request.userId}</p>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-slate-500 mt-1">
                        <span className="flex items-center gap-1.5">
                          <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                          </svg>
                          <span className="font-mono text-xs bg-slate-100 px-2 py-0.5 rounded">{request.userId}</span>
                        </span>
                        {request.userEmail && (
                          <span className="flex items-center gap-1.5">
                            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                            </svg>
                            {request.userEmail}
                          </span>
                        )}
                        {request.userDepartment && (
                          <span className="flex items-center gap-1.5">
                            <svg className="w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                            </svg>
                            {request.userDepartment}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-slate-400 mt-2 flex items-center gap-1.5">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        Requested {formatDateTime(request.requestedAt)}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <Button
                      size="sm"
                      variant="outline"
                      className="border-red-200 text-red-600 hover:bg-red-50 hover:border-red-300"
                      onClick={() => openRejectDialog(request)}
                    >
                      <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                      Reject
                    </Button>
                    <Button
                      size="sm"
                      className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 shadow-lg shadow-emerald-500/20"
                      onClick={() => openApproveDialog(request)}
                    >
                      <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      Approve & Reset
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Processed Requests History */}
      <div className="bg-white rounded-2xl border border-slate-200/60 shadow-xl shadow-slate-200/40 overflow-hidden">
        <div className="px-6 py-5 border-b border-slate-100 bg-gradient-to-r from-slate-50 to-white">
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-slate-100">
              <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h2 className="text-lg font-semibold text-slate-800">Request History</h2>
          </div>
        </div>
        <div className="p-6">
          {processedRequests.length === 0 ? (
            <div className="text-center py-12">
              <div className="w-16 h-16 mx-auto rounded-2xl bg-slate-100 flex items-center justify-center mb-4">
                <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                </svg>
              </div>
              <p className="text-slate-600 font-medium">No history yet</p>
              <p className="text-sm text-slate-400 mt-1">Processed requests will appear here</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100">
                    <th className="text-left py-4 px-4 font-semibold text-slate-600 text-sm">User</th>
                    <th className="text-left py-4 px-4 font-semibold text-slate-600 text-sm">Status</th>
                    <th className="text-left py-4 px-4 font-semibold text-slate-600 text-sm">Requested</th>
                    <th className="text-left py-4 px-4 font-semibold text-slate-600 text-sm">Processed</th>
                    <th className="text-left py-4 px-4 font-semibold text-slate-600 text-sm">Processed By</th>
                  </tr>
                </thead>
                <tbody>
                  {processedRequests.map((request) => (
                    <tr key={request.id} className="border-b border-slate-50 last:border-0 hover:bg-slate-50/50 transition-colors">
                      <td className="py-4 px-4">
                        <div className="flex items-center gap-3">
                          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-slate-100 to-slate-200 flex items-center justify-center text-sm font-semibold text-slate-600">
                            {(request.userFullName || request.userId).split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
                          </div>
                          <div>
                            <p className="font-medium text-slate-800">{request.userFullName || request.userId}</p>
                            {request.userFullName && <p className="text-xs text-slate-400 font-mono">{request.userId}</p>}
                          </div>
                        </div>
                      </td>
                      <td className="py-4 px-4">{getStatusBadge(request.status)}</td>
                      <td className="py-4 px-4 text-sm text-slate-500">
                        {formatDate(request.requestedAt)}
                        <span className="block text-xs text-slate-400">{formatTime(request.requestedAt)}</span>
                      </td>
                      <td className="py-4 px-4 text-sm text-slate-500">
                        {request.processedAt ? (
                          <>
                            {formatDate(request.processedAt)}
                            <span className="block text-xs text-slate-400">{formatTime(request.processedAt)}</span>
                          </>
                        ) : '-'}
                      </td>
                      <td className="py-4 px-4">
                        {request.processedBy ? (
                          <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg bg-slate-100 text-sm text-slate-600">
                            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                            </svg>
                            {request.processedBy}
                          </span>
                        ) : '-'}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* Approve Dialog */}
      <Dialog open={actionDialog === 'approve'} onClose={closeDialog}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-emerald-100">
              <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            Approve Password Reset
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="flex items-center gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center text-lg font-semibold text-slate-600">
              {(selectedRequest?.userFullName || selectedRequest?.userId || '').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
            </div>
            <div>
              <p className="font-semibold text-slate-800">{selectedRequest?.userFullName || selectedRequest?.userId}</p>
              {selectedRequest?.userFullName && <p className="text-sm text-slate-500 font-mono">{selectedRequest.userId}</p>}
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-3 rounded-xl bg-red-50 border border-red-200 p-4">
              <svg className="w-5 h-5 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-semibold text-slate-700">Temporary Password</label>
              <div className="flex gap-2">
                <Button type="button" variant="outline" size="sm" onClick={regeneratePassword} className="gap-1.5">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                  </svg>
                  Regenerate
                </Button>
                <Button type="button" variant="outline" size="sm" onClick={copyToClipboard} className="gap-1.5">
                  {copied ? (
                    <>
                      <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                      <span className="text-emerald-600">Copied!</span>
                    </>
                  ) : (
                    <>
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                      Copy
                    </>
                  )}
                </Button>
              </div>
            </div>
            <div className="relative">
              <Input
                value={newPassword}
                readOnly
                type={showPassword ? 'text' : 'password'}
                className="font-mono text-base bg-slate-50 pr-16 h-12 border-slate-200"
              />
              <button
                type="button"
                className="absolute right-4 top-1/2 -translate-y-1/2 text-sm font-medium text-slate-500 hover:text-slate-700 transition-colors"
                onClick={() => setShowPassword(!showPassword)}
              >
                {showPassword ? 'Hide' : 'Show'}
              </button>
            </div>
          </div>

          <div className="rounded-xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200/60 p-4">
            <div className="flex gap-3">
              <div className="p-2 rounded-lg bg-amber-100 h-fit">
                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
              </div>
              <div>
                <p className="font-semibold text-amber-800 text-sm">Important</p>
                <p className="text-amber-700 text-sm mt-1">
                  Copy the temporary password before approving. Share it securely with the user. The user must change this password on first login.
                </p>
              </div>
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog}>Cancel</Button>
          <Button
            className="bg-gradient-to-r from-emerald-500 to-teal-500 hover:from-emerald-600 hover:to-teal-600 shadow-lg shadow-emerald-500/20"
            onClick={handleProcess}
            disabled={isProcessing || !newPassword}
          >
            {isProcessing ? (
              <>
                <svg className="w-4 h-4 mr-2 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                Processing...
              </>
            ) : (
              <>
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                </svg>
                Approve & Reset Password
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Reject Dialog */}
      <Dialog open={actionDialog === 'reject'} onClose={closeDialog}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-red-100">
              <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            Reject Password Reset Request
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-5">
          <div className="flex items-center gap-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
            <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center text-lg font-semibold text-slate-600">
              {(selectedRequest?.userFullName || selectedRequest?.userId || '').split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2)}
            </div>
            <div>
              <p className="font-semibold text-slate-800">{selectedRequest?.userFullName || selectedRequest?.userId}</p>
              {selectedRequest?.userFullName && <p className="text-sm text-slate-500 font-mono">{selectedRequest.userId}</p>}
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-3 rounded-xl bg-red-50 border border-red-200 p-4">
              <svg className="w-5 h-5 text-red-500 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              <p className="text-sm text-red-700">{error}</p>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">Reason for rejection (optional)</label>
            <Input
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder="e.g., User should contact IT directly"
              className="h-12"
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={closeDialog}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={handleProcess}
            disabled={isProcessing}
            className="bg-gradient-to-r from-red-500 to-rose-500 hover:from-red-600 hover:to-rose-600"
          >
            {isProcessing ? (
              <>
                <svg className="w-4 h-4 mr-2 animate-spin" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
                </svg>
                Processing...
              </>
            ) : (
              <>
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Reject Request
              </>
            )}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* Reauth Dialog */}
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Process Reset Request"
      />
    </div>
  );
}
