import type { StageResult } from '../types';
import {
  STAGE_NAMES,
  formatDuration,
  getStageBgClass,
  getStageDotClass,
  getStageTimelineClass,
} from '../helpers';

// ---------------------------------------------------------------------------
// Stage Timeline (detail view)
// ---------------------------------------------------------------------------

export function StageTimeline({ stages }: { stages: StageResult[] }) {
  // Ensure 11 slots, filling in not-reached stages
  const allStages = Array.from({ length: 11 }, (_, i) => {
    const stageNum = i + 1;
    const found = stages.find((s) => s.stage === stageNum);
    return (
      found ?? {
        stage: stageNum,
        name: STAGE_NAMES[stageNum] ?? `Stage ${stageNum}`,
        status: 'SKIPPED' as const,
        durationMs: 0,
      }
    );
  });

  return (
    <div className="space-y-2">
      {allStages.map((stage, index) => {
        const isLast = index === allStages.length - 1;
        return (
          <div key={stage.stage} className="relative flex items-start gap-3">
            {/* Connector line */}
            {!isLast && (
              <div className="absolute left-[10px] top-6 bottom-0 w-0.5 bg-slate-200" style={{ height: 'calc(100% + 8px)' }} />
            )}

            {/* Stage dot */}
            <div
              className={`relative flex-shrink-0 w-5 h-5 rounded-full border-2 mt-0.5 ${getStageDotClass(stage.status)}`}
            >
              {stage.status === 'SUCCESS' && (
                <svg className="w-2.5 h-2.5 text-white absolute inset-0 m-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                </svg>
              )}
              {stage.status === 'FAILED' && (
                <svg className="w-2.5 h-2.5 text-white absolute inset-0 m-auto" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M6 18L18 6M6 6l12 12" />
                </svg>
              )}
            </div>

            {/* Stage content */}
            <div className={`flex-1 min-w-0 rounded-xl border px-3.5 py-2.5 mb-1 ${getStageTimelineClass(stage.status)}`}>
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="text-xs font-bold text-slate-400 tabular-nums w-5 text-right flex-shrink-0">
                    {stage.stage}
                  </span>
                  <span className={`text-sm font-semibold truncate ${
                    stage.status === 'FAILED' ? 'text-red-700' :
                    stage.status === 'SUCCESS' ? 'text-emerald-700' :
                    'text-slate-500'
                  }`}>
                    {stage.name}
                  </span>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  {stage.status !== 'SKIPPED' && (
                    <span className="text-xs text-slate-500 font-mono">{formatDuration(stage.durationMs)}</span>
                  )}
                  <span className={`text-xs px-1.5 py-0.5 rounded font-semibold ${getStageBgClass(stage.status)} ${
                    stage.status === 'SKIPPED' ? 'text-slate-500' : 'text-white'
                  }`}>
                    {stage.status}
                  </span>
                </div>
              </div>

              {/* Error info */}
              {stage.status === 'FAILED' && (stage.errorCode || stage.errorMessage) && (
                <div className="mt-2 rounded-lg bg-red-100/70 border border-red-200 px-3 py-2 space-y-1">
                  {stage.errorCode && (
                    <p className="text-xs font-mono font-bold text-red-700">{stage.errorCode}</p>
                  )}
                  {stage.errorMessage && (
                    <p className="text-xs text-red-600">{stage.errorMessage}</p>
                  )}
                </div>
              )}

              {/* Warnings */}
              {stage.warnings && stage.warnings.length > 0 && (
                <div className="mt-2 space-y-0.5">
                  {stage.warnings.map((w, wi) => (
                    <p key={wi} className="text-xs text-amber-600 flex items-start gap-1">
                      <svg className="w-3 h-3 mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
                      </svg>
                      {w}
                    </p>
                  ))}
                </div>
              )}

              {/* Details (collapsible if present) */}
              {stage.details && Object.keys(stage.details).length > 0 && (
                <details className="mt-2">
                  <summary className="text-xs text-slate-400 cursor-pointer hover:text-slate-600 select-none">
                    Details
                  </summary>
                  <pre className="mt-1.5 text-xs text-slate-600 bg-white/70 rounded-lg border border-slate-200 p-2 overflow-x-auto max-h-32">
                    {JSON.stringify(stage.details, null, 2)}
                  </pre>
                </details>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
