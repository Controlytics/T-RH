import { useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import useSWR, { useSWRConfig } from 'swr';
import { Input } from '@/components/ui/input';
import { api } from '@/lib/api-client';
import { REAUTH_ACTIONS, REAUTH_ACTION_CATEGORIES } from '@digilog/shared';
import type { RoleData, ReauthAction, ReauthActionCategory } from '@digilog/shared';

// ── Re-auth tab constants ──
const REAUTH_CATEGORY_META: Record<ReauthActionCategory, { gradient: string; bgLight: string; icon: string; description: string }> = {
  'User Management': {
    gradient: 'from-blue-600 to-indigo-600',
    bgLight: 'bg-blue-50 border-blue-200 text-blue-700',
    icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z',
    description: 'Account creation, modification, and access control',
  },
  'Configuration': {
    gradient: 'from-purple-600 to-pink-600',
    bgLight: 'bg-purple-50 border-purple-200 text-purple-700',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    description: 'System policy and security settings',
  },
  'Role Management': {
    gradient: 'from-amber-500 to-orange-600',
    bgLight: 'bg-amber-50 border-amber-200 text-amber-700',
    icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z',
    description: 'Role creation, editing, and deletion',
  },
  'Backup': {
    gradient: 'from-red-500 to-rose-600',
    bgLight: 'bg-red-50 border-red-200 text-red-700',
    icon: 'M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4m0 5c0 2.21-3.582 4-8 4s-8-1.79-8-4',
    description: 'Database export and restore operations',
  },
  'Asset Management': {
    gradient: 'from-emerald-500 to-teal-600',
    bgLight: 'bg-emerald-50 border-emerald-200 text-emerald-700',
    icon: 'M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4',
    description: 'Asset CRUD, relationships, and identifiers',
  },
  // 'Alarms' category removed 2026-05-17 (alarm subsystem retired).
  'Checklist': {
    gradient: 'from-cyan-500 to-blue-600',
    bgLight: 'bg-cyan-50 border-cyan-200 text-cyan-700',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
    description: 'Checklist submission, review, and approval',
  },
  // 'Rule Chain' category removed 2026-05-17 (rule-chain subsystem retired).
  // 'UNS' + 'Retention' categories removed 2026-06-17 (data-ingestion subsystem retired).
  'Help': {
    gradient: 'from-lime-500 to-green-600',
    bgLight: 'bg-lime-50 border-lime-200 text-lime-700',
    icon: 'M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
    description: 'Help article management',
  },
  'Filter Management': {
    gradient: 'from-sky-500 to-blue-600',
    bgLight: 'bg-sky-50 border-sky-200 text-sky-700',
    icon: 'M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z',
    description: 'Filter cleaning cycle operations and deviations',
  },
  'Cleaning Profiles': {
    gradient: 'from-teal-500 to-cyan-600',
    bgLight: 'bg-teal-50 border-teal-200 text-teal-700',
    icon: 'M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4',
    description: 'Cleaning pipeline profile management',
  },
  'Filter Profiles': {
    gradient: 'from-indigo-500 to-violet-600',
    bgLight: 'bg-indigo-50 border-indigo-200 text-indigo-700',
    icon: 'M19 11H5m14 0a2 2 0 012 2v6a2 2 0 01-2 2H5a2 2 0 01-2-2v-6a2 2 0 012-2m14 0V9a2 2 0 00-2-2M5 11V9a2 2 0 012-2m0 0V5a2 2 0 012-2h6a2 2 0 012 2v2M7 7h10',
    description: 'Filter-to-profile assignment and management',
  },
  'PM Schedules': {
    gradient: 'from-rose-500 to-pink-600',
    bgLight: 'bg-rose-50 border-rose-200 text-rose-700',
    icon: 'M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
    description: 'Preventive maintenance schedule management',
  },
  'Equipment Groups': {
    gradient: 'from-amber-500 to-yellow-600',
    bgLight: 'bg-amber-50 border-amber-200 text-amber-700',
    icon: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z',
    description: 'Equipment group and instrument configuration',
  },
  'Reports': {
    gradient: 'from-sky-500 to-blue-600',
    bgLight: 'bg-sky-50 border-sky-200 text-sky-700',
    icon: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
    description: 'Report template and generation management',
  },
  'Notifications': {
    gradient: 'from-rose-500 to-pink-600',
    bgLight: 'bg-rose-50 border-rose-200 text-rose-700',
    icon: 'M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9',
    description: 'Notification deletion',
  },
  'Super Admin': {
    gradient: 'from-red-600 to-rose-700',
    bgLight: 'bg-red-50 border-red-200 text-red-700',
    icon: 'M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z',
    description: 'Direct record edits in Filter Data Management',
  },
};

// Group reauth actions by category
const reauthActionsByCategory = REAUTH_ACTION_CATEGORIES.map((category) => ({
  category,
  actions: (Object.entries(REAUTH_ACTIONS) as [ReauthAction, { label: string; category: string }][])
    .filter(([, v]) => v.category === category)
    .map(([key, v]) => ({ key, label: v.label })),
})).filter(g => g.actions.length > 0);

export interface ReauthTabHandle {
  save: () => Promise<void>;
  reset: () => void;
}

interface ReauthTabProps {
  selectableRoles: RoleData[];
  onStateChange: (state: { hasChanges: boolean; saving: boolean }) => void;
}

export const ReauthTab = forwardRef<ReauthTabHandle, ReauthTabProps>(
  function ReauthTab({ selectableRoles, onStateChange }, ref) {
    const { mutate } = useSWRConfig();

    const { data: reauthConfig, isLoading: reauthLoading } = useSWR<Record<string, string[]>>(
      '/api/config/action-reauth',
      { revalidateOnMount: true, dedupingInterval: 0 }
    );
    const [reauthLocalConfig, setReauthLocalConfig] = useState<Record<string, string[]> | null>(null);
    const [reauthSaving, setReauthSaving] = useState(false);
    const [reauthSearch, setReauthSearch] = useState('');
    const [reauthCollapsed, setReauthCollapsed] = useState<Set<string>>(new Set());
    const [reauthRoleFilter, setReauthRoleFilter] = useState<string>('all');
    const [reauthSaveMessage, setReauthSaveMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

    // ── Computed values ──
    const reauthCurrentConfig = reauthLocalConfig ?? reauthConfig ?? {};
    const reauthHasChanges = reauthLocalConfig !== null;

    const reauthVisibleRoles = useMemo(() => {
      if (reauthRoleFilter === 'all') return selectableRoles;
      return selectableRoles.filter(r => r.name === reauthRoleFilter);
    }, [selectableRoles, reauthRoleFilter]);

    const reauthFilteredActionsByCategory = useMemo(() => {
      if (!reauthSearch.trim()) return reauthActionsByCategory;
      const q = reauthSearch.toLowerCase();
      return reauthActionsByCategory.map(g => ({
        ...g,
        actions: g.actions.filter(a => a.label.toLowerCase().includes(q) || a.key.toLowerCase().includes(q) || g.category.toLowerCase().includes(q)),
      })).filter(g => g.actions.length > 0);
    }, [reauthSearch]);

    const reauthStats = useMemo(() => {
      const totalActions = Object.keys(REAUTH_ACTIONS).length;
      const configuredActions = Object.keys(reauthCurrentConfig).filter(k => (reauthCurrentConfig[k]?.length ?? 0) > 0).length;
      const totalChecks = Object.values(reauthCurrentConfig).reduce((sum, arr) => sum + (arr?.length ?? 0), 0);
      const categoryStats = reauthActionsByCategory.map(g => {
        const configured = g.actions.filter(a => (reauthCurrentConfig[a.key]?.length ?? 0) > 0).length;
        return { category: g.category, total: g.actions.length, configured };
      });
      return { totalActions, configuredActions, totalChecks, categoryStats };
    }, [reauthCurrentConfig]);

    const reauthIsChecked = useCallback((action: string, role: string): boolean => {
      return reauthCurrentConfig[action]?.includes(role) ?? false;
    }, [reauthCurrentConfig]);

    const reauthToggleAction = useCallback((action: string, role: string) => {
      const updated = { ...reauthCurrentConfig };
      const currentRoles = updated[action] ?? [];
      if (currentRoles.includes(role)) {
        updated[action] = currentRoles.filter(r => r !== role);
        if (updated[action].length === 0) delete updated[action];
      } else {
        updated[action] = [...currentRoles, role];
      }
      setReauthLocalConfig(updated);
      setReauthSaveMessage(null);
    }, [reauthCurrentConfig]);

    const reauthSelectAllCategory = useCallback((category: ReauthActionCategory) => {
      const updated = { ...reauthCurrentConfig };
      const categoryActions = reauthActionsByCategory.find(c => c.category === category)?.actions ?? [];
      const targetRoles = reauthVisibleRoles.map(r => r.name);
      for (const { key } of categoryActions) {
        const existing = new Set(updated[key] ?? []);
        targetRoles.forEach(r => existing.add(r));
        updated[key] = Array.from(existing);
      }
      setReauthLocalConfig(updated);
      setReauthSaveMessage(null);
    }, [reauthCurrentConfig, reauthVisibleRoles]);

    const reauthClearCategory = useCallback((category: ReauthActionCategory) => {
      const updated = { ...reauthCurrentConfig };
      const categoryActions = reauthActionsByCategory.find(c => c.category === category)?.actions ?? [];
      const targetRoles = new Set(reauthVisibleRoles.map(r => r.name));
      for (const { key } of categoryActions) {
        if (updated[key]) {
          updated[key] = updated[key].filter(r => !targetRoles.has(r));
          if (updated[key].length === 0) delete updated[key];
        }
      }
      setReauthLocalConfig(updated);
      setReauthSaveMessage(null);
    }, [reauthCurrentConfig, reauthVisibleRoles]);

    const reauthSelectAllRole = useCallback((roleName: string) => {
      const updated = { ...reauthCurrentConfig };
      for (const action of Object.keys(REAUTH_ACTIONS)) {
        const existing = new Set(updated[action] ?? []);
        existing.add(roleName);
        updated[action] = Array.from(existing);
      }
      setReauthLocalConfig(updated);
      setReauthSaveMessage(null);
    }, [reauthCurrentConfig]);

    const reauthClearRole = useCallback((roleName: string) => {
      const updated = { ...reauthCurrentConfig };
      for (const action of Object.keys(updated)) {
        updated[action] = (updated[action] ?? []).filter(r => r !== roleName);
        if (updated[action].length === 0) delete updated[action];
      }
      setReauthLocalConfig(updated);
      setReauthSaveMessage(null);
    }, [reauthCurrentConfig]);

    const reauthToggleCategory = useCallback((category: string) => {
      setReauthCollapsed(prev => {
        const next = new Set(prev);
        if (next.has(category)) next.delete(category);
        else next.add(category);
        return next;
      });
    }, []);

    const handleReauthSave = useCallback(async () => {
      setReauthSaving(true);
      setReauthSaveMessage(null);
      try {
        await api.put('/api/config/action-reauth', reauthCurrentConfig);
        mutate('/api/config/action-reauth');
        mutate('/api/config/action-reauth/my-actions');
        setReauthLocalConfig(null);
        setReauthSaveMessage({ type: 'success', text: 'Action re-authentication settings saved successfully.' });
      } catch (err: any) {
        setReauthSaveMessage({ type: 'error', text: err.message ?? 'Failed to save settings.' });
      } finally {
        setReauthSaving(false);
      }
    }, [reauthCurrentConfig, mutate]);

    const handleReauthReset = useCallback(() => {
      setReauthLocalConfig(null);
      setReauthSaveMessage(null);
    }, []);

    const reauthGetRoleConfiguredCount = (roleName: string) => {
      return Object.values(reauthCurrentConfig).filter(arr => arr?.includes(roleName)).length;
    };

    useEffect(() => {
      onStateChange({ hasChanges: reauthHasChanges, saving: reauthSaving });
    }, [reauthHasChanges, reauthSaving, onStateChange]);

    useImperativeHandle(ref, () => ({
      save: handleReauthSave,
      reset: handleReauthReset,
    }), [handleReauthSave, handleReauthReset]);

    return (
      <>
        {reauthLoading ? (
          <div className="flex items-center justify-center h-64">
            <div className="flex flex-col items-center gap-3 text-slate-500">
              <div className="relative">
                <div className="w-12 h-12 rounded-full border-4 border-slate-200 border-t-red-500 animate-spin" />
              </div>
              <p className="text-sm font-medium">Loading re-authentication configuration...</p>
            </div>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Stats Cards */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-blue-50">
                    <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-slate-800">{reauthStats.totalActions}</p>
                    <p className="text-xs text-slate-500">Total Actions</p>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-emerald-50">
                    <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-emerald-700">{reauthStats.configuredActions}</p>
                    <p className="text-xs text-slate-500">Actions Configured</p>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-purple-50">
                    <svg className="w-5 h-5 text-purple-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-purple-700">{reauthStats.totalChecks}</p>
                    <p className="text-xs text-slate-500">Total Checks</p>
                  </div>
                </div>
              </div>
              <div className="bg-white rounded-xl border border-slate-200 p-4 shadow-sm">
                <div className="flex items-center gap-3">
                  <div className="p-2 rounded-lg bg-orange-50">
                    <svg className="w-5 h-5 text-orange-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-orange-700">{selectableRoles.length}</p>
                    <p className="text-xs text-slate-500">Roles</p>
                  </div>
                </div>
              </div>
            </div>

            {/* Info Banner */}
            <div className="bg-gradient-to-r from-blue-50 to-indigo-50 rounded-xl border border-blue-200/60 p-4">
              <div className="flex items-start gap-3">
                <div className="p-1.5 rounded-lg bg-blue-100 flex-shrink-0 mt-0.5">
                  <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="text-sm text-blue-700">
                  <p className="font-semibold">How it works</p>
                  <p className="mt-1 text-blue-600">
                    When a checked action is performed by a user with the corresponding role, they will be prompted to
                    re-enter their password before the action executes. This adds an extra layer of security for sensitive operations.
                  </p>
                </div>
              </div>
            </div>

            {/* Save Message */}
            {reauthSaveMessage && (
              <div className={`rounded-xl border p-4 text-sm flex items-center gap-2 ${
                reauthSaveMessage.type === 'success'
                  ? 'bg-emerald-50 border-emerald-200 text-emerald-700'
                  : 'bg-red-50 border-red-200 text-red-700'
              }`}>
                <svg className="w-5 h-5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                    d={reauthSaveMessage.type === 'success'
                      ? 'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z'
                      : 'M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'}
                  />
                </svg>
                <span className="font-medium">{reauthSaveMessage.text}</span>
              </div>
            )}

            {/* Toolbar: Search + Role Filter */}
            <div className="flex flex-col sm:flex-row gap-3">
              <div className="relative flex-1">
                <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <Input
                  type="text"
                  placeholder="Search actions..."
                  value={reauthSearch}
                  onChange={e => setReauthSearch(e.target.value)}
                  className="pl-10 h-10 bg-white"
                />
                {reauthSearch && (
                  <button
                    onClick={() => setReauthSearch('')}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              <div className="flex items-center gap-2">
                <label className="text-sm text-slate-500 whitespace-nowrap">Filter Role:</label>
                <select
                  value={reauthRoleFilter}
                  onChange={e => setReauthRoleFilter(e.target.value)}
                  className="h-10 px-3 pr-8 rounded-lg border border-slate-200 bg-white text-sm text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-400 cursor-pointer appearance-none"
                  style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' fill='none' viewBox='0 0 24 24' stroke='%2394a3b8'%3E%3Cpath stroke-linecap='round' stroke-linejoin='round' stroke-width='2' d='M19 9l-7 7-7-7'/%3E%3C/svg%3E")`, backgroundRepeat: 'no-repeat', backgroundPosition: 'right 8px center', backgroundSize: '16px' }}
                >
                  <option value="all">All Roles ({selectableRoles.length})</option>
                  {selectableRoles.map(r => (
                    <option key={r.name} value={r.name}>{r.displayName} ({reauthGetRoleConfiguredCount(r.name)} configured)</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Matrix Table */}
            <div className="bg-white rounded-2xl border border-slate-200/60 shadow-xl shadow-slate-200/40">
              <div className="overflow-x-auto rounded-2xl">
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-slate-200" style={{ background: 'linear-gradient(to right, #f8fafc, #f1f5f9)' }}>
                      <th className="text-left px-5 pt-4 pb-3 text-xs font-semibold text-slate-500 uppercase tracking-wider" style={{ minWidth: reauthVisibleRoles.length > 3 ? '240px' : '300px' }}>
                        Action
                      </th>
                      {reauthVisibleRoles.map(role => (
                        <th key={role.name} className="px-2 pt-4 pb-3 text-center" style={{ minWidth: reauthVisibleRoles.length > 3 ? '105px' : '140px' }}>
                          <div className="flex flex-col items-center gap-1">
                            <div
                              className={`inline-flex items-center rounded-lg font-bold text-white shadow-sm whitespace-nowrap ${reauthVisibleRoles.length > 3 ? 'px-2 py-1 text-[10px]' : 'px-3 py-1.5 text-[11px]'} ${role.color || 'bg-slate-500'}`}
                            >
                              {role.displayName}
                            </div>
                            <span className="text-[10px] text-slate-400 font-medium tabular-nums whitespace-nowrap">
                              {reauthGetRoleConfiguredCount(role.name)} / {reauthStats.totalActions}
                            </span>
                            <div className="flex gap-1">
                              <button
                                onClick={() => reauthSelectAllRole(role.name)}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 hover:bg-blue-100 font-medium transition-colors"
                              >
                                All
                              </button>
                              <button
                                onClick={() => reauthClearRole(role.name)}
                                className="text-[10px] px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 hover:bg-slate-200 font-medium transition-colors"
                              >
                                None
                              </button>
                            </div>
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {reauthFilteredActionsByCategory.map(({ category, actions }) => {
                      const meta = REAUTH_CATEGORY_META[category as ReauthActionCategory];
                      const isCollapsed = reauthCollapsed.has(category);
                      const catStat = reauthStats.categoryStats.find(s => s.category === category);

                      return (
                        <ReauthCategorySection
                          key={category}
                          category={category as ReauthActionCategory}
                          actions={actions}
                          roles={reauthVisibleRoles}
                          meta={meta}
                          isCollapsed={isCollapsed}
                          onToggleCollapse={() => reauthToggleCategory(category)}
                          isChecked={reauthIsChecked}
                          onToggle={reauthToggleAction}
                          onSelectAll={() => reauthSelectAllCategory(category as ReauthActionCategory)}
                          onClear={() => reauthClearCategory(category as ReauthActionCategory)}
                          configuredCount={catStat?.configured ?? 0}
                          totalCount={catStat?.total ?? 0}
                        />
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {reauthFilteredActionsByCategory.length === 0 && (
                <div className="text-center py-12 text-slate-400">
                  <svg className="w-12 h-12 mx-auto mb-3 opacity-50" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                  <p className="font-medium">No actions match "{reauthSearch}"</p>
                  <p className="text-sm mt-1">Try a different search term</p>
                </div>
              )}
            </div>
          </div>
        )}
      </>
    );
  }
);

/* ── Re-auth Category Section Component ── */

function ReauthCategorySection({
  category,
  actions,
  roles,
  meta,
  isCollapsed,
  onToggleCollapse,
  isChecked,
  onToggle,
  onSelectAll,
  onClear,
  configuredCount,
  totalCount,
}: {
  category: ReauthActionCategory;
  actions: { key: string; label: string }[];
  roles: RoleData[];
  meta: { gradient: string; bgLight: string; icon: string; description: string };
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  isChecked: (action: string, role: string) => boolean;
  onToggle: (action: string, role: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  configuredCount: number;
  totalCount: number;
}) {
  return (
    <>
      {/* Category Header Row */}
      <tr className="bg-gradient-to-r from-slate-50 to-white border-y border-slate-100">
        <td className="px-5 py-3 sticky left-0 bg-gradient-to-r from-slate-50 to-white z-10" colSpan={1}>
          <div className="flex items-center gap-3">
            <button
              onClick={onToggleCollapse}
              className="flex items-center gap-3 flex-1 text-left"
            >
              <div className={`p-1.5 rounded-lg bg-gradient-to-br ${meta.gradient} shadow-sm`}>
                <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={meta.icon} />
                </svg>
              </div>
              <div className="flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm font-semibold text-slate-700">{category}</span>
                  <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-medium border ${meta.bgLight}`}>
                    {configuredCount}/{totalCount}
                  </span>
                </div>
                <p className="text-[11px] text-slate-400 mt-0.5">{meta.description}</p>
              </div>
              <svg
                className={`w-4 h-4 text-slate-400 transition-transform duration-200 ${isCollapsed ? '' : 'rotate-180'}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>
            <div className="flex gap-1">
              <button
                onClick={onSelectAll}
                className="text-[10px] px-2 py-1 rounded-md bg-blue-50 text-blue-600 hover:bg-blue-100 font-medium transition-colors border border-blue-100"
              >
                Select All
              </button>
              <button
                onClick={onClear}
                className="text-[10px] px-2 py-1 rounded-md bg-slate-50 text-slate-500 hover:bg-slate-100 font-medium transition-colors border border-slate-200"
              >
                Clear
              </button>
            </div>
          </div>
        </td>
        <td colSpan={roles.length} />
      </tr>
      {/* Action Rows (collapsible) */}
      {!isCollapsed && actions.map(({ key, label }, idx) => (
        <tr
          key={key}
          className={`border-b border-slate-50 hover:bg-blue-50/40 transition-colors ${
            idx % 2 === 0 ? 'bg-white' : 'bg-slate-50/30'
          }`}
        >
          <td className="px-5 py-2.5 sticky left-0 z-10" style={{ background: idx % 2 === 0 ? 'white' : 'rgb(248 250 252 / 0.3)' }}>
            <div className="flex items-center gap-2">
              <span className="w-1 h-1 rounded-full bg-slate-300" />
              <span className="text-sm text-slate-700 font-medium">{label}</span>
            </div>
          </td>
          {roles.map(role => {
            const checked = isChecked(key, role.name);
            return (
              <td key={role.name} className="px-2 py-2.5 text-center">
                <label className="inline-flex items-center justify-center cursor-pointer group/check">
                  <div className="relative">
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => onToggle(key, role.name)}
                      className="sr-only peer"
                    />
                    <div className={`w-5 h-5 rounded-md border-2 transition-all duration-150 flex items-center justify-center
                      ${checked
                        ? 'border-blue-500 bg-blue-500 shadow-sm shadow-blue-500/25'
                        : 'border-slate-300 bg-white group-hover/check:border-slate-400 group-hover/check:bg-slate-50'
                      }`}
                    >
                      {checked && (
                        <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                        </svg>
                      )}
                    </div>
                  </div>
                </label>
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
