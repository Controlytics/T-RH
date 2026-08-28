import { useMemo } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useCan } from '@/hooks/use-can';
import useSWR from 'swr';
import { TelemetryTable } from './telemetry-table';
import { FloorplanView } from './floorplan-view';
import { resolveNav, ALL_INSTRUMENTS, type NavNode } from './location-nav';
import { usePanels } from '@/hooks/use-panels';
import { AggregateTrendCard } from './aggregate-trend-card';
import { SelectionAlarms } from './selection-alarms';
import { PanelGrid } from './panel-grid';
import { PanelCard } from './panel-card';
import { useDashboardLayout } from '@/hooks/use-dashboard-layout';

/** A CSS gradient STRING for `backgroundImage`. Not lib/theme-styles' themeGradient,
 *  which is a CSSProperties object and cannot be assigned to that property. */
const themeGradient = 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))';

/**
 * The dashboard: a functional-location drill-down over the two instrument views.
 *
 * Levels: entry cards (All Instruments + each Block) → a Block's Areas → the
 * Tabular / Graphical views, scoped to the selection. Design:
 * docs/superpowers/specs/2026-08-13-dashboard-drilldown-design.md
 *
 * CARDS ARE DATA-DRIVEN. The operator named CWH and eight areas, but those are
 * their current locations, not a fixed menu — the grid renders whatever the
 * functional-location tree holds, so creating a location makes its card appear with
 * no code change here.
 *
 * SELECTION LIVES IN THE URL (`?fl=`), not in useState: a scoped view is then
 * linkable, survives a refresh, and the browser Back button walks back up the tree.
 *
 * The Welcome hero, Quick Overview and Quick Actions were removed (operator: "in
 * dashboard page show only tabular view and graphical view"). The four keys that
 * gated them — `total_users`, `audit_trail`, `notifications`, `quick_actions` —
 * were INERT from that day and were finally retired on 2026-08-28 with the panel
 * assignment work.
 *
 * Panel visibility now comes from `usePanels()`: resolved SERVER-SIDE per role and
 * per user and shipped on /api/config/my-config, so nothing here re-derives it.
 * The catalogue is @digilog/shared types/panels.ts.
 *
 * There is deliberately NO Alarms card: this fork has no alarm subsystem, and a
 * card that cannot be backed by data is worse than an absent one. It arrives with
 * the alarm project.
 */
export function DashboardPage() {
  const can = useCan();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selected = params.get('fl');
  // In the URL, like `fl` and `view`: the whole dashboard state is linkable and
  // survives a refresh, which is the convention this page already set.
  const aggWindow = (['1h', '6h', '24h', '7d'] as const)
    .find((w) => w === params.get('agg')) ?? '24h';
  const setAggWindow = (w: '1h' | '6h' | '24h' | '7d') => {
    const next = new URLSearchParams(params);
    next.set('agg', w);
    setParams(next);
  };

  // Resolved server-side, per role AND per user. Replaces the old
  // /api/config/dashboard-cards/current fetch, which had no per-user layer and
  // which did the role lookup here in the browser.
  const { showPanel } = usePanels();
  const layout = useDashboardLayout();

  const { data: tree } = useSWR<{ data: NavNode[] }>('/api/functional-locations');
  // The true instrument total, including instruments in NO location. limit=1 so
  // this is a count query, not a page of rows. Without it the All Instruments card
  // shows only the instruments that happen to be placed — 5 of 20 here — while its
  // own view shows all 20.
  const { data: allInstruments } = useSWR<{ total?: number }>('/api/instruments?limit=1');
  // Alarm counts for the overview card. Fetched only when the viewer may read alarms —
  // the endpoint 403s otherwise, and a card showing 0 because of a permission error
  // would read as "nothing wrong" to someone who simply cannot see it.
  const canSeeAlarms = can('alarms.view');
  const { data: alarmSummary } = useSWR<{ active: number; unacknowledged: number; critical: number }>(
    canSeeAlarms ? '/api/alarms/summary' : null,
  );
  const nav = useMemo(
    () => resolveNav(selected, tree?.data ?? [], allInstruments?.total),
    [selected, tree, allInstruments?.total],
  );

  const go = (fl: string | null) => {
    const next = new URLSearchParams(params);
    if (fl) next.set('fl', fl); else next.delete('fl');
    setParams(next);
  };

  const locations = tree?.data ?? [];

  /**
   * The two readings panels used to sit under one heading naming the current
   * location. As separate cards they each need it, or a screen showing both gives
   * no clue which location the numbers belong to.
   */
  const panelHeading = (base: string) => {
    const where = nav.breadcrumb.length > 0 ? nav.breadcrumb[nav.breadcrumb.length - 1].label : null;
    const pinned = nav.directOnly ? ' (pinned to the block itself)' : '';
    return where ? `${base} — ${where}${pinned}` : `${base}${pinned}`;
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Dashboard</h1>
          {/* Breadcrumb: the only way back up, so it is always rendered once a
              selection exists rather than only at the deepest level. */}
          {nav.breadcrumb.length > 0 && (
            <nav className="mt-1 flex flex-wrap items-center gap-1 text-sm text-slate-500">
              {nav.breadcrumb.map((c, i) => (
                <span key={`${c.id ?? 'root'}-${i}`} className="flex items-center gap-1">
                  {i > 0 && <span className="text-slate-400">›</span>}
                  {i === nav.breadcrumb.length - 1 ? (
                    <span className="font-semibold text-slate-700">{c.label}</span>
                  ) : (
                    <button type="button" onClick={() => go(c.id)} className="hover:underline">
                      {c.label}
                    </button>
                  )}
                </span>
              ))}
            </nav>
          )}
        </div>

        {/* Location filter — jumps straight to any location, at any depth. */}
        <label className="flex items-center gap-2 text-sm">
          <span className="font-medium text-slate-600">Functional location</span>
          <select
            value={selected ?? ''}
            onChange={(e) => go(e.target.value || null)}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm"
          >
            <option value="">— Overview —</option>
            <option value={ALL_INSTRUMENTS}>All Instruments</option>
            {locations.map((b) => (
              <optgroup key={b.id} label={b.name}>
                <option value={b.id}>{b.name} (whole block)</option>
                {b.ownCount > 0 && <option value={`${b.id}:direct`}>{b.name} — direct only</option>}
                {b.children.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
              </optgroup>
            ))}
          </select>
        </label>
      </div>

      {nav.cards.length > 0 && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {nav.cards.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => go(c.id)}
              className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-elevated"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-lg font-bold text-slate-800">{c.label}</p>
                  <p className="mt-0.5 text-xs uppercase tracking-wider text-slate-500">{c.sublabel}</p>
                </div>
                <span
                  className="shrink-0 rounded-xl px-3 py-1.5 text-lg font-bold text-white"
                  style={{ backgroundImage: themeGradient }}
                >
                  {c.count}
                </span>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                {c.count === 1 ? '1 instrument' : `${c.count} instruments`}
              </p>
            </button>
          ))}

          {/* Alarms sits beside the location cards at the top level only: it is a
              destination, not a drill-down, so it navigates away rather than filtering.
              Deeper levels are about one location's instruments, where a global alarm
              count would be misleading. */}
          {selected === null && canSeeAlarms && (
            <button
              type="button"
              onClick={() => navigate('/alarms')}
              className="rounded-2xl border border-slate-200 bg-white p-5 text-left shadow-soft transition-all hover:-translate-y-0.5 hover:shadow-elevated"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="truncate text-lg font-bold text-slate-800">Alarms</p>
                  <p className="mt-0.5 text-xs uppercase tracking-wider text-slate-500">Active</p>
                </div>
                <span className={`shrink-0 rounded-xl px-3 py-1.5 text-lg font-bold text-white ${
                  (alarmSummary?.active ?? 0) > 0 ? 'bg-red-600' : 'bg-emerald-600'
                }`}>
                  {alarmSummary?.active ?? 0}
                </span>
              </div>
              <p className="mt-3 text-xs text-slate-500">
                {(alarmSummary?.unacknowledged ?? 0) > 0
                  ? `${alarmSummary?.unacknowledged} awaiting acknowledgement`
                  : 'Nothing awaiting acknowledgement'}
              </p>
            </button>
          )}
        </div>
      )}

      {/*
        THE PANEL GRID.

        Every assignable panel is a grid item: draggable and resizable once
        "Arrange" is pressed, and persisted per user with a role default beneath.

        The Table | Graphical TOGGLE WAS REMOVED on 2026-08-28 (operator's call).
        A grid where each panel is independently placeable cannot also have two of
        them sharing one slot behind a switch — and they were already two separate
        keys in the panel catalogue. Both can now be on screen at once, or either
        dragged away. The `?view=` URL parameter went with it.

        Each child's `key` MUST equal its layout item's `i`. That is how
        react-grid-layout matches a child to its position; a mismatch silently
        drops the card rather than erroring.
      */}
      {nav.showViews && layout.items.length > 0 && (
        <PanelGrid
          items={layout.items}
          editing={layout.editing}
          saving={layout.saving}
          onStart={layout.start}
          onCancel={layout.cancel}
          onSave={layout.save}
          onReset={layout.reset}
          onChange={layout.setDraft}
        >
          {layout.items.map((it) => {
            // A layout item for a panel this viewer may not see never reaches the
            // browser — the server strips it — but the guard stays as the single
            // place that decides, so assignment and rendering cannot disagree.
            if (!showPanel(it.i)) return <div key={it.i} />;
            return (
              <div key={it.i}>
                {it.i === 'telemetry_table' && (
                  <PanelCard title={panelHeading('Instrument Readings — Table')} editing={layout.editing}>
                    <TelemetryTable functionalLocationId={nav.functionalLocationId} directOnly={nav.directOnly} />
                  </PanelCard>
                )}
                {it.i === 'telemetry_floorplan' && (
                  <PanelCard title={panelHeading('Instrument Readings — Floorplan')} editing={layout.editing}>
                    <FloorplanView functionalLocationId={nav.functionalLocationId} directOnly={nav.directOnly} />
                  </PanelCard>
                )}
                {it.i === 'dashboard_trend' && (
                  <PanelCard title="Trend — spread across this selection" editing={layout.editing}>
                    <AggregateTrendCard
                      functionalLocationId={nav.functionalLocationId}
                      directOnly={nav.directOnly}
                      window={aggWindow}
                      onWindowChange={setAggWindow}
                    />
                  </PanelCard>
                )}
                {it.i === 'dashboard_alarms' && (
                  <PanelCard title="Active alarms in this selection" editing={layout.editing}>
                    <SelectionAlarms functionalLocationId={nav.functionalLocationId} />
                  </PanelCard>
                )}
              </div>
            );
          })}
        </PanelGrid>
      )}

      {nav.level === 0 && locations.length === 0 && (
        <p className="rounded-2xl border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-sm text-slate-600">
          No functional locations yet — only <strong>All Instruments</strong> is available.
          Create Blocks and Areas on the Functional Locations page to drill down by area.
        </p>
      )}
    </div>
  );
}

export default DashboardPage;
