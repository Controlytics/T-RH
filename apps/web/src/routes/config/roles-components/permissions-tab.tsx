import { useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { api } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { FEATURE_PRIVILEGES } from '@digilog/shared';
import type { RoleData } from '@digilog/shared';
import { groupFeaturePrivilegesByTree } from './permission-tree-grouping';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PermissionsTabHandle {
  save: () => Promise<void>;
}

interface PermissionsTabProps {
  selectableRoles: RoleData[];
  onStateChange: (state: { dirty: boolean; saving: boolean }) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const DEFAULT_ROLE_ICON = 'M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z';

// ─── Component ────────────────────────────────────────────────────────────────

export const PermissionsTab = forwardRef<PermissionsTabHandle, PermissionsTabProps>(
  function PermissionsTab({ selectableRoles, onStateChange }, ref) {
    const { toast } = useToast();

    const [permSelectedRole, setPermSelectedRole] = useState<string>('ADMIN');
    const [permissions, setPermissions] = useState<Record<string, boolean>>({});
    const [permSaving, setPermSaving] = useState(false);
    const [permDirty, setPermDirty] = useState(false);

    // Load role config — contract: SWR /api/config/roles/${role} → data.permissions
    const { data: roleConfig, isLoading: permLoading } = useSWR(
      `/api/config/roles/${permSelectedRole}`,
      { onSuccess: (data) => { setPermissions(data.permissions || {}); setPermDirty(false); } }
    );

    // Save — contract: PUT /api/config/roles/${role} with { permissions: Record<featureId, boolean> }
    const handlePermSave = useCallback(async () => {
      setPermSaving(true);
      try {
        await api.put(`/api/config/roles/${permSelectedRole}`, { permissions });
        setPermDirty(false);
      } catch (error: any) {
        toast.error('Save Failed', error.message || 'Failed to save permissions');
      } finally {
        setPermSaving(false);
      }
    }, [permSelectedRole, permissions, roleConfig, toast]);

    useEffect(() => {
      onStateChange({ dirty: permDirty, saving: permSaving });
    }, [permDirty, permSaving, onStateChange]);

    useImperativeHandle(ref, () => ({ save: handlePermSave }), [handlePermSave]);

    // ── Permission toggle helpers ──────────────────────────────────────────
    const togglePermission = (featureId: string) => {
      setPermissions(prev => ({ ...prev, [featureId]: !prev[featureId] }));
      setPermDirty(true);
    };

    const toggleGroup = (fpNodeIds: string[], value: boolean) => {
      const updates: Record<string, boolean> = {};
      fpNodeIds.forEach(id => { updates[id] = value; });
      setPermissions(prev => ({ ...prev, ...updates }));
      setPermDirty(true);
    };

    const isGroupFullyEnabled = (fpNodeIds: string[]) =>
      fpNodeIds.length > 0 && fpNodeIds.every(id => permissions[id]);

    const isGroupAnyEnabled = (fpNodeIds: string[]) =>
      fpNodeIds.some(id => permissions[id]);

    const enabledInGroup = (fpNodeIds: string[]) =>
      fpNodeIds.filter(id => permissions[id]).length;

    // ── Grouped tree (stable across renders) ──────────────────────────────
    const { groups: treeGroups, other: otherNodes } = useMemo(
      () => groupFeaturePrivilegesByTree(),
      []
    );

    // ── Stats ─────────────────────────────────────────────────────────────
    const enabledCount = Object.values(permissions).filter(Boolean).length;
    const enabledPercentage = Math.round((enabledCount / FEATURE_PRIVILEGES.length) * 100);

    // ─────────────────────────────────────────────────────────────────────
    return (
      <>
        {/* Role Selection Card */}
        <Card className="border-0 shadow-xl bg-gradient-to-br from-white via-white to-slate-50/50 overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-violet-500 via-purple-500 to-indigo-500" />
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="p-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-500/25">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" />
                </svg>
              </div>
              <div>
                <h3 className="font-bold text-slate-800">Select Role to Configure</h3>
                <p className="text-xs text-slate-500">Choose a role to manage its permissions</p>
              </div>
            </div>

            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
              {selectableRoles.map((role) => {
                const color = role.color || '#64748b';
                return (
                  <button key={role.name} onClick={() => { setPermSelectedRole(role.name); setPermDirty(false); }}
                    className={`relative group p-4 rounded-2xl border-2 transition-all duration-300 ${
                      permSelectedRole === role.name ? 'border-transparent shadow-xl scale-[1.02]' : 'border-slate-200 hover:border-slate-300 hover:shadow-lg'
                    }`}>
                    {permSelectedRole === role.name && <div className="absolute inset-0 rounded-2xl bg-gradient-to-br from-slate-500 to-slate-600 opacity-10" />}
                    <div className="relative">
                      <div className={`w-12 h-12 mx-auto rounded-xl flex items-center justify-center mb-3 transition-all ${
                        permSelectedRole === role.name ? 'text-white shadow-lg' : 'bg-slate-100 text-slate-500 group-hover:bg-slate-200'
                      }`} style={permSelectedRole === role.name ? { background: color } : undefined}>
                        <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={DEFAULT_ROLE_ICON} />
                        </svg>
                      </div>
                      <p className={`text-sm font-semibold text-center ${permSelectedRole === role.name ? 'text-slate-800' : 'text-slate-600'}`}>
                        {role.displayName}
                      </p>
                      {permSelectedRole === role.name && (
                        <div className="absolute -top-1 -right-1">
                          <div className="w-5 h-5 rounded-full flex items-center justify-center shadow-lg" style={{ background: color }}>
                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                            </svg>
                          </div>
                        </div>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="mt-5 p-4 rounded-xl bg-gradient-to-r from-amber-50 to-orange-50 border border-amber-200/50">
              <div className="flex items-center gap-3 text-amber-800">
                <div className="p-2 rounded-lg bg-amber-100">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div className="text-sm">
                  <span className="font-semibold">Note:</span> Super Admin has all permissions by default and cannot be modified.
                </div>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-0 shadow-lg overflow-hidden">
            <div className="h-1" style={{ background: selectableRoles.find(r => r.name === permSelectedRole)?.color || '#64748b' }} />
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white shadow-lg" style={{ background: selectableRoles.find(r => r.name === permSelectedRole)?.color || '#64748b' }}>
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={DEFAULT_ROLE_ICON} />
                  </svg>
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">Selected Role</p>
                  <p className="text-xl font-bold text-slate-800">{selectableRoles.find(r => r.name === permSelectedRole)?.displayName || permSelectedRole}</p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-lg overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-emerald-500 to-green-500" />
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center text-white shadow-lg">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">Enabled</p>
                  <p className="text-xl font-bold text-slate-800">{enabledCount} <span className="text-sm font-normal text-slate-400">/ {FEATURE_PRIVILEGES.length}</span></p>
                </div>
              </div>
            </CardContent>
          </Card>

          <Card className="border-0 shadow-lg overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-blue-500 to-indigo-500" />
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-lg">
                    <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-xs text-slate-500 uppercase tracking-wider font-medium">Access Level</p>
                    <p className="text-xl font-bold text-slate-800">{enabledPercentage}%</p>
                  </div>
                </div>
                <div className="w-16 h-16">
                  <svg viewBox="0 0 36 36" className="w-full h-full transform -rotate-90">
                    <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="#e2e8f0" strokeWidth="3" />
                    <path d="M18 2.0845 a 15.9155 15.9155 0 0 1 0 31.831 a 15.9155 15.9155 0 0 1 0 -31.831" fill="none" stroke="url(#perm-gradient)" strokeWidth="3" strokeDasharray={`${enabledPercentage}, 100`} strokeLinecap="round" />
                    <defs>
                      <linearGradient id="perm-gradient">
                        <stop offset="0%" stopColor="#3b82f6" />
                        <stop offset="100%" stopColor="#6366f1" />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Permissions Tree — Sidebar → Page → Action */}
        <Card className="border-0 shadow-xl overflow-hidden">
          <CardContent className="p-0">
            {permLoading ? (
              <div className="p-16 text-center">
                <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 mb-4 animate-pulse">
                  <svg className="w-8 h-8 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                </div>
                <p className="text-slate-600 font-medium">Loading permissions...</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">

                {/* ── Sidebar groups (in PERMISSION_TREE order) ── */}
                {treeGroups.map((group) => {
                  const groupEnabled = enabledInGroup(group.fpNodeIds);
                  const groupTotal = group.fpNodeIds.length;
                  const fullyEnabled = isGroupFullyEnabled(group.fpNodeIds);
                  const anyEnabled = isGroupAnyEnabled(group.fpNodeIds);
                  const hasMultiplePages = group.pageGroups.length > 1;

                  return (
                    <div key={group.sidebarId} className="p-6">
                      {/* Group header */}
                      <div className="flex items-center justify-between mb-5">
                        <div className="flex items-center gap-3">
                          <div className="w-11 h-11 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-xl flex-shrink-0">
                            {group.icon}
                          </div>
                          <div>
                            <h3 className="font-bold text-slate-800">{group.label}</h3>
                            <p className="text-xs text-slate-500">{groupEnabled} of {groupTotal} enabled</p>
                          </div>
                        </div>
                        <div className="flex gap-2">
                          <Button
                            variant="outline" size="sm"
                            onClick={() => toggleGroup(group.fpNodeIds, true)}
                            disabled={fullyEnabled}
                            className="rounded-lg text-xs hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200"
                          >
                            <svg className="w-3.5 h-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            </svg>
                            Enable All
                          </Button>
                          <Button
                            variant="outline" size="sm"
                            onClick={() => toggleGroup(group.fpNodeIds, false)}
                            disabled={!anyEnabled}
                            className="rounded-lg text-xs hover:bg-red-50 hover:text-red-600 hover:border-red-200"
                          >
                            <svg className="w-3.5 h-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                            </svg>
                            Disable All
                          </Button>
                        </div>
                      </div>

                      {/* Page sub-groups */}
                      <div className="space-y-4">
                        {group.pageGroups.map((pageGroup) => (
                          <div key={pageGroup.page}>
                            {/* Page sub-header — shown only when the group spans multiple pages */}
                            {hasMultiplePages && (
                              <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2 pl-1">
                                {pageGroup.page}
                              </p>
                            )}
                            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                              {pageGroup.nodes.map((node) => (
                                <label
                                  key={node.id}
                                  className={`group relative flex items-center gap-4 p-4 rounded-xl border-2 transition-all duration-200 cursor-pointer ${
                                    permissions[node.id]
                                      ? 'bg-gradient-to-r from-emerald-50 to-green-50 border-emerald-200 shadow-md'
                                      : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm'
                                  }`}
                                >
                                  <input
                                    type="checkbox"
                                    checked={permissions[node.id] || false}
                                    onChange={() => togglePermission(node.id)}
                                    className="sr-only"
                                  />
                                  {/* Custom checkbox */}
                                  <div className={`flex-shrink-0 w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${
                                    permissions[node.id]
                                      ? 'bg-gradient-to-br from-emerald-500 to-green-600 border-emerald-500 shadow-md'
                                      : 'bg-white border-slate-300 group-hover:border-slate-400'
                                  }`}>
                                    {permissions[node.id] && (
                                      <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                                      </svg>
                                    )}
                                  </div>
                                  {/* Label + reauth badge */}
                                  <div className="flex-1 min-w-0">
                                    <span className={`text-sm font-medium transition-colors ${
                                      permissions[node.id] ? 'text-emerald-800' : 'text-slate-600'
                                    }`}>
                                      {node.label}
                                    </span>
                                    {node.reauthAction && (
                                      <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-600 text-xs font-medium whitespace-nowrap">
                                        🔒 re-auth
                                      </span>
                                    )}
                                  </div>
                                  {/* Enabled pulse dot */}
                                  {permissions[node.id] && (
                                    <span className="flex-shrink-0 w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                                  )}
                                </label>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}

                {/* ── Catch-all: FP ids not in PERMISSION_TREE (should be empty) ── */}
                {otherNodes.length > 0 && (
                  <div className="p-6">
                    <div className="flex items-center justify-between mb-5">
                      <div className="flex items-center gap-3">
                        <div className="w-11 h-11 rounded-xl bg-slate-100 border border-slate-200 flex items-center justify-center text-xl flex-shrink-0">
                          ⚙️
                        </div>
                        <div>
                          <h3 className="font-bold text-slate-800">Other Permissions</h3>
                          <p className="text-xs text-slate-500">{enabledInGroup(otherNodes.map(n => n.id))} of {otherNodes.length} enabled</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button
                          variant="outline" size="sm"
                          onClick={() => toggleGroup(otherNodes.map(n => n.id), true)}
                          disabled={isGroupFullyEnabled(otherNodes.map(n => n.id))}
                          className="rounded-lg text-xs hover:bg-emerald-50 hover:text-emerald-600 hover:border-emerald-200"
                        >
                          <svg className="w-3.5 h-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                          </svg>
                          Enable All
                        </Button>
                        <Button
                          variant="outline" size="sm"
                          onClick={() => toggleGroup(otherNodes.map(n => n.id), false)}
                          disabled={!isGroupAnyEnabled(otherNodes.map(n => n.id))}
                          className="rounded-lg text-xs hover:bg-red-50 hover:text-red-600 hover:border-red-200"
                        >
                          <svg className="w-3.5 h-3.5 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                          </svg>
                          Disable All
                        </Button>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                      {otherNodes.map((node) => (
                        <label
                          key={node.id}
                          className={`group relative flex items-center gap-4 p-4 rounded-xl border-2 transition-all duration-200 cursor-pointer ${
                            permissions[node.id]
                              ? 'bg-gradient-to-r from-emerald-50 to-green-50 border-emerald-200 shadow-md'
                              : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm'
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={permissions[node.id] || false}
                            onChange={() => togglePermission(node.id)}
                            className="sr-only"
                          />
                          <div className={`flex-shrink-0 w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${
                            permissions[node.id]
                              ? 'bg-gradient-to-br from-emerald-500 to-green-600 border-emerald-500 shadow-md'
                              : 'bg-white border-slate-300 group-hover:border-slate-400'
                          }`}>
                            {permissions[node.id] && (
                              <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </div>
                          <div className="flex-1 min-w-0">
                            <span className={`text-sm font-medium transition-colors ${
                              permissions[node.id] ? 'text-emerald-800' : 'text-slate-600'
                            }`}>
                              {node.label}
                            </span>
                          </div>
                          {permissions[node.id] && (
                            <span className="flex-shrink-0 w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                          )}
                        </label>
                      ))}
                    </div>
                  </div>
                )}

              </div>
            )}
          </CardContent>
        </Card>

        {/* Security Notice */}
        <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-amber-50 via-orange-50 to-red-50 border border-amber-100/50 p-5">
          <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-amber-500/10 to-orange-500/10 rounded-full blur-3xl" />
          <div className="relative flex items-start gap-4">
            <div className="flex-shrink-0 p-3 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg shadow-amber-500/25">
              <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
              </svg>
            </div>
            <div>
              <h3 className="font-bold text-amber-900 mb-1">Security Notice</h3>
              <p className="text-sm text-amber-700">Role permissions determine what actions users can perform. Changes take effect immediately for all users with the selected role.</p>
              <div className="flex items-center gap-4 mt-3">
                <div className="flex items-center gap-1.5 text-xs text-amber-600">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z" />
                  </svg>
                  <span>21 CFR Part 11 compliant</span>
                </div>
                <div className="flex items-center gap-1.5 text-xs text-amber-600">
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  <span>All changes are audit logged</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </>
    );
  }
);
