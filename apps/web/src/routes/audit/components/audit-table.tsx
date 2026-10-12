import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table';
import { formatActionLabel, diffAuditValues, isRedacted, redactionDetail } from '../audit-helpers';
import { StatusBadge } from '@/components/ui/status-badge';
import { SkeletonRows } from '@/components/ui/skeleton';

type SortField = 'timestamp' | 'action' | 'userId' | 'userRole';

// Actions that mean "a record's fields were edited" — for these the summary
// ("… updated") doesn't say WHAT changed, so we show the inline old -> new diff.
// Self-descriptive status/workflow actions (account unlock/lock, enable/disable,
// approvals) are NOT listed: their summary line already tells the whole story,
// so no field diff.
const FIELD_DIFF_ACTIONS = new Set([
  'USER_UPDATED',
  'ROLE_UPDATED',
  'PROFILE_UPDATED',
  'CONFIG_CHANGED',
  'INSTRUMENT_UPDATED',
  'UPDATED',
  'EDITED',
]);

interface AuditTableProps {
  data: any;
  isLoading: boolean;
  // Gates the SELECTION column only (the checkboxes that feed bulk redact /
  // delete). Reading a record is NOT gated on it — the whole page already
  // requires AUDIT_READ, and the backend row-scopes what a reader may fetch.
  canDestroy: boolean;
  selectedIds: Set<string>;
  toggleSelect: (id: string) => void;
  toggleSelectAll: () => void;
  isAllSelected: boolean;
  sortBy: SortField;
  sortOrder: 'asc' | 'desc';
  toggleSort: (field: SortField) => void;
  formatDate: (value: string) => string;
  formatTime: (value: string) => string;
  getAuditSummary: (record: any, templates: Record<string, string>) => string;
  getAuditStatus: (action: string) => 'Success' | 'Fail';
  templates: Record<string, string>;
  ACTION_COLORS: Record<string, string>;
  onViewRecord: (record: any) => void;
  onDeleteRecord: (id: string) => void;
  // Per-row destructive affordances. `canRedact` shows the chain-preserving
  // redact button; `canHardDelete` shows the physical-delete button (breaks chain).
  canRedact?: boolean;
  canHardDelete?: boolean;
  onHardDeleteRecord?: (id: string) => void;
}

export function AuditTable({
  data,
  isLoading,
  canDestroy,
  selectedIds,
  toggleSelect,
  toggleSelectAll,
  isAllSelected,
  sortBy,
  sortOrder,
  toggleSort,
  formatDate,
  formatTime,
  getAuditSummary,
  getAuditStatus,
  templates,
  ACTION_COLORS,
  onViewRecord,
  onDeleteRecord,
  canRedact = true,
  canHardDelete = false,
  onHardDeleteRecord,
}: AuditTableProps) {
  // Timestamp, Description, Action, Performed By, Status, Details — plus the
  // selection checkbox when the viewer can destroy. Counted rather than
  // hardcoded; the previous literals (8 / 5) over-spanned the empty state.
  const columnCount = 6 + (canDestroy ? 1 : 0);
  return (
    <Card className="border-slate-200/60 shadow-soft overflow-hidden">
      <CardContent className="p-0">
        {isLoading ? (
          // Rows where rows are coming, at the table's real column count, so
          // the page does not jump when the records land.
          <div className="p-4">
            <SkeletonRows rows={6} columns={columnCount} />
          </div>
        ) : (
          <div className="overflow-x-auto">
            {/* A GRID, 15px, bold (operator, 2026-09-25: "make audit trail
                page in to table format … font sizes increased and bold, and
                table lines shoud be visibl"). The header row used to carry
                a translucent slate wash over the band; the band shows now. */}
            <Table grid size="lg">
              <TableHeader>
                <TableRow>
                  {canDestroy && (
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        checked={isAllSelected}
                        onChange={toggleSelectAll}
                        className="ctl-check"
                      />
                    </TableHead>
                  )}
                  <TableHead>
                    <button onClick={() => toggleSort('timestamp')} className="flex items-center gap-1.5 text-[0.75rem] font-bold text-white hover:text-white/80 transition-colors group">
                      Timestamp
                      <span className={`transition-colors ${sortBy === 'timestamp' ? 'text-white' : 'text-white/50 group-hover:text-white/70'}`}>
                        {sortBy === 'timestamp' ? (sortOrder === 'asc' ? '\u2191' : '\u2193') : '\u2195'}
                      </span>
                    </button>
                  </TableHead>
                  <TableHead className="text-[0.75rem] font-bold text-white">Description</TableHead>
                  <TableHead>
                    <button onClick={() => toggleSort('action')} className="flex items-center gap-1.5 text-[0.75rem] font-bold text-white hover:text-white/80 transition-colors group">
                      Action
                      <span className={`transition-colors ${sortBy === 'action' ? 'text-white' : 'text-white/50 group-hover:text-white/70'}`}>
                        {sortBy === 'action' ? (sortOrder === 'asc' ? '\u2191' : '\u2193') : '\u2195'}
                      </span>
                    </button>
                  </TableHead>
                  <TableHead>
                    <button onClick={() => toggleSort('userId')} className="flex items-center gap-1.5 text-[0.75rem] font-bold text-white hover:text-white/80 transition-colors group">
                      Performed By
                      <span className={`transition-colors ${sortBy === 'userId' ? 'text-white' : 'text-white/50 group-hover:text-white/70'}`}>
                        {sortBy === 'userId' ? (sortOrder === 'asc' ? '\u2191' : '\u2193') : '\u2195'}
                      </span>
                    </button>
                  </TableHead>
                  <TableHead className="text-[0.75rem] font-bold text-white">Status</TableHead>
                  {/* Always shown: opening a record is a READ, available to anyone
                      who can see the trail. Only the buttons inside are gated. */}
                  <TableHead className="text-[0.75rem] font-bold text-white text-center">Details</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data?.data?.map((record: any) => {
                  const status = getAuditStatus(record.action);
                  const redacted = isRedacted(record);
                  // The server's per-row answer (2026-10-12): the record of a
                  // deletion or a redaction is neither deletable nor redactable.
                  const isProtected = record.protectedRecord === true;
                  return (
                  <TableRow key={record.id} className={`hover:bg-slate-50/50 transition-colors ${canDestroy && selectedIds.has(record.id) ? 'bg-red-50/40' : ''}`}>
                    {canDestroy && (
                      <TableCell className="w-10">
                        <input
                          type="checkbox"
                          checked={selectedIds.has(record.id)}
                          onChange={() => toggleSelect(record.id)}
                          disabled={isProtected}
                          aria-label={isProtected ? 'This record cannot be deleted or redacted' : 'Select record'}
                          title={isProtected ? 'This record documents a deletion or a redaction and cannot be deleted or redacted' : undefined}
                          className="ctl-check"
                        />
                      </TableCell>
                    )}
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="p-1.5 rounded-lg bg-slate-100">
                          <svg className="w-3.5 h-3.5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </div>
                        <div>
                          <p className="text-[0.9375rem] font-bold text-slate-900">
                            {formatDate(record.timestamp)}
                          </p>
                          <p className="text-sm font-medium text-slate-500">
                            {formatTime(record.timestamp)}
                          </p>
                        </div>
                      </div>
                    </TableCell>
                    <TableCell>
                      {(() => {
                        const desc = getAuditSummary(record, templates);
                        const isTruncated = desc.length > 70;
                        const shown = isTruncated ? desc.slice(0, 67) + '...' : desc;
                        // Inline field changes (old -> new) shown directly in the
                        // description for edits, so operators see WHAT changed
                        // without opening the detail popup. Only when both before
                        // and after exist (a real edit) — creates/deletes skip it.
                        const changes = FIELD_DIFF_ACTIONS.has(record.action) && record.beforeValue && record.afterValue
                          ? diffAuditValues(record.beforeValue, record.afterValue)
                          : [];
                        // Styled hover popup for truncated descriptions.
                        // The native `title` tooltip is OS-themed and slow
                        // (~1s delay on most platforms); the custom popup
                        // fires immediately and uses the app's color scheme.
                        return (
                          <div className="min-w-[15rem]">
                            {/* A redacted row's payload was masked, so the summary
                                below is built from an empty before/after and reads
                                like an ordinary record. Say so, and name the
                                redactor + reason — that visibility is the whole
                                reason redaction exists instead of deletion. */}
                            {redacted && (
                              <div className="mb-1.5 flex items-start gap-1.5 text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-md px-2 py-1">
                                <svg className="w-3.5 h-3.5 shrink-0 mt-px" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                                </svg>
                                <span className="break-words">
                                  <span className="font-semibold">Payload redacted</span>
                                  {' by '}{redactionDetail(record).by}
                                  {': '}{redactionDetail(record).reason}
                                </span>
                              </div>
                            )}
                            <span className="relative inline-block group">
                              <span className="text-[0.9375rem] font-semibold text-slate-800 cursor-default">
                                {shown}
                              </span>
                              {isTruncated && (
                                <span
                                  className="pointer-events-none absolute left-0 bottom-full mb-2 z-50 hidden group-hover:block w-[28rem] max-w-[36rem] bg-white text-slate-800 text-xs leading-snug rounded-lg border border-slate-200 shadow-[var(--elev-2)] px-3 py-2 whitespace-normal break-words"
                                  role="tooltip"
                                >
                                  {desc}
                                </span>
                              )}
                            </span>
                            {changes.length > 0 && (
                              <div className="mt-1.5 space-y-1 border-l-2 border-slate-200 pl-2.5">
                                {changes.map((c) => (
                                  <div key={c.field} className="text-xs flex items-center gap-1.5 flex-wrap">
                                    <span className="font-medium text-slate-500">{c.field}:</span>
                                    <span className="text-red-600 line-through break-all">{c.from}</span>
                                    <span className="text-slate-400">&rarr;</span>
                                    <span className="text-green-700 font-medium break-all">{c.to}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </TableCell>
                    <TableCell>
                      <span
                        className={`inline-flex px-2.5 py-1 rounded-lg text-sm font-bold border ${ACTION_COLORS[record.action] || 'bg-slate-100 text-slate-700 border-slate-200'}`}
                        title={record.action}
                      >
                        {formatActionLabel(record.action, record.afterValue, record.beforeValue)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <div className="w-7 h-7 rounded-full bg-gradient-to-br from-slate-200 to-slate-300 flex items-center justify-center text-xs font-bold text-slate-600">
                          {record.userId?.charAt(0)?.toUpperCase() || '?'}
                        </div>
                        <span className="text-[0.9375rem] font-bold text-slate-900">{record.userId}</span>
                      </div>
                    </TableCell>
                    <TableCell>
                      {/* The outcome of an audited action, in the product's
                          status tones. Was two hand-built pills in green-100 /
                          red-100 with their own glyphs — a third green and a
                          third red, on the one screen an inspector reads. */}
                      <StatusBadge
                        tone={status === 'Success' ? 'ok' : 'danger'}
                        label={status === 'Success' ? 'Success' : 'Fail'}
                        className="px-3 py-1 text-sm font-bold"
                      />
                    </TableCell>
                    <TableCell className="text-center">
                      <div className="flex items-center justify-center gap-1">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => onViewRecord(record)}
                          title="View record details"
                          className="text-indigo-600 hover:text-indigo-700 hover:bg-indigo-50"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
                          </svg>
                        </Button>
                        {/* Already-redacted rows drop the redact button: the payload
                            is gone, and a second click cost a prompt + a reauth
                            round-trip only to 409 ALREADY_REDACTED. Hard-delete
                            stays available — a redacted row can still be removed. */}
                        {canRedact && !redacted && !isProtected && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onDeleteRecord(record.id)}
                            title="Redact record (mask contents, keep hash chain)"
                            className="text-amber-600 hover:text-amber-700 hover:bg-amber-50"
                          >
                            {/* eye-off — redaction */}
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21" />
                            </svg>
                          </Button>
                        )}
                        {canHardDelete && onHardDeleteRecord && !isProtected && (
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => onHardDeleteRecord(record.id)}
                            title="Delete permanently (physically removes the row — breaks the hash chain)"
                            className="text-red-500 hover:text-red-700 hover:bg-red-50"
                          >
                            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                            </svg>
                          </Button>
                        )}
                      </div>
                    </TableCell>
                  </TableRow>
                  );
                })}
                {(!data?.data || data.data.length === 0) && (
                  <TableRow>
                    <TableCell colSpan={columnCount} className="text-center py-12">
                      <div className="p-4 rounded-[var(--radius-card)] bg-slate-100 inline-block mb-4">
                        <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                        </svg>
                      </div>
                      <p className="text-slate-600 font-medium">No audit records found</p>
                      <p className="text-sm text-slate-400 mt-1">Try adjusting your filters</p>
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
