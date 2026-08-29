import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatActionLabel, diffAuditValues, maskAuditValue, prettyFieldName, isRedacted, redactionDetail } from '../audit-helpers';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isUuidLike(value: unknown): boolean {
  return typeof value === 'string' && UUID_REGEX.test(value);
}

/** Strip keys whose value is a UUID (id, userId, *Id) so the detail view shows only human-readable fields. */
function pruneUuids(obj: Record<string, unknown> | null | undefined): Array<[string, unknown]> {
  if (!obj || typeof obj !== 'object') return [];
  return Object.entries(obj).filter(([key, value]) => {
    if (isUuidLike(value)) return false;
    if (/(^|[^a-z])id$/i.test(key) && typeof value === 'string') return false;
    return true;
  });
}

interface AuditDetailModalProps {
  selectedRecord: any;
  onClose: () => void;
  formatDateTime: (value: string) => string;
  getAuditSummary: (record: any, templates: Record<string, string>) => string;
  getAuditStatus: (action: string) => 'Success' | 'Fail';
  templates: Record<string, string>;
  ACTION_COLORS: Record<string, string>;
  ROLE_COLORS: Record<string, string>;
}

export function AuditDetailModal({
  selectedRecord,
  onClose,
  formatDateTime,
  getAuditSummary,
  getAuditStatus,
  templates,
  ACTION_COLORS,
  ROLE_COLORS,
}: AuditDetailModalProps) {
  return (
    <Dialog open={!!selectedRecord} onClose={onClose} className="max-w-2xl">
      <DialogHeader>
        <DialogTitle className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-indigo-100 text-indigo-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
          </div>
          Audit Record Detail
        </DialogTitle>
      </DialogHeader>
      {selectedRecord && (() => {
        const detailStatus = getAuditStatus(selectedRecord.action);
        return (
        <div className="space-y-4 max-h-[70vh] overflow-y-auto">
          {/* Action Summary */}
          <div className="rounded-[var(--radius-card)] border border-sky-200 bg-sky-50 p-4">
            <p className="text-sm font-semibold text-sky-900">
              {getAuditSummary(selectedRecord, templates)}
            </p>
            <div className="flex items-center gap-3 mt-2">
              <p className="text-xs text-indigo-500">
                {formatDateTime(selectedRecord.timestamp)}
              </p>
              {detailStatus === 'Success' ? (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-green-100 text-green-700 border border-green-200">
                  <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" /></svg>
                  Success
                </span>
              ) : (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-red-100 text-red-700 border border-red-200">
                  <svg className="w-2.5 h-2.5" fill="currentColor" viewBox="0 0 20 20"><path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM8.707 7.293a1 1 0 00-1.414 1.414L8.586 10l-1.293 1.293a1 1 0 101.414 1.414L10 11.414l1.293 1.293a1 1 0 001.414-1.414L11.414 10l1.293-1.293a1 1 0 00-1.414-1.414L10 8.586 8.707 7.293z" clipRule="evenodd" /></svg>
                  Fail
                </span>
              )}
            </div>
          </div>

          {/* Redaction banner. Sits directly under the summary because that summary
              is built from a NULLed before/after and would otherwise read as a
              complete record. Chain-preserving redaction only satisfies §11 if the
              mask, the redactor and the reason are all visible to an inspector. */}
          {isRedacted(selectedRecord) && (
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-200">
              <div className="flex items-start gap-3">
                <svg className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                </svg>
                <div className="text-sm text-amber-800 min-w-0">
                  <p className="font-semibold">This record's payload was redacted</p>
                  <p className="mt-1">
                    The before/after values were permanently masked. The record itself, its
                    checksum and its hash-chain link are intact — only the payload was removed.
                  </p>
                  <dl className="mt-2 space-y-0.5">
                    <div className="flex gap-2">
                      <dt className="font-medium shrink-0">Redacted by:</dt>
                      <dd className="break-words">{redactionDetail(selectedRecord).by}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="font-medium shrink-0">Redacted at:</dt>
                      <dd>{formatDateTime(selectedRecord.redactedAt)}</dd>
                    </div>
                    <div className="flex gap-2">
                      <dt className="font-medium shrink-0">Reason:</dt>
                      <dd className="break-words">{redactionDetail(selectedRecord).reason}</dd>
                    </div>
                  </dl>
                </div>
              </div>
            </div>
          )}

          {/* Common Info Grid — All users see this */}
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 rounded-xl bg-slate-50">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Record ID</p>
              <p className="text-sm font-semibold text-slate-800 mt-1">#{selectedRecord.id}</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Timestamp</p>
              <p className="text-sm font-semibold text-slate-800 mt-1">
                {formatDateTime(selectedRecord.timestamp)}
              </p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Performed By</p>
              <p className="text-sm font-semibold text-slate-800 mt-1">{selectedRecord.userId}</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Action</p>
              <span className={`inline-flex px-2.5 py-1 rounded-lg text-xs font-medium border mt-1 ${ACTION_COLORS[selectedRecord.action] || 'bg-slate-100 text-slate-700 border-slate-200'}`}>
                {selectedRecord.action}
              </span>
            </div>
            <div className="p-3 rounded-xl bg-slate-50">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Status</p>
              <div className="mt-1">
                {detailStatus === 'Success' ? (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-green-100 text-green-700">Success</span>
                ) : (
                  <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-semibold bg-red-100 text-red-700">Fail</span>
                )}
              </div>
            </div>
            <div className="p-3 rounded-xl bg-slate-50">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">User Role</p>
              <span className={`inline-flex px-2.5 py-1 rounded-full text-xs font-semibold mt-1 ${ROLE_COLORS[selectedRecord.userRole] || 'bg-slate-100 text-slate-700'}`}>
                {selectedRecord.userRole}
              </span>
            </div>
          </div>

          {/* Record metadata. Previously gated on a redact-class permission, which
              left an inspector holding AUDIT_READ looking at a near-empty dialog.
              All of it is read data the backend already returns to any AUDIT_READ
              caller (GET /api/audit/:id), and that endpoint row-scopes what a
              non-SUPER_ADMIN may fetch at all — so there is nothing to withhold here. */}
          <div className="grid grid-cols-2 gap-4">
            <div className="p-3 rounded-xl bg-slate-50">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">IP Address</p>
              <p className="text-sm font-mono text-slate-800 mt-1">{selectedRecord.ipAddress || '-'}</p>
            </div>
            <div className="p-3 rounded-xl bg-slate-50">
              <p className="text-xs font-medium text-slate-500 uppercase tracking-wider">Target Type</p>
              <p className="text-sm font-semibold text-slate-800 mt-1">{selectedRecord.targetType || '-'}</p>
            </div>
          </div>

          {/* Checksum */}
          <div className="p-4 rounded-xl bg-slate-50 border border-slate-200">
            <div className="flex items-center gap-2 mb-2">
              <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
              </svg>
              <p className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Integrity Checksum (SHA-256)</p>
            </div>
            <code className="text-xs font-mono text-slate-600 break-all">{selectedRecord.checksum}</code>
          </div>

          {/* Before/After — visible to ALL roles. Changed-fields summary on top,
              full previous/new record collapsible below. Secrets masked. */}
          {(() => {
            const changes = diffAuditValues(selectedRecord.beforeValue, selectedRecord.afterValue);
            const beforeEntries = pruneUuids(selectedRecord.beforeValue);
            const afterEntries = pruneUuids(selectedRecord.afterValue);
            if (changes.length === 0 && beforeEntries.length === 0 && afterEntries.length === 0) return null;
            return (
              <div className="space-y-3">
                {changes.length > 0 && (
                  <div className="rounded-xl border border-indigo-100 overflow-hidden">
                    <div className="px-4 py-2 bg-indigo-50 border-b border-indigo-100">
                      <p className="text-xs font-semibold text-indigo-700 uppercase tracking-wider">Changes</p>
                    </div>
                    <div className="p-4 bg-white space-y-2">
                      {changes.map((c) => (
                        <div key={c.field} className="flex items-start gap-3 py-1.5 border-b border-slate-50 last:border-0">
                          <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider min-w-[120px] pt-0.5">{c.field}</span>
                          <span className="text-sm flex items-center gap-2 flex-wrap">
                            <span className="text-red-600 line-through break-all">{c.from}</span>
                            <span className="text-slate-400">→</span>
                            <span className="text-green-700 font-medium break-all">{c.to}</span>
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
                {(beforeEntries.length > 0 || afterEntries.length > 0) && (
                  <details className="rounded-xl border border-slate-200 overflow-hidden">
                    <summary className="px-4 py-2 bg-slate-50 text-xs font-semibold text-slate-600 uppercase tracking-wider cursor-pointer select-none">
                      Full record (previous / new)
                    </summary>
                    <div className="p-4 bg-white grid grid-cols-1 md:grid-cols-2 gap-4">
                      <div>
                        <p className="text-xs font-semibold text-red-700 uppercase tracking-wider mb-2">Previous Value</p>
                        {beforeEntries.length === 0 ? <p className="text-sm text-slate-400">—</p> : beforeEntries.map(([key, value]) => (
                          <div key={key} className="py-1 text-sm">
                            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider mr-2">{prettyFieldName(key)}</span>
                            <span className="text-slate-800 break-all">{maskAuditValue(key, value)}</span>
                          </div>
                        ))}
                      </div>
                      <div>
                        <p className="text-xs font-semibold text-green-700 uppercase tracking-wider mb-2">New Value</p>
                        {afterEntries.length === 0 ? <p className="text-sm text-slate-400">—</p> : afterEntries.map(([key, value]) => (
                          <div key={key} className="py-1 text-sm">
                            <span className="text-xs font-semibold text-slate-500 uppercase tracking-wider mr-2">{prettyFieldName(key)}</span>
                            <span className="text-slate-800 break-all">{maskAuditValue(key, value)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  </details>
                )}
              </div>
            );
          })()}

          {/* Reason — visible to all */}
          {selectedRecord.reason && (
            <div className="p-4 rounded-xl bg-amber-50 border border-amber-100">
              <p className="text-xs font-semibold text-amber-700 uppercase tracking-wider mb-1">Reason</p>
              <p className="text-sm text-amber-800">{selectedRecord.reason}</p>
            </div>
          )}
        </div>
        );
      })()}
    </Dialog>
  );
}
