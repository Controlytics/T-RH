import { themeButton, themeGradientBr } from '@/lib/theme-styles';
import type { FilterRef } from '../types';

type Props = {
  filter: FilterRef;
  tags: any[]; // identifiers for this filter (RFID + other types)
  tagValue: string;
  submitting: boolean;
  onTagValueChange: (v: string) => void;
  onClose: () => void;
  onAssign: () => void;
  onUnassign: (identifierId: string) => void;
};

export function RfidTagPanel({
  filter, tags, tagValue, submitting,
  onTagValueChange, onClose, onAssign, onUnassign,
}: Props) {
  const rfidTags = tags.filter((t: any) => t.identifierType === 'RFID');
  const otherTags = tags.filter((t: any) => t.identifierType !== 'RFID');
  return (
    <>
      <div className="fixed inset-0 bg-black/30 z-40" onClick={onClose} />
      <div className="fixed top-0 right-0 h-full w-[420px] bg-white shadow-2xl z-50 flex flex-col border-l border-slate-200">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200 bg-slate-50">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center shadow-lg" style={{ ...themeGradientBr, boxShadow: '0 4px 14px -3px color-mix(in srgb, var(--theme-primary) 20%, transparent)' }}>
              <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0" />
              </svg>
            </div>
            <div>
              <h3 className="text-[15px] font-bold text-slate-800">RFID Tag Management</h3>
              <p className="text-[12px] text-slate-400">{filter.name}</p>
            </div>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-200 text-slate-400 hover:text-slate-600 transition-colors">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-6 space-y-5">
          {/* Current Tags */}
          <div>
            <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">Assigned Tags</h4>
            <div className="space-y-2">
              {rfidTags.length === 0 && otherTags.length === 0 && (
                <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center">
                  <p className="text-sm text-slate-400">No tags assigned to this filter</p>
                </div>
              )}
              {rfidTags.map((tag: any) => (
                <div key={tag.id} className="flex items-center justify-between rounded-xl px-4 py-3" style={{ backgroundColor: 'var(--theme-primary-light)', border: '1px solid var(--theme-primary)' }}>
                  <div className="flex items-center gap-3">
                    <svg className="w-5 h-5 text-theme-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0" />
                    </svg>
                    <div>
                      <div className="text-sm font-bold font-mono" style={{ color: 'var(--theme-primary-dark)' }}>{tag.identifierValue}</div>
                      <div className="text-[10px] text-theme-primary">RFID Tag</div>
                    </div>
                  </div>
                  <button onClick={() => onUnassign(tag.id)} disabled={submitting}
                    className="px-3 py-1.5 bg-white border border-red-200 text-red-600 text-[11px] font-semibold rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors">
                    Unassign
                  </button>
                </div>
              ))}
              {otherTags.map((tag: any) => (
                <div key={tag.id} className="flex items-center justify-between bg-slate-50 border border-slate-200 rounded-xl px-4 py-3">
                  <div className="flex items-center gap-3">
                    <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 7h.01M7 3h5c.512 0 1.024.195 1.414.586l7 7a2 2 0 010 2.828l-7 7a2 2 0 01-2.828 0l-7-7A1.994 1.994 0 013 12V7a4 4 0 014-4z" />
                    </svg>
                    <div>
                      <div className="text-sm font-medium text-slate-700">{tag.identifierValue}</div>
                      <div className="text-[10px] text-slate-400">{tag.identifierType}{tag.label ? ` — ${tag.label}` : ''}</div>
                    </div>
                  </div>
                  <button onClick={() => onUnassign(tag.id)} disabled={submitting}
                    className="px-3 py-1.5 bg-white border border-red-200 text-red-600 text-[11px] font-semibold rounded-lg hover:bg-red-50 disabled:opacity-50 transition-colors">
                    Remove
                  </button>
                </div>
              ))}
            </div>
          </div>

          {/* Assign New Tag */}
          <div className="border-t border-slate-200 pt-5">
            <h4 className="text-[11px] font-bold text-slate-500 uppercase tracking-wider mb-3">Assign New RFID Tag</h4>
            <p className="text-[12px] text-slate-400 mb-3">Scan an RFID tag or enter the tag ID manually.</p>
            <div className="space-y-3">
              <div className="relative">
                <input
                  type="text"
                  value={tagValue}
                  onChange={e => onTagValueChange(e.target.value)}
                  data-rfid="true"
                  placeholder="Scan RFID tag or type tag ID..."
                  autoFocus
                  className="w-full px-4 py-3 border border-slate-200 rounded-xl text-sm text-slate-800 font-mono bg-white focus:border-[var(--theme-primary)] focus:ring-2 focus:ring-[var(--theme-focus-ring)] outline-none pr-12"
                />
                <div className="absolute right-3 top-1/2 -translate-y-1/2">
                  <svg className="w-5 h-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.858 15.355-5.858 21.213 0" />
                  </svg>
                </div>
              </div>
              <button
                onClick={onAssign}
                disabled={submitting || !tagValue.trim()}
                className="w-full py-2.5 text-white rounded-xl text-sm font-semibold disabled:opacity-50 shadow-lg hover:opacity-90 transition-all"
                style={themeButton}
              >
                {submitting ? 'Assigning...' : 'Assign Tag'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
