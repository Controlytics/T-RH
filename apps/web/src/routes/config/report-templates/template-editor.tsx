import { useEffect, useId, useMemo, useRef, useState, type DragEvent } from 'react';
import useSWR from 'swr';
import { ArrowDown, ArrowUp, GripVertical, Plus, Trash2, Upload } from 'lucide-react';
import {
  REPORT_TEMPLATE_FIELDS, REPORT_TEMPLATE_LOGO_MAX, TEMPLATE_KIND_SPECS,
  builtinReportTemplate, isPlaceholder, reportTemplateDocumentSchema,
  type Placeholder, type ReportField, type ReportLogoMode, type ReportTemplateDocument, type TemplateKind,
} from '@digilog/shared';
import { FormSection } from '@/components/ui/form-section';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Toggle } from '@/components/ui/toggle';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/cn';
import { columnsFromRows, decimalsAllowed, moveRow, rowsFromColumns, withCatalogue, type ColumnRow } from './column-rows';
import { TemplatePreview } from './template-preview';
import { reportTemplatesCatalogueUrl } from './types';

/**
 * The template EDITOR (spec §9; page kinds 2026-11-03, spec §10): the document
 * as form sections — Template, Header, Information rows, Columns, Footer, Page,
 * Notes — beside the live preview (sticky on a wide screen). One editor for
 * every template KIND, widget type or page report.
 *
 * The editor never decides what a profile can print: the Columns section is the
 * SERVER's catalogue (`GET /api/report-templates/catalogue`) merged with the
 * template's own columns (`column-rows.ts`). Until the catalogue arrives the
 * rows are the template's columns, labelled from the shared built-in fields;
 * once it arrives they are labelled from it and its other fields are offered,
 * hidden. A kind with NO fields (the text card, the floor plan, the Instrument
 * Trend) prints no table, so it has no Columns section at all; its catalogue's
 * `attr:` fields are offered as information rows only (ruling T3-C).
 *
 * The placeholder picker and the information-row sources are the KIND's own
 * placeholders (`TEMPLATE_KIND_SPECS[kind].placeholders`) — a name the kind's
 * download does not supply would print —.
 *
 * It validates nothing itself: Save hands the document to the page, which runs
 * the shared schema before anything is sent.
 */
export const PLACEHOLDER_LABELS: Record<Placeholder, string> = {
  dashboard: 'Dashboard',
  widget: 'Widget',
  profile: 'Instrument profile',
  from: 'From',
  to: 'To',
  period: 'Period',
  date: 'Date printed',
  // The USERNAME, as the footer's "Printed By" prints it (review m5): one
  // person, one identity on a record.
  user: 'Username',
  instrumentCount: 'Number of instruments',
  selection: 'Selection',
  // The page reports' (2026-11-03).
  instrument: 'Instrument ID',
  block: 'Block',
  area: 'Area',
  location: 'Location',
  fromDate: 'Start date',
  fromTime: 'Start time',
  toDate: 'End date',
  toTime: 'End time',
  interval: 'Interval',
  mkt: 'Mean kinetic temperature',
  tempLimit: 'Temperature limit',
  rhLimit: 'Humidity limit',
  extremes: 'Maximum and minimum',
  recordCount: 'Number of records',
  search: 'Search text',
  series: 'Series',
  level: 'Selection level',
};

const GROUP_WORDS: Record<ReportField['group'], string> = { builtin: 'Built-in', key: 'Key', attribute: 'Attribute' };
/** A column's group read off its id — for a column the catalogue no longer lists. */
const groupOfId = (id: string): ReportField['group'] => (id.startsWith('key:') ? 'key' : id.startsWith('attr:') ? 'attribute' : 'builtin');

interface InfoDraft { key: string; label: string; source: string }
interface Draft {
  name: string;
  isDefault: boolean;
  title: string;
  subtitle: string;
  companyName: string;
  appName: string;
  showAppName: boolean;
  logoMode: ReportLogoMode;
  /** Kept while the mode is switched away, so switching back does not lose the upload; written only for `custom`. */
  logoDataUrl?: string;
  accentColor?: string;
  info: InfoDraft[];
  columns: ColumnRow[];
  footerText: string;
  showPageNumbers: boolean;
  showPrintedBy: boolean;
  showPrintedAt: boolean;
  signatureLine: boolean;
  orientation: ReportTemplateDocument['page']['orientation'];
  typography: ReportTemplateDocument['page']['typography'];
  remarksLabel: string;
  legend: string;
}

let infoSeq = 0;
/**
 * An information row has no id of its own and can be MOVED, which
 * `useRowKeys` cannot follow (it tracks removals only), so each draft row
 * carries a client key — stripped by `documentFromDraft`, never sent.
 */
const infoKey = () => `info-${++infoSeq}`;

function draftFrom(name: string, isDefault: boolean, doc: ReportTemplateDocument, fields: readonly ReportField[] | undefined): Draft {
  const columns = rowsFromColumns(doc.columns);
  return {
    name,
    isDefault,
    title: doc.header.title,
    subtitle: doc.header.subtitle ?? '',
    companyName: doc.header.companyName ?? '',
    appName: doc.header.appName ?? '',
    showAppName: doc.header.showAppName,
    logoMode: doc.header.logo.mode,
    ...(doc.header.logo.dataUrl ? { logoDataUrl: doc.header.logo.dataUrl } : {}),
    ...(doc.header.accentColor ? { accentColor: doc.header.accentColor } : {}),
    info: doc.infoBlock.map((r) => ({ key: infoKey(), label: r.label, source: r.source })),
    columns: fields ? withCatalogue(columns, fields) : columns,
    footerText: doc.footer.text ?? '',
    showPageNumbers: doc.footer.showPageNumbers,
    showPrintedBy: doc.footer.showPrintedBy,
    showPrintedAt: doc.footer.showPrintedAt,
    signatureLine: doc.footer.signatureLine,
    orientation: doc.page.orientation,
    typography: doc.page.typography,
    remarksLabel: doc.notes.remarksLabel ?? '',
    legend: doc.notes.legend ?? '',
  };
}

/** Blank optional text is ABSENT in the document (= "use the configured value"), not an empty string. */
const opt = <K extends string>(key: K, value: string): Partial<Record<K, string>> =>
  (value.trim() === '' ? {} : { [key]: value } as Record<K, string>);

export function documentFromDraft(d: Draft, decimalsAllowedFor: (id: string) => boolean = () => true): ReportTemplateDocument {
  return {
    version: 1,
    header: {
      title: d.title,
      ...opt('subtitle', d.subtitle),
      ...opt('companyName', d.companyName),
      ...opt('appName', d.appName),
      showAppName: d.showAppName,
      // The image goes only with "Upload": an upload left behind by switching
      // to Branding or None is not stored.
      logo: d.logoMode === 'custom' ? { mode: 'custom', ...(d.logoDataUrl ? { dataUrl: d.logoDataUrl } : {}) } : { mode: d.logoMode },
      ...(d.accentColor ? { accentColor: d.accentColor } : {}),
    },
    infoBlock: d.info.map(({ label, source }) => ({ label, source })),
    columns: columnsFromRows(d.columns, decimalsAllowedFor),
    footer: {
      ...opt('text', d.footerText),
      showPageNumbers: d.showPageNumbers,
      showPrintedBy: d.showPrintedBy,
      showPrintedAt: d.showPrintedAt,
      signatureLine: d.signatureLine,
    },
    page: { orientation: d.orientation, typography: d.typography },
    notes: { ...opt('remarksLabel', d.remarksLabel), ...opt('legend', d.legend) },
  };
}

/**
 * The SHARED schema's verdict on a logo — its own message, never retyped here.
 * Checked against the kind's built-in document with only the logo replaced, so
 * the only issues it can raise are the logo's.
 */
export function logoProblem(kind: TemplateKind, dataUrl: string): string | null {
  const base = builtinReportTemplate(kind);
  const r = reportTemplateDocumentSchema.safeParse({ ...base, header: { ...base.header, logo: { mode: 'custom', dataUrl } } });
  if (r.success) return null;
  return r.error.issues.find((i) => i.path[0] === 'header' && i.path[1] === 'logo')?.message ?? r.error.issues[0]?.message ?? null;
}

/** A text box whose value is a template: a picker beside it inserts `{name}` — one of the kind's `names` — where the caret is. */
function TemplatedText({
  label, value, onChange, maxLength, names, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; maxLength: number; names: readonly Placeholder[]; placeholder?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  const id = useId();
  const insert = (name: string) => {
    const el = ref.current;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? start;
    const token = `{${name}}`;
    onChange(value.slice(0, start) + token + value.slice(end));
    const caret = start + token.length;
    requestAnimationFrame(() => {
      if (!ref.current) return;
      ref.current.focus();
      ref.current.setSelectionRange(caret, caret);
    });
  };
  return (
    <div className="space-y-1 md:col-span-2">
      <label className="block text-sm font-medium text-slate-700" htmlFor={id}>{label}</label>
      <div className="flex gap-2">
        <Input
          ref={ref}
          id={id}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
        <Select
          aria-label={`Insert into ${label}`}
          value=""
          className="w-40 shrink-0"
          onChange={(e) => { if (e.target.value) insert(e.target.value); }}
        >
          <option value="">Insert…</option>
          {names.map((p) => <option key={p} value={p}>{PLACEHOLDER_LABELS[p]}</option>)}
        </Select>
      </div>
    </div>
  );
}

function LabelledInput({
  label, value, onChange, maxLength, placeholder,
}: { label: string; value: string; onChange: (v: string) => void; maxLength: number; placeholder?: string }) {
  return (
    <label className="block space-y-1">
      <span className="block text-sm font-medium text-slate-700">{label}</span>
      <Input aria-label={label} value={value} maxLength={maxLength} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

const LOGO_MODES: { mode: ReportLogoMode; label: string }[] = [
  { mode: 'branding', label: 'Branding' },
  { mode: 'custom', label: 'Upload' },
  { mode: 'none', label: 'None' },
];

export interface TemplateEditorProps {
  mode: 'new' | 'edit';
  /** The profile, or null for an application-wide kind — then no request names one. */
  profileId: string | null;
  profileName: string | null;
  kind: TemplateKind;
  initialName: string;
  initialDefault: boolean;
  initialDocument: ReportTemplateDocument;
  saving: boolean;
  /** The page's refusal of the last Save; `onName` = it is the name's (a clash, a blank). */
  error: { message: string; onName: boolean } | null;
  onSave: (v: { name: string; isDefault: boolean; document: ReportTemplateDocument }) => void;
  onCancel: () => void;
}

export function TemplateEditor({
  mode, profileId, profileName, kind, initialName, initialDefault, initialDocument, saving, error, onSave, onCancel,
}: TemplateEditorProps) {
  const spec = TEMPLATE_KIND_SPECS[kind];
  const builtinFields = REPORT_TEMPLATE_FIELDS(kind);
  const { data: catalogue, error: catalogueError } = useSWR<{ fields: ReportField[] }>(reportTemplatesCatalogueUrl(kind, profileId));
  // The catalogue, or — only if it cannot be had — the shared built-ins, so the
  // editor still works; never fields derived from the profile here.
  // Shown exactly as served: which fields a kind may print — e.g. no keys or
  // attributes on a pie or an alarm-count report, attributes only on a page
  // report — is the catalogue's rule (review m1), never re-decided here.
  const fields = catalogue?.fields ?? (catalogueError ? builtinFields : undefined);
  // A kind with no fields prints no table: no Columns section (ruling T3-C).
  const hasColumns = builtinFields.length > 0;
  const [draft, setDraft] = useState<Draft>(() => draftFrom(initialName, initialDefault, initialDocument, hasColumns ? fields : undefined));
  const [logoError, setLogoError] = useState<string | null>(null);
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // The catalogue arriving after the editor opened: offer its fields, hidden.
  useEffect(() => {
    if (!fields || !hasColumns) return;
    setDraft((d) => {
      const merged = withCatalogue(d.columns, fields);
      return merged === d.columns ? d : { ...d, columns: merged };
    });
  }, [fields, hasColumns]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const fieldById = useMemo(() => {
    const m = new Map<string, ReportField>();
    for (const f of builtinFields) m.set(f.id, f);
    for (const f of fields ?? []) m.set(f.id, f);
    return m;
  }, [fields, builtinFields]);
  const ownDecimals = useMemo(
    () => (id: string) => decimalsAllowed(id, fieldById.get(id), fields !== undefined),
    [fieldById, fields],
  );
  const document = useMemo(() => documentFromDraft(draft, ownDecimals), [draft, ownDecimals]);

  // ── Columns ──
  const available = useMemo(() => (fields ? new Set(fields.map((f) => f.id)) : null), [fields]);
  /** A row's name on screen and to a screen reader — unique: two fields may share a label (a built-in Location and an attribute Location). */
  const nameOf = (row: ColumnRow): string => {
    const f = fieldById.get(row.id);
    const label = f?.label ?? row.id.replace(/^(key|attr):/, '');
    const clash = draft.columns.some((o) => o.id !== row.id && (fieldById.get(o.id)?.label ?? o.id) === label);
    return clash && f ? `${label} (${GROUP_WORDS[f.group].toLowerCase()})` : label;
  };
  const editColumn = (i: number, patch: Partial<ColumnRow>) =>
    setDraft((d) => ({ ...d, columns: d.columns.map((c, j) => (j === i ? { ...c, ...patch, keep: true } : c)) }));
  const moveColumn = (from: number, to: number) => setDraft((d) => ({ ...d, columns: moveRow(d.columns, from, to) }));
  const onDrop = (e: DragEvent, to: number) => {
    e.preventDefault();
    if (dragFrom !== null) moveColumn(dragFrom, to);
    setDragFrom(null);
  };

  // ── Information rows ──
  // The kind's own placeholders, then — for a kind that prints the profile's
  // fields — the catalogue's attributes.
  const names = spec.placeholders;
  const attributeFields = spec.profileFields !== 'none' ? (fields ?? []).filter((f) => f.group === 'attribute') : [];
  const sourceOptions = (current: string) => {
    const opts = [
      ...names.map((p) => ({ value: p as string, label: PLACEHOLDER_LABELS[p] })),
      ...attributeFields.map((f) => ({ value: f.id, label: `Attribute: ${f.label}` })),
    ];
    if (current && !opts.some((o) => o.value === current)) {
      const what = isPlaceholder(current) ? PLACEHOLDER_LABELS[current] : current.replace(/^attr:/, 'Attribute: ');
      opts.push({ value: current, label: `${what} (not available)` });
    }
    return opts;
  };
  const editInfo = (i: number, patch: Partial<InfoDraft>) =>
    setDraft((d) => ({ ...d, info: d.info.map((r, j) => (j === i ? { ...r, ...patch } : r)) }));

  // ── Logo ──
  const onLogoFile = (file: File | undefined) => {
    setLogoError(null);
    if (!file) return;
    // A data URL is always longer than the file it encodes, so a file over the
    // cap is refused before it is read — with the schema's own message.
    if (file.size > REPORT_TEMPLATE_LOGO_MAX) {
      setLogoError(logoProblem(kind, `data:image/png;base64,${'A'.repeat(REPORT_TEMPLATE_LOGO_MAX)}`));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result ?? '');
      const problem = logoProblem(kind, url);
      if (problem) { setLogoError(problem); return; }
      set('logoDataUrl', url);
    };
    reader.onerror = () => setLogoError('The file could not be read.');
    reader.readAsDataURL(file);
  };

  const shownCount = draft.columns.filter((c) => c.show).length;
  const typeLabel = spec.label;

  return (
    <section aria-label="Template editor" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-slate-200/70 bg-white px-5 py-3 shadow-[var(--elev-1)]">
        <div className="min-w-0">
          <h2 className="truncate text-[1.0625rem] font-semibold text-slate-900">
            {mode === 'new' ? 'New template' : `Edit “${initialName}”`}
          </h2>
          <p className="truncate text-sm text-slate-500">{profileName ?? 'Application-wide'} · {typeLabel}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" onClick={onCancel} disabled={saving}>Cancel</Button>
          <Button onClick={() => onSave({ name: draft.name, isDefault: draft.isDefault, document })} disabled={saving}>
            {saving ? 'Saving…' : 'Save template'}
          </Button>
        </div>
      </div>

      {error && (
        <p role="alert" className="rounded-[var(--radius-control)] border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
          {error.message}
        </p>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="min-w-0 space-y-6">
          <FormSection title="Template">
            <label className="block space-y-1">
              <span className="block text-sm font-medium text-slate-700">Name</span>
              <Input
                aria-label="Template name"
                aria-invalid={error?.onName ? true : undefined}
                value={draft.name}
                maxLength={80}
                onChange={(e) => set('name', e.target.value)}
              />
            </label>
            {mode === 'new' && (
              <div className="flex items-end pb-2">
                <Toggle label="Default template" checked={draft.isDefault} onChange={(e) => set('isDefault', e.target.checked)} />
              </div>
            )}
          </FormSection>

          <FormSection title="Header">
            <TemplatedText label="Title" value={draft.title} maxLength={200} names={names} onChange={(v) => set('title', v)} />
            <TemplatedText label="Subtitle" value={draft.subtitle} maxLength={300} names={names} onChange={(v) => set('subtitle', v)} />
            <LabelledInput label="Company name" value={draft.companyName} maxLength={120} placeholder="As configured" onChange={(v) => set('companyName', v)} />
            <LabelledInput label="Application name" value={draft.appName} maxLength={120} placeholder="As configured" onChange={(v) => set('appName', v)} />
            <Toggle label="Show application name" checked={draft.showAppName} onChange={(e) => set('showAppName', e.target.checked)} />
            <div className="flex flex-wrap items-center gap-3">
              <Toggle
                label="Own accent colour"
                checked={!!draft.accentColor}
                onChange={(e) => set('accentColor', e.target.checked ? (draft.accentColor ?? '#1e40af') : undefined)}
              />
              {draft.accentColor && (
                <input
                  type="color"
                  aria-label="Accent colour"
                  value={draft.accentColor}
                  onChange={(e) => set('accentColor', e.target.value)}
                  className="h-9 w-14 cursor-pointer rounded-[var(--radius-control)] border border-slate-300 bg-white p-1"
                />
              )}
            </div>
            <div className="space-y-2 md:col-span-2">
              <span id="logo-mode-label" className="block text-sm font-medium text-slate-700">Logo</span>
              <div role="radiogroup" aria-labelledby="logo-mode-label" className="seg">
                {LOGO_MODES.map((m) => (
                  <label
                    key={m.mode}
                    className="seg-btn cursor-pointer has-[:checked]:bg-white has-[:checked]:text-slate-900 has-[:checked]:shadow-[var(--elev-1)] has-[:focus-visible]:outline has-[:focus-visible]:outline-2"
                  >
                    <input
                      type="radio"
                      name="logo-mode"
                      className="sr-only"
                      checked={draft.logoMode === m.mode}
                      onChange={() => { set('logoMode', m.mode); setLogoError(null); }}
                    />
                    {m.label}
                  </label>
                ))}
              </div>
              {draft.logoMode === 'custom' && (
                <div className="flex flex-wrap items-center gap-3">
                  <input
                    ref={fileRef}
                    type="file"
                    accept="image/png,image/jpeg"
                    aria-label="Upload logo"
                    className="sr-only"
                    onChange={(e) => { onLogoFile(e.target.files?.[0]); e.target.value = ''; }}
                  />
                  <Button type="button" variant="outline" size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => fileRef.current?.click()}>
                    {draft.logoDataUrl ? 'Replace image' : 'Choose image'}
                  </Button>
                  {draft.logoDataUrl && (
                    <img src={draft.logoDataUrl} alt="Template logo" className="h-10 max-w-[10rem] rounded border border-slate-200 bg-white object-contain p-1" />
                  )}
                  <span className="text-xs text-slate-500">PNG or JPEG</span>
                </div>
              )}
              {logoError && <p data-testid="logo-error" className="text-sm text-rose-700">{logoError}</p>}
            </div>
          </FormSection>

          <FormSection
            title="Information rows"
            columns={1}
            actions={(
              <Button
                type="button"
                size="sm"
                variant="secondary"
                icon={<Plus className="h-4 w-4" />}
                disabled={draft.info.length >= 20}
                // A new row starts on the kind's first placeholder — one its download supplies.
                onClick={() => set('info', [...draft.info, { key: infoKey(), label: '', source: names[0] ?? 'date' }])}
              >
                Add row
              </Button>
            )}
          >
            {draft.info.length === 0 ? (
              <p className="text-sm text-slate-500">No information rows.</p>
            ) : (
              <ol className="space-y-2">
                {draft.info.map((r, i) => (
                  <li key={r.key} className="grid items-center gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
                    <Input aria-label={`Label of information row ${i + 1}`} value={r.label} maxLength={60} placeholder="Label" onChange={(e) => editInfo(i, { label: e.target.value })} />
                    <Select aria-label={`Value of information row ${i + 1}`} value={r.source} onChange={(e) => editInfo(i, { source: e.target.value })}>
                      {sourceOptions(r.source).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </Select>
                    <div className="flex gap-1">
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move information row ${i + 1} up`} disabled={i === 0} onClick={() => set('info', moveRow(draft.info, i, i - 1))}><ArrowUp className="h-4 w-4" /></Button>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move information row ${i + 1} down`} disabled={i === draft.info.length - 1} onClick={() => set('info', moveRow(draft.info, i, i + 1))}><ArrowDown className="h-4 w-4" /></Button>
                      <Button type="button" size="icon-sm" variant="ghost" aria-label={`Remove information row ${i + 1}`} onClick={() => set('info', draft.info.filter((_, j) => j !== i))}><Trash2 className="h-4 w-4" /></Button>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </FormSection>

          {hasColumns && (
            <FormSection
              title="Columns"
              columns={1}
              actions={<span className="text-xs text-white/85">{shownCount} shown</span>}
            >
              <ol className="space-y-2">
                {draft.columns.map((row, i) => {
                  const f = fieldById.get(row.id);
                  const name = nameOf(row);
                  const missing = available !== null && !available.has(row.id);
                  const isNumber = f?.kind === 'number';
                  // Decimals only on a raw key: every other number prints the
                  // server's display precision as it stands (review C1).
                  const hasDecimals = isNumber && ownDecimals(row.id);
                  return (
                    <li
                      key={row.id}
                      data-testid={`column-row-${row.id}`}
                      draggable
                      onDragStart={() => setDragFrom(i)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => onDrop(e, i)}
                      onDragEnd={() => setDragFrom(null)}
                      className={cn(
                        'space-y-2 rounded-[var(--radius-control)] border px-3 py-2.5',
                        row.show ? 'border-slate-200 bg-white' : 'border-slate-200 bg-slate-50',
                        dragFrom === i && 'opacity-50',
                      )}
                    >
                      <div className="flex items-center gap-2">
                        <GripVertical aria-hidden className="h-4 w-4 shrink-0 cursor-grab text-slate-400" />
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-semibold text-slate-800" title={name}>{name}</span>
                          <span className="block truncate text-xs text-slate-500">
                            {GROUP_WORDS[f?.group ?? groupOfId(row.id)]}
                            {f?.unit ? ` · ${f.unit}` : ''}
                            {f?.measured ? ' · measured' : ''}
                          </span>
                        </div>
                        {missing && (
                          <span className="shrink-0 rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[0.6875rem] font-semibold text-amber-800">
                            Not available for this profile
                          </span>
                        )}
                        <Toggle aria-label={`Show ${name}`} checked={row.show} onChange={(e) => editColumn(i, { show: e.target.checked })} />
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${name} up`} disabled={i === 0} onClick={() => moveColumn(i, i - 1)}><ArrowUp className="h-4 w-4" /></Button>
                        <Button type="button" size="icon-sm" variant="ghost" aria-label={`Move ${name} down`} disabled={i === draft.columns.length - 1} onClick={() => moveColumn(i, i + 1)}><ArrowDown className="h-4 w-4" /></Button>
                      </div>
                      <div className={cn('grid gap-2', hasDecimals ? 'sm:grid-cols-[minmax(0,1fr)_7rem_6.5rem]' : isNumber && 'sm:grid-cols-[minmax(0,1fr)_6.5rem]')}>
                        <Input aria-label={`Heading for ${name}`} value={row.heading} maxLength={80} placeholder="Heading" onChange={(e) => editColumn(i, { heading: e.target.value })} />
                        {hasDecimals && (
                          <Input
                            type="number"
                            min={0}
                            max={6}
                            aria-label={`Decimals for ${name}`}
                            placeholder="Decimals"
                            value={row.decimals ?? ''}
                            onChange={(e) => editColumn(i, { decimals: e.target.value === '' ? undefined : Math.max(0, Math.min(6, Math.trunc(Number(e.target.value)))) })}
                          />
                        )}
                        {isNumber && (
                          <Input
                            aria-label={`Unit for ${name}`}
                            placeholder={f?.unit ?? 'Unit'}
                            maxLength={16}
                            value={row.unit ?? ''}
                            onChange={(e) => editColumn(i, { unit: e.target.value === '' ? undefined : e.target.value })}
                          />
                        )}
                      </div>
                    </li>
                  );
                })}
              </ol>
            </FormSection>
          )}

          <FormSection title="Footer">
            <TemplatedText label="Footer text" value={draft.footerText} maxLength={300} names={names} onChange={(v) => set('footerText', v)} />
            <Toggle label="Page numbers" checked={draft.showPageNumbers} onChange={(e) => set('showPageNumbers', e.target.checked)} />
            <Toggle label="Printed by" checked={draft.showPrintedBy} onChange={(e) => set('showPrintedBy', e.target.checked)} />
            <Toggle label="Printed at" checked={draft.showPrintedAt} onChange={(e) => set('showPrintedAt', e.target.checked)} />
            <Toggle label="Signature line" checked={draft.signatureLine} onChange={(e) => set('signatureLine', e.target.checked)} />
          </FormSection>

          <FormSection title="Page">
            <label className="block space-y-1">
              <span className="block text-sm font-medium text-slate-700">Orientation</span>
              <Select aria-label="Orientation" value={draft.orientation} onChange={(e) => set('orientation', e.target.value as Draft['orientation'])}>
                <option value="portrait">Portrait</option>
                <option value="landscape">Landscape</option>
              </Select>
            </label>
            <label className="block space-y-1">
              <span className="block text-sm font-medium text-slate-700">Type size</span>
              <Select aria-label="Type size" value={draft.typography} onChange={(e) => set('typography', e.target.value as Draft['typography'])}>
                <option value="default">Standard</option>
                <option value="data-report">As the Data Report</option>
              </Select>
            </label>
          </FormSection>

          <FormSection title="Notes" columns={1}>
            <LabelledInput label="Remarks label" value={draft.remarksLabel} maxLength={60} placeholder="Remarks" onChange={(v) => set('remarksLabel', v)} />
            <label className="block space-y-1">
              <span className="block text-sm font-medium text-slate-700">Legend</span>
              <textarea
                aria-label="Legend"
                rows={3}
                maxLength={1000}
                value={draft.legend}
                onChange={(e) => set('legend', e.target.value)}
                className="ctl w-full"
              />
            </label>
          </FormSection>
        </div>

        <div className="min-w-0 lg:sticky lg:top-0">
          <TemplatePreview kind={kind} profileId={profileId} profileName={profileName} document={document} fields={fields} />
        </div>
      </div>
    </section>
  );
}
