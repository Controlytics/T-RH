/** AHU Filter-Set Chooser — shown BEFORE the AHU completion popup (2026-07-03).
 *
 * When the AHU Completion Process is POPUP or INTERLOCK, the operator first
 * picks which filter set they are completing right now:
 *
 *   Set A  → only Set A + unclassified filters count toward completion.
 *   Set B  → only Set B + unclassified filters count.
 *   All    → every filter under the AHU counts (legacy behavior).
 *
 * The choice scopes both the on-screen status popup AND the server INTERLOCK
 * gate (it rides in the submit-checklist body), so the two never disagree.
 */
export type FilterSetChoice = 'ALL' | 'SET_A' | 'SET_B';

export interface AhuSetChooserDialogProps {
  onChoose: (set: FilterSetChoice) => void;
  onCancel: () => void;
}

const OPTIONS: {
  value: FilterSetChoice;
  title: string;
  desc: string;
  accent: string; // ring + icon color when hovered/selected
  dot: string;
}[] = [
  { value: 'SET_A', title: 'Set A', desc: 'Complete Set A filters (plus any unclassified). Set B is ignored.', accent: 'hover:border-blue-400 hover:ring-blue-100', dot: 'bg-blue-500' },
  { value: 'SET_B', title: 'Set B', desc: 'Complete Set B filters (plus any unclassified). Set A is ignored.', accent: 'hover:border-purple-400 hover:ring-purple-100', dot: 'bg-purple-500' },
  { value: 'ALL', title: 'All Filters', desc: 'Every filter under the AHU must reach its final stage.', accent: 'hover:border-cyan-400 hover:ring-cyan-100', dot: 'bg-cyan-500' },
];

export function AhuSetChooserDialog({ onChoose, onCancel }: AhuSetChooserDialogProps) {
  return (
    <div className="fixed inset-0 bg-black/70 flex items-center justify-center z-[70] p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden flex flex-col">
        {/* Gradient header */}
        <div className="px-6 py-4 flex items-center gap-3 shrink-0 bg-gradient-to-r from-teal-500 to-cyan-600">
          <svg className="w-7 h-7 text-cyan-100" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
              d="M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10" />
          </svg>
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-white">Which set are you completing?</h2>
            <p className="text-sm text-cyan-100">Choose the filter set before completing this AHU</p>
          </div>
        </div>

        {/* Options */}
        <div className="p-5 space-y-3">
          {OPTIONS.map((o) => (
            <button
              key={o.value}
              onClick={() => onChoose(o.value)}
              className={`w-full text-left flex items-start gap-3 px-4 py-3 rounded-xl border border-slate-200 bg-white transition-all ring-2 ring-transparent ${o.accent}`}
            >
              <span className={`mt-1.5 w-2.5 h-2.5 rounded-full shrink-0 ${o.dot}`} />
              <span className="min-w-0">
                <span className="block text-sm font-bold text-slate-800">{o.title}</span>
                <span className="block text-xs text-slate-500 mt-0.5">{o.desc}</span>
              </span>
            </button>
          ))}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-slate-200 shrink-0">
          <button
            onClick={onCancel}
            className="w-full py-3 bg-slate-100 text-slate-600 rounded-xl font-medium hover:bg-slate-200 transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
