import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import useSWR from 'swr';
import { RULE_CHAIN_NAME_MAX, RULE_NODE_TYPE_BY_ID, type RuleChainDocument } from '@digilog/shared';
import { PageHero } from '@/components/ui/page-hero';
import { Button } from '@/components/ui/button';
import { Dialog, DialogFooter } from '@/components/ui/dialog';
import { DialogBanner } from '@/components/ui/dialog-banner';
import { EmptyState } from '@/components/ui/empty-state';
import { Input } from '@/components/ui/input';
import { LoadError } from '@/components/ui/load-error';
import { SkeletonCard } from '@/components/ui/skeleton';
import { Toggle } from '@/components/ui/toggle';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { RuleChainCanvas, type CanvasApi } from './canvas';
import { DebugPanel } from './debug-panel';
import { ImportDialog } from './import-dialog';
import { downloadChainExport } from './import-export';
import { useLeaveGuard } from './leave-guard';
import { Palette } from './palette';
import { ReasonDialog, refusalText, useChainWrites } from './reason-dialog';
import { RelationPicker, relationChoicesFor } from './relation-picker';
import { NodeSettingsDialog } from './settings-dialog';
import {
  addNodeTo, moveNodesIn, relationsBetween, removeFromDoc, setFirstNodeIn, setPairRelations, updateNodeIn,
  useChainDraft, type ChainDraftState,
} from './use-chain-draft';
import { RULE_CHAINS_KEY, deleteRuleChain, saveRuleChain, useRuleChain } from './use-rule-chains';
import { PATHS, RootBadge, Svg } from './icons';
import { INPUT_NODE_ID, ruleGroupTokens, type RuleChainDetail } from './types';

/**
 * `/rule-chains/:id` — the rule chain editor (rule chains, 2026-11-04; spec
 * section 11): palette, canvas, node settings, link labels, debug.
 *
 * WHAT IS SHOWN is the server's chain (`GET /api/rule-chains/:id`); the
 * editor holds a DRAFT of it (`use-chain-draft.ts`, undo / redo over the last
 * 50 changes). WHO MAY CHANGE IT: a RULE_CHAIN_MANAGE holder
 * (`useCan('rule_chains.manage')`) — presentation; the route's 403 is the
 * control. Save sends the WHOLE draft with the `updatedAt` the draft is BASED
 * on, a reason, inside `reauth.execute('UPDATE_RULE_CHAIN', …)`; it adopts the
 * PUT's answer as the new base. A chain someone else saved since is a 409
 * STALE that writes nothing — the draft stays until the user chooses Reload.
 * A newer version read in the background is adopted only while nothing is
 * unsaved. Leaving with unsaved changes asks first (`leave-guard.ts`).
 */
export function RuleChainEditorPage() {
  const { id } = useParams<{ id: string }>();
  const { chain, notFound, error, mutate } = useRuleChain(id);

  if (notFound) {
    return (
      <div className="rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]">
        <EmptyState
          icon={<Svg d={PATHS.chain} className="h-6 w-6" />}
          title="This rule chain does not exist."
          action={<Link to="/rule-chains" className="text-sm font-semibold text-[var(--theme-primary,#2a78d6)] hover:underline">Back to Rule Chains</Link>}
        />
      </div>
    );
  }
  if (!chain) return error ? <LoadError what="this rule chain" error={error} /> : <SkeletonCard lines={3} />;
  // Keyed by id: the draft, its history and its base belong to ONE chain.
  return <EditorView key={chain.id} chain={chain} mutate={mutate} />;
}

const stateOf = (c: RuleChainDetail): ChainDraftState => ({
  name: c.name,
  reEnterOnRuleNodeWrites: c.reEnterOnRuleNodeWrites,
  document: c.document,
});

type Picker = { from: string; to: string; editing: boolean } | null;
type Dialogs = 'save' | 'delete' | 'chain' | 'import' | null;

/** Free-text suggestions for a node whose relations are named at run time. */
function useRelationSuggestions(picker: Picker, doc: RuleChainDocument): string[] {
  const source = picker ? doc.nodes.find((n) => n.id === picker.from) : undefined;
  const type = source?.type;
  const called = type === 'tb:flow:rule-chain' ? (source?.config as { ruleChainId?: unknown }).ruleChainId : undefined;
  const profiles = useSWR<{ data: { id: string; name: string }[] }>(type === 'tb:filter:device-profile-switch' ? '/api/instrument-profiles' : null);
  const target = useSWR<RuleChainDetail>(typeof called === 'string' && called ? `${RULE_CHAINS_KEY}/${called}` : null);
  return useMemo(() => {
    if (!source) return [];
    if (type === 'tb:filter:device-profile-switch') return (profiles.data?.data ?? []).map((p) => p.name);
    if (type === 'tb:flow:rule-chain') {
      return (target.data?.document.nodes ?? []).filter((n) => n.type === 'tb:flow:output').map((n) => n.name);
    }
    // A Switch: the labels this node already uses on its other links.
    return [...new Set(doc.connections.filter((c) => c.from === source.id).map((c) => c.relation))];
  }, [source, type, profiles.data, target.data, doc.connections]);
}

export function EditorView({ chain, mutate }: {
  chain: RuleChainDetail;
  /** SWR's bound mutate: no argument re-reads; a detail is adopted as it is. */
  mutate: (data?: RuleChainDetail, opts?: { revalidate: boolean }) => Promise<RuleChainDetail | undefined>;
}) {
  const can = useCan();
  const canEdit = can('rule_chains.manage');
  const { toast } = useToast();
  const navigate = useNavigate();
  const writes = useChainWrites();
  const chainNameId = useId();

  /** The stored version the draft is based on, and its `updatedAt` — what Save sends as expected. */
  const [base, setBase] = useState<{ state: ChainDraftState; updatedAt: string }>(() => ({ state: stateOf(chain), updatedAt: chain.updatedAt }));
  const session = useChainDraft(base.state);
  const { draft, dirty } = session;
  const doc = draft.document;
  const guard = useLeaveGuard(dirty);

  const { reset } = session;
  const adopt = useCallback((saved: RuleChainDetail) => {
    const next = { state: stateOf(saved), updatedAt: saved.updatedAt };
    setBase(next);
    reset(next.state);
  }, [reset]);

  // A newer stored version (another editor, a refetch) is adopted only while
  // nothing is unsaved; with unsaved changes the draft keeps its base, so a
  // save over the newer version is refused (409) rather than silent.
  useEffect(() => {
    if (chain.updatedAt === base.updatedAt || dirty) return;
    adopt(chain);
    // `chain` is a new object per fetch; its version is the event.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chain.updatedAt]);

  const [dialog, setDialog] = useState<Dialogs>(null);
  const [picker, setPicker] = useState<Picker>(null);
  // The node whose settings are open, and a counter per open: the dialog is
  // KEYED by both, so each open starts from the node as it is now.
  const [settingsFor, setSettingsFor] = useState<{ id: string; seq: number } | null>(null);
  const settingsSeq = useRef(0);
  const openSettings = (id: string) => { settingsSeq.current += 1; setSettingsFor({ id, seq: settingsSeq.current }); };
  const [selected, setSelected] = useState<string | null>(null);
  const [debugOpen, setDebugOpen] = useState(false);
  const [debugNode, setDebugNode] = useState<string | null>(null);
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [chainName, setChainName] = useState('');
  const [chainReEnter, setChainReEnter] = useState(false);
  const canvasApi = useRef<CanvasApi | null>(null);
  const suggestions = useRelationSuggestions(picker, doc);

  const openDialog = (d: Dialogs) => { writes.setError(null); setDialog(d); };

  // ── Canvas edits — each one undo step ────────────────────────────────────
  const addNode = (type: string, pos: { x: number; y: number }) => {
    const spec = RULE_NODE_TYPE_BY_ID.get(type);
    if (!canEdit || !spec || spec.status !== 'built') return;
    // A drop whose pointer position is not a number (an event without
    // coordinates) lands in the middle of the view: a NaN position would be a
    // node the server's strict parse refuses at Save.
    const at = Number.isFinite(pos.x) && Number.isFinite(pos.y) ? pos : canvasApi.current?.centre() ?? { x: 200, y: 200 };
    session.edit((d) => addNodeTo(d, type, at));
  };
  const addAtCentre = (type: string) => {
    const c = canvasApi.current?.centre() ?? { x: 200, y: 200 };
    // Stagger so repeated clicks do not stack exactly.
    const n = doc.nodes.length % 6;
    addNode(type, { x: c.x - 100 + n * 24, y: c.y - 30 + n * 24 });
  };
  const connect = (from: string, to: string) => {
    if (!canEdit) return;
    // The Input's one link IS the chain's first node; it carries no label.
    if (from === INPUT_NODE_ID) { session.edit((d) => setFirstNodeIn(d, to)); return; }
    const source = doc.nodes.find((n) => n.id === from);
    if (!source) return;
    const choices = relationChoicesFor(source.type);
    if (choices.fixed.length === 0 && !choices.free) return;
    setPicker({ from, to, editing: relationsBetween(doc, from, to).length > 0 });
  };

  const pickerSource = picker ? doc.nodes.find((n) => n.id === picker.from) : undefined;
  const pickerTarget = picker ? doc.nodes.find((n) => n.id === picker.to) : undefined;
  const settingsNode = settingsFor ? doc.nodes.find((n) => n.id === settingsFor.id) ?? null : null;

  // ── Writes ───────────────────────────────────────────────────────────────
  const save = (reason: string) => writes.run(
    (pw) => saveRuleChain(chain.id, {
      name: draft.name.trim(),
      document: draft.document,
      reEnterOnRuleNodeWrites: draft.reEnterOnRuleNodeWrites,
      expectedUpdatedAt: base.updatedAt,
    }, reason, pw),
    {
      done: async (result) => {
        const saved = result as RuleChainDetail;
        // ADOPT the server's answer — the saved chain and its NEW updatedAt —
        // as the base: a re-read could land late, and the next Save would send
        // a stale updatedAt and be refused against this user's own save.
        adopt(saved);
        await mutate(saved, { revalidate: false });
        setDialog(null);
        toast.success('Rule chain saved', `"${saved.name}" saved.`);
      },
      refused: (e) => {
        if ((e as { code?: string })?.code !== 'STALE') return false;
        setDialog(null);
        setConflict(true);
        return true;
      },
    },
  );

  const remove = (reason: string) => writes.run(
    (pw) => deleteRuleChain(chain.id, reason, pw),
    {
      done: () => {
        setDialog(null);
        toast.success('Rule chain deleted', `"${chain.name}" removed.`);
        // The chain is gone: nothing is left to save, so no prompt.
        navigate('/rule-chains');
      },
    },
  );

  const reload = async () => {
    setReloading(true);
    try {
      const fresh = await mutate();
      if (fresh) adopt(fresh);
      setConflict(false);
    } catch (e) {
      toast.error('Could not reload', refusalText(e));
    } finally {
      setReloading(false);
    }
  };

  const exportChain = async () => {
    try {
      const file = await downloadChainExport(chain.id, chain.name);
      toast.success('Exported', dirty
        ? `${file} is the SAVED chain — your unsaved changes are not in it. Credentials are masked.`
        : `${file} — credentials are masked in the file.`);
    } catch (e) {
      toast.error('Could not export', refusalText(e));
    }
  };

  // Ctrl+Z / Ctrl+Shift+Z / Ctrl+Y, outside text fields and dialogs.
  const { undo, redo } = session;
  useEffect(() => {
    if (!canEdit) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const t = e.target as HTMLElement | null;
      if (t && (t.closest('input, textarea, select, [contenteditable="true"]') || t.closest('[role="dialog"]'))) return;
      const k = e.key.toLowerCase();
      if (k === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
      else if ((k === 'z' && e.shiftKey) || k === 'y') { e.preventDefault(); redo(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canEdit, undo, redo]);

  const toolbarBtn = 'font-semibold';
  const gridCols = [canEdit ? '15rem' : null, 'minmax(0,1fr)', debugOpen ? '24rem' : null].filter(Boolean).join(' ');

  return (
    <div className="space-y-3" style={ruleGroupTokens()}>
      <PageHero
        className="py-4"
        title={draft.name}
        icon={<Svg d={PATHS.chain} className="h-5 w-5" />}
        crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Rule Chains', to: '/rule-chains' }, { label: draft.name }]}
        meta={(
          <>
            {chain.root && <RootBadge />}
            {dirty && (
              <span data-testid="unsaved" className="rounded-full bg-amber-300 px-2.5 py-0.5 text-[0.75rem] font-bold text-amber-950">Unsaved changes</span>
            )}
            {!canEdit && <span className="rounded-full bg-white/15 px-2.5 py-0.5 text-[0.75rem] font-semibold text-white ring-1 ring-inset ring-white/30">Read only</span>}
          </>
        )}
        actions={(
          <div className="flex flex-wrap items-center justify-end gap-2">
            {canEdit && (
              <>
                <Button type="button" variant="outline" size="icon-sm" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!session.canUndo} onClick={undo}><Svg d={PATHS.undo} /></Button>
                <Button type="button" variant="outline" size="icon-sm" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!session.canRedo} onClick={redo}><Svg d={PATHS.redo} /></Button>
                <Button
                  type="button" variant="outline" size="sm" className={toolbarBtn}
                  onClick={() => { setChainName(draft.name); setChainReEnter(draft.reEnterOnRuleNodeWrites); openDialog('chain'); }}
                >
                  <Svg d={PATHS.settings} />Chain settings
                </Button>
              </>
            )}
            <Button type="button" variant="outline" size="sm" className={toolbarBtn} aria-pressed={debugOpen} onClick={() => { setDebugOpen((o) => !o); setDebugNode(selected); }}>
              <Svg d={PATHS.bug} />Debug
            </Button>
            <Button type="button" variant="outline" size="sm" className={toolbarBtn} onClick={() => { void exportChain(); }}>
              <Svg d={PATHS.download} />Export
            </Button>
            {canEdit && (
              <>
                <Button type="button" variant="outline" size="sm" className={toolbarBtn} onClick={() => openDialog('import')}>
                  <Svg d={PATHS.upload} />Import
                </Button>
                <Button
                  type="button" variant="outline" size="sm" className={`${toolbarBtn} text-rose-700`}
                  disabled={chain.root}
                  title={chain.root ? 'The root chain cannot be deleted. Make another chain the root first.' : undefined}
                  onClick={() => openDialog('delete')}
                >
                  <Svg d={PATHS.trash} />Delete
                </Button>
                <Button type="button" size="sm" className={toolbarBtn} disabled={!dirty} onClick={() => openDialog('save')}>
                  <Svg d={PATHS.save} />Save
                </Button>
              </>
            )}
          </div>
        )}
      />

      <div
        className="grid h-[calc(100vh-14rem)] min-h-[560px] overflow-hidden rounded-[var(--radius-card)] border border-slate-200 bg-white shadow-[var(--elev-1)]"
        style={{ gridTemplateColumns: gridCols }}
      >
        {canEdit && <Palette onAdd={addAtCentre} />}
        <div className="relative h-full min-h-0 min-w-0">
          <RuleChainCanvas
            document={doc}
            canEdit={canEdit}
            inspectedId={debugOpen ? debugNode : null}
            apiRef={canvasApi}
            onAddNode={addNode}
            onMoveNodes={(moves) => session.edit((d) => moveNodesIn(d, moves))}
            onRemove={(what) => session.edit((d) => removeFromDoc(d, what))}
            onConnect={connect}
            onEditEdge={(from, to) => setPicker({ from, to, editing: true })}
            onOpenNode={openSettings}
            onSelectNode={(id) => { setSelected(id); if (id) setDebugNode(id); }}
          />
          {doc.nodes.length === 0 && (
            <p className="pointer-events-none absolute inset-x-0 top-1/3 text-center text-sm text-slate-500">
              {canEdit ? 'Drag a node from the palette, then connect the Input to it.' : 'This chain has no nodes.'}
            </p>
          )}
        </div>
        {debugOpen && (
          <DebugPanel
            chainId={chain.id}
            nodes={base.state.document.nodes}
            nodeId={debugNode}
            onNodeChange={setDebugNode}
            canClear={canEdit}
            onClose={() => setDebugOpen(false)}
          />
        )}
      </div>

      <RelationPicker
        open={picker !== null}
        sourceType={pickerSource?.type ?? ''}
        sourceName={pickerSource?.name ?? ''}
        targetName={pickerTarget?.name ?? ''}
        existing={picker ? relationsBetween(doc, picker.from, picker.to) : []}
        suggestions={suggestions}
        editing={picker?.editing ?? false}
        readOnly={!canEdit}
        onPick={(relations) => {
          if (picker) session.edit((d) => setPairRelations(d, picker.from, picker.to, relations));
          setPicker(null);
        }}
        onClose={() => setPicker(null)}
      />

      {settingsFor && settingsNode && (
        <NodeSettingsDialog
          key={`${settingsFor.id}:${settingsFor.seq}`}
          node={settingsNode}
          chainId={chain.id}
          readOnly={!canEdit}
          onApply={(patch) => {
            const id = settingsFor.id;
            session.edit((d) => updateNodeIn(d, id, patch));
            setSettingsFor(null);
          }}
          onDelete={() => {
            const id = settingsFor.id;
            session.edit((d) => removeFromDoc(d, { nodeIds: [id] }));
            setSettingsFor(null);
          }}
          onClose={() => setSettingsFor(null)}
        />
      )}

      <Dialog open={dialog === 'chain'} onClose={() => setDialog(null)}>
        <DialogBanner title="Chain settings" subtitle="Saved with the chain" />
        <div className="space-y-4">
          <div className="space-y-1">
            <label htmlFor={chainNameId} className="block text-sm font-semibold text-slate-700">Name</label>
            <Input id={chainNameId} value={chainName} maxLength={RULE_CHAIN_NAME_MAX} onChange={(e) => setChainName(e.target.value)} />
          </div>
          <Toggle
            label="Re-enter on rule-node writes"
            helper="On: what this chain's own nodes save (readings, attributes, alarms) enters the root chain again as a new message. Off by default — the shipped root chain would loop once per key."
            checked={chainReEnter}
            onChange={() => setChainReEnter((v) => !v)}
          />
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setDialog(null)}>Cancel</Button>
          <Button
            type="button"
            disabled={chainName.trim() === ''}
            onClick={() => { session.setMeta({ name: chainName.trim(), reEnterOnRuleNodeWrites: chainReEnter }); setDialog(null); }}
          >
            Apply
          </Button>
        </DialogFooter>
      </Dialog>

      <ReasonDialog
        open={dialog === 'save'}
        title="Save rule chain"
        subtitle={draft.name}
        confirmLabel="Save chain"
        busy={writes.busy}
        error={writes.error}
        onConfirm={save}
        onClose={() => setDialog(null)}
      >
        <p className="text-sm text-slate-600">
          The whole chain is saved and recorded in the audit trail before and after.{chain.root ? ' This is the root chain: every message enters it.' : ''}
        </p>
      </ReasonDialog>

      <ReasonDialog
        open={dialog === 'delete'}
        title="Delete rule chain"
        subtitle={chain.name}
        confirmLabel="Delete rule chain"
        busyLabel="Deleting…"
        danger
        busy={writes.busy}
        error={writes.error}
        onConfirm={remove}
        onClose={() => setDialog(null)}
      >
        <p className="text-sm text-slate-600">
          Its nodes, links and debug events go with it{dirty ? ', and your unsaved changes are discarded' : ''}. A chain another chain calls cannot be deleted. This cannot be undone.
        </p>
      </ReasonDialog>

      {canEdit && (
        <ImportDialog
          open={dialog === 'import'}
          onClose={() => setDialog(null)}
          onImported={(result, importedName) => {
            setDialog(null);
            toast.success('Rule chain imported', `"${importedName}" created as a new chain.`);
            guard.go(`/rule-chains/${result.id}`);
          }}
        />
      )}

      <Dialog open={conflict} onClose={() => setConflict(false)}>
        <DialogBanner tone="danger" title="This rule chain was changed by someone else." />
        <p className="text-sm text-slate-600">
          Your changes cannot be saved over theirs. Reload shows the saved chain and discards your changes.
        </p>
        <DialogFooter>
          <Button type="button" variant="outline" disabled={reloading} onClick={() => setConflict(false)}>Keep editing</Button>
          <Button type="button" disabled={reloading} onClick={() => { void reload(); }}>{reloading ? 'Reloading…' : 'Reload'}</Button>
        </DialogFooter>
      </Dialog>

      <Dialog open={guard.pendingTo !== null} onClose={guard.stay}>
        <DialogBanner tone="danger" title="Leave without saving?" subtitle={draft.name} />
        <p className="text-sm text-slate-600">This chain has unsaved changes. Leaving discards them.</p>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={guard.stay}>Stay</Button>
          <Button type="button" variant="destructive" onClick={guard.leave}>Leave</Button>
        </DialogFooter>
      </Dialog>

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
    </div>
  );
}
