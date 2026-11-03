/**
 * WHICH TEMPLATE a report will be printed with (2026-11-03, page reports on
 * templates — spec docs/superpowers/specs/2026-11-03-page-reports-on-templates-design.md
 * §8): the SERVER's answer, shown in every download dialog (widget, Data
 * Report, trend page, Alarms, Audit) by `components/report-template-lines.tsx`
 * and used by the builder. Generalised from the widget dialog's
 * `useWidgetReportPlan` (2026-11-02): nothing here decides a template.
 *
 * - A PROFILE kind (every widget type, `page:data-report`, `page:trend`,
 *   `page:instrument-alarms`): `GET /api/report-templates/resolve?kind=…
 *   &instrumentIds=…` in runs of `REPORT_TEMPLATE_RESOLVE_IDS_MAX`, merged by
 *   profile — one section per profile with its visible instruments and its
 *   default (or null = the built-in); then per profile its templates (the
 *   picker) and its field catalogue. No instruments = no request, no section.
 * - An APPLICATION kind (`page:alarms`, `page:audit-trail`): ONE `GET
 *   /resolve?kind=` with no ids (the server refuses ids there), answered with
 *   one section `{ profileId: null, … }`; then the kind's templates `GET
 *   /?kind=` with no profile; the available ids are the kind's built-ins.
 *
 * Every request names the KIND (`kind=`); `widgetType=` is gone from the wire.
 *
 * On the dashboard's main bundle: never import `pdf-report` / `templated-report`
 * / `widget-report` here for a value (they carry jsPDF).
 */
import useSWR from 'swr';
import {
  REPORT_TEMPLATE_FIELDS, REPORT_TEMPLATE_RESOLVE_IDS_MAX, templateKindScope, templateKindTakesProfileFields,
  type ReportField, type ReportTemplateRow, type TemplateKind,
} from '@digilog/shared';
import { apiClient } from './api-client';

/** The picker's value for "print with the built-in template". */
export const BUILTIN_TEMPLATE_PICK = '__builtin__';

/** The scope key of an application-wide kind's one section. */
export const APPLICATION_SCOPE_KEY = 'application';

export interface PlanSection {
  /** The profile, or null for an application-wide kind's one section. */
  profileId: string | null;
  profileName: string | null;
  /** The instruments of this profile that the viewer can see, in the order asked. `[]` for an application kind. */
  instrumentIds: string[];
  /** The server's resolution: the scope's default template for the kind, or null = the built-in. */
  resolved: ReportTemplateRow | null;
  /** Every template this scope has for the kind (the picker). */
  templates: ReportTemplateRow[];
  /** The field ids this section can fill: the profile's catalogue, or an application kind's built-ins. */
  availableIds: string[];
}

/** What a section is keyed by in a dialog's picks: its profile id, or `'application'`. */
export function planScopeKey(section: Pick<PlanSection, 'profileId'>): string {
  return section.profileId ?? APPLICATION_SCOPE_KEY;
}

const query = (params: Record<string, string>) => new URLSearchParams(params).toString();

/** The kind's templates in one scope: a profile's, or (null) the application-wide set. The ONE builder of this URL. */
export function reportTemplatesListUrl(kind: TemplateKind, profileId: string | null): string {
  return `/api/report-templates?${query({ kind, ...(profileId !== null ? { profileId } : {}) })}`;
}

/** The fields a template of the kind can print for a profile (or, null, an application kind's built-ins). */
export function reportTemplatesCatalogueUrl(kind: TemplateKind, profileId: string | null): string {
  return `/api/report-templates/catalogue?${query({ kind, ...(profileId !== null ? { profileId } : {}) })}`;
}

/** Which template each profile of these instruments uses — or, with no ids, the application-wide kind's one default. */
export function reportTemplatesResolveUrl(kind: TemplateKind, instrumentIds?: readonly string[]): string {
  return `/api/report-templates/resolve?${query({ kind, ...(instrumentIds ? { instrumentIds: instrumentIds.join(',') } : {}) })}`;
}

/** The template a section prints with: the one picked, else the server's resolution; the built-in pick (or none) = null. */
export function chooseTemplate(section: Pick<PlanSection, 'resolved' | 'templates'>, pickId: string | undefined): ReportTemplateRow | null {
  if (pickId === BUILTIN_TEMPLATE_PICK) return null;
  return section.templates.find((t) => t.id === pickId) ?? section.resolved;
}

interface ResolvedSection { profileId: string | null; profileName: string | null; instrumentIds: string[]; template: ReportTemplateRow | null }

async function resolveSections(kind: TemplateKind, ids: readonly string[]): Promise<ResolvedSection[]> {
  if (templateKindScope(kind) === 'application') {
    const { sections } = await apiClient.get<{ sections: ResolvedSection[] }>(reportTemplatesResolveUrl(kind));
    return (sections ?? []).map((s) => ({ ...s, instrumentIds: [...(s.instrumentIds ?? [])] }));
  }
  const merged = new Map<string, ResolvedSection>();
  // The route takes at most REPORT_TEMPLATE_RESOLVE_IDS_MAX ids: a selection of
  // ~320 is asked in runs and merged (ruling R11), never cut.
  for (let k = 0; k < ids.length; k += REPORT_TEMPLATE_RESOLVE_IDS_MAX) {
    const { sections } = await apiClient.get<{ sections: ResolvedSection[] }>(
      reportTemplatesResolveUrl(kind, ids.slice(k, k + REPORT_TEMPLATE_RESOLVE_IDS_MAX)),
    );
    for (const s of sections ?? []) {
      const key = planScopeKey(s);
      const held = merged.get(key);
      if (held) held.instrumentIds.push(...s.instrumentIds);
      else merged.set(key, { ...s, instrumentIds: [...s.instrumentIds] });
    }
  }
  return [...merged.values()];
}

/**
 * Whether a profile's catalogue can name anything for the kind: built-in
 * fields, or profile fields (`attr:` on the per-profile page kinds, `key:` /
 * `attr:` on the widget types). A widget with neither (text card, floor plan)
 * asks none — as before; `page:trend` has no fields but takes `attr:` info
 * rows, so it asks (ruling: the brief's "fields only" rule would have named
 * every attribute row on a trend template "Not available").
 */
function asksCatalogue(kind: TemplateKind): boolean {
  return REPORT_TEMPLATE_FIELDS(kind).length > 0 || templateKindTakesProfileFields(kind) !== 'none';
}

async function scopeDetails(kind: TemplateKind, scopes: readonly (string | null)[]) {
  const builtins = REPORT_TEMPLATE_FIELDS(kind).map((f) => f.id);
  return Promise.all(scopes.map(async (profileId) => {
    const catalogue = profileId !== null && asksCatalogue(kind);
    const [list, fields] = await Promise.all([
      apiClient.get<{ data: ReportTemplateRow[] }>(reportTemplatesListUrl(kind, profileId)),
      catalogue ? apiClient.get<{ fields: ReportField[] }>(reportTemplatesCatalogueUrl(kind, profileId)) : Promise.resolve(null),
    ]);
    return {
      scopeKey: profileId ?? APPLICATION_SCOPE_KEY,
      templates: list.data ?? [],
      // An application kind has no profile to ask: its built-ins are what it can fill.
      availableIds: fields ? (fields.fields ?? []).map((f) => f.id) : profileId === null ? builtins : [],
    };
  }));
}

/**
 * Which template each section of a report of `kind` uses — the server's
 * answer — with each scope's templates (the picker) and catalogue.
 * `enabled: false` asks nothing (the caller is still learning its ids).
 * `instrumentIds` is ignored for an application kind.
 */
export function useReportTemplatePlan(
  kind: TemplateKind,
  instrumentIds: readonly string[],
  opts: { enabled?: boolean } = {},
): { sections: PlanSection[]; loading: boolean; error: unknown } {
  const application = templateKindScope(kind) === 'application';
  const asked = (opts.enabled ?? true) && (application || instrumentIds.length > 0);
  const idsKey = application ? '' : instrumentIds.join(',');
  const resolved = useSWR<ResolvedSection[]>(
    asked ? ['report-template-resolve', kind, idsKey] : null,
    () => resolveSections(kind, application ? [] : instrumentIds),
    { revalidateOnFocus: false },
  );
  const scopes = (resolved.data ?? []).map((s) => s.profileId);
  const scopesKey = scopes.map((p) => p ?? APPLICATION_SCOPE_KEY).join(',');
  const details = useSWR(
    scopes.length > 0 ? ['report-template-details', kind, scopesKey] : null,
    () => scopeDetails(kind, scopes),
    { revalidateOnFocus: false },
  );
  const sections: PlanSection[] = (resolved.data ?? []).map((s) => {
    const d = details.data?.find((x) => x.scopeKey === planScopeKey(s));
    return {
      profileId: s.profileId,
      profileName: s.profileName,
      instrumentIds: s.instrumentIds,
      resolved: s.template,
      templates: d?.templates ?? [],
      availableIds: d?.availableIds ?? [],
    };
  });
  const loading = (asked && resolved.data === undefined && !resolved.error)
    || (scopes.length > 0 && details.data === undefined && !details.error);
  return { sections, loading, error: resolved.error ?? details.error };
}
