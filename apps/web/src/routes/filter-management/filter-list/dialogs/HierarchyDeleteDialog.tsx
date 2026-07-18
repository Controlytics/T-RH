import type { HierarchyNode } from '../types';

type Props = {
  node: HierarchyNode;
  submitting: boolean;
  onClose: () => void;
  onSubmit: () => void;
};

export function HierarchyDeleteDialog({ node, submitting, onClose, onSubmit }: Props) {
  return (
    <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[55] p-4">
      <div className="bg-white border border-slate-200 rounded-2xl w-full max-w-md overflow-hidden shadow-2xl">
        <div className="px-6 py-5">
          <div className="flex items-start gap-3">
            <div className="p-2 rounded-lg bg-red-100 text-red-600">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            </div>
            <div className="flex-1">
              <h3 className="text-lg font-bold text-slate-800">Delete {node.entityType}</h3>
              <p className="text-sm text-slate-600 mt-1">
                Permanently delete <strong>"{node.name}"</strong>? Any child entities will also be removed. This cannot be undone.
              </p>
            </div>
          </div>
        </div>
        <div className="px-6 py-4 border-t border-slate-200 bg-slate-50 flex items-center gap-3">
          <button onClick={onClose} className="flex-1 px-4 py-2 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors">Cancel</button>
          <button onClick={onSubmit} disabled={submitting}
            className="flex-1 px-4 py-2 rounded-lg text-sm font-medium text-white bg-red-600 hover:bg-red-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
            {submitting ? 'Deleting...' : `Delete ${node.entityType}`}
          </button>
        </div>
      </div>
    </div>
  );
}
