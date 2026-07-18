import { useState, useEffect } from 'react';
import useSWR, { mutate } from 'swr';
import { apiClient, api } from '@/lib/api-client';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';

const ALL_CARDS = [
  { key: 'total_users', label: 'Total Users', description: 'User count with link to user management' },
  { key: 'audit_trail', label: 'Audit Trail', description: 'Audit record count with link to audit page' },
  { key: 'notifications', label: 'Notifications', description: 'Notification count with link to notifications' },
  { key: 'filter_analytics', label: 'Filter Cleaning Analytics', description: 'Stage counts, daily/monthly charts, cycle status donut' },
  { key: 'total_filters', label: 'Total Filters', description: 'Filter count summary card' },
  { key: 'active_cycles', label: 'Active Cycles', description: 'Currently running cleaning cycles' },
  { key: 'completed_today', label: 'Completed Today', description: 'Cycles completed today' },
  { key: 'stage_distribution', label: 'Stage Distribution', description: 'Bar chart of filters by cleaning stage' },
  { key: 'cycle_status', label: 'Cycle Status Breakdown', description: 'Donut chart of cycle statuses' },
  { key: 'daily_chart', label: 'Daily Cycles Chart', description: 'Bar chart of cycles per day (30 days)' },
  { key: 'monthly_chart', label: 'Monthly Cycles Chart', description: 'Bar chart of cycles per month (12 months)' },
  { key: 'quick_actions', label: 'Quick Actions', description: 'Create user, view audit, system config shortcuts' },
];

interface RoleConfig {
  roleId: string;
  roleName: string;
  displayName: string;
  cards: string[];
}

export default function DashboardCardsConfig() {
  // Always refetch roles on mount and bypass the dedupe window so a role
  // created/deleted elsewhere is reflected here immediately (mirrors the
  // role-access + role-assignments pages). Without this, a deleted role
  // lingers in this list until a hard refresh.
  const { data: rolesData } = useSWR<any>('/api/roles/active', { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: configData } = useSWR<any>('/api/config/dashboard-cards/current');
  const [roleConfigs, setRoleConfigs] = useState<RoleConfig[]>([]);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const reauth = useReauth();

  const roles: any[] = rolesData?.roles ?? rolesData ?? [];

  useEffect(() => {
    if (!roles.length) return;
    const saved: Record<string, string[]> = configData?.roles ?? {};
    setRoleConfigs(
      roles.map((r: any) => ({
        roleId: r.id,
        roleName: r.name,
        displayName: r.displayName ?? r.name.replace(/_/g, ' '),
        cards: saved[r.name] ?? ALL_CARDS.map(c => c.key), // default: all visible
      })),
    );
  }, [roles, configData]);

  const toggleCard = (roleIdx: number, cardKey: string) => {
    setRoleConfigs(prev => prev.map((rc, i) => {
      if (i !== roleIdx) return rc;
      const cards = rc.cards.includes(cardKey)
        ? rc.cards.filter(k => k !== cardKey)
        : [...rc.cards, cardKey];
      return { ...rc, cards };
    }));
  };

  const toggleAll = (roleIdx: number, enable: boolean) => {
    setRoleConfigs(prev => prev.map((rc, i) => {
      if (i !== roleIdx) return rc;
      return { ...rc, cards: enable ? ALL_CARDS.map(c => c.key) : [] };
    }));
  };

  // Audit 2026-05-04 fix #5 (web-routes review H — lower-blast config
  // surfaces). Routed through the umbrella UPDATE_CONFIG_PAGE action;
  // backend mirror in static-routes/dashboard-cards.routes.ts.
  const handleSave = () => {
    setSaving(true);
    const rolesMap: Record<string, string[]> = {};
    for (const rc of roleConfigs) rolesMap[rc.roleName] = rc.cards;
    const body = { configValue: { roles: rolesMap } };
    reauth.execute(
      'UPDATE_CONFIG_PAGE',
      async (password?: string) => {
        if (password) await api.putWithReauth('/api/config/dashboard-cards', body, password);
        else await apiClient.put('/api/config/dashboard-cards', body);
      },
      {
        onSuccess: () => {
          mutate('/api/config/dashboard-cards/current');
          setToast('Saved');
          setTimeout(() => setToast(null), 2000);
          setSaving(false);
        },
        onError: (e: any) => {
          setToast(e.message ?? 'Save failed');
          setSaving(false);
        },
      },
    );
  };

  return (
    <div className="space-y-6">
      {toast && (
        <div className="fixed top-4 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-xl shadow-2xl bg-green-50 border border-green-200 text-green-700 text-sm font-medium">
          {toast}
        </div>
      )}

      <div className="flex items-center justify-between gap-4">
        <p className="text-sm text-slate-500 max-w-2xl">Configure which cards are visible on the dashboard for each role.</p>
        <button onClick={handleSave} disabled={saving}
          className="shrink-0 px-4 py-2.5 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-teal-500 to-cyan-600 shadow-sm disabled:opacity-40 disabled:cursor-not-allowed">
          {saving ? 'Saving…' : 'Save Changes'}
        </button>
      </div>

      {roleConfigs.length === 0 ? (
        <div className="text-center py-12 text-slate-400">Loading roles...</div>
      ) : (
        <div className="space-y-4">
          {roleConfigs.map((rc, roleIdx) => (
            <div key={rc.roleId} className="bg-white border border-slate-200 rounded-xl overflow-hidden">
              <div className="px-5 py-3 bg-slate-50 border-b border-slate-200 flex items-center justify-between">
                <div>
                  <span className="text-sm font-semibold text-slate-800">{rc.displayName}</span>
                  <span className="ml-2 text-xs text-slate-400">({rc.cards.length}/{ALL_CARDS.length} cards)</span>
                </div>
                <div className="flex items-center gap-2">
                  <button onClick={() => toggleAll(roleIdx, true)}
                    className="text-[11px] text-cyan-600 hover:text-cyan-700 font-medium">Select All</button>
                  <span className="text-slate-300">|</span>
                  <button onClick={() => toggleAll(roleIdx, false)}
                    className="text-[11px] text-slate-500 hover:text-slate-700 font-medium">Clear All</button>
                </div>
              </div>
              <div className="p-4 grid grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-2">
                {ALL_CARDS.map(card => {
                  const checked = rc.cards.includes(card.key);
                  return (
                    <label key={card.key}
                      className={`flex items-start gap-2.5 p-3 rounded-lg border cursor-pointer transition-all ${
                        checked ? 'bg-cyan-50/50 border-cyan-200' : 'bg-white border-slate-200 hover:bg-slate-50'
                      }`}>
                      <input type="checkbox" checked={checked} onChange={() => toggleCard(roleIdx, card.key)}
                        className="mt-0.5 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500" />
                      <div>
                        <div className="text-[13px] font-medium text-slate-800">{card.label}</div>
                        <div className="text-[11px] text-slate-400 mt-0.5 leading-tight">{card.description}</div>
                      </div>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
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
        actionLabel="Update Dashboard Cards"
      />
    </div>
  );
}
