import { useState, useRef, useCallback, useEffect } from 'react';
import { apiClient } from '@/lib/api-client';
import { getCachedData } from '@/lib/offline-store';

interface QueueItem {
  filterId: string;
  filterName: string;
  tagId: string;
}

interface StageScanDialogProps {
  activeStage: {
    key: string;
    label: string;
    icon: string;
    color: string;
    border: string;
    needsBlock: boolean;
  } | null;
  step: 'block' | 'scan';
  blocks: any[];
  selectedBlock: any;
  scanValue: string;
  remarks: string;
  error: string;
  loading: boolean;
  queue: QueueItem[];
  addingToQueue: boolean;
  onScanValueChange: (value: string) => void;
  onRemarksChange: (value: string) => void;
  onClearError: () => void;
  onBlockSelect: (block: any) => void;
  onChangeBlock: () => void;
  onAddToQueue: (tagOrName: string) => void;
  onRemoveFromQueue: (filterId: string) => void;
  onSubmitBatch: () => void;
  onClose: () => void;
  fullPage?: boolean;
  instances?: any[]; // cached instances for offline parent name lookup
}

export function StageScanDialog({
  activeStage,
  step,
  blocks,
  selectedBlock,
  scanValue,
  remarks,
  error,
  loading,
  queue,
  addingToQueue,
  onScanValueChange,
  onRemarksChange,
  onClearError,
  onBlockSelect,
  onChangeBlock,
  onAddToQueue,
  onRemoveFromQueue,
  onSubmitBatch,
  onClose,
  fullPage = false,
  instances = [],
}: StageScanDialogProps) {
  // RFID: detected tag waiting for Continue/Remove
  const [rfidDetected, setRfidDetected] = useState<string | null>(null);
  const [filterInfo, setFilterInfo] = useState<{ name: string; parentName: string } | null>(null);
  const [lookingUp, setLookingUp] = useState(false);
  const rfidTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset RFID state when dialog opens/closes
  useEffect(() => {
    if (!activeStage) {
      setRfidDetected(null);
      setFilterInfo(null);
    }
  }, [activeStage]);

  // When tag is detected, look up filter details (API first, then cached identifier map)
  const lookupFilter = useCallback(async (tagId: string) => {
    setLookingUp(true);
    setFilterInfo(null);
    // 1. Try API
    try {
      const lookup = await apiClient.get<any>(`/api/assets/identifiers/lookup/${encodeURIComponent(tagId)}`);
      if (lookup?.asset) {
        setFilterInfo({
          name: lookup.asset.name || 'Unknown',
          parentName: lookup.asset.parent?.name || '—',
        });
        setLookingUp(false);
        return;
      }
    } catch { /* offline or network error — fall through */ }
    // 2. Try cached identifier map from IndexedDB
    try {
      const identifierMap = await getCachedData<Record<string, { filterId: string; filterName: string }>>('identifier-map');
      if (identifierMap) {
        const entry = identifierMap[tagId] || identifierMap[tagId.toUpperCase()] || identifierMap[tagId.toLowerCase()];
        if (entry) {
          // Look up parent (AHU) name from cached instances
          let parentName = '—';
          const filterInstance = instances.find((i: any) => i.id === entry.filterId);
          if (filterInstance?.parentId) {
            const parent = instances.find((i: any) => i.id === filterInstance.parentId);
            if (parent) parentName = parent.name;
          }
          setFilterInfo({ name: entry.filterName, parentName });
          setLookingUp(false);
          return;
        }
      }
    } catch { /* IndexedDB error — fall through */ }
    // 3. Try matching by filter name in cached instances
    const match = instances.find((i: any) => i.name?.toLowerCase() === tagId.toLowerCase());
    if (match) {
      let parentName = '—';
      if (match.parentId) {
        const parent = instances.find((i: any) => i.id === match.parentId);
        if (parent) parentName = parent.name;
      }
      setFilterInfo({ name: match.name, parentName });
      setLookingUp(false);
      return;
    }
    setFilterInfo(null);
    setLookingUp(false);
  }, [instances]);

  // Handle input — detect RFID burst (input stops for 300ms = one tag complete)
  const handleScanInput = useCallback((value: string) => {
    if (rfidDetected) return; // already have a tag, ignore

    onScanValueChange(value);
    onClearError();

    // After 300ms of no new input, tag is complete
    if (rfidTimerRef.current) clearTimeout(rfidTimerRef.current);
    rfidTimerRef.current = setTimeout(() => {
      let tag = value.trim().toUpperCase();
      if (tag.length < 3) return;

      // Deduplicate: if the reader scanned the same tag multiple times rapidly,
      // the value will be the tag ID repeated (e.g., "ABCD1234ABCD1234").
      // Detect this by checking if the first half equals the second half.
      if (tag.length >= 6 && tag.length % 2 === 0) {
        const half = tag.length / 2;
        if (tag.substring(0, half) === tag.substring(half)) {
          tag = tag.substring(0, half);
        }
      }
      // Also handle 3x repeated
      if (tag.length >= 9 && tag.length % 3 === 0) {
        const third = tag.length / 3;
        if (tag.substring(0, third) === tag.substring(third, third * 2) && tag.substring(0, third) === tag.substring(third * 2)) {
          tag = tag.substring(0, third);
        }
      }

      setRfidDetected(tag);
      onScanValueChange(tag);
      lookupFilter(tag);
    }, 300);
  }, [rfidDetected, onScanValueChange, onClearError, lookupFilter]);

  const handleContinue = () => {
    if (rfidDetected) {
      onAddToQueue(rfidDetected);
      // Reset local scanner state for next scan
      setRfidDetected(null);
      setFilterInfo(null);
      onScanValueChange('');
    }
  };

  const handleManualAdd = () => {
    if (scanValue.trim()) {
      onAddToQueue(scanValue.trim());
      setRfidDetected(null);
      setFilterInfo(null);
      onScanValueChange('');
    }
  };

  const handleRemove = () => {
    setRfidDetected(null);
    setFilterInfo(null);
    onScanValueChange('');
    onClearError();
  };

  if (!activeStage) return null;

  const wrapperClass = fullPage
    ? 'w-full'
    : 'fixed inset-0 bg-black/70 flex items-center justify-center z-50 p-4';
  const cardClass = fullPage
    ? 'bg-white border border-slate-200 rounded-2xl w-full max-w-2xl mx-auto overflow-hidden'
    : 'bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden';

  return (
    <div className={wrapperClass} onClick={fullPage ? undefined : onClose}>
      <div className={cardClass} onClick={e => e.stopPropagation()}>
        <div className={`bg-gradient-to-r ${activeStage.color} px-6 py-4 flex items-center gap-3`}>
          <span className="text-3xl">{activeStage.icon}</span>
          <div>
            <h2 className="text-xl font-bold text-white">{activeStage.label}</h2>
            <p className="text-white/60 text-sm">
              {step === 'block' ? 'Step 1: Select Block' : selectedBlock ? `Block: ${selectedBlock.name}` : 'Scan filter to proceed'}
            </p>
          </div>
        </div>
        <div className="p-6 space-y-4">
          {step === 'block' && (
            <>
              <div className="text-sm text-slate-500 mb-2">Select the block:</div>
              <div className="space-y-2">
                {blocks.length === 0 && <div className="text-center py-6 text-slate-400">No blocks found</div>}
                {blocks.map((block: any) => (
                  <button key={block.id} onClick={() => onBlockSelect(block)}
                    className="w-full text-left px-4 py-4 bg-slate-100 hover:bg-slate-100 border-2 border-transparent hover:border-cyan-600 rounded-xl transition-all">
                    <div className="text-slate-800 font-semibold">{block.name}</div>
                    {block.attributes?.grade && <div className="text-xs text-slate-500 mt-0.5">{block.attributes.grade}</div>}
                  </button>
                ))}
              </div>
              <button onClick={onClose} className="w-full py-3 bg-slate-100 text-slate-600 rounded-xl mt-2">Cancel</button>
            </>
          )}
          {step === 'scan' && (
            <>
              {selectedBlock && (
                <div className="flex items-center gap-2 px-3 py-2 bg-cyan-50 border border-cyan-200 rounded-xl text-sm">
                  <span className="text-cyan-700">{selectedBlock.name}</span>
                  <button onClick={onChangeBlock} className="ml-auto text-xs text-cyan-600">Change</button>
                </div>
              )}

              {/* Tag detected — show filter info + Continue / Remove */}
              {rfidDetected ? (
                <div className="p-4 border-2 border-purple-300 bg-purple-50 rounded-xl space-y-3">
                  <div>
                    <p className="text-xs text-purple-500 font-medium">Tag Detected</p>
                    <p className="text-lg font-mono font-bold text-purple-800 mt-0.5">{rfidDetected}</p>
                  </div>

                  {/* Filter details from lookup */}
                  {lookingUp && (
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      <div className="w-3 h-3 border-2 border-slate-300 border-t-transparent rounded-full animate-spin" />
                      Looking up filter...
                    </div>
                  )}
                  {filterInfo && (
                    <div className="bg-white rounded-lg p-3 border border-purple-200 space-y-1">
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-500">Filter</span>
                        <span className="text-sm font-semibold text-slate-800">{filterInfo.name}</span>
                      </div>
                      <div className="flex items-center justify-between">
                        <span className="text-xs text-slate-500">AHU</span>
                        <span className="text-sm font-medium text-slate-600">{filterInfo.parentName}</span>
                      </div>
                    </div>
                  )}
                  {!lookingUp && !filterInfo && (
                    <p className="text-xs text-amber-600">No filter found for this tag. You can still continue with manual lookup.</p>
                  )}

                  <div className="flex gap-3">
                    <button onClick={handleRemove}
                      className="flex-1 py-2.5 text-sm font-medium text-red-600 bg-white border border-red-200 rounded-xl hover:bg-red-50">
                      Remove
                    </button>
                    <button onClick={handleContinue} disabled={addingToQueue}
                      className="flex-1 py-2.5 text-sm font-medium text-white bg-green-600 rounded-xl hover:bg-green-700 disabled:opacity-50 flex items-center justify-center gap-2">
                      {addingToQueue ? (
                        <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                      ) : (
                        <>
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" /></svg>
                          Add to Queue
                        </>
                      )}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div>
                    <label className="text-sm font-medium text-slate-500 mb-1 block">Scan or Enter Filter Identifier</label>
                    <input type="text"
                      className="w-full bg-slate-50 border-2 border-slate-300 rounded-xl px-4 py-4 text-slate-800 text-center font-mono text-xl placeholder:text-slate-300 focus:border-cyan-500 outline-none"
                      placeholder="Scan tag or type filter name"
                      value={scanValue}
                      onChange={e => handleScanInput(e.target.value)}
                      data-rfid="true"
                      autoFocus
                      autoComplete="off"
                      spellCheck={false} />
                  </div>
                  <p className="text-xs text-slate-400 text-center">Hold RFID tag near reader, or type filter name and press Submit</p>
                </>
              )}

              {/* Remarks — only show when no tag detected yet */}
              {!rfidDetected && (
                <textarea className="w-full bg-slate-50 border border-slate-300 rounded-xl px-4 py-2 text-slate-800 text-sm placeholder:text-slate-400" rows={2}
                  placeholder="Remarks (optional)" value={remarks} onChange={e => onRemarksChange(e.target.value)} />
              )}

              {error && <div className="px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700">{error}</div>}

              {/* Manual add to queue — only when no RFID tag detected */}
              {!rfidDetected && (
                <button onClick={handleManualAdd} disabled={addingToQueue || !scanValue.trim()}
                  className="w-full py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-medium disabled:opacity-40 flex items-center justify-center gap-2 transition-colors">
                  {addingToQueue ? <div className="w-5 h-5 border-2 border-slate-500 border-t-transparent rounded-full animate-spin" /> :
                    <><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M12 4v16m8-8H4" /></svg>Add to Queue</>}
                </button>
              )}

              {/* Queue display */}
              {queue.length > 0 && (
                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <div className="px-4 py-2 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                    <span className="text-xs font-semibold text-slate-600 uppercase tracking-wider">Queue ({queue.length})</span>
                  </div>
                  <div className="max-h-40 overflow-y-auto divide-y divide-slate-100">
                    {queue.map((item, idx) => (
                      <div key={item.filterId} className="px-4 py-2 flex items-center gap-2 text-sm">
                        <span className="text-slate-400 text-xs w-5">{idx + 1}.</span>
                        <span className="flex-1 font-medium text-slate-700 truncate">{item.filterName}</span>
                        <button onClick={() => onRemoveFromQueue(item.filterId)}
                          className="text-red-500 hover:text-red-700 text-xs font-medium px-2 py-1 rounded hover:bg-red-50">
                          Remove
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Action buttons */}
              <div className="flex gap-3">
                <button onClick={onClose} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl">Close</button>
                <button onClick={onSubmitBatch} disabled={loading || queue.length === 0}
                  className="flex-1 py-3 bg-green-600 text-white rounded-xl font-bold disabled:opacity-40 flex items-center justify-center gap-2 hover:bg-green-500 transition-colors">
                  {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> :
                    <><svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>Submit All ({queue.length})</>}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
