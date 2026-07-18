import { useState, useEffect } from 'react';
import useSWR, { mutate } from 'swr';
import { apiClient } from '../../lib/api-client';
import { useToast } from '@/hooks/use-toast';

const FEATURES = [
  { key: 'login', label: 'Login', description: 'Allow this role to log into the tablet app' },
  { key: 'filter_cleaning', label: 'Filter Cleaning', description: 'Start/advance cleaning cycles, scan filters' },
  { key: 'filter_status', label: 'Filter Status', description: 'View current filter states and cleaning progress' },
  { key: 'my_tasks', label: 'My Tasks', description: 'View PM schedule tasks and due filters' },
  { key: 'approvals', label: 'Approvals', description: 'View and process block change approval requests' },
  { key: 'rfid_assign', label: 'RFID Assign', description: 'Assign or remove RFID tags on filters from the tablet' },
  { key: 'logout', label: 'Logout', description: 'Allow logout from the tablet app' },
];

type TabletConfig = Record<string, string[]>;

export function TabletAccessConfigPage() {
  const { toast } = useToast();
  const { data: config, isLoading } = useSWR('/api/config/tablet-access');
  const { data: rolesData } = useSWR('/api/roles', { revalidateOnMount: true, dedupingInterval: 0 });
  const [localConfig, setLocalConfig] = useState<TabletConfig>({});
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  const roles: Array<{ name: string; displayName: string }> = Array.isArray(rolesData)
    ? rolesData.map((r: any) => ({ name: r.name, displayName: r.displayName || r.name }))
    : [];

  useEffect(() => {
    if (config && typeof config === 'object') {
      setLocalConfig(config as TabletConfig);
      setDirty(false);
    }
  }, [config]);

  const toggle = (role: string, feature: string) => {
    setLocalConfig(prev => {
      const current = prev[role] ?? [];
      const has = current.includes(feature);

      // If disabling login, disable all other features too
      if (feature === 'login' && has) {
        return { ...prev, [role]: [] };
      }
      // If enabling any feature, also enable login
      if (!has && feature !== 'login' && !current.includes('login')) {
        return { ...prev, [role]: [...current, 'login', feature] };
      }

      const updated = has ? current.filter(f => f !== feature) : [...current, feature];
      return { ...prev, [role]: updated };
    });
    setDirty(true);
  };

  const toggleAll = (role: string) => {
    setLocalConfig(prev => {
      const current = prev[role] ?? [];
      const allEnabled = FEATURES.every(f => current.includes(f.key));
      return { ...prev, [role]: allEnabled ? [] : FEATURES.map(f => f.key) };
    });
    setDirty(true);
  };

  const save = async () => {
    setSaving(true);
    try {
      await apiClient.put('/api/config/tablet-access', localConfig);
      mutate('/api/config/tablet-access');
      toast.success('Saved', 'Tablet access configuration updated');
      setDirty(false);
    } catch (e: any) {
      toast.error('Error', e?.message ?? 'Failed to save');
    }
    setSaving(false);
  };

  if (isLoading) {
    return (
      <div className="p-6 flex items-center justify-center min-h-[40vh]">
        <div className="w-8 h-8 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
        <div className="h-1 bg-gradient-to-r from-cyan-500 to-teal-500" />
        <div className="p-6 flex items-center justify-between">
          <div className="flex items-center gap-4">
            <div className="p-3 rounded-2xl bg-gradient-to-br from-cyan-500 to-teal-600 shadow-lg shadow-cyan-500/20">
              <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 18h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
              </svg>
            </div>
            <div>
              <h1 className="text-xl font-bold text-slate-800">Tablet App Access Control</h1>
              <p className="text-sm text-slate-500 mt-0.5">Configure which roles can access tablet features</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {dirty && <span className="text-xs text-amber-600 font-medium">Unsaved changes</span>}
            <button onClick={save} disabled={saving || !dirty}
              className="px-5 py-2.5 bg-gradient-to-r from-cyan-600 to-teal-600 text-white rounded-xl text-sm font-semibold shadow-lg shadow-cyan-500/25 disabled:opacity-50 hover:from-cyan-500 hover:to-teal-500 transition-all">
              {saving ? 'Saving...' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>

      {/* Matrix Table */}
      <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
        <table className="w-full">
          <thead>
            <tr className="bg-slate-50 border-b border-slate-200">
              <th className="text-left px-5 py-4 text-[11px] font-bold text-slate-500 uppercase tracking-wider w-44">Role</th>
              {FEATURES.map(f => (
                <th key={f.key} className="text-center px-3 py-4 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                  <div>{f.label}</div>
                  <div className="font-normal normal-case text-[10px] text-slate-400 mt-0.5 tracking-normal">{f.description}</div>
                </th>
              ))}
              <th className="text-center px-3 py-4 text-[11px] font-bold text-slate-500 uppercase tracking-wider">All</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {roles.map(role => {
              const features = localConfig[role.name] ?? [];
              const allEnabled = FEATURES.every(f => features.includes(f.key));
              const loginDisabled = !features.includes('login');

              return (
                <tr key={role.name} className="hover:bg-slate-50/50 transition-colors">
                  <td className="px-5 py-4">
                    <div className="text-[13px] font-bold text-slate-800">{role.displayName}</div>
                    <div className="text-[11px] text-slate-400 font-mono">{role.name}</div>
                  </td>
                  {FEATURES.map(f => {
                    const enabled = features.includes(f.key);
                    const isLogin = f.key === 'login';
                    const isDisabledByLogin = !isLogin && loginDisabled;

                    return (
                      <td key={f.key} className="text-center px-3 py-4">
                        <button
                          onClick={() => toggle(role.name, f.key)}
                          disabled={isDisabledByLogin}
                          className={`w-10 h-6 rounded-full relative transition-all ${
                            enabled
                              ? isLogin ? 'bg-cyan-500' : 'bg-emerald-500'
                              : isDisabledByLogin ? 'bg-slate-100 cursor-not-allowed' : 'bg-slate-200'
                          }`}
                        >
                          <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${
                            enabled ? 'left-[18px]' : 'left-0.5'
                          }`} />
                        </button>
                      </td>
                    );
                  })}
                  <td className="text-center px-3 py-4">
                    <button onClick={() => toggleAll(role.name)}
                      className={`w-10 h-6 rounded-full relative transition-all ${allEnabled ? 'bg-cyan-500' : 'bg-slate-200'}`}>
                      <div className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow-sm transition-all ${allEnabled ? 'left-[18px]' : 'left-0.5'}`} />
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Info */}
      <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-[12px] text-slate-500 space-y-1.5">
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <span>Disabling <strong>Login</strong> for a role prevents that role from accessing the tablet app entirely.</span>
        </div>
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <span>Features are hidden from the tablet home screen when disabled. The desktop application is not affected.</span>
        </div>
        <div className="flex items-center gap-2">
          <svg className="w-4 h-4 text-slate-400 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          <span>Changes take effect immediately — users must refresh or re-login on the tablet to see updates.</span>
        </div>
      </div>
    </div>
  );
}
