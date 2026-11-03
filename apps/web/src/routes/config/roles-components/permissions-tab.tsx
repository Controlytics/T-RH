import { useState, useEffect, useCallback, useMemo, forwardRef, useImperativeHandle } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Input } from '@/components/ui/input';
import { FEATURE_PRIVILEGES } from '@digilog/shared';
import type { RoleData } from '@digilog/shared';
import { groupFeaturePrivilegesByTree } from './permission-tree-grouping';
import type { TreePermissionNode } from './permission-tree-grouping';
import { heldToggles, heldCaption } from './held-toggles';
import { SkeletonRows } from '@/components/ui/skeleton';

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PermissionsTabHandle {
  save: () => Promise<void>;
}

interface PermissionsTabProps {
  selectableRoles: RoleData[];
  onStateChange: (state: { dirty: boolean; saving: boolean }) => void;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// A role with no colour of its own takes the SITE THEME, and the access ring is
// the theme gradient (audit 2026-10-03, WEB-17) — the fixed slate and blue were
// the one patch of this screen the ten presets did not reach.
const DEFAULT_ROLE_ICON ='M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z';

// One stable empty list, so the held computation is not redone every render
// for a role with no stored sidebar selection.
const NO_SIDEBAR_ITEMS: readonly string[] = [];

// ─── One toggle ───────────────────────────────────────────────────────────────

/**
 * A toggle that is OFF in the user's own map but that the save will bring back
 * ON (2026-11-03) renders CHECKED and DISABLED with `caption` — "Held by …" —
 * under its label, so un-selecting it says at once why it stays.
 */
function PermissionToggle({ node, on, caption, onToggle }: {
  node: TreePermissionNode;
  on: boolean;
  /** Present iff the toggle is held. */
  caption?: string;
  onToggle: () => void;
}) {
  const held = caption !== undefined;
  const captionId = `perm-held-${node.id}`;
  return (
    <label
      data-held={held ? 'true' : undefined}
      className={`group relative flex items-center gap-4 p-4 rounded-xl border-2 transition-all duration-200 ${
        held
          ? 'cursor-not-allowed border-dashed bg-emerald-50/60 border-emerald-200'
          : on
            ? 'cursor-pointer bg-gradient-to-r from-emerald-50 to-green-50 border-emerald-200 shadow-[var(--elev-1)]'
            : 'cursor-pointer bg-white border-slate-200 hover:border-slate-300 hover:shadow-[var(--elev-1)]'
      }`}
    >
      <input
        type="checkbox"
        checked={on}
        disabled={held}
        aria-disabled={held ? 'true' : undefined}
        aria-describedby={held ? captionId : undefined}
        data-held={held ? 'true' : undefined}
        // `disabled` stops a browser click; a change event from anywhere else
        // (jsdom delivers one) must not flip a held toggle either.
        onChange={() => { if (!held) onToggle(); }}
        className="sr-only"
      />
      {/* Custom checkbox — a held one is ticked but muted */}
      <div className={`flex-shrink-0 w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${
        held
          ? 'bg-emerald-300 border-emerald-300'
          : on
            ? 'bg-gradient-to-br from-emerald-500 to-green-600 border-emerald-500 shadow-[var(--elev-1)]'
            : 'bg-white border-slate-300 group-hover:border-slate-400'
      }`}>
        {on && (
          <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" />
          </svg>
        )}
      </div>
      {/* Label + reauth badge + why it is held */}
      <div className="flex-1 min-w-0">
        <span className={`text-sm font-medium transition-colors ${on ? 'text-emerald-800' : 'text-slate-600'}`}>
          {node.label}
        </span>
        {node.reauthAction && (
          <span className="ml-2 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md bg-amber-50 border border-amber-200 text-amber-600 text-xs font-medium whitespace-nowrap">
            🔒 re-auth
          </span>
        )}
        {held && <p id={captionId} className="mt-1 text-xs text-slate-500">{caption}</p>}
      </div>
      {/* Enabled pulse dot — the role's own choice only */}
      {on && !held && (
        <span className="flex-shrink-0 w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
      )}
    </label>
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export const PermissionsTab = forwardRef<PermissionsTabHandle, PermissionsTabProps>(
  function PermissionsTab({ selectableRoles, onStateChange }, ref) {
    const { toast } = useToast();

    const [permSelectedRole, setPermSelectedRole] = useState<string>('ADMIN');
    const [permissions, setPermissions] = useState<Record<string, boolean>>({});
    const [permSaving, setPermSaving] = useState(false);
    const [permDirty, setPermDirty] = useState(false);
    const [reason, setReason] = useState('');
    const reauth = useReauth();

    // Load role config — contract: SWR /api/config/roles/${role} → data.permissions
    const { data: roleConfig, isLoading: permLoading, mutate: reloadRoleConfig } = useSWR(
      `/api/config/roles/${permSelectedRole}`,
      { onSuccess: (data) => { setPermissions(data.permissions || {}); setPermDirty(false); } }
    );

    // Save — contract: PUT /api/config/roles/${role} with { permissions, reason }.
    // The server demands a REASON whenever the permission SET changes (audit
    // 2026-10-03, DATA-11) and challenges the save under UPDATE_ROLE_CONFIG,
    // so the save runs through the re-auth hook (it was a bare put — a role
    // whose matrix asked for a password could never save here). The callback
    // is idempotent: the hook replays it after a 401.
    const handlePermSave = useCallback(async () => {
      const why = reason.trim();
      if (!why) {
        toast.error('Reason required', 'State why these permissions are changing — it is recorded in the audit trail.');
        return;
      }
      setPermSaving(true);
      let done = false;
      await reauth.execute('UPDATE_ROLE_CONFIG', async (password?: string) => {
        if (done) return;
        const body = { permissions, reason: why };
        if (password) await apiClient.putWithReauth(`/api/config/roles/${permSelectedRole}`, body, password);
        else await apiClient.put(`/api/config/roles/${permSelectedRole}`, body);
        done = true;
      }, {
        // Re-read the SERVER's toggles: they are derived from what the role now
        // holds, so a toggle another one implies (Edit Instruments implies Edit
        // Settings — INSTRUMENT_UPDATE implies INSTRUMENT_ATTRIBUTE_UPDATE) shows
        // its real state.
        onSuccess: () => { setPermDirty(false); setReason(''); setPermSaving(false); void reloadRoleConfig(); },
        onError: (error: unknown) => {
          toast.error('Save Failed', (error as { message?: string })?.message || 'Failed to save permissions');
          setPermSaving(false);
        },
        onCancel: () => setPermSaving(false),
      });
    }, [permSelectedRole, permissions, reason, reauth, toast, reloadRoleConfig]);

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

    // ── What the save will decide (2026-11-03) ─────────────────────────────
    // The server rebuilds the role from these toggles and the role's STORED
    // sidebar items (this PUT sends none), then reads the toggles back. A
    // toggle OFF here that comes back ON is HELD — by another ON toggle, an
    // implication or a sidebar item — and is drawn checked, disabled and
    // named. The PUT is unchanged: the user's own toggles; the server decides.
    const sidebarItems: readonly string[] = (roleConfig?.sidebarItems as string[] | undefined) ?? NO_SIDEBAR_ITEMS;
    const held = useMemo(() => heldToggles(permissions, sidebarItems), [permissions, sidebarItems]);
    const isOn = (id: string) => !!permissions[id] || !!held.shown[id];
    const captionFor = (id: string) => (held.heldBy[id] ? heldCaption(held.heldBy[id]) : undefined);

    // Counters and Enable All count what the role WILL hold, held toggles
    // included; Disable All looks only at the role's OWN toggles — a group
    // held only by a sidebar item has nothing of its own to turn off.
    const isGroupFullyEnabled = (fpNodeIds: string[]) =>
      fpNodeIds.length > 0 && fpNodeIds.every(isOn);

    const isGroupAnyEnabled = (fpNodeIds: string[]) =>
      fpNodeIds.some(id => permissions[id]);

    const enabledInGroup = (fpNodeIds: string[]) =>
      fpNodeIds.filter(isOn).length;

    // ── Grouped tree (stable across renders) ──────────────────────────────
    const { groups: treeGroups, other: otherNodes } = useMemo(
      () => groupFeaturePrivilegesByTree(),
      []
    );

    // ── Stats ─────────────────────────────────────────────────────────────
    const enabledCount = FEATURE_PRIVILEGES.filter(fp => isOn(fp.id)).length;
    const enabledPercentage = Math.round((enabledCount / FEATURE_PRIVILEGES.length) * 100);

    // ─────────────────────────────────────────────────────────────────────
    return (
      <>
        {/* Role Selection Card */}
        <Card className="border-0 shadow-[var(--elev-2)] bg-gradient-to-br from-white via-white to-slate-50/50 overflow-hidden">
          <div className="h-1 bg-gradient-to-r from-violet-500 via-purple-500 to-indigo-500" />
          <CardContent className="p-6">
            <div className="flex items-center gap-3 mb-5">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-slate-100 text-slate-600">
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
                const color = role.color || 'var(--theme-primary, #2a78d6)';
                return (
                  <button key={role.name} onClick={() => { setPermSelectedRole(role.name); setPermDirty(false); }}
                    className={`relative group p-4 rounded-[var(--radius-card)] border-2 transition-all duration-300 ${
                      permSelectedRole === role.name ? 'border-transparent shadow-[var(--elev-2)] scale-[1.02]' : 'border-slate-200 hover:border-slate-300 hover:shadow-[var(--elev-2)]'
                    }`}>
                    {permSelectedRole === role.name && <div className="absolute inset-0 rounded-[var(--radius-card)] bg-gradient-to-br from-slate-500 to-slate-600 opacity-10" />}
                    <div className="relative">
                      <div className={`w-12 h-12 mx-auto rounded-xl flex items-center justify-center mb-3 transition-all ${
                        permSelectedRole === role.name ? 'text-white shadow-[var(--elev-2)]' : 'bg-slate-100 text-slate-500 group-hover:bg-slate-200'
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
                          <div className="w-5 h-5 rounded-full flex items-center justify-center shadow-[var(--elev-2)]" style={{ background: color }}>
                            <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
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
            {permDirty && (
              <div className="mt-5">
                <label htmlFor="perm-reason" className="mb-1 block text-xs font-medium text-slate-600">Reason for change</label>
                <Input id="perm-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)}
                  placeholder="Why are these permissions changing? Recorded in the audit trail." />
              </div>
            )}
          </CardContent>
        </Card>

        {/* Stats Cards */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
            <div className="h-1" style={{ background: selectableRoles.find(r => r.name === permSelectedRole)?.color || 'var(--theme-primary, #2a78d6)' }} />
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white shadow-[var(--elev-2)]" style={{ background: selectableRoles.find(r => r.name === permSelectedRole)?.color || 'var(--theme-primary, #2a78d6)' }}>
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

          <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-emerald-500 to-green-500" />
            <CardContent className="p-4">
              <div className="flex items-center gap-3">
                <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center text-white shadow-[var(--elev-2)]">
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

          <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
            <div className="h-1 bg-gradient-to-r from-blue-500 to-indigo-500" />
            <CardContent className="p-4">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-600 flex items-center justify-center text-white shadow-[var(--elev-2)]">
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
                        <stop offset="0%" style={{ stopColor: 'var(--theme-gradient-from, #3b82f6)' }} />
                        <stop offset="100%" style={{ stopColor: 'var(--theme-gradient-to, #6366f1)' }} />
                      </linearGradient>
                    </defs>
                  </svg>
                </div>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* Permissions Tree — Sidebar → Page → Action */}
        <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
          <CardContent className="p-0">
            {permLoading ? (
              <div className="p-16 text-center">
<SkeletonRows rows={6} columns={2} />
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
                    <div key={group.sidebarId} className="p-6" data-testid={`perm-group-${group.sidebarId}`}>
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
                                <PermissionToggle
                                  key={node.id}
                                  node={node}
                                  on={isOn(node.id)}
                                  caption={captionFor(node.id)}
                                  onToggle={() => togglePermission(node.id)}
                                />
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
                        <PermissionToggle
                          key={node.id}
                          node={node}
                          on={isOn(node.id)}
                          caption={captionFor(node.id)}
                          onToggle={() => togglePermission(node.id)}
                        />
                      ))}
                    </div>
                  </div>
                )}

              </div>
            )}
          </CardContent>
        </Card>

        {/* Security Notice */}
        <div className="relative overflow-hidden rounded-[var(--radius-card)] bg-gradient-to-r from-amber-50 via-orange-50 to-red-50 border border-amber-100/50 p-5">
          <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-amber-500/10 to-orange-500/10 rounded-full blur-3xl" />
          <div className="relative flex items-start gap-4">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-slate-100 text-slate-600">
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
        <ReauthDialog
          open={reauth.isOpen}
          password={reauth.password}
          error={reauth.error}
          isVerifying={reauth.isVerifying}
          onPasswordChange={reauth.setPassword}
          onConfirm={reauth.confirm}
          onCancel={reauth.cancel}
        />
      </>
    );
  }
);
