import { Component, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useSWRConfig } from 'swr';
import {
  WIDGETS_PER_LAYOUT_MAX, widgetIdOf,
  type CustomWidget, type DashboardDetail, type DashboardTimeWindow,
} from '@digilog/shared';
import { PageHero } from '@/components/ui/page-hero';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { DialogBanner } from '@/components/ui/dialog-banner';
import { EmptyState } from '@/components/ui/empty-state';
import { LoadError } from '@/components/ui/load-error';
import { SkeletonCard } from '@/components/ui/skeleton';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useAuth } from '@/hooks/use-auth';
import { useReauth } from '@/hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { PanelGrid } from '@/routes/dashboard/panel-grid';
import { applyAutoHeights, autoHeightIds, nextRows } from '@/routes/dashboard/panel-auto-height';
import { useTelemetryOverview } from '@/routes/dashboard/use-telemetry';
import { WidgetPanel } from '@/routes/dashboard/widgets/widget-panel';
import { WidgetDialog } from '@/routes/dashboard/widgets/widget-dialog';
import { selectionForSource } from '@/routes/dashboard/widgets/selection';
import { LOAD_FAILED } from '@/routes/dashboard/widgets/widget-common';
import { useDashboard, saveDashboard } from './use-dashboards';
import { useDashboardDraft } from './use-dashboard-draft';
import { TimeWindowPicker } from './time-window-picker';
import { PATHS, Svg } from './index';

/**
 * `/dashboards/:id` — ONE built dashboard (dashboard builder phase 1, design
 * sections 4 and 8; the header is concept C, ruling R6).
 *
 * WHAT IS SHOWN is the server's: the document comes from `GET
 * /api/dashboards/:id` (a 404 for one that is not visible to the caller), and
 * every widget reads the existing instrument routes under the VIEWER's own
 * scope. A dashboard grants nothing; an instrument the viewer cannot see is
 * simply absent. An unreadable source (`null`) is NO instruments, never all.
 *
 * WHO MAY CHANGE IT: a SUPER_ADMIN only. Edit (and `?edit=1`, where the New
 * flow lands) is presentation; the write route's 403 is the control. A save is
 * the WHOLE document, inside `reauth.execute('UPDATE_DASHBOARD', ...)`, with
 * the `updatedAt` loaded when editing BEGAN — a save over a dashboard someone
 * else changed since is a 409 that writes nothing, and the draft is kept until
 * Reload.
 *
 * The header's time window is SESSION state, starting at the document's; it is
 * never written back (Settings owns the stored default).
 */
export function DashboardPage() {
  const { id } = useParams<{ id: string }>();
  const { dashboard, notFound, error, mutate } = useDashboard(id);

  if (notFound) {
    return (
      <div className="space-y-6">
        <div className="rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]">
          <EmptyState
            icon={<Svg d={PATHS.unreadable} className="h-6 w-6" />}
            title="This dashboard is not available to you."
            action={(
              <Link to="/dashboards" className="text-sm font-semibold text-[var(--theme-primary,#2a78d6)] hover:underline">
                Back to Dashboards
              </Link>
            )}
          />
        </div>
      </div>
    );
  }
  if (!dashboard) {
    return error ? <LoadError what="this dashboard" error={error} /> : <SkeletonCard lines={3} />;
  }
  // Keyed by id: the draft, the session window and the edit base all belong to
  // ONE dashboard, and a link to another must not carry them across.
  return <DashboardView key={dashboard.id} dashboard={dashboard} mutate={mutate} />;
}

function DashboardView({ dashboard, mutate }: { dashboard: DashboardDetail; mutate: () => Promise<unknown> }) {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const { toast } = useToast();
  const reauth = useReauth();
  const { mutate: revalidate } = useSWRConfig();
  const [params, setParams] = useSearchParams();

  const session = useDashboardDraft(dashboard.document);
  const { draft, editing } = session;
  const [activeWindow, setActiveWindow] = useState<DashboardTimeWindow>(dashboard.document.timeWindow);
  const selection = useMemo(() => selectionForSource(draft.source, activeWindow), [draft.source, activeWindow]);
  // The same overview query the "follow the dashboard" widgets make — one SWR
  // key, so the count costs no extra request.
  const overview = useTelemetryOverview({
    functionalLocationId: selection.functionalLocationId,
    directOnly: selection.directOnly,
    profileId: selection.profileId,
    instrumentIds: selection.instrumentIds,
  });

  /**
   * The `updatedAt` this edit session is BASED on, taken when it starts. Not
   * the live `dashboard.updatedAt` at Save: a revalidation while editing (focus,
   * Refresh) would hand Save the OTHER editor's version, and the 409 that
   * stops a silent overwrite would never fire.
   */
  const [editBase, setEditBase] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [widgetDialog, setWidgetDialog] = useState<{ initial?: CustomWidget } | null>(null);

  const startEditing = () => {
    setEditBase(dashboard.updatedAt);
    session.start();
  };
  const stopEditing = () => {
    session.cancel();
    setEditBase(null);
  };

  // `?edit=1` (where New lands) opens a SUPER_ADMIN in edit mode — once, then
  // leaves the URL, so a later Save or Cancel does not re-enter it.
  const editParamSeen = useRef(false);
  useEffect(() => {
    if (editParamSeen.current || !user) return;
    editParamSeen.current = true;
    if (params.get('edit') !== '1') return;
    if (isSuperAdmin) startEditing();
    const next = new URLSearchParams(params);
    next.delete('edit');
    setParams(next, { replace: true });
    // Keyed on `user` only: it waits for the signed-in user, and the ref makes
    // it once per mount whatever else re-renders.
  }, [user]);

  const save = () => {
    // Nothing changed: nothing to write (the server would write nothing either),
    // and no reason to ask for a password.
    if (!session.dirty) { stopEditing(); return; }
    const body = { document: draft, expectedUpdatedAt: editBase ?? dashboard.updatedAt };
    setSaving(true);
    void reauth.execute('UPDATE_DASHBOARD', async (password?: string) => {
      await saveDashboard(dashboard.id, body, password);
      // Read the saved dashboard BEFORE leaving edit mode, so the page never
      // flashes the version it is replacing.
      await mutate();
    }, {
      onSuccess: () => {
        setSaving(false);
        stopEditing();
        toast.success('Dashboard saved', `"${dashboard.title}" saved.`);
      },
      onError: (e: unknown) => {
        setSaving(false);
        if ((e as { code?: string })?.code === 'DASHBOARD_CHANGED') { setConflict(true); return; }
        toast.error('Could not save', (e as { message?: string })?.message || 'Please try again.');
      },
      onCancel: () => setSaving(false),
    });
  };

  /** After a 409: read the saved version and drop the draft (and only then). */
  const reload = async () => {
    setReloading(true);
    try {
      await mutate();
      stopEditing();
      setConflict(false);
    } finally {
      setReloading(false);
    }
  };

  // Every key on the page — the dashboard, the overview, each widget's
  // requests. ONE argument: a second (`undefined`) would WIPE the cache.
  const refresh = () => { void revalidate(() => true); };

  // ── Heights that follow their content (the home dashboard's rule) ─────────
  const [autoRows, setAutoRows] = useState<Record<string, number>>({});
  const reporters = useRef(new Map<string, (px: number) => void>());
  const reportHeight = useCallback((key: string) => {
    const existing = reporters.current.get(key);
    if (existing) return existing;
    const fn = (px: number) => setAutoRows((prev) => {
      const next = nextRows(prev[key] ?? null, px);
      return next === prev[key] ? prev : { ...prev, [key]: next };
    });
    reporters.current.set(key, fn);
    return fn;
  }, []);
  const autoIds = useMemo(() => autoHeightIds(draft.widgets), [draft.widgets]);
  const visibleItems = applyAutoHeights(draft.items, autoRows, autoIds);

  const atMax = draft.widgets.length >= WIDGETS_PER_LAYOUT_MAX;
  const count = overview.isLoading && overview.rows.length === 0 ? null : overview.rows.length;
  const empty = draft.items.length === 0;

  return (
    <div className="space-y-4">
      <PageHero
        className="py-4"
        title={dashboard.title}
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Dashboards', to: '/dashboards' }, { label: dashboard.title }]}
        meta={(
          <>
            {dashboard.description && (
              <>
                <span className="text-[0.875rem] text-white/85">{dashboard.description}</span>
                <span aria-hidden className="h-4 w-px bg-white/30" />
              </>
            )}
            <span
              data-testid="dashboard-source"
              data-mode={dashboard.sourceSummary.mode}
              className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-full bg-white/15 px-3 py-1 text-[0.8125rem] font-semibold text-white ring-1 ring-inset ring-white/30"
            >
              <Svg d={PATHS[dashboard.sourceSummary.mode]} />
              {count === null ? dashboard.sourceSummary.label : `${dashboard.sourceSummary.label} · ${count} in your view`}
            </span>
          </>
        )}
        actions={(
          <div className="flex flex-col items-end gap-2">
            {isSuperAdmin && !editing && (
              <div className="flex items-center gap-2">
                <Button type="button" variant="outline" size="sm" className="font-semibold" onClick={startEditing}>
                  <Svg d={PATHS.pencil} className="h-4 w-4" />Edit
                </Button>
              </div>
            )}
            <div className="flex items-center gap-2">
              <TimeWindowPicker value={activeWindow} onChange={setActiveWindow} />
              <button
                type="button"
                onClick={refresh}
                title="Refresh"
                aria-label="Refresh"
                className="widget-band-btn inline-flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)]"
              >
                <Svg d={PATHS.refresh} className="h-4 w-4" />
              </button>
            </div>
          </div>
        )}
      />

      {draft.source === null && (
        <p role="alert" className="rounded-[var(--radius-card)] border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-medium text-amber-900">
          This dashboard&apos;s instruments could not be read. A super admin can choose them again in Settings.
        </p>
      )}

      {empty && !editing ? (
        <div className="rounded-[var(--radius-card)] border border-dashed border-slate-300 bg-white">
          {isSuperAdmin ? (
            <EmptyState
              icon={<Svg d={PATHS.grid} className="h-6 w-6" />}
              title="No widgets yet."
              action={(
                <Button type="button" onClick={() => { startEditing(); setWidgetDialog({}); }}>
                  <Svg d={PATHS.plus} className="h-4 w-4" />Add the first widget
                </Button>
              )}
            />
          ) : (
            <EmptyState icon={<Svg d={PATHS.grid} className="h-6 w-6" />} title="Nothing on this dashboard yet." />
          )}
        </div>
      ) : (
        /* The home dashboard's grid, unchanged. Its own Arrange button is
           hidden (`canArrange` is false outside edit mode) because Edit lives in
           the header; "Reset to default" means "back to the saved dashboard",
           still editing — a built dashboard has no other default. */
        <PanelGrid
          items={visibleItems}
          editing={editing}
          saving={saving}
          onStart={startEditing}
          onCancel={stopEditing}
          onSave={save}
          onReset={startEditing}
          onChange={session.onGridChange}
          canArrange={isSuperAdmin && editing}
          autoIds={autoIds}
          editActions={isSuperAdmin ? (
            <Button
              variant="outline"
              disabled={saving || atMax}
              title={atMax ? `At most ${WIDGETS_PER_LAYOUT_MAX} widgets on one dashboard.` : undefined}
              onClick={() => setWidgetDialog({})}
            >
              Add widget
            </Button>
          ) : undefined}
        >
          {/* Each child's key MUST equal its item's `i` (how the grid matches them). */}
          {visibleItems.map((it) => {
            const wid = widgetIdOf(it.i);
            const w = wid === null ? undefined : draft.widgets.find((x) => x.id === wid);
            if (!w) return <div key={it.i} />;
            return (
              <div key={it.i}>
                {/* Keyed by the DEFINITION: an edited widget starts afresh, so a
                    changed default (status, page size, period) shows at once
                    rather than after a reload; and a widget that failed to draw
                    gets another try. */}
                <WidgetBoundary key={JSON.stringify(w)} title={w.title}>
                  <WidgetPanel
                    widget={w}
                    item={it}
                    selection={selection}
                    editing={editing}
                    onEdit={() => setWidgetDialog({ initial: w })}
                    onRemove={() => session.removeWidget(w.id)}
                    onStyleChange={(next) => session.setStyle(it.i, next)}
                    onSizeChange={(width, height) => session.setSize(it.i, width, height)}
                    autoHeight={autoIds.has(it.i)}
                    onNaturalHeight={reportHeight(it.i)}
                  />
                </WidgetBoundary>
              </div>
            );
          })}
        </PanelGrid>
      )}
      {empty && editing && (
        <p className="rounded-[var(--radius-card)] border border-dashed border-slate-300 bg-white py-10 text-center text-sm text-slate-500">
          No widgets yet.
        </p>
      )}

      {widgetDialog && (
        <WidgetDialog
          open
          initial={widgetDialog.initial}
          selection={selection}
          followLabel="Follow the dashboard"
          onCancel={() => setWidgetDialog(null)}
          onSubmit={(w) => {
            if (widgetDialog.initial) session.updateWidget(w); else session.addWidget(w);
            setWidgetDialog(null);
          }}
        />
      )}

      <Dialog open={conflict} onClose={() => setConflict(false)}>
        <DialogBanner tone="danger" title="This dashboard was changed by someone else." />
        <p className="text-sm text-slate-600">
          Your changes cannot be saved over theirs. Reload shows the saved dashboard and discards your changes.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={reloading} onClick={() => setConflict(false)}>Keep editing</Button>
          <Button type="button" disabled={reloading} onClick={() => { void reload(); }}>
            {reloading ? 'Reloading…' : 'Reload'}
          </Button>
        </DialogFooter>
      </Dialog>

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Update dashboard"
      />
    </div>
  );
}

/**
 * ONE widget's failure stays in its own card. A widget's failed REQUEST is
 * already its own message (`LOAD_FAILED`); this catches a widget that throws
 * while drawing, which would otherwise take the whole page down to the route's
 * error screen. The error is still reported to the console, not hidden.
 */
class WidgetBoundary extends Component<{ title: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error(`[dashboard] widget "${this.props.title}" failed to draw:`, error);
  }

  render() {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
        <div className="border-b border-slate-200 px-4 py-2.5 text-white" style={{ background: 'var(--band-gradient)' }}>
          <h2 className="truncate text-[0.9375rem] font-bold leading-tight">{this.props.title}</h2>
        </div>
        <p role="alert" className="flex flex-1 items-center justify-center p-4 text-sm text-red-700">{LOAD_FAILED}</p>
      </div>
    );
  }
}
