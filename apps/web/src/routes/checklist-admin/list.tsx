import { useEffect, useState } from 'react';
import useSWR, { mutate } from 'swr';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../../lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useCan } from '@/hooks/use-can';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Pagination } from '@/components/ui/pagination';
import type { PaginatedResponse } from '../../types/filter';

const TYPE_COLORS: Record<string, { bg: string; text: string; icon: string }> = {
  YES_NO: { bg: 'bg-emerald-50', text: 'text-emerald-700', icon: '' },
  PASS_FAIL: { bg: 'bg-blue-50', text: 'text-blue-700', icon: '' },
  TEXT: { bg: 'bg-cyan-50', text: 'text-cyan-700', icon: '' },
  NUMERIC: { bg: 'bg-amber-50', text: 'text-amber-700', icon: '' },
};

export function ChecklistProfileListPage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  // Phase 5C: button gating via useCan(<node>) — resolves from PERMISSION_TREE gate,
  // which matches the real backend enforcement (no drift).
  const can = useCan();
  const canCreate = can('checklists.create'); // gate: ['CHECKLIST_CREATE'] — SAME as old CHECKLIST_CREATE check
  const canDelete = can('checklists.delete'); // gate: ['CHECKLIST_DELETE'] — SAME as old CHECKLIST_DELETE check
  // THEATER-FIX: old gate was CHECKLIST_TOGGLE (standalone theater perm never wired to a
  // real backend route). Node 'checklists.toggle' gate is ['FCP_UPDATE','CHECKLIST_EDIT']
  // — the real backend enforcement. Users holding only CHECKLIST_TOGGLE lose the toggle
  // button; users with CHECKLIST_EDIT (which implies FCP_UPDATE rights) retain it.
  const canToggle = can('checklists.toggle');
  const reauth = useReauth();
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'active' | 'inactive'>('all');
  const swrKey = '/api/checklist-profiles?limit=100';
  const { data, isLoading } = useSWR(swrKey);

  const handleCreate = async () => {
    if (!newName.trim()) return;
    setCreating(true);
    await reauth.execute('CREATE_CHECKLIST_PROFILE', async (password?: string) => {
      try {
        const result = password
          ? await apiClient.postWithReauth('/api/checklist-profiles', { name: newName, description: newDesc || undefined }, password)
          : await apiClient.post('/api/checklist-profiles', { name: newName, description: newDesc || undefined });
        mutate(swrKey);
        setShowCreate(false); setNewName(''); setNewDesc('');
        navigate(`/checklists/${(result as any).id}`);
      } catch (e: any) { toast.error(e.message || 'Failed to create checklist'); throw e; }
      finally { setCreating(false); }
    });
    setCreating(false);
  };

  const toggleActive = (id: string, isActive: boolean, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    reauth.execute('UPDATE_CHECKLIST_PROFILE', async (password?: string) => {
      try {
        if (password) await apiClient.putWithReauth(`/api/checklist-profiles/${id}`, { isActive: !isActive }, password);
        else await apiClient.put(`/api/checklist-profiles/${id}`, { isActive: !isActive });
        mutate(swrKey);
      } catch (e: any) { toast.error((e as any).message); throw e; }
    });
  };

  const deleteProfile = (id: string, name: string, e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    reauth.execute('DELETE_CHECKLIST_PROFILE', async (password?: string) => {
      try {
        if (password) await apiClient.deleteWithReauth(`/api/checklist-profiles/${id}`, password);
        else await apiClient.delete(`/api/checklist-profiles/${id}`);
        mutate(swrKey);
      } catch (e: any) { toast.error((e as any).message); throw e; }
    });
  };

  const allProfiles = (data?.data ?? []) as any[];
  const filtered = allProfiles.filter((p: any) => {
    if (filter === 'active' && !p.isActive) return false;
    if (filter === 'inactive' && p.isActive) return false;
    if (search && !p.name.toLowerCase().includes(search.toLowerCase())) return false;
    return true;
  });

  const activeCount = allProfiles.filter((p: any) => p.isActive).length;
  const inactiveCount = allProfiles.filter((p: any) => !p.isActive).length;
  const totalQuestions = allProfiles.reduce((s: number, p: any) => s + (p.questionCount ?? 0), 0);

  // Pagination — slice the filtered grid; stats above stay on `allProfiles`.
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  useEffect(() => { setPage(1); }, [search, filter]);
  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, totalPages);
  const pagedProfiles = filtered.slice((safePage - 1) * pageSize, safePage * pageSize);

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Checklist Profiles</h1>
          <p className="text-sm text-slate-500 mt-1">Create and manage checklist templates with configurable questions</p>
        </div>
        {canCreate && (
          <button onClick={() => setShowCreate(true)}
            className="px-5 py-2.5 text-white rounded-xl transition-all text-sm font-semibold flex items-center gap-2"
            style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            Create Checklist
          </button>
        )}
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="rounded-2xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
          <div className="text-2xl font-bold">{allProfiles.length}</div>
          <div className="text-sm font-medium" style={{ color: 'var(--theme-primary-light)' }}>Total Checklists</div>
        </div>
        <div className="bg-gradient-to-br from-emerald-500 to-green-600 rounded-2xl p-4 text-white shadow-lg shadow-emerald-500/20">
          <div className="text-2xl font-bold">{activeCount}</div>
          <div className="text-emerald-100 text-sm font-medium">Active</div>
        </div>
        <div className="bg-gradient-to-br from-slate-400 to-slate-500 rounded-2xl p-4 text-white shadow-lg shadow-slate-400/20">
          <div className="text-2xl font-bold">{inactiveCount}</div>
          <div className="text-slate-200 text-sm font-medium">Inactive</div>
        </div>
        <div className="rounded-2xl p-4 text-white shadow-lg" style={{ background: 'linear-gradient(to bottom right, var(--theme-gradient-to), var(--theme-gradient-from))' }}>
          <div className="text-2xl font-bold">{totalQuestions}</div>
          <div className="text-sm font-medium" style={{ color: 'var(--theme-primary-light)' }}>Total Questions</div>
        </div>
      </div>

      {/* Search & Filter Bar */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
          </svg>
          <input className="w-full bg-white border border-slate-200 rounded-xl pl-10 pr-4 py-2.5 text-sm text-slate-800 placeholder:text-slate-400 outline-none"
            style={{ '--tw-ring-color': 'var(--theme-focus-ring)' } as React.CSSProperties}
            onFocus={e => { e.currentTarget.style.borderColor = 'var(--theme-primary)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--theme-focus-ring)'; }}
            onBlur={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
            placeholder="Search checklists..." value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="flex gap-1 bg-slate-100 rounded-xl p-1">
          {[
            { key: 'all' as const, label: 'All', count: allProfiles.length },
            { key: 'active' as const, label: 'Active', count: activeCount },
            { key: 'inactive' as const, label: 'Inactive', count: inactiveCount },
          ].map(f => (
            <button key={f.key} onClick={() => setFilter(f.key)}
              className={`px-4 py-2 rounded-lg text-sm font-medium transition-all ${filter === f.key
                ? 'bg-white shadow-sm'
                : 'text-slate-500 hover:text-slate-700'}`}
              style={filter === f.key ? { color: 'var(--theme-primary)' } : undefined}>
              {f.label} <span className="text-xs opacity-60">({f.count})</span>
            </button>
          ))}
        </div>
      </div>

      {/* Card Grid */}
      {isLoading ? (
        <div className="flex justify-center py-20">
          <div className="w-8 h-8 border-3 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--theme-primary)', borderTopColor: 'transparent' }} />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {pagedProfiles.map((p: any) => (
            <div key={p.id}
              className="bg-white border border-slate-200 rounded-2xl overflow-hidden hover:shadow-xl transition-all duration-300 cursor-pointer group"
              onClick={() => navigate(`/checklists/${p.id}`)}>
              {/* Color strip */}
              <div className={`h-1.5 ${p.isActive ? 'bg-gradient-to-r from-emerald-400 to-green-500' : 'bg-gradient-to-r from-slate-300 to-slate-400'}`} />
              <div className="p-5">
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <div className={`w-10 h-10 rounded-xl flex items-center justify-center text-lg shadow-sm ${p.isActive ? '' : 'bg-slate-100'}`}
                      style={p.isActive ? { background: 'var(--theme-primary-light)' } : undefined}>
                      <svg className={`w-5 h-5 ${p.isActive ? '' : 'text-slate-400'}`} style={p.isActive ? { color: 'var(--theme-primary)' } : undefined} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
                      </svg>
                    </div>
                    <div className="flex-1 min-w-0">
                      <h3 className="text-sm font-bold text-slate-800 truncate">{p.name}</h3>
                      {p.description && <p className="text-xs text-slate-400 truncate mt-0.5">{p.description}</p>}
                    </div>
                  </div>
                  {canDelete && (
                    <button onClick={(e) => deleteProfile(p.id, p.name, e)}
                      className="w-7 h-7 rounded-lg text-slate-300 hover:text-red-500 hover:bg-red-50 flex items-center justify-center opacity-0 group-hover:opacity-100 transition-all">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" /></svg>
                    </button>
                  )}
                </div>

                {/* Question count badge */}
                <div className="flex items-center gap-2 mb-4">
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 text-blue-700 text-xs font-semibold rounded-lg">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                    {p.questionCount} question{p.questionCount !== 1 ? 's' : ''}
                  </span>
                </div>

                {/* Footer */}
                <div className="flex items-center justify-between pt-3 border-t border-slate-100">
                  <div className="flex items-center gap-2">
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-xs font-semibold rounded-full ${p.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${p.isActive ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                      {p.isActive ? 'Active' : 'Inactive'}
                    </span>
                  </div>
                  {canToggle && (
                    <button onClick={(e) => toggleActive(p.id, p.isActive, e)}
                      className={`relative w-11 h-6 rounded-full transition-colors duration-200 ${p.isActive ? 'bg-emerald-500' : 'bg-slate-300'}`}>
                      <span className={`absolute top-0.5 left-0.5 w-5 h-5 bg-white rounded-full shadow-md transition-transform duration-200 ${p.isActive ? 'translate-x-5' : 'translate-x-0'}`} />
                    </button>
                  )}
                </div>
              </div>
            </div>
          ))}
          {filtered.length === 0 && (
            <div className="col-span-full text-center py-20">
              <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-slate-100 flex items-center justify-center">
                <svg className="w-8 h-8 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2" /></svg>
              </div>
              <p className="text-slate-500 font-medium">{search ? 'No checklists match your search' : 'No checklists yet'}</p>
              <p className="text-sm text-slate-400 mt-1">Create your first checklist to get started</p>
            </div>
          )}
        </div>
      )}

      {!isLoading && filtered.length > 0 && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm">
          <Pagination
            page={safePage}
            pageSize={pageSize}
            totalItems={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={setPageSize}
          />
        </div>
      )}

      {/* Create Modal */}
      {showCreate && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => setShowCreate(false)}>
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="h-1.5" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }} />
            <div className="p-6">
              <div className="flex items-center gap-3 mb-5">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white shadow-lg" style={{ background: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-800">Create Checklist</h2>
                  <p className="text-xs text-slate-400">Add a new checklist profile template</p>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Name</label>
                  <input className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm outline-none"
                    style={{ '--tw-ring-color': 'var(--theme-focus-ring)' } as React.CSSProperties}
                    onFocus={e => { e.currentTarget.style.borderColor = 'var(--theme-primary)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--theme-focus-ring)'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
                    value={newName} onChange={e => setNewName(e.target.value)} placeholder="e.g. HEPA Pre-Wash Checklist" autoFocus
                    onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }} />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Description (optional)</label>
                  <textarea className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm outline-none" rows={3}
                    onFocus={e => { e.currentTarget.style.borderColor = 'var(--theme-primary)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--theme-focus-ring)'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
                    value={newDesc} onChange={e => setNewDesc(e.target.value)} placeholder="Brief description of this checklist..." />
                </div>
              </div>
              <div className="flex gap-3 mt-6">
                <button onClick={() => setShowCreate(false)} className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200 transition-colors">Cancel</button>
                <button onClick={handleCreate} disabled={creating || !newName.trim()}
                  className="flex-1 py-2.5 text-white rounded-xl text-sm font-semibold disabled:opacity-50 transition-all shadow-lg"
                  style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
                  {creating ? 'Creating...' : 'Create Checklist'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
      <ReauthDialog open={reauth.isOpen} password={reauth.password} error={reauth.error} isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword} onConfirm={reauth.confirm} onCancel={reauth.cancel} />
    </div>
  );
}
