import { useState } from 'react';
import useSWR, { mutate } from 'swr';
import { useNavigate } from 'react-router-dom';
import { apiClient, api } from '../../lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useCan } from '@/hooks/use-can';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Pagination } from '@/components/ui/pagination';
import { usePaginationConfig } from '@/hooks/use-pagination-config';
import type { CleaningProfile, PaginatedResponse } from '../../types/filter';

const FLOW_COLORS: Record<string, { bg: string; text: string }> = {
  STRICT: { bg: 'bg-red-50', text: 'text-red-700' },
  FLEXIBLE: { bg: 'bg-amber-50', text: 'text-amber-700' },
  LINEAR: { bg: 'bg-blue-50', text: 'text-blue-700' },
};

export function CleaningProfileListPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  // Phase 5C: button gating via useCan(<node>) — resolves from PERMISSION_TREE gate,
  // which matches the real backend enforcement (no drift).
  const can = useCan();
  const canCreate = can('cleaning_profiles.create'); // gate: ['CP_PAGE_CREATE'] — SAME as old CP_PAGE_CREATE check
  const canUpdate = can('cleaning_profiles.edit');   // gate: ['CP_PAGE_EDIT'] — SAME as old CP_PAGE_EDIT check
  const canDelete = can('cleaning_profiles.delete'); // gate: ['CP_PAGE_DELETE'] — SAME as old CP_PAGE_DELETE check
  // THEATER-FIX: old gate was CP_TOGGLE (a standalone theater perm never wired to a
  // real backend route). Node 'cleaning_profiles.toggle' gate is ['FCP_UPDATE','CP_PAGE_EDIT']
  // — the real backend enforcement. Users holding CP_TOGGLE alone lose the toggle button;
  // users holding CP_PAGE_EDIT (which implies FCP_UPDATE rights) retain it.
  const canToggle = can('cleaning_profiles.toggle');
  const reauth = useReauth();
  const paginationOptions = usePaginationConfig();
  const [status, setStatus] = useState('ACTIVE');
  const [page, setPage] = useState(1);
  // Default to a config-provided option so the rows-per-page selector always
  // shows a valid selection (20 is not guaranteed to be in the options list).
  const [perPage, setPerPage] = useState(paginationOptions[0] ?? 10);
  const [search, setSearch] = useState('');
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const swrKey = `/api/filter-cleaning-profiles?page=${page}&limit=${perPage}&status=${status}`;
  const { data, isLoading } = useSWR<PaginatedResponse<CleaningProfile>>(swrKey);

  // Audit 2026-05-09 fix: DELETE endpoint exists with reauth gate
  // (DELETE_CLEANING_PROFILE) but no FE button rendered. Backend
  // archive() returns 409 IN_USE if any FilterProfile or CleaningCycle
  // binds the profile — toast surfaces that cleanly.
  const confirmDelete = (e: React.MouseEvent, id: string, name: string) => {
    e.stopPropagation();
    e.preventDefault();
    setDeleteConfirm({ id, name });
  };

  const submitDelete = () => {
    if (!deleteConfirm) return;
    const { id, name } = deleteConfirm;
    setDeleting(true);
    reauth.execute(
      'DELETE_CLEANING_PROFILE',
      async (password?: string) => {
        if (password) await api.deleteWithReauth(`/api/filter-cleaning-profiles/${id}`, password);
        else await apiClient.delete(`/api/filter-cleaning-profiles/${id}`);
      },
      {
        onSuccess: () => {
          toast.success('Deleted', `Cleaning profile "${name}" deleted`);
          setDeleteConfirm(null); setDeleting(false); mutate(swrKey);
        },
        onError: (e: any) => {
          const msg = e?.code === 'IN_USE' || /in use/i.test(e?.message ?? '')
            ? `Cannot delete — "${name}" is still in use by one or more filters or cycles.`
            : (e?.message ?? 'Failed to delete profile');
          toast.error('Error', msg);
          setDeleting(false);
        },
      },
    );
  };

  const toggleStatus = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    reauth.execute('UPDATE_CLEANING_PROFILE', async (password?: string) => {
      try {
        if (password) await apiClient.patchWithReauth(`/api/filter-cleaning-profiles/${id}/toggle-status`, { toggle: true }, password);
        else await apiClient.patch(`/api/filter-cleaning-profiles/${id}/toggle-status`, { toggle: true });
        mutate(swrKey);
      } catch (err: any) {
        toast.error('Error', err.message || 'Failed to toggle status');
        throw err;
      }
    });
  };

  const profiles = (data?.data ?? []).filter(p =>
    !search || p.name.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Cleaning Profiles</h1>
          <p className="text-sm text-slate-500 mt-1">Pipeline cleaning configurations for filter management</p>
        </div>
        {canCreate && (
          <button onClick={() => navigate('/filter-cleaning-profiles/new/edit')}
            className="px-5 py-2.5 text-white rounded-xl transition-all text-sm font-semibold shadow-lg flex items-center gap-2"
            style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            Create Profile
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-2xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
          <div className="text-2xl font-bold">{data?.total ?? 0}</div>
          <div className="text-white/80 text-sm font-medium">
            {status === 'ACTIVE' ? 'Active Profiles' : 'Inactive Profiles'}
          </div>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
              <svg className="w-5 h-5 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
            </div>
            <div>
              <div className="text-lg font-bold text-slate-800">{profiles.reduce((s, p) => s + p.stageCount, 0)}</div>
              <div className="text-xs text-slate-400">Total Stages</div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-teal-50 flex items-center justify-center">
              <svg className="w-5 h-5 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101" /></svg>
            </div>
            <div>
              <div className="text-lg font-bold text-slate-800">{profiles.reduce((s, p) => s + p.connectionCount, 0)}</div>
              <div className="text-xs text-slate-400">Connections</div>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-2xl p-4 border border-slate-200 shadow-sm">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
              <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10" /></svg>
            </div>
            <div>
              <div className="text-lg font-bold text-slate-800">{data?.totalPages ?? 1}</div>
              <div className="text-xs text-slate-400">Pages</div>
            </div>
          </div>
        </div>
      </div>

      {/* Search & Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input className="w-full bg-white border border-slate-200 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 outline-none focus:ring-2"
            style={{ '--tw-ring-color': 'color-mix(in srgb, var(--theme-primary) 20%, transparent)' } as React.CSSProperties}
            onFocus={e => e.currentTarget.style.borderColor = 'var(--theme-primary-light)'}
            onBlur={e => e.currentTarget.style.borderColor = ''}
            placeholder="Search profiles..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
          {[
            { key: 'ACTIVE', label: 'Active' },
            { key: 'INACTIVE', label: 'Inactive' },
          ].map(s => (
            <button key={s.key} onClick={() => { setStatus(s.key); setPage(1); }}
              className={`px-5 py-2 rounded-lg text-sm font-medium transition-all ${status === s.key
                ? 'bg-white shadow-sm'
                : 'text-slate-500 hover:text-slate-700'}`}
              style={status === s.key ? { color: 'var(--theme-primary)' } : undefined}>
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-3 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--theme-primary)', borderTopColor: 'transparent' }} />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {profiles.map((p) => {
            const flowColor = FLOW_COLORS[p.flowMode] ?? { bg: 'bg-slate-50', text: 'text-slate-600' };
            return (
              <div key={p.id}
                className={`bg-white border border-slate-200 rounded-2xl overflow-hidden transition-all duration-300 group ${canUpdate ? 'hover:shadow-xl cursor-pointer' : ''}`}
                onMouseEnter={e => canUpdate && (e.currentTarget.style.borderColor = 'var(--theme-primary-light)')}
                onMouseLeave={e => canUpdate && (e.currentTarget.style.borderColor = '')}
                onClick={() => canUpdate && navigate(`/filter-cleaning-profiles/${p.id}/edit`)}>
                <div className={`h-1.5 ${p.status === 'ACTIVE' ? '' : 'bg-gradient-to-r from-slate-300 to-slate-400'}`}
                  style={p.status === 'ACTIVE' ? { background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' } : undefined} />
                <div className="p-5">
                  <div className="flex items-start gap-3 mb-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center shadow-sm ${p.status === 'ACTIVE' ? '' : 'bg-slate-100'}`}
                      style={p.status === 'ACTIVE' ? { background: 'color-mix(in srgb, var(--theme-primary) 15%, white)' } : undefined}>
                      <svg className={`w-5 h-5 ${p.status === 'ACTIVE' ? '' : 'text-slate-400'}`} style={p.status === 'ACTIVE' ? { color: 'var(--theme-primary)' } : undefined} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-bold text-slate-800 truncate">{p.name}</h3>
                      <div className="flex items-center gap-2 mt-1">
                        <span className="text-xs text-slate-400">v{p.version}</span>
                        <span className={`px-2 py-0.5 text-[10px] font-semibold rounded-full border ${flowColor.bg} ${flowColor.text}`}>{p.flowMode}</span>
                      </div>
                    </div>
                  </div>

                  {/* Metrics */}
                  <div className="flex gap-3 mb-4">
                    <div className="flex-1 bg-blue-50 rounded-xl p-2.5 text-center">
                      <div className="text-lg font-bold text-blue-700">{p.stageCount}</div>
                      <div className="text-[10px] text-blue-500 font-medium">Stages</div>
                    </div>
                    <div className="flex-1 bg-teal-50 rounded-xl p-2.5 text-center">
                      <div className="text-lg font-bold text-teal-700">{p.connectionCount}</div>
                      <div className="text-[10px] text-teal-500 font-medium">Connections</div>
                    </div>
                  </div>

                  {/* Footer */}
                  <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                    <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 text-xs font-semibold rounded-full ${
                      p.status === 'ACTIVE' ? 'bg-emerald-50 text-emerald-700' : p.status === 'DRAFT' ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-500'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${p.status === 'ACTIVE' ? 'bg-emerald-500' : p.status === 'DRAFT' ? 'bg-amber-500' : 'bg-slate-400'}`} />
                      {p.status === 'ACTIVE' ? 'Active' : p.status === 'DRAFT' ? 'Draft' : 'Inactive'}
                    </span>
                    <div className="flex items-center gap-2">
                      {canToggle && p.status !== 'DRAFT' && (
                        <button onClick={(e) => toggleStatus(p.id, e)}
                          aria-label={p.status === 'ACTIVE' ? 'Deactivate profile' : 'Activate profile'}
                          className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${p.status === 'ACTIVE' ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                          <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform duration-200 ${p.status === 'ACTIVE' ? 'translate-x-5' : 'translate-x-0'}`} />
                        </button>
                      )}
                      {canDelete && (
                        <button onClick={(e) => confirmDelete(e, p.id, p.name)}
                          aria-label={`Delete ${p.name}`}
                          title="Delete profile"
                          className="w-7 h-7 rounded-full text-slate-400 hover:text-red-600 hover:bg-red-50 transition-colors flex items-center justify-center">
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a2 2 0 012-2h2a2 2 0 012 2v3" />
                          </svg>
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          {profiles.length === 0 && (
            <div className="col-span-full text-center py-20">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-slate-100 flex items-center justify-center">
                <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
              </div>
              <p className="text-slate-500 font-medium">{search ? 'No profiles match your search' : `No ${status.toLowerCase()} profiles`}</p>
            </div>
          )}
        </div>
      )}

      {/* Pagination */}
      {(data?.total ?? 0) > 0 && (
        <div className="bg-white rounded-xl border border-slate-200">
          <Pagination
            page={page}
            pageSize={perPage}
            totalItems={data?.total ?? 0}
            onPageChange={setPage}
            onPageSizeChange={setPerPage}
            pageSizeOptions={paginationOptions}
          />
        </div>
      )}
      <ReauthDialog open={reauth.isOpen} password={reauth.password} error={reauth.error} isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword} onConfirm={reauth.confirm} onCancel={() => { reauth.cancel(); setDeleting(false); }} />

      {deleteConfirm && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
             onClick={() => !deleting && setDeleteConfirm(null)}>
          <div className="bg-white rounded-2xl w-full max-w-md overflow-hidden shadow-2xl"
               onClick={e => e.stopPropagation()}>
            <div className="h-1.5 bg-gradient-to-r from-red-400 to-rose-500" />
            <div className="px-6 py-5 space-y-4">
              <div className="flex items-start gap-3">
                <div className="w-10 h-10 rounded-xl bg-red-50 flex items-center justify-center text-red-600 shrink-0">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-base font-bold text-slate-800">Delete cleaning profile</h2>
                  <p className="text-sm text-slate-600 mt-1">
                    "{deleteConfirm.name}" will be deleted. If any filter or cycle is currently bound to this profile, the server will reject the delete with an error.
                  </p>
                </div>
              </div>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex gap-3">
              <button type="button" onClick={() => setDeleteConfirm(null)} disabled={deleting}
                      className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors disabled:opacity-50">
                Cancel
              </button>
              <button type="button" onClick={submitDelete} disabled={deleting}
                      className="flex-1 py-2.5 bg-gradient-to-r from-red-500 to-rose-500 text-white rounded-xl text-sm font-semibold hover:from-red-400 hover:to-rose-400 shadow-lg shadow-red-500/25 disabled:opacity-50">
                {deleting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
