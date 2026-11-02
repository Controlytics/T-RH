import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import useSWR from 'swr';
import { FileText } from 'lucide-react';
import {
  WIDGET_REPORT_FIELDS, WIDGET_TYPES, WIDGET_TYPE_SPECS, builtinReportTemplate, coerceReportTemplateDocument,
  reportTemplateCreateSchema, reportTemplateUpdateSchema, REPORT_TEMPLATE_NAME_MAX,
  type ReportTemplateDocument, type WidgetType,
} from '@digilog/shared';
import { PageHero } from '@/components/ui/page-hero';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { Tabs, TabPanel } from '@/components/ui/tabs';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { EmptyState } from '@/components/ui/empty-state';
import { ReauthDialog } from '@/components/reauth-dialog';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { useReauth, reauthActionLabel } from '@/hooks/use-reauth';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { TemplateList } from './report-templates/template-list';
import { TemplateEditor } from './report-templates/template-editor';
import {
  reportTemplatesListUrl, type ReportTemplateProfile, type ReportTemplateRow,
} from './report-templates/types';

/**
 * CONFIGURATION → REPORT TEMPLATES (2026-11-02, spec §9).
 *
 * What a dashboard widget's "Download report" prints, per instrument PROFILE,
 * per widget TYPE: any number of named templates, one default. The profile
 * picker rides in the band; the 14 widget types are tabs; each tab lists the
 * server's templates; "+ New template" starts from the shared built-in. The
 * editor replaces the list while it is open, beside a live preview.
 *
 * Every write — create, update, set default, delete — is SUPER_ADMIN only on
 * the server (by role) and signed under `UPDATE_REPORT_TEMPLATE` through the
 * shared re-auth hook, which asks for a password exactly when the server's
 * policy does. Every body is checked by the SHARED schema before it is sent,
 * so a refusal reads as the schema's sentence instead of a bare 400.
 *
 * The URL holds the selection (`?profileId=&widgetType=`), so a widget's
 * download dialog and the Instrument Attributes page can open a profile's tab
 * directly.
 */
const ACTION = 'UPDATE_REPORT_TEMPLATE';

type EditorState =
  | { mode: 'new'; name: string; isDefault: boolean; document: ReportTemplateDocument }
  | { mode: 'edit'; row: ReportTemplateRow; name: string; isDefault: boolean; document: ReportTemplateDocument };

const isWidgetType = (v: string | null): v is WidgetType => !!v && (WIDGET_TYPES as readonly string[]).includes(v);
const message = (e: unknown, fallback: string) => (e as { message?: string })?.message || fallback;

/**
 * The schema's sentence, plus WHICH column or information row it is about —
 * "A column needs a heading" alone sends the admin hunting through forty rows.
 */
export function describeIssue(
  issue: { message: string; path: (string | number)[] } | undefined,
  document: ReportTemplateDocument,
  labelOf: (fieldId: string) => string,
): string {
  if (!issue) return 'The template is not valid.';
  const [top, list, n] = issue.path;
  if (top === 'document' && list === 'columns' && typeof n === 'number') {
    const c = document.columns[n];
    const name = c ? (c.heading.trim() || labelOf(c.id)) : `${n + 1}`;
    return `${issue.message} — column “${name}”`;
  }
  if (top === 'document' && list === 'infoBlock' && typeof n === 'number') return `${issue.message} — information row ${n + 1}`;
  return issue.message;
}

export function ReportTemplatesConfigPage() {
  const { toast } = useToast();
  const reauth = useReauth();
  const { formatDateTime } = useDatetimeFormat();
  const [params, setParams] = useSearchParams();
  const { data: profileList, isLoading: profilesLoading } = useSWR<{ data: ReportTemplateProfile[] }>('/api/instrument-profiles');
  const profiles = profileList?.data ?? [];

  const wanted = params.get('profileId');
  const profile = profiles.find((p) => p.id === wanted) ?? profiles[0] ?? null;
  const rawType = params.get('widgetType');
  const widgetType: WidgetType = isWidgetType(rawType) ? rawType : WIDGET_TYPES[0];
  const typeLabel = WIDGET_TYPE_SPECS[widgetType].label;

  const listUrl = profile ? reportTemplatesListUrl(profile.id, widgetType) : null;
  const { data: list, isLoading: listLoading, mutate } = useSWR<{ data: ReportTemplateRow[] }>(listUrl);
  const rows = list?.data ?? [];

  const [editor, setEditor] = useState<EditorState | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<{ message: string; onName: boolean } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<ReportTemplateRow | null>(null);

  const select = (profileId: string, type: WidgetType) =>
    setParams((p) => {
      const next = new URLSearchParams(p);
      next.set('profileId', profileId);
      next.set('widgetType', type);
      return next;
    }, { replace: true });

  const open = (state: EditorState) => { setSaveError(null); setEditor(state); };
  const noDefault = !rows.some((r) => r.isDefault);
  const openNew = () => open({ mode: 'new', name: '', isDefault: noDefault, document: builtinReportTemplate(widgetType) });
  const openEdit = (row: ReportTemplateRow) =>
    open({ mode: 'edit', row, name: row.name, isDefault: row.isDefault, document: coerceReportTemplateDocument(row.document, widgetType) });
  const openDuplicate = (row: ReportTemplateRow) =>
    open({
      mode: 'new',
      name: `${row.name} (copy)`.slice(0, REPORT_TEMPLATE_NAME_MAX),
      isDefault: false,
      document: coerceReportTemplateDocument(row.document, widgetType),
    });

  const save = (v: { name: string; isDefault: boolean; document: ReportTemplateDocument }) => {
    if (!editor || !profile) return;
    const parsed = editor.mode === 'new'
      ? reportTemplateCreateSchema.safeParse({ profileId: profile.id, widgetType, name: v.name, isDefault: v.isDefault, document: v.document })
      : reportTemplateUpdateSchema.safeParse({ name: v.name, document: v.document });
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const labelOf = (id: string) => WIDGET_REPORT_FIELDS[widgetType].find((f) => f.id === id)?.label ?? id.replace(/^(key|attr):/, '');
      setSaveError({ message: describeIssue(issue, v.document, labelOf), onName: issue?.path[0] === 'name' });
      return;
    }
    const body = parsed.data as Record<string, unknown>;
    const url = editor.mode === 'new' ? '/api/report-templates' : `/api/report-templates/${editor.row.id}`;
    setSaving(true);
    setSaveError(null);
    void reauth.execute(ACTION, async (password?: string) => {
      if (editor.mode === 'new') {
        if (password) await apiClient.postWithReauth(url, body, password);
        else await apiClient.post(url, body);
      } else if (password) await apiClient.putWithReauth(url, body, password);
      else await apiClient.put(url, body);
    }, {
      onSuccess: () => {
        setSaving(false);
        setEditor(null);
        void mutate();
        toast.success('Template saved', `“${v.name.trim()}” — ${profile.name} · ${typeLabel}.`);
      },
      onError: (e) => {
        setSaving(false);
        const code = (e as { code?: string })?.code;
        setSaveError({ message: message(e, 'The template could not be saved.'), onName: code === 'TEMPLATE_NAME_IN_USE' });
      },
      // A cancel is not an error: nothing was sent, the draft stays as it was.
      onCancel: () => setSaving(false),
    });
  };

  const setDefault = (row: ReportTemplateRow) => {
    const url = `/api/report-templates/${row.id}/default`;
    void reauth.execute(ACTION, async (password?: string) => {
      if (password) await apiClient.putWithReauth(url, {}, password);
      else await apiClient.put(url, {});
    }, {
      onSuccess: () => { void mutate(); toast.success('Default template', `${typeLabel} downloads for ${profile?.name ?? 'this profile'} now use “${row.name}”.`); },
      onError: (e) => toast.error('Could not set the default', message(e, 'Nothing was changed.')),
      onCancel: () => {},
    });
  };

  const remove = (row: ReportTemplateRow) => {
    // Closed FIRST, so the password prompt never stacks on the confirm.
    setConfirmDelete(null);
    const url = `/api/report-templates/${row.id}`;
    void reauth.execute(ACTION, async (password?: string) => {
      if (password) await apiClient.deleteWithReauth(url, password);
      else await apiClient.delete(url);
    }, {
      onSuccess: () => { void mutate(); toast.success('Template deleted', `“${row.name}” was deleted.`); },
      onError: (e) => toast.error('Could not delete the template', message(e, 'Nothing was deleted.')),
      onCancel: () => {},
    });
  };

  return (
    <div className="space-y-6">
      <PageHero
        title="Report Templates"
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Report Templates' }]}
        icon={<FileText className="h-5 w-5" strokeWidth={1.75} />}
      >
        <label className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <span className="text-sm font-semibold text-white">Instrument profile</span>
          <SearchableSelect
            className="w-full sm:w-80"
            value={profile?.id ?? ''}
            onChange={(id) => select(id, widgetType)}
            options={profiles.map((p) => ({ value: p.id, label: p.name }))}
            placeholder={profilesLoading ? 'Loading…' : 'No profiles'}
            searchPlaceholder="Search profiles…"
            disabled={!!editor || profiles.length === 0}
          />
        </label>
      </PageHero>

      {!profile ? (
        profilesLoading ? null : (
          <EmptyState
            title="No instrument profiles"
            description="Templates are made per instrument profile."
            action={<Link className="text-sm font-semibold text-[var(--theme-primary,#2a78d6)] hover:underline" to="/instruments">Instrument profiles</Link>}
          />
        )
      ) : editor ? (
        <TemplateEditor
          // A new editor for a new target, never a stale draft carried across.
          key={editor.mode === 'edit' ? editor.row.id : `new-${editor.name}`}
          mode={editor.mode}
          profileId={profile.id}
          profileName={profile.name}
          widgetType={widgetType}
          initialName={editor.name}
          initialDefault={editor.isDefault}
          initialDocument={editor.document}
          saving={saving}
          error={saveError}
          onSave={save}
          onCancel={() => { setEditor(null); setSaveError(null); }}
        />
      ) : (
        <div className="space-y-4 rounded-[var(--radius-card)] border border-slate-200/70 bg-white p-4 shadow-[var(--elev-1)]">
          <Tabs
            idPrefix="report-templates"
            variant="segmented"
            className="flex w-full flex-wrap"
            aria-label="Widget type"
            tabs={WIDGET_TYPES.map((t) => ({ id: t, label: WIDGET_TYPE_SPECS[t].label }))}
            active={widgetType}
            onChange={(t) => select(profile.id, t)}
          />
          <TabPanel id={widgetType} idPrefix="report-templates">
            <TemplateList
              rows={rows}
              loading={listLoading}
              typeLabel={typeLabel}
              formatDateTime={formatDateTime}
              onNew={openNew}
              onEdit={openEdit}
              onDuplicate={openDuplicate}
              onSetDefault={setDefault}
              onDelete={(r) => setConfirmDelete(r)}
            />
          </TabPanel>
        </div>
      )}

      <ConfirmDialog
        open={!!confirmDelete}
        title={`Delete “${confirmDelete?.name ?? ''}”`}
        message={`The template is deleted from ${profile?.name ?? 'this profile'} · ${typeLabel}.`}
        warning={confirmDelete?.isDefault
          ? `It is the default: after it is deleted, the built-in template will be used for ${typeLabel} downloads until another template is set as the default.`
          : undefined}
        confirmLabel="Delete template"
        onConfirm={() => { if (confirmDelete) remove(confirmDelete); }}
        onClose={() => setConfirmDelete(null)}
      />

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel={reauthActionLabel(reauth.action)}
      />
    </div>
  );
}
