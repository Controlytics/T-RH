/** Remaining Filters Dialog — AHU completion pre-flight (Task 7 + 2026-07-02 redesign).
 *
 * Shown BEFORE a filter's terminal (completing) checklist opens when sibling
 * filters in the same AHU have not all reached their final cleaning stage.
 *
 * Multi-AHU (2026-07-02): when a submission batch spans several AHUs, each AHU is
 * a card in a ◀ ▶ carousel. A single AHU renders one card with no arrows.
 *
 * POPUP mode  → informational; operator can Continue (open the checklist) or Cancel.
 * INTERLOCK mode → block; operator sees the roster. "Complete ready filters" appears
 *                  only when at least one AHU is ready (partial submission — the
 *                  server completes ready-AHU filters and 422-blocks pending ones).
 *                  When every AHU is pending, only Close (hard block) is shown.
 */
import { useState } from 'react';

export interface AhuFilterRow {
  id: string;
  name: string;
  stage: string;
  done: boolean;
}

export interface AhuCard {
  ahuName: string;
  filters: AhuFilterRow[];
  allAtFinal: boolean;
}

function prettyStageLabel(stage: string): string {
  if (!stage || stage === 'Not started') return stage || 'Not started';
  if (stage === 'CLEANING_CYCLE_COMPLETED') return 'Completed';
  return stage
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(' ');
}

export interface RemainingFiltersDialogProps {
  mode: 'POPUP' | 'INTERLOCK';
  /** One card per AHU involved in the batch (≥1). */
  ahus: AhuCard[];
  /** Batch filters — tagged "(this filter)" wherever they appear. */
  currentFilterIds: string[];
  onContinue?: () => void;
  onCancel: () => void;
  error?: string;
}

export function RemainingFiltersDialog({
  mode,
  ahus,
  currentFilterIds,
  onContinue,
  onCancel,
  error,
}: RemainingFiltersDialogProps) {
  const isInterlock = mode === 'INTERLOCK';
  const [idx, setIdx] = useState(0);
  const count = ahus.length;
  const safeIdx = Math.min(idx, Math.max(0, count - 1));
  const ahu = ahus[safeIdx];
  const currentSet = new Set(currentFilterIds);
  // INTERLOCK: "Complete ready filters" appears only when something can proceed.
  const anyReady = ahus.some((a) => a.allAtFinal);

  // Count only cycles that actually finished (checklist submitted), not filters
  // merely parked at their final stage.
  const doneCount = ahu ? ahu.filters.filter((f) => f.stage === 'CLEANING_CYCLE_COMPLETED').length : 0;

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col">

        {/* Gradient header — amber for POPUP (warning), rose for INTERLOCK (block) */}
        <div
          className={`px-6 py-4 flex items-center gap-3 shrink-0 ${
            isInterlock
              ? 'bg-gradient-to-r from-rose-600 to-rose-700'
              : 'bg-gradient-to-r from-amber-500 to-orange-600'
          }`}
        >
          {isInterlock ? (
            <svg className="w-7 h-7 text-rose-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
            </svg>
          ) : (
            <svg className="w-7 h-7 text-amber-200" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
            </svg>
          )}
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-white">
              {count > 1 ? `${count} AHUs still in progress` : 'Remaining Filters'}
            </h2>
            <p className={`text-sm ${isInterlock ? 'text-rose-100' : 'text-amber-100'}`}>
              {isInterlock
                ? 'AHU interlock — cleaning completion blocked'
                : 'Other filters in this AHU are still in progress'}
            </p>
          </div>
        </div>

        {/* Carousel nav (only when >1 AHU) */}
        {count > 1 && (
          <div className="px-4 py-2 flex items-center justify-between border-b border-slate-100 bg-slate-50 shrink-0">
            <button
              onClick={() => setIdx((i) => (i - 1 + count) % count)}
              className="p-2 rounded-lg hover:bg-slate-200 text-slate-600"
              aria-label="Previous AHU"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M15 19l-7-7 7-7" />
              </svg>
            </button>
            <div className="flex items-center gap-2">
              <span className="text-xs font-semibold text-slate-500">AHU {safeIdx + 1} of {count}</span>
              <div className="flex gap-1">
                {ahus.map((a, i) => (
                  <span
                    key={i}
                    className={`w-2 h-2 rounded-full ${
                      i === safeIdx ? (isInterlock ? 'bg-rose-500' : 'bg-amber-500') : a.allAtFinal ? 'bg-emerald-300' : 'bg-slate-300'
                    }`}
                  />
                ))}
              </div>
            </div>
            <button
              onClick={() => setIdx((i) => (i + 1) % count)}
              className="p-2 rounded-lg hover:bg-slate-200 text-slate-600"
              aria-label="Next AHU"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
              </svg>
            </button>
          </div>
        )}

        {/* Body — the current AHU card */}
        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {ahu && (
            <>
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-base font-bold text-slate-800 truncate">AHU: {ahu.ahuName || '—'}</h3>
                {ahu.allAtFinal ? (
                  <span className="shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">Ready</span>
                ) : (
                  <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${isInterlock ? 'bg-rose-100 text-rose-700' : 'bg-amber-100 text-amber-700'}`}>
                    Blocking
                  </span>
                )}
              </div>

              <div className="flex items-center justify-between text-xs text-slate-500">
                <span className="font-semibold uppercase tracking-wider">Filters under this AHU</span>
                <span>{doneCount}/{ahu.filters.length} completed</span>
              </div>

              {ahu.filters.length > 0 && (
                <ul className="divide-y divide-slate-100 border border-slate-200 rounded-xl overflow-hidden">
                  {ahu.filters.map((f) => {
                    const isCurrent = currentSet.has(f.id);
                    // "Completed" ONLY when the cycle is actually finished
                    // (terminal checklist submitted → CLEANING_CYCLE_COMPLETED).
                    // A filter parked AT its final stage (e.g. Storage Out) with
                    // the checklist still pending is `done` for the interlock
                    // (reached final) but is NOT completed — show its real stage.
                    const isCompleted = f.stage === 'CLEANING_CYCLE_COMPLETED';
                    const atFinal = f.done && !isCompleted; // reached final, checklist pending
                    const rowBg = isCompleted ? 'bg-emerald-50/40' : atFinal ? 'bg-sky-50/40' : 'bg-white';
                    const badge = isCompleted
                      ? 'bg-emerald-100 text-emerald-700'
                      : atFinal
                        ? 'bg-sky-100 text-sky-700'
                        : isInterlock ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700';
                    return (
                      <li
                        key={f.id}
                        className={`flex items-center justify-between px-4 py-2.5 text-sm ${rowBg}`}
                      >
                        <span className="flex items-center gap-2 min-w-0 pr-4">
                          {isCompleted ? (
                            <svg className="w-4 h-4 text-emerald-600 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                            </svg>
                          ) : (
                            <span className={`w-2 h-2 rounded-full shrink-0 ${atFinal ? 'bg-sky-500' : isInterlock ? 'bg-rose-500' : 'bg-amber-500'}`} />
                          )}
                          <span className="font-medium text-slate-800 truncate">{f.name}</span>
                          {isCurrent && (
                            <span className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700">
                              this filter
                            </span>
                          )}
                        </span>
                        <span className={`shrink-0 text-xs font-semibold px-2 py-0.5 rounded-full ${badge}`}>
                          {prettyStageLabel(f.stage)}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </>
          )}

          {error && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">
              {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 shrink-0 flex gap-3">
          {isInterlock ? (
            <>
              <button
                onClick={onCancel}
                className={`py-3 bg-slate-100 text-slate-700 rounded-xl font-medium hover:bg-slate-200 transition-colors ${anyReady ? 'flex-1' : 'flex-1'}`}
              >
                Close
              </button>
              {anyReady && (
                <button
                  onClick={onContinue}
                  className="flex-1 py-3 bg-emerald-600 text-white rounded-xl font-bold hover:bg-emerald-500 transition-colors"
                >
                  Complete ready filters
                </button>
              )}
            </>
          ) : (
            <>
              <button
                onClick={onCancel}
                className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-medium hover:bg-slate-200 transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={onContinue}
                className="flex-1 py-3 bg-amber-500 text-white rounded-xl font-bold hover:bg-amber-400 transition-colors flex items-center justify-center gap-2"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M9 5l7 7-7 7" />
                </svg>
                Continue anyway
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
