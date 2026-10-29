/**
 * The dashboard DOCUMENT — dashboard builder phase 1 (2026-10-29).
 *
 * Design: docs/superpowers/specs/2026-10-29-dashboard-builder-design.md §4, §5, §7.
 *
 * One named dashboard = one document: which instruments it is about (`source`),
 * the time window its widgets read (`timeWindow`), and the widgets with where
 * they sit. The widget schema and the item reader are the layout's own, so a
 * dashboard and a layout cannot disagree about what a widget is.
 *
 * Two readers, on purpose, as for the layout: `parseDashboardDocument` is STRICT
 * (a write that loses the operator's work while reporting success is the trap),
 * `readDashboardDocument` is FORGIVING (one bad widget must not blank a stored
 * dashboard). An unreadable SOURCE reads as `null`, never as `all`: widening a
 * dashboard to every instrument because its stored scope was corrupt would show
 * data its author never chose.
 */
import { z } from 'zod';
import { readItem, readWidgets, pairWidgets, type LayoutItem } from './dashboard-layout.js';
import {
  WIDGETS_PER_LAYOUT_MAX, customWidgetSchema, isWidgetItem, widgetIdOf, widgetsEqual, type CustomWidget,
} from './dashboard-widgets.js';
import { PERIOD_PRESETS } from './telemetry-period.js';

export const DASHBOARD_DOCUMENT_VERSION = 1;
export const DASHBOARD_SOURCE_INSTRUMENTS_MAX = 200;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERIOD_VALUES = PERIOD_PRESETS.map((p) => p.value) as [string, ...string[]];

export const dashboardSourceSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }),
  z.object({ mode: z.literal('profile'), profileId: z.string().regex(UUID_RE, 'Not a profile id') }),
  z.object({
    mode: z.literal('location'),
    functionalLocationId: z.string().regex(UUID_RE, 'Not a location id'),
    directOnly: z.boolean().default(false),
  }),
  z.object({
    mode: z.literal('instruments'),
    ids: z.array(z.string().regex(UUID_RE, 'Not an instrument id'))
      .min(1, 'Pick at least one instrument')
      .max(DASHBOARD_SOURCE_INSTRUMENTS_MAX, `At most ${DASHBOARD_SOURCE_INSTRUMENTS_MAX} instruments`)
      .transform((ids) => [...new Set(ids)]),
  }),
]);
export type DashboardSource = z.infer<typeof dashboardSourceSchema>;

export const dashboardTimeWindowSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('relative'), period: z.enum(PERIOD_VALUES) }),
  z.object({ mode: z.literal('fixed'), from: z.string().datetime(), to: z.string().datetime() }),
]).refine(
  (w) => w.mode !== 'fixed' || Date.parse(w.from) < Date.parse(w.to),
  { message: 'The window must end after it starts', path: ['to'] },
);
export type DashboardTimeWindow = z.infer<typeof dashboardTimeWindowSchema>;

export const DEFAULT_DASHBOARD_WINDOW: DashboardTimeWindow = { mode: 'relative', period: '24h' };

export interface DashboardDocument {
  version: 1;
  source: DashboardSource;
  timeWindow: DashboardTimeWindow;
  items: LayoutItem[];
  widgets: CustomWidget[];
}

/** As stored: `source: null` means the stored scope could not be read. */
export type StoredDashboardDocument = Omit<DashboardDocument, 'source'> & { source: DashboardSource | null };

/** The wire types the API serves and the web reads. */
export interface DashboardSourceSummary {
  mode: 'all' | 'profile' | 'location' | 'instruments' | 'unreadable';
  label: string;
}

export interface DashboardSummary {
  id: string;
  title: string;
  description: string | null;
  sourceSummary: DashboardSourceSummary;
  widgetCount: number;
  updatedAt: string;
  assignments?: { roles: string[]; users: { id: string; username: string; fullName: string | null }[] };
}

export type DashboardDetail = DashboardSummary & { document: StoredDashboardDocument };

export function emptyDashboardDocument(): DashboardDocument {
  return {
    version: DASHBOARD_DOCUMENT_VERSION,
    source: { mode: 'all' },
    timeWindow: { ...DEFAULT_DASHBOARD_WINDOW },
    items: [],
    widgets: [],
  };
}

const UNSTORABLE = 'Dashboard is not in a form this server can store.';

function titleOf(raw: unknown, n: number): string {
  const t = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>).title : undefined;
  return typeof t === 'string' && t.trim() ? t.trim().slice(0, 80) : `#${n + 1}`;
}

/** The STRICT reader for the write routes: a document, or the reason it is refused. */
export function parseDashboardDocument(
  v: unknown,
): { ok: true; document: DashboardDocument } | { ok: false; message: string } {
  const bad = (message: string) => ({ ok: false as const, message });
  if (typeof v !== 'object' || v === null) return bad(UNSTORABLE);
  const o = v as Record<string, unknown>;
  if (o.version !== DASHBOARD_DOCUMENT_VERSION || !Array.isArray(o.items)) return bad(UNSTORABLE);

  const s = dashboardSourceSchema.safeParse(o.source);
  if (!s.success) {
    const mode = typeof o.source === 'object' && o.source !== null ? (o.source as Record<string, unknown>).mode : undefined;
    return bad(`Dashboard ${typeof mode === 'string' ? mode : 'source'}: ${s.error.issues[0]?.message ?? 'not a source'}`);
  }
  const t = dashboardTimeWindowSchema.safeParse(o.timeWindow);
  if (!t.success) return bad(`Time window: ${t.error.issues[0]?.message ?? 'not a time window'}`);

  const items: LayoutItem[] = [];
  for (const raw of o.items) {
    const item = readItem(raw);
    if (item === undefined) return bad(UNSTORABLE);
    if (item === null || !isWidgetItem(item.i)) return bad('Only widgets can be placed on a dashboard');
    items.push(item);
  }

  if (!Array.isArray(o.widgets)) return bad('`widgets` must be a list.');
  if (o.widgets.length > WIDGETS_PER_LAYOUT_MAX) return bad(`At most ${WIDGETS_PER_LAYOUT_MAX} widgets on one dashboard.`);
  const widgets: CustomWidget[] = [];
  for (const [n, raw] of o.widgets.entries()) {
    const r = customWidgetSchema.safeParse(raw);
    if (!r.success) return bad(`Widget "${titleOf(raw, n)}": ${r.error.issues[0]?.message ?? 'not a widget'}`);
    widgets.push(r.data);
  }

  const ids = new Set<string>();
  for (const w of widgets) {
    if (ids.has(w.id)) return bad(`Widget "${w.title}" appears twice`);
    ids.add(w.id);
  }
  const placements = new Map<string, number>();
  for (const it of items) {
    const id = widgetIdOf(it.i);
    if (id === null) continue;
    if (!ids.has(id)) return bad('A placed widget has no definition');
    placements.set(id, (placements.get(id) ?? 0) + 1);
  }
  for (const w of widgets) {
    const n = placements.get(w.id) ?? 0;
    if (n === 0) return bad(`Widget "${w.title}" is not placed`);
    if (n > 1) return bad(`Widget "${w.title}" is placed twice`);
  }
  return {
    ok: true,
    document: { version: DASHBOARD_DOCUMENT_VERSION, source: s.data, timeWindow: t.data, items, widgets },
  };
}

/**
 * The FORGIVING reader for a stored document. Each part stands alone: a bad
 * widget drops with its item, a bad window reads as the default, a bad source
 * reads as `null` (unreadable) — never as `all`.
 */
export function readDashboardDocument(v: unknown): StoredDashboardDocument {
  const o = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
  const s = dashboardSourceSchema.safeParse(o.source);
  const t = dashboardTimeWindowSchema.safeParse(o.timeWindow);
  const items: LayoutItem[] = [];
  if (Array.isArray(o.items)) {
    for (const raw of o.items) {
      const item = readItem(raw);
      if (item && isWidgetItem(item.i)) items.push(item);
    }
  }
  const paired = pairWidgets(items, readWidgets(o.widgets));
  return {
    version: DASHBOARD_DOCUMENT_VERSION,
    source: s.success ? s.data : null,
    timeWindow: t.success ? t.data : { ...DEFAULT_DASHBOARD_WINDOW },
    items: paired.items,
    widgets: paired.widgets ?? [],
  };
}

/** What changed between two widget lists, matched by id. */
export function diffWidgets(
  before: readonly CustomWidget[],
  after: readonly CustomWidget[],
): { created: CustomWidget[]; updated: { before: CustomWidget; after: CustomWidget }[]; deleted: CustomWidget[] } {
  const was = new Map(before.map((w) => [w.id, w]));
  const now = new Map(after.map((w) => [w.id, w]));
  const created = after.filter((w) => !was.has(w.id));
  const deleted = before.filter((w) => !now.has(w.id));
  const updated: { before: CustomWidget; after: CustomWidget }[] = [];
  for (const a of after) {
    const b = was.get(a.id);
    if (b && !widgetsEqual([b], [a])) updated.push({ before: b, after: a });
  }
  return { created, updated, deleted };
}
