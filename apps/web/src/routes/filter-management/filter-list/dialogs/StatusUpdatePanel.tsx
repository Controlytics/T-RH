import { useState, useEffect } from 'react';
import useSWR from 'swr';
import { STATUS_LABELS, LIFECYCLE_STATE_OPTIONS } from '../constants';
import type { StatusPanelFilter } from '../types';

type Props = {
  filter: StatusPanelFilter;
  state: string;
  remarks: string;
  submitting: boolean;
  onStateChange: (v: string) => void;
  onRemarksChange: (v: string) => void;
  onClose: () => void;
  onSubmit: (extra?: { cleaningReasonKey?: string; cleaningJustification?: string }) => void;
};

type StageOption = {
  state: string;
  classification: 'SAME' | 'COMPLETE' | 'NON_CLEANING' | 'START' | 'FORWARD' | 'BACKWARD' | 'SKIP';
  allowed: boolean;
  isCurrent: boolean;
  startsCycle: boolean;
};
type CleaningReason = { key: string; name: string; requiresJustification?: boolean };
type StageOptionsResp = {
  hasProfile: boolean;
  hasActiveCycle: boolean;
  profileName: string | null;
  currentStage: string | null;
  orderedStages: string[];
  immediateNext: string[];
  options: StageOption[];
  cleaningReasons: CleaningReason[];
};

const labelFor = (value: string) =>
  LIFECYCLE_STATE_OPTIONS.find((o) => o.value === value)?.label
  ?? STATUS_LABELS[value]?.label
  ?? value.replace(/_/g, ' ');

export function StatusUpdatePanel({
  filter, state, remarks, submitting,
  onStateChange, onRemarksChange, onClose, onSubmit,
}: Props) {
  // P1: constrain the manual status move to the filter's cleaning-profile
  // sequence — same rules the tablet enforces. The server validates too.
  const { data: stageOpts } = useSWR<StageOptionsResp>(
    filter.id ? `/api/filters/${filter.id}/stage-options` : null,
  );

  // P3: when the chosen move starts/restarts a cleaning cycle, the operator must
  // pick a cleaning reason (and a justification if that reason requires one).
  const [reasonKey, setReasonKey] = useState('');
  const [justification, setJustification] = useState('');
  // Reset reason inputs whenever the target state changes.
  useEffect(() => { setReasonKey(''); setJustification(''); }, [state]);

  const profileOptions = stageOpts?.hasProfile ? stageOpts.options : null;
  const selectedOpt = profileOptions?.find((o) => o.state === state) ?? null;
  const isSkip = selectedOpt?.classification === 'SKIP';
  const isBackward = selectedOpt?.classification === 'BACKWARD';
  const startsCycle = selectedOpt?.startsCycle ?? false;
  const sameAsCurrent = state === (filter.currentState ?? '');

  const reasons = stageOpts?.cleaningReasons ?? [];
  const chosenReason = reasons.find((r) => r.key === reasonKey) ?? null;
  const needsJustification = !!chosenReason?.requiresJustification;
  const reasonIncomplete = startsCycle && (!reasonKey || (needsJustification && justification.trim().length < 10));

  const submitDisabled = !remarks.trim() || sameAsCurrent || submitting || isSkip || reasonIncomplete;

  return (
    <>
      <div className="fixed inset-0 bg-black/20 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 h-full w-96 bg-white shadow-2xl z-50 flex flex-col border-l border-slate-200 animate-in slide-in-from-right">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <h3 className="text-lg font-semibold text-slate-800">Update Filter Status</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Filter ID</label>
            <input type="text" value={filter.name} readOnly className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-slate-50 text-slate-700 text-sm" />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">Current Status</label>
            <input
              type="text"
              value={filter.currentState ? (STATUS_LABELS[filter.currentState]?.label ?? filter.currentState.replace(/_/g, ' ')) : 'To Be Cleaned'}
              readOnly
              className="w-full px-3 py-2 border border-slate-200 rounded-lg bg-slate-50 text-slate-700 text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              New Status <span className="text-red-500">*</span>
            </label>
            <select
              value={state}
              onChange={e => onStateChange(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            >
              <option value="" disabled>Select status…</option>
              {profileOptions
                ? profileOptions.map(opt => (
                    <option key={opt.state} value={opt.state} disabled={opt.isCurrent}>
                      {labelFor(opt.state)}
                      {opt.isCurrent ? ' (current)' : opt.classification === 'SKIP' ? ' — out of sequence' : opt.classification === 'BACKWARD' ? ' (back)' : ''}
                    </option>
                  ))
                : LIFECYCLE_STATE_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
            </select>
            {stageOpts?.hasProfile && stageOpts.profileName && (
              <p className="mt-1 text-xs text-slate-400">Cleaning profile: {stageOpts.profileName}</p>
            )}
          </div>

          {isSkip && (
            <div className="rounded-lg p-3 text-xs bg-red-50 text-red-700 border border-red-200">
              Invalid stage movement. Please follow the configured cleaning profile sequence.
            </div>
          )}
          {isBackward && stageOpts?.hasActiveCycle && (
            <div className="rounded-lg p-3 text-xs bg-amber-50 text-amber-700 border border-amber-200">
              Moving <strong>backward</strong> will close the current cleaning cycle as <strong>interrupted</strong> and start a new cycle from this stage.
            </div>
          )}
          {startsCycle && !(isBackward && stageOpts?.hasActiveCycle) && (
            <div className="rounded-lg p-3 text-xs bg-amber-50 text-amber-700 border border-amber-200">
              This will start a new cleaning cycle.
            </div>
          )}
          {sameAsCurrent && state !== '' && (
            <div className="rounded-lg p-3 text-xs bg-amber-50 text-amber-700 border border-amber-200">
              Please select a different status from the current one.
            </div>
          )}

          {startsCycle && (
            <>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">
                  Cleaning Reason <span className="text-red-500">*</span>
                </label>
                <select
                  value={reasonKey}
                  onChange={e => setReasonKey(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 bg-white focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                >
                  <option value="" disabled>Select reason…</option>
                  {reasons.map(r => (
                    <option key={r.key} value={r.key}>{r.name}</option>
                  ))}
                </select>
              </div>
              {needsJustification && (
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">
                    Justification <span className="text-red-500">*</span>
                  </label>
                  <textarea
                    value={justification}
                    onChange={e => setJustification(e.target.value)}
                    placeholder="Min 10 characters…"
                    rows={3}
                    className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                  />
                </div>
              )}
            </>
          )}

          <div>
            <label className="block text-sm font-medium text-slate-600 mb-1">
              Remarks <span className="text-red-500">*</span>
            </label>
            <textarea
              value={remarks}
              onChange={e => onRemarksChange(e.target.value)}
              placeholder="Enter reason for status change..."
              rows={4}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-700 resize-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
            />
          </div>

          <div className="rounded-lg p-3 text-xs bg-blue-50 text-blue-700 border border-blue-200">
            Moving filter manually. Continuing will require your password confirmation.
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center gap-3">
          <button
            onClick={onClose}
            className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSubmit(startsCycle ? { cleaningReasonKey: reasonKey, cleaningJustification: justification.trim() || undefined } : undefined)}
            disabled={submitDisabled}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Processing...' : 'Update Status'}
          </button>
        </div>
      </div>
    </>
  );
}
