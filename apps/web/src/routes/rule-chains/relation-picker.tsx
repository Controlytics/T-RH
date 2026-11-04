import { useEffect, useMemo, useState } from 'react';
import { RULE_NODE_TYPE_BY_ID, RULE_RELATION_FAILURE, RULE_RELATION_MAX } from '@digilog/shared';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { DialogBanner } from '@/components/ui/dialog-banner';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';

/**
 * The relation picker (rule chains, 2026-11-04; spec section 11): the labels a
 * connection from one node to another carries — ThingsBoard's "Link labels"
 * dialog. Several at once: each label is its own connection in the document,
 * and the message is copied down every one the node returns.
 *
 * What it offers is the SOURCE node TYPE's relation list from the shared
 * catalogue, the list the server's handlers return:
 * - a fixed list (Save time series: Success / Failure; the Message type switch:
 *   every ThingsBoard message-type label, Other and Failure) — those only;
 * - `dynamic` (Switch, Device profile switch, Rule chain — the label is named
 *   at run time by a script, a profile or the called chain's Output nodes) —
 *   Failure, plus FREE TEXT with the page's suggestions;
 * - a node with no counterpart here, or an Unsupported one — Failure only;
 * - Output — nothing: it returns the message to the chain that called this one.
 * A label the node can never return would be a connection no message follows.
 */

export interface RelationChoices {
  fixed: readonly string[];
  free: boolean;
}

export function relationChoicesFor(sourceType: string): RelationChoices {
  const spec = RULE_NODE_TYPE_BY_ID.get(sourceType);
  if (!spec || spec.status !== 'built') return { fixed: [RULE_RELATION_FAILURE], free: false };
  if (spec.relations === 'dynamic') return { fixed: [RULE_RELATION_FAILURE], free: true };
  return { fixed: spec.relations, free: false };
}

/** A list longer than this gets a filter box (the Message type switch has ~45). */
const FILTER_FROM = 8;

export interface RelationPickerProps {
  open: boolean;
  sourceType: string;
  sourceName: string;
  targetName: string;
  /** The labels this pair already carries — chosen when it opens. */
  existing: readonly string[];
  /** Free-text suggestions for a dynamic node (profile names, the called chain's Outputs, labels in use). */
  suggestions?: readonly string[];
  /** Editing a drawn link: an empty choice removes it. A new link needs at least one label. */
  editing?: boolean;
  readOnly?: boolean;
  /** The pair's labels, exactly: fixed ones in the node's order, then custom ones as added. */
  onPick: (relations: string[]) => void;
  onClose: () => void;
}

export function RelationPicker({
  open, sourceType, sourceName, targetName, existing, suggestions = [], editing = false, readOnly = false, onPick, onClose,
}: RelationPickerProps) {
  const choices = useMemo(() => relationChoicesFor(sourceType), [sourceType]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [filter, setFilter] = useState('');
  const [custom, setCustom] = useState('');

  // Fresh on every open: a choice left from the previous link would label a different one.
  useEffect(() => {
    if (!open) return;
    setChosen([...existing]);
    setFilter('');
    setCustom('');
    // `existing` is a new array per render of the page; the open flag is the event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const toggle = (label: string) =>
    setChosen((cur) => (cur.includes(label) ? cur.filter((l) => l !== label) : [...cur, label]));

  const addCustom = (raw: string) => {
    const label = raw.trim().slice(0, RULE_RELATION_MAX);
    if (label === '') return;
    setChosen((cur) => (cur.includes(label) ? cur : [...cur, label]));
    setCustom('');
  };

  const fixedShown = choices.fixed.filter((l) => l.toLowerCase().includes(filter.trim().toLowerCase()));
  const customChosen = chosen.filter((l) => !choices.fixed.includes(l));
  const ordered = [...choices.fixed.filter((l) => chosen.includes(l)), ...customChosen];
  const suggested = suggestions.filter((s) => s.trim() !== '' && !chosen.includes(s) && !choices.fixed.includes(s));
  const nothing = choices.fixed.length === 0 && !choices.free;

  return (
    <Dialog open={open} onClose={onClose} className="max-w-xl">
      <DialogBanner title="Link labels" subtitle={`${sourceName} → ${targetName}`} />
      {nothing ? (
        <p className="text-sm text-slate-600">
          This node returns the message to the rule chain that called this one. It has no outgoing links.
        </p>
      ) : (
        <div className="space-y-4">
          {choices.fixed.length > FILTER_FROM && (
            <Input
              aria-label="Filter labels"
              placeholder="Filter labels"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
          )}
          <div
            role="group"
            aria-label="Relations"
            className="grid max-h-72 grid-cols-1 gap-2.5 overflow-y-auto rounded-[var(--radius-control)] border border-slate-200 p-3 sm:grid-cols-2"
          >
            {fixedShown.map((label) => (
              <Checkbox
                key={label}
                label={label}
                checked={chosen.includes(label)}
                disabled={readOnly}
                onChange={() => toggle(label)}
              />
            ))}
            {fixedShown.length === 0 && <p className="text-sm text-slate-500">No label matches.</p>}
          </div>

          {choices.free && (
            <div className="space-y-2">
              <label htmlFor="relation-custom" className="block text-[0.8125rem] font-semibold text-slate-700">Custom label</label>
              <div className="flex gap-2">
                <Input
                  id="relation-custom"
                  value={custom}
                  maxLength={RULE_RELATION_MAX}
                  disabled={readOnly}
                  placeholder="The name the node returns"
                  onChange={(e) => setCustom(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addCustom(custom); } }}
                />
                <Button type="button" variant="outline" disabled={readOnly || custom.trim() === ''} onClick={() => addCustom(custom)}>
                  Add label
                </Button>
              </div>
              {suggested.length > 0 && (
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-[0.75rem] font-semibold uppercase tracking-wide text-slate-500">Suggested</span>
                  {suggested.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={readOnly}
                      onClick={() => addCustom(s)}
                      className="rounded-full border border-dashed border-slate-300 bg-white px-2.5 py-0.5 text-[0.8125rem] font-medium text-slate-700 hover:border-slate-400 hover:bg-slate-50"
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          <div data-testid="relation-chosen" className="flex min-h-8 flex-wrap items-center gap-1.5">
            <span className="text-[0.75rem] font-semibold uppercase tracking-wide text-slate-500">Chosen</span>
            {ordered.length === 0 && <span className="text-[0.8125rem] italic text-slate-400">none</span>}
            {ordered.map((l) => (
              <span
                key={l}
                className="inline-flex items-center gap-1 rounded-full bg-[var(--surface-tint-2)] px-2.5 py-0.5 text-[0.8125rem] font-semibold text-[var(--theme-primary-dark,#1e3a5f)] ring-1 ring-inset ring-slate-200"
              >
                {l}
                {!readOnly && customChosen.includes(l) && (
                  <Button type="button" variant="ghost" size="chip" aria-label={`Remove ${l}`} onClick={() => toggle(l)}>×</Button>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onClose}>Cancel</Button>
        {!readOnly && !nothing && (
          editing && ordered.length === 0 ? (
            <Button type="button" variant="destructive" onClick={() => onPick([])}>Remove link</Button>
          ) : (
            <Button type="button" disabled={ordered.length === 0} onClick={() => onPick(ordered)}>
              {editing ? 'Save' : 'Add'}
            </Button>
          )
        )}
      </DialogFooter>
    </Dialog>
  );
}
