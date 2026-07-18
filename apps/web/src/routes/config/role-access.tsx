import { useState, useRef, useMemo, useCallback } from 'react';
import { Link } from 'react-router-dom';
import useSWR, { useSWRConfig } from 'swr';
import { Button } from '@/components/ui/button';
import { api } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import type { RoleData } from '@digilog/shared';
import { PRESET_COLORS } from './roles-components/role-color-picker';
import { RoleTable } from './roles-components/role-table';
import { RoleFormDialog } from './roles-components/role-form-dialog';
import type { RoleFormData } from './roles-components/role-form-dialog';
import { RoleDeleteDialog } from './roles-components/role-delete-dialog';
import { PermissionsTab } from './roles-components/permissions-tab';
import type { PermissionsTabHandle } from './roles-components/permissions-tab';
import { SidebarTab } from './roles-components/sidebar-tab';
import type { SidebarTabHandle } from './roles-components/sidebar-tab';
import { ReauthTab } from './roles-components/reauth-tab';
import type { ReauthTabHandle } from './roles-components/reauth-tab';

type TabId = 'roles' | 'permissions' | 'sidebar' | 'reauth';

export function RoleAccessPage() {
  const { user } = useAuth();
  const reauth = useReauth();
  const [activeTab, setActiveTab] = useState<TabId>('roles');

  // ── Tab refs for imperative access (save/reset) ──
  const permissionsRef = useRef<PermissionsTabHandle>(null);
  const sidebarRef = useRef<SidebarTabHandle>(null);
  const reauthRef = useRef<ReauthTabHandle>(null);

  // ── Tab state lifted from children for header buttons ──
  const [permState, setPermState] = useState({ dirty: false, saving: false });
  const [sidebarState, setSidebarState] = useState({ dirty: false, saving: false, canSave: false });
  const [reauthState, setReauthState] = useState({ hasChanges: false, saving: false });

  // ── Shared data fetches ──
  const { mutate } = useSWRConfig();
  const { data: roles, isLoading: rolesLoading } = useSWR<RoleData[]>('/api/roles', { revalidateOnMount: true, dedupingInterval: 0 });
  const { data: activeRoles } = useSWR<RoleData[]>('/api/roles/active', { revalidateOnMount: true, dedupingInterval: 0 });
  const mutateRoles = useCallback(() => mutate((key: unknown) => typeof key === 'string' && key.startsWith('/api/roles')), [mutate]);

  const isSuperAdmin = user?.role === 'SUPER_ADMIN' || (user?.permissions?.includes('ROLE_MANAGE') ?? false);

  const selectableRoles = useMemo(() => {
    if (!activeRoles) return [];
    return activeRoles.filter(r => r.name !== 'SUPER_ADMIN').sort((a, b) => b.hierarchyLevel - a.hierarchyLevel);
  }, [activeRoles]);

  // ── Roles tab state ──
  const [showCreateDialog, setShowCreateDialog] = useState(false);
  const [showEditDialog, setShowEditDialog] = useState(false);
  const [selectedRoleForEdit, setSelectedRoleForEdit] = useState<RoleData | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showDeleteDialog, setShowDeleteDialog] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<RoleData | null>(null);
  const [deleteError, setDeleteError] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [formData, setFormData] = useState<RoleFormData>({
    name: '', displayName: '', description: '', hierarchyLevel: 1,
    color: PRESET_COLORS[0].value, permissions: [],
  });

  // ── Roles tab handlers ──
  const resetForm = () => {
    setFormData({ name: '', displayName: '', description: '', hierarchyLevel: 1, color: PRESET_COLORS[0].value, permissions: [] });
    setError('');
  };
  const openCreateDialog = () => { resetForm(); setShowCreateDialog(true); };
  const openEditDialog = (role: RoleData) => {
    setSelectedRoleForEdit(role);
    setFormData({ name: role.name, displayName: role.displayName, description: role.description || '', hierarchyLevel: role.hierarchyLevel, color: role.color, permissions: role.permissions });
    setShowEditDialog(true);
  };
  const handleCreate = async () => {
    if (!formData.name || !formData.displayName) { setError('Name and Display Name are required'); return; }
    setSaving(true); setError('');
    const body = { name: formData.name.toUpperCase().replace(/\s+/g, '_'), displayName: formData.displayName, description: formData.description, hierarchyLevel: formData.hierarchyLevel, color: formData.color, permissions: formData.permissions };
    await reauth.execute('CREATE_ROLE', async (password?) => {
      if (password) await api.postWithReauth('/api/roles', body, password);
      else await api.post('/api/roles', body);
      mutateRoles();
      setShowCreateDialog(false); resetForm();
    }, {
      onError: (err: unknown) => { setError((err as any)?.message || 'Failed to create role'); },
    });
    setSaving(false);
  };
  const handleUpdate = async () => {
    if (!selectedRoleForEdit) return;
    setSaving(true); setError('');
    const roleName = selectedRoleForEdit.name;
    const body = { displayName: formData.displayName, description: formData.description, hierarchyLevel: formData.hierarchyLevel, color: formData.color, permissions: formData.permissions };
    await reauth.execute('UPDATE_ROLE', async (password?) => {
      if (password) await api.putWithReauth(`/api/roles/${roleName}`, body, password);
      else await api.put(`/api/roles/${roleName}`, body);
      mutateRoles();
      setShowEditDialog(false); setSelectedRoleForEdit(null);
    }, {
      onError: (err: unknown) => { setError((err as any)?.message || 'Failed to update role'); },
    });
    setSaving(false);
  };
  const openDeleteDialog = (role: RoleData) => { setDeleteTarget(role); setDeleteError(''); setShowDeleteDialog(true); };
  const handleDelete = async () => {
    if (!deleteTarget) return;
    setDeleting(true); setDeleteError('');
    const roleName = deleteTarget.name;
    await reauth.execute('DELETE_ROLE', async (password?) => {
      if (password) await api.deleteWithReauth(`/api/roles/${roleName}`, password);
      else await api.delete(`/api/roles/${roleName}`);
      mutateRoles();
      setShowDeleteDialog(false); setDeleteTarget(null);
    }, {
      onError: (err: unknown) => { setDeleteError((err as any)?.message || 'Failed to delete role'); },
    });
    setDeleting(false);
  };

  // ── Tab definitions ──
  const tabs: { id: TabId; label: string; icon: string }[] = [
    { id: 'roles', label: 'Roles', icon: 'M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z' },
    { id: 'permissions', label: 'Permissions', icon: 'M9 12l2 2 4-4m5.618-4.016A11.955 11.955 0 0112 2.944a11.955 11.955 0 01-8.618 3.04A12.02 12.02 0 003 9c0 5.591 3.824 10.29 9 11.622 5.176-1.332 9-6.03 9-11.622 0-1.042-.133-2.052-.382-3.016z' },
    { id: 'sidebar', label: 'Sidebar', icon: 'M4 6h16M4 12h16M4 18h7' },
    { id: 'reauth', label: 'Re-auth', icon: 'M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z' },
  ];

  // ── Header save button helpers ──
  const renderHeaderActions = () => {
    if (activeTab === 'roles' && isSuperAdmin) {
      return (
        <Button onClick={openCreateDialog} className="bg-white text-purple-600 hover:bg-purple-50 shadow-lg font-semibold">
          <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
          Create Role
        </Button>
      );
    }
    if (activeTab === 'permissions' && permState.dirty) {
      return (
        <Button onClick={() => permissionsRef.current?.save()} disabled={permState.saving} className="bg-white text-purple-600 hover:bg-purple-50 shadow-lg font-semibold">
          {permState.saving ? (
            <><svg className="w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Saving...</>
          ) : (
            <><svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>Save Changes</>
          )}
        </Button>
      );
    }
    if (activeTab === 'sidebar' && sidebarState.dirty && sidebarState.canSave) {
      return (
        <Button onClick={() => sidebarRef.current?.save()} disabled={sidebarState.saving} className="bg-white text-purple-600 hover:bg-purple-50 shadow-lg font-semibold">
          {sidebarState.saving ? (
            <><svg className="w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Saving...</>
          ) : (
            <><svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>Save Changes</>
          )}
        </Button>
      );
    }
    if (activeTab === 'reauth' && reauthState.hasChanges) {
      return (
        <div className="flex items-center gap-2">
          <Button onClick={() => reauthRef.current?.reset()} variant="outline" className="bg-white/10 text-white border-white/20 hover:bg-white/20 font-semibold">
            Discard
          </Button>
          <Button onClick={() => reauthRef.current?.save()} disabled={reauthState.saving} className="bg-white text-purple-600 hover:bg-purple-50 shadow-lg font-semibold">
            {reauthState.saving ? (
              <><svg className="w-4 h-4 mr-2 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>Saving...</>
            ) : (
              <><svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>Save Changes</>
            )}
          </Button>
        </div>
      );
    }
    return null;
  };

  return (
    <div className="space-y-6 animate-fade-in">
      {/* Header */}
      <div className="relative overflow-hidden rounded-2xl bg-gradient-to-br from-violet-500 via-purple-600 to-indigo-600 p-6 text-white shadow-2xl">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxwYXRoIGQ9Ik0zNiAxOGMzLjMxNCAwIDYgMi42ODYgNiA2cy0yLjY4NiA2LTYgNi02LTIuNjg2LTYtNiAyLjY4Ni02IDYtNiIgc3Ryb2tlPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMSkiIHN0cm9rZS13aWR0aD0iMiIvPjwvZz48L3N2Zz4=')] opacity-30" />
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link to="/config" className="p-2.5 rounded-xl bg-white/10 hover:bg-white/20 backdrop-blur-sm transition-all duration-200 border border-white/10">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </Link>
            <div className="flex items-center gap-3 mb-1">
              <div className="p-3 rounded-xl bg-white/20 backdrop-blur-sm shadow-lg">
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4.354a4 4 0 110 5.292M15 21H3v-1a6 6 0 0112 0v1zm0 0h6v-1a6 6 0 00-9-5.197M13 7a4 4 0 11-8 0 4 4 0 018 0z" />
                </svg>
              </div>
              <div>
                <h1 className="text-2xl font-bold">Role & Access Configuration</h1>
                <p className="text-purple-100/80 text-sm">Manage roles, permissions, sidebar visibility, and re-authentication</p>
              </div>
            </div>
          </div>
          {/* Context-sensitive header action */}
          {renderHeaderActions()}
        </div>
      </div>

      {/* Tab Bar */}
      <div className="bg-white rounded-2xl border border-slate-200/60 shadow-soft overflow-hidden">
        <div className="flex border-b border-slate-200">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex-1 px-6 py-4 text-sm font-medium transition-all flex items-center justify-center gap-2 ${
                activeTab === tab.id
                  ? 'bg-violet-50 text-violet-700 border-b-2 border-violet-500'
                  : 'text-slate-600 hover:bg-slate-50'
              }`}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={tab.icon} />
              </svg>
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* ═══════════════════ ROLES TAB ═══════════════════ */}
      {activeTab === 'roles' && (
        <>
          <RoleTable roles={roles} isLoading={rolesLoading} isSuperAdmin={isSuperAdmin} onEdit={openEditDialog} onDelete={openDeleteDialog} />

          {/* Info Banner */}
          <div className="relative overflow-hidden rounded-2xl bg-gradient-to-r from-purple-50 via-indigo-50 to-blue-50 border border-purple-100/50 p-5">
            <div className="flex items-start gap-4">
              <div className="flex-shrink-0 p-3 rounded-xl bg-gradient-to-br from-purple-500 to-indigo-600 text-white shadow-lg shadow-purple-500/25">
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              </div>
              <div>
                <h3 className="font-bold text-purple-900 mb-1">Role Hierarchy</h3>
                <p className="text-sm text-purple-700">
                  Users can only create or manage users with roles of equal or lower hierarchy level.
                  System roles (marked with the System badge) cannot be deleted but their permissions can be customized.
                </p>
              </div>
            </div>
          </div>

          <RoleFormDialog open={showCreateDialog} onClose={() => setShowCreateDialog(false)} title="Create New Role" formData={formData} setFormData={setFormData} error={error} saving={saving} onSubmit={handleCreate} isEdit={false} />
          <RoleDeleteDialog open={showDeleteDialog} role={deleteTarget} error={deleteError} deleting={deleting} onClose={() => setShowDeleteDialog(false)} onDelete={handleDelete} />
          <RoleFormDialog open={showEditDialog} onClose={() => setShowEditDialog(false)} title={`Edit Role: ${selectedRoleForEdit?.displayName}`} formData={formData} setFormData={setFormData} error={error} saving={saving} onSubmit={handleUpdate} isEdit={true} isSystem={selectedRoleForEdit?.isSystem} />
        </>
      )}

      {/* ═══════════════════ PERMISSIONS TAB ═══════════════════ */}
      {activeTab === 'permissions' && (
        <PermissionsTab ref={permissionsRef} selectableRoles={selectableRoles} onStateChange={setPermState} />
      )}

      {/* ═══════════════════ SIDEBAR TAB ═══════════════════ */}
      {activeTab === 'sidebar' && (
        <SidebarTab ref={sidebarRef} activeRoles={activeRoles || []} onStateChange={setSidebarState} />
      )}

      {/* ═══════════════════ RE-AUTH TAB ═══════════════════ */}
      {activeTab === 'reauth' && (
        <ReauthTab ref={reauthRef} selectableRoles={selectableRoles} onStateChange={setReauthState} />
      )}

      {/* Reauth Dialog */}
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Role Management"
      />
    </div>
  );
}
