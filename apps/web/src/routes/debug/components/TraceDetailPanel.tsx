import type { PipelineTrace } from '../types';
import { formatDuration } from '../helpers';
import { StageTimeline } from './StageTimeline';

// ---------------------------------------------------------------------------
// Expanded trace row detail panel
// ---------------------------------------------------------------------------

export function TraceDetailPanel({ trace }: { trace: PipelineTrace }) {
  return (
    <div className="px-5 pb-5 pt-2 bg-slate-50/60 border-t border-slate-100">
      {/* Meta grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-5">
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Message ID</p>
          <p className="text-xs font-mono text-slate-600 truncate">{trace.messageId}</p>
        </div>
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Payload Size</p>
          <p className="text-sm font-semibold text-slate-700">
            {trace.payloadSize != null ? `${trace.payloadSize.toLocaleString()} B` : '—'}
          </p>
        </div>
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Total Duration</p>
          <p className="text-sm font-semibold text-slate-700">{formatDuration(trace.totalDurationMs)}</p>
        </div>
        <div>
          <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-0.5">Stages Run</p>
          <p className="text-sm font-semibold text-slate-700">{trace.stages.length} / 11</p>
        </div>
      </div>

      {/* Error summary if present */}
      {trace.finalStatus === 'FAILED' && (trace.errorCode || trace.errorMessage) && (
        <div className="mb-5 flex items-start gap-3 rounded-xl bg-red-50 border border-red-200 px-4 py-3">
          <div className="p-1.5 rounded-lg bg-red-100 flex-shrink-0">
            <svg className="w-4 h-4 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <div className="min-w-0">
            {trace.errorCode && (
              <p className="text-xs font-mono font-bold text-red-700 mb-0.5">{trace.errorCode}</p>
            )}
            {trace.errorMessage && (
              <p className="text-sm text-red-600">{trace.errorMessage}</p>
            )}
            {trace.failedStage && (
              <p className="text-xs text-red-400 mt-1">Failed at: {trace.failedStage}</p>
            )}
          </div>
        </div>
      )}

      {/* Warnings summary */}
      {trace.warnings && trace.warnings.length > 0 && (
        <div className="mb-5 rounded-xl bg-amber-50 border border-amber-200 px-4 py-3">
          <p className="text-xs font-semibold text-amber-700 mb-2 uppercase tracking-wider">Warnings ({trace.warnings.length})</p>
          <ul className="space-y-1">
            {trace.warnings.map((w, i) => (
              <li key={i} className="text-xs text-amber-600 flex items-start gap-1.5">
                <svg className="w-3.5 h-3.5 mt-0.5 flex-shrink-0 text-amber-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                </svg>
                {w}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* Stage Timeline */}
      <div>
        <p className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Pipeline Stages</p>
        <StageTimeline stages={trace.stages} />
      </div>
    </div>
  );
}
