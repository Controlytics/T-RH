import { useMemo, useState, useCallback, useRef } from 'react';
import { useSearchParams, useNavigate } from 'react-router-dom';
import { useCan } from '@/hooks/use-can';
import { useAuth } from '@/hooks/use-auth';
import useSWR from 'swr';
import { TelemetryTable } from './telemetry-table';
import { FloorplanView } from './floorplan-view';
import { resolveNav, ALL_INSTRUMENTS, type NavNode } from './location-nav';
import { usePanels } from '@/hooks/use-panels';
import { SelectionAlarms } from './selection-alarms';
import { READING_PANELS, hiddenPanelsFor } from './view-panels';
import { PanelGrid } from './panel-grid';
import { PanelCard } from './panel-card';
import { AUTO_HEIGHT_PANELS, applyAutoHeights, keepStoredHeights, nextRows } from './panel-auto-height';
import { EntryCards } from './entry-cards';
import { useDashboardLayout } from '@/hooks/use-dashboard-layout';
import type { LayoutItem } from '@digilog/shared';
import { Button } from '@/components/ui/button';

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
  const { user } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const selected = params.get('fl');

  // Resolved server-side, per role AND per user. Replaces the old
  // /api/config/dashboard-cards/current fetch, which had no per-user layer and
  // which did the role lookup here in the browser.
  const { showPanel } = usePanels();
  const layout = useDashboardLayout();

  // TABULAR by default; Graphical only when asked for. In the URL like `fl` and
  // `agg`, so a graphical view is linkable and survives a refresh — the
  // convention this page already set. Anything other than 'graphical' reads as
  // table, so a hand-edited URL degrades to the default rather than a blank slot.
  const view: 'table' | 'graphical' = params.get('view') === 'graphical' ? 'graphical' : 'table';
  const setView = (v: 'table' | 'graphical') => {
    const next = new URLSearchParams(params);
    if (v === 'graphical') next.set('view', v); else next.delete('view');
    setParams(next);
  };

  const { data: tree } = useSWR<{ data: NavNode[] }>('/api/functional-locations');
  // The true instrument total, including instruments in NO location. limit=1 so
  // this is a count query, not a page of rows. Without it the All Instruments card
  // shows only the instruments that happen to be placed — 5 of 20 here — while its
  // own view shows all 20.
  const { data: allInstruments } = useSWR<{ total?: number }>('/api/instruments?limit=1');
  // ACTIVE = REPORTING, not `isActive`.
  //
  // This first used `/api/instruments?limit=1&isActive=true`, which counts the
  // administrator's enable/disable flag. Every instrument here is enabled, so
  // the card read "101 active · 0 inactive" while nothing had reported for two
  // days. `/activity-summary` applies `isInstrumentReporting` — the same rule
  // Configuration → Instrument Activity describes and the Block/Area cards use
  // — so the headline and the cards beneath it cannot disagree.
  const { data: activitySummary } = useSWR<{ total?: number; active?: number }>(
    '/api/instruments/activity-summary',
  );
  // Alarm counts for the overview card. Fetched only when the viewer may read alarms —
  // the endpoint 403s otherwise, and a card showing 0 because of a permission error
  // would read as "nothing wrong" to someone who simply cannot see it.
  const canSeeAlarms = can('alarms.view');
  const { data: alarmSummary } = useSWR<{ active: number; unacknowledged: number }>(
    canSeeAlarms ? '/api/alarms/summary' : null,
  );
  const nav = useMemo(
    () => resolveNav(selected, tree?.data ?? [], allInstruments?.total, activitySummary?.active),
    [selected, tree, allInstruments?.total, activitySummary?.active],
  );

  const go = (fl: string | null) => {
    const next = new URLSearchParams(params);
    if (fl) next.set('fl', fl); else next.delete('fl');
    setParams(next);
  };

  const locations = tree?.data ?? [];

  // ── Tabular / Graphical ────────────────────────────────────────────────────
  // WHICH panels each view hides lives in `view-panels.ts` (Tabular hides the
  // floorplan; Graphical hides the table AND the alarms widget — operator,
  // 2026-09-22). The trend shows in both views.
  const hasPanel = (key: string) => layout.items.some((it) => it.i === key) && showPanel(key);
  // Offer the switch only when there is something to switch BETWEEN. A role that
  // cannot see the floorplan gets no toggle rather than a button that blanks the
  // grid.
  const canToggleView = hasPanel(READING_PANELS.table) && hasPanel(READING_PANELS.graphical);
  const hiddenPanels = hiddenPanelsFor(view, canToggleView);

  /**
   * PANEL HEIGHTS THAT FOLLOW THEIR CONTENT (operator, 2026-09-01).
   *
   * Each auto card reports the height it wants; `nextRows` damps that into a grid
   * row count and this state feeds it back as the item's `h`. The measured value
   * is RENDER-ONLY — `onGridChange` below strips it out again before anything is
   * saved, so `role_configs` never learns how many rows were on screen at the
   * moment somebody pressed Save.
   *
   * `useCallback` per panel key, memoised in a ref: `onNaturalHeight` is an effect
   * dependency inside PanelCard, so a fresh function each render would tear down
   * and rebuild the ResizeObserver on every frame.
   */
  const [autoRows, setAutoRows] = useState<Record<string, number>>({});
  const reporters = useRef(new Map<string, (px: number) => void>());
  const reportHeight = useCallback((key: string) => {
    const existing = reporters.current.get(key);
    if (existing) return existing;
    const fn = (px: number) => setAutoRows((prev) => {
      const next = nextRows(prev[key] ?? null, px);
      // Bail on an unchanged value or React re-renders for every observed frame.
      return next === prev[key] ? prev : { ...prev, [key]: next };
    });
    reporters.current.set(key, fn);
    return fn;
  }, []);

  const placedItems = hiddenPanels.size ? layout.items.filter((it) => !hiddenPanels.has(it.i)) : layout.items;
  const visibleItems = applyAutoHeights(placedItems, autoRows);

  /**
   * Merge the hidden panels' stored positions back into the draft.
   *
   * react-grid-layout reports only the items it was GIVEN, so saving while a view
   * is filtered would persist a layout with the hidden panels missing — and a
   * panel absent from the layout never comes back. The hidden items are carried
   * through untouched, at whatever position they already held.
   */
  const onGridChange = (next: LayoutItem[]) => {
    // Discard the DERIVED heights before they reach the draft. The grid reports
    // whatever height each item currently has, which for an auto panel is a
    // measurement — saving it would pin every viewer to one page size's worth of
    // rows, and it would go stale the first time anyone changed that page size.
    const kept = keepStoredHeights(next, layout.items);

    /**
     * BAIL WHEN NOTHING MOVED, or edit mode writes the draft on every layout pass.
     *
     * Every step of the render carries fresh OBJECT IDENTITIES even when the
     * values are identical — `keepStoredHeights` maps, `applyAutoHeights` maps,
     * `withResizeHandles` maps, and the `layouts={{ lg: ... }}` literal is new each
     * render. react-grid-layout re-runs its layout, calls back, and the cycle
     * starts again: the classic RGL feedback loop, and at best a draft rewritten
     * on every pass, which can flip the unsaved-changes state on its own.
     *
     * Only reachable in edit mode — `onLayoutChange` already returns early when
     * `!editing` — which is exactly why nothing outside edit mode would show it.
     */
    const unchanged = kept.every((it) => {
      const prev = layout.items.find((p) => p.i === it.i);
      return prev !== undefined
        && prev.x === it.x && prev.y === it.y && prev.w === it.w && prev.h === it.h;
    });
    if (unchanged) return;

    if (!hiddenPanels.size) return layout.setDraft(kept);
    const carried = layout.items.filter((it) => hiddenPanels.has(it.i));
    layout.setDraft([...kept, ...carried]);
  };

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
    <div
      className="space-y-4 animate-fade-in"
      // Which ground the layout paints (app.css `.dash-ground`): DEEP while only
      // the colour cards are on screen, LIGHT once the readings table is —
      // dark type on a dark field is the one thing the deep ground cannot hold.
      data-dashboard-ground={nav.showViews ? 'light' : 'deep'}
    >
      {/*
        THE PLATE behind this header is a legibility fix, not decoration.

        The dashboard is the one route that renders the operator-uploaded
        wallpaper, and the title and breadcrumb sat directly on it — over a
        photograph, dark slate type on an arbitrary image has no contrast
        guarantee at all, and with the wallpaper set on this install the word
        "Dashboard" was effectively unreadable.

        A translucent plate rather than a switch on "is a wallpaper set":
        the header does not know, and should not have to. Over a wallpaper it
        restores contrast; over the plain grey page it reads as an ordinary
        header band.

        HIDDEN AT THE TOP LEVEL (operator, 2026-08-29: "remove the dashboard text
        box and functional location selection on dashboard first page"). At level 0
        the breadcrumb is empty by construction, so the plate carried nothing but
        the word "Dashboard" and the location picker; the entry cards below are the
        drill-down. From level 1 down the plate MUST stay — the breadcrumb inside it
        is the only way back up.
      */}
      {nav.level > 0 && (
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-[var(--radius-card)] border border-white/70 bg-white/85 px-3 py-2 shadow-[var(--elev-1)] backdrop-blur-sm">
        <div>
          {/* The "Dashboard" <h1> was REMOVED 2026-08-29 (operator: "remove the
              dashboard text and decrease the dashboard size"). The sidebar already
              marks Dashboard as the current page, so the title only restated it
              while setting the bar's height — losing it is most of the size cut.
              The breadcrumb keeps the word as its ROOT LINK; that one is
              navigation, not a label, and is the only way back to the top level. */}
          {/* Breadcrumb: the only way back up, so it is always rendered once a
              selection exists rather than only at the deepest level. */}
          {nav.breadcrumb.length > 0 && (
            <nav className="flex flex-wrap items-center gap-1 text-sm text-slate-500">
              {nav.breadcrumb.map((c, i) => (
                <span key={`${c.id ?? 'root'}-${i}`} className="flex items-center gap-1">
                  {i > 0 && <span className="text-slate-400">›</span>}
                  {i === nav.breadcrumb.length - 1 ? (
                    <span className="font-semibold text-slate-700">{c.label}</span>
                  ) : (
                    <Button variant="link" size="inline" type="button" onClick={() => go(c.id)}>
                      {c.label}
                    </Button>
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
            className="ctl"
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
      )}

      {nav.cards.length > 0 && (
        /* The landing cards. Built to the supplied reference (Screen-1.png,
           2026-08-29): two hero cards, then Blocks Overview. Every count comes
           from the same `nav.cards` / alarm-summary data the previous uniform
           grid used — this changed the presentation, not the numbers.

           Alarms sits beside All Instruments at the TOP LEVEL ONLY: it is a
           destination, not a drill-down, so it navigates away rather than
           filtering. Deeper levels are about one location's instruments, where
           a global alarm count would be misleading. */
        <EntryCards
          dark={!nav.showViews}
          cards={nav.cards}
          onSelect={go}
          alarms={selected === null && canSeeAlarms
            ? {
                active: alarmSummary?.active ?? 0,
                unacknowledged: alarmSummary?.unacknowledged ?? 0,
              }
            : null}
          onOpenAlarms={() => navigate('/alarms')}
          // The same component lists Blocks at the top and one Block's Areas a
          // level down, so it has to be told which.
          // Below the top level the heading is SUPPRESSED (operator, 2026-08-29).
          // "Areas / Areas in CWH Block" sat directly under a breadcrumb already
          // reading "Dashboard › CWH Block", so it named what the line above it
          // had just named. null, not '' — the default only fires on undefined.
          sectionTitle={nav.level === 0 ? 'Blocks Overview' : null}
          sectionSubtitle={nav.level === 0 ? 'Overview of all functional blocks' : null}
        />
      )}

      {/*
        THE PANEL GRID.

        Every assignable panel is a grid item: draggable and resizable once
        "Arrange" is pressed, and persisted per user with a role default beneath.

        The Table | Graphical TOGGLE IS BACK (operator, 2026-08-29), having been
        removed on 2026-08-28. It reads the `?view=` parameter again. Tabular is the
        default; Graphical swaps in the floorplan.

        IT HIDES, IT DOES NOT DELETE. Tabular hides the floorplan; Graphical hides
        the table and the alarms widget (`view-panels.ts`). A hidden panel keeps its
        stored position — see `onGridChange` below, which merges hidden items back
        into the draft. Without that merge, arranging while one view is showing
        would save a layout with the other panels MISSING, and they would never come
        back. That is the trap in filtering the items you hand to react-grid-layout:
        its onChange reports only what it was given.

        Each child's `key` MUST equal its layout item's `i`. That is how
        react-grid-layout matches a child to its position; a mismatch silently
        drops the card rather than erroring.
      */}
      {nav.showViews && layout.items.length > 0 && (
        <PanelGrid
          items={visibleItems}
          editing={layout.editing}
          saving={layout.saving}
          onStart={layout.start}
          onCancel={layout.cancel}
          onSave={layout.save}
          onReset={layout.reset}
          onChange={onGridChange}
          // Arrange is SUPER_ADMIN only (operator, 2026-08-29).
          canArrange={user?.role === 'SUPER_ADMIN'}
          toolbar={canToggleView ? (
            <div className="inline-flex rounded-lg border border-slate-200 bg-white p-0.5 shadow-sm">
              {([
                { id: 'table' as const, label: 'Tabular view' },
                { id: 'graphical' as const, label: 'Graphical view' },
              ]).map((v) => (
                <button
                  key={v.id}
                  type="button"
                  onClick={() => setView(v.id)}
                  aria-pressed={view === v.id}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    view === v.id
                      ? 'bg-blue-600 text-white shadow-sm'
                      : 'text-slate-600 hover:bg-slate-50'
                  }`}
                >
                  {v.label}
                </button>
              ))}
            </div>
          ) : undefined}
        >
          {visibleItems.map((it) => {
            // A layout item for a panel this viewer may not see never reaches the
            // browser — the server strips it — but the guard stays as the single
            // place that decides, so assignment and rendering cannot disagree.
            if (!showPanel(it.i)) return <div key={it.i} />;
            return (
              <div key={it.i}>
                {it.i === 'telemetry_table' && (
                  <PanelCard
                    title={panelHeading('Instrument Readings — Table')}
                    eyebrow="Readings"
                    editing={layout.editing}
                    style={it.style}
                    width={it.w}
                    height={it.h}
                    onStyleChange={(next) => layout.setStyle(it.i, next)}
                    onSizeChange={(w, h) => layout.setSize(it.i, w, h)}
                    autoHeight={AUTO_HEIGHT_PANELS.has(it.i)}
                    onNaturalHeight={reportHeight(it.i)}
                  >
                    <TelemetryTable functionalLocationId={nav.functionalLocationId} directOnly={nav.directOnly} />
                  </PanelCard>
                )}
                {/* `dashboard_history` (the Instrument History widget) rendered
                    here from 2026-09-05 to 2026-09-07; it is the `/data-report`
                    page now, and the key is out of the catalogue. */}
                {it.i === 'telemetry_floorplan' && (
                  <PanelCard
                    title={panelHeading('Instrument Readings — Floorplan')}
                    eyebrow="Layout"
                    editing={layout.editing}
                    style={it.style}
                    width={it.w}
                    height={it.h}
                    onStyleChange={(next) => layout.setStyle(it.i, next)}
                    onSizeChange={(w, h) => layout.setSize(it.i, w, h)}
                  >
                    <FloorplanView functionalLocationId={nav.functionalLocationId} directOnly={nav.directOnly} />
                  </PanelCard>
                )}
                {it.i === 'dashboard_alarms' && (
                  <PanelCard
                    title="Active alarms in this selection"
                    eyebrow="Alarms"
                    editing={layout.editing}
                    style={it.style}
                    width={it.w}
                    height={it.h}
                    onStyleChange={(next) => layout.setStyle(it.i, next)}
                    onSizeChange={(w, h) => layout.setSize(it.i, w, h)}
                    autoHeight={AUTO_HEIGHT_PANELS.has(it.i)}
                    onNaturalHeight={reportHeight(it.i)}
                  >
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
