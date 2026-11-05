import { useId, useMemo, useState } from 'react';
import useSWR from 'swr';
import {
  ALL_RECORDS_PARAM, RULE_DEBUG_MODES, RULE_NODE_GROUPS, RULE_NODE_NAME_MAX, RULE_NODE_TYPE_BY_ID,
  type RuleChainNode, type RuleDebugMode,
} from '@digilog/shared';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { DialogBanner } from '@/components/ui/dialog-banner';
import { FormSection } from '@/components/ui/form-section';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { ConfigForm, visibleFieldsFor, type ConfigFormContext } from './config-form';
import { tbClassOf } from './flow-mapping';
import { UNSUPPORTED_TOOLTIP } from './node-card';
import { RULE_CHAINS_KEY, testRuleScript } from './use-rule-chains';
import type { NodePatch } from './use-chain-draft';
import type { RuleChainSummary } from './types';

/**
 * A node's settings (rule chains, 2026-11-04; spec section 11) — opened by a
 * double-click on the canvas: its name, its DEBUG MODE, and its configuration
 * through the generic form. Apply writes the DRAFT (one undo step); nothing
 * reaches the server until the chain is saved, and the server's strict parse
 * is the judge then. Apply checks the configuration with the SAME shared
 * schema first, so a mistake is named here rather than at Save.
 *
 * A node with no counterpart here (Unsupported, later, none) shows its
 * ThingsBoard class and its configuration as imported, read only — it is kept
 * for the export back and sends every message to Failure.
 */

const DEBUG_LABELS: Record<RuleDebugMode, string> = {
  off: 'Off',
  all: 'All messages in and out',
  failures: 'Failures only',
};

export const DEBUG_CAP_CAPTION = 'Debug events are capped per node (Configuration → Rule Engine)';

/** The lists the form's pickers need — fetched only for a node whose fields use them. */
export function useNodeFormContext(node: RuleChainNode | null, chainId: string): ConfigFormContext {
  const types = useMemo(() => new Set((node ? RULE_NODE_TYPE_BY_ID.get(node.type)?.fields ?? [] : []).map((f) => f.type)), [node]);
  const instruments = useSWR<{ data: { id: string; code: string; name?: string | null }[] }>(
    types.has('instrument') ? `/api/instruments?${ALL_RECORDS_PARAM}` : null,
  );
  const templates = useSWR<{ id: string; name: string }[]>(
    types.has('notification-template') ? '/api/notification-settings/templates' : null,
  );
  const roles = useSWR<{ name: string; displayName?: string | null }[]>(types.has('targets') ? '/api/roles/active' : null);
  const users = useSWR<{ data: { id: string; username: string; fullName?: string | null }[] }>(
    types.has('targets') ? `/api/users?${ALL_RECORDS_PARAM}&status=ENABLED` : null,
  );
  const chains = useSWR<{ data: RuleChainSummary[] }>(types.has('chain') ? RULE_CHAINS_KEY : null);
  return {
    instruments: instruments.data?.data,
    templates: templates.error ? null : templates.data,
    roles: roles.data,
    users: users.data?.data,
    chains: chains.data?.data,
    currentChainId: chainId,
    testScript: testRuleScript,
  };
}

/**
 * MOUNTED ONLY WHILE OPEN, and the editor keys it by the node's id plus an
 * open counter (fix round 1, Critical). Its state is seeded ONCE, lazily, from
 * the node it opened on — so every open starts from what the node holds now:
 * never the previous node's values, never an edit that was cancelled, never the
 * empty config of a first render. (It used to stay mounted and copy the node in
 * by an effect after its first render, and the form's local-state fields had
 * already seeded themselves from the empty config: a map field then wrote back
 * only the rows it showed, and adding one header dropped the stored ones.)
 */
export function NodeSettingsDialog({ node, chainId, readOnly, onApply, onDelete, onClose }: {
  node: RuleChainNode;
  chainId: string;
  readOnly: boolean;
  onApply: (patch: NodePatch) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const nameId = useId();
  const debugId = useId();
  const [name, setName] = useState(() => node.name);
  const [debugMode, setDebugMode] = useState<RuleDebugMode>(() => node.debugMode);
  const [config, setConfig] = useState<Record<string, unknown>>(
    () => JSON.parse(JSON.stringify(node.config ?? {})) as Record<string, unknown>,
  );
  const [issues, setIssues] = useState<string[]>([]);
  const context = useNodeFormContext(node, chainId);

  const spec = RULE_NODE_TYPE_BY_ID.get(node.type) ?? null;
  const supported = spec !== null && spec.status === 'built';
  const group = spec ? RULE_NODE_GROUPS.find((g) => g.id === spec.group)?.label : undefined;
  const fields = supported ? visibleFieldsFor(node.type, config) : [];

  const apply = () => {
    const trimmed = name.trim();
    const problems: string[] = [];
    if (trimmed === '') problems.push('Name: required.');
    if (trimmed.length > RULE_NODE_NAME_MAX) problems.push(`Name: at most ${RULE_NODE_NAME_MAX} characters.`);
    if (supported && spec) {
      const parsed = spec.configSchema.safeParse(config);
      if (!parsed.success) {
        for (const issue of parsed.error.issues) {
          const field = spec.fields.find((f) => f.key === issue.path[0]);
          const where = field ? field.label : issue.path.join('.') || 'Configuration';
          problems.push(`${where}: ${issue.message}`);
        }
      }
    }
    if (problems.length > 0) { setIssues(problems); return; }
    onApply(supported ? { name: trimmed, debugMode, config } : { name: trimmed, debugMode });
  };

  return (
    <Dialog open onClose={onClose} className="max-w-3xl">
      <DialogBanner
        title={node.name}
        subtitle={supported && spec ? `${group} · ${spec.label}` : `${spec ? spec.label : 'Unsupported'} · ${tbClassOf(node, spec) ?? 'unknown class'}`}
      />
      <div className="space-y-4">
        {!supported && (
          <div data-testid="unsupported-note" className="space-y-1 rounded-[var(--radius-control)] border border-dashed border-slate-400 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            <p className="font-semibold">{UNSUPPORTED_TOOLTIP}.</p>
            <p className="font-mono text-[0.75rem] text-slate-500">{tbClassOf(node, spec) ?? 'unknown class'}</p>
            {spec?.description && <p className="text-[0.8125rem]">{spec.description}</p>}
          </div>
        )}
        <FormSection title="Node" columns={2}>
          <div className="space-y-1">
            <label htmlFor={nameId} className="block text-[0.8125rem] font-semibold text-slate-700">Name</label>
            <Input id={nameId} value={name} maxLength={RULE_NODE_NAME_MAX} disabled={readOnly} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label htmlFor={debugId} className="block text-[0.8125rem] font-semibold text-slate-700">Debug mode</label>
            <Select id={debugId} value={debugMode} disabled={readOnly} onChange={(e) => setDebugMode(e.target.value as RuleDebugMode)}>
              {RULE_DEBUG_MODES.map((m) => <option key={m} value={m}>{DEBUG_LABELS[m]}</option>)}
            </Select>
            <p className="text-[0.75rem] text-slate-500">{DEBUG_CAP_CAPTION}</p>
          </div>
        </FormSection>
        {supported && spec ? (
          <FormSection title="Configuration" columns={1}>
            <p className="-mt-1 text-[0.8125rem] text-slate-500">{spec.description}</p>
            <ConfigForm
              key={node.id}
              nodeType={node.type}
              fields={fields}
              value={config}
              onChange={setConfig}
              context={context}
              readOnly={readOnly}
            />
          </FormSection>
        ) : (
          <FormSection title="Configuration (as imported)" columns={1}>
            <pre className="max-h-64 overflow-auto rounded-[var(--radius-control)] bg-slate-50 p-3 font-mono text-[0.75rem] text-slate-700">
              {JSON.stringify(node.config, null, 2)}
            </pre>
          </FormSection>
        )}
        {issues.length > 0 && (
          <ul role="alert" className="list-disc space-y-0.5 rounded-[var(--radius-control)] border border-rose-200 bg-rose-50 py-2 pl-7 pr-3 text-sm text-rose-800">
            {issues.map((i) => <li key={i}>{i}</li>)}
          </ul>
        )}
      </div>
      <DialogFooter className="justify-between">
        <div>
          {!readOnly && <Button type="button" variant="ghost" className="text-rose-600 hover:bg-rose-50" onClick={onDelete}>Delete node</Button>}
        </div>
        <div className="flex gap-3">
          <Button type="button" variant="outline" onClick={onClose}>{readOnly ? 'Close' : 'Cancel'}</Button>
          {!readOnly && <Button type="button" onClick={apply}>Apply</Button>}
        </div>
      </DialogFooter>
    </Dialog>
  );
}
