import { useId, useState } from 'react';
import type { RuleChainNode } from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useDatetimeFormat } from '@/hooks/use-datetime-format';
import { cn } from '@/lib/cn';
import { ReasonDialog, useChainWrites } from './reason-dialog';
import { DEBUG_POLL_MS, clearRuleDebug, useRuleDebug } from './use-rule-chains';
import type { RuleDebugEvent } from './types';

/**
 * The Debug panel (rule chains, 2026-11-04; spec section 11) — ThingsBoard's
 * node "Debug" tab as a drawer beside the canvas. One node's events (or the
 * whole chain's), NEWEST FIRST: IN / OUT, the relation, the message type, the
 * originator and the time; each row opens to its data, metadata and error.
 * It re-reads every 2 s while open and stops when closed (the panel is not
 * mounted then, so its request key does not exist).
 *
 * The events are the SAVED chain's: a node records only while its debug mode is
 * on in the saved version. Clear deletes them — audited, with a reason.
 */

/** Newest first: by time, then by the event's id (a bigserial, compared as a number). */
export function newestFirst(events: readonly RuleDebugEvent[]): RuleDebugEvent[] {
  const idOf = (e: RuleDebugEvent) => { try { return BigInt(e.id); } catch { return 0n; } };
  return [...events].sort((a, b) => {
    const t = Date.parse(b.ts) - Date.parse(a.ts);
    if (t !== 0) return t;
    const ia = idOf(a);
    const ib = idOf(b);
    return ib > ia ? 1 : ib < ia ? -1 : 0;
  });
}

/**
 * The event's time to the MILLISECOND, in the administered timezone: a trace
 * steps through a message in milliseconds, and the app's time format may stop
 * at minutes. The date is the administered format.
 */
export function debugTime(ts: string, timezone: string | undefined): string {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const opts: Intl.DateTimeFormatOptions = {
    hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3, hour12: false,
  };
  try {
    return new Intl.DateTimeFormat('en-GB', { ...opts, timeZone: timezone || undefined }).format(d);
  } catch {
    // An unknown zone name: the browser's own, rather than nothing.
    return new Intl.DateTimeFormat('en-GB', opts).format(d);
  }
}

const isFailure = (e: RuleDebugEvent) => e.error !== null || (e.relation ?? '').startsWith('Failure');

function Json({ label, value }: { label: string; value: unknown }) {
  return (
    <div className="space-y-0.5">
      <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-slate-500">{label}</p>
      <pre className="max-h-56 overflow-auto rounded-md bg-slate-950 p-2 font-mono text-[0.75rem] leading-5 text-slate-100">
        {typeof value === 'string' ? value : JSON.stringify(value, null, 2)}
      </pre>
    </div>
  );
}

function EventRow({ event, nodeName, showNode }: { event: RuleDebugEvent; nodeName: string; showNode: boolean }) {
  const [open, setOpen] = useState(false);
  const { formatDate, config } = useDatetimeFormat();
  const failed = isFailure(event);
  const id = useId();
  return (
    <li data-testid="debug-event" data-event-id={event.id} className={cn('border-b border-slate-100 px-3 py-2', failed && 'bg-rose-50/60')}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full flex-wrap items-center gap-1.5 text-left"
      >
        <span
          data-testid="debug-direction"
          className={cn(
            'rounded px-1.5 py-0.5 text-[0.6875rem] font-bold',
            event.direction === 'IN' ? 'bg-sky-100 text-sky-800' : 'bg-violet-100 text-violet-800',
          )}
        >
          {event.direction}
        </span>
        {event.relation && (
          <span
            data-testid="debug-relation"
            className={cn(
              'rounded-full px-2 py-0.5 text-[0.6875rem] font-semibold ring-1 ring-inset',
              failed ? 'bg-rose-100 text-rose-800 ring-rose-200' : 'bg-white text-slate-700 ring-slate-200',
            )}
          >
            {event.relation}
          </span>
        )}
        <span className="font-mono text-[0.75rem] font-semibold text-slate-800">{event.msgType}</span>
        <span className="ml-auto text-[0.75rem] tabular-nums text-slate-500" title={event.ts}>
          {formatDate(event.ts)} <span data-testid="debug-time" className="font-semibold text-slate-700">{debugTime(event.ts, config?.timezone)}</span>
        </span>
        <span className="basis-full truncate text-[0.75rem] text-slate-500">
          {showNode && <span className="font-semibold text-slate-700">{nodeName} · </span>}
          {event.originatorType} {event.originatorId}
        </span>
      </button>
      {open && (
        <div id={id} className="mt-2 space-y-2">
          <Json label="Data" value={event.data} />
          <Json label="Metadata" value={event.metadata} />
          {event.error && (
            <div className="space-y-0.5">
              <p className="text-[0.6875rem] font-bold uppercase tracking-wide text-rose-700">Error</p>
              <pre className="whitespace-pre-wrap break-words rounded-md bg-rose-50 p-2 font-mono text-[0.75rem] text-rose-900">{event.error}</pre>
            </div>
          )}
          <p className="font-mono text-[0.6875rem] text-slate-400">message {event.msgId}</p>
        </div>
      )}
    </li>
  );
}

export function DebugPanel({ chainId, nodes, nodeId, onNodeChange, canClear, onClose }: {
  chainId: string;
  /** The SAVED chain's nodes (the events are keyed to them). */
  nodes: readonly RuleChainNode[];
  /** null = every node of the chain. */
  nodeId: string | null;
  onNodeChange: (id: string | null) => void;
  canClear: boolean;
  onClose: () => void;
}) {
  const selectId = useId();
  const { events, error, loading, mutate } = useRuleDebug(chainId, nodeId, true);
  const writes = useChainWrites();
  const [clearing, setClearing] = useState(false);
  const names = new Map(nodes.map((n) => [n.id, n.name]));
  const node = nodeId ? nodes.find((n) => n.id === nodeId) : undefined;
  const rows = newestFirst(events);

  const clear = (reason: string) => writes.run(
    (pw) => clearRuleDebug(chainId, nodeId, reason, pw),
    { done: async () => { setClearing(false); await mutate(); } },
  );

  return (
    <aside aria-label="Debug" data-testid="debug-panel" className="flex h-full min-h-0 flex-col border-l border-slate-200 bg-white">
      <div className="space-y-2 border-b border-slate-200 p-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-[0.9375rem] font-bold text-slate-800">Debug</h2>
          <div className="flex items-center gap-1">
            {canClear && (
              <Button type="button" variant="ghost" size="sm" className="text-rose-600 hover:bg-rose-50" onClick={() => { writes.setError(null); setClearing(true); }}>
                Clear
              </Button>
            )}
            <Button type="button" variant="ghost" size="icon-sm" aria-label="Close debug" onClick={onClose}>×</Button>
          </div>
        </div>
        <label htmlFor={selectId} className="sr-only">Node</label>
        <Select id={selectId} selectSize="sm" value={nodeId ?? ''} onChange={(e) => onNodeChange(e.target.value || null)}>
          <option value="">All nodes</option>
          {nodes.map((n) => <option key={n.id} value={n.id}>{n.name}{n.debugMode === 'off' ? ' (debug off)' : ''}</option>)}
        </Select>
        {node && node.debugMode === 'off' && (
          <p className="text-[0.75rem] text-amber-800">Debug is off for this node in the saved chain. Turn it on in the node&apos;s settings, then save.</p>
        )}
        <p className="text-[0.6875rem] text-slate-400">Newest first · refreshes every {DEBUG_POLL_MS / 1000} s</p>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <p role="alert" className="m-3 rounded-md border border-rose-200 bg-rose-50 p-2 text-sm text-rose-800">Could not load debug events. {error.message}</p>
        ) : rows.length === 0 ? (
          <p className="p-6 text-center text-sm text-slate-500">{loading ? 'Loading…' : 'No debug events.'}</p>
        ) : (
          <ul>
            {rows.map((e) => <EventRow key={e.id} event={e} nodeName={names.get(e.nodeId) ?? e.nodeId} showNode={nodeId === null} />)}
          </ul>
        )}
      </div>
      <ReasonDialog
        open={clearing}
        title="Clear debug events"
        subtitle={node ? node.name : 'Every node of this chain'}
        confirmLabel="Clear events"
        busyLabel="Clearing…"
        danger
        busy={writes.busy}
        error={writes.error}
        onConfirm={clear}
        onClose={() => setClearing(false)}
      />
      <ReauthDialog
        open={writes.reauth.isOpen}
        password={writes.reauth.password}
        error={writes.reauth.error}
        isVerifying={writes.reauth.isVerifying}
        onPasswordChange={writes.reauth.setPassword}
        onConfirm={writes.reauth.confirm}
        onCancel={writes.reauth.cancel}
        actionLabel={writes.actionLabel}
      />
    </aside>
  );
}
