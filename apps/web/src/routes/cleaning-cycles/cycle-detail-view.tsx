import { useNavigate } from 'react-router-dom';
import { useDatetimeFormat } from '../../hooks/use-datetime-format';
import { formatByLeastCount } from '@/lib/format-by-least-count';
import { fmtMinutes, effectiveCycleStatus, stageProgress, STAGE_ORDER } from '../../lib/cleaning-cycle-report';

// Presentational constants for a single cleaning-cycle's detail view. Shared by
// the View detail page (timeline.tsx) and the Filter Lifecycle Report
// (filter-lifecycle.tsx) so the two render identically.
const EVENT_ICONS: Record<string, { icon: string; color: string; border: string; bg: string }> = {
  CYCLE_STARTED: { icon: '▶', color: 'text-cyan-600', border: 'border-cyan-500', bg: 'bg-cyan-50' },
  STATE_TRANSITION: { icon: '→', color: 'text-blue-600', border: 'border-blue-500', bg: 'bg-blue-50' },
  PARAMETER_CAPTURE: { icon: '📊', color: 'text-purple-600', border: 'border-purple-500', bg: 'bg-purple-50' },
  CHECKLIST_COMPLETED: { icon: '✓', color: 'text-green-600', border: 'border-green-500', bg: 'bg-green-50' },
  BYPASS_DEVIATION: { icon: '⚠', color: 'text-red-600', border: 'border-red-500', bg: 'bg-red-50' },
  EQUIPMENT_LINKED: { icon: '🔧', color: 'text-amber-600', border: 'border-amber-500', bg: 'bg-amber-50' },
  REMARK_ADDED: { icon: '💬', color: 'text-slate-500', border: 'border-slate-400', bg: 'bg-slate-50' },
  APPROVAL_GRANTED: { icon: '✅', color: 'text-emerald-600', border: 'border-emerald-500', bg: 'bg-emerald-50' },
  CYCLE_COMPLETED: { icon: '●', color: 'text-green-600', border: 'border-green-500', bg: 'bg-green-50' },
};

export const STAGE_LABELS: Record<string, string> = {
  WASH_IN: 'Wash In', WASH_OUT: 'Wash Out', DRY_IN: 'Dry In', DRY_OUT: 'Dry Out',
  STORAGE_IN: 'Storage In', STORAGE_OUT: 'Storage Out', START: 'Start', END: 'End',
};

const STAGE_BADGE: Record<string, string> = {
  WASH_IN: 'bg-sky-50 text-sky-700 border-sky-200',
  WASH_OUT: 'bg-sky-50 text-sky-700 border-sky-200',
  DRY_IN: 'bg-amber-50 text-amber-700 border-amber-200',
  DRY_OUT: 'bg-amber-50 text-amber-200 border-amber-200/40',
  STORAGE_IN: 'bg-slate-100 text-slate-600 border-slate-200',
  STORAGE_OUT: 'bg-slate-100/40 text-slate-700 border-slate-200',
};

// Cycle status badge styling. RETIRED / REPLACED appear when a cycle ended
// because its filter was retired / replaced mid-cleaning.
const CYCLE_STATUS_BADGE: Record<string, { cls: string; label: string }> = {
  COMPLETED: { cls: 'bg-green-50 text-green-700 border border-green-200', label: 'Completed' },
  IN_PROGRESS: { cls: 'bg-blue-50 text-blue-700 border border-blue-200', label: 'In Progress' },
  TERMINATED: { cls: 'bg-red-50 text-red-700 border border-red-200', label: 'Terminated' },
  RETIRED: { cls: 'bg-amber-50 text-amber-700 border border-amber-200', label: 'Retired' },
  REPLACED: { cls: 'bg-purple-50 text-purple-700 border border-purple-200', label: 'Replaced' },
};

const REASON_COLORS: Record<string, string> = {
  PM: 'bg-blue-50 text-blue-700', TYPE_A: 'bg-purple-50 text-purple-700',
  TYPE_B: 'bg-indigo-50 text-indigo-700', TYPE_C: 'bg-sky-50 text-sky-700',
  ON_REQUEST: 'bg-amber-50 text-amber-700', CONTAMINATION: 'bg-red-50 text-red-700',
};

/**
 * Single cleaning-cycle detail: info card (filter / AHU / set / status + grid +
 * pinned versions) + stage progress bar + chronological event timeline (with
 * instrument readings, dryer info, checklist Q&A, deviations, remarks).
 *
 * Renders ONLY the per-cycle content — no page-level scroll/header wrappers, so
 * it drops cleanly into both the full-page detail view and the lifecycle
 * accordion. Requires a cycle fetched from GET /api/filters/cycles/:id (the
 * list endpoint does NOT resolve checklist question text / AHU name / pins).
 */
export function CycleDetailView({ cycle }: { cycle: any }) {
  const navigate = useNavigate();
  const { formatDateTime } = useDatetimeFormat();

  const events = cycle.events ?? [];

  // "Duration" = the dryer duration the operator selected at DRY_IN
  // (cycle.dryerDurationMinutes), NOT the total cycle duration.
  const dryerEvent = events.find((e: any) =>
    e.eventType === 'STATE_TRANSITION' && e.toState === 'DRY_IN' &&
    (e.attributes?.action === 'DRYER_STARTED' || e.attributes?.dryerDurationMinutes != null));
  const dryerMinutes: number | null =
    cycle.dryerDurationMinutes ?? dryerEvent?.attributes?.dryerDurationMinutes ?? null;
  const durationStr = fmtMinutes(dryerMinutes) ?? '—';

  const eff = effectiveCycleStatus(cycle);
  // A manual status update isn't a cycle — render it through this same view
  // (info card + stage bar + event timeline) but badge it "Manual Update"
  // instead of a cycle status.
  const stBadge = cycle._manual
    ? { cls: 'bg-orange-50 text-orange-700 border border-orange-200', label: 'Manual Update' }
    : (CYCLE_STATUS_BADGE[eff] ?? { cls: 'bg-red-50 text-red-700 border border-red-200', label: eff });
  // Stages configured in this cycle's profile (from getCycleById); stages NOT in
  // it render as "NA" in the stage bar.
  const profileStages: string[] = cycle.profileStages ?? [];
  // Reached-stage set + the operator's current stage. Derived structurally from
  // the stage order — DRY_IN transitions twice by design, so transition COUNT
  // cannot be used as a stage index.
  const { reached: reachedStages, current: currentStage } = stageProgress(events, profileStages, eff);

  return (
    <div className="space-y-4">
      {/* Cycle Info Card */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        <div className="p-5">
          <div className="flex items-start justify-between gap-4 mb-4">
            <div>
              <div className="flex items-center gap-3">
                <h2 className="text-xl font-bold text-slate-800">{cycle.filterName ?? 'Filter'}</h2>
                {cycle.ahuName && (
                  <span className="px-2 py-0.5 text-[11px] rounded-full font-medium bg-slate-100 text-slate-600 border border-slate-200">
                    AHU: {cycle.ahuName}
                  </span>
                )}
                {cycle.filterSet && (
                  <span className={`px-2 py-0.5 text-[10px] rounded-full font-medium ${cycle.filterSet === 'SET_A' ? 'bg-indigo-50 text-indigo-700' : 'bg-purple-50 text-purple-700'}`}>
                    Set {cycle.filterSet.replace('SET_', '')}
                  </span>
                )}
                <span className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-medium rounded-full ${stBadge.cls}`}>
                  {eff === 'IN_PROGRESS' && <span className="w-1.5 h-1.5 rounded-full bg-blue-400 animate-pulse" />}
                  {stBadge.label}
                </span>
              </div>
            </div>
          </div>

          {/* Info Grid */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className="bg-slate-50/50 rounded-lg px-3 py-2.5">
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">Cleaning Reason</div>
              <span className={`inline-block px-2 py-0.5 text-xs font-medium rounded-full ${REASON_COLORS[cycle.cleaningReasonKey] ?? 'bg-slate-100 text-slate-600'}`}>
                {cycle.cleaningReasonLabel || cycle.cleaningReasonKey || '—'}
              </span>
            </div>
            <div className="bg-slate-50/50 rounded-lg px-3 py-2.5">
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">Block</div>
              <div className="text-sm text-slate-700 font-medium">{cycle.cleaningAreaName ?? '—'}</div>
            </div>
            <div className="bg-slate-50/50 rounded-lg px-3 py-2.5">
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">Duration</div>
              <div className="text-sm text-slate-700 font-medium">{durationStr}</div>
            </div>
            <div className="bg-slate-50/50 rounded-lg px-3 py-2.5">
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">Started</div>
              <div className="text-sm text-slate-700">{formatDateTime(cycle.startedAt)}</div>
            </div>
            <div className="bg-slate-50/50 rounded-lg px-3 py-2.5">
              <div className="text-[10px] text-slate-400 uppercase tracking-wider mb-0.5">{cycle.completedAt ? 'Completed' : 'Events'}</div>
              <div className="text-sm text-slate-700">{cycle.completedAt ? formatDateTime(cycle.completedAt) : `${events.length} events`}</div>
            </div>
          </div>

          {cycle.cleaningJustification && (
            <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-700 italic">
              {cycle.cleaningJustification}
            </div>
          )}

          {/* Pinned versions (audit replay) — deep-link each to Version History. */}
          {(cycle.profileVersion !== undefined || cycle.equipmentGroupVersionPin || (cycle.checklistVersionPins && Object.keys(cycle.checklistVersionPins ?? {}).length > 0)) && (
            <div className="mt-3 px-3 py-2 bg-indigo-50 border border-indigo-200 rounded-lg">
              <div className="text-[10px] text-indigo-700 uppercase tracking-wider mb-1.5 font-semibold">Pinned Versions (audit replay)</div>
              <div className="flex flex-wrap gap-2 items-center">
                {cycle.profileVersion !== undefined && (
                  <button
                    onClick={() => navigate(`/version-history?entity=cleaning-profile&id=${cycle.profileId}&v=${cycle.profileVersion}`)}
                    className="text-xs px-2 py-1 bg-white border border-indigo-300 hover:border-indigo-500 hover:bg-indigo-50 rounded-md font-medium text-indigo-800 transition-colors"
                    title="Cleaning pipeline pinned at cycle start"
                  >
                    Pipeline v{cycle.profileVersion}
                  </button>
                )}
                {cycle.equipmentGroupVersionPin !== undefined && cycle.equipmentGroupVersionPin !== null && cycle.equipmentGroupId && (
                  <button
                    onClick={() => navigate(`/version-history?entity=equipment-group&id=${cycle.equipmentGroupId}&v=${cycle.equipmentGroupVersionPin}`)}
                    className="text-xs px-2 py-1 bg-white border border-indigo-300 hover:border-indigo-500 hover:bg-indigo-50 rounded-md font-medium text-indigo-800 transition-colors"
                    title="Equipment group ranges pinned at cycle start (P1)"
                  >
                    Equipment v{cycle.equipmentGroupVersionPin}
                  </button>
                )}
                {cycle.checklistVersionPins && Object.entries(cycle.checklistVersionPins).map(([profileId, version]) => (
                  <button
                    key={profileId}
                    onClick={() => navigate(`/version-history?entity=checklist-profile&id=${profileId}&v=${version}`)}
                    className="text-xs px-2 py-1 bg-white border border-indigo-300 hover:border-indigo-500 hover:bg-indigo-50 rounded-md font-medium text-indigo-800 transition-colors"
                    title={`Checklist profile ${(profileId as string).slice(0, 8)}… pinned at cycle start`}
                  >
                    Checklist v{String(version)}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Stage Progress Bar */}
        <div className="border-t border-slate-200 px-5 py-3 bg-slate-50">
          <div className="flex items-center gap-2">
            {STAGE_ORDER.map((stage, i) => {
              // A stage NOT in this cycle's profile is "NA" (not applicable);
              // an in-profile stage not yet reached stays pending/grey. Only mark
              // NA when profileStages is known (non-empty) so unknowns don't lie.
              const notApplicable = profileStages.length > 0 && !profileStages.includes(stage);
              const done = !notApplicable && reachedStages.has(stage);
              // stageProgress() already excludes NA / reached stages.
              const isCurrent = stage === currentStage;
              return (
                <div key={stage} className="flex items-center gap-2 flex-1">
                  <div title={notApplicable ? "Not in this cycle's cleaning profile" : undefined} className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-medium flex-1 justify-center transition-all ${
                    notApplicable ? 'bg-slate-100 text-slate-400 border border-slate-200 line-through'
                    : done ? (STAGE_BADGE[stage] ?? 'bg-slate-100 text-slate-600') + ' border'
                    : isCurrent ? 'bg-blue-50 text-blue-700 border border-blue-200 animate-pulse'
                    : 'bg-slate-50 text-slate-300 border border-slate-200'
                  }`}>
                    {done && <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>}
                    {STAGE_LABELS[stage]}{notApplicable ? ' · NA' : ''}
                  </div>
                  {i < 5 && <div className={`w-3 h-0.5 shrink-0 ${done ? 'bg-slate-200' : 'bg-white'}`} />}
                </div>
              );
            })}
            {/* Cycle ended by retire/replace → terminal chip after the last stage. */}
            {(eff === 'REPLACED' || eff === 'RETIRED') && (
              <div className="flex items-center gap-2 shrink-0">
                <div className="w-3 h-0.5 shrink-0 bg-slate-200" />
                <div className={`flex items-center gap-1.5 px-2 py-1 rounded-lg text-[10px] font-bold justify-center border ${eff === 'RETIRED' ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-purple-50 text-purple-700 border-purple-200'}`}>
                  {eff === 'RETIRED' ? 'Retired' : 'Replaced'}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Event Timeline */}
      <div className="space-y-0">
        {events.map((event: any, i: number) => {
          const style = EVENT_ICONS[event.eventType] ?? EVENT_ICONS.REMARK_ADDED;
          const attrs = event.attributes ?? {};
          const instrumentReadings: any[] = attrs.instrumentReadings ?? [];
          const hasReadings = instrumentReadings.length > 0;

          // Dryer keys get a dedicated formatted panel below; clientOpId is internal.
          // `checklists` (full questions+answers snapshot) is rendered as the
          // "Checklist Responses" section below, not dumped as raw JSON.
          // `offlinePerformedAt` is internal bookkeeping — the formatted submit
          // time is already shown in the event header (performedAt).
          // Approval events carry internal bookkeeping (kind / approvalId UUID /
          // attemptSeq) + the stageKey; the stage is surfaced as a clean badge
          // below, the rest is noise the reader doesn't need.
          const displayAttrs = Object.entries(attrs).filter(
            ([k]) => !['cleaningReasonKey', 'cleaningReasonLabel', 'instrumentReadings', 'sequenceNumber', 'answers', 'afterStage', 'action', 'dryerDurationMinutes', 'dryerStartedAt', 'clientOpId', 'checklists', 'offlinePerformedAt', 'kind', 'stageKey', 'approvalId', 'attemptSeq'].includes(k)
          );
          const enrichedAnswers: { questionId: string; question: string; answer: any }[] = event.enrichedAnswers ?? [];

          return (
            <div key={event.id} className="flex gap-4">
              {/* Timeline connector */}
              <div className="flex flex-col items-center w-5 shrink-0">
                <div className={`w-4 h-4 rounded-full border-2 shrink-0 mt-1 ${
                  event.eventType === 'CYCLE_STARTED' ? 'border-cyan-500 bg-cyan-500 shadow-sm shadow-cyan-500/30'
                  : event.eventType === 'CYCLE_COMPLETED' ? 'border-green-500 bg-green-500 shadow-sm shadow-green-500/30'
                  : event.eventType === 'BYPASS_DEVIATION' ? 'border-red-500 bg-red-500 shadow-sm shadow-red-500/30'
                  : i === events.length - 1 && cycle.status === 'IN_PROGRESS' ? 'border-blue-400 bg-blue-400 animate-pulse shadow-sm shadow-blue-500/30'
                  : 'border-blue-500 bg-blue-500'
                }`} />
                {i < events.length - 1 && <div className="w-0.5 flex-1 bg-slate-100/80 min-h-[24px]" />}
              </div>

              {/* Event Card */}
              <div className={`flex-1 mb-4 rounded-xl border-l-4 p-4 ${style.border} ${style.bg}`}>
                {/* Event Header */}
                <div className="flex items-center justify-between mb-2">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-slate-800">
                      {event.eventType.replace(/_/g, ' ')}
                    </span>
                    {event.performedByName && (
                      <span className="text-[11px] text-slate-400 bg-white px-2 py-0.5 rounded-full">
                        by {event.performedByName}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-slate-400 tabular-nums">{formatDateTime(event.performedAt)}</span>
                </div>

                {/* State Transition. A transition with no fromState is the
                    "genesis" move — the filter entering its first cleaning
                    stage from the pre-cycle lifecycle state, shown as
                    "To Be Cleaned". */}
                {(event.fromState || event.toState) && (
                  <div className="flex items-center gap-2 mb-2">
                    {event.toState && (
                      <span className="px-2 py-0.5 text-xs rounded-md bg-white text-slate-500">
                        {event.fromState ? (STAGE_LABELS[event.fromState] ?? event.fromState.replace(/_/g, ' ')) : 'To Be Cleaned'}
                      </span>
                    )}
                    {event.fromState && !event.toState && (
                      <span className="px-2 py-0.5 text-xs rounded-md bg-white text-slate-500">
                        {STAGE_LABELS[event.fromState] ?? event.fromState.replace(/_/g, ' ')}
                      </span>
                    )}
                    {event.toState && (
                      <svg className="w-4 h-4 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 7l5 5m0 0l-5 5m5-5H6" />
                      </svg>
                    )}
                    {event.toState && (
                      <span className={`px-2.5 py-0.5 text-xs font-medium rounded-md border ${STAGE_BADGE[event.toState] ?? 'bg-slate-100 text-slate-600 border-slate-300'}`}>
                        {STAGE_LABELS[event.toState] ?? event.toState.replace(/_/g, ' ')}
                      </span>
                    )}
                  </div>
                )}

                {/* Dryer info (DRY_IN SET_DURATION event): selected dryer duration
                    + the time the operator submitted it. */}
                {(attrs.action === 'DRYER_STARTED' || attrs.dryerDurationMinutes != null) && (
                  <div className="flex flex-wrap items-center gap-2 mb-2">
                    <span className="px-2.5 py-0.5 text-xs font-medium rounded-md bg-amber-50 text-amber-700 border border-amber-200">
                      Dryer Duration: {fmtMinutes(attrs.dryerDurationMinutes) ?? '—'}
                    </span>
                    {attrs.dryerStartedAt && (
                      <span className="px-2.5 py-0.5 text-xs font-medium rounded-md bg-amber-50 text-amber-700 border border-amber-200">
                        Started: {formatDateTime(attrs.dryerStartedAt)}
                      </span>
                    )}
                  </div>
                )}

                {/* Stage interlock approval — show the approved stage cleanly,
                    not the raw approvalId / attemptSeq / kind (internal). */}
                {event.eventType === 'APPROVAL_GRANTED' && attrs.stageKey && (
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-slate-400">Approved stage:</span>
                    <span className="px-2.5 py-0.5 text-xs font-medium rounded-md border bg-emerald-50 text-emerald-700 border-emerald-200">
                      {STAGE_LABELS[attrs.stageKey] ?? String(attrs.stageKey).replace(/_/g, ' ')}
                    </span>
                  </div>
                )}

                {/* Cleaning Reason (for CYCLE_STARTED) */}
                {event.eventType === 'CYCLE_STARTED' && (attrs.cleaningReasonKey || cycle.cleaningReasonKey) && (
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-xs text-slate-400">Reason:</span>
                    <span className={`px-2.5 py-0.5 text-xs font-medium rounded-full ${
                      REASON_COLORS[attrs.cleaningReasonKey ?? cycle.cleaningReasonKey] ?? 'bg-slate-100 text-slate-600'
                    }`}>
                      {attrs.cleaningReasonLabel ?? cycle.cleaningReasonLabel ?? attrs.cleaningReasonKey ?? cycle.cleaningReasonKey}
                    </span>
                  </div>
                )}

                {/* Instrument Readings */}
                {hasReadings && (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-slate-400 uppercase tracking-wider font-medium">Instrument Readings</div>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                      {instrumentReadings.map((reading: any, ri: number) => (
                        <div key={ri} className="bg-white border border-slate-200 rounded-lg px-3 py-2.5">
                          <div className="text-[11px] text-slate-400 mb-1">{reading.description || reading.instrumentCode || `Instrument ${ri + 1}`}</div>
                          <div className="flex items-baseline gap-1.5">
                            <span className="text-lg font-bold text-slate-800 tabular-nums">{reading.leastCount !== undefined && reading.leastCount !== null ? formatByLeastCount(reading.value, reading.leastCount) : reading.value}</span>
                            <span className="text-xs text-slate-500">{reading.uom || reading.unit || ''}</span>
                          </div>
                          {reading.instrumentCode && reading.description && (
                            <div className="text-[10px] text-slate-300 mt-0.5 font-mono">{reading.instrumentCode}</div>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Checklist Answers */}
                {enrichedAnswers.length > 0 && (
                  <div className="mt-3 space-y-2">
                    <div className="text-xs text-slate-400 uppercase tracking-wider font-medium">Checklist Responses</div>
                    <div className="space-y-1.5">
                      {enrichedAnswers.map((qa, qi) => (
                        <div key={qa.questionId} className="bg-white border border-slate-200 rounded-lg px-3 py-2.5 flex items-start gap-3">
                          <span className="text-[11px] text-slate-400 font-medium mt-0.5 shrink-0">{qi + 1}.</span>
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] text-slate-700">{qa.question}</div>
                            <div className="text-[13px] font-semibold text-slate-900 mt-0.5">
                              {typeof qa.answer === 'boolean' ? (qa.answer ? 'Yes' : 'No') : String(qa.answer)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Deviation Details */}
                {event.deviationDetails && (
                  <div className="mt-2 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                    Deviation: {(event.deviationDetails as any).justification || JSON.stringify(event.deviationDetails)}
                  </div>
                )}

                {/* Remarks */}
                {event.remarks && (
                  <div className="text-sm text-slate-500 italic mt-2">{event.remarks}</div>
                )}

                {/* Other Attributes — never dump raw objects as JSON; render
                    timestamps in the configured local time, not raw UTC ISO. */}
                {(() => {
                  const shown = displayAttrs.filter(([, v]) => v !== null && v !== undefined && typeof v !== 'object');
                  if (shown.length === 0) return null;
                  const isIsoDate = (s: any) => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s);
                  return (
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {shown.map(([k, v]: [string, any]) => (
                        <span key={k} className="px-2 py-0.5 text-[11px] bg-white border border-slate-200 rounded-md text-slate-500">
                          {k}: {isIsoDate(v) ? formatDateTime(v) : String(v)}
                        </span>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
