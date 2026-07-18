import { useState, useEffect, useRef } from 'react';
import { formatByLeastCount } from '@/lib/format-by-least-count';
import { apiClient } from '@/lib/api-client';

interface EquipmentDialogProps {
  dialog: {
    filterId: string;
    filterName: string;
    stage: { key: string; label: string; color: string };
    groups: any[];
    cycleEquipmentGroup?: any;
    block?: { id: string; name: string };
  } | null;
  onClose: () => void;
  onSubmit: (groupId: string, readings: Record<string, number>) => void;
  loading: boolean;
  error: string;
  // Auto-fetch is an ONLINE-only convenience. Offline, every instrument falls
  // back to the original manual flow (stepped dropdown from operatingMin/Max +
  // leastCount) regardless of its autoFetchEnabled flag — the server proxy is
  // unreachable, so there's nothing to fetch. See instrument-autofetch plan P5.
  online: boolean;
}

type ReadingSource = 'MANUAL' | 'AUTO' | 'AUTO_OVERRIDDEN';

// Auto-fetch retry budget (2026-06-13): poll the server proxy for up to ~2
// minutes (two 1-min windows) before falling back to manual entry per the spec.
const FETCH_BUDGET_MS = 120_000;
const FETCH_INTERVAL_MS = 5_000;

function generateReadingOptions(opMin: number, opMax: number, leastCount: number): number[] {
  const options: number[] = [];
  if (leastCount <= 0 || opMin >= opMax) return options;
  for (let v = opMin, i = 0; v <= opMax + 1e-9 && i < 10000; v = Math.round((v + leastCount) * 1e10) / 1e10, i++) {
    options.push(v);
  }
  return options;
}

export function EquipmentDialog({ dialog, onClose, onSubmit, loading, error, online }: EquipmentDialogProps) {
  const [selectedEquipmentGroup, setSelectedEquipmentGroup] = useState<any>(null);
  const [instrumentReadings, setInstrumentReadings] = useState<Record<string, number>>({});
  const [source, setSource] = useState<Record<string, ReadingSource>>({});
  const [internalError, setInternalError] = useState('');
  // Auto-fetch state.
  const [fetching, setFetching] = useState(false);
  const [fetchStatus, setFetchStatus] = useState('');
  const [pendingAuto, setPendingAuto] = useState<Set<string>>(new Set());
  const cancelRef = useRef(false);

  // Reset internal state when dialog opens/closes. Cleanup aborts any in-flight
  // fetch loop when the dialog is dismissed (the dialog prop goes null).
  useEffect(() => {
    if (dialog) {
      setSelectedEquipmentGroup(dialog.cycleEquipmentGroup ?? null);
      setInstrumentReadings({});
      setSource({});
      setInternalError('');
      setFetching(false);
      setFetchStatus('');
      setPendingAuto(new Set());
      cancelRef.current = false;
    }
    return () => { cancelRef.current = true; };
  }, [dialog]);

  if (!dialog) return null;

  const displayError = error || internalError;

  const stageInstrumentsOf = (group: any): any[] =>
    (group?.instruments ?? []).filter((i: any) => i.stageKey === dialog.stage.key);

  // Effective auto = configured for auto-fetch AND currently online. Offline the
  // instrument reverts to the manual stepped-dropdown flow (old process).
  const isAutoInstrument = (i: any): boolean => i.autoFetchEnabled === true && online;

  const hasAuto = stageInstrumentsOf(selectedEquipmentGroup).some(isAutoInstrument);

  // Mark a value the operator typed/picked. If it was auto-filled, an edit flips
  // provenance to AUTO_OVERRIDDEN (never silently stays AUTO).
  const setManualReading = (instId: string, raw: string) => {
    setInstrumentReadings(prev => {
      const next = { ...prev };
      const n = Number(raw);
      if (raw === '' || Number.isNaN(n)) delete next[instId];
      else next[instId] = n;
      return next;
    });
    setSource(prev => ({ ...prev, [instId]: (prev[instId] === 'AUTO' || prev[instId] === 'AUTO_OVERRIDDEN') ? 'AUTO_OVERRIDDEN' : 'MANUAL' }));
    setInternalError('');
  };

  const sleep = (ms: number) => new Promise<void>(res => setTimeout(res, ms));

  // "Get Values": poll the SSRF-hardened server proxy and fill each auto
  // instrument as its value arrives. Retries the still-pending ones for up to
  // ~2 minutes, then leaves them empty for manual entry. Aborts on dialog close.
  const handleGetValues = async () => {
    if (!selectedEquipmentGroup || fetching) return;
    const autoIds = stageInstrumentsOf(selectedEquipmentGroup).filter(isAutoInstrument).map((i: any) => i.id);
    if (autoIds.length === 0) return;

    cancelRef.current = false;
    setFetching(true);
    const pending = new Set<string>(autoIds);
    setPendingAuto(new Set(pending));
    setFetchStatus(`Fetching ${autoIds.length} reading(s)…`);
    const start = Date.now();
    try {
      while (pending.size > 0 && (Date.now() - start) < FETCH_BUDGET_MS) {
        if (cancelRef.current) return;
        let res: any = null;
        try {
          res = await apiClient.post<any>('/api/equipment-groups/fetch-readings', {
            filterId: dialog.filterId,
            groupId: selectedEquipmentGroup.id,
            stageKey: dialog.stage.key,
          });
        } catch { res = null; }
        if (cancelRef.current) return;
        for (const r of (res?.results ?? [])) {
          if (r?.ok && typeof r.value === 'number' && pending.has(r.instrumentId)) {
            const val = r.value;
            setInstrumentReadings(prev => ({ ...prev, [r.instrumentId]: val }));
            setSource(prev => ({ ...prev, [r.instrumentId]: 'AUTO' }));
            pending.delete(r.instrumentId);
          }
        }
        setPendingAuto(new Set(pending));
        if (pending.size === 0) break;
        setFetchStatus(`Got ${autoIds.length - pending.size}/${autoIds.length}. Retrying the rest…`);
        await sleep(FETCH_INTERVAL_MS);
      }
    } finally {
      if (!cancelRef.current) {
        setFetching(false);
        setFetchStatus(pending.size > 0
          ? `${pending.size} reading(s) couldn't be fetched — enter them manually below.`
          : 'All readings fetched.');
      }
    }
  };

  const handleSubmit = () => {
    if (!selectedEquipmentGroup) {
      setInternalError('Please select an equipment group');
      return;
    }
    const insts = stageInstrumentsOf(selectedEquipmentGroup);
    for (const inst of insts) {
      if (instrumentReadings[inst.id] === undefined) {
        setInternalError(`Please enter a value for ${inst.description}`);
        return;
      }
    }
    // Out-of-range readings are allowed, but the operator must confirm — the
    // value is then recorded as a deviation on the server.
    const oos = insts.filter((i: any) => {
      const v = instrumentReadings[i.id];
      return v !== undefined && (v < i.operatingMin || v > i.operatingMax);
    });
    if (oos.length > 0) {
      const lines = oos.map((i: any) => `• ${i.description}: ${instrumentReadings[i.id]} ${i.uom} (range ${i.operatingMin}–${i.operatingMax})`).join('\n');
      if (!window.confirm(`These readings are OUTSIDE the operating range:\n\n${lines}\n\nSubmit anyway?`)) return;
    }
    setInternalError('');
    onSubmit(selectedEquipmentGroup.id, instrumentReadings);
  };

  const isDryer = dialog.stage.key === 'DRY_IN';
  const submitDisabled = loading || fetching || !selectedEquipmentGroup ||
    stageInstrumentsOf(selectedEquipmentGroup).some((i: any) => instrumentReadings[i.id] === undefined);

  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[55] p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-lg max-h-[85vh] overflow-hidden flex flex-col">
        <div className={`bg-gradient-to-r ${isDryer ? 'from-amber-600 to-amber-700' : 'from-sky-600 to-sky-700'} px-6 py-4 shrink-0`}>
          <h2 className="text-lg font-bold text-white">
            {isDryer ? 'Dryer Temperature Reading' : 'Equipment & Pressure Readings'}
          </h2>
          <p className="text-white/70 text-sm">{dialog.filterName} &rarr; {dialog.stage.label}</p>
        </div>
        <div className="p-6 space-y-4 overflow-y-auto flex-1">
          {/* Equipment Group Selection (only when not pre-bound to the cycle's group) */}
          {!dialog.cycleEquipmentGroup && (
            <>
              <div className="text-sm text-slate-500 mb-1">Select Equipment Group:</div>
              <div className="space-y-2">
                {dialog.groups.map((g: any) => (
                  <button key={g.id} onClick={() => { setSelectedEquipmentGroup(g); setInstrumentReadings({}); setSource({}); setInternalError(''); setFetchStatus(''); setPendingAuto(new Set()); }}
                    className={`w-full text-left px-4 py-3 rounded-xl transition-all ${selectedEquipmentGroup?.id === g.id ? 'bg-cyan-50 border-2 border-cyan-500' : 'bg-slate-100 border-2 border-transparent hover:border-slate-300'}`}>
                    <div className="text-sm font-medium text-slate-800">{g.name}</div>
                    <div className="text-xs text-slate-400 mt-0.5">
                      {g.instruments?.map((i: any) => i.instrumentId).join(', ')}
                    </div>
                  </button>
                ))}
              </div>
            </>
          )}

          {/* Instrument Readings */}
          {selectedEquipmentGroup && (
            <div className="space-y-4 mt-2">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-slate-500">
                  {isDryer ? 'Record dryer temperature:' : 'Record pressure readings:'}
                </div>
                {hasAuto && (
                  <button type="button" onClick={handleGetValues} disabled={fetching}
                    className="flex items-center gap-2 px-3 py-1.5 text-xs font-semibold rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50 transition-colors shrink-0">
                    {fetching
                      ? <div className="w-3.5 h-3.5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      : <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}
                    {fetching ? 'Fetching…' : 'Get Values'}
                  </button>
                )}
              </div>
              {hasAuto && fetchStatus && (
                <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">{fetchStatus}</div>
              )}

              {stageInstrumentsOf(selectedEquipmentGroup).map((inst: any) => {
                const val = instrumentReadings[inst.id];
                const src = source[inst.id];
                const outOfRange = val !== undefined && (val < inst.operatingMin || val > inst.operatingMax);
                const auto = isAutoInstrument(inst);
                const isWaiting = fetching && pendingAuto.has(inst.id);
                const options = auto ? [] : generateReadingOptions(inst.operatingMin, inst.operatingMax, inst.leastCount);
                return (
                  <div key={inst.id} className="bg-slate-50 border border-slate-200 rounded-xl p-4 space-y-2">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium text-slate-700">{inst.description}</span>
                        <span className="text-xs text-slate-400 font-mono">{inst.instrumentId}</span>
                        {src === 'AUTO' && <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-cyan-50 border border-cyan-200 text-cyan-700">Auto</span>}
                        {src === 'AUTO_OVERRIDDEN' && <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-amber-50 border border-amber-200 text-amber-700">Auto · edited</span>}
                      </div>
                      <span className="text-xs text-slate-400">{formatByLeastCount(inst.operatingMin, inst.leastCount)}–{formatByLeastCount(inst.operatingMax, inst.leastCount)} {inst.uom}</span>
                    </div>

                    {auto ? (
                      // Auto-fetch instrument: free numeric input so it can hold the
                      // API value (which may be off-step or out of range) and still
                      // serve as the manual fallback.
                      <div className="flex items-center gap-2">
                        <input
                          type="number" step="any" inputMode="decimal"
                          value={val ?? ''}
                          onChange={e => setManualReading(inst.id, e.target.value)}
                          placeholder={isWaiting ? 'Fetching…' : 'Enter or fetch value'}
                          className={`w-full bg-white border rounded-lg px-3 py-2.5 text-slate-800 text-sm outline-none ${outOfRange ? 'border-amber-400 focus:border-amber-500' : 'border-slate-300 focus:border-cyan-500'}`}
                        />
                        <span className="text-xs text-slate-400 shrink-0">{inst.uom}</span>
                      </div>
                    ) : (
                      <select
                        value={val ?? ''}
                        onChange={e => setManualReading(inst.id, e.target.value)}
                        className="w-full bg-white border border-slate-300 rounded-lg px-3 py-2.5 text-slate-800 text-sm focus:border-cyan-500 outline-none">
                        <option value="">Select value...</option>
                        {options.map((v) => (
                          <option key={v} value={v}>{formatByLeastCount(v, inst.leastCount)} {inst.uom}</option>
                        ))}
                      </select>
                    )}

                    {outOfRange && (
                      <div className="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">
                        {formatByLeastCount(val!, inst.leastCount)} {inst.uom} is out of the operating range ({formatByLeastCount(inst.operatingMin, inst.leastCount)}–{formatByLeastCount(inst.operatingMax, inst.leastCount)}). You can submit after confirming.
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}

          {displayError && (
            <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{displayError}</div>
          )}
        </div>
        <div className="px-6 py-4 border-t border-slate-200 flex gap-3 shrink-0">
          <button onClick={onClose}
            className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl">Cancel</button>
          <button onClick={handleSubmit} disabled={submitDisabled}
            className={`flex-1 py-3 text-white rounded-xl font-bold disabled:opacity-40 flex items-center justify-center gap-2 transition-colors ${isDryer ? 'bg-amber-600 hover:bg-amber-500' : 'bg-cyan-600 hover:bg-cyan-500'}`}>
            {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> :
              <><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>Submit</>}
          </button>
        </div>
      </div>
    </div>
  );
}
