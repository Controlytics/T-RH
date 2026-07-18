import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { apiClient } from '../../lib/api-client';
import { useReauth } from '../../hooks/use-reauth';
import { ReauthDialog } from '../../components/reauth-dialog';
import { useDatetimeFormat } from '../../hooks/use-datetime-format';
import { StageScanDialog } from './components/stage-scan-dialog';
import { CleaningReasonDialog } from './components/cleaning-reason-dialog';
import { EquipmentDialog } from './components/equipment-dialog';
import { DryerDurationDialog } from './components/dryer-duration-dialog';
import { ChecklistDialog } from './components/checklist-dialog';
import { BlockChangeRequestDialog } from './components/block-change-request-dialog';
import { DryingFiltersPanel } from './components/drying-filters-panel';
import { buildAhuBlockMap, filtersInBlock } from '@/lib/ahu-block-map';
import { useFilterOperationsOfflineCache } from './hooks/use-filter-operations-offline-cache';
import { useRecentSubmissions } from './hooks/use-recent-submissions';
import { CLEANING_STAGES_OPS } from '../../lib/filter-constants';
import { ErrorPopup } from '../../components/ui/error-popup';
import { useOffline } from '../../hooks/use-offline';
import { onSyncEvent } from '../../lib/sync-engine';
import type { FilterInstance, PaginatedResponse } from '../../types/filter';
// Phase 8.6 — shared executor + action-tape resolver + offline-cache helper.
// All graph-walking decisions (next-stage, checklist-after-stage, cache
// rewrites) route through these so client/server stay in lockstep.
import { actionsForStage, getCurrentActions } from '@/lib/action-tape';
import { prettyStage as interlockStageLabel } from '@/lib/stage-approval';
import {
  cacheServerStateResponse,
  recomputeAndCacheFilterState,
} from '@/lib/offline-cache';
// Phase 8.7 Wave-5 split — shared with mobile-operations.tsx.
// PendingChecklist + dialog-resolver + offline-gate + first-stages walker live
// in lib/filter-ops so the two pages cannot drift on these primitives.
import {
  firstStagesFromGraph,
  resolvePendingChecklistDialog,
  findNextPendingChecklist,
  type PendingChecklist,
  type PendingChecklistBatchItem,
} from '@/lib/filter-ops';
// D1/D2/D4 refactor Day 4 (2026-05-18) — useFilterOperationsCore is now
// authoritative. All dialog state lives in core.dialogState; all writes
// go through core.dispatch / core.advance / core.startAndAdvance / core.submitChecklist.
import { useFilterOperationsCore } from '@/lib/filter-ops/use-core';
// Task 7 — AHU completion pre-flight (Remaining Filters dialog).
import { useAhuCompletionMode } from '../../hooks/use-ahu-completion-mode';
import { checkAhuCompletionBatch, checkAhuHasBothSets, isTerminalChecklist } from '../../lib/filter-ops/ahu-completion-check';
import { RemainingFiltersDialog } from './components/remaining-filters-dialog';
import { AhuSetChooserDialog, type FilterSetChoice } from './components/ahu-set-chooser-dialog';

const CLEANING_STAGES = CLEANING_STAGES_OPS;

export function FilterOperationsPage() {
  const navigate = useNavigate();
  const { stageKey: urlStageKey } = useParams<{ stageKey?: string }>();
  // Optional ?ahuId= query param lets other pages (e.g. My Tasks) deep-link
  // here with the list pre-filtered to an AHU's child filters.
  const [searchParams] = useSearchParams();
  const ahuIdFilter = searchParams.get('ahuId');
  const { formatDateTime, formatDate, formatTime } = useDatetimeFormat();
  const reauth = useReauth();
  // ─── D1/D2/D4 Day 4 — useFilterOperationsCore is now authoritative ──────
  const core = useFilterOperationsCore();
  const { online, pendingCount, syncing, executeOrQueue, manualSync, clearQueue, cache, getCache } = useOffline();
  // Task 7: AHU completion mode (NONE / POPUP / INTERLOCK) from config.
  const ahuMode = useAhuCompletionMode();
  const { data: instancesData, error: instancesError } = useSWR<PaginatedResponse<FilterInstance>>('/api/assets/instances', { refreshInterval: online ? 30000 : 0 });
  const { data: templatesData, error: templatesError } = useSWR<PaginatedResponse<{ id: string; name: string }>>('/api/assets/templates');
  const { data: identifiersData } = useSWR<any[]>(online ? '/api/assets/identifiers' : null);
  // A-01 cluster Step 4 (2026-05-29): primary data source is the typed
  // hierarchy endpoints. Filter rows include the four cycle-state fields
  // (currentLifecycleState / currentCycleId / filterProfileId / filterSet)
  // because hierarchy.service.ts.listFilters LEFT JOINs FilterDetails
  // (Tier 1.6 unblock). The two legacy SWR calls above remain ONLY to feed
  // useFilterOperationsOfflineCache, which still primes the legacy mixed-kind
  // `filters` IDB store + offlineInstances/Templates that mobile-wrapper +
  // mobile-operations consume. Steps 5-6 migrate those consumers; Step 7
  // drops the legacy SWR + cache entirely.
  const { data: typedFiltersResp, error: typedFiltersError } = useSWR<PaginatedResponse<any>>(
    '/api/hierarchy/filters',
    { refreshInterval: online ? 30000 : 0 },
  );
  const { data: typedBlocksResp, error: typedBlocksError } = useSWR<PaginatedResponse<any>>(
    '/api/hierarchy/blocks',
  );
  // AHU→block resolution for the Dry In panel (scopes drying filters to the
  // selected block). Filter rows carry only ahuId; these give ahu.blockId /
  // area.blockId. Online-only — the panel's countdowns need the server anyway.
  const { data: ahusResp } = useSWR<PaginatedResponse<any>>(online ? '/api/hierarchy/ahus' : null);
  const { data: areasResp } = useSWR<PaginatedResponse<any>>(online ? '/api/hierarchy/areas' : null);
  const ahuBlockMap = useMemo(
    () => buildAhuBlockMap(ahusResp?.data ?? [], areasResp?.data ?? []),
    [ahusResp, areasResp],
  );
  const { data: reasonsData } = useSWR<any>(online ? '/api/filters/reasons' : null);
  const { data: equipGroupsData } = useSWR<any>(online ? '/api/equipment-groups' : null);
  const isMobile = typeof window !== 'undefined' && !!(window as any).Capacitor?.isNativePlatform?.();

  // Phase 2 of the offline-tier extraction: offline cache state + 9 priming
  // effects live in the hook so this file isn't fighting offline-cache
  // bookkeeping in the middle of cycle-write logic.
  const {
    // A-01 Step 4: offlineInstances/offlineTemplates no longer consumed in
    // this file's derivations — typed caches replace them. They remain in
    // the hook for mobile-wrapper + mobile-operations (Steps 5-6).
    offlineBlocks,
    offlineFiltersTyped,
    offlineDataLoaded,
    refreshOfflineInstances,
  } = useFilterOperationsOfflineCache({
    online,
    instancesData,
    templatesData,
    reasonsData,
    equipGroupsData,
    identifiersData,
  });

  const [mode, setMode] = useState<'operations' | 'status'>('operations');
  const [activeStage, setActiveStage] = useState<typeof CLEANING_STAGES[0] | null>(null);
  const [selectedStatusStage, setSelectedStatusStage] = useState<string | null>(null);
  const [step, setStep] = useState<'block' | 'scan'>('block');
  const [selectedBlock, setSelectedBlock] = useState<any>(null);
  const [scanValue, setScanValue] = useState('');
  const [remarks, setRemarks] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [popupError, setPopupError] = useState('');
  // B7.4 (2026-05-02): advisory shown when admin edited the cycle's pinned
  // EquipmentGroup mid-cycle. Persistent (no auto-clear) — operator can keep
  // working on the pinned ranges, but should know the live group has moved.
  // Cleared on closeDialog / clearScanState / stage change.
  const [equipmentGroupSyncWarning, setEquipmentGroupSyncWarning] = useState<{
    groupId: string;
    pinnedVersion: number;
    liveVersion: number;
    recommendation: 'CONTINUE_OR_TERMINATE_AND_RESTART';
  } | null>(null);
  // Stage interlock — when the current stage (Wash Out / Dry Out) is awaiting QA
  // approval, the server drops the advance action from the tape; this surfaces WHY.
  const [interlock, setInterlock] = useState<{
    gatedStage: boolean;
    stageKey: string | null;
    status: string | null;
    approvalId: string | null;
    approverRole: string | null;
    blocksLeaving: boolean;
  } | null>(null);
  const { recentSubmissions, record: recordSubmission } = useRecentSubmissions();
  const [submitting, setSubmitting] = useState(false); // double-submit guard

  // Scan queue (batch mode)
  const [scanQueue, setScanQueue] = useState<Array<{ filterId: string; filterName: string; tagId: string }>>([]);
  const [addingToQueue, setAddingToQueue] = useState(false);
  // Snapshot of queue while a shared dialog (reason/duration/equipment/checklist) is open
  const [pendingBatch, setPendingBatch] = useState<Array<{ filterId: string; filterName: string }> | null>(null);

  // ─── Dialog state — owned by useFilterOperationsCore (D1/D2/D4 Day 4) ───
  // The six imperative useState hooks below are replaced by compat aliases
  // that narrow core.dialogState. JSX reads unchanged; all writes route
  // through core.dispatch / core.advance / core.startAndAdvance /
  // core.submitChecklist so the D4 clobber-races are no longer expressible.
  // Capture narrowed state once so TypeScript's type narrowing holds inside
  // each compat alias (ternary RHS resets the narrowing).
  const _ds = core.dialogState;
  const reasonDialog = _ds.kind === 'awaiting_reason'
    ? {
        filterId: _ds.filterId,
        filterName: _ds.filterName,
        stage: CLEANING_STAGES.find(s => s.key === _ds.stage) as typeof CLEANING_STAGES[0],
        block: selectedBlock ? { id: selectedBlock.id, name: selectedBlock.name } : undefined,
      }
    : null;
  const checklistDialog = _ds.kind === 'awaiting_checklist'
    ? {
        filterId: _ds.filterId,
        filterName: _ds.filterName,
        checklists: _ds.checklists as PendingChecklist[],
      }
    : null;
  const equipmentDialog = _ds.kind === 'awaiting_equipment'
    ? {
        filterId: _ds.filterId,
        filterName: _ds.filterName,
        stage: CLEANING_STAGES.find(s => s.key === _ds.stage) as typeof CLEANING_STAGES[0],
        groups: _ds.groups as any[],
        cycleEquipmentGroup: _ds.cycleGroup,
        block: selectedBlock ? { id: selectedBlock.id, name: selectedBlock.name } : undefined,
      }
    : null;
  const dryerDialog = _ds.kind === 'awaiting_dryer'
    ? {
        filterId: _ds.filterId,
        filterName: _ds.filterName,
        block: selectedBlock ? { id: selectedBlock.id, name: selectedBlock.name } : undefined,
      }
    : null;
  const blockChangeDialog = _ds.kind === 'awaiting_block_change'
    ? _ds
    : null;

  const [reasonError, setReasonError] = useState('');
  // PM-due context for the reason dialog: pre-select PM + show the PM banner.
  const [pmReasonCtx, setPmReasonCtx] = useState<{ pmDue: boolean; defaultReasonKey?: string }>({ pmDue: false });

  // Toast notification (appears at top, auto-dismisses)
  const [toast, setToast] = useState<{ type: 'success' | 'error'; message: string } | null>(null);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); } }, [toast]);

  // Checklist state (loading/error remain local; dialog state is in core)
  const [checklistLoading, setChecklistLoading] = useState(false);
  const [checklistError, setChecklistError] = useState('');

  // Equipment group & instrument readings state (loading/error remain local)
  const [equipmentError, setEquipmentError] = useState('');
  const [equipmentLoading, setEquipmentLoading] = useState(false);

  // Dryer duration state (loading/error remain local)
  const [dryerLoading, setDryerLoading] = useState(false);
  const [dryerError, setDryerError] = useState('');

  // Block change request state (reason/submitting remain local)
  const [blockChangeReason, setBlockChangeReason] = useState('');
  const [blockChangeSubmitting, setBlockChangeSubmitting] = useState(false);
  // 2026-06-09: block-change approval replaced by an operator self-confirm. Filters
  // the operator confirmed for cross-block cleaning (start payload sends
  // acknowledgeBlockChange=true so the backend lets the cycle start in that block).
  const ackedBlockFiltersRef = useRef<Set<string>>(new Set());
  // 2026-06-09: cross-block mode is configurable (config block-change-approval.mode):
  // CONFIRM = operator self-confirm; APPROVAL = submit a request an approver approves.
  // Reads the authenticated-only /current mirror — the SUPER_ADMIN-gated
  // dynamic route 403'd for every operator role, silently defaulting to CONFIRM.
  // NONE needs no branch here: the dialog only opens when the SERVER reports
  // blockChangeStatus CONFIRM/REQUIRED, and under NONE current-state.ts reports
  // MATCH. This mode only picks the wording/flow once a dialog is warranted.
  const { data: bcCfg } = useSWR<any>('/api/config/block-change-approval/current');
  const blockChangeMode: 'CONFIRM' | 'APPROVAL' = bcCfg?.mode === 'APPROVAL' ? 'APPROVAL' : 'CONFIRM';
  // Saved cycle-start payload when equipment dialog is opened before cycle is started (offline flow)
  const [pendingCyclePayload, setPendingCyclePayload] = useState<Record<string, any> | null>(null);
  // Task 7 + 2026-07-02: AHU remaining-filters dialog state + Promise resolve ref.
  // ahus = one card per AHU in the batch (multi-AHU carousel).
  const [ahuDialogState, setAhuDialogState] = useState<{
    mode: 'POPUP' | 'INTERLOCK';
    ahus: { ahuName: string; allAtFinal: boolean; filters: { id: string; name: string; stage: string; done: boolean }[] }[];
    currentFilterIds: string[];
  } | null>(null);
  const ahuDialogResolveRef = useRef<((proceed: boolean) => void) | null>(null);
  // 2026-07-03: filter-set chooser shown BEFORE the AHU popup. The choice
  // scopes the status check AND rides in the submit body via ahuSetChoiceRef.
  const [ahuSetChooser, setAhuSetChooser] = useState<boolean>(false);
  const ahuSetResolveRef = useRef<((set: FilterSetChoice | null) => void) | null>(null);
  const ahuSetChoiceRef = useRef<FilterSetChoice | null>(null);

  // If SWR fetch failed (network error), treat as offline — use cached data.
  // A-01 Step 4: include typed-hierarchy errors so the typed source's network
  // failure cleanly drops to offlineFiltersTyped/offlineBlocks fallback.
  const swrFailed = !!(instancesError || templatesError || typedFiltersError || typedBlocksError);
  // Loading gate: prefer typed-hierarchy presence. Legacy SWR no longer
  // gates render — it stays only as cache-hook input. Offline branch waits
  // for IDB load (which now includes the typed-kind stores) as before.
  const isLoading = (!swrFailed && online)
    ? (!typedFiltersResp || !typedBlocksResp)
    : !offlineDataLoaded;

  // A-01 Step 4 (2026-05-29): primary source is the typed hierarchy endpoint.
  // FilterDetails join (Tier 1.6) provides currentLifecycleState, filterSet,
  // currentCycleId, filterProfileId on each row — the four fields the stage
  // counter / status drilldown / Set A/B labels / offline cycle-state fallback
  // depend on. Falls back to offlineFiltersTyped when SWR hasn't responded
  // (first paint / disconnect). The previous filterTemplateIds Set +
  // template.templateKind name-substring heuristic is gone: cache_filters_typed
  // is kind-scoped by design — no discrimination needed (see [[template-kind-
  // heuristic-bug-class]] memory). Same applies to `blocks` below.
  const typedFilters = (typedFiltersResp?.data ?? offlineFiltersTyped ?? []) as any[];
  const typedBlocks  = (typedBlocksResp?.data  ?? offlineBlocks         ?? []) as any[];

  // `instances` alias kept for the offline cycle-state fallback at the
  // /current-state catch branch (~line 472) which does instances.find(byId).
  // Shape-compatible with typedFilters per Tier 1.6 join.
  const instances = typedFilters;

  const allFilters = typedFilters.filter((f: any) => {
    if (f.isActive === false || f.status === 'Retired') return false;
    if (ahuIdFilter && f.ahuId !== ahuIdFilter) return false;
    return true;
  });

  const filterStateMap = useMemo(() => {
    const map: Record<string, { state: string; name: string; set: string; id: string }> = {};
    allFilters.forEach((f) => {
      if (f.currentLifecycleState) {
        map[f.id] = { state: f.currentLifecycleState, name: f.name, set: f.filterSet ?? '', id: f.id };
      }
    });
    return map;
  }, [allFilters]);

  const stageCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    Object.values(filterStateMap).forEach(f => {
      counts[f.state] = (counts[f.state] ?? 0) + 1;
    });
    return counts;
  }, [filterStateMap]);

  const filtersInStage = useMemo(() =>
    selectedStatusStage
      ? Object.values(filterStateMap).filter(f => f.state === selectedStatusStage)
      : [],
    [filterStateMap, selectedStatusStage]
  );

  const refreshFilters = useCallback(() => {
    // A-01 Step 4: invalidate typed-hierarchy SWR (primary source) AND the
    // legacy /api/assets/instances key (still feeds the offline cache hook
    // for the legacy mixed `filters` IDB store until Step 7).
    mutate('/api/hierarchy/filters');
    mutate('/api/hierarchy/blocks');
    mutate('/api/assets/instances');
  }, []);

  // A-01 Step 4: blocks come direct from the typed-hierarchy endpoint. The
  // previous `templates.find(BLOCK)?.id` + instance-template-match heuristic
  // is gone — cache_blocks is kind-scoped.
  const blocks = typedBlocks.filter((b: any) => b.isActive !== false);

  const handleStageClick = (stage: typeof CLEANING_STAGES[0]) => {
    navigate(`/filters/stage/${stage.key}`);
  };

  const handleBlockSelect = (block: any) => {
    // B7.4 follow-up (Issue #1): clear stale advisory when switching blocks
    // intra-stage. The equipmentGroupSyncWarning was bound to the previously
    // scanned filter on the previously selected block; once the operator
    // moves to a different block it no longer applies and would leak onto
    // the next scan view until the next current-state response replaces it.
    setEquipmentGroupSyncWarning(null);
    setSelectedBlock(block);
    setStep('scan');
  };

  // Clear scan state without navigating (used when handing off to sub-dialogs)
  const clearScanState = () => {
    setScanValue(''); setRemarks(''); setError(''); setScanQueue([]); setEquipmentGroupSyncWarning(null);
  };
  // Close stage screen and go back to landing
  const closeDialog = () => {
    setActiveStage(null); setSelectedBlock(null); setScanValue(''); setRemarks(''); setError(''); setScanQueue([]); setEquipmentGroupSyncWarning(null);
    core.dispatch({ type: 'close' });
    navigate('/filters');
  };

  // Sync URL stageKey → activeStage
  useEffect(() => {
    if (!urlStageKey) {
      setActiveStage(null);
      return;
    }
    const stage = CLEANING_STAGES.find(s => s.key === urlStageKey);
    if (!stage) { navigate('/filters'); return; }
    setActiveStage(stage);
    setError(''); setScanValue(''); setRemarks(''); setEquipmentGroupSyncWarning(null);
    if (stage.needsBlock) { setStep('block'); setSelectedBlock(null); }
    else { setStep('scan'); setSelectedBlock(null); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [urlStageKey]);

  // Resolve a tag/name → filterId+name
  // Uses API when online, cached identifier map when offline
  const resolveFilter = async (tagOrName: string): Promise<{ filterId: string; filterName: string } | null> => {
    let trimmed = tagOrName.trim().toUpperCase();
    // RFID dedup: reader may send the same tag 2x or 3x concatenated
    if (trimmed.length >= 6 && trimmed.length % 2 === 0) {
      const half = trimmed.length / 2;
      if (trimmed.substring(0, half) === trimmed.substring(half)) trimmed = trimmed.substring(0, half);
    }
    if (trimmed.length >= 9 && trimmed.length % 3 === 0) {
      const third = trimmed.length / 3;
      if (trimmed.substring(0, third) === trimmed.substring(third, third * 2) && trimmed.substring(0, third) === trimmed.substring(third * 2)) trimmed = trimmed.substring(0, third);
    }
    if (!trimmed) return null;

    // 1. Try API lookup (works when online) — authoritative for reassigned tags.
    try {
      const lookup = await apiClient.get<any>(`/api/assets/identifiers/lookup/${encodeURIComponent(trimmed)}`);
      if (lookup?.asset?.id) {
        const resolved = { filterId: lookup.asset.id as string, filterName: lookup.asset.name as string };
        // Self-heal the offline cache so a later offline scan of this (possibly
        // just-reassigned) tag resolves to the CURRENT filter, not a stale one.
        try {
          const m = (await getCache<Record<string, { filterId: string; filterName: string }>>('identifier-map')) || {};
          m[trimmed] = resolved; m[trimmed.toUpperCase()] = resolved; m[trimmed.toLowerCase()] = resolved;
          await cache('identifier-map', m);
        } catch { /* best-effort cache write */ }
        return resolved;
      }
    } catch { /* offline or network error — fall through */ }

    // 2. Try cached identifier map (works offline — built from identifiers API and stored in IndexedDB)
    try {
      const identifierMap = await getCache<Record<string, { filterId: string; filterName: string }>>('identifier-map');
      if (identifierMap) {
        const entry = identifierMap[trimmed] || identifierMap[trimmed.toUpperCase()] || identifierMap[trimmed.toLowerCase()];
        if (entry) return entry;
      }
    } catch { /* IndexedDB error — fall through */ }

    // 3. Try matching by filter name
    const match = instances.find((a: any) => a.name?.toLowerCase() === trimmed.toLowerCase());
    if (match) return { filterId: match.id, filterName: match.name };
    return null;
  };

  const handleAddToQueue = async (tagOrName: string) => {
    if (addingToQueue) return;
    setAddingToQueue(true); setError('');
    try {
      const resolved = await resolveFilter(tagOrName);
      if (!resolved) {
        setError(`Filter not found: ${tagOrName}`);
        setAddingToQueue(false);
        return;
      }
      if (scanQueue.some(q => q.filterId === resolved.filterId)) {
        setError(`${resolved.filterName} already in queue`);
        setAddingToQueue(false);
        return;
      }
      setScanQueue(prev => [...prev, { ...resolved, tagId: tagOrName }]);
    } catch (e: any) {
      setError(e.message ?? 'Failed to add to queue');
    }
    setAddingToQueue(false);
  };

  const handleRemoveFromQueue = (filterId: string) => {
    setScanQueue(prev => prev.filter(q => q.filterId !== filterId));
  };

  // Loop the batch advancing each filter with shared params
  const advanceBatch = async (
    batch: Array<{ filterId: string; filterName: string }>,
    extraBody: Record<string, any>,
    overrideTargetState?: string,
  ) => {
    if (!activeStage) return;
    const stageLabel = activeStage.label;
    const blockId = selectedBlock?.id;
    const blockName = selectedBlock?.name;
    let success = 0;
    const failed: string[] = [];
    const newSubmissions: Array<{stage: string; filter: string; block?: string; time: string}> = [];
    for (const item of batch) {
      try {
        const { executed } = await executeOrQueue('advance', item.filterId, item.filterName, {
          targetState: overrideTargetState ?? activeStage.key,
          cleaningAreaId: blockId,
          remarks: remarks || `${stageLabel} - Batch - ${item.filterName}`,
          ...extraBody,
        }, overrideTargetState ?? activeStage.key);
        success++;
        // Update cached pipeline state after offline advance.
        // Deep-review fix D3: pass blockId so the offline cycle stub records cleaningAreaId.
        if (!executed) await recomputeAndCacheFilterState(item.filterId, overrideTargetState ?? activeStage.key, false, blockId ?? null);
        newSubmissions.push({ stage: stageLabel + (executed ? '' : ' (queued)'), filter: item.filterName, block: blockName, time: formatTime(new Date()) });
      } catch (e: any) {
        if ((e.code === 'BLOCK_CHANGE_CONFIRM' || e.code === 'BLOCK_CHANGE_REQUIRED') && e.connectionInfo) {
          core.dispatch({
            type: 'open_block_change',
            filterId: e.connectionInfo.filterId ?? item.filterId,
            filterName: item.filterName,
            homeBlockId: e.connectionInfo.homeBlockId,
            homeBlockName: e.connectionInfo.homeBlockName,
            requestedBlockId: e.connectionInfo.requestedBlockId,
            requestedBlockName: e.connectionInfo.requestedBlockName,
          });
          setBlockChangeReason('');
          failed.push(`${item.filterName}: Block change approval required`);
        } else {
          failed.push(`${item.filterName}: ${e.message ?? 'failed'}`);
        }
      }
    }
    recordSubmission(newSubmissions);
    refreshFilters();
    // Gap 20: Refresh offline cached data after queued operations
    if (newSubmissions.some(s => s.stage.includes('queued'))) {
      refreshOfflineInstances();
    }
    // Offline parity: if pipeline prescribes a checklist after this stage,
    // pop the dialog so the operator can complete it (matches mobile behavior,
    // blocks further advance). Phase 8.7: gate via the action tape (Tier-1
    // server actions[] when present, else local executor over the
    // just-rewritten cache row). Fall back to the helper that reads the
    // cached dialog payload when the tape can't surface questions inline
    // (legacy server response without TAPE_PARALLEL).
    //
    // Multi-filter cycling (PHASE_5_RECENT_WORK.md § 11 fix): EVERY filter in
    // the batch may have its own pending checklist (different cleaning
    // profiles → different CHECKLIST nodes). We open the dialog for the
    // first such filter and stash the rest in `postAdvanceChecklistQueue`;
    // `handleChecklistSubmit` walks the queue after each submit so no
    // checklist gate is ever silently skipped. Pre-fix the loop took only
    // the first item and dropped the rest.
    if (batch.length > 0 && newSubmissions.some(s => s.stage.includes('queued'))) {
      try {
        // Phase 8.7 Wave-5 helper. Tier-1 server actions (when emitted)
        // → Tier-2 local executor → Tier-3 cached pending payload fallback.
        // Returns null when no dialog is needed.
        const cycleBatch: PendingChecklistBatchItem[] = batch.map(b => ({
          filterId: b.filterId,
          filterName: b.filterName,
        }));
        const next = await findNextPendingChecklist(cycleBatch, resolvePendingChecklistDialog);
        if (next) {
          // AHU pre-flight BEFORE the (terminal) checklist opens (whole batch).
          if ((await gateAhuBeforeChecklist(cycleBatch.map(b => b.filterId))) === 'proceed') {
            core.dispatch({
              type: 'open_checklist',
              filterId: next.item.filterId,
              filterName: next.item.filterName,
              checklists: next.checklists,
              remainingBatch: next.remaining,
            });
            setChecklistError('');
          }
        }
      } catch { /* ignore */ }
    }
    if (failed.length > 0 && !blockChangeDialog) {
      setPopupError(`${success} succeeded, ${failed.length} failed:\n${failed.join('\n')}`);
    } else if (failed.length === 0) {
      setToast({ type: 'success', message: `${success} filter(s) → ${stageLabel}` });
    }
  };


  const handleSubmitBatch = async () => {
    if (scanQueue.length === 0 || !activeStage || submitting) return;
    setLoading(true); setSubmitting(true); setError('');
    try {
      // Try to inspect first filter's state to decide which dialog to show.
      // When offline, skip state inspection and queue the advance directly.
      const first = scanQueue[0];
      // Try to get filter state from API; if offline, build from cached data
      let state: any = null;
      const csQuery = selectedBlock?.id ? `?cleaningAreaId=${encodeURIComponent(selectedBlock.id)}` : '';
      try {
        state = await apiClient.get<any>(`/api/filters/${first.filterId}/current-state${csQuery}`);
        // Cache the full state for offline use (Phase 8.7: route through helper
        // so the legacy mirror field names live only in offline-cache.ts).
        await cacheServerStateResponse(first.filterId, state);
      } catch (fetchErr: any) {
        const msg = String(fetchErr?.message || '').toLowerCase();
        const isNetErr = (fetchErr instanceof TypeError && msg.includes('fetch'))
          || msg.includes('failed to fetch') || msg.includes('networkerror')
          || msg.includes('load failed') || msg.includes('econnrefused');
        if (!isNetErr) throw fetchErr;

        // ===== OFFLINE PATH =====
        // Use the LAST CACHED current-state response for this filter.
        // This was cached during the previous online session when handleSubmitBatch
        // or the pre-cache loop fetched /current-state successfully.
        const cachedFilter = instances.find((f: any) => f.id === first.filterId);
        const cachedState = await getCache<any>(`filter-state-${first.filterId}`);

        if (cachedState) {
          // We have a full cached state from a previous online fetch — use it directly
          state = {
            ...cachedState,
            currentState: cachedFilter?.currentLifecycleState ?? cachedState.currentState ?? null,
            currentCycle: cachedState.currentCycle ?? (cachedFilter?.currentCycleId ? { id: cachedFilter.currentCycleId } : null),
            blockChangeStatus: null,
          };
        } else {
          // No cached state at all — we CANNOT safely determine the pipeline.
          // Use minimal state: check if filter has a cycle, and let the server
          // validate everything on sync.
          const hasCycle = !!cachedFilter?.currentCycleId;
          // Phase 8.7: legacy mirror fields omitted — gate sites below resolve
          // via the action tape (Tier-3 empty-tape fallback when no cached
          // graph), which produces the same "refuse the op offline without
          // cache" outcome the legacy reads of those fields would have.
          state = {
            currentState: cachedFilter?.currentLifecycleState || null,
            currentCycle: hasCycle ? { id: cachedFilter.currentCycleId } : null,
            equipmentGroup: null,
            isPmDue: false,
            pmReasonKey: null,
            blockChangeStatus: null,
          };

          // Try to resolve equipment group from cached groups for this block
          if (selectedBlock?.id) {
            try {
              const cachedGroups = await getCache<any[]>('equipment-groups') ?? [];
              const blockGroups = cachedGroups.filter((g: any) => g.blockId === selectedBlock.id);
              if (blockGroups.length === 1) state.equipmentGroup = blockGroups[0];
            } catch { /* ignore */ }
          }
        }
      }

      // B7.4 (2026-05-02): surface the equipmentGroupSyncWarning advisory if
      // the server reported one. Online responses include it; offline-built
      // state does not, so this clears any stale value when offline.
      setEquipmentGroupSyncWarning(state.equipmentGroupSyncWarning ?? null);
      // Stage interlock state (online responses only; offline state omits it).
      setInterlock(state.interlock ?? null);

      // ─── STRICT OFFLINE GATE (parity with mobile) ─────────────────────────
      // Without cached pipeline data we cannot enforce stage ordering — refuse
      // the operation explicitly rather than silently letting it through.
      //
      // Phase 8.6 part 2: reachability decisions read the action tape (server
      // actions[] when TAPE_PARALLEL=true, else executor.computeNextActions
      // resolved by getCurrentActions()). Both new-cycle entry points and
      // in-cycle reachability come from the SAME tape — the same one the
      // server emits and the FE caches.
      const resolvedActions = await getCurrentActions(first.filterId, state.actions);
      const advanceTargets = resolvedActions
        .filter(a => a.type === 'ADVANCE_TO_STAGE' || a.type === 'SET_DRYER_DURATION')
        .map(a => (a as { params: { targetState: string } }).params.targetState);

      if (!online) {
        const hasGraph = !!state.pipelineGraph?.stages;
        const hasLinearPipeline = (state.pipelineStages?.length ?? 0) > 0;
        const hasValidation = hasGraph || hasLinearPipeline || advanceTargets.length > 0;

        if (!hasValidation) {
          setPopupError(`${first.filterName}: offline data not cached. Connect to network and re-sync before retrying.`);
          setLoading(false); setSubmitting(false);
          return;
        }

        // OFFLINE cross-block: never blocks (no confirm, no approval per config).
        // Just show an informational notice that the filter belongs elsewhere and
        // let the operation queue; the server auto-passes the offline replay.
        if (state.homeBlock && selectedBlock?.id && state.homeBlock.id !== selectedBlock.id) {
          setToast({ type: 'success', message: `Note: ${first.filterName} belongs to ${state.homeBlock.name}, not ${selectedBlock.name}. Recorded offline.` });
        }

        const cycleInProgress = !!state.currentCycle;
        // New cycle: activeStage must be a legal entry point. The action tape
        // only emits ADVANCE_TO_STAGE entries for in-progress cycles — for the
        // pre-cycle case we walk the cached pipeline graph from its START
        // node via the shared executor's `findReachable` helper (Phase 8.7
        // Wave-5: lifted to `firstStagesFromGraph` in lib/filter-ops, shared
        // with mobile's validateOfflineGate so the walker can't drift).
        if (!cycleInProgress && hasGraph) {
          const firstStages = firstStagesFromGraph(state.pipelineGraph);
          if (firstStages.length > 0 && !firstStages.includes(activeStage.key)) {
            setError(`${first.filterName}: cannot start cycle at ${activeStage.label}. Start at: ${firstStages.map((s: string) => s.replace(/_/g, ' ')).join(', ')}`);
            setLoading(false); setSubmitting(false);
            return;
          }
        }

        // In-cycle but no advance actions on tape → stale cache; refuse
        if (cycleInProgress && advanceTargets.length === 0) {
          setPopupError(`${first.filterName}: filter is in-cycle but no next stage is cached. Reconnect and re-sync.`);
          setLoading(false); setSubmitting(false);
          return;
        }
      }
      // ─── END STRICT OFFLINE GATE ─────────────────────────────────────────

      // Gap 9: Proactive cross-block gate (ONLINE only — offline showed a notice
      // above and proceeds). CONFIRM → confirm dialog; REQUIRED → request dialog.
      // APPROVED/MATCH proceed. Acked filters (CONFIRM mode) skip.
      if (online && state.homeBlock && selectedBlock?.id && state.homeBlock.id !== selectedBlock.id
          && !ackedBlockFiltersRef.current.has(first.filterId)
          && (state.blockChangeStatus === 'CONFIRM' || state.blockChangeStatus === 'REQUIRED')) {
        core.dispatch({
          type: 'open_block_change',
          filterId: first.filterId,
          filterName: first.filterName,
          homeBlockId: state.homeBlock.id,
          homeBlockName: state.homeBlock.name,
          requestedBlockId: selectedBlock.id,
          requestedBlockName: selectedBlock.name,
        });
        setBlockChangeReason('');
        setLoading(false); setSubmitting(false);
        return;
      }

      // B.10 — stale profile detection on desktop too. Cycle bound to a profile
      // that no longer matches the live block-assignment → block advance and
      // tell the operator to terminate-and-restart.
      if (state.profileSyncWarning) {
        const w = state.profileSyncWarning;
        setPopupError(
          `${first.filterName}: active cycle is on profile "${w.cycleProfileName ?? w.cycleProfileId}", but the live profile for this block is "${w.expectedProfileName ?? w.expectedProfileId}". Terminate the current cycle and rescan to start fresh.`
        );
        setLoading(false); setSubmitting(false);
        return;
      }

      // DRY_IN: if temperature already recorded, direct user to Dry Out stage
      // (runs BEFORE generic nextAllowed check so the user gets a clear instruction
      // instead of the confusing "is at DRY IN. Next allowed: Dry Out")
      if (activeStage.key === 'DRY_IN' && state.currentCycle?.dryerReadingsSubmitted) {
        setPopupError('Dry In complete — temperature already recorded. Scan on Dry Out stage to advance.');
        setLoading(false); setSubmitting(false);
        return;
      }

      // Phase 8.6 part 2: tape-derived "wrong stage" check. activeStage must
      // appear as an ADVANCE / SET_DRYER target on the resolved tape.
      const advanceMatch = actionsForStage(activeStage.key, resolvedActions).some(
        a => a.type === 'ADVANCE_TO_STAGE' || a.type === 'SET_DRYER_DURATION',
      );
      if (advanceTargets.length > 0 && !advanceMatch) {
        const allowedLabels = advanceTargets.map((k: string) => CLEANING_STAGES.find(s => s.key === k)?.label ?? k).join(', ');
        setError(`${first.filterName} is at "${(state.currentState ?? 'START').replace(/_/g, ' ')}". Next allowed: ${allowedLabels}`);
        setLoading(false); setSubmitting(false);
        return;
      }

      // Phase 8.7 Wave-5: shared checklist-dialog resolver. Pass the resolved
      // tape from the offline-gate computation above so we don't recompute it.
      {
        const dialogChecklists = await resolvePendingChecklistDialog(first.filterId, resolvedActions);
        if (dialogChecklists) {
          // AHU pre-flight BEFORE the (terminal) checklist opens (whole batch).
          if ((await gateAhuBeforeChecklist(scanQueue.map(q => q.filterId))) === 'blocked') {
            setLoading(false); setSubmitting(false);
            return;
          }
          const batch = scanQueue.map(q => ({ filterId: q.filterId, filterName: q.filterName }));
          setPendingBatch(batch);
          clearScanState();
          core.dispatch({ type: 'open_checklist', filterId: first.filterId, filterName: `${batch.length} filter(s)`, checklists: dialogChecklists });
          setChecklistError('');
          setLoading(false); setSubmitting(false);
          return;
        }
      }

      // Need cycle start — always confirm the reason via the dialog. For a
      // PM-due filter, pre-select PM + show a "PM schedule" banner so the
      // operator confirms PM (completes the My Tasks PM task) or picks another
      // reason (which leaves the PM task pending). No more silent PM auto-start.
      if (!state.currentCycle) {
        const batch = scanQueue.map(q => ({ filterId: q.filterId, filterName: q.filterName }));
        setPendingBatch(batch);
        setPmReasonCtx(state.isPmDue && state.pmReasonKey ? { pmDue: true, defaultReasonKey: state.pmReasonKey } : { pmDue: false });
        clearScanState();
        core.dispatch({ type: 'open_reason', filterId: first.filterId, filterName: `${batch.length} filter(s)`, stage: activeStage.key });
        setReasonError('');
        setLoading(false); setSubmitting(false);
        return;
      }

      // DRY_IN special two-step dryer flow
      if (activeStage.key === 'DRY_IN') {
        const cyc = state.currentCycle ?? {};
        if (cyc.dryerReadingsSubmitted) {
          setPopupError('Dry In complete — temperature already recorded. Scan on Dry Out stage to advance.');
          setLoading(false); setSubmitting(false);
          return;
        }
        const startedAt = cyc.dryerStartedAt ? new Date(cyc.dryerStartedAt).getTime() : null;
        const durationMin: number | null = cyc.dryerDurationMinutes ?? null;

        if (!startedAt || !durationMin) {
          // Step 1: ask for duration (shared)
          const batch = scanQueue.map(q => ({ filterId: q.filterId, filterName: q.filterName }));
          setPendingBatch(batch);
          clearScanState();
          core.dispatch({ type: 'open_dryer', filterId: first.filterId, filterName: `${batch.length} filter(s)` });
          setDryerError('');
          setLoading(false); setSubmitting(false);
          return;
        }

        const halfMs = (durationMin * 60_000) / 2;
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs < halfMs) {
          const remainingMin = Math.ceil((halfMs - elapsedMs) / 60_000);
          setPopupError(`Dryer still running. Wait ${remainingMin} more minute(s) before entering temperature readings.`);
          setLoading(false); setSubmitting(false);
          return;
        }

        if (state.equipmentGroup) {
          // Step 2: shared temperature/readings dialog
          const batch = scanQueue.map(q => ({ filterId: q.filterId, filterName: q.filterName }));
          setPendingBatch(batch);
          clearScanState();
          core.dispatch({ type: 'open_equipment', filterId: first.filterId, filterName: `${batch.length} filter(s)`, stage: activeStage.key, groups: [], cycleGroup: state.equipmentGroup });
          setEquipmentError('');
          setLoading(false); setSubmitting(false);
          return;
        }
      }

      // Check if equipment group has instruments for this stage — show readings dialog if so
      if (state.equipmentGroup && selectedBlock?.id) {
        const instruments = state.equipmentGroup.instruments ?? [];
        const stageInstruments = instruments.filter((i: any) => i.stageKey === activeStage.key);
        if (stageInstruments.length > 0) {
          const batch = scanQueue.map(q => ({ filterId: q.filterId, filterName: q.filterName }));
          setPendingBatch(batch);
          clearScanState();
          core.dispatch({ type: 'open_equipment', filterId: first.filterId, filterName: `${batch.length} filter(s)`, stage: activeStage.key, groups: [], cycleGroup: state.equipmentGroup });
          setEquipmentError('');
          setLoading(false); setSubmitting(false);
          return;
        }
      }

      // No dialog needed → advance the whole batch
      const batch = scanQueue.map(q => ({ filterId: q.filterId, filterName: q.filterName }));
      await advanceBatch(batch, {});
      // Stay on the stage screen; clear queue so user can scan more
      clearScanState();
    } catch (e: any) {
      setPopupError(e.message ?? 'Failed');
    }
    setLoading(false); setSubmitting(false);
  };

  const handleReasonSubmit = async (reasonKey: string, justification?: string) => {
    if (!reasonDialog || !reasonKey || submitting) return;
    // Validate justification requirement by fetching reasons
    let reasons: any[] = [];
    try {
      const res = await apiClient.get<any>('/api/filters/reasons');
      reasons = res?.reasons ?? res ?? [];
    } catch { /* proceed */ }
    const reason = reasons.find((r: any) => r.key === reasonKey);
    if (reason?.requiresJustification && (!justification || justification.length < 10)) {
      setReasonError('Justification required (min 10 characters)');
      return;
    }

    // BATCH MODE: start cycle for every filter in the snapshot.
    // For WASH_IN with equipment groups on the block, pause after start-cycle
    // and hand off to the equipment-group / limits dialog (which will run the
    // batch advance). For every other stage, advance immediately.
    if (pendingBatch && pendingBatch.length > 0 && reasonDialog.stage) {
      const batch = pendingBatch;
      const stage = reasonDialog.stage;
      const blockId = reasonDialog.block?.id;
      const blockName = reasonDialog.block?.name;
      const block = reasonDialog.block;
      setLoading(true); setReasonError(''); setSubmitting(true);
      await reauth.execute('START_CLEANING_CYCLE', async (password?) => {
        const startBody = { cleaningReasonKey: reasonKey, cleaningJustification: justification || undefined, cleaningAreaId: blockId };

        // 1) Start cycle for every filter in the batch.
        //    `password` is forwarded so executeOrQueue's online path uses
        //    postWithReauth — closes the gap that previously dropped the
        //    operator's typed password and surfaced as "Password is required"
        //    on every batch start by an ADMIN-role user.
        let started = 0; const startFailed: string[] = [];
        for (const item of batch) {
          try {
            await executeOrQueue('start-cycle', item.filterId, item.filterName,
              { ...startBody, acknowledgeBlockChange: ackedBlockFiltersRef.current.has(item.filterId) }, undefined, password);
            started++;
          } catch (e: any) {
            // REAUTH errors must NOT be swallowed into the per-filter
            // failure list — the reauth dialog needs to stay open with
            // the inline "Incorrect password" message and let the
            // operator retry, instead of closing on a generic popup.
            // The two shapes (`.error` from REAUTH_REQUIRED / REAUTH_FAILED
            // re-thrown raw in api-client.ts:67, `.code` from the
            // constructed-Error branch at line 104) cover both paths.
            const errCode = e?.error ?? e?.code;
            if (errCode === 'REAUTH_FAILED' || errCode === 'REAUTH_REQUIRED') {
              throw e;
            }
            if ((e.code === 'BLOCK_CHANGE_CONFIRM' || e.code === 'BLOCK_CHANGE_REQUIRED') && e.connectionInfo) {
              core.dispatch({ type: 'close' }); // close reason dialog
              core.dispatch({
                type: 'open_block_change',
                filterId: e.connectionInfo.filterId ?? item.filterId,
                filterName: item.filterName,
                homeBlockId: e.connectionInfo.homeBlockId,
                homeBlockName: e.connectionInfo.homeBlockName,
                requestedBlockId: e.connectionInfo.requestedBlockId,
                requestedBlockName: e.connectionInfo.requestedBlockName,
              });
              setBlockChangeReason('');
              setPendingBatch(null);
              refreshFilters();
              setLoading(false); setSubmitting(false);
              return;
            }
            startFailed.push(`${item.filterName}: ${e.message ?? 'failed'}`);
          }
        }
        if (startFailed.length > 0) {
          setPopupError(`${started} cycle(s) started, ${startFailed.length} failed:\n${startFailed.join('\n')}`);
          core.dispatch({ type: 'close' }); // close reason dialog
          setPendingBatch(null);
          refreshFilters();
          return;
        }

        // 2) WASH_IN + block selected → check for equipment groups; if any,
        //    hand off to equipment/limits dialog (keeps pendingBatch set).
        if (stage.key === 'WASH_IN' && blockId && block) {
          let groups: any[] = [];
          try {
            groups = await apiClient.get<any[]>(`/api/equipment-groups/by-block/${blockId}`) ?? [];
          } catch {
            // Offline: use cached equipment groups filtered by block
            try {
              const cachedGroups = await getCache<any[]>('equipment-groups') ?? [];
              groups = cachedGroups.filter((g: any) => g.blockId === blockId);
            } catch { /* no cached groups */ }
          }
          if (groups.length > 0) {
            core.dispatch({ type: 'close' }); // close reason dialog
            core.dispatch({ type: 'open_equipment', filterId: batch[0].filterId, filterName: `${batch.length} filter(s)`, stage: stage.key, groups });
            setEquipmentError('');
            return; // pendingBatch stays set — equipment dialog handles advance
          }
        }

        // 3) No equipment dialog needed → advance the whole batch now
        let success = 0; const failed: string[] = [];
        const newSubs: typeof recentSubmissions = [];
        for (const item of batch) {
          try {
            const { executed } = await executeOrQueue('advance', item.filterId, item.filterName, {
              targetState: stage.key,
              cleaningAreaId: blockId,
              remarks: remarks || `${stage.label} - Batch - ${item.filterName}`,
            }, stage.key);
            success++;
            newSubs.push({ stage: stage.label + (executed ? '' : ' (queued)'), filter: item.filterName, block: blockName, time: formatTime(new Date()) });
          } catch (e: any) {
            if ((e.code === 'BLOCK_CHANGE_CONFIRM' || e.code === 'BLOCK_CHANGE_REQUIRED') && e.connectionInfo) {
              core.dispatch({ type: 'close' }); // close reason dialog
              core.dispatch({
                type: 'open_block_change',
                filterId: e.connectionInfo.filterId ?? item.filterId,
                filterName: item.filterName,
                homeBlockId: e.connectionInfo.homeBlockId,
                homeBlockName: e.connectionInfo.homeBlockName,
                requestedBlockId: e.connectionInfo.requestedBlockId,
                requestedBlockName: e.connectionInfo.requestedBlockName,
              });
              setBlockChangeReason('');
              setPendingBatch(null); refreshFilters();
              return;
            }
            failed.push(`${item.filterName}: ${e.message ?? 'failed'}`);
          }
        }
        recordSubmission(newSubs);
        refreshFilters();
        core.dispatch({ type: 'close' }); // close reason dialog
        setPendingBatch(null);
        if (failed.length > 0) setPopupError(`${success} succeeded, ${failed.length} failed:\n${failed.join('\n')}`);
        else setToast({ type: 'success', message: `${success} filter(s) → ${stage.label}` });
      }, {
        onError: (e: unknown) => { setReasonError((e as any)?.message ?? 'Failed'); setPopupError((e as any)?.message ?? 'Failed'); },
      });
      setLoading(false); setSubmitting(false);
      return;
    }

    const reasonBlock = reasonDialog.block;
    const dialogCapture = { ...reasonDialog, block: reasonBlock };
    setLoading(true); setReasonError(''); setSubmitting(true);

    try {
      const cycleBody = { cleaningReasonKey: reasonKey, cleaningJustification: justification || undefined, cleaningAreaId: reasonBlock?.id };
      const advBody = { targetState: dialogCapture.stage.key, cleaningAreaId: reasonBlock?.id, remarks: remarks || `${dialogCapture.stage.label} - ${dialogCapture.filterName}` };

      // For WASH_IN: check equipment groups before advancing (online only)
      if (dialogCapture.stage.key === 'WASH_IN' && reasonBlock?.id && online) {
        await reauth.execute('START_CLEANING_CYCLE', async (password?) => {
          const startBody = { ...cycleBody };
          if (password) await apiClient.postWithReauth(`/api/filters/${dialogCapture.filterId}/start-cycle`, startBody, password);
          else await apiClient.post(`/api/filters/${dialogCapture.filterId}/start-cycle`, startBody);

          try {
            const groups = await apiClient.get<any[]>(`/api/equipment-groups/by-block/${reasonBlock.id}`);
            if (groups && groups.length > 0) {
              core.dispatch({ type: 'close' }); // close reason dialog
              core.dispatch({ type: 'open_equipment', filterId: dialogCapture.filterId, filterName: dialogCapture.filterName, stage: dialogCapture.stage.key, groups });
              setEquipmentError('');
              setLoading(false); setSubmitting(false);
              return;
            }
          } catch { /* no groups -- proceed normally */ }

          // Phase 8.7 cutover (Wave 2 — server commit f8fae1d): /advance now
          // requires `tapeVersion` in the body. We just started the cycle on
          // the previous line so the cache row's tapeVersion is stale (or
          // null). Fetch the freshly-derived tapeVersion via /current-state
          // and include it. This is a one-shot read; the offline path uses
          // executeOrQueue which handles the cache lookup itself.
          let advanceTapeVersion: number | undefined;
          try {
            const fresh = await apiClient.get<any>(`/api/filters/${dialogCapture.filterId}/current-state`);
            if (typeof fresh?.tapeVersion === 'number') advanceTapeVersion = fresh.tapeVersion;
          } catch { /* if this fails, advance will 400 STALE_TAPE → reauth.execute surfaces it */ }
          const advBodyWithTape = advanceTapeVersion !== undefined
            ? { ...advBody, tapeVersion: advanceTapeVersion }
            : advBody;
          const advanceResult = password
            ? await apiClient.postWithReauth<any>(`/api/filters/${dialogCapture.filterId}/advance`, advBodyWithTape, password)
            : await apiClient.post<any>(`/api/filters/${dialogCapture.filterId}/advance`, advBodyWithTape);
          recordSubmission({ stage: dialogCapture.stage.label, filter: dialogCapture.filterName, block: reasonBlock?.name, time: formatTime(new Date()) });
          refreshFilters();
          core.dispatch({ type: 'close' }); // close reason dialog
          setToast({ type: 'success', message: `${dialogCapture.filterName} \u2192 ${dialogCapture.stage.label}` });
          // Phase 8.7 Wave-5: shared checklist-dialog resolver. /advance
          // returns getCurrentState() — its actions[] is the canonical source.
          {
            const dialogChecklists = await resolvePendingChecklistDialog(
              dialogCapture.filterId,
              advanceResult?.actions,
            );
            if (dialogChecklists) {
              // AHU pre-flight BEFORE the (terminal) checklist opens (single filter).
              if ((await gateAhuBeforeChecklist([dialogCapture.filterId])) === 'proceed') {
                core.dispatch({ type: 'open_checklist', filterId: dialogCapture.filterId, filterName: dialogCapture.filterName, checklists: dialogChecklists });
                setChecklistError('');
              }
            }
          }
        }, {
          onError: (e: unknown) => {
            const err = e as any;
            if ((err?.code === 'BLOCK_CHANGE_CONFIRM' || err?.code === 'BLOCK_CHANGE_REQUIRED') && err?.connectionInfo) {
              core.dispatch({ type: 'close' }); // close reason dialog
              core.dispatch({
                type: 'open_block_change',
                filterId: err.connectionInfo.filterId ?? dialogCapture.filterId,
                filterName: dialogCapture.filterName,
                homeBlockId: err.connectionInfo.homeBlockId,
                homeBlockName: err.connectionInfo.homeBlockName,
                requestedBlockId: err.connectionInfo.requestedBlockId,
                requestedBlockName: err.connectionInfo.requestedBlockName,
              });
              setBlockChangeReason('');
              return;
            }
            setReasonError(err?.message ?? 'Failed'); setPopupError(err?.message ?? 'Failed');
          },
        });
      } else {
        // Non-WASH_IN or offline: check equipment groups (offline uses cache), then start-and-advance
        if (dialogCapture.stage.key === 'WASH_IN' && reasonBlock?.id) {
          let groups: any[] = [];
          try {
            const cachedGroups = await getCache<any[]>('equipment-groups') ?? [];
            groups = cachedGroups.filter((g: any) => g.blockId === reasonBlock.id);
          } catch { /* no cached groups */ }
          if (groups.length > 0) {
            // Save cycle payload — equipment dialog will use it for compound start-and-advance
            setPendingCyclePayload(cycleBody);
            core.dispatch({ type: 'close' }); // close reason dialog
            core.dispatch({ type: 'open_equipment', filterId: dialogCapture.filterId, filterName: dialogCapture.filterName, stage: dialogCapture.stage.key, groups });
            setEquipmentError('');
            setLoading(false); setSubmitting(false);
            return;
          }
        }

        const { executed, result, deferred } = await core.startAndAdvance({
          filterId: dialogCapture.filterId,
          filterName: dialogCapture.filterName,
          cyclePayload: cycleBody,
          advancePayload: advBody,
          targetState: dialogCapture.stage.key,
          cleaningAreaId: reasonBlock?.id,
        });
        // Dialog-first (2026-07-16): the first stage has a mandatory checklist \u2014
        // nothing was written (not even the cycle start) and the reason dialog has
        // already been REPLACED by the checklist dialog (open_checklist transitions
        // straight from awaiting_reason). Recording a submission or toasting would
        // claim work that hasn't happened, and the close below would dismiss the
        // checklist the operator must answer.
        if (deferred) return;
        recordSubmission({ stage: dialogCapture.stage.label + (executed ? '' : ' (queued)'), filter: dialogCapture.filterName, block: reasonBlock?.name, time: formatTime(new Date()) });
        refreshFilters();
        core.dispatch({ type: 'close' }); // close reason dialog
        setToast({ type: 'success', message: `${dialogCapture.filterName} \u2192 ${dialogCapture.stage.label}${executed ? '' : ' (queued)'}` });
      }
    } catch (e: any) {
      if ((e?.code === 'BLOCK_CHANGE_CONFIRM' || e?.code === 'BLOCK_CHANGE_REQUIRED') && e?.connectionInfo) {
        core.dispatch({ type: 'close' }); // close reason dialog
        core.dispatch({
          type: 'open_block_change',
          filterId: e.connectionInfo.filterId ?? dialogCapture.filterId,
          filterName: dialogCapture.filterName,
          homeBlockId: e.connectionInfo.homeBlockId,
          homeBlockName: e.connectionInfo.homeBlockName,
          requestedBlockId: e.connectionInfo.requestedBlockId,
          requestedBlockName: e.connectionInfo.requestedBlockName,
        });
        setBlockChangeReason('');
      } else {
        setReasonError(e?.message ?? 'Failed'); setPopupError(e?.message ?? 'Failed');
      }
    }
    setLoading(false); setSubmitting(false);
  };

  const handleDryerDurationSubmit = async (minutes: number) => {
    if (!dryerDialog || dryerLoading) return;
    setDryerLoading(true); setDryerError('');
    const blockId = dryerDialog.block?.id;
    const blockName = dryerDialog.block?.name;

    // BATCH MODE
    if (pendingBatch && pendingBatch.length > 0) {
      const batch = pendingBatch;
      let success = 0; const failed: string[] = [];
      const newSubs: typeof recentSubmissions = [];
      for (const item of batch) {
        try {
          const { executed } = await executeOrQueue('advance', item.filterId, item.filterName, {
            targetState: 'DRY_IN',
            cleaningAreaId: blockId,
            dryerAction: 'SET_DURATION',
            dryerDurationMinutes: minutes,
            remarks: remarks || `Dryer started (${minutes} min) - Batch`,
          }, 'DRY_IN');
          success++;
          newSubs.push({ stage: 'Dryer Started' + (executed ? '' : ' (queued)'), filter: item.filterName, block: blockName, time: formatTime(new Date()) });
        } catch (e: any) {
          failed.push(`${item.filterName}: ${e.message ?? 'failed'}`);
        }
      }
      recordSubmission(newSubs);
      refreshFilters();
      // Cache dryer timing + equipmentGroup for each filter (offline + navigation persistence)
      const dryerStartedAt = new Date().toISOString();
      // Resolve equipment group for offline temperature dropdown
      let batchEqGroup: any = null;
      if (blockId) {
        try {
          const allGroups = await getCache<any[]>('equipment-groups') ?? [];
          const blockGroups = allGroups.filter((g: any) => g.blockId === blockId);
          if (blockGroups.length === 1) batchEqGroup = blockGroups[0];
        } catch { /* IDB read failed — batchEqGroup stays null and each item resolves its own */ }
      }
      for (const item of batch) {
        try {
          const cached = await getCache<any>(`filter-state-${item.filterId}`) ?? {};
          cache(`filter-state-${item.filterId}`, {
            ...cached,
            currentState: 'DRY_IN',
            equipmentGroup: cached.equipmentGroup ?? batchEqGroup,
            currentCycle: {
              ...(cached.currentCycle ?? {}),
              status: 'IN_PROGRESS',
              dryerDurationMinutes: minutes,
              dryerStartedAt,
              cleaningAreaId: blockId ?? cached.currentCycle?.cleaningAreaId ?? null,
            },
          }, 24 * 60 * 60 * 1000);
        } catch { /* ignore cache errors */ }
      }
      // Update offline cache (action tape + reachable-target mirrors) per filter when queued.
      // Deep-review fix D3: blockId pulled from selectedBlock via wrapper default.
      for (const item of batch) {
        await recomputeAndCacheFilterState(item.filterId, 'DRY_IN', false, selectedBlock?.id ?? null);
      }
        core.dispatch({ type: 'close' }); // close dryer dialog
      setPendingBatch(null);
      if (failed.length > 0) setPopupError(`${success} succeeded, ${failed.length} failed:\n${failed.join('\n')}`);
      else setToast({ type: 'success', message: `${success} filter(s) → Dryer running (${minutes} min)` });
      setDryerLoading(false);
      return;
    }

    try {
      const { executed } = await executeOrQueue('advance', dryerDialog.filterId, dryerDialog.filterName, {
        targetState: 'DRY_IN',
        cleaningAreaId: blockId,
        dryerAction: 'SET_DURATION',
        dryerDurationMinutes: minutes,
        remarks: remarks || `Dryer started (${minutes} min) - ${dryerDialog.filterName}`,
      }, 'DRY_IN');
      recordSubmission({ stage: 'Dryer Started' + (executed ? '' : ' (queued)'), filter: dryerDialog.filterName, block: blockName, time: formatTime(new Date()) });
      refreshFilters();
      // Cache dryer timing + equipmentGroup (offline + navigation persistence)
      try {
        const cached = await getCache<any>(`filter-state-${dryerDialog.filterId}`) ?? {};
        let eqGroup = cached.equipmentGroup ?? null;
        if (!eqGroup && blockId) {
          const allGroups = await getCache<any[]>('equipment-groups') ?? [];
          const blockGroups = allGroups.filter((g: any) => g.blockId === blockId);
          if (blockGroups.length === 1) eqGroup = blockGroups[0];
        }
        cache(`filter-state-${dryerDialog.filterId}`, {
          ...cached,
          currentState: 'DRY_IN',
          equipmentGroup: eqGroup,
          currentCycle: {
            ...(cached.currentCycle ?? {}),
            status: 'IN_PROGRESS',
            dryerDurationMinutes: minutes,
            dryerStartedAt: new Date().toISOString(),
            cleaningAreaId: blockId ?? cached.currentCycle?.cleaningAreaId ?? null,
          },
        }, 24 * 60 * 60 * 1000);
      } catch { /* ignore cache errors */ }
      // Update offline cache (action tape + reachable-target mirrors) when queued.
      // Deep-review fix D3: pass blockId explicitly.
      if (!executed) {
      await recomputeAndCacheFilterState(dryerDialog.filterId, 'DRY_IN', false, selectedBlock?.id ?? null);
      }
      core.dispatch({ type: 'close' }); // close dryer dialog
      setToast({ type: 'success', message: `${dryerDialog.filterName} → Dryer running (${minutes} min)${executed ? '' : ' (queued)'}` });
    } catch (e: any) {
      setDryerError(e.message ?? 'Failed to start dryer');
      setPopupError(e.message ?? 'Failed to start dryer');
    }
    setDryerLoading(false);
  };

  const handleEquipmentSubmit = async (groupId: string, readings: Record<string, number>) => {
    if (!equipmentDialog || equipmentLoading) return;
    setEquipmentLoading(true); setEquipmentError('');
    const isDryerReadings = equipmentDialog.stage.key === 'DRY_IN';
    const blockId = equipmentDialog.block?.id;
    const blockName = equipmentDialog.block?.name;
    const stage = equipmentDialog.stage;

    // BATCH MODE: same readings applied to every filter in the snapshot
    if (pendingBatch && pendingBatch.length > 0) {
      const batch = pendingBatch;
      const savedCyclePayload = pendingCyclePayload;
      let success = 0; const failed: string[] = [];
      const newSubs: typeof recentSubmissions = [];
      // Minor #2: track first 409 BLOCK_CHANGE_REQUIRED hit with a local flag.
      // The closure-captured `blockChangeDialog` does NOT update mid-loop —
      // React doesn't flush state between iterations of a sync `for`/await —
      // so `if (!blockChangeDialog)` would always be whatever it was at
      // function entry, not "have we set it this run". Local flag = correct.
      let blockChangePopped = false;
      for (const item of batch) {
        try {
          const advPayload = {
            targetState: isDryerReadings ? 'DRY_IN' : stage.key,
            cleaningAreaId: blockId,
            equipmentGroupId: groupId,
            instrumentReadings: readings,
            ...(isDryerReadings ? { dryerAction: 'SUBMIT_READINGS' } : {}),
            remarks: remarks || `${stage.label} - Batch - ${item.filterName}`,
          };
          let executed: boolean;
          if (savedCyclePayload) {
            // Cycle not started yet — compound start-and-advance with readings
            const res = await executeOrQueue('start-and-advance', item.filterId, item.filterName, {
              cyclePayload: { ...savedCyclePayload, equipmentGroupId: groupId },
              advancePayload: advPayload,
            } as any, isDryerReadings ? 'DRY_IN' : stage.key);
            executed = res.executed;
          } else {
            const res = await executeOrQueue('advance', item.filterId, item.filterName, advPayload, isDryerReadings ? 'DRY_IN' : stage.key);
            executed = res.executed;
          }
          success++;
          // Update cached state after offline operation.
          // Deep-review fix D3: pass blockId from the equipment dialog scope.
          if (!executed) await recomputeAndCacheFilterState(item.filterId, isDryerReadings ? 'DRY_IN' : stage.key, !!savedCyclePayload, blockId ?? null);
          newSubs.push({ stage: stage.label + (executed ? '' : ' (queued)'), filter: item.filterName, block: blockName, time: formatTime(new Date()) });
        } catch (e: any) {
          // B7.2: equipment-dialog batch loop uses `start-and-advance` when a
          // cycle hasn't started yet, which calls start-cycle → validateBlockChange.
          // A cross-block hit can return 409 BLOCK_CHANGE_REQUIRED. Pop the
          // structured modal once on first hit (matches advanceBatch:388
          // pattern) and continue iterating so other items can still succeed.
          if ((e?.code === 'BLOCK_CHANGE_CONFIRM' || e?.code === 'BLOCK_CHANGE_REQUIRED') && e?.connectionInfo) {
            if (!blockChangePopped) {
              core.dispatch({
                type: 'open_block_change',
                filterId: e.connectionInfo.filterId ?? item.filterId,
                filterName: item.filterName,
                homeBlockId: e.connectionInfo.homeBlockId,
                homeBlockName: e.connectionInfo.homeBlockName,
                requestedBlockId: e.connectionInfo.requestedBlockId,
                requestedBlockName: e.connectionInfo.requestedBlockName,
              });
              setBlockChangeReason('');
            }
            failed.push(`${item.filterName}: Block change approval required`);
          } else {
            failed.push(`${item.filterName}: ${e.message ?? 'failed'}`);
          }
        }
      }
      recordSubmission(newSubs);
      refreshFilters();
      refreshOfflineInstances(); // refresh cached data after queued ops
      core.dispatch({ type: 'close' }); // close equipment dialog (batch end)
      setPendingBatch(null);
      setPendingCyclePayload(null);
      // Minor #3: suppress generic toast when block-change modal is up
      // (mirrors advanceBatch:422 `&& !blockChangeDialog`, but using the
      // local flag to avoid the same closure-staleness pitfall).
      if (failed.length > 0 && !blockChangePopped) setPopupError(`${success} succeeded, ${failed.length} failed:\n${failed.join('\n')}`);
      else if (failed.length === 0) setToast({ type: 'success', message: `${success} filter(s) → ${stage.label}` });
      setEquipmentLoading(false);
      return;
    }

    try {
      const advPayload = {
        targetState: isDryerReadings ? 'DRY_IN' : equipmentDialog.stage.key,
        cleaningAreaId: equipmentDialog.block?.id,
        equipmentGroupId: groupId,
        instrumentReadings: readings,
        ...(isDryerReadings ? { dryerAction: 'SUBMIT_READINGS' } : {}),
        remarks: remarks || `${equipmentDialog.stage.label} - ${equipmentDialog.filterName}`,
      };
      let executed: boolean;
      // 2026-05-26: trust the hook's dialogOpened signal instead of reading
      // core.dialogState.kind — the kind is a stale-closure snapshot from
      // when this handler started ('awaiting_equipment'), so the close-on-
      // no-gate check below was firing AFTER open_checklist had transitioned
      // state to 'awaiting_checklist' and killing the checklist dialog on
      // L1-style every-stage-has-gate profiles.
      let dialogOpenedByCore = false;
      // 2026-07-16: the advance deferred behind its checklist dialog and wrote
      // nothing. Suppresses the submission record + success toast below, which
      // would otherwise report a stage the filter has not entered.
      let deferredHere = false;
      if (pendingCyclePayload) {
        // Cycle not started yet — compound start-and-advance with readings
        const res = await core.startAndAdvance({
          filterId: equipmentDialog.filterId,
          filterName: equipmentDialog.filterName,
          cyclePayload: { ...pendingCyclePayload, equipmentGroupId: groupId },
          advancePayload: advPayload,
          targetState: isDryerReadings ? 'DRY_IN' : equipmentDialog.stage.key,
          cleaningAreaId: equipmentDialog.block?.id,
        });
        deferredHere = res.deferred === true;
        executed = res.executed;
        dialogOpenedByCore = res.dialogOpened;
        setPendingCyclePayload(null);
      } else {
        const res = await core.advance({
          filterId: equipmentDialog.filterId,
          filterName: equipmentDialog.filterName,
          targetState: isDryerReadings ? 'DRY_IN' : equipmentDialog.stage.key,
          cleaningAreaId: equipmentDialog.block?.id,
          equipmentGroupId: groupId,
          instrumentReadings: readings,
          ...(isDryerReadings ? { dryerAction: 'SUBMIT_READINGS' as const } : {}),
          remarks: advPayload.remarks,
        });
        executed = res.executed;
        dialogOpenedByCore = res.dialogOpened;
        deferredHere = res.deferred === true;
      }

      // Dialog-first (2026-07-16): when deferred, NOTHING was written — the
      // checklist dialog is open and the advance commits atomically with the
      // answers on submit. Recording a submission or toasting "→ stage" here
      // would claim a transition that hasn't happened and that Close discards.
      // The checklist submit path reports the combined result. The equip dialog
      // is already superseded by the checklist dialog (dialogOpenedByCore), so
      // the close guard below still behaves.
      if (!deferredHere) {
        recordSubmission({ stage: equipmentDialog.stage.label + (executed ? '' : ' (queued)'), filter: equipmentDialog.filterName, block: equipmentDialog.block?.name, time: formatTime(new Date()) });
      }
      refreshFilters();
      // Close equip dialog ONLY when no checklist gate fired — otherwise the
      // explicit close races the checklist dispatch and dismisses it.
      if (!dialogOpenedByCore) core.dispatch({ type: 'close' });
      if (!deferredHere) {
        setToast({ type: 'success', message: `${equipmentDialog.filterName} → ${equipmentDialog.stage.label}${executed ? '' : ' (queued)'}` });
      }
    } catch (e: any) {
      // B7.2: single-filter equipment submit may return 409 BLOCK_CHANGE_REQUIRED
      // when pendingCyclePayload is set (start-and-advance path).
      if ((e?.code === 'BLOCK_CHANGE_CONFIRM' || e?.code === 'BLOCK_CHANGE_REQUIRED') && e?.connectionInfo) {
        core.dispatch({ type: 'close' }); // close equipment dialog first
        core.dispatch({
          type: 'open_block_change',
          filterId: e.connectionInfo.filterId ?? equipmentDialog.filterId,
          filterName: equipmentDialog.filterName,
          homeBlockId: e.connectionInfo.homeBlockId,
          homeBlockName: e.connectionInfo.homeBlockName,
          requestedBlockId: e.connectionInfo.requestedBlockId,
          requestedBlockName: e.connectionInfo.requestedBlockName,
        });
        setBlockChangeReason('');
        setPendingCyclePayload(null);
      } else {
        setEquipmentError(e.message ?? 'Failed to advance');
        setPopupError(e.message ?? 'Failed to advance');
      }
    }
    setEquipmentLoading(false);
  };

  // 2026-07-02: AHU completion pre-flight — runs BEFORE the terminal checklist
  // opens, for BOTH modes. Gated on isTerminalChecklist so intermediate
  // checklists are never affected (this is what dissolves the old two-filter
  // deadlock concern). Returns 'blocked' when the operator must NOT proceed to
  // open the checklist: INTERLOCK when siblings are pending, or POPUP when the
  // operator picks Cancel. Non-fatal on any error (the server 422 still guards
  // INTERLOCK at submit as a safety net).
  const gateAhuBeforeChecklist = async (filterIds: string[]): Promise<'proceed' | 'blocked'> => {
    // Reset any prior choice so a non-AHU / non-terminal submit carries none
    // (server then treats it as ALL — legacy behavior).
    ahuSetChoiceRef.current = null;
    if (ahuMode === 'NONE' || filterIds.length === 0) return 'proceed';
    // Terminal-checklist detection. The CACHED filter-state row can carry a
    // PREVIOUS cycle's terminal stage (or miss stageLookup) — that both skipped
    // the pre-flight AND mis-fired the POPUP at intermediate stages. ALWAYS
    // attempt fresh state (NOT gated on the flaky `online` flag); fall back to
    // cache only if the fetch truly fails (genuinely offline).
    let termState: any = await getCache<any>(`filter-state-${filterIds[0]}`).catch(() => null);
    try { termState = await apiClient.get<any>(`/api/filters/${filterIds[0]}/current-state`); }
    catch { /* genuinely offline → keep cached fallback */ }
    if (!isTerminalChecklist(termState?.currentState, termState?.stageLookup)) return 'proceed';

    // Only ask A / B / All when the batch actually spans both sets — otherwise
    // the choice is meaningless (proceed as ALL). Cancel = don't proceed.
    let set: FilterSetChoice | undefined;
    if (await checkAhuHasBothSets(ahuMode, filterIds, online)) {
      const chosen = await new Promise<FilterSetChoice | null>((resolve) => {
        ahuSetResolveRef.current = resolve;
        setAhuSetChooser(true);
      });
      if (!chosen) return 'blocked';
      set = chosen;
      ahuSetChoiceRef.current = chosen;
    }

    const { ahus, failed } = await checkAhuCompletionBatch(ahuMode, filterIds, online, set);
    // Fail-safe: the INTERLOCK gate exists to BLOCK completion while sibling
    // filters are unfinished. A FAILED check returns no AHUs — reading that as
    // "all done → proceed" would silently defeat the interlock. Stop and tell
    // the operator to retry instead of walking into a server-side 422 at submit.
    // (POPUP is advisory-only, so a failed check there proceeds — already logged.)
    if (failed && ahuMode === 'INTERLOCK') {
      setPopupError('Could not verify AHU completion status. Check your connection and try again.');
      return 'blocked';
    }
    if (ahus.filter((a) => !a.allAtFinal).length === 0) return 'proceed';
    const proceed = await new Promise<boolean>((resolve) => {
      ahuDialogResolveRef.current = resolve;
      setAhuDialogState({
        mode: ahuMode === 'INTERLOCK' ? 'INTERLOCK' : 'POPUP',
        ahus,
        currentFilterIds: filterIds,
      });
    });
    return proceed ? 'proceed' : 'blocked';
  };

  const handleChecklistSubmit = async (answers: Record<string, any>) => {
    if (!checklistDialog) return;
    setChecklistLoading(true); setChecklistError('');

    // 2026-07-02: the AHU completion pre-flight (POPUP + INTERLOCK) now runs
    // BEFORE the checklist opens (gateAhuBeforeChecklist), so there is no
    // submit-time POPUP pre-flight here. INTERLOCK still has a server-side 422
    // safety net caught below in case state changed between open and submit.

    // Phase A.1: include the version each profile was rendered against. Server
    // compares to its cycle pins and returns 409 SCHEMA_DRIFT if the live profile
    // version moved between when the dialog opened and when we submitted.
    const expectedProfileVersions: Record<string, number> = {};
    for (const cl of checklistDialog.checklists) {
      if (typeof cl.profileVersion === 'number') {
        expectedProfileVersions[cl.checklistProfileId] = cl.profileVersion;
      }
    }
    // ahuSetChoiceRef holds the operator's A/B/All pick (set in gateAhuBeforeChecklist).
    // It scopes the server INTERLOCK gate to the same roster the popup showed.
    const submitPayload = {
      answers,
      expectedProfileVersions,
      ...(ahuSetChoiceRef.current ? { filterSet: ahuSetChoiceRef.current } : {}),
    };

    // SUBMIT_CHECKLIST_WITH_SIGNATURE is reauth-gated when the admin enables
    // it in Action-Reauth config. Wrap so the password dialog appears once
    // for the whole submission (single or batch). Mirrors mobile-operations
    // handleChecklistSubmit. Without the wrap, the backend's enforceReauth
    // would 401 silently when policy demands a password.
    await reauth.execute('SUBMIT_CHECKLIST_WITH_SIGNATURE', async (password?: string) => {
      // BATCH MODE: submit same answers for every filter in the snapshot
      if (pendingBatch && pendingBatch.length > 0) {
        const batch = pendingBatch;
        let success = 0; const failed: string[] = [];
        for (const item of batch) {
          try {
            const { executed } = await executeOrQueue('submit-checklist', item.filterId, item.filterName, submitPayload, undefined, password);
            success++;
            if (!executed) failed.push(`${item.filterName}: queued for sync`);
          } catch (e: any) {
            failed.push(`${item.filterName}: ${e.message ?? 'failed'}`);
          }
        }
        core.dispatch({ type: 'close' }); // BATCH MODE: close checklist dialog
        setPendingBatch(null);
        refreshFilters();
        if (failed.length > 0) setPopupError(`${success} succeeded, ${failed.length} failed:\n${failed.join('\n')}`);
        else setToast({ type: 'success', message: `Checklist submitted for ${success} filter(s)` });
        return;
      }

      try {
        const { executed } = await core.submitChecklist({
          filterId: checklistDialog.filterId,
          filterName: checklistDialog.filterName,
          answers: submitPayload.answers,
          expectedProfileVersions: submitPayload.expectedProfileVersions,
          filterSet: ahuSetChoiceRef.current ?? undefined,
          password,
        });
        // Dialog close + offline cache-clear + batch walking handled by core.submitChecklist.
        setToast({ type: 'success', message: executed ? 'Checklist submitted successfully' : 'Checklist queued for sync' });
        refreshFilters();
      } catch (e: any) {
        // INTERLOCK: server returns 422 AHU_INTERLOCK_PENDING only at the terminal
        // checklist (when shouldComplete=true). Show the blocking dialog; the
        // operator must click Close, then wait for siblings to finish.
        if (e?.code === 'AHU_INTERLOCK_PENDING' && ahuMode === 'INTERLOCK') {
          const info = e?.connectionInfo ?? {};
          const pending = (info.pendingFilters as { id: string; name: string; stage: string }[]) ?? [];
          const filters = (info.filters as { id: string; name: string; stage: string; done: boolean }[])
            ?? pending.map(p => ({ ...p, done: false }));
          // Clear the checklist Submit spinner BEFORE showing the blocking
          // dialog so the button doesn't spin behind the interlock modal.
          setChecklistLoading(false);
          await new Promise<boolean>((resolve) => {
            ahuDialogResolveRef.current = resolve;
            setAhuDialogState({
              mode: 'INTERLOCK',
              ahus: [{ ahuName: info.ahuName ?? '', filters, allAtFinal: false }],
              currentFilterIds: [info.currentFilterId ?? checklistDialog.filterId],
            });
          });
          return;
        }
        setChecklistError(e.message ?? 'Failed to submit checklist');
        setPopupError(e.message ?? 'Failed to submit checklist');
      }
    });
    setChecklistLoading(false);
  };

  // 2026-06-09: block-change approval removed. The operator self-confirms cleaning
  // the filter in a different block; we mark it acknowledged and the next start for
  // that filter sends acknowledgeBlockChange=true so the cycle starts in that block.
  const handleBlockChangeRequest = async () => {
    if (!blockChangeDialog || blockChangeSubmitting) return;
    if (blockChangeMode === 'APPROVAL') {
      // Submit a block-change request for an approver to approve.
      if (!online) { setPopupError('Block change requests need an internet connection. Connect and try again.'); return; }
      setBlockChangeSubmitting(true);
      try {
        await apiClient.post('/api/block-change-requests', {
          filterId: blockChangeDialog.filterId,
          filterName: blockChangeDialog.filterName,
          fromBlockId: blockChangeDialog.homeBlockId,
          fromBlockName: blockChangeDialog.homeBlockName,
          toBlockId: blockChangeDialog.requestedBlockId,
          toBlockName: blockChangeDialog.requestedBlockName,
          reason: blockChangeReason.trim() || undefined,
        });
        setToast({ type: 'success', message: 'Block change request submitted. Waiting for approval.' });
        core.dispatch({ type: 'close' });
        setBlockChangeReason('');
      } catch (e: any) {
        setPopupError(e.message ?? 'Failed to submit block change request');
      }
      setBlockChangeSubmitting(false);
      return;
    }
    // CONFIRM mode: operator self-confirm — mark acknowledged + re-submit.
    ackedBlockFiltersRef.current.add(blockChangeDialog.filterId);
    core.dispatch({ type: 'close' });
    setBlockChangeReason('');
    setToast({ type: 'success', message: `Confirmed. Scan ${blockChangeDialog.filterName} again to clean it in this block.` });
  };

  const selectedStageInfo = CLEANING_STAGES.find(s => s.key === selectedStatusStage);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin h-8 w-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  // Stage screen mode: dedicated page for one stage
  if (urlStageKey && activeStage) {
    return (
      <div className="p-4 md:p-6 max-w-3xl mx-auto space-y-4">
        {toast && (
          <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-xl shadow-2xl flex items-center gap-3 text-sm font-medium ${toast.type === 'success' ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
            <span>{toast.type === 'success' ? '\u2713' : '\u2717'}</span>
            <span>{toast.message}</span>
          </div>
        )}
        {pendingCount > 0 && (
          <div className="mx-4 mb-2 px-4 py-2 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between">
            <span className="text-sm text-amber-700 font-medium">{pendingCount} operation(s) pending sync</span>
            <div className="flex gap-2">
              <button onClick={manualSync} disabled={syncing} className="px-3 py-1 bg-amber-100 text-amber-800 rounded-lg text-xs font-medium">{syncing ? 'Syncing...' : 'Sync Now'}</button>
              <button onClick={() => { if (confirm('Clear all pending?')) clearQueue(); }} className="px-2 py-1 bg-red-50 text-red-600 rounded-lg text-xs">Clear</button>
            </div>
          </div>
        )}
        {/* Stage interlock — this stage is paused awaiting a QA approval signature.
            The server has already dropped the advance action from the tape, so this
            banner explains why no "next stage" button is shown. */}
        {interlock?.blocksLeaving && (
          <div className="mx-4 mb-2 px-4 py-3 bg-amber-50 border border-amber-300 rounded-xl flex items-start gap-2">
            <svg className="w-5 h-5 mt-0.5 shrink-0 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
            <div className="text-sm text-amber-800">
              <div className="font-semibold">{interlockStageLabel(interlock.stageKey)} is awaiting QA approval.</div>
              <div className="text-amber-700 mt-0.5">
                {interlock.status === 'REJECTED'
                  ? 'This stage was rejected — the filter has been sent back for re-cleaning.'
                  : `${interlock.approverRole ?? 'An approver'} must verify the filter details and approve before this filter can continue. You'll be notified once it's released.`}
              </div>
            </div>
          </div>
        )}
        {/* B7.4 (2026-05-02): equipmentGroupSyncWarning advisory — admin edited
            the cycle's pinned EquipmentGroup mid-cycle. Persistent (no
            auto-clear); operator may continue on the pinned ranges or
            terminate-and-restart. */}
        {equipmentGroupSyncWarning && (
          <div className="mx-4 mb-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl flex items-start gap-2">
            <svg className="w-4 h-4 mt-0.5 shrink-0 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" /></svg>
            <span className="text-sm text-amber-800">
              Equipment group has been updated by admin (you started on v{equipmentGroupSyncWarning.pinnedVersion}, current is v{equipmentGroupSyncWarning.liveVersion}). Your readings will continue to validate against the version you started with — terminate-and-restart only if you need the new ranges.
            </span>
          </div>
        )}
        <button onClick={closeDialog} className="flex items-center gap-2 text-sm text-slate-600 hover:text-slate-900">
          <span>←</span> Back to Stages
        </button>
        <StageScanDialog
          fullPage
          activeStage={activeStage}
          step={step}
          blocks={blocks}
          selectedBlock={selectedBlock}
          scanValue={scanValue}
          remarks={remarks}
          error={error}
          loading={loading}
          queue={scanQueue}
          addingToQueue={addingToQueue}
          onScanValueChange={setScanValue}
          onRemarksChange={setRemarks}
          onClearError={() => setError('')}
          onBlockSelect={handleBlockSelect}
          onChangeBlock={() => {
            // B7.4 follow-up (Issue #1): clear stale advisory before
            // returning to block-picker; otherwise the warning lingers
            // visually while operator selects a new block.
            setEquipmentGroupSyncWarning(null);
            setStep('block');
          }}
          onAddToQueue={handleAddToQueue}
          onRemoveFromQueue={handleRemoveFromQueue}
          onSubmitBatch={handleSubmitBatch}
          onClose={closeDialog}
          instances={instances}
        />
        {activeStage.key === 'DRY_IN' && selectedBlock && (
          <DryingFiltersPanel
            filters={filtersInBlock(
              allFilters.filter((f: any) => f.currentLifecycleState === 'DRY_IN'),
              selectedBlock?.id,
              ahuBlockMap,
            )}
            refreshFilters={refreshFilters}
            setToast={setToast}
            setPopupError={setPopupError}
          />
        )}
        <CleaningReasonDialog dialog={reasonDialog} onClose={() => { core.dispatch({ type: 'close' }); setReasonError(''); }} onSubmit={handleReasonSubmit} loading={loading} error={reasonError} onClearError={() => setReasonError('')} defaultReasonKey={pmReasonCtx.defaultReasonKey} pmDue={pmReasonCtx.pmDue} />
        <EquipmentDialog dialog={equipmentDialog} onClose={() => core.dispatch({ type: 'close' })} onSubmit={handleEquipmentSubmit} loading={equipmentLoading} error={equipmentError} online={online} />
        <DryerDurationDialog open={!!dryerDialog} filterName={dryerDialog?.filterName ?? ''} loading={dryerLoading} error={dryerError} onClose={() => { core.dispatch({ type: 'close' }); setDryerError(''); }} onSubmit={handleDryerDurationSubmit} />
        <ChecklistDialog dialog={checklistDialog} onClose={() => core.dispatch({ type: 'close' })} onSubmit={handleChecklistSubmit} loading={checklistLoading} error={checklistError} />
        <ReauthDialog open={reauth.isOpen} password={reauth.password} error={reauth.error} isVerifying={reauth.isVerifying} onPasswordChange={reauth.setPassword} onConfirm={reauth.confirm} onCancel={reauth.cancel} actionLabel="Filter Operation" />
        <BlockChangeRequestDialog
          dialog={blockChangeDialog}
          reason={blockChangeReason}
          onReasonChange={setBlockChangeReason}
          submitting={blockChangeSubmitting}
          onSubmit={handleBlockChangeRequest}
          onCancel={() => { core.dispatch({ type: 'close' }); }}
          mode={blockChangeMode}
        />
        <ErrorPopup error={popupError} onClose={() => setPopupError('')} />
      </div>
    );
  }

  return (
    <div className="p-4 md:p-6 max-w-5xl mx-auto space-y-6">
      {/* Toast Notification */}
      {toast && (
        <div className={`fixed top-4 left-1/2 -translate-x-1/2 z-[100] px-5 py-3 rounded-xl shadow-2xl flex items-center gap-3 text-sm font-medium transition-all animate-in ${toast.type === 'success' ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
          <span>{toast.type === 'success' ? '\u2713' : '\u2717'}</span>
          <span>{toast.message}</span>
        </div>
      )}

      {pendingCount > 0 && (
        <div className="mx-4 mb-2 px-4 py-2 bg-amber-50 border border-amber-200 rounded-xl flex items-center justify-between">
          <span className="text-sm text-amber-700 font-medium">{pendingCount} operation(s) pending sync</span>
          <div className="flex gap-2">
            <button onClick={manualSync} disabled={syncing} className="px-3 py-1 bg-amber-100 text-amber-800 rounded-lg text-xs font-medium">{syncing ? 'Syncing...' : 'Sync Now'}</button>
            <button onClick={() => { if (confirm('Clear all pending?')) clearQueue(); }} className="px-2 py-1 bg-red-50 text-red-600 rounded-lg text-xs">Clear</button>
          </div>
        </div>
      )}

      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-800">Filter Operations</h1>
        <div className="flex bg-slate-100 rounded-xl p-1">
          <button onClick={() => { setMode('operations'); setSelectedStatusStage(null); }}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'operations' ? 'bg-cyan-600 text-white' : 'text-slate-500 hover:text-slate-700'}`}>
            Cleaning
          </button>
          <button onClick={() => setMode('status')}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${mode === 'status' ? 'bg-cyan-600 text-white' : 'text-slate-500 hover:text-slate-700'}`}>
            Filter Status
          </button>
        </div>
      </div>

      {mode === 'operations' && (
        <>
          <p className="text-slate-500 text-sm -mt-4">Select a cleaning stage to process filters</p>
          <div className="grid grid-cols-3 gap-3">
            {CLEANING_STAGES.map((stage) => (
              <button key={stage.key} onClick={() => handleStageClick(stage)}
                className={`bg-gradient-to-br ${stage.color} border-2 ${stage.border} rounded-2xl p-6 text-center transition-all hover:scale-[1.03] hover:shadow-lg hover:shadow-cyan-600/10 active:scale-[0.98]`}>
                <div className="text-4xl mb-3">{stage.icon}</div>
                <div className="text-white font-bold text-lg">{stage.label}</div>
                {stage.needsBlock && <div className="text-white/50 text-[10px] mt-2 uppercase tracking-wider">Block Selection Required</div>}
              </button>
            ))}
          </div>

          {recentSubmissions.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-2xl p-5">
              <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wider mb-3">Recent Submissions</h3>
              <div className="space-y-2">
                {recentSubmissions.map((sub, i) => (
                  <div key={sub.filter + '-' + sub.stage + '-' + sub.time} className="flex items-center gap-3 py-2 border-b border-slate-200 last:border-0 text-sm">
                    <span className="w-2 h-2 bg-green-500 rounded-full" />
                    <span className="text-slate-500 w-20 shrink-0">{sub.time}</span>
                    <span className="text-slate-700 font-medium">{sub.filter}</span>
                    <span className="text-cyan-600">\u2192 {sub.stage}</span>
                    {sub.block && <span className="text-slate-400 text-xs">({sub.block})</span>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      {mode === 'status' && (
        <>
          <p className="text-slate-500 text-sm -mt-4">Click a stage to see filters currently in that state</p>
          <div className="grid grid-cols-3 gap-3">
            {CLEANING_STAGES.map((stage) => {
              const count = stageCounts[stage.key] ?? 0;
              const isActive = selectedStatusStage === stage.key;
              return (
                <button key={stage.key}
                  onClick={() => setSelectedStatusStage(isActive ? null : stage.key)}
                  className={`bg-gradient-to-br ${stage.color} border-2 ${isActive ? 'border-cyan-400 ring-2 ring-cyan-400/30 scale-[1.03]' : stage.border} rounded-2xl p-4 text-center transition-all hover:scale-[1.02] active:scale-[0.98] relative`}>
                  <div className="text-2xl mb-1">{stage.icon}</div>
                  <div className="text-white font-semibold text-xs">{stage.label}</div>
                  <div className={`mt-2 inline-flex items-center justify-center min-w-[28px] h-7 rounded-full font-bold text-sm ${count > 0 ? 'bg-white/20 text-white' : 'bg-white/5 text-white/30'}`}>
                    {count}
                  </div>
                  {isActive && <div className="absolute -top-1 -right-1 w-4 h-4 bg-cyan-400 rounded-full border-2 border-white" />}
                </button>
              );
            })}
          </div>

          {selectedStatusStage && (
            <div className={`${selectedStageInfo?.activeBg ?? 'bg-slate-50'} border border-slate-200 rounded-2xl p-5`}>
              <div className="flex items-center gap-3 mb-4">
                <span className="text-2xl">{selectedStageInfo?.icon}</span>
                <div>
                  <h2 className="text-lg font-bold text-slate-800">{selectedStageInfo?.label}</h2>
                  <p className="text-sm text-slate-500">{filtersInStage.length} filter(s)</p>
                </div>
              </div>
              {filtersInStage.length === 0 ? (
                <div className="text-center py-8 text-slate-400">No filters in this stage</div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {filtersInStage.map((filter) => (
                    <div key={filter.id} className="bg-white border border-slate-200 rounded-xl p-4">
                      <div className="flex items-center justify-between">
                        <span className="font-semibold text-slate-800">{filter.name}</span>
                        {filter.set && (
                          <span className={`px-2 py-0.5 text-[10px] rounded-full font-medium ${filter.set === 'SET_A' ? 'bg-indigo-50 text-indigo-700' : 'bg-purple-50 text-purple-700'}`}>
                            Set {filter.set.replace('SET_', '')}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* Stage Dialog */}
      <StageScanDialog
        activeStage={activeStage}
        step={step}
        blocks={blocks}
        selectedBlock={selectedBlock}
        scanValue={scanValue}
        remarks={remarks}
        error={error}
        loading={loading}
        queue={scanQueue}
        addingToQueue={addingToQueue}
        onScanValueChange={setScanValue}
        onRemarksChange={setRemarks}
        onClearError={() => setError('')}
        onBlockSelect={handleBlockSelect}
        onChangeBlock={() => {
          // B7.4 follow-up (Issue #1): clear stale advisory before
          // returning to block-picker; mirror of the fullPage variant
          // above so both render paths behave identically.
          setEquipmentGroupSyncWarning(null);
          setStep('block');
        }}
        onAddToQueue={handleAddToQueue}
        onRemoveFromQueue={handleRemoveFromQueue}
        onSubmitBatch={handleSubmitBatch}
        onClose={closeDialog}
        instances={instances}
      />

      {/* Cleaning Reason Dialog */}
      <CleaningReasonDialog
        dialog={reasonDialog}
        onClose={() => { core.dispatch({ type: 'close' }); setReasonError(''); }}
        onSubmit={handleReasonSubmit}
        loading={loading}
        error={reasonError}
        onClearError={() => setReasonError('')}
        defaultReasonKey={pmReasonCtx.defaultReasonKey}
        pmDue={pmReasonCtx.pmDue}
      />

      {/* Equipment Group & Instrument Readings Dialog */}
      <EquipmentDialog
        dialog={equipmentDialog}
        onClose={() => core.dispatch({ type: 'close' })}
        onSubmit={handleEquipmentSubmit}
        loading={equipmentLoading}
        error={equipmentError}
        online={online}
      />

      {/* Dryer Duration Dialog */}
      <DryerDurationDialog
        open={!!dryerDialog}
        filterName={dryerDialog?.filterName ?? ''}
        loading={dryerLoading}
        error={dryerError}
        onClose={() => { core.dispatch({ type: 'close' }); setDryerError(''); }}
        onSubmit={handleDryerDurationSubmit}
      />

      {/* Checklist Dialog */}
      <ChecklistDialog
        dialog={checklistDialog}
        onClose={() => core.dispatch({ type: 'close' })}
        onSubmit={handleChecklistSubmit}
        loading={checklistLoading}
        error={checklistError}
      />

      {/* Reauth Dialog */}
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Filter Operation"
      />

      {/* Block Change Request Dialog */}
      <BlockChangeRequestDialog
        dialog={blockChangeDialog}
        reason={blockChangeReason}
        onReasonChange={setBlockChangeReason}
        submitting={blockChangeSubmitting}
        onSubmit={handleBlockChangeRequest}
        onCancel={() => { core.dispatch({ type: 'close' }); }}
        mode={blockChangeMode}
      />

      {/* AHU Filter-Set Chooser — shown before the completion popup (2026-07-03) */}
      {ahuSetChooser && (
        <AhuSetChooserDialog
          onChoose={(set) => {
            setAhuSetChooser(false);
            ahuSetResolveRef.current?.(set);
            ahuSetResolveRef.current = null;
          }}
          onCancel={() => {
            setAhuSetChooser(false);
            ahuSetResolveRef.current?.(null);
            ahuSetResolveRef.current = null;
          }}
        />
      )}

      {/* AHU Remaining Filters Dialog (Task 7) */}
      {ahuDialogState && (
        <RemainingFiltersDialog
          mode={ahuDialogState.mode}
          ahus={ahuDialogState.ahus}
          currentFilterIds={ahuDialogState.currentFilterIds}
          onContinue={() => {
            ahuDialogResolveRef.current?.(true);
            ahuDialogResolveRef.current = null;
            setAhuDialogState(null);
          }}
          onCancel={() => {
            ahuDialogResolveRef.current?.(false);
            ahuDialogResolveRef.current = null;
            setAhuDialogState(null);
          }}
        />
      )}

      {/* Error Popup */}
      <ErrorPopup error={popupError} onClose={() => setPopupError('')} />
    </div>
  );
}
