import { Fragment, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { apiClient, api } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';

type Matrix = Record<string, string[]>;

interface Role {
  name: string;
  displayName: string;
}

interface Module {
  moduleKey: string;
  moduleName: string;
  description: string;
  category: string;
}

// Modules edited only on the consolidated Role Assignments page — they have no
// standalone config page and are all SUPER_ADMIN-only, so a per-role access grant
// here would do nothing. Hidden from the matrix. Keep in sync with
// roleAssignmentKeys in routes/config/index.tsx.
const HIDDEN_MODULE_KEYS = new Set([
  'pm-schedule-approval', 'replacement-schedule-approval', 'qnn-notifications',
  'guest-cleaning-requests', 'block-change-approval', 'stage-interlock', 'pm-schedule-settings',
]);

// Modules that have a hardcoded page (no config def → not in the manifest) but
// should still be grantable per-role here. Injected as synthetic matrix rows.
const EXTRA_MODULES: Module[] = [
  {
    moduleKey: 'filter-data-management',
    moduleName: 'Filter Data Management',
    description: 'Edit, delete, or unretire retirement and replacement records (no audit trail)',
    category: 'filter-management',
  },
];

export function AccessMatrixPage() {
  const { toast } = useToast();
  const reauth = useReauth();
  const { data: matrixData, mutate } = useSWR<Matrix>('/api/config/access-matrix');
  const { data: rolesData } = useSWR<Role[]>('/api/roles/active', { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: manifest } = useSWR<any[]>('/api/config/registry/manifest');

  const [draft, setDraft] = useState<Matrix>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (matrixData) setDraft(matrixData);
  }, [matrixData]);

  // Filter out SUPER_ADMIN — it implicitly has access to everything
  const roles = useMemo(
    () => (rolesData ?? []).filter(r => r.name !== 'SUPER_ADMIN'),
    [rolesData],
  );

  // Group modules by category, exclude the access-matrix module itself and the
  // consolidated modules that no longer have a standalone page (see HIDDEN_MODULE_KEYS).
  const modulesByCategory = useMemo(() => {
    const groups = new Map<string, Module[]>();
    const all = [...((manifest ?? []) as Module[]), ...EXTRA_MODULES];
    for (const m of all) {
      if (m.moduleKey === 'access-matrix' || HIDDEN_MODULE_KEYS.has(m.moduleKey)) continue;
      const cat = m.category || 'other';
      if (!groups.has(cat)) groups.set(cat, []);
      groups.get(cat)!.push(m);
    }
    for (const arr of groups.values()) arr.sort((a, b) => a.moduleName.localeCompare(b.moduleName));
    return groups;
  }, [manifest]);

  const isAssigned = (moduleKey: string, role: string) =>
    (draft[moduleKey] ?? []).includes(role);

  const toggle = (moduleKey: string, role: string) => {
    setDraft(prev => {
      const current = prev[moduleKey] ?? [];
      const next = current.includes(role)
        ? current.filter(r => r !== role)
        : [...current, role];
      return { ...prev, [moduleKey]: next };
    });
  };

  const toggleRowAll = (moduleKey: string) => {
    setDraft(prev => {
      const allRoles = roles.map(r => r.name);
      const current = prev[moduleKey] ?? [];
      const allChecked = current.length >= allRoles.length
        && allRoles.every(r => current.includes(r));
      return { ...prev, [moduleKey]: allChecked ? [] : allRoles };
    });
  };

  const toggleColumnAll = (role: string) => {
    setDraft(prev => {
      const next: Matrix = { ...prev };
      const allModuleKeys = [...modulesByCategory.values()].flat().map(m => m.moduleKey);
      const allChecked = allModuleKeys.every(k => (next[k] ?? []).includes(role));
      for (const k of allModuleKeys) {
        const cur = next[k] ?? [];
        next[k] = allChecked ? cur.filter(r => r !== role) : [...new Set([...cur, role])];
      }
      return next;
    });
  };

  // Audit 2026-05-04 fix #5 (web-routes review H1): the access matrix is the
  // role↔config-module source of truth. Saving it without reauth meant any
  // user with CONFIG_UPDATE could rebind every config tab to every role.
  // Wrap in UPDATE_ROLE_CONFIG (existing — same audit category as the
  // role-edit page so config-access edits and role-edits share an audit
  // bucket the operator already monitors).
  const save = () => {
    setSaving(true);
    reauth.execute(
      'UPDATE_ROLE_CONFIG',
      async (password?: string) => {
        if (password) await api.putWithReauth('/api/config/access-matrix', draft, password);
        else await apiClient.put('/api/config/access-matrix', draft);
      },
      {
        onSuccess: async () => {
          await mutate(draft, false);
          toast.success('Saved', 'Configuration access matrix updated.');
          setSaving(false);
        },
        onError: (err: any) => {
          toast.error('Save failed', err?.message ?? 'Could not save access matrix');
          setSaving(false);
        },
      },
    );
  };

  const reset = () => {
    setDraft(matrixData ?? {});
  };

  const dirty = JSON.stringify(draft) !== JSON.stringify(matrixData ?? {});

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3.5 rounded-2xl bg-gradient-to-br from-indigo-500 to-purple-600 shadow-lg shadow-indigo-500/25">
            <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
            </svg>
          </div>
          <div>
            <h1 className="text-2xl font-bold text-slate-800">Configuration Access</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              Assign configuration modules to roles. SUPER_ADMIN always has access to all modules.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={reset}
            disabled={!dirty || saving}
            className="px-4 py-2 rounded-lg text-sm font-medium text-slate-600 border border-slate-200 hover:bg-slate-50 disabled:opacity-50 transition-colors"
          >
            Reset
          </button>
          <button
            type="button"
            onClick={save}
            disabled={!dirty || saving}
            className="px-5 py-2 rounded-lg text-sm font-semibold text-white bg-indigo-600 hover:bg-indigo-700 disabled:opacity-50 transition-colors"
          >
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </div>

      {roles.length === 0 ? (
        <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-slate-500">
          No assignable roles found. SUPER_ADMIN always has access.
        </div>
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="sticky top-0 bg-slate-50 border-b border-slate-200 z-10">
                <tr>
                  <th className="text-left px-5 py-3 text-[11px] font-bold text-slate-500 uppercase tracking-wider">Module</th>
                  {roles.map(r => (
                    <th key={r.name} className="px-3 py-3 text-center text-[11px] font-bold text-slate-500 uppercase tracking-wider whitespace-nowrap">
                      <div className="flex flex-col items-center gap-1">
                        <span>{r.displayName}</span>
                        <button
                          type="button"
                          onClick={() => toggleColumnAll(r.name)}
                          className="text-[10px] font-semibold text-indigo-600 hover:text-indigo-700"
                        >
                          toggle all
                        </button>
                      </div>
                    </th>
                  ))}
                  <th className="px-3 py-3 text-center text-[11px] font-bold text-slate-500 uppercase tracking-wider">Row</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {[...modulesByCategory.entries()].map(([category, modules]) => (
                  <Fragment key={category}>
                    <tr className="bg-slate-50/50">
                      <td colSpan={roles.length + 2} className="px-5 py-2 text-[11px] font-bold text-slate-600 uppercase tracking-wider">
                        {category}
                      </td>
                    </tr>
                    {modules.map(m => (
                      <tr key={m.moduleKey} className="hover:bg-slate-50/50">
                        <td className="px-5 py-3">
                          <div className="font-semibold text-[13px] text-slate-800">{m.moduleName}</div>
                          <div className="text-[12px] text-slate-400 mt-0.5">{m.description}</div>
                        </td>
                        {roles.map(r => (
                          <td key={r.name} className="px-3 py-3 text-center">
                            <input
                              type="checkbox"
                              checked={isAssigned(m.moduleKey, r.name)}
                              onChange={() => toggle(m.moduleKey, r.name)}
                              className="w-4 h-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500"
                            />
                          </td>
                        ))}
                        <td className="px-3 py-3 text-center">
                          <button
                            type="button"
                            onClick={() => toggleRowAll(m.moduleKey)}
                            className="text-[11px] font-semibold text-indigo-600 hover:text-indigo-700"
                          >
                            all
                          </button>
                        </td>
                      </tr>
                    ))}
                  </Fragment>
                ))}
              </tbody>
            </table>
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
        actionLabel="Save Configuration Access"
      />
    </div>
  );
}
