import { useState, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@/components/ui/card';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { apiUrl } from '@/lib/url-utils';

interface ValidationResult {
  valid: boolean;
  metadata: {
    version: string;
    timestamp: string;
    generatedBy: string;
    tableCount: number;
    checksum: string;
  };
  tableSummary: Record<string, number>;
  checksumValid: boolean;
  checksumSupported?: boolean;
  totalRecords: number;
}

const TABLE_LABELS: Record<string, string> = {
  users: 'Users',
  roles: 'Roles',
  systemConfig: 'System Config',
  auditTrail: 'Audit Trail',
  notifications: 'Notifications',
  passwordHistory: 'Password History',
  sessions: 'Sessions',
  fieldIdConfig: 'Field ID Config',
  userConfigs: 'User Configs',
  roleConfigs: 'Role Configs',
  passwordResetRequests: 'Password Reset Requests',
};

type BackupFormat = 'json' | 'sql' | 'csv' | 'bak';

const FORMAT_OPTIONS: { value: BackupFormat; label: string; description: string; icon: string; ext: string; color: string }[] = [
  {
    value: 'json',
    label: 'JSON',
    description: 'Full backup with checksum verification. Can be restored via this application.',
    icon: '{ }',
    ext: '.json',
    color: 'from-blue-500 to-indigo-600',
  },
  {
    value: 'bak',
    label: 'BAK',
    description: 'Compressed binary backup. Smallest file size, restorable via this application.',
    icon: 'BAK',
    ext: '.bak',
    color: 'from-violet-500 to-purple-600',
  },
  {
    value: 'sql',
    label: 'SQL',
    description: 'PostgreSQL INSERT statements. Can be restored via psql or any SQL client.',
    icon: 'SQL',
    ext: '.sql',
    color: 'from-emerald-500 to-teal-600',
  },
  {
    value: 'csv',
    label: 'CSV (ZIP)',
    description: 'ZIP archive of CSV files, one per table. Ideal for Excel or data analysis.',
    icon: 'CSV',
    ext: '.zip',
    color: 'from-amber-500 to-orange-600',
  },
];

export function BackupRestorePage() {
  // 2026-05-26 permission-leak fix (audit task #12): the route is gated
  // by CONFIG_READ which intentionally allows read-only config viewers.
  // Pre-fix this page exposed Download (full DB dump) and Restore
  // (overwrite every table) buttons to anyone who could reach the
  // route. Backend RBAC stopped the actual write on Restore, but the
  // UI surface contradicted the role intent and a curious operator
  // could trigger BACKUP_EXPORT (which IS suffix-covered by
  // BACKUP_MANAGE per packages/shared/src/types/permissions.ts) by
  // chaining their CONFIG_READ token with a manual API call.
  const { user } = useAuth();
  const perms: string[] = (user?.permissions as string[] | undefined) ?? [];
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const canExport = isSuperAdmin || perms.includes('BACKUP_MANAGE') || perms.includes('BACKUP_EXPORT');
  // BACKUP_RESTORE is intentionally NOT covered by BACKUP_MANAGE suffix
  // expansion (see comment in shared types). Restore requires the
  // explicit perm — destructive enough that a SUPER_ADMIN bypass is
  // the only override.
  const canRestore = isSuperAdmin || perms.includes('BACKUP_RESTORE');
  const reauth = useReauth();
  const { formatDateTime } = useDatetimeFormat();
  const [selectedFormat, setSelectedFormat] = useState<BackupFormat>('json');
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState('');
  const [restoring, setRestoring] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);
  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [confirmRestore, setConfirmRestore] = useState(false);
  const [restoreResult, setRestoreResult] = useState<{ success: boolean; message: string } | null>(null);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleExport = async () => {
    setExporting(true);
    setExportError('');
    await reauth.execute('EXPORT_BACKUP', async (password?) => {
      const token = sessionStorage.getItem('access_token');
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (password) headers['x-reauth-password'] = password;
      const response = await fetch(apiUrl(`/api/backup/export?format=${selectedFormat}`), { headers });
      if (!response.ok) throw new Error('Export failed');

      const blob = await response.blob();
      const contentDisposition = response.headers.get('Content-Disposition');
      const filenameMatch = contentDisposition?.match(/filename="(.+)"/);
      const fallbackExt = selectedFormat === 'csv' ? '.zip' : `.${selectedFormat}`;
      const filename = filenameMatch?.[1] || `digilog_backup_${new Date().toISOString().replace(/[:.]/g, '-')}${fallbackExt}`;

      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, {
      onError: (err: any) => setExportError(err.message || 'Failed to export backup'),
    });
    setExporting(false);
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setRestoreFile(file);
    setValidation(null);
    setRestoreResult(null);
    setError('');

    setValidating(true);
    try {
      const formData = new FormData();
      formData.append('file', file);

      const token = sessionStorage.getItem('access_token');
      const response = await fetch(apiUrl('/api/backup/validate'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      });

      const result = await response.json();
      if (response.ok) {
        setValidation(result);
      } else {
        setError(result.message || 'Validation failed');
      }
    } catch {
      setError('Failed to validate backup file');
    } finally {
      setValidating(false);
    }
  };

  const handleRestore = async () => {
    if (!restoreFile) return;
    setRestoring(true);
    setError('');
    setConfirmRestore(false);
    await reauth.execute('RESTORE_BACKUP', async (password?) => {
      const formData = new FormData();
      formData.append('file', restoreFile);

      const token = sessionStorage.getItem('access_token');
      const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
      if (password) headers['x-reauth-password'] = password;
      const response = await fetch(apiUrl('/api/backup/restore'), {
        method: 'POST',
        headers,
        body: formData,
      });

      const result = await response.json();
      if (response.ok) {
        setRestoreResult({ success: true, message: result.message });
      } else {
        setRestoreResult({ success: false, message: result.message || 'Restore failed' });
      }

      if (result.success) {
        setRestoreFile(null);
        setValidation(null);
        if (fileInputRef.current) fileInputRef.current.value = '';
      }
    }, {
      onError: () => {
        setRestoreResult({ success: false, message: 'Restore failed unexpectedly' });
      },
    });
    setRestoring(false);
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-center gap-4">
        <div className="p-3 rounded-2xl bg-gradient-to-br from-emerald-500 to-teal-600 shadow-lg shadow-emerald-500/25">
          <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4" />
          </svg>
        </div>
        <div>
          <h1 className="text-2xl font-bold bg-gradient-to-r from-slate-800 to-slate-600 bg-clip-text text-transparent">Backup & Restore</h1>
          <p className="text-sm text-slate-500 mt-0.5">Export or restore the entire database</p>
        </div>
      </div>

      {/* Create Backup */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
            </div>
            <div>
              <CardTitle>Create Backup</CardTitle>
              <CardDescription>Download a full backup of all database tables in your preferred format</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Format Selection */}
          <div>
            <p className="text-sm font-medium text-slate-700 mb-3">Select Backup Format</p>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              {FORMAT_OPTIONS.map((fmt) => (
                <button
                  key={fmt.value}
                  type="button"
                  onClick={() => setSelectedFormat(fmt.value)}
                  className={`relative flex flex-col items-start gap-2 rounded-xl border-2 p-4 text-left transition-all ${
                    selectedFormat === fmt.value
                      ? 'border-blue-500 bg-blue-50/50 shadow-md shadow-blue-500/10'
                      : 'border-slate-200 bg-white hover:border-slate-300 hover:shadow-sm'
                  }`}
                >
                  {/* Selection indicator */}
                  <div className={`absolute top-3 right-3 w-5 h-5 rounded-full border-2 flex items-center justify-center transition-colors ${
                    selectedFormat === fmt.value ? 'border-blue-500 bg-blue-500' : 'border-slate-300'
                  }`}>
                    {selectedFormat === fmt.value && (
                      <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </div>
                  {/* Format icon */}
                  <div className={`px-2.5 py-1 rounded-lg bg-gradient-to-r ${fmt.color} text-white text-xs font-bold tracking-wide`}>
                    {fmt.icon}
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{fmt.label}</p>
                    <p className="text-xs text-slate-500 mt-0.5 leading-relaxed pr-4">{fmt.description}</p>
                  </div>
                  <span className="text-[10px] font-mono text-slate-400 bg-slate-100 px-1.5 py-0.5 rounded">{fmt.ext}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Download button */}
          <div className="flex items-center gap-4">
            <Button
              onClick={handleExport}
              disabled={exporting || !canExport}
              title={!canExport ? 'BACKUP_MANAGE permission required' : undefined}
              className="gap-2 bg-gradient-to-r from-blue-500 to-indigo-600 hover:from-blue-600 hover:to-indigo-700 shadow-lg shadow-blue-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
              </svg>
              {exporting ? 'Generating Backup...' : `Download ${FORMAT_OPTIONS.find(f => f.value === selectedFormat)?.label} Backup`}
            </Button>
            <p className="text-sm text-slate-500">
              Includes all users, roles, configuration, audit trail, templates, and hierarchy data.
            </p>
            {!canExport && (
              <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
                You do not have permission to download backups. Required: BACKUP_MANAGE.
              </p>
            )}
          </div>
          {exportError && (
            <div className="mt-3 rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{exportError}</div>
          )}
        </CardContent>
      </Card>

      {/* Restore from Backup */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="p-2 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600">
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
              </svg>
            </div>
            <div>
              <CardTitle>Restore from Backup</CardTitle>
              <CardDescription>Upload a backup file to restore the database to a previous state</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* File upload area */}
          <div
            className="border-2 border-dashed border-slate-300 rounded-2xl p-8 text-center hover:border-blue-400 hover:bg-blue-50/30 transition-colors cursor-pointer"
            onClick={() => fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,.bak,.sql,.zip"
              onChange={handleFileSelect}
              className="hidden"
            />
            <div className="flex flex-col items-center gap-3">
              <div className="p-3 rounded-2xl bg-slate-100">
                <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-700">
                  {restoreFile ? restoreFile.name : 'Click to select backup file'}
                </p>
                <p className="text-xs text-slate-500 mt-1">
                  {restoreFile
                    ? `${(restoreFile.size / 1024).toFixed(1)} KB`
                    : 'Supported formats: .json, .bak, .sql, .zip (CSV)'
                  }
                </p>
              </div>
            </div>
          </div>

          {/* Validating indicator */}
          {validating && (
            <div className="flex items-center gap-3 p-4 rounded-xl bg-blue-50 border border-blue-200">
              <svg className="w-5 h-5 text-blue-500 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span className="text-sm text-blue-700 font-medium">Validating backup file...</span>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
          )}

          {/* Validation result. Three states: verified (json/bak checksum OK),
              failed (json/bak checksum mismatch), and not-applicable (SQL/CSV
              carry no independent integrity digest — showing green "VALID" there
              was a false tamper-evidence signal). */}
          {validation && (() => {
            const csState: 'ok' | 'fail' | 'na' =
              validation.checksumSupported === false ? 'na' : validation.checksumValid ? 'ok' : 'fail';
            const box = csState === 'ok' ? 'bg-emerald-50/50 border-emerald-200'
              : csState === 'fail' ? 'bg-red-50/50 border-red-200'
              : 'bg-amber-50/50 border-amber-200';
            return (
            <div className={`rounded-2xl border p-5 space-y-4 ${box}`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  {csState === 'ok' ? (
                    <div className="p-2 rounded-xl bg-emerald-100">
                      <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                      </svg>
                    </div>
                  ) : csState === 'fail' ? (
                    <div className="p-2 rounded-xl bg-red-100">
                      <svg className="w-5 h-5 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                      </svg>
                    </div>
                  ) : (
                    <div className="p-2 rounded-xl bg-amber-100">
                      <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                    </div>
                  )}
                  <div>
                    <p className={`font-semibold ${csState === 'ok' ? 'text-emerald-800' : csState === 'fail' ? 'text-red-800' : 'text-amber-800'}`}>
                      {csState === 'ok' ? 'Backup file is valid'
                        : csState === 'fail' ? 'Backup file integrity check failed'
                        : 'Structure valid — integrity not independently verifiable'}
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">
                      {csState === 'ok' ? 'Checksum verified. File has not been tampered with.'
                        : csState === 'fail' ? 'The file may be corrupted or modified. Do not restore from this file.'
                        : 'SQL/CSV backups carry no independent integrity digest, so tampering cannot be detected. Use a .json or .bak backup if you need a verifiable checksum.'}
                    </p>
                  </div>
                </div>
                <Badge className={csState === 'ok'
                  ? 'bg-gradient-to-r from-emerald-400 to-teal-400 text-white border-0'
                  : csState === 'fail' ? 'bg-gradient-to-r from-red-400 to-rose-400 text-white border-0'
                  : 'bg-gradient-to-r from-amber-400 to-orange-400 text-white border-0'
                }>
                  {csState === 'ok' ? 'VALID' : csState === 'fail' ? 'INVALID' : 'NOT VERIFIED'}
                </Badge>
              </div>

              {/* Metadata */}
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-white/60 rounded-xl p-3 border border-slate-200/50">
                  <p className="text-xs text-slate-500">Backup Date</p>
                  <p className="text-sm font-semibold text-slate-800">{formatDateTime(validation.metadata.timestamp)}</p>
                </div>
                <div className="bg-white/60 rounded-xl p-3 border border-slate-200/50">
                  <p className="text-xs text-slate-500">Created By</p>
                  <p className="text-sm font-semibold text-slate-800">{validation.metadata.generatedBy}</p>
                </div>
                <div className="bg-white/60 rounded-xl p-3 border border-slate-200/50">
                  <p className="text-xs text-slate-500">Tables</p>
                  <p className="text-sm font-semibold text-slate-800">{validation.metadata.tableCount}</p>
                </div>
                <div className="bg-white/60 rounded-xl p-3 border border-slate-200/50">
                  <p className="text-xs text-slate-500">Total Records</p>
                  <p className="text-sm font-semibold text-slate-800">{validation.totalRecords.toLocaleString()}</p>
                </div>
              </div>

              {/* Table summary */}
              <div className="bg-white/60 rounded-xl border border-slate-200/50 overflow-hidden">
                <div className="px-4 py-2 bg-slate-50/80 border-b border-slate-200/50">
                  <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Record Counts by Table</p>
                </div>
                <div className="grid grid-cols-2 gap-px bg-slate-200/30">
                  {Object.entries(validation.tableSummary).map(([key, count]) => (
                    <div key={key} className="bg-white px-4 py-2 flex items-center justify-between">
                      <span className="text-sm text-slate-600">{TABLE_LABELS[key] || key}</span>
                      <span className="text-sm font-semibold text-slate-800">{count.toLocaleString()}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Restore button — 2026-05-26 gated on BACKUP_RESTORE
                  (explicit, NOT covered by BACKUP_MANAGE suffix). Available when
                  the file isn't a proven-tampered json/bak (csState 'ok' or 'na');
                  SQL/CSV ('na') has no verifiable checksum but restore() skips the
                  check for those formats, so they remain restorable as before. */}
              {csState !== 'fail' && (
                <>
                  <Button
                    onClick={() => setConfirmRestore(true)}
                    disabled={restoring || !canRestore}
                    title={!canRestore ? 'BACKUP_RESTORE permission required' : undefined}
                    className="w-full gap-2 bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 shadow-lg shadow-amber-500/25 disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    Restore Database from This Backup
                  </Button>
                  {!canRestore && (
                    <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 mt-2">
                      You do not have permission to restore from a backup. Required: BACKUP_RESTORE.
                    </p>
                  )}
                </>
              )}
            </div>
            );
          })()}

          {/* Restore result */}
          {restoreResult && (
            <div className={`rounded-xl border p-4 flex items-start gap-3 ${restoreResult.success ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
              {restoreResult.success ? (
                <svg className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              ) : (
                <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
              <div>
                <p className={`font-semibold text-sm ${restoreResult.success ? 'text-emerald-800' : 'text-red-800'}`}>
                  {restoreResult.success ? 'Restore Successful' : 'Restore Failed'}
                </p>
                <p className={`text-sm mt-1 ${restoreResult.success ? 'text-emerald-700' : 'text-red-700'}`}>
                  {restoreResult.message}
                </p>
                {restoreResult.success && (
                  <p className="text-xs text-emerald-600 mt-2">You may need to log in again if your session was affected.</p>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Restore Confirmation Dialog */}
      <Dialog open={confirmRestore} onClose={() => setConfirmRestore(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="p-2 rounded-lg bg-amber-100">
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            Confirm Database Restore
          </DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <div className="flex items-start gap-3 p-4 rounded-xl bg-red-50 border border-red-200">
            <svg className="w-5 h-5 text-red-500 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
            <div className="text-sm text-red-700">
              <p className="font-semibold">Warning: This will replace ALL existing data!</p>
              <p className="mt-2">This action will:</p>
              <ul className="list-disc list-inside mt-1 space-y-1">
                <li>Delete all current data from all tables</li>
                <li>Restore data from the backup file</li>
                <li>Terminate all active sessions</li>
                <li>Require you to log in again</li>
              </ul>
              <p className="mt-2 font-semibold">This action cannot be undone. Make sure you have a current backup before proceeding.</p>
            </div>
          </div>
          {validation && (
            <div className="mt-4 p-4 rounded-xl bg-slate-50 border border-slate-200">
              <p className="text-sm text-slate-600">
                Restoring backup from <strong>{formatDateTime(validation.metadata.timestamp)}</strong> created by <strong>{validation.metadata.generatedBy}</strong>
              </p>
              <p className="text-xs text-slate-500 mt-1">{validation.totalRecords.toLocaleString()} total records across {validation.metadata.tableCount} tables</p>
            </div>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => setConfirmRestore(false)}>Cancel</Button>
          <Button
            variant="destructive"
            onClick={handleRestore}
            disabled={restoring || !canRestore}
            title={!canRestore ? 'BACKUP_RESTORE permission required' : undefined}
            className="bg-gradient-to-r from-red-500 to-rose-500 hover:from-red-600 hover:to-rose-600 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {restoring ? 'Restoring...' : 'Restore Database'}
          </Button>
        </DialogFooter>
      </Dialog>

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Backup Action"
      />
    </div>
  );
}
