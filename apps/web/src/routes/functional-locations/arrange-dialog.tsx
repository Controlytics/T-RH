import { useEffect, useState } from 'react';
import { Dialog } from '@/components/ui/dialog';
import { DialogBanner } from './dialog-banner';
import { Button } from '@/components/ui/button';

export interface ArrangeItem {
  id: string;
  name: string;
  /** Shown beside the name so a block and an area are never confused. */
  meta?: string;
}

/**
 * Arrange siblings into a manual display order.
 *
 * Move up / move down rather than drag-and-drop, deliberately. Dragging is
 * nicer with a mouse and unusable without one; this list is short, the
 * operators are often on a shop-floor machine, and an ordering control that a
 * keyboard cannot reach is a control half the plant cannot use. Each button is
 * a real button with a name, so the whole thing works from the keyboard and
 * announces itself.
 *
 * Nothing is written until Save. The list is local until then, so an operator
 * can shuffle freely and back out — reordering is an audited §11 change, and
 * writing one audit row per nudge would bury the decision they actually made
 * under a dozen intermediate ones.
 */
export function ArrangeDialog({
  open, onClose, title, items, onSave,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  items: ArrangeItem[];
  /** Receives the ids in their new order. Should throw to report failure. */
  onSave: (ids: string[]) => Promise<void>;
}) {
  const [list, setList] = useState<ArrangeItem[]>(items);
  const [saving, setSaving] = useState(false);

  // Re-seed whenever the dialog opens or the underlying data changes, so a
  // second open never shows the previous session's half-finished shuffle.
  useEffect(() => { if (open) setList(items); }, [open, items]);

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= list.length) return;
    const next = [...list];
    [next[index], next[target]] = [next[target], next[index]];
    setList(next);
  };

  const dirty =
    list.length !== items.length ||
    list.some((item, i) => item.id !== items[i]?.id);

  const save = async () => {
    setSaving(true);
    try {
      await onSave(list.map((i) => i.id));
      onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose}>
      <DialogBanner
        title={title}
        subtitle="The order they appear on the dashboard and everywhere else they are listed"
      />

      <ol className="max-h-[22rem] space-y-1.5 overflow-y-auto pb-4">
        {list.map((item, i) => (
          <li
            key={item.id}
            className="flex items-center gap-3 rounded-[var(--radius-control)] border border-slate-200 bg-white px-3 py-2"
          >
            {/* The position, so the order is legible without counting rows. */}
            <span className="w-6 shrink-0 text-center text-[0.75rem] font-semibold tabular-nums text-slate-400">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[0.875rem] font-medium text-slate-800">
                {item.name}
              </span>
              {item.meta && (
                <span className="block truncate text-[0.75rem] text-slate-500">{item.meta}</span>
              )}
            </span>
            <span className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => move(i, -1)}
                disabled={i === 0}
                title={`Move ${item.name} up`}
                aria-label={`Move ${item.name} up`}
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 19V5m0 0l-6 6m6-6l6 6" />
                </svg>
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => move(i, 1)}
                disabled={i === list.length - 1}
                title={`Move ${item.name} down`}
                aria-label={`Move ${item.name} down`}
              >
                <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" aria-hidden>
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 5v14m0 0l6-6m-6 6l-6-6" />
                </svg>
              </Button>
            </span>
          </li>
        ))}
      </ol>

      <div className="-mx-6 -mb-6 flex items-center justify-end gap-2 rounded-b-[var(--radius-card)] border-t border-slate-200 bg-slate-50 px-6 py-3">
        <Button type="button" variant="outline" onClick={onClose} disabled={saving}>
          Cancel
        </Button>
        <Button type="button" onClick={save} loading={saving} disabled={!dirty}>
          Save order
        </Button>
      </div>
    </Dialog>
  );
}
