import { useMemo, useState } from 'react';
import { RULE_NODE_GROUPS, RULE_NODE_TYPES, type RuleNodeTypeSpec } from '@digilog/shared';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/cn';
import { groupColorVar } from './types';

/**
 * The node palette (rule chains, 2026-11-04; spec section 11): ThingsBoard's
 * groups in its order and colours, every node BUILT here, each dragged onto
 * the canvas (or clicked / Enter, which places it in the middle of the view).
 *
 * The nodes this system lists but cannot run — later (a feature this system
 * does not have yet) and none (ThingsBoard-only: customers, assets, cloud
 * queues) — are in one collapsed "Not available here" group, shown so nobody
 * looks for them, and cannot be placed.
 */

export const DRAG_MIME = 'application/x-rule-node-type';

function matches(spec: RuleNodeTypeSpec, q: string): boolean {
  if (q === '') return true;
  return spec.label.toLowerCase().includes(q) || spec.description.toLowerCase().includes(q);
}

export function Palette({ onAdd }: { onAdd: (type: string) => void }) {
  const [query, setQuery] = useState('');
  const [closed, setClosed] = useState<Set<string>>(() => new Set(['unavailable']));
  const q = query.trim().toLowerCase();

  const groups = useMemo(() => RULE_NODE_GROUPS.map((g) => ({
    ...g,
    specs: RULE_NODE_TYPES.filter((s) => s.group === g.id && s.status === 'built' && matches(s, q)),
  })), [q]);
  const unavailable = useMemo(() => RULE_NODE_TYPES.filter((s) => s.status !== 'built' && matches(s, q)), [q]);

  const toggle = (id: string) => setClosed((cur) => {
    const next = new Set(cur);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  // While searching, every group with a match is open.
  const isOpen = (id: string) => q !== '' || !closed.has(id);

  return (
    <aside aria-label="Node palette" className="flex h-full min-h-0 flex-col border-r border-slate-200 bg-white">
      <div className="border-b border-slate-200 p-2">
        <Input aria-label="Search nodes" placeholder="Search nodes" value={query} onChange={(e) => setQuery(e.target.value)} className="h-8 text-[0.8125rem]" />
      </div>
      <div className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2">
        {groups.map((g) => g.specs.length > 0 && (
          <section key={g.id} aria-label={g.label}>
            <button
              type="button"
              aria-expanded={isOpen(g.id)}
              onClick={() => toggle(g.id)}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[0.75rem] font-bold uppercase tracking-[0.08em] text-slate-600 hover:bg-slate-50"
            >
              <span aria-hidden className="h-3 w-3 shrink-0 rounded-sm ring-1 ring-black/15" style={{ background: groupColorVar(g.id) }} />
              <span className="flex-1">{g.label}</span>
              <span className="tabular-nums text-slate-400">{g.specs.length}</span>
              <span aria-hidden className="text-slate-400">{isOpen(g.id) ? '▾' : '▸'}</span>
            </button>
            {isOpen(g.id) && (
              <ul className="mt-1 space-y-1">
                {g.specs.map((s) => (
                  <li key={s.id}>
                    <div
                      role="button"
                      tabIndex={0}
                      draggable
                      data-testid="palette-item"
                      data-type={s.id}
                      aria-label={`Add ${s.label}`}
                      title={s.description}
                      onDragStart={(e) => {
                        e.dataTransfer.setData(DRAG_MIME, s.id);
                        e.dataTransfer.effectAllowed = 'move';
                      }}
                      onClick={() => onAdd(s.id)}
                      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onAdd(s.id); } }}
                      className="cursor-grab rounded-md border border-black/10 px-2.5 py-1.5 text-[0.8125rem] font-semibold text-[var(--rc-ink)] shadow-[var(--elev-1)] hover:brightness-95 focus-visible:outline-2 focus-visible:outline-[var(--theme-primary,#2a78d6)] active:cursor-grabbing"
                      style={{ background: groupColorVar(s.group) }}
                    >
                      {s.label}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}
        {unavailable.length > 0 && (
          <section aria-label="Not available here" className="pt-2">
            <button
              type="button"
              aria-expanded={isOpen('unavailable')}
              onClick={() => toggle('unavailable')}
              className="flex w-full items-center gap-2 rounded-md px-1.5 py-1 text-left text-[0.75rem] font-bold uppercase tracking-[0.08em] text-slate-500 hover:bg-slate-50"
            >
              <span aria-hidden className="h-3 w-3 shrink-0 rounded-sm border border-dashed border-slate-400" style={{ background: groupColorVar(null) }} />
              <span className="flex-1">Not available here</span>
              <span className="tabular-nums text-slate-400">{unavailable.length}</span>
              <span aria-hidden className="text-slate-400">{isOpen('unavailable') ? '▾' : '▸'}</span>
            </button>
            {isOpen('unavailable') && (
              <ul className="mt-1 space-y-1">
                {unavailable.map((s) => (
                  <li
                    key={s.id}
                    aria-disabled="true"
                    data-testid="palette-unavailable"
                    data-type={s.id}
                    title={s.description}
                    className={cn('cursor-not-allowed rounded-md border border-dashed border-slate-300 px-2.5 py-1.5 text-[0.8125rem] text-slate-500')}
                    style={{ background: groupColorVar(null) }}
                  >
                    {s.label}
                    <span className="ml-1 text-[0.6875rem] uppercase tracking-wide text-slate-400">{s.status === 'later' ? 'later' : 'none'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        )}
      </div>
    </aside>
  );
}
