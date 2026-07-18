import { useState, useEffect, useCallback, forwardRef, useImperativeHandle, type ReactNode } from 'react';
import useSWR from 'swr';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { api } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { SIDEBAR_ITEMS } from '@digilog/shared';
import type { RoleData } from '@digilog/shared';

interface User {
  id: string;
  username: string;
  fullName: string;
  role: string;
  status: string;
}

export interface SidebarTabHandle {
  save: () => Promise<void>;
}

interface SidebarTabProps {
  activeRoles: RoleData[];
  onStateChange: (state: { dirty: boolean; saving: boolean; canSave: boolean }) => void;
}

export const SidebarTab = forwardRef<SidebarTabHandle, SidebarTabProps>(
  function SidebarTab({ activeRoles, onStateChange }, ref) {
    const { toast } = useToast();

    const [sidebarSubTab, setSidebarSubTab] = useState<'role' | 'user'>('role');
    const [sidebarSelectedRole, setSidebarSelectedRole] = useState<string>('');
    const [selectedUser, setSelectedUser] = useState<User | null>(null);
    const [enabledItems, setEnabledItems] = useState<string[]>([]);
    const [searchQuery, setSearchQuery] = useState('');
    const [sidebarSaving, setSidebarSaving] = useState(false);
    const [sidebarDirty, setSidebarDirty] = useState(false);
    const [isTransitioning, setIsTransitioning] = useState(false);

    const allRoles = activeRoles || [];

    useEffect(() => {
      if (allRoles.length > 0 && !sidebarSelectedRole) {
        const admin = allRoles.find(r => r.name === 'ADMIN');
        setSidebarSelectedRole(admin?.name || allRoles[0].name);
      }
    }, [allRoles, sidebarSelectedRole]);

    const { data: usersData, isLoading: loadingUsers } = useSWR('/api/users');

    const { data: sidebarRoleConfig, isLoading: loadingSidebarRoleConfig, isValidating: validatingSidebarRoleConfig } = useSWR(
      sidebarSubTab === 'role' && sidebarSelectedRole ? `/api/config/roles/${sidebarSelectedRole}` : null,
      {
        revalidateOnMount: true, dedupingInterval: 0,
        onSuccess: (data) => { setEnabledItems(data.sidebarItems || SIDEBAR_ITEMS.map(i => i.id)); setSidebarDirty(false); setIsTransitioning(false); },
      }
    );

    const { data: userConfig, isLoading: loadingUserConfig, isValidating: validatingUserConfig } = useSWR(
      sidebarSubTab === 'user' && selectedUser ? `/api/config/users/${selectedUser.id}` : null,
      {
        revalidateOnMount: true, dedupingInterval: 0,
        onSuccess: (data) => { setEnabledItems(data.sidebarItems || []); setSidebarDirty(false); setIsTransitioning(false); },
      }
    );

    const handleSidebarRoleChange = useCallback((role: string) => {
      if (role !== sidebarSelectedRole) { setIsTransitioning(true); setEnabledItems([]); setSidebarDirty(false); setSidebarSelectedRole(role); }
    }, [sidebarSelectedRole]);

    const handleUserChange = useCallback((u: User) => {
      if (u.id !== selectedUser?.id) { setIsTransitioning(true); setEnabledItems([]); setSidebarDirty(false); setSelectedUser(u); }
    }, [selectedUser]);

    const handleSidebarSubTabChange = useCallback((tab: 'role' | 'user') => {
      if (tab !== sidebarSubTab) { setIsTransitioning(true); setEnabledItems([]); setSidebarDirty(false); setSidebarSubTab(tab); if (tab === 'role') setSelectedUser(null); }
    }, [sidebarSubTab]);

    const toggleSidebarItem = (itemId: string) => {
      setEnabledItems(prev => prev.includes(itemId) ? prev.filter(id => id !== itemId) : [...prev, itemId]);
      setSidebarDirty(true);
    };
    const enableAllSidebar = () => { setEnabledItems(SIDEBAR_ITEMS.map(i => i.id)); setSidebarDirty(true); };
    const disableAllSidebar = () => { setEnabledItems([]); setSidebarDirty(true); };

    const handleSaveSidebarRole = useCallback(async () => {
      setSidebarSaving(true);
      try {
        await api.put(`/api/config/roles/${sidebarSelectedRole}`, { sidebarItems: enabledItems });
        setSidebarDirty(false);
      } catch (error: any) { toast.error('Save Failed', error.message || 'Failed to save sidebar configuration'); } finally { setSidebarSaving(false); }
    }, [sidebarSelectedRole, enabledItems, sidebarRoleConfig, toast]);

    const handleSaveSidebarUser = useCallback(async () => {
      if (!selectedUser) return;
      setSidebarSaving(true);
      try {
        await api.put(`/api/config/users/${selectedUser.id}`, { sidebarItems: enabledItems });
        setSidebarDirty(false);
      } catch (error: any) { toast.error('Save Failed', error.message || 'Failed to save user sidebar configuration'); } finally { setSidebarSaving(false); }
    }, [selectedUser, enabledItems, userConfig, toast]);

    const resetUserToRoleDefault = async () => {
      if (!selectedUser) return;
      setSidebarSaving(true);
      try {
        await api.put(`/api/config/users/${selectedUser.id}`, { sidebarItems: [] });
        setEnabledItems([]); setSidebarDirty(false);
      } catch (error: any) { toast.error('Reset Failed', error.message || 'Failed to reset user to role defaults'); } finally { setSidebarSaving(false); }
    };

    const filteredUsers = usersData?.data?.filter((u: User) =>
      u.username.toLowerCase().includes(searchQuery.toLowerCase()) || u.fullName.toLowerCase().includes(searchQuery.toLowerCase())
    ) || [];

    const sidebarIsLoading = sidebarSubTab === 'role'
      ? (loadingSidebarRoleConfig || validatingSidebarRoleConfig || isTransitioning)
      : (loadingUserConfig || validatingUserConfig || isTransitioning);
    const handleSaveSidebar = sidebarSubTab === 'role' ? handleSaveSidebarRole : handleSaveSidebarUser;
    const canSave = sidebarSubTab === 'role' || !!selectedUser;

    useEffect(() => {
      onStateChange({ dirty: sidebarDirty, saving: sidebarSaving, canSave });
    }, [sidebarDirty, sidebarSaving, canSave, onStateChange]);

    useImperativeHandle(ref, () => ({
      save: handleSaveSidebar,
    }), [handleSaveSidebar]);

    // Group-aware rendering: items with a `group` (e.g. all report pages under
    // "Reports") render nested under a group header so admins can see + pick
    // which reports to grant; ungrouped items render at the top level.
    const ungroupedItems = SIDEBAR_ITEMS.filter(i => !i.group);
    const groupNames = [...new Set(SIDEBAR_ITEMS.filter(i => i.group).map(i => i.group as string))];
    const itemsInGroup = (g: string) => SIDEBAR_ITEMS.filter(i => i.group === g);
    const enableGroup = (g: string, on: boolean) => {
      const ids = itemsInGroup(g).map(i => i.id);
      setEnabledItems(prev => on ? [...new Set([...prev, ...ids])] : prev.filter(id => !ids.includes(id)));
      setSidebarDirty(true);
    };

    const renderRoleCard = (item: typeof SIDEBAR_ITEMS[number]) => {
      const isEnabled = enabledItems.includes(item.id);
      return (
        <div key={item.id} onClick={() => toggleSidebarItem(item.id)} className={`relative p-4 rounded-xl border-2 transition-all cursor-pointer ${
          isEnabled ? 'bg-violet-50 border-violet-300 shadow-md' : 'bg-white border-slate-200 hover:border-slate-300 hover:shadow-sm'
        }`}>
          <div className={`absolute top-3 right-3 w-6 h-6 rounded-full flex items-center justify-center transition-all ${isEnabled ? 'bg-violet-500 text-white' : 'bg-slate-200 text-slate-400'}`}>
            {isEnabled ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
            )}
          </div>
          <div className="flex items-start gap-3">
            <span className="text-2xl">{item.icon}</span>
            <div>
              <h4 className={`font-semibold ${isEnabled ? 'text-violet-800' : 'text-slate-800'}`}>{item.label}</h4>
              <p className={`text-sm mt-1 ${isEnabled ? 'text-violet-600' : 'text-slate-500'}`}>{item.description}</p>
            </div>
          </div>
        </div>
      );
    };

    const renderUserCard = (item: typeof SIDEBAR_ITEMS[number]) => {
      const isEnabled = enabledItems.includes(item.id);
      return (
        <div key={item.id} onClick={() => toggleSidebarItem(item.id)} className={`flex items-center gap-3 p-3 rounded-xl border-2 transition-all cursor-pointer ${
          isEnabled ? 'bg-violet-50 border-violet-300 shadow-sm' : 'bg-white border-slate-200 hover:border-slate-300'
        }`}>
          <span className="text-xl">{item.icon}</span>
          <span className={`flex-1 font-medium text-sm ${isEnabled ? 'text-violet-800' : 'text-slate-600'}`}>{item.label}</span>
          <div className={`w-5 h-5 rounded-full flex items-center justify-center ${isEnabled ? 'bg-violet-500 text-white' : 'bg-slate-200 text-slate-400'}`}>
            {isEnabled ? (
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
            ) : (
              <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6m0 0v6m0-6h6m-6 0H6" /></svg>
            )}
          </div>
        </div>
      );
    };

    const renderGroupSection = (g: string, renderCard: (item: typeof SIDEBAR_ITEMS[number]) => ReactNode, gridCols: string) => {
      const items = itemsInGroup(g);
      const enabledInGroup = items.filter(i => enabledItems.includes(i.id)).length;
      return (
        <div key={g} className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-bold text-slate-700 flex items-center gap-2">
              <span className="text-lg">📊</span> {g}
              <span className="text-xs font-normal text-slate-400">({enabledInGroup}/{items.length})</span>
            </h3>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={() => enableGroup(g, true)} disabled={enabledInGroup === items.length}>Enable All</Button>
              <Button variant="outline" size="sm" onClick={() => enableGroup(g, false)} disabled={enabledInGroup === 0}>Disable All</Button>
            </div>
          </div>
          <div className={`grid ${gridCols} gap-3`}>
            {items.map(renderCard)}
          </div>
        </div>
      );
    };

    // ── Display-order ("Arrange Order") support ──────────────────────────────
    // The saved `enabledItems` array IS the order (the sidebar renders in this
    // order). Grouped items (e.g. all reports) move as one unit, with their own
    // internal order. buildOrderUnits derives the structured view; flattenUnits
    // serialises it back to the flat array, keeping each group contiguous.
    type SItem = typeof SIDEBAR_ITEMS[number];
    type OrderUnit = { kind: 'item'; item: SItem } | { kind: 'group'; name: string; children: SItem[] };
    const buildOrderUnits = (enabled: string[]): OrderUnit[] => {
      const units: OrderUnit[] = [];
      const groupUnits = new Map<string, { kind: 'group'; name: string; children: SItem[] }>();
      for (const id of enabled) {
        const item = SIDEBAR_ITEMS.find(i => i.id === id);
        if (!item) continue;
        if (item.group) {
          let gu = groupUnits.get(item.group);
          if (!gu) { gu = { kind: 'group', name: item.group, children: [] }; groupUnits.set(item.group, gu); units.push(gu); }
          gu.children.push(item);
        } else {
          units.push({ kind: 'item', item });
        }
      }
      return units;
    };
    const flattenUnits = (units: OrderUnit[]): string[] =>
      units.flatMap(u => u.kind === 'item' ? [u.item.id] : u.children.map(c => c.id));
    const moveUnit = (index: number, dir: -1 | 1) => {
      const units = buildOrderUnits(enabledItems);
      const j = index + dir;
      if (j < 0 || j >= units.length) return;
      [units[index], units[j]] = [units[j], units[index]];
      setEnabledItems(flattenUnits(units)); setSidebarDirty(true);
    };
    const moveChild = (groupName: string, ci: number, dir: -1 | 1) => {
      const units = buildOrderUnits(enabledItems);
      const gu = units.find(u => u.kind === 'group' && u.name === groupName) as { kind: 'group'; name: string; children: SItem[] } | undefined;
      if (!gu) return;
      const j = ci + dir;
      if (j < 0 || j >= gu.children.length) return;
      [gu.children[ci], gu.children[j]] = [gu.children[j], gu.children[ci]];
      setEnabledItems(flattenUnits(units)); setSidebarDirty(true);
    };
    const arrowBtn = (onClick: () => void, disabled: boolean, dir: 'up' | 'down') => (
      <button type="button" onClick={onClick} disabled={disabled}
        className="w-7 h-7 rounded-lg border border-slate-200 bg-white text-slate-500 hover:bg-slate-100 hover:text-slate-700 disabled:opacity-30 disabled:cursor-not-allowed flex items-center justify-center">
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d={dir === 'up' ? 'M5 15l7-7 7 7' : 'M19 9l-7 7-7-7'} /></svg>
      </button>
    );
    const renderOrderPanel = () => {
      const units = buildOrderUnits(enabledItems);
      if (units.length === 0) return null;
      return (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-2">
            <svg className="w-5 h-5 text-violet-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" /></svg>
            <h3 className="font-bold text-slate-700">Display Order</h3>
          </div>
          <p className="text-xs text-slate-500 mt-1 mb-3">Arrange how the enabled menu items appear in the sidebar for this role. Reports stay grouped — reorder the group as a whole, or its reports inside.</p>
          <div className="space-y-1.5">
            {units.map((u, idx) => (
              <div key={u.kind === 'item' ? u.item.id : `group:${u.name}`}>
                <div className="flex items-center gap-2 p-2.5 rounded-lg border border-slate-200 bg-slate-50">
                  <span className="text-lg w-6 text-center">{u.kind === 'item' ? u.item.icon : '📊'}</span>
                  <span className="flex-1 text-sm font-medium text-slate-700">
                    {u.kind === 'item' ? u.item.label : `${u.name}`}
                    {u.kind === 'group' && <span className="ml-1.5 text-[11px] font-normal text-slate-400">({u.children.length} reports)</span>}
                  </span>
                  {arrowBtn(() => moveUnit(idx, -1), idx === 0, 'up')}
                  {arrowBtn(() => moveUnit(idx, 1), idx === units.length - 1, 'down')}
                </div>
                {u.kind === 'group' && (
                  <div className="ml-7 mt-1 space-y-1 border-l border-slate-200 pl-3">
                    {u.children.map((c, ci) => (
                      <div key={c.id} className="flex items-center gap-2 p-2 rounded-lg border border-slate-100 bg-white">
                        <span className="text-base w-5 text-center">{c.icon}</span>
                        <span className="flex-1 text-xs font-medium text-slate-600">{c.label}</span>
                        {arrowBtn(() => moveChild(u.name, ci, -1), ci === 0, 'up')}
                        {arrowBtn(() => moveChild(u.name, ci, 1), ci === u.children.length - 1, 'down')}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      );
    };

    return (
      <div className="bg-white rounded-2xl border border-slate-200/60 shadow-soft overflow-hidden">
        {/* Inner tabs: Role / User */}
        <div className="flex border-b border-slate-200">
          <button onClick={() => handleSidebarSubTabChange('role')} className={`flex-1 px-6 py-4 text-sm font-medium transition-all flex items-center justify-center gap-2 ${
            sidebarSubTab === 'role' ? 'bg-violet-50 text-violet-700 border-b-2 border-violet-500' : 'text-slate-600 hover:bg-slate-50'
          }`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0zm6 3a2 2 0 11-4 0 2 2 0 014 0zM7 10a2 2 0 11-4 0 2 2 0 014 0z" /></svg>
            Configure by Role
          </button>
          <button onClick={() => handleSidebarSubTabChange('user')} className={`flex-1 px-6 py-4 text-sm font-medium transition-all flex items-center justify-center gap-2 ${
            sidebarSubTab === 'user' ? 'bg-violet-50 text-violet-700 border-b-2 border-violet-500' : 'text-slate-600 hover:bg-slate-50'
          }`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
            Configure by User
          </button>
        </div>

        <div className="p-6">
          {sidebarSubTab === 'role' ? (
            <div className="space-y-6">
              <div>
                <label className="block text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Select Role</label>
                <div className="flex flex-wrap gap-2">
                  {allRoles.map((role) => (
                    <button key={role.name} onClick={() => handleSidebarRoleChange(role.name)} disabled={isTransitioning}
                      className={`px-4 py-2 rounded-xl text-sm font-medium transition-all text-white shadow-md ${
                        sidebarSelectedRole === role.name ? role.color + ' ring-2 ring-offset-2 ring-violet-400' : 'bg-slate-100 !text-slate-600 hover:bg-slate-200 !shadow-none'
                      } ${isTransitioning ? 'opacity-50 cursor-wait' : ''}`}>
                      {role.displayName}
                    </button>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between p-4 bg-slate-50 rounded-xl border border-slate-200">
                <div className="text-sm text-slate-600">
                  <span className="font-semibold text-violet-600">{enabledItems.length}</span>
                  <span> / {SIDEBAR_ITEMS.length} items enabled for </span>
                  <span className="font-semibold">{allRoles.find(r => r.name === sidebarSelectedRole)?.displayName || sidebarSelectedRole}</span>
                </div>
                <div className="flex gap-2">
                  <Button variant="outline" size="sm" onClick={enableAllSidebar}>Enable All</Button>
                  <Button variant="outline" size="sm" onClick={disableAllSidebar}>Disable All</Button>
                </div>
              </div>

              {sidebarIsLoading ? (
                <div className="p-8 text-center">
                  <svg className="w-6 h-6 animate-spin mx-auto mb-2 text-violet-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                  <p className="text-slate-500">Loading configuration...</p>
                </div>
              ) : (
                <div className="space-y-5">
                  <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                    {ungroupedItems.map(renderRoleCard)}
                  </div>
                  {groupNames.map(g => renderGroupSection(g, renderRoleCard, 'grid-cols-1 md:grid-cols-2 lg:grid-cols-3'))}
                </div>
              )}

              {!sidebarIsLoading && renderOrderPanel()}
            </div>
          ) : (
            /* User-wise Configuration */
            <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
              {/* User Selection Panel */}
              <div className="bg-slate-50 rounded-xl border border-slate-200 overflow-hidden">
                <div className="p-4 border-b border-slate-200 bg-white">
                  <h3 className="font-semibold text-slate-800 flex items-center gap-2 mb-3">
                    <svg className="w-5 h-5 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    Select User
                  </h3>
                  <div className="relative">
                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
                    <Input placeholder="Search users..." value={searchQuery} onChange={(e) => setSearchQuery(e.target.value)} className="pl-9 text-sm" />
                  </div>
                </div>
                <div className="max-h-80 overflow-y-auto">
                  {loadingUsers ? (
                    <div className="p-6 text-center text-slate-500">
                      <svg className="w-5 h-5 animate-spin mx-auto mb-2" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                      Loading users...
                    </div>
                  ) : filteredUsers.length === 0 ? (
                    <div className="p-6 text-center text-slate-400 text-sm">No users found</div>
                  ) : (
                    <div className="divide-y divide-slate-200">
                      {filteredUsers.map((u: User) => (
                        <div key={u.id} onClick={() => handleUserChange(u)} className={`p-3 cursor-pointer transition-colors ${
                          selectedUser?.id === u.id ? 'bg-violet-100' : 'bg-white hover:bg-slate-50'
                        } ${isTransitioning ? 'opacity-50 cursor-wait' : ''}`}>
                          <div className="flex items-center gap-3">
                            <div className={`w-9 h-9 rounded-full flex items-center justify-center text-sm font-bold ${
                              selectedUser?.id === u.id ? 'bg-violet-500 text-white' : 'bg-slate-200 text-slate-600'
                            }`}>{u.fullName.charAt(0).toUpperCase()}</div>
                            <div className="flex-1 min-w-0">
                              <p className="font-medium text-slate-800 truncate text-sm">{u.fullName}</p>
                              <p className="text-xs text-slate-500 truncate">{u.username}</p>
                            </div>
                            <Badge variant="secondary" className="text-xs">{allRoles.find(r => r.name === u.role)?.displayName || u.role}</Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* User Configuration Panel */}
              <div className="lg:col-span-2">
                {!selectedUser ? (
                  <div className="h-full flex items-center justify-center p-12 bg-slate-50 rounded-xl border border-slate-200 border-dashed">
                    <div className="text-center">
                      <div className="p-4 rounded-2xl bg-slate-100 inline-block mb-4">
                        <svg className="w-8 h-8 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" /></svg>
                      </div>
                      <p className="text-slate-600 font-medium">Select a user to configure</p>
                      <p className="text-sm text-slate-400 mt-1">Choose a user from the list to customize their sidebar</p>
                    </div>
                  </div>
                ) : (
                  <div className="space-y-4">
                    <div className="p-4 bg-violet-50 rounded-xl border border-violet-200 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-full bg-violet-500 text-white flex items-center justify-center font-bold">{selectedUser.fullName.charAt(0).toUpperCase()}</div>
                        <div>
                          <p className="font-semibold text-violet-800">{selectedUser.fullName}</p>
                          <p className="text-sm text-violet-600">{selectedUser.username} &bull; {allRoles.find(r => r.name === selectedUser.role)?.displayName || selectedUser.role}</p>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button variant="outline" size="sm" onClick={enableAllSidebar}>Enable All</Button>
                        <Button variant="outline" size="sm" onClick={disableAllSidebar}>Disable All</Button>
                        <Button variant="outline" size="sm" onClick={resetUserToRoleDefault} className="text-amber-600 hover:text-amber-700">Reset to Role Default</Button>
                      </div>
                    </div>

                    {sidebarIsLoading ? (
                      <div className="p-8 text-center">
                        <svg className="w-6 h-6 animate-spin mx-auto mb-2 text-violet-500" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                        <p className="text-slate-500">Loading configuration...</p>
                      </div>
                    ) : (
                      <div className="space-y-4">
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                          {ungroupedItems.map(renderUserCard)}
                        </div>
                        {groupNames.map(g => renderGroupSection(g, renderUserCard, 'grid-cols-1 md:grid-cols-2'))}
                      </div>
                    )}

                    {!sidebarIsLoading && renderOrderPanel()}

                    <div className="p-4 rounded-xl bg-amber-50 border border-amber-200">
                      <div className="flex items-start gap-3">
                        <svg className="w-5 h-5 text-amber-600 flex-shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                        <div className="text-sm text-amber-800">
                          <p className="font-medium">User-specific override</p>
                          <p className="mt-1 text-amber-700">This configuration will override the role-based defaults for this user.{enabledItems.length === 0 && ' Currently using role defaults.'}</p>
                        </div>
                      </div>
                    </div>

                    <div className="text-sm text-slate-600">
                      <span className="font-semibold text-violet-600">{enabledItems.length}</span>
                      <span> / {SIDEBAR_ITEMS.length} items enabled</span>
                      {enabledItems.length === 0 && <span className="text-slate-400 ml-2">(Using role defaults)</span>}
                    </div>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }
);
