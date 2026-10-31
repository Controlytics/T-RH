/**
 * The per-widget render boundary, shared by BOTH hosts — the home dashboard `/`
 * and a built dashboard `/dashboards/:id` (final fix wave, I-3; until then only
 * the built dashboard had it). A widget's failed REQUEST is already its own
 * message (`LOAD_FAILED`); this catches a renderer that THROWS — the chart
 * models run in the widget's render, outside `ChartBoundary` — so one
 * unreadable widget never blanks a whole dashboard (the spec's anti-goal), and
 * a super admin's unsaved arrangement survives it.
 */
import { Component, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { DialogBanner } from '@/components/ui/dialog-banner';
import { LOAD_FAILED } from './widget-common';

/**
 * A part of the page that throws while drawing is replaced by `fallback`
 * instead of taking the whole page — and an unsaved draft — down to the
 * route's error screen. Used per widget card and around the widget dialog
 * (whose live preview runs the widget's renderer). The error is still
 * reported to the console, not hidden.
 */
export class RenderBoundary extends Component<{ name: string; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: Error) {
    console.error(`[dashboard] ${this.props.name} failed to draw:`, error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

/**
 * ONE widget's failure stays in its own card. While editing it keeps Edit
 * widget and Remove: it replaces the panel and with it those two buttons, and
 * a widget nobody can open or remove could never be cleared from the dashboard.
 */
export function FailedWidgetCard({ title, editing, onEdit, onRemove }: {
  title: string;
  editing: boolean;
  onEdit: () => void;
  onRemove: () => void;
}) {
  return (
    <div data-testid="widget-failed" className="flex h-full flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white">
      <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-2.5 text-white" style={{ background: 'var(--band-gradient)' }}>
        <h2 className="min-w-0 flex-1 truncate text-[0.9375rem] font-bold leading-tight">{title}</h2>
        {editing && (
          <>
            <button
              type="button"
              onClick={onEdit}
              className="shrink-0 rounded-md border border-slate-300 bg-white/90 px-2 py-0.5 text-[0.6875rem] font-semibold text-slate-700 hover:bg-white"
            >
              Edit widget
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="shrink-0 rounded-md border border-red-300 bg-white/90 px-2 py-0.5 text-[0.6875rem] font-semibold text-red-700 hover:bg-red-50"
            >
              Remove
            </button>
          </>
        )}
      </div>
      <p role="alert" className="flex flex-1 items-center justify-center p-4 text-sm text-red-700">{LOAD_FAILED}</p>
    </div>
  );
}

/**
 * The widget dialog's stand-in when its live preview threw. The dialog's own
 * state is gone with it; the page and the draft are not. Remove is offered for
 * an existing widget, whose renderer is what failed.
 */
export function PreviewFailedDialog({ onClose, onRemove }: { onClose: () => void; onRemove?: () => void }) {
  return (
    <Dialog open onClose={onClose}>
      <DialogBanner tone="danger" title="This widget's preview could not be drawn." />
      <p className="text-sm text-slate-600">
        {onRemove
          ? 'It cannot be edited here. Remove it from this dashboard, or close and keep it as it is.'
          : 'Nothing was added.'}
      </p>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Close</Button>
        {onRemove && <Button type="button" variant="destructive" onClick={onRemove}>Remove widget</Button>}
      </DialogFooter>
    </Dialog>
  );
}
