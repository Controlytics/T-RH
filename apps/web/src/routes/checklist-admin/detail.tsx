import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { apiClient, api } from '../../lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';

const QUESTION_TYPES = [
  { value: 'YES_NO',       label: 'Yes / No',       color: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  { value: 'PASS_FAIL',    label: 'Pass / Fail',    color: 'bg-blue-50 text-blue-700 border-blue-200' },
  { value: 'YES_NO_NA',    label: 'Yes / No / N/A', color: 'bg-teal-50 text-teal-700 border-teal-200' },
  { value: 'TEXT',          label: 'Text Input',     color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  { value: 'NUMERIC',      label: 'Numeric',        color: 'bg-amber-50 text-amber-700 border-amber-200' },
  { value: 'DROPDOWN',     label: 'Dropdown',       color: 'bg-teal-50 text-teal-700 border-teal-200' },
  { value: 'MULTI_SELECT', label: 'Multi Select',   color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
  { value: 'DATE_TIME',    label: 'Date / Time',    color: 'bg-sky-50 text-sky-700 border-sky-200' },
  { value: 'PHOTO',        label: 'Photo Upload',   color: 'bg-rose-50 text-rose-700 border-rose-200' },
  { value: 'SIGNATURE',    label: 'Signature',       color: 'bg-pink-50 text-pink-700 border-pink-200' },
  { value: 'CALCULATED',   label: 'Calculated',      color: 'bg-orange-50 text-orange-700 border-orange-200' },
  { value: 'CONDITIONAL',  label: 'Conditional',     color: 'bg-cyan-50 text-cyan-700 border-cyan-200' },
];

const TYPES_WITH_OPTIONS = ['DROPDOWN', 'MULTI_SELECT'];
const TYPES_WITH_NUMERIC = ['NUMERIC'];

interface QuestionForm {
  question: string; questionType: string; required: boolean;
  section: string; description: string; options: string[];
  validation: { min?: number; max?: number; unit?: string; expression?: string };
}

function emptyQuestion(): QuestionForm {
  return { question: '', questionType: 'YES_NO', required: false, section: '', description: '', options: [], validation: {} };
}

export function ChecklistProfileDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const perms = user?.permissions ?? [];
  const canEdit = isSuperAdmin || perms.includes('CHECKLIST_EDIT');
  const canDelete = isSuperAdmin || perms.includes('CHECKLIST_DELETE');
  // M4 (2026-05-03): version history is gated by VERSION_HISTORY_VIEW (the
  // same perm /version-history route uses). SUPER_ADMIN bypasses per the
  // standard pattern. Backend `GET /api/checklist-profiles/:id/versions`
  // also accepts CHECKLIST_READ, but the deep-link target page strictly
  // requires VERSION_HISTORY_VIEW, so don't render a link the user can't follow.
  const canViewHistory = isSuperAdmin || perms.includes('VERSION_HISTORY_VIEW');
  const reauth = useReauth();
  const swrKey = `/api/checklist-profiles/${id}`;
  const { data: profile, isLoading } = useSWR(id ? swrKey : null);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<QuestionForm>(emptyQuestion());
  const [saving, setSaving] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [optionInput, setOptionInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  // Audit 2026-05-09 fix: BE PUT /api/checklist-profiles/:id accepts
  // name/description/isActive but the FE detail page was read-only —
  // operators had to delete + recreate to rename. Inline edit panel toggled
  // by a pencil icon next to the title.
  const [editProfileMode, setEditProfileMode] = useState(false);
  const [editProfileForm, setEditProfileForm] = useState({ name: '', description: '', isActive: true });
  const [savingProfile, setSavingProfile] = useState(false);

  const openEditProfile = () => {
    setEditProfileForm({
      name: profile?.name ?? '',
      description: profile?.description ?? '',
      isActive: profile?.isActive ?? true,
    });
    setEditProfileMode(true);
  };

  const submitEditProfile = () => {
    if (!id || !editProfileForm.name.trim()) return;
    setSavingProfile(true);
    const body = {
      name: editProfileForm.name.trim(),
      description: editProfileForm.description.trim() || null,
      isActive: editProfileForm.isActive,
    };
    reauth.execute(
      'UPDATE_CHECKLIST_PROFILE',
      async (password?: string) => {
        if (password) await api.putWithReauth(`/api/checklist-profiles/${id}`, body, password);
        else await apiClient.put(`/api/checklist-profiles/${id}`, body);
      },
      {
        onSuccess: () => { mutate(swrKey); setEditProfileMode(false); setSavingProfile(false); },
        onError: (e: any) => { setError(e?.message ?? 'Failed to update checklist profile'); setSavingProfile(false); },
      },
    );
  };

  const questions = profile?.questions ?? [];
  const sections = [...new Set(questions.map((q: any) => q.section || 'General'))];

  const openAdd = () => { setForm(emptyQuestion()); setEditingId(null); setShowAdd(true); };
  const openEdit = (q: any) => {
    setForm({
      question: q.question, questionType: q.questionType, required: q.required,
      section: q.section ?? '', description: q.description ?? '',
      options: Array.isArray(q.options) ? q.options : [],
      validation: q.validation ?? {},
    });
    setEditingId(q.id); setShowAdd(true);
  };

  const saveQuestion = async () => {
    if (!form.question.trim()) return;
    setSaving(true);
    const action = editingId ? 'UPDATE_CHECKLIST_PROFILE' : 'CREATE_CHECKLIST_PROFILE';
    await reauth.execute(action, async (password?: string) => {
      try {
        const body = { ...form, options: form.options, validation: form.validation };
        if (editingId) {
          if (password) await apiClient.putWithReauth(`/api/checklist-profiles/${id}/questions/${editingId}`, body, password);
          else await apiClient.put(`/api/checklist-profiles/${id}/questions/${editingId}`, body);
        } else {
          if (password) await apiClient.postWithReauth(`/api/checklist-profiles/${id}/questions`, body, password);
          else await apiClient.post(`/api/checklist-profiles/${id}/questions`, body);
        }
        mutate(swrKey); setShowAdd(false); setEditingId(null); setForm(emptyQuestion()); setError(null);
      } catch (e: any) { setError(e.message || 'Failed to save question'); throw e; }
      finally { setSaving(false); }
    });
    setSaving(false);
  };

  const deleteQuestion = async (qId: string) => {
    await reauth.execute('DELETE_CHECKLIST_PROFILE', async (password?: string) => {
      try {
        if (password) await apiClient.deleteWithReauth(`/api/checklist-profiles/${id}/questions/${qId}`, password);
        else await apiClient.delete(`/api/checklist-profiles/${id}/questions/${qId}`);
        mutate(swrKey); setError(null);
      } catch (e: any) { setError(e.message || 'Failed to delete question'); throw e; }
    });
  };

  const moveQuestion = async (idx: number, dir: -1 | 1) => {
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= questions.length) return;
    const ids = questions.map((q: any) => q.id);
    [ids[idx], ids[newIdx]] = [ids[newIdx], ids[idx]];
    try { await apiClient.put(`/api/checklist-profiles/${id}/reorder`, { questionIds: ids }); mutate(swrKey); }
    catch (e: any) { setError(e.message || 'Failed to reorder'); }
  };

  const addOption = () => {
    if (!optionInput.trim()) return;
    setForm({ ...form, options: [...form.options, optionInput.trim()] });
    setOptionInput('');
  };

  const removeOption = (idx: number) => {
    setForm({ ...form, options: form.options.filter((_, i) => i !== idx) });
  };

  const getTypeInfo = (t: string) => QUESTION_TYPES.find(qt => qt.value === t) ?? { value: t, label: t, color: 'bg-slate-50 text-slate-600 border-slate-200' };

  if (isLoading) return (
    <div className="flex justify-center py-20">
      <div className="w-8 h-8 border-3 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--theme-primary)', borderTopColor: 'transparent' }} />
    </div>
  );

  const requiredCount = questions.filter((q: any) => q.required).length;

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden shadow-sm">
        <div className="h-1.5" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }} />
        <div className="p-6">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button onClick={() => navigate('/checklists')}
                className="w-10 h-10 rounded-xl bg-slate-100 hover:bg-slate-200 flex items-center justify-center text-slate-500 hover:text-slate-700 transition-colors">
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
              </button>
              <div className="w-12 h-12 rounded-xl flex items-center justify-center text-white shadow-lg" style={{ background: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
                <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
              </div>
              <div className="flex-1">
                {editProfileMode ? (
                  <div className="space-y-2 max-w-xl">
                    <input type="text" value={editProfileForm.name}
                           onChange={e => setEditProfileForm(f => ({ ...f, name: e.target.value }))}
                           placeholder="Profile name"
                           className="w-full px-3 py-2 text-base font-bold text-slate-800 border border-slate-300 rounded-lg focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-100" />
                    <input type="text" value={editProfileForm.description}
                           onChange={e => setEditProfileForm(f => ({ ...f, description: e.target.value }))}
                           placeholder="Description (optional)"
                           className="w-full px-3 py-1.5 text-sm text-slate-600 border border-slate-300 rounded-lg focus:border-cyan-500 focus:outline-none focus:ring-2 focus:ring-cyan-100" />
                    <label className="inline-flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                      <input type="checkbox" checked={editProfileForm.isActive}
                             onChange={e => setEditProfileForm(f => ({ ...f, isActive: e.target.checked }))}
                             className="w-4 h-4 rounded border-slate-300 text-cyan-600 focus:ring-cyan-500" />
                      Active (available for use in cleaning profiles)
                    </label>
                    <div className="flex items-center gap-2 pt-1">
                      <button onClick={submitEditProfile} disabled={savingProfile || !editProfileForm.name.trim()}
                              className="px-3 py-1.5 bg-cyan-600 text-white rounded-lg text-xs font-semibold hover:bg-cyan-700 disabled:opacity-50">
                        {savingProfile ? 'Saving…' : 'Save'}
                      </button>
                      <button onClick={() => setEditProfileMode(false)} disabled={savingProfile}
                              className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-200 disabled:opacity-50">
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center gap-2">
                    <div>
                      <h1 className="text-xl font-bold text-slate-800">{profile?.name ?? 'Checklist'}</h1>
                      {profile?.description && <p className="text-sm text-slate-400 mt-0.5">{profile.description}</p>}
                    </div>
                    {canEdit && profile && (
                      <button onClick={openEditProfile}
                              aria-label="Edit profile metadata"
                              title="Edit profile name / description / active status"
                              className="ml-1 w-7 h-7 rounded text-slate-400 hover:text-cyan-600 hover:bg-cyan-50 transition-colors flex items-center justify-center">
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
                        </svg>
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div className="flex items-center gap-3">
              {/* M4 (2026-05-03): deep-link to the cross-entity Version History page,
                  pre-tabbed to checklist-profile and pre-selected to this id.
                  Lightweight discoverability fix — keeps all version-list / diff
                  rendering on the dedicated page; no extra fetches here. */}
              {canViewHistory && id && (
                <button
                  onClick={() => navigate(`/version-history?entity=checklist-profile&id=${id}`)}
                  className="px-3 py-1.5 text-xs rounded-full font-semibold flex items-center gap-1.5 bg-indigo-50 text-indigo-700 border border-indigo-200 hover:bg-indigo-100 hover:border-indigo-300 transition-colors"
                  title="View archived versions and diffs for this checklist profile"
                >
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                  Version History
                </button>
              )}
              <span className={`px-3 py-1.5 text-xs rounded-full font-semibold flex items-center gap-1.5 ${profile?.isActive ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                <span className={`w-2 h-2 rounded-full ${profile?.isActive ? 'bg-emerald-500' : 'bg-slate-400'}`} />
                {profile?.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
          </div>

          {/* Stats */}
          <div className="flex gap-6 mt-5 pt-5 border-t border-slate-100">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center">
                <svg className="w-4 h-4 text-blue-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              </div>
              <div>
                <div className="text-lg font-bold text-slate-800">{questions.length}</div>
                <div className="text-xs text-slate-400">Questions</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center">
                <svg className="w-4 h-4 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
              </div>
              <div>
                <div className="text-lg font-bold text-slate-800">{requiredCount}</div>
                <div className="text-xs text-slate-400">Required</div>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-teal-50 flex items-center justify-center">
                <svg className="w-4 h-4 text-teal-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h7" /></svg>
              </div>
              <div>
                <div className="text-lg font-bold text-slate-800">{sections.length}</div>
                <div className="text-xs text-slate-400">Sections</div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-xl text-sm flex items-center justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)} className="text-red-400 hover:text-red-600 ml-4">&times;</button>
        </div>
      )}

      {/* Questions */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-bold text-slate-800">Questions</h2>
        {canEdit && (
          <button onClick={openAdd}
            className="px-4 py-2 text-white rounded-xl text-sm font-semibold transition-all shadow-lg flex items-center gap-2"
            style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" /></svg>
            Add Question
          </button>
        )}
      </div>

      {questions.length === 0 ? (
        <div className="text-center py-20 bg-slate-50 rounded-2xl border-2 border-dashed border-slate-200">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl flex items-center justify-center" style={{ backgroundColor: 'var(--theme-primary-light)' }}>
            <svg className="w-8 h-8 text-theme-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
          </div>
          <p className="text-slate-600 font-semibold">No questions yet</p>
          <p className="text-sm text-slate-400 mt-1">Add your first question to this checklist</p>
          {canEdit && <button onClick={openAdd} className="mt-4 px-4 py-2 text-white rounded-xl text-sm font-medium" style={{ backgroundColor: 'var(--theme-primary)' }}>Add First Question</button>}
        </div>
      ) : (
        <div className="space-y-3">
          {questions.map((q: any, idx: number) => {
            const typeInfo = getTypeInfo(q.questionType);
            return (
              <div key={q.id} className="bg-white border border-slate-200 rounded-2xl p-5 flex items-start gap-4 group hover:shadow-md transition-all">
                {/* Number + reorder */}
                <div className="flex flex-col items-center gap-1 shrink-0">
                  {canEdit && (
                    <button onClick={() => moveQuestion(idx, -1)} disabled={idx === 0}
                      className="w-7 h-7 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-400 hover:text-slate-600 disabled:opacity-20 flex items-center justify-center transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
                    </button>
                  )}
                  <div className="w-8 h-8 rounded-lg text-white flex items-center justify-center text-sm font-bold shadow-sm" style={{ background: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
                    {idx + 1}
                  </div>
                  {canEdit && (
                    <button onClick={() => moveQuestion(idx, 1)} disabled={idx === questions.length - 1}
                      className="w-7 h-7 rounded-lg bg-slate-50 hover:bg-slate-100 text-slate-400 hover:text-slate-600 disabled:opacity-20 flex items-center justify-center transition-colors">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" /></svg>
                    </button>
                  )}
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-semibold text-slate-800 leading-relaxed">{q.question}</div>
                  <div className="flex items-center gap-2 mt-2 flex-wrap">
                    <span className={`px-2.5 py-0.5 text-xs rounded-lg font-semibold border ${typeInfo.color}`}>{typeInfo.label}</span>
                    {q.required && (
                      <span className="px-2.5 py-0.5 text-xs rounded-lg font-semibold bg-red-50 text-red-600 border border-red-200">Required</span>
                    )}
                    {q.section && (
                      <span className="px-2.5 py-0.5 text-xs rounded-lg font-medium bg-slate-50 text-slate-500 border border-slate-200">{q.section}</span>
                    )}
                    {Array.isArray(q.options) && q.options.length > 0 && (
                      <span className="text-xs text-slate-400">{q.options.length} options</span>
                    )}
                  </div>
                  {q.description && <div className="text-xs text-slate-400 mt-2">{q.description}</div>}
                </div>

                {/* Actions */}
                <div className="flex gap-2 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity">
                  {canEdit && (
                    <button onClick={() => openEdit(q)}
                      className="px-3 py-1.5 text-xs font-medium rounded-lg transition-colors" style={{ color: 'var(--theme-primary)', backgroundColor: 'var(--theme-primary-light)' }}>Edit</button>
                  )}
                  {canDelete && (
                    <button onClick={() => deleteQuestion(q.id)}
                      className="px-3 py-1.5 text-xs font-medium text-red-500 bg-red-50 hover:bg-red-100 rounded-lg transition-colors">Delete</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Add/Edit Question Modal */}
      {showAdd && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm" onClick={() => { setShowAdd(false); setEditingId(null); }}>
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col shadow-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="h-1.5" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }} />
            <div className="p-5 border-b border-slate-100">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white" style={{ background: 'linear-gradient(to bottom right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d={editingId ? "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" : "M12 4v16m8-8H4"} /></svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-slate-800">{editingId ? 'Edit Question' : 'Add Question'}</h2>
                  <p className="text-xs text-slate-400">Configure the question settings below</p>
                </div>
              </div>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Question *</label>
                <textarea className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm outline-none" rows={2}
                  onFocus={e => { e.currentTarget.style.borderColor = 'var(--theme-primary)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--theme-focus-ring)'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
                  value={form.question} onChange={e => setForm({ ...form, question: e.target.value })} placeholder="Enter your question..." autoFocus />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Type</label>
                  <select className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm outline-none"
                    onFocus={e => { e.currentTarget.style.borderColor = 'var(--theme-primary)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--theme-focus-ring)'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
                    value={form.questionType} onChange={e => setForm({ ...form, questionType: e.target.value, options: TYPES_WITH_OPTIONS.includes(e.target.value) ? form.options : [] })}>
                    {QUESTION_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Section</label>
                  <input className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm outline-none"
                    onFocus={e => { e.currentTarget.style.borderColor = 'var(--theme-primary)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--theme-focus-ring)'; }}
                    onBlur={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
                    value={form.section} onChange={e => setForm({ ...form, section: e.target.value })} placeholder="e.g. Pre-checks" />
                </div>
              </div>
              <div className="flex items-center gap-3 p-3 bg-slate-50 rounded-xl border border-slate-200">
                <label className="flex items-center gap-2 text-sm text-slate-700 cursor-pointer font-medium">
                  <input type="checkbox" checked={form.required} onChange={e => setForm({ ...form, required: e.target.checked })}
                    className="w-4 h-4 rounded border-slate-300" style={{ accentColor: 'var(--theme-primary)' }} />
                  Required question
                </label>
              </div>
              <div>
                <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Help Text</label>
                <input className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm outline-none"
                  onFocus={e => { e.currentTarget.style.borderColor = 'var(--theme-primary)'; e.currentTarget.style.boxShadow = '0 0 0 2px var(--theme-focus-ring)'; }}
                  onBlur={e => { e.currentTarget.style.borderColor = ''; e.currentTarget.style.boxShadow = ''; }}
                  value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Additional guidance for this question" />
              </div>

              {TYPES_WITH_OPTIONS.includes(form.questionType) && (
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Options</label>
                  <div className="space-y-1.5 mb-2">
                    {form.options.map((opt, i) => (
                      <div key={i} className="flex items-center gap-2 bg-white border border-slate-200 rounded-lg px-3 py-2">
                        <span className="w-5 h-5 rounded flex items-center justify-center text-xs font-bold" style={{ backgroundColor: 'var(--theme-primary-light)', color: 'var(--theme-primary)' }}>{i + 1}</span>
                        <span className="text-sm text-slate-700 flex-1">{opt}</span>
                        <button onClick={() => removeOption(i)} className="text-xs text-slate-400 hover:text-red-500">&times;</button>
                      </div>
                    ))}
                  </div>
                  <div className="flex gap-2">
                    <input className="flex-1 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-slate-800 text-sm"
                      value={optionInput} onChange={e => setOptionInput(e.target.value)} placeholder="Add option..."
                      onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addOption(); } }} />
                    <button onClick={addOption} className="px-4 py-2 font-medium rounded-lg text-sm" style={{ backgroundColor: 'var(--theme-primary-light)', color: 'var(--theme-primary)' }}>Add</button>
                  </div>
                </div>
              )}

              {TYPES_WITH_NUMERIC.includes(form.questionType) && (
                <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Min</label>
                    <input type="number" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm"
                      value={form.validation.min ?? ''} onChange={e => setForm({ ...form, validation: { ...form.validation, min: e.target.value ? Number(e.target.value) : undefined } })} />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Max</label>
                    <input type="number" className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm"
                      value={form.validation.max ?? ''} onChange={e => setForm({ ...form, validation: { ...form.validation, max: e.target.value ? Number(e.target.value) : undefined } })} />
                  </div>
                  <div>
                    <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Unit</label>
                    <input className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm"
                      value={form.validation.unit ?? ''} onChange={e => setForm({ ...form, validation: { ...form.validation, unit: e.target.value } })} placeholder="e.g. degC" />
                  </div>
                </div>
              )}

              {form.questionType === 'CALCULATED' && (
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1.5 block">Expression</label>
                  <input className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-slate-800 text-sm font-mono"
                    value={form.validation.expression ?? ''} onChange={e => setForm({ ...form, validation: { ...form.validation, expression: e.target.value } })} placeholder="e.g. q_1 + q_2" />
                </div>
              )}
            </div>
            <div className="p-4 border-t border-slate-100 flex gap-3">
              <button onClick={() => { setShowAdd(false); setEditingId(null); }} className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-200">Cancel</button>
              <button onClick={saveQuestion} disabled={saving || !form.question.trim()}
                className="flex-1 py-2.5 text-white rounded-xl text-sm font-semibold disabled:opacity-50 shadow-lg"
                style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
                {saving ? 'Saving...' : editingId ? 'Update Question' : 'Add Question'}
              </button>
            </div>
          </div>
        </div>
      )}
      <ReauthDialog open={reauth.isOpen} password={reauth.password} error={reauth.error} isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword} onConfirm={reauth.confirm} onCancel={reauth.cancel} />
    </div>
  );
}
