import { useState, useEffect } from 'react';
import useSWR, { mutate } from 'swr';
import { apiClient, api } from '../../lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';


interface CleaningReason {
  key: string; name: string; description: string; requiresJustification: boolean; isActive: boolean; sortOrder: number;
}

export function CleaningReasonsConfigPage() {
  // 2026-05-26 audit fix (PA-FE-1): gate Add/Edit/Save on CONFIG_UPDATE.
  const { user } = useAuth();
  const perms = (user?.permissions as string[] | undefined) ?? [];
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const canWrite = isSuperAdmin || perms.includes('CONFIG_UPDATE');
  const { data: config } = useSWR('/api/config/dynamic/filter-cleaning-reasons');
  const [reasons, setReasons] = useState<CleaningReason[]>([]);
  const [editing, setEditing] = useState<CleaningReason | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modalError, setModalError] = useState<string | null>(null);
  const [isNewReason, setIsNewReason] = useState(false);
  const reauth = useReauth();

  useEffect(() => {
    if (config?.value) setReasons(Array.isArray(config.value) ? config.value : []);
  }, [config]);

  // Audit 2026-05-04 fix #5 (web-routes review H — lower-blast config
  // surfaces). UPDATE_CONFIG_PAGE umbrella; backend is gated via the
  // dynamic-routes.ts PUT handler reading reauthAction from the def
  // (filter-cleaning-reasons.def.ts now sets requiresReauth + reauthAction).
  const save = () => {
    setSaving(true);
    const body = { value: reasons };
    reauth.execute(
      'UPDATE_CONFIG_PAGE',
      async (password?: string) => {
        if (password) await api.putWithReauth('/api/config/dynamic/filter-cleaning-reasons', body, password);
        else await apiClient.put('/api/config/dynamic/filter-cleaning-reasons', body);
      },
      {
        onSuccess: () => {
          mutate('/api/config/dynamic/filter-cleaning-reasons');
          setError(null);
          setSaving(false);
        },
        onError: (e: any) => {
          setError(e.message || 'Failed to save cleaning reasons');
          console.error(e);
          setSaving(false);
        },
      },
    );
  };

  const openAdd = () => {
    setEditing({ key: '', name: '', description: '', requiresJustification: false, isActive: true, sortOrder: reasons.length + 1 });
    setIsNewReason(true);
    setModalError(null);
  };

  const openEdit = (r: CleaningReason) => {
    setEditing({ ...r });
    setIsNewReason(false);
    setModalError(null);
  };

  const handleModalSave = () => {
    if (!editing) return;

    if (!editing.key.trim()) {
      setModalError('Key is required.');
      return;
    }
    if (!editing.name.trim()) {
      setModalError('Name is required.');
      return;
    }

    // Key uniqueness check: for new reasons, key must not exist; for edits, allow same key only for the item being edited
    const duplicate = reasons.find(r => r.key === editing.key.trim());
    if (isNewReason && duplicate) {
      setModalError(`A reason with key "${editing.key.trim()}" already exists.`);
      return;
    }
    if (!isNewReason && duplicate && duplicate.name !== editing.name) {
      // When editing, we matched by key in findIndex, so duplicates only matter if a different entry has the same key
      // This case is handled below via findIndex
    }

    const idx = reasons.findIndex(x => x.key === editing.key);
    if (idx >= 0 && !isNewReason) {
      const ns = [...reasons];
      ns[idx] = { ...editing, key: editing.key.trim(), name: editing.name.trim(), description: editing.description.trim() };
      setReasons(ns);
    } else if (isNewReason && !duplicate) {
      setReasons([...reasons, { ...editing, key: editing.key.trim(), name: editing.name.trim(), description: editing.description.trim() }]);
    } else {
      return; // duplicate guard
    }
    setEditing(null);
    setModalError(null);
  };

  return (
    <div className="space-y-5">
      {/* Panel toolbar */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <p className="text-sm text-slate-500 max-w-xl">Configure the reasons available when starting a cleaning cycle.</p>
        <div className="flex gap-2 shrink-0">
          <button onClick={openAdd} disabled={!canWrite}
            title={!canWrite ? 'CONFIG_UPDATE permission required' : undefined}
            className="px-4 py-2 bg-white border border-slate-200 text-slate-700 rounded-lg hover:bg-slate-50 hover:border-slate-300 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm font-medium text-sm">
            + Add Reason
          </button>
          <button onClick={save} disabled={saving || !canWrite}
            title={!canWrite ? 'CONFIG_UPDATE permission required' : undefined}
            className="px-4 py-2 bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-lg hover:from-cyan-500 hover:to-blue-500 disabled:opacity-50 transition-all shadow-sm font-medium text-sm">
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg text-sm flex items-center justify-between">
          <div className="flex items-center gap-2">
            <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>{error}</span>
          </div>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 ml-4 text-lg font-medium">&times;</button>
        </div>
      )}

      {/* Reasons list */}
      <div className="bg-white rounded-2xl border border-slate-200/60 shadow-xl overflow-hidden">
        {reasons.length === 0 ? (
          <div className="p-12 text-center text-slate-400">
            <svg className="w-12 h-12 mx-auto mb-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
            </svg>
            <p className="text-sm">No cleaning reasons configured yet. Click "Add Reason" to get started.</p>
          </div>
        ) : (
          <div className="divide-y divide-slate-100">
            {reasons.map((r) => (
              <div key={r.key} className="px-5 py-4 flex items-center gap-4 hover:bg-slate-50/50 transition-colors">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-slate-800 font-medium">{r.name}</span>
                    <span className="px-1.5 py-0.5 text-xs text-slate-400 bg-slate-100 rounded font-mono">{r.key}</span>
                  </div>
                  {r.description && (
                    <p className="text-sm text-slate-500 mt-0.5 truncate">{r.description}</p>
                  )}
                </div>
                {r.requiresJustification && (
                  <span className="px-2.5 py-1 text-xs bg-amber-50 text-amber-700 border border-amber-200 rounded-full font-medium whitespace-nowrap">
                    Requires Justification
                  </span>
                )}
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={r.isActive} disabled={r.key === 'PM'}
                    onChange={e => setReasons(reasons.map(x => x.key === r.key ? { ...x, isActive: e.target.checked } : x))}
                    className="w-4 h-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500" />
                  <span className="text-sm text-slate-500">Active</span>
                </label>
                <button onClick={() => openEdit(r)}
                  className="text-slate-400 hover:text-cyan-600 text-sm font-medium transition-colors">
                  Edit
                </button>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Edit / Add Modal */}
      {editing && (
        <div className="fixed inset-0 bg-black/30 backdrop-blur-sm flex items-center justify-center z-50" onClick={() => { setEditing(null); setModalError(null); }}>
          <div className="bg-white border border-slate-200 rounded-2xl p-6 w-full max-w-md space-y-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <h2 className="text-lg font-semibold text-slate-800">{isNewReason ? 'Add Reason' : 'Edit Reason'}</h2>

            {modalError && (
              <div className="bg-red-50 border border-red-200 text-red-700 px-3 py-2 rounded-lg text-sm flex items-center gap-2">
                <svg className="w-4 h-4 text-red-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                <span>{modalError}</span>
              </div>
            )}

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Name</label>
                <input
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                  placeholder="e.g. Scheduled Cleaning"
                  value={editing.name}
                  onChange={e => setEditing({
                    ...editing,
                    name: e.target.value,
                    key: isNewReason && !editing.key || (isNewReason && editing.key === editing.name.toUpperCase().replace(/\s+/g, '_'))
                      ? e.target.value.toUpperCase().replace(/\s+/g, '_')
                      : editing.key,
                  })}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Key</label>
                <input
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-800 font-mono placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent"
                  placeholder="e.g. SCHEDULED_CLEANING"
                  value={editing.key}
                  onChange={e => setEditing({ ...editing, key: e.target.value })}
                  disabled={!isNewReason}
                />
                {!isNewReason && (
                  <p className="text-xs text-slate-400 mt-1">Key cannot be changed after creation.</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Description</label>
                <textarea
                  className="w-full bg-white border border-slate-200 rounded-lg px-3 py-2 text-slate-800 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-cyan-500 focus:border-transparent resize-none"
                  placeholder="Describe when this reason should be used"
                  rows={2}
                  value={editing.description}
                  onChange={e => setEditing({ ...editing, description: e.target.value })}
                />
              </div>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={editing.requiresJustification}
                  onChange={e => setEditing({ ...editing, requiresJustification: e.target.checked })}
                  className="w-4 h-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500" />
                <span className="text-sm text-slate-600">Requires Justification</span>
              </label>
            </div>
            <div className="flex gap-3 pt-2">
              <button onClick={() => { setEditing(null); setModalError(null); }}
                className="flex-1 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-lg hover:bg-slate-50 transition-colors font-medium text-sm">
                Cancel
              </button>
              <button onClick={handleModalSave}
                className="flex-1 py-2.5 bg-gradient-to-r from-cyan-600 to-blue-600 text-white rounded-lg hover:from-cyan-500 hover:to-blue-500 transition-all font-medium text-sm">
                {isNewReason ? 'Add' : 'Update'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setSaving(false); }}
        actionLabel="Update Cleaning Reasons"
      />
    </div>
  );
}
