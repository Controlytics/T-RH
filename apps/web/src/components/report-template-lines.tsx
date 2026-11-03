/**
 * What a report will be printed with (2026-11-02 in the widget dialog;
 * extracted 2026-11-03 for every download dialog — widget, Data Report, trend
 * page, Alarms, Audit — spec
 * docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md §8):
 * per section the template the SERVER resolved, or the one picked —
 * "Template: <name> (<profile>)", "Template: <name> (application-wide)", or
 * "Template: Built-in …" when the scope has no default — a picker when the
 * scope has more than one template, and for a SUPER_ADMIN the way to the
 * editor. Presentation only: the plan is `useReportTemplatePlan`'s, the
 * choice `chooseTemplate`'s, the same two the builder's caller uses.
 */
import { Link } from 'react-router-dom';
import type { TemplateKind } from '@digilog/shared';
import { BUILTIN_TEMPLATE_PICK, chooseTemplate, planScopeKey, type PlanSection } from '@/lib/report-template-plan';

/** The name a section's line prints when it uses no saved template. */
const BUILTIN_NAME = 'Built-in';

export interface ReportTemplateLinesProps {
  kind: TemplateKind;
  /** `useReportTemplatePlan(...).sections`. */
  sections: readonly PlanSection[];
  /** Template id picked per scope key (`planScopeKey`), or `BUILTIN_TEMPLATE_PICK`. */
  picks: Readonly<Record<string, string>>;
  onPick: (scopeKey: string, templateId: string) => void;
  loading: boolean;
  failed: boolean;
  superAdmin: boolean;
  /**
   * The report is ONE section whatever its instruments' profiles (a widget
   * whose rows name no single instrument): one line, the FIRST profile's
   * template, named for every profile it covers; with no profile at all, the
   * built-in.
   */
  oneSection?: boolean;
}

export function ReportTemplateLines({ kind, sections, picks, onPick, loading, failed, superAdmin, oneSection = false }: ReportTemplateLinesProps) {
  if (failed) {
    return <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">The report templates could not be loaded.</p>;
  }
  if (loading) return <p className="text-sm text-slate-500">Loading the report templates…</p>;
  if (!oneSection && sections.length === 0) {
    return <p className="text-sm text-slate-600" data-testid="report-template-line">No instruments in this selection — the report says so.</p>;
  }
  const lines: { section: PlanSection | null; scope: string }[] = oneSection
    ? [{ section: sections[0] ?? null, scope: sections.map((s) => s.profileName ?? '').filter((n) => n !== '').join(', ') }]
    : sections.map((s) => ({ section: s, scope: s.profileId === null ? 'application-wide' : s.profileName ?? '' }));
  return (
    <ul className="space-y-2" aria-label="Report templates">
      {lines.map(({ section: s, scope }) => {
        const key = s ? planScopeKey(s) : 'none';
        const chosen = s ? chooseTemplate(s, picks[key]) : null;
        const name = chosen ? chosen.name : BUILTIN_NAME;
        const application = s?.profileId === null;
        return (
          <li key={key} className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2">
            <p className="text-sm font-medium text-slate-800" data-testid="report-template-line">
              {scope ? `Template: ${name} (${scope})` : `Template: ${name}`}
            </p>
            {s && s.templates.length > 1 && (
              <select
                aria-label={application ? 'Template (application-wide)' : `Template for ${s.profileName ?? ''}`}
                className="ctl ctl-sm mt-1.5 w-full"
                value={picks[key] ?? s.resolved?.id ?? BUILTIN_TEMPLATE_PICK}
                onChange={(e) => onPick(key, e.target.value)}
              >
                {s.templates.map((t) => (
                  <option key={t.id} value={t.id}>{t.isDefault ? `${t.name} (default)` : t.name}</option>
                ))}
                <option value={BUILTIN_TEMPLATE_PICK}>{BUILTIN_NAME}</option>
              </select>
            )}
            {superAdmin && s && (
              <Link
                to={`/config/report-templates?${new URLSearchParams({ kind, ...(s.profileId !== null ? { profileId: s.profileId } : {}) }).toString()}`}
                className="mt-1 inline-block text-xs font-semibold text-[var(--theme-primary)] hover:underline"
              >
                {application ? 'Edit the application-wide report templates' : `Edit report templates for ${s.profileName ?? ''}`}
              </Link>
            )}
          </li>
        );
      })}
    </ul>
  );
}
