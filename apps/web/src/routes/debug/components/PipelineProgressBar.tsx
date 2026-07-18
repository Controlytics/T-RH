import type { StageResult } from '../types';
import { STAGE_NAMES } from '../helpers';

// ---------------------------------------------------------------------------
// Pipeline Progress Bar (11 blocks, one per stage)
// ---------------------------------------------------------------------------

export function PipelineProgressBar({ stages }: { stages: StageResult[] }) {
  // Build a map of stage number -> status
  const stageMap = new Map<number, StageResult['status']>();
  for (const s of stages) {
    stageMap.set(s.stage, s.status);
  }

  const completedCount = stages.filter((s) => s.status === 'SUCCESS').length;

  return (
    <div className="flex items-center gap-1.5">
      <div className="flex items-center gap-0.5">
        {Array.from({ length: 11 }, (_, i) => {
          const stageNum = i + 1;
          const status = stageMap.get(stageNum);
          let blockClass = 'bg-slate-200'; // not reached
          if (status === 'SUCCESS') blockClass = 'bg-emerald-500';
          else if (status === 'FAILED') blockClass = 'bg-red-500';
          else if (status === 'SKIPPED') blockClass = 'bg-slate-300';

          return (
            <div
              key={stageNum}
              title={`Stage ${stageNum}: ${STAGE_NAMES[stageNum] ?? `Stage ${stageNum}`} — ${status ?? 'Not reached'}`}
              className={`w-3 h-3 rounded-sm transition-colors ${blockClass}`}
            />
          );
        })}
      </div>
      <span className="text-xs text-slate-500 font-medium whitespace-nowrap">
        {completedCount}/11
      </span>
    </div>
  );
}
