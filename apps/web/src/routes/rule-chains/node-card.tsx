import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { RULE_NODE_GROUPS } from '@digilog/shared';
import { cn } from '@/lib/cn';
import type { InputFlowNode, RuleFlowNode } from './flow-mapping';
import { groupColorVar } from './types';

/**
 * The two node kinds on the canvas (rule chains, 2026-11-04).
 *
 * A rule node wears ThingsBoard's group colour (a token, `--rc-group-<group>`,
 * with dark ink) and says three things: its group, its type and its name. A
 * node with NO counterpart here — Unsupported from an import, or a type this
 * system lists as later / none — is grey, names its ThingsBoard class, and says
 * where its messages go. Generator takes no input and Output gives no output
 * (ThingsBoard's `inEnabled` / `outEnabled`), so neither draws that handle.
 *
 * Styled INSIDE the card, never on React Flow's `.react-flow__node` wrapper:
 * React Flow's stylesheet is unlayered and would beat any utility class there.
 */

export const UNSUPPORTED_TOOLTIP = 'No counterpart in this system — messages go to Failure';
const GROUP_LABEL = new Map(RULE_NODE_GROUPS.map((g) => [g.id, g.label]));

export const RuleNodeCard = memo(function RuleNodeCard({ data, selected }: NodeProps<RuleFlowNode>) {
  const { node, spec, tbClass, supported, inspected } = data;
  const takesInput = spec?.id !== 'tb:action:generator';
  const givesOutput = spec?.id !== 'tb:flow:output';
  const debug = node.debugMode !== 'off';
  return (
    <div
      data-testid="rule-node"
      data-node-id={node.id}
      data-node-type={node.type}
      data-unsupported={supported ? undefined : 'true'}
      title={supported ? spec?.description : UNSUPPORTED_TOOLTIP}
      className={cn(
        'rc-node relative w-[12rem] rounded-[10px] border px-3 py-2 text-[var(--rc-ink)] shadow-[var(--elev-1)] transition-shadow',
        supported ? 'border-black/15' : 'border-dashed border-slate-400 text-slate-600',
        selected && 'ring-2 ring-[var(--theme-primary,#2a78d6)] ring-offset-1',
        inspected && !selected && 'ring-2 ring-amber-400 ring-offset-1',
      )}
      style={{ background: supported && spec ? groupColorVar(spec.group) : groupColorVar(null) }}
    >
      {takesInput && <Handle type="target" position={Position.Left} className="rc-handle" />}
      <div className="flex items-center justify-between gap-2">
        {/* The group is the card's colour; the line names the TYPE (ThingsBoard's card does the same). */}
        <span className="truncate text-[0.6875rem] font-bold uppercase tracking-[0.06em] opacity-80" title={spec ? GROUP_LABEL.get(spec.group) : undefined}>
          {supported && spec ? spec.label : spec ? `${spec.label} · not here` : 'Unsupported'}
        </span>
        {debug && (
          <span
            data-testid="node-debug"
            title={node.debugMode === 'all' ? 'Debug: every message in and out' : 'Debug: failures only'}
            className="shrink-0 rounded bg-black/10 px-1 text-[0.625rem] font-bold uppercase"
          >
            {node.debugMode === 'all' ? 'Debug' : 'Debug ✕'}
          </span>
        )}
      </div>
      <div className="mt-0.5 truncate text-[0.9375rem] font-semibold leading-tight">{node.name}</div>
      {!supported && (
        <div className="mt-1 truncate font-mono text-[0.6875rem] text-slate-500" data-testid="node-tb-class">
          {tbClass ?? 'unknown class'}
        </div>
      )}
      {givesOutput && <Handle type="source" position={Position.Right} className="rc-handle" />}
    </div>
  );
});

export const InputNodeCard = memo(function InputNodeCard({ data }: NodeProps<InputFlowNode>) {
  return (
    <div
      data-testid="input-node"
      title="Every message entering this chain starts here. Drag from its right handle to the node it goes to first."
      className="rc-node flex w-[8.5rem] items-center gap-2 rounded-full border border-emerald-700/30 px-4 py-2 text-[var(--rc-ink)] shadow-[var(--elev-1)]"
      style={{ background: 'var(--rc-input)' }}
    >
      <svg className="h-4 w-4 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 16l-4-4m0 0l4-4m-4 4h14m-5 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h7a3 3 0 013 3v1" transform="rotate(180 12 12)" />
      </svg>
      <span className="text-[0.875rem] font-bold">Input</span>
      {!data.connected && <span className="sr-only">(not connected)</span>}
      <Handle type="source" position={Position.Right} className="rc-handle" isConnectable={data.canEdit} />
    </div>
  );
});

export const NODE_TYPES = { ruleNode: RuleNodeCard, chainInput: InputNodeCard };
