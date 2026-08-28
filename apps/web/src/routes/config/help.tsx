import { useState, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Dialog, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { ReauthDialog } from '@/components/reauth-dialog';

// ─── Types ────────────────────────────────────────────────────────────────────

interface HelpArticle {
  id: string;
  key: string;
  title: string;
  category: string;
  sortOrder: number;
  currentVersion: number;
  updatedAt: string;
}

interface HelpArticleVersion {
  id: string;
  helpArticleId: string;
  version: number;
  content: string;
  changedBy: string;
  changeNotes: string | null;
  createdAt: string;
}

interface ArticleFormData {
  key: string;
  title: string;
  category: string;
  content: string;
  sortOrder: number;
}

// ─── Constants ────────────────────────────────────────────────────────────────

// 'rule-chain' + 'alarms' categories removed 2026-05-17 (subsystems retired).
const CATEGORIES = [
  'entity',
  'connectivity',
  'data',
  'uns',
  'audit',
  'users',
] as const;

type HelpCategory = (typeof CATEGORIES)[number];

const CATEGORY_COLORS: Record<HelpCategory, string> = {
  entity: 'bg-emerald-100 text-emerald-700 border-emerald-200',
  connectivity: 'bg-sky-100 text-sky-700 border-sky-200',
  data: 'bg-blue-100 text-blue-700 border-blue-200',
  uns: 'bg-slate-100 text-slate-700 border-slate-200',
  audit: 'bg-orange-100 text-orange-700 border-orange-200',
  users: 'bg-indigo-100 text-indigo-700 border-indigo-200',
};

const CATEGORY_LABELS: Record<HelpCategory, string> = {
  entity: 'Entity',
  connectivity: 'Connectivity',
  data: 'Data',
  uns: 'UNS',
  audit: 'Audit',
  users: 'Users',
};

const DEFAULT_FORM: ArticleFormData = {
  key: '',
  title: '',
  category: CATEGORIES[0],
  content: '',
  sortOrder: 0,
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function buildUrl(base: string, search: string, category: string): string {
  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (category) params.set('category', category);
  const qs = params.toString();
  return qs ? `${base}?${qs}` : base;
}

function getCategoryColor(category: string): string {
  return CATEGORY_COLORS[category as HelpCategory] ?? 'bg-slate-100 text-slate-600 border-slate-200';
}

function getCategoryLabel(category: string): string {
  return CATEGORY_LABELS[category as HelpCategory] ?? category;
}

// ─── Page Component ───────────────────────────────────────────────────────────

export function HelpArticlesPage() {
  const { formatDateTime } = useDatetimeFormat();
  const { toast } = useToast();
  const reauth = useReauth();

  // ── Search & filter state
  const [rawSearch, setRawSearch] = useState('');
  const [search, setSearch] = useState('');
  const [categoryFilter, setCategoryFilter] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  // Debounce search
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setSearch(rawSearch), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [rawSearch]);

  // ── Data fetching
  const swrKey = buildUrl('/api/help', search, categoryFilter);
  const { data: articles, isLoading, mutate } = useSWR<HelpArticle[]>(swrKey);

  // ── Dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [showEdit, setShowEdit] = useState(false);
  const [showVersions, setShowVersions] = useState(false);
  const [showDelete, setShowDelete] = useState(false);

  const [selectedArticle, setSelectedArticle] = useState<HelpArticle | null>(null);
  const [form, setForm] = useState<ArticleFormData>(DEFAULT_FORM);
  const [formError, setFormError] = useState('');
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState('');

  // Version history
  const [versions, setVersions] = useState<HelpArticleVersion[]>([]);
  const [versionsLoading, setVersionsLoading] = useState(false);

  // ── Handlers: Create ──────────────────────────────────────────────────────

  const openCreate = () => {
    setForm(DEFAULT_FORM);
    setFormError('');
    setShowCreate(true);
  };

  const handleCreate = async () => {
    if (!form.key.trim() || !form.title.trim() || !form.content.trim()) {
      setFormError('Key, Title, and Content are required.');
      return;
    }
    setSaving(true);
    setFormError('');
    await reauth.execute(
      'CREATE_HELP_ARTICLE',
      async (password?: string) => {
        const payload = {
          key: form.key.trim(),
          title: form.title.trim(),
          category: form.category,
          content: form.content,
          sortOrder: form.sortOrder,
        };
        if (password) {
          await apiClient.postWithReauth('/api/help', payload, password);
        } else {
          await apiClient.post('/api/help', payload);
        }
      },
      {
        onSuccess: () => {
          mutate();
          setShowCreate(false);
          setSaving(false);
          toast.success('Article created', `"${form.title}" has been created successfully.`);
        },
        onError: (err: unknown) => {
          const msg = (err as Error)?.message ?? 'Failed to create article';
          setFormError(msg);
          setSaving(false);
        },
      },
    );
  };

  // ── Handlers: Edit ────────────────────────────────────────────────────────

  const openEdit = async (article: HelpArticle) => {
    setSelectedArticle(article);
    // Show dialog immediately with known fields; fetch full content so the user can edit it
    setForm({
      key: article.key,
      title: article.title,
      category: article.category,
      content: '',
      sortOrder: article.sortOrder,
    });
    setFormError('');
    setShowEdit(true);
    try {
      // GET /api/help/:key returns the full article including `content`
      const full = await apiClient.get<HelpArticle & { content?: string }>(`/api/help/${encodeURIComponent(article.key)}`);
      setForm(f => ({ ...f, content: full?.content ?? '' }));
    } catch (e: any) {
      setFormError(`Could not load article content: ${e.message ?? 'unknown error'}`);
    }
  };

  const handleEdit = async () => {
    if (!form.title.trim()) {
      setFormError('Title is required.');
      return;
    }
    if (!selectedArticle) return;
    setSaving(true);
    setFormError('');
    await reauth.execute(
      'UPDATE_HELP_ARTICLE',
      async (password?: string) => {
        const payload: Record<string, unknown> = {
          title: form.title.trim(),
          category: form.category,
          sortOrder: form.sortOrder,
        };
        if (form.content.trim()) {
          payload.content = form.content;
        }
        if (password) {
          await apiClient.putWithReauth(`/api/help/${selectedArticle.id}`, payload, password);
        } else {
          await apiClient.put(`/api/help/${selectedArticle.id}`, payload);
        }
      },
      {
        onSuccess: () => {
          mutate();
          setShowEdit(false);
          setSaving(false);
          toast.success('Article updated', `"${form.title}" has been updated successfully.`);
        },
        onError: (err: unknown) => {
          const msg = (err as Error)?.message ?? 'Failed to update article';
          setFormError(msg);
          setSaving(false);
        },
      },
    );
  };

  // ── Handlers: Delete ──────────────────────────────────────────────────────

  const openDelete = (article: HelpArticle) => {
    setSelectedArticle(article);
    setDeleteError('');
    setShowDelete(true);
  };

  const handleDelete = async () => {
    if (!selectedArticle) return;
    setDeleting(true);
    setDeleteError('');
    await reauth.execute(
      'DELETE_HELP_ARTICLE',
      async (password?: string) => {
        if (password) {
          await apiClient.deleteWithReauth(`/api/help/${selectedArticle.id}`, password);
        } else {
          await apiClient.delete(`/api/help/${selectedArticle.id}`);
        }
      },
      {
        onSuccess: () => {
          mutate();
          setShowDelete(false);
          setDeleting(false);
          toast.success('Article deleted', `"${selectedArticle.title}" has been deleted.`);
          setSelectedArticle(null);
        },
        onError: (err: unknown) => {
          const msg = (err as Error)?.message ?? 'Failed to delete article';
          setDeleteError(msg);
          setDeleting(false);
        },
      },
    );
  };

  // ── Handlers: Version History ─────────────────────────────────────────────

  const openVersions = async (article: HelpArticle) => {
    setSelectedArticle(article);
    setVersions([]);
    setVersionsLoading(true);
    setShowVersions(true);
    try {
      const data = await apiClient.get<HelpArticleVersion[]>(`/api/help/${article.id}/versions`);
      setVersions(data);
    } catch {
      toast.error('Failed to load versions', 'Could not retrieve version history.');
    } finally {
      setVersionsLoading(false);
    }
  };

  // ── Render ─────────────────────────────────────────────────────────────────

  const articleList = articles ?? [];

  return (
    <div className="space-y-6 animate-fade-in">
      {/* ── Header ── */}
      <div className="relative overflow-hidden rounded-[var(--radius-card)] bg-gradient-to-br from-emerald-500 via-teal-600 to-cyan-700 p-6 text-white shadow-[var(--elev-3)]">
        <div className="absolute inset-0 bg-[url('data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNjAiIGhlaWdodD0iNjAiIHZpZXdCb3g9IjAgMCA2MCA2MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48ZyBmaWxsPSJub25lIiBmaWxsLXJ1bGU9ImV2ZW5vZGQiPjxwYXRoIGQ9Ik0zNiAxOGMzLjMxNCAwIDYgMi42ODYgNiA2cy0yLjY4NiA2LTYgNi02LTIuNjg2LTYtNiAyLjY4Ni02IDYtNiIgc3Ryb2tlPSJyZ2JhKDI1NSwyNTUsMjU1LDAuMSkiIHN0cm9rZS13aWR0aD0iMiIvPjwvZz48L3N2Zz4=')] opacity-30" />
        <div className="relative flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Link
              to="/config"
              className="p-2.5 rounded-xl bg-white/10 hover:bg-white/20 backdrop-blur-sm transition-all duration-200 border border-white/10"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </Link>
            <div className="flex items-center gap-3">
              <div className="p-3 rounded-xl bg-white/20 backdrop-blur-sm shadow-[var(--elev-2)]">
                <svg className="w-7 h-7" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              </div>
              <div>
                <h1 className="text-[26px] font-semibold leading-tight tracking-[-0.01em] text-slate-900">Help Articles</h1>
                <p className="text-teal-100/80 text-sm">Manage in-app help content and documentation</p>
              </div>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <div className="px-4 py-2 rounded-xl bg-white/10 backdrop-blur-sm border border-white/10 text-center">
              <p className="text-xs text-teal-100 uppercase tracking-wider">Articles</p>
              <p className="text-2xl font-bold">{articleList.length}</p>
            </div>
            <button
              onClick={openCreate}
              className="flex items-center gap-2 px-5 py-2.5 rounded-xl bg-white text-teal-700 hover:bg-teal-50 font-semibold shadow-[var(--elev-2)] transition-all duration-200 text-sm"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
              New Article
            </button>
          </div>
        </div>
      </div>

      {/* ── Filters ── */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-[var(--elev-2)] overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500" />
        <div className="p-5">
          <div className="flex items-center gap-4">
            {/* Search */}
            <div className="flex-1 relative group">
              <div className="absolute inset-0 rounded-xl bg-gradient-to-r from-emerald-500/20 to-teal-500/20 blur-sm opacity-0 group-hover:opacity-100 transition-opacity" />
              <div className="relative">
                <svg className="absolute left-4 top-1/2 -translate-y-1/2 w-5 h-5 text-slate-400 group-hover:text-emerald-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                </svg>
                <input
                  type="text"
                  placeholder="Search by title, key, or content..."
                  value={rawSearch}
                  onChange={(e) => setRawSearch(e.target.value)}
                  className="ctl w-full"
                />
              </div>
            </div>

            {/* Category Filter */}
            <div className="relative">
              <svg className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400 pointer-events-none z-10" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4a1 1 0 011-1h16a1 1 0 011 1v2.586a1 1 0 01-.293.707l-6.414 6.414a1 1 0 00-.293.707V17l-4 4v-6.586a1 1 0 00-.293-.707L3.293 7.293A1 1 0 013 6.586V4z" />
              </svg>
              <select
                value={categoryFilter}
                onChange={(e) => setCategoryFilter(e.target.value)}
                className="ctl font-medium min-w-[160px]"
              >
                <option value="">All Categories</option>
                {CATEGORIES.map((cat) => (
                  <option key={cat} value={cat}>
                    {getCategoryLabel(cat)}
                  </option>
                ))}
              </select>
            </div>

            {/* Clear button */}
            {(rawSearch || categoryFilter) && (
              <Button
                variant="outline"
                onClick={() => { setRawSearch(''); setCategoryFilter(''); }}
                className="h-11 px-4 rounded-xl hover:bg-red-50 hover:text-red-600 hover:border-red-200 transition-all text-sm"
              >
                <svg className="w-4 h-4 mr-1.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
                Clear
              </Button>
            )}
          </div>
          {(search || categoryFilter) && (
            <p className="mt-3 text-sm text-slate-500">
              Found <span className="font-semibold text-emerald-600">{articleList.length}</span> matching article{articleList.length !== 1 ? 's' : ''}
            </p>
          )}
        </div>
      </div>

      {/* ── Table ── */}
      <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-[var(--elev-2)] overflow-hidden">
        {isLoading ? (
          <div className="p-16 text-center">
            <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-gradient-to-br from-emerald-500 to-teal-600 mb-4 animate-pulse">
              <svg className="w-8 h-8 text-white animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
            <p className="text-slate-600 font-medium">Loading help articles...</p>
            <p className="text-sm text-slate-400 mt-1">Please wait a moment</p>
          </div>
        ) : articleList.length === 0 ? (
          <div className="p-16 text-center">
            <div className="inline-flex items-center justify-center w-20 h-20 rounded-[var(--radius-card)] bg-gradient-to-br from-slate-100 to-slate-200 mb-4">
              <svg className="w-10 h-10 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093m0 3h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <p className="text-slate-700 font-semibold text-lg">No articles found</p>
            <p className="text-sm text-slate-400 mt-1">
              {search || categoryFilter
                ? 'Try adjusting your search or category filter'
                : 'Create your first help article using the button above'}
            </p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="bg-gradient-to-r from-slate-50 to-white border-b border-slate-200">
                  <th className="text-left px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Title</th>
                  <th className="text-left px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Key</th>
                  <th className="text-left px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Category</th>
                  <th className="text-center px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Version</th>
                  <th className="text-left px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Updated At</th>
                  <th className="text-right px-6 py-4 text-xs font-semibold text-slate-500 uppercase tracking-wider">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {articleList.map((article) => (
                  <tr
                    key={article.id}
                    className="group hover:bg-gradient-to-r hover:from-emerald-50/40 hover:to-teal-50/20 transition-all duration-200"
                  >
                    {/* Title */}
                    <td className="px-6 py-4">
                      <div className="flex items-center gap-3">
                        <div className="flex-shrink-0 w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-500/10 to-teal-500/10 flex items-center justify-center group-hover:from-emerald-500/20 group-hover:to-teal-500/20 transition-all">
                          <svg className="w-4 h-4 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                        </div>
                        <span className="font-semibold text-slate-800 text-sm">{article.title}</span>
                      </div>
                    </td>

                    {/* Key */}
                    <td className="px-6 py-4">
                      <code className="inline-flex items-center px-2.5 py-1 text-xs font-mono bg-gradient-to-r from-slate-100 to-slate-50 rounded-lg text-slate-600 border border-slate-200/60">
                        {article.key}
                      </code>
                    </td>

                    {/* Category */}
                    <td className="px-6 py-4">
                      <Badge className={`border ${getCategoryColor(article.category)}`}>
                        {getCategoryLabel(article.category)}
                      </Badge>
                    </td>

                    {/* Version */}
                    <td className="px-6 py-4 text-center">
                      <button
                        onClick={() => openVersions(article)}
                        className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg bg-slate-100 hover:bg-emerald-100 text-slate-600 hover:text-emerald-700 text-xs font-semibold transition-all duration-200"
                        title="View version history"
                      >
                        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                        </svg>
                        v{article.currentVersion}
                      </button>
                    </td>

                    {/* Updated At */}
                    <td className="px-6 py-4">
                      <span className="text-sm text-slate-500">{formatDateTime(article.updatedAt)}</span>
                    </td>

                    {/* Actions */}
                    <td className="px-6 py-4">
                      <div className="flex items-center justify-end gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity">
                        {/* Versions */}
                        <button
                          onClick={() => openVersions(article)}
                          className="p-2 rounded-lg text-slate-400 hover:text-sky-600 hover:bg-sky-50 transition-all"
                          title="Version history"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                          </svg>
                        </button>

                        {/* Edit */}
                        <button
                          onClick={() => openEdit(article)}
                          className="p-2 rounded-lg text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 transition-all"
                          title="Edit article"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                          </svg>
                        </button>

                        {/* Delete */}
                        <button
                          onClick={() => openDelete(article)}
                          className="p-2 rounded-lg text-slate-400 hover:text-red-600 hover:bg-red-50 transition-all"
                          title="Delete article"
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                          </svg>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* ── Info Banner ── */}
      <div className="relative overflow-hidden rounded-[var(--radius-card)] bg-gradient-to-r from-emerald-50 via-teal-50 to-cyan-50 border border-emerald-100/50 p-5">
        <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-emerald-500/10 to-teal-500/10 rounded-full blur-3xl" />
        <div className="relative flex items-start gap-4">
          <div className="flex-shrink-0 p-3 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-[var(--elev-2)]">
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-emerald-900 mb-1">Help Article Management</h3>
            <p className="text-sm text-emerald-700">
              Help articles are displayed to users in context-sensitive panels throughout the app.
              Each article is identified by a unique key and supports markdown content.
              All changes are versioned automatically.
            </p>
            <div className="flex items-center gap-4 mt-3">
              <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
                Auto-versioned
              </div>
              <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" />
                </svg>
                Audit tracked
              </div>
              <div className="flex items-center gap-1.5 text-xs text-emerald-600">
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21h10a2 2 0 002-2V9.414a1 1 0 00-.293-.707l-5.414-5.414A1 1 0 0012.586 3H7a2 2 0 00-2 2v14a2 2 0 002 2z" />
                </svg>
                Markdown supported
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ════════════════════════════════════════════════════
          Dialog: Create Article
      ════════════════════════════════════════════════════ */}
      <Dialog open={showCreate} onClose={() => setShowCreate(false)} className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-emerald-500 to-teal-600 text-white shadow-[var(--elev-1)]">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
              </svg>
            </div>
            <DialogTitle>Create Help Article</DialogTitle>
          </div>
          <p className="text-sm text-slate-500 mt-2 ml-14">Add a new help article available to users in the app.</p>
        </DialogHeader>

        <ArticleFormFields
          form={form}
          onChange={setForm}
          error={formError}
          keyReadOnly={false}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowCreate(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleCreate}
            disabled={saving}
            className="bg-gradient-to-r from-emerald-500 to-teal-600 hover:from-emerald-600 hover:to-teal-700 text-white"
          >
            {saving ? (
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Creating...
              </span>
            ) : 'Create Article'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ════════════════════════════════════════════════════
          Dialog: Edit Article
      ════════════════════════════════════════════════════ */}
      <Dialog open={showEdit} onClose={() => setShowEdit(false)} className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-sky-500 to-blue-600 text-white shadow-[var(--elev-1)]">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
              </svg>
            </div>
            <DialogTitle>Edit Article</DialogTitle>
          </div>
          {selectedArticle && (
            <p className="text-sm text-slate-500 mt-2 ml-14">
              Editing <span className="font-semibold text-slate-700">{selectedArticle.title}</span>
              {' '}&mdash; leave Content empty to keep existing content.
            </p>
          )}
        </DialogHeader>

        <ArticleFormFields
          form={form}
          onChange={setForm}
          error={formError}
          keyReadOnly={true}
        />

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowEdit(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={handleEdit}
            disabled={saving}
            className="bg-gradient-to-r from-sky-500 to-blue-600 hover:from-sky-600 hover:to-blue-700 text-white"
          >
            {saving ? (
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Saving...
              </span>
            ) : 'Save Changes'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ════════════════════════════════════════════════════
          Dialog: Version History
      ════════════════════════════════════════════════════ */}
      <Dialog open={showVersions} onClose={() => setShowVersions(false)} className="max-w-2xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-[var(--elev-1)]">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <DialogTitle>Version History</DialogTitle>
          </div>
          {selectedArticle && (
            <p className="text-sm text-slate-500 mt-2 ml-14">
              <span className="font-semibold text-slate-700">{selectedArticle.title}</span>
              {' '}&mdash; {selectedArticle.currentVersion} version{selectedArticle.currentVersion !== 1 ? 's' : ''}
            </p>
          )}
        </DialogHeader>

        <div className="space-y-3 max-h-[420px] overflow-y-auto pr-1">
          {versionsLoading ? (
            <div className="flex items-center justify-center py-12">
              <svg className="w-7 h-7 animate-spin text-violet-500" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
            </div>
          ) : versions.length === 0 ? (
            <div className="py-10 text-center text-slate-400 text-sm">No version history available.</div>
          ) : (
            versions.map((v, idx) => (
              <div
                key={v.id}
                className={`rounded-xl border p-4 transition-all ${
                  idx === 0
                    ? 'border-violet-200 bg-violet-50/50'
                    : 'border-slate-200 bg-slate-50/50'
                }`}
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-2.5">
                    <div className={`w-8 h-8 rounded-lg flex items-center justify-center text-xs font-bold ${
                      idx === 0
                        ? 'bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-[var(--elev-1)]'
                        : 'bg-slate-200 text-slate-600'
                    }`}>
                      v{v.version}
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold text-slate-800">Version {v.version}</span>
                        {idx === 0 && (
                          <Badge className="bg-violet-100 text-violet-700 border-violet-200 text-[10px] py-0.5 px-1.5">
                            Latest
                          </Badge>
                        )}
                      </div>
                      {v.changeNotes && (
                        <p className="text-xs text-slate-500 mt-0.5 italic">{v.changeNotes}</p>
                      )}
                    </div>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-xs text-slate-500">
                      <span className="font-medium text-slate-700">{v.changedBy}</span>
                    </p>
                    <p className="text-xs text-slate-400 mt-0.5">{formatDateTime(v.createdAt)}</p>
                  </div>
                </div>
                {v.content && (
                  <div className="mt-3 pl-10">
                    <p className="text-xs text-slate-500 uppercase tracking-wider mb-1 font-medium">Content preview</p>
                    <div className="bg-white rounded-lg border border-slate-200 p-3 text-xs text-slate-600 font-mono max-h-24 overflow-y-auto whitespace-pre-wrap">
                      {v.content.slice(0, 300)}{v.content.length > 300 ? '…' : ''}
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowVersions(false)}>
            Close
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ════════════════════════════════════════════════════
          Dialog: Delete Confirmation
      ════════════════════════════════════════════════════ */}
      <Dialog open={showDelete} onClose={() => setShowDelete(false)}>
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-xl bg-red-100 text-red-600">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
              </svg>
            </div>
            <DialogTitle>Delete Article</DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-4">
          <p className="text-sm text-slate-600">
            Are you sure you want to delete{' '}
            <span className="font-semibold text-slate-800">"{selectedArticle?.title}"</span>?
            This action will hide the article from users. Version history will be preserved.
          </p>
          {deleteError && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 flex items-center gap-2">
              <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
              {deleteError}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setShowDelete(false)} disabled={deleting}>
            Cancel
          </Button>
          <Button
            onClick={handleDelete}
            disabled={deleting}
            className="bg-gradient-to-r from-red-500 to-rose-600 hover:from-red-600 hover:to-rose-700 text-white"
          >
            {deleting ? (
              <span className="flex items-center gap-2">
                <svg className="w-4 h-4 animate-spin" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                Deleting...
              </span>
            ) : 'Delete Article'}
          </Button>
        </DialogFooter>
      </Dialog>

      {/* ════════════════════════════════════════════════════
          ReauthDialog (shared, priority overlay)
      ════════════════════════════════════════════════════ */}
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
      />
    </div>
  );
}

// ─── ArticleFormFields ─────────────────────────────────────────────────────────

interface ArticleFormFieldsProps {
  form: ArticleFormData;
  onChange: (form: ArticleFormData) => void;
  error: string;
  keyReadOnly: boolean;
}

function ArticleFormFields({ form, onChange, error, keyReadOnly }: ArticleFormFieldsProps) {
  const set = (patch: Partial<ArticleFormData>) => onChange({ ...form, ...patch });

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700 flex items-center gap-2">
          <svg className="w-4 h-4 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          {error}
        </div>
      )}

      {/* Key */}
      <div>
        <label className="block text-sm font-semibold text-slate-700 mb-1.5">
          Key <span className="text-red-500">*</span>
          {keyReadOnly && (
            <span className="ml-2 text-xs font-normal text-slate-400">(read-only)</span>
          )}
        </label>
        <input
          type="text"
          value={form.key}
          onChange={(e) => set({ key: e.target.value.toLowerCase().replace(/\s+/g, '-') })}
          readOnly={keyReadOnly}
          disabled={keyReadOnly}
          placeholder="e.g. entity-overview, audit-guide"
          className={`w-full h-10 px-3.5 rounded-xl border-2 text-sm font-mono text-slate-700 placeholder-slate-400 focus:outline-none transition-all ${
            keyReadOnly
              ? 'border-slate-200 bg-slate-50 text-slate-500 cursor-not-allowed'
              : 'border-slate-200 bg-white focus:border-emerald-500 focus:ring-4 focus:ring-emerald-500/10'
          }`}
        />
        {!keyReadOnly && (
          <p className="mt-1 text-xs text-slate-400">Unique identifier used to retrieve this article in code. Use lowercase with hyphens.</p>
        )}
      </div>

      {/* Title */}
      <div>
        <label className="block text-sm font-semibold text-slate-700 mb-1.5">
          Title <span className="text-red-500">*</span>
        </label>
        <input
          type="text"
          value={form.title}
          onChange={(e) => set({ title: e.target.value })}
          placeholder="e.g. Getting Started with Entities"
          className="ctl w-full"
        />
      </div>

      {/* Category + Sort Order */}
      <div className="grid grid-cols-2 gap-4">
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1.5">Category</label>
          <select
            value={form.category}
            onChange={(e) => set({ category: e.target.value })}
            className="ctl w-full"
          >
            {CATEGORIES.map((cat) => (
              <option key={cat} value={cat}>
                {getCategoryLabel(cat)}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-1.5">Sort Order</label>
          <input
            type="number"
            min={0}
            value={form.sortOrder}
            onChange={(e) => set({ sortOrder: parseInt(e.target.value) || 0 })}
            className="ctl w-full"
          />
        </div>
      </div>

      {/* Content */}
      <div>
        <label className="block text-sm font-semibold text-slate-700 mb-1.5">
          Content {!keyReadOnly && <span className="text-red-500">*</span>}
          <span className="ml-2 text-xs font-normal text-slate-400">Markdown supported</span>
        </label>
        <textarea
          value={form.content}
          onChange={(e) => set({ content: e.target.value })}
          placeholder={
            keyReadOnly
              ? 'Leave empty to keep existing content. Enter new content to update...'
              : 'Write article content here. Markdown formatting is supported...'
          }
          rows={8}
          className="ctl w-full font-mono resize-y"
        />
      </div>
    </div>
  );
}
