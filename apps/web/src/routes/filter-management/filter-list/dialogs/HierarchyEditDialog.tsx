import type { HierarchyNode } from '../types';

type Props = {
  node: HierarchyNode;
  name: string;
  error: string;
  submitting: boolean;
  onNameChange: (v: string) => void;
  onClose: () => void;
  onSubmit: () => void;
};

export function HierarchyEditDialog({ node, name, error, submitting, onNameChange, onClose, onSubmit }: Props) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[55] p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden flex flex-col shadow-2xl">
        <div className="px-6 py-4 shrink-0 flex items-center justify-between bg-gradient-to-r from-amber-500 to-orange-500">
          <div>
            <h2 className="text-lg font-bold text-white">Edit {node.entityType}</h2>
            <p className="text-white/70 text-sm">Rename this hierarchy node</p>
          </div>
          <button onClick={onClose} className="text-white/80 hover:text-white">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
        </div>
        <div className="px-6 py-5 space-y-4">
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
          )}
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1">Name <span className="text-red-500">*</span></label>
            <input type="text" value={name} onChange={e => onNameChange(e.target.value)}
              className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500" />
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">Cancel</button>
          <button onClick={onSubmit} disabled={submitting || !name.trim()}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white bg-amber-600 hover:bg-amber-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>
    </div>
  );
}
