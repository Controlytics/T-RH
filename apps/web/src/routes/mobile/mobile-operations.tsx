import { useState, useEffect, useRef, useMemo } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { apiClient } from '../../lib/api-client';
import { useAuth } from '../../hooks/use-auth';
import { useDatetimeFormat } from '../../hooks/use-datetime-format';
import { useOffline } from '../../hooks/use-offline';
import { useReauth } from '../../hooks/use-reauth';
import { useToast } from '@/hooks/use-toast';
import { ReauthDialog } from '../../components/reauth-dialog';
import { onSyncEvent } from '../../lib/sync-engine';
import { DryerDurationDialog } from '../filter-management/components/dryer-duration-dialog';
import { formatByLeastCount } from '@/lib/format-by-least-count';
import { buildAhuBlockMap, filtersInBlock } from '@/lib/ahu-block-map';
import { subscribeRfidTags } from '@/lib/rfid-bridge';
// Phase 8.6 — shared executor + action-tape resolver + offline-cache helper.
// All graph-walking decisions (next-stage, checklist-after-stage, cache
// rewrites) route through these so client/server stay in lockstep.
import { actionsForStage, getCurrentActions, hasActionKind } from '@/lib/action-tape';
import {
  cacheServerStateResponse,
  recomputeAndCacheFilterState,
} from '@/lib/offline-cache';
// Phase 8.7 Wave-5 split — shared with desktop filter-operations.tsx.
// validateOfflineGate + checklist-resolver + dryer countdown helpers all live
// in lib/filter-ops so the two pages cannot drift again.
import {
  validateOfflineGate,
  resolvePendingChecklistDialog,
  resolveChecklistForTargetStage,
  findNextPendingChecklist,
  useNowTick,
  buildTempOptionsLinear,
  findDryerTempInstrument,
  projectDryerCountdown,
} from '@/lib/filter-ops';
import type { PendingChecklistBatchItem } from '@/lib/filter-ops';
// D1/D2/D4 refactor Day 3b (2026-05-18) — useFilterOperationsCore is now
// authoritative. All dialog state lives in core.dialogState; all writes
// go through core.dispatch / core.advance / core.startAndAdvance / core.submitChecklist.
import { useFilterOperationsCore } from '@/lib/filter-ops/use-core';
import { prettyStage as interlockStageLabel } from '@/lib/stage-approval';
// Task 7 — AHU completion pre-flight (Remaining Filters dialog).
import { useAhuCompletionMode } from '../../hooks/use-ahu-completion-mode';
import { checkAhuCompletionBatch, checkAhuHasBothSets, isTerminalChecklist } from '../../lib/filter-ops/ahu-completion-check';
import { RemainingFiltersDialog } from '../filter-management/components/remaining-filters-dialog';
import { AhuSetChooserDialog, type FilterSetChoice } from '../filter-management/components/ahu-set-chooser-dialog';

import { CLEANING_STAGES_MOBILE as STAGES } from '@/lib/filter-constants';
// Task 3 — batch the ONLINE mid-cycle advances into one /bulk-operate POST.
import { bulkOperate, type BulkClientItem, type BulkClientResult } from '@/lib/filter-ops/bulk-operate';

type View = 'home' | 'status' | 'stage' | 'my-tasks' | 'approvals' | 'cycles';

// Build identifier→filter map from identifiers list
function buildIdentifierMap(identifiers: any[]): Record<string, { filterId: string; filterName: string }> {
  const list = Array.isArray(identifiers) ? identifiers : [];
  const map: Record<string, { filterId: string; filterName: string }> = {};
  for (const ident of list) {
    if (ident.identifierValue && ident.assetId) {
      const entry = { filterId: ident.assetId, filterName: ident.asset?.name || ident.assetId };
      map[ident.identifierValue] = entry;
      map[ident.identifierValue.toUpperCase()] = entry;
      map[ident.identifierValue.toLowerCase()] = entry;
    }
  }
  return map;
}


export function MobileOperationsPage({ initialStageKey, hideHeader }: { initialStageKey?: string; hideHeader?: boolean } = {}) {
  const { user, isLoading: authLoading, logout: authLogout } = useAuth();
  const { formatTime } = useDatetimeFormat();
  const { online, pendingCount, syncing, lastSyncMessage, executeOrQueue, manualSync, clearQueue, getQueueDetails, cacheFilterData, getOfflineFilters, cache, getCache } = useOffline();
  const reauth = useReauth();
  // ─── D1/D2/D4 Day 3b — useFilterOperationsCore is now authoritative ──────
  // Owns all dialog state + executeOrQueue invocations for the five dialogs.
  const core = useFilterOperationsCore();
  // Task 7: AHU completion mode (NONE / POPUP / INTERLOCK) from config.
  const ahuMode = useAhuCompletionMode();
  const mobileNav = useNavigate();

  // Tablet access control — which features are allowed for this role
  const { data: tabletAccess } = useSWR(user && online ? '/api/config/tablet-access/my-features' : null);
  const allowedFeatures: string[] = (tabletAccess as any)?.allowed ?? [];
  const hasFeature = (f: string) => allowedFeatures.length === 0 || allowedFeatures.includes(f); // empty = all allowed (backwards compat)

  // 2026-05-21: auth/feature redirects deferred to the final JSX block. See
  // mobile-wrapper.tsx for the same fix — early-returning before the ~50
  // hooks below caused React 19 error #300 ("Rendered fewer hooks than
  // expected") on logout when `user` flipped to undefined mid-render.

  const logout = async () => {
    await authLogout();
    mobileNav('/m/login', { replace: true });
  };

  const initialStage = initialStageKey ? STAGES.find(s => s.key === initialStageKey) : null;
  const [view, setView] = useState<View>(initialStage ? 'stage' : 'home');
  const [activeStage, setActiveStage] = useState<typeof STAGES[0] | null>(initialStage ?? null);
  const [selectedBlock, setSelectedBlock] = useState<any>(null);
  const [scanValue, setScanValue] = useState('');
  const [scanQueue, setScanQueue] = useState<Array<{ filterId: string; filterName: string; ahuName?: string; tagId: string }>>([]);
  // 2026-05-20: per-filter dryer duration (DRY_IN stage). Keyed by filterId
  // so reordering the queue doesn't lose values. Cleared on queue drain.
  const [dryerDurations, setDryerDurations] = useState<Record<string, number>>({});
  const [remarks, setRemarks] = useState('');
  // ─── Dialog state — now owned by useFilterOperationsCore (D1/D2/D4 Day 3b) ──
  // Compat aliases: read-only views into core.dialogState.
  // All writes go through core.dispatch({ type: '...' }).
  const blockChangeDialog = core.dialogState.kind === 'awaiting_block_change' ? core.dialogState : null;
  const [blockChangeReason, setBlockChangeReason] = useState('');
  const [blockChangeSubmitting, setBlockChangeSubmitting] = useState(false);
  // 2026-06-09: block-change approval → operator self-confirm. Filters confirmed for
  // cross-block cleaning (start payload sends acknowledgeBlockChange=true).
  const ackedBlockFiltersRef = useRef<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [recentOps, setRecentOps] = useState<Array<{ stage: string; filter: string; time: string; queued?: boolean; status?: 'ok' | 'failed'; msg?: string }>>([]);
  // 2026-05-25: combined-screen UX. When a stage submit triggers a follow-up
  // checklist dialog (resolveAndDispatchChecklist auto-opens it), we want the
  // operator to see the stage readings they just submitted at the top of the
  // checklist dialog — so both readings + checklist are visible on a single
  // screen instead of looking like two unrelated steps. We snapshot the
  // readings + stage right before advance fires and clear after the checklist
  // closes. `readings` is an instrument-id keyed map; we resolve the labels
  // (description + uom) lazily from the active stage's `instrumentsForStage`
  // when rendering, so the snapshot stays small and stable.
  const [stageSubmitRecap, setStageSubmitRecap] = useState<{
    stage: string;
    filterName: string;
    readings: Array<{ description: string; value: string | number; uom: string }>;
    submittedAt: string;
  } | null>(null);
  // B7.4 (2026-05-02): advisory shown when admin edited the cycle's pinned
  // EquipmentGroup mid-cycle. Persistent (no auto-clear) — operator can keep
  // working on the pinned ranges, but should know the live group has moved.
  // Cleared on goHome / openStage / scan reset.
  const [equipmentGroupSyncWarning, setEquipmentGroupSyncWarning] = useState<{
    groupId: string;
    pinnedVersion: number;
    liveVersion: number;
    recommendation: 'CONTINUE_OR_TERMINATE_AND_RESTART';
  } | null>(null);
  // Stage interlock — current stage (Wash Out / Dry Out) awaiting QA approval.
  const [interlock, setInterlock] = useState<{
    gatedStage: boolean; stageKey: string | null; status: string | null;
    approvalId: string | null; approverRole: string | null; blocksLeaving: boolean;
  } | null>(null);
  // Task 7 + 2026-07-02: AHU remaining-filters dialog state (multi-AHU carousel).
  const [ahuDialogState, setAhuDialogState] = useState<{
    mode: 'POPUP' | 'INTERLOCK';
    ahus: { ahuName: string; allAtFinal: boolean; filters: { id: string; name: string; stage: string; done: boolean }[] }[];
    currentFilterIds: string[];
  } | null>(null);
  const ahuDialogResolveRef = useRef<((proceed: boolean) => void) | null>(null);
  // 2026-07-03: filter-set chooser shown BEFORE the AHU popup. Choice scopes the
  // status check AND rides in the submit body via ahuSetChoiceRef.
  const [ahuSetChooser, setAhuSetChooser] = useState<boolean>(false);
  const ahuSetResolveRef = useRef<((set: FilterSetChoice | null) => void) | null>(null);
  const ahuSetChoiceRef = useRef<FilterSetChoice | null>(null);

  // RFID scan input ref + focus management. autoFocus only fires once on mount,
  // so after the first scan succeeds the input loses focus and subsequent RFID
  // keystrokes hit document.body — third-party apps work because they keep one
  // input permanently focused. We do the same: refocus after every successful
  // scan, dialog close, view change, AND we install a global keydown trap on
  // the stage view that pipes RFID-speed keystrokes to the input regardless
  // of where focus is. (RFID readers in UKB mode type 3-50ms between keys;
  // humans type 80-300ms — anything ≤80ms is RFID.)
  const scanInputRef = useRef<HTMLInputElement>(null);
  const focusScanInput = () => {
    // setTimeout(0) so the focus runs after React commits the next paint
    setTimeout(() => { scanInputRef.current?.focus(); }, 0);
  };

  // 2026-05-20: when batch DRY_IN gate opens a checklist dialog, scanQueue +
  // dryerDurations stay populated so they can be replayed once all checklists
  // in the batch finish. This ref + effect below is the trigger: set to true
  // at the gate, watched by an effect that fires handleSubmitQueue when the
  // checklist dialog walks to 'none'. Without this, the per-filter SET_DURATION
  // advances never fire — operator saw no countdowns after batch DRY_IN.
  const pendingBatchReplayRef = useRef(false);
  const prevDialogKindRef = useRef<string>('none');

  // Dialogs (compat aliases — see blockChangeDialog above)
  const reasonDialog = core.dialogState.kind === 'awaiting_reason' ? core.dialogState : null;
  const equipDialog = core.dialogState.kind === 'awaiting_equipment' ? core.dialogState : null;
  const dryerDialog = core.dialogState.kind === 'awaiting_dryer' ? core.dialogState : null;
  const checklistDialog = core.dialogState.kind === 'awaiting_checklist' ? core.dialogState : null;
  const [selectedReason, setSelectedReason] = useState('');
  const [pmReasonDue, setPmReasonDue] = useState(false); // show PM banner in reason picker
  const [justification, setJustification] = useState('');
  const [selectedEquipGroup, setSelectedEquipGroup] = useState<any>(null);
  const [readings, setReadings] = useState<Record<string, number>>({});
  // Instrument auto-fetch (2026-06-13) — mirrors the shared web EquipmentDialog.
  const [equipSource, setEquipSource] = useState<Record<string, 'MANUAL' | 'AUTO' | 'AUTO_OVERRIDDEN'>>({});
  const [equipFetching, setEquipFetching] = useState(false);
  const [equipFetchStatus, setEquipFetchStatus] = useState('');
  const [equipPending, setEquipPending] = useState<Set<string>>(new Set());
  const equipCancelRef = useRef(false);
  const [dryerLoading, setDryerLoading] = useState(false);
  const [dryerError, setDryerError] = useState('');
  const [checklistAnswers, setChecklistAnswers] = useState<Record<string, any>>({});
  // 2026-05-26: unified-batch checklist (mirrors desktop filter-operations.tsx
  // `pendingBatch` state at line ~110). When multiple filters are advancing
  // through the same checklist gate, the dialog now opens ONCE with
  // filterName="N filter(s)" and pendingBatch carries every filter; on submit
  // the same answers are POSTed for each filter sequentially. Replaces the
  // pre-fix per-filter cycling via `remainingBatch`, which made the operator
  // re-answer the same checklist N times.
  const [pendingBatch, setPendingBatch] = useState<Array<{ filterId: string; filterName: string }> | null>(null);
  /**
   * Advances PARKED behind the batch checklist dialog, keyed by filterId
   * (2026-07-16). Non-empty => those filters have NOT been advanced: the dialog
   * opened first and each advance commits atomically with the answers, as ONE
   * `advance-with-checklist` per filter.
   *
   * Batch needs its own store because a single dialog covers N filters, so only
   * the primary has dialog state — `core.dialogState.deferredAdvance` can't
   * carry members 2..N. Cleared alongside `pendingBatch`; if the operator closes
   * the dialog, nothing was written and these are simply dropped.
   */
  const [pendingBatchDeferred, setPendingBatchDeferred] = useState<Map<string, { targetState: string; payload: Record<string, unknown> }> | null>(null);

  // Auto-fetch: reset per-instrument provenance/fetch state when the equipment
  // dialog opens; abort any in-flight fetch loop when it closes.
  useEffect(() => {
    if (equipDialog) {
      setEquipSource({}); setEquipFetching(false); setEquipFetchStatus(''); setEquipPending(new Set());
      equipCancelRef.current = false;
    }
    return () => { equipCancelRef.current = true; };
  }, [equipDialog]);

  // Refocus the scan input whenever we enter the stage view, all dialogs close,
  // or success flashes. autoFocus only fires once on mount, so without this
  // the operator has to manually tap the input after every successful scan
  // before the next RFID trigger does anything.
  useEffect(() => {
    if (view === 'stage' && !reasonDialog && !equipDialog && !checklistDialog && !dryerDialog && !blockChangeDialog) {
      focusScanInput();
    }
  }, [view, reasonDialog, equipDialog, checklistDialog, dryerDialog, blockChangeDialog, success]);

  // Native SDK-mode RFID bridge. When the reader is in answer/SDK mode the OS
  // does NOT inject keystrokes — Reader_Usb.jar reads tags directly via USB
  // and pushes them through Capacitor's RfidPlugin. We subscribe once on the
  // stage view and route every received tag to the scan input + auto-submit.
  // Falls back silently on web (browser) where the plugin isn't available;
  // the document-level keystroke trap below handles UKB-mode readers.
  const [rfidError, setRfidError] = useState<string | null>(null);
  useEffect(() => {
    if (view !== 'stage') return;
    let unsub: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const off = await subscribeRfidTags(
        (tag) => {
          if (cancelled) return;
          // Use the EPC as the scan value. resolveFilter() already handles
          // RFID dedup + identifier-map lookup the same way it does for keyboard input.
          const epc = (tag.epc ?? '').trim();
          if (!epc) return;
          setScanValue(epc);
          // Pass epc directly so handleAddToQueue doesn't rely on the
          // not-yet-committed scanValue state (stale-closure issue).
          handleAddToQueue(epc);
        },
        (err) => { if (!cancelled) setRfidError(err); },
      );
      if (cancelled) { try { off(); } catch {} } else unsub = off;
    })();
    return () => { cancelled = true; try { unsub?.(); } catch {} };
  }, [view, scanQueue.length]);

  // Global RFID-burst capture. UKB-mode readers inject keystrokes into the
  // focused app at 3-100ms intervals (way faster than human typing). We catch
  // those bursts at document level, build the tag string, and route it to the
  // scan input. Debug log captures every keydown so operators can verify keys
  // are actually arriving (toggle via tap on the small ⓘ in the header).
  const [rfidDebug, setRfidDebug] = useState<string[]>([]);
  const [rfidDebugVisible, setRfidDebugVisible] = useState(false);
  const pushDebug = (s: string) => setRfidDebug(prev => [s, ...prev].slice(0, 25));

  useEffect(() => {
    let buffer = '';
    let lastKeyTime = 0;
    let captureMode = false;
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const RFID_INTERVAL_MS = 150;  // ≤ this gap = RFID. Used only to gate captureMode.
    // 2026-05-20: gap-based auto-flush. Some KC-series readers send tags
    // back-to-back without Enter/Tab between them, so without this the
    // global buffer accumulates "tag-Atag-B…" and the scan input shows the
    // concatenation. After the last key of a burst, wait FLUSH_AFTER_MS for
    // another key — if none arrives, treat it as the burst end and submit.
    const FLUSH_AFTER_MS = 250;

    const handler = (e: KeyboardEvent) => {
      const now = Date.now();
      const gap = lastKeyTime === 0 ? -1 : now - lastKeyTime;
      lastKeyTime = now;

      if (e.key.length === 1 || e.key === 'Enter' || e.key === 'Tab') {
        pushDebug(`key="${e.key}" gap=${gap}ms target=${(e.target as HTMLElement)?.tagName ?? '?'}`);
      }

      // 2026-07-10: leave keystrokes destined for ANOTHER editable field alone
      // (checklist question inputs, remarks textarea, search boxes, selects).
      // This global capture-phase trap catches USB keyboard-wedge RFID input
      // when the scan field isn't focused — but fast HUMAN typing (2 chars
      // within RFID_INTERVAL_MS) was latching captureMode, mirroring the
      // keystrokes into the scan box AND preventDefault-ing them away from the
      // field the operator was typing in (the "checklist answer shows up in the
      // scan box" bug). Hardware RFID scans arrive via the native RfidPlugin
      // bridge (subscribeRfidTags), not this keyboard fallback, so nothing is
      // lost by skipping here. The scan input itself stays trapped below.
      const tgt = e.target as HTMLElement | null;
      if (
        tgt && tgt !== scanInputRef.current &&
        (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' ||
         tgt.tagName === 'SELECT' || tgt.isContentEditable)
      ) {
        // Drop any stale wedge state so a later real scan into the scan input
        // starts clean.
        buffer = '';
        captureMode = false;
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        return;
      }

      // Enter or Tab terminates an RFID burst — most readers append CR/LF/TAB.
      // Submit immediately on terminator. Zero wait.
      if (e.key === 'Enter' || e.key === 'Tab') {
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
        if (captureMode || buffer.length > 0) {
          e.preventDefault();
          if (buffer.length >= 4) {
            const toSubmit = buffer;
            pushDebug(`SUBMIT: "${toSubmit}" (len ${toSubmit.length})`);
            setScanValue('');
            if (view === 'stage') {
              // Pass buffer directly — scanValue state hasn't committed yet.
              handleAddToQueue(toSubmit);
            }
          }
          buffer = '';
          captureMode = false;
        }
        return;
      }

      if (e.key.length !== 1) return;

      // Capture rule (no time wait — every captured char is written to the input
      // immediately so operators see the tag building live):
      //   - captureMode is on (already in a burst) → continue
      //   - First key (gap === -1) → seed the buffer; next gap tells us if RFID
      //   - Fast follow-up (gap <= threshold) → RFID burst, latch captureMode
      //   - Otherwise human typing → ignore + reset stale buffer
      const isFastFollow = gap >= 0 && gap <= RFID_INTERVAL_MS;
      const isFirstKey = gap === -1;

      if (captureMode || isFastFollow || isFirstKey) {
        const target = e.target as HTMLElement | null;
        const isScanInput = target === scanInputRef.current;

        if (isFastFollow || captureMode) captureMode = true;
        buffer += e.key;

        // Live update: stuff the buffer into the scan input as each key arrives.
        // Operator sees the EPC build in real time.
        setScanValue(buffer);

        // Restart the gap-based flush timer. If no further key arrives within
        // FLUSH_AFTER_MS, submit the buffer. This catches readers that don't
        // send Enter/Tab between back-to-back tags (without this, buffer
        // accumulates "tag-Atag-B…" and only one tag is registered).
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = setTimeout(() => {
          if (buffer.length >= 4) {
            const toSubmit = buffer;
            pushDebug(`AUTO-FLUSH: "${toSubmit}" (len ${toSubmit.length})`);
            setScanValue('');
            if (view === 'stage') handleAddToQueue(toSubmit);
          }
          buffer = '';
          captureMode = false;
          flushTimer = null;
        }, FLUSH_AFTER_MS);

        if (!isScanInput && captureMode) {
          e.preventDefault();
          e.stopPropagation();
        }
      } else {
        // Human-speed key after a long gap — reset state in case prior buffer was stale
        buffer = '';
        captureMode = false;
        if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
      }
    };

    document.addEventListener('keydown', handler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
      if (flushTimer) clearTimeout(flushTimer);
    };
  }, [view, scanQueue.length]);

  // Data — always fetch when online, cache for offline
  const { data: instancesData } = useSWR(online ? '/api/assets/instances' : null, { refreshInterval: 30000 });
  const { data: templatesData } = useSWR(online ? '/api/assets/templates' : null);
  // AHU→block map to scope the "Currently Drying" panel to the selected block.
  // Filter rows carry parentId (= their AHU); these give ahu.blockId /
  // area.blockId. Online-only; when unavailable the panel safe-degrades to all.
  const { data: ahusResp } = useSWR<any>(online ? '/api/hierarchy/ahus' : null);
  const { data: areasResp } = useSWR<any>(online ? '/api/hierarchy/areas' : null);
  const ahuBlockMap = useMemo(
    () => buildAhuBlockMap(ahusResp?.data ?? [], areasResp?.data ?? []),
    [ahusResp, areasResp],
  );
  // Always attempt the reasons fetch (not gated on the `online` flag — that
  // flag is unreliable on Android WebViews and, when it flips false on an
  // actually-online device, left the cleaning-reason picker empty). Offline the
  // fetch fails gracefully and we fall back to the cached reasons below.
  const { data: reasonsData } = useSWR('/api/filters/reasons');
  // refreshInterval so the offline identifier-map cache stays current: a tag
  // reassigned to another filter (here or on admin/web) propagates within ~30s
  // of being online, so a later OFFLINE scan resolves to the right filter
  // instead of "Filter not found" (matches the instances cache cadence).
  const { data: identifiersData } = useSWR(online ? '/api/assets/identifiers' : null, { refreshInterval: 30000, revalidateOnReconnect: true });
  const { data: equipGroupsData } = useSWR(online ? '/api/equipment-groups' : null);
  // B.5 — Cache cleaning-profile-assignment + active profiles so offline scans of
  // a brand-new filter (no filter-state-{id} cache yet) can still resolve a pipeline.
  const { data: cleaningAssignmentData } = useSWR(online ? '/api/config/cleaning-profile-assignment' : null);
  const { data: activeProfilesData } = useSWR(online ? '/api/filter-cleaning-profiles?status=ACTIVE&expand=stages,connections' : null);
  const { data: checklistProfilesData } = useSWR(online ? '/api/checklist-profiles?expand=questions' : null);
  // Task 5: cache the server's blocked-filter set (AHU replacement overdue) so
  // the client-side offline gate can refuse to START a cleaning cycle on a
  // blocked filter even without a round trip. Server gate (Task 3) backstops
  // this online regardless.
  const { data: blockedFiltersData } = useSWR(online ? '/api/replacement-schedules/blocked-filters' : null, { refreshInterval: 30000, revalidateOnReconnect: true });
  // B.13 — Cache branding/field-ids/datetime config so offline app restart doesn't
  // flash defaults or break field labels until reconnect.
  const { data: brandingData } = useSWR(online ? '/api/config/branding' : null);
  const { data: fieldIdsData } = useSWR(online ? '/api/config/field-ids' : null);
  const { data: datetimeData } = useSWR(online ? '/api/config/datetime/current' : null);
  // B.14 — Cache approved block-change requests so an APPROVED status from a
  // recent server-side approval is visible offline before the cycle starts.
  const { data: approvedBlockChangesData } = useSWR(online ? '/api/block-change-requests?status=APPROVED&limit=200' : null);
  // B.11 — Cache reauth scope for current user so offline ops know which actions
  // need a queued password vs. immediate dialog.
  const { data: myReauthActionsData } = useSWR(online && user ? '/api/config/action-reauth/my-actions' : null);

  // 2026-06-09: cross-block mode (NONE no-check | CONFIRM self-confirm | APPROVAL request).
  // Reads the authenticated-only /current mirror — the SUPER_ADMIN-gated
  // dynamic route 403'd for every operator role, silently defaulting to CONFIRM.
  const { data: bcCfg } = useSWR<any>(online ? '/api/config/block-change-approval/current' : null);
  const bcModeRaw = bcCfg?.mode;
  const blockChangeMode: 'NONE' | 'CONFIRM' | 'APPROVAL' =
    bcModeRaw === 'NONE' ? 'NONE' : bcModeRaw === 'APPROVAL' ? 'APPROVAL' : 'CONFIRM';

  // My Tasks + Approvals — fetch when user opens the view, cache for offline
  const { data: dueTasksData, mutate: mutateDueTasks, isLoading: dueTasksLoading } =
    useSWR(online && view === 'my-tasks' ? '/api/pm-schedules/due' : null, { refreshInterval: 30000 });

  const isApprover = user?.role === 'SUPER_ADMIN' || (user?.permissions ?? []).includes('BLOCK_CHANGE_APPROVE');
  const [approvalsFilter, setApprovalsFilter] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>(isApprover ? 'PENDING' : 'ALL');
  const approvalsKey = (online && view === 'approvals')
    ? `/api/block-change-requests?page=1&limit=50&status=${approvalsFilter}${!isApprover ? '&mine=true' : ''}`
    : null;
  const { data: approvalsData, mutate: mutateApprovals, isLoading: approvalsLoading } =
    useSWR<any>(approvalsKey, { refreshInterval: 30000 });

  // C3 (2026-07-10): read-only stage-approval (interlock QA) status on the tablet
  // Approvals screen, honoring the same status filter. Approve/reject stays on
  // desktop. Fails silently (empty) for roles without STAGE_APPROVAL_VIEW.
  const stageApprovalsKey = (online && view === 'approvals')
    ? `/api/stage-approvals${approvalsFilter !== 'ALL' ? `?status=${approvalsFilter}` : ''}`
    : null;
  const { data: stageApprovalsData } = useSWR<any>(stageApprovalsKey, { refreshInterval: 30000 });
  const stageApprovals: any[] = stageApprovalsData?.data ?? [];

  // Issue #7 fix (2026-05-18): Cleaning Cycles list on mobile. Desktop has a
  // full /cleaning-cycles/history page but tablets had no equivalent — after
  // an offline sync, operators couldn't view the resulting cycle data without
  // a desktop. Mirror the desktop endpoint, scoped to recent cycles only.
  const { data: cyclesData, isLoading: cyclesLoading } =
    useSWR<any>(online && view === 'cycles' ? '/api/filters/cycles?page=1&limit=30&includeEvents=true' : null, { refreshInterval: 30000 });
  const [offlineCycles, setOfflineCycles] = useState<any[]>([]);
  useEffect(() => { if (cyclesData?.data) cache('cleaning-cycles-recent', cyclesData.data); }, [cyclesData, cache]);
  useEffect(() => {
    if (!online && view === 'cycles') {
      getCache<any[]>('cleaning-cycles-recent').then(c => setOfflineCycles(c ?? []));
    }
  }, [online, view, getCache]);
  const cyclesList: any[] = online ? (cyclesData?.data ?? []) : offlineCycles;
  const [expandedCycle, setExpandedCycle] = useState<string | null>(null);

  // Cache tasks and approvals for offline use
  const [offlineTasks, setOfflineTasks] = useState<any>(null);
  const [offlineApprovals, setOfflineApprovals] = useState<any[]>([]);
  useEffect(() => { if (dueTasksData) { cache('due-tasks', dueTasksData); } }, [dueTasksData, cache]);
  useEffect(() => { if (approvalsData?.data) { cache('approvals', approvalsData.data); } }, [approvalsData, cache]);
  useEffect(() => {
    if (!online) {
      getCache<any>('due-tasks').then(t => setOfflineTasks(t));
      getCache<any[]>('approvals').then(a => setOfflineApprovals(a ?? []));
    }
  }, [online, view]);

  const approvals: any[] = online ? (approvalsData?.data ?? []) : offlineApprovals;
  const tasksSource = online ? dueTasksData : offlineTasks;

  // Expand state for My Tasks cards + processing state for Approve/Reject
  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [processingApproval, setProcessingApproval] = useState<string | null>(null);
  const [approvalComment, setApprovalComment] = useState('');
  const [offlineFilters, setOfflineFilters] = useState<any[]>([]);
  const [offlineTemplates, setOfflineTemplates] = useState<any[]>([]);
  const [offlineReasons, setOfflineReasons] = useState<any[]>([]);
  const [dataCached, setDataCached] = useState(false);

  // Revalidate SWR data after sync completes (fixes "buffering" after sync)
  const [prevPendingCount, setPrevPendingCount] = useState(0);
  useEffect(() => {
    // When pending count drops (operations synced), refresh data
    if (prevPendingCount > 0 && pendingCount < prevPendingCount && online) {
      mutate('/api/assets/instances');
      mutateDueTasks();
    }
    setPrevPendingCount(pendingCount);
  }, [pendingCount, online]);

  // Also listen for sync events directly
  useEffect(() => {
    const cleanup = onSyncEvent((event) => {
      if (event.type === 'complete' && event.synced && event.synced > 0) {
        mutate('/api/assets/instances');
        mutateDueTasks();
      }
    });
    return cleanup;
  }, []);

  // Cache data when online for offline use
  useEffect(() => { if (instancesData?.data) cacheFilterData(instancesData.data); }, [instancesData]);
  useEffect(() => {
    if (identifiersData) {
      const map = buildIdentifierMap(identifiersData as any[]);
      if (Object.keys(map).length > 0) {
        cache('identifier-map', map);
      }
    }
  }, [identifiersData, cache]);
  useEffect(() => { if (templatesData?.data) cache('templates', templatesData.data, 24 * 60 * 60 * 1000); }, [templatesData, cache]);
  useEffect(() => { const r = (reasonsData as any)?.reasons ?? reasonsData; if (r) cache('cleaning-reasons', r, 24 * 60 * 60 * 1000); }, [reasonsData, cache]);
  useEffect(() => { if (equipGroupsData) cache('equipment-groups', Array.isArray(equipGroupsData) ? equipGroupsData : equipGroupsData?.data ?? [], 24 * 60 * 60 * 1000); }, [equipGroupsData, cache]);
  // B.5/B.11/B.13/B.14 — operationally-critical caches: 24h TTL so they survive long shifts
  useEffect(() => { if (cleaningAssignmentData) cache('cleaning-profile-assignment', cleaningAssignmentData, 24 * 60 * 60 * 1000); }, [cleaningAssignmentData, cache]);
  useEffect(() => {
    const list = (activeProfilesData as any)?.data ?? activeProfilesData;
    if (Array.isArray(list)) {
      cache('active-profiles', list, 24 * 60 * 60 * 1000);
      // Also store per-profile so resolveProfileForBlockOffline() can look up by id quickly
      for (const p of list) cache(`active-profile-${p.id}`, p, 24 * 60 * 60 * 1000);
    }
  }, [activeProfilesData, cache]);
  useEffect(() => {
    const list = (checklistProfilesData as any)?.data ?? checklistProfilesData;
    if (Array.isArray(list)) cache('checklist-profiles', list, 24 * 60 * 60 * 1000);
  }, [checklistProfilesData, cache]);
  useEffect(() => {
    const ids = (blockedFiltersData as any)?.filterIds;
    if (Array.isArray(ids)) cache('blocked-filter-ids', ids, 24 * 60 * 60 * 1000);
  }, [blockedFiltersData, cache]);
  useEffect(() => { if (brandingData) cache('branding-config', brandingData, 24 * 60 * 60 * 1000); }, [brandingData, cache]);
  useEffect(() => { if (fieldIdsData) cache('field-ids-config', fieldIdsData, 24 * 60 * 60 * 1000); }, [fieldIdsData, cache]);
  useEffect(() => { if (datetimeData) cache('datetime-config', datetimeData, 24 * 60 * 60 * 1000); }, [datetimeData, cache]);
  useEffect(() => {
    const list = (approvedBlockChangesData as any)?.data ?? approvedBlockChangesData;
    if (Array.isArray(list)) cache('approved-block-changes', list, 24 * 60 * 60 * 1000);
  }, [approvedBlockChangesData, cache]);
  useEffect(() => {
    const actions = (myReauthActionsData as any)?.actions ?? myReauthActionsData;
    if (actions) cache('my-reauth-actions', actions, 24 * 60 * 60 * 1000);
  }, [myReauthActionsData, cache]);

  // Batch-cache all filter states for offline use (single API call instead of N calls).
  // B.4 — surface failures via state so the "Data Synced" indicator can show a
  // warning instead of silently leaving the operator with a stale cache. Manual
  // re-cache button below uses the same function.
  const [batchCacheError, setBatchCacheError] = useState<string | null>(null);
  const [batchCacheTimestamp, setBatchCacheTimestamp] = useState<string | null>(null);
  const [recaching, setRecaching] = useState(false);
  const cacheAllStates = async (): Promise<{ ok: boolean; count: number; error?: string }> => {
    try {
      const result = await apiClient.get<{ states: Record<string, any>; cachedAt: string }>('/api/filters/batch-states');
      if (result?.states) {
        let count = 0;
        for (const [fid, st] of Object.entries(result.states)) {
          await cache(`filter-state-${fid}`, st, 24 * 60 * 60 * 1000);
          count++;
        }
        setBatchCacheError(null);
        setBatchCacheTimestamp(result.cachedAt ?? new Date().toISOString());
        return { ok: true, count };
      }
      setBatchCacheError('Batch states endpoint returned no data');
      return { ok: false, count: 0, error: 'No data' };
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      setBatchCacheError(msg);
      return { ok: false, count: 0, error: msg };
    }
  };
  useEffect(() => {
    if (!online || !instancesData?.data) return;
    const timer = setTimeout(cacheAllStates, 2000);
    return () => clearTimeout(timer);
  }, [online, instancesData]);
  const manualRecache = async () => {
    if (!online || recaching) return;
    setRecaching(true);
    try {
      const r = await cacheAllStates();
      if (r.ok) setSuccess(`Re-cached ${r.count} filter states for offline use`);
      else setError(`Re-cache failed: ${r.error ?? 'unknown'}`);
    } finally {
      setRecaching(false);
    }
  };

  // Track when all data is cached and ready for offline
  useEffect(() => {
    if (online && instancesData?.data && templatesData?.data && identifiersData && reasonsData) {
      setDataCached(true);
    }
  }, [online, instancesData, templatesData, identifiersData, reasonsData]);

  // Load cached data when offline
  const refreshOfflineData = () => {
    getOfflineFilters().then(setOfflineFilters);
    getCache<any[]>('templates').then(t => setOfflineTemplates(t ?? []));
    getCache<any[]>('cleaning-reasons').then(r => setOfflineReasons(r ?? []));
  };
  useEffect(() => {
    if (!online) refreshOfflineData();
  }, [online]);
  // Issue #5 fix (2026-05-18): home/status tile counters were rendering
  // stale state-counts (e.g. Wash In: 1 even after the filter advanced to
  // Wash Out offline). `recomputeAndCacheFilterState` correctly writes the
  // new currentLifecycleState to IndexedDB, but `refreshOfflineData()` is
  // fire-and-forget at the call site — if React happened to render before
  // setOfflineFilters resolved, the tile saw the old in-memory snapshot.
  // pendingCount changes whenever the queue grows (new offline op) or
  // shrinks (sync completed), so it's the right tripwire for re-reading
  // the cache and updating the counts.
  useEffect(() => {
    refreshOfflineData();
  }, [pendingCount]);

  // Prefer freshly-fetched reasons whenever the fetch returned any (regardless
  // of the flaky `online` flag); fall back to the cached reasons only when the
  // fetch yielded nothing (genuinely offline).
  const fetchedReasons = ((reasonsData as any)?.reasons ?? reasonsData ?? []) as any[];
  const cleaningReasons = fetchedReasons.length > 0 ? fetchedReasons : offlineReasons;
  const templates = (online ? (templatesData?.data ?? []) : offlineTemplates) as any[];
  const instances = online ? ((instancesData?.data ?? []) as any[]) : offlineFilters;
  // Match against every FILTER-kind template, not just one (history.tsx bug
  // fix from 2026-05-12 fanned out — single .find()?.id silently dropped
  // filters belonging to a second/third FILTER-kind template).
  const filterTemplateIds = new Set(
    templates.filter((t: any) => t.templateKind === 'FILTER').map((t: any) => t.id),
  );
  const blockTemplateId = templates.find((t: any) => t.templateKind === 'BLOCK')?.id;
  // Templates-loaded path: Set membership. First-paint fallback: the
  // instance carries its eager-loaded `template.templateKind` per
  // assets/instance.repository.ts. Same rename-stable filter as desktop.
  const allFilters = instances.filter((f: any) =>
    (filterTemplateIds.has(f.templateId) || f.template?.templateKind === 'FILTER') &&
    f.isActive !== false && f.status !== 'Retired'
  );
  const blocks = instances.filter((i: any) => i.templateId === blockTemplateId);

  const stageCounts: Record<string, number> = {};
  allFilters.forEach((f: any) => { if (f.currentLifecycleState) stageCounts[f.currentLifecycleState] = (stageCounts[f.currentLifecycleState] ?? 0) + 1; });

  // Per operator request 2026-05-25: every message (error / success /
  // warning) surfaces as a toast popup — no inline banners. Inline banners
  // were getting buried beneath scrollable content and operators missed
  // them. Toast pops at the top of the page from any view.
  const { toast } = useToast();
  useEffect(() => {
    if (error) {
      toast.error('Error', error);
      const t = setTimeout(() => setError(''), 100);
      return () => clearTimeout(t);
    }
  }, [error]);
  useEffect(() => {
    if (success) {
      toast.success('Success', success);
      const t = setTimeout(() => setSuccess(''), 100);
      return () => clearTimeout(t);
    }
  }, [success]);
  useEffect(() => {
    if (equipmentGroupSyncWarning) {
      toast.error(
        'Equipment group changed',
        `Admin updated this group (you started on v${equipmentGroupSyncWarning.pinnedVersion}, current is v${equipmentGroupSyncWarning.liveVersion}). Readings still validate against your pinned version — terminate-and-restart only if you need the new ranges.`,
      );
    }
  }, [equipmentGroupSyncWarning]);
  // batchCacheError stays as an inline banner because it carries a Retry button;
  // a toast can't host the action. rfidError also stays inline — it's stage-
  // local and the toast wouldn't see the same view scope.

  const openStage = (stage: typeof STAGES[0]) => {
    setActiveStage(stage);
    setView('stage');
    setScanValue(''); setRemarks(''); setError(''); setSuccess(''); setSelectedBlock(null);
    setEquipmentGroupSyncWarning(null);
  };

  // 2026-05-17 stale-stage-counter fix: force-revalidate `instances` when
  // returning to home. SWR's `refreshInterval: 15000` means the dashboard's
  // per-stage filter counts can lag the actual cycle state for up to 15s
  // after a submit if the operator navigates back-and-forth quickly. Forcing
  // a revalidate on home-enter gives an upper-bound staleness of one fetch
  // round-trip (~200ms on LAN) instead of waiting for the next poll tick.
  // Online-only — offline mode keeps the last server snapshot until reconnect,
  // since per-stage counters can't be derived from local optimistic state
  // without re-projecting every cached filter (separate follow-up).
  const goHome = () => {
    setView('home'); setActiveStage(null); core.dispatch({ type: 'close' }); setError(''); setSuccess(''); setScanQueue([]); setDryerDurations({}); setEquipmentGroupSyncWarning(null); setStageSubmitRecap(null);
    if (online) mutate('/api/assets/instances');
  };

  // 2026-05-20: accept an explicit `rawValue` arg so RFID-driven scans can
  // pass the EPC directly, bypassing the stale-closure problem where
  // setScanValue(epc) + immediate handleAddToQueue() sees the OLD scanValue
  // (React state update isn't observable inside the same callback frame).
  // The keyboard-input path falls back to reading scanValue as before.
  const resolveFilter = async (rawValue?: string): Promise<{ filterId: string; filterName: string; ahuName?: string } | null> => {
    let filterId = ''; let filterName = '';
    const source = rawValue ?? scanValue;

    // Deduplicate RFID scan value (reader may repeat tag ID)
    let sv = source.trim().toUpperCase();
    if (sv.length >= 6 && sv.length % 2 === 0) {
      const half = sv.length / 2;
      if (sv.substring(0, half) === sv.substring(half)) sv = sv.substring(0, half);
    }
    if (sv.length >= 9 && sv.length % 3 === 0) {
      const third = sv.length / 3;
      if (sv.substring(0, third) === sv.substring(third, third * 2) && sv.substring(0, third) === sv.substring(third * 2)) sv = sv.substring(0, third);
    }

    // Identifier lookup API — FIRST of three fallback strategies. Do NOT gate on
    // the `online` flag: navigator.onLine is unreliable on Android WebViews, so a
    // stale false-negative would skip a REACHABLE server and fall back to a stale
    // cached map — exactly the "Filter not found after a tag is reassigned to
    // another filter" bug (the cache still maps the tag to the old filter, or
    // lacks the new one). A genuinely-offline call throws (or returns the SPA
    // shell) and falls through to the cached map. 404 / network error are
    // non-fatal and intentionally silent.
    try {
      const l = await apiClient.get<any>(`/api/assets/identifiers/lookup/${encodeURIComponent(sv)}`);
      if (l?.asset?.id) {
        filterId = l.asset.id; filterName = l.asset.name;
        // Self-heal the offline cache so a later OFFLINE scan of this (possibly
        // just-reassigned) tag resolves to the CURRENT filter, not a stale one.
        try {
          const m = (await getCache<Record<string, { filterId: string; filterName: string }>>('identifier-map')) || {};
          const entry = { filterId: filterId as string, filterName: filterName as string };
          m[sv] = entry; m[sv.toUpperCase()] = entry; m[sv.toLowerCase()] = entry;
          await cache('identifier-map', m);
        } catch { /* best-effort cache write */ }
      }
    } catch { /* offline / network error — fall through to cached map */ }

    // Try cached identifier map (works both online and offline)
    if (!filterId) {
      try {
        const map = await getCache<Record<string, { filterId: string; filterName: string }>>('identifier-map');
        if (map) {
          const match = map[sv] || map[sv.toUpperCase()] || map[sv.toLowerCase()] || map[source.trim()];
          if (match) { filterId = match.filterId; filterName = match.filterName; }
        }
      } catch { /* IDB read failed — fall through to name match below */ }
    }

    // Fallback: match by filter name in cached instances
    if (!filterId) { const m = allFilters.find((a: any) => a.name?.toLowerCase() === sv.toLowerCase()); if (m) { filterId = m.id; filterName = m.name; } }
    if (!filterId && sv.match(/^[0-9a-f]{8}-/i)) { filterId = sv; filterName = sv.slice(0, 8); }
    if (!filterId) {
      // Show the exact value we looked up (normalized + raw if different) so a
      // value-mismatch — scanned EPC ≠ the stored RFID number — is visible. The
      // server resolves the stored number exactly; if this value isn't found,
      // it doesn't match any assigned tag.
      const rawShown = source.trim();
      setError(`Filter not found for tag "${sv}"${rawShown !== sv ? ` (scanned "${rawShown}")` : ''}. ${online ? 'This value is not assigned to any filter on the server — the scanned value may differ from the stored RFID number.' : "You're offline and this tag isn't cached — connect once to sync."}`);
      return null;
    }
    // 2026-05-20: resolve parent AHU name so the queue display can show
    // "{filterName} · {ahuName}" — operators on the floor identify filters
    // by their AHU context, not by serial alone. Lookup against the same
    // instances cache that powers allFilters; both filter and AHU live there.
    const filterRow = instances.find((i: any) => i.id === filterId);
    let ahuName: string | undefined;
    if (filterRow?.parentId) {
      const parent = instances.find((i: any) => i.id === filterRow.parentId);
      if (parent?.name) ahuName = parent.name;
    }
    return { filterId, filterName, ahuName };
  };

  // Add scanned filter to queue (batch mode).
  // 2026-05-20: accept an explicit `rawValue` arg so RFID-driven scans
  // bypass the stale-closure problem (setScanValue + immediate call sees
  // the old value). Falls back to scanValue for the keyboard Enter path.
  const handleAddToQueue = async (rawValue?: string) => {
    const value = (rawValue ?? scanValue).trim();
    if (!value) return;
    setError('');
    const resolved = await resolveFilter(value);
    if (!resolved) return;
    if (scanQueue.some(q => q.filterId === resolved.filterId)) {
      setError('Filter already in queue');
      setScanValue('');
      return;
    }
    // Dedup INSIDE the functional updater too, not only the closure check above:
    // an RFID reader re-fires the same tag rapidly, so two handleAddToQueue calls
    // can run before a re-render — both see a stale `scanQueue` and pass the check
    // above. The updater sees the accumulated `prev`, so the duplicate is dropped.
    setScanQueue(prev =>
      prev.some(q => q.filterId === resolved.filterId) ? prev : [...prev, { ...resolved, tagId: value }],
    );
    // 2026-05-20: pre-populate per-filter dryer duration with a sensible
    // default so the Submit-All button is enabled out of the box. Operator
    // can change per row before submitting. Only meaningful on DRY_IN
    // stage; harmlessly ignored on others.
    if (activeStage?.key === 'DRY_IN') {
      setDryerDurations(prev => ({ ...prev, [resolved.filterId]: prev[resolved.filterId] ?? 30 }));
    }
    setScanValue('');
  };

  const removeFromQueue = (filterId: string) => {
    setScanQueue(prev => prev.filter(q => q.filterId !== filterId));
    setDryerDurations(prev => { const next = { ...prev }; delete next[filterId]; return next; });
  };

  // Post one batch of resolved ops to /bulk-operate (online only). Primes each ok
  // filter's cache from its returned snapshot and exposes the per-filter
  // post-write `actions` tape so the callers' existing post-loop checklist
  // dispatch keeps working.
  //
  // Reauth: wraps the ONE batch POST in reauth.executeWithResult — for a
  // reauth-gated action (START_CLEANING_CYCLE / SUBMIT_CHECKLIST_WITH_SIGNATURE for
  // the enabled role) it opens the password dialog and resolves with the POST
  // result once the operator confirms; for reauth-off actions (advance) it posts
  // inline. Returns 'cancelled' if the operator declines the dialog and
  // 'transport_error' on a wholesale failure — both keep the caller's queue for
  // retry (the operator re-submits).
  const runBulkOnline = async (
    ops: BulkClientItem[],
    reauthAction: string,
  ): Promise<{ results: BulkClientResult[]; actionsByFilter: Map<string, any[]>; okCount: number; failures: string[] } | 'transport_error' | 'cancelled'> => {
    let resp: { results: BulkClientResult[] };
    try {
      resp = await reauth.executeWithResult(reauthAction, (password?: string) => bulkOperate(ops, password));
    } catch (e: any) {
      if (e?.error === 'REAUTH_CANCELLED') return 'cancelled';
      return 'transport_error';
    }
    const actionsByFilter = new Map<string, any[]>();
    const failures: string[] = [];
    let okCount = 0;
    for (const r of resp.results) {
      if (r.status === 'ok') {
        okCount++;
        if (r.snapshot) {
          await cache(`filter-state-${r.filterId}`, r.snapshot, 24 * 60 * 60 * 1000);
          if (Array.isArray((r.snapshot as any).actions)) actionsByFilter.set(r.filterId, (r.snapshot as any).actions);
        }
      } else {
        failures.push(`${r.filterId}: ${r.error?.message ?? 'failed'}`);
      }
    }
    return { results: resp.results, actionsByFilter, okCount, failures };
  };

  // Submit all queued filters for the active stage (batch advance for mid-cycle stages).
  // Each item is validated against the cached pipeline graph + block assignment BEFORE
  // being queued — this is the same strict offline gate applied in handleSubmit.
  const handleSubmitQueue = async () => {
    if (scanQueue.length === 0 || !activeStage || loading) return;
    setLoading(true); setError(''); setSuccess('');
    // 2026-05-20: snapshot the queue BEFORE the loop so the post-batch
    // current-state prime can target every filter even after setScanQueue([])
    // clears the live state.
    const scanQueueSnapshot = scanQueue.slice();
    let successCount = 0;
    const failed: string[] = [];
    // 2026-05-26: capture per-filter server tape so the post-loop checklist
    // dispatch can pass authoritative server actions to
    // resolvePendingChecklistDialog instead of falling back to local
    // recompute (which depends on cache state that the post-loop /current-
    // state prime overwrites before the dispatch runs).
    const serverActionsByFilter = new Map<string, any[]>();
    // Task 3: ONLINE advance leaves accumulate a resolved op here instead of
    // firing a per-filter network call. After the loop, all of these post in ONE
    // /bulk-operate request (see the runBulkOnline dispatch below). Offline leaves
    // are untouched — they still go through executeOrQueue/core.advance.
    const bulkOps: BulkClientItem[] = [];
    // 2026-07-16: filters whose target stage carries a mandatory checklist. Their
    // advance is NOT dispatched in the loop — it is parked here, the dialog opens
    // after the loop, and each commits atomically with the answers. Works online
    // and offline (resolution is cache-first).
    const deferredAdvances = new Map<
      string,
      { item: { filterId: string; filterName: string }; payload: Record<string, unknown>; checklists: any[] }
    >();
    // 2026-05-26: filters whose dialog was ALREADY dispatched inside the
    // loop by core.advance/startAndAdvance's resolveAndDispatchChecklist.
    // The post-loop dispatch must SKIP these — otherwise it tries to open
    // open_checklist from awaiting_checklist and the state-machine guard
    // throws (caught offline DRY_IN SET_DURATION repro on 2026-05-26).
    const dialogDispatchedInLoop = new Set<string>();
    // Perf (2026-07-09): read the ENTIRE cached-filter store ONCE, up front,
    // and index it by id. Pre-fix each loop iteration called getOfflineFilters()
    // — a full IDB scan of every cached filter — just to .find() its own row,
    // so a 50–100 tag batch did 50–100 full-store reads (O(N²)). Distinct
    // filterIds per queue item mean a single snapshot is correct; each row is
    // that filter's own state and no item depends on another item's row.
    const allCachedFilters = await getOfflineFilters();
    const cachedFilterById = new Map<string, any>(
      (allCachedFilters ?? []).map((f: any) => [f.id, f]),
    );
    // Task 5: the cached blocked-filter set (AHU replacement overdue). Loaded
    // once per batch submit; the gate below only uses it on the !cycleInProgress
    // (START) branch.
    const blockedIds = new Set<string>((await getCache<string[]>('blocked-filter-ids')) ?? []);
    // Deep-review fix D6 (2026-05-17): outer try/finally so the loading flag
    // always clears even when REAUTH or OFFLINE_CACHE_RECOMPUTE_FAILED bubble
    // out of the inner loop. Pre-fix a re-thrown REAUTH left loading=true
    // and the operator's UI was stuck until refresh.
    try {
    for (const item of scanQueue) {
      try {
        const cached = cachedFilterById.get(item.filterId);
        const cachedState = await getCache<any>(`filter-state-${item.filterId}`) ?? {};
        const currentLifecycle = cached?.currentLifecycleState || cachedState.currentState || null;
        const cycleInProgress = !!(cachedState.currentCycle?.id || cached?.currentCycleId);

        // Phase 8.6 part 2: resolve the action tape — server actions[] when
        // TAPE_PARALLEL=true (currently absent in dev), else local compute via
        // the shared executor over loadLocalContextFromCache().
        //
        // Stage interlock is an ONLINE-only QA gate (commit d8afc02). Offline at
        // a gated stage (WASH_OUT / DRY_OUT) the cached server tape has the
        // advance stripped (only TERMINATE_CYCLE left), which would block the
        // offline op the replay would have exempted — so drop the stale stripped
        // tape and recompute locally. Online keeps respecting the live stripped
        // tape. (Same rationale as buildOfflineState above.)
        const itemGated = !online && !!cachedState.stageLookup?.[currentLifecycle ?? '']?.interlockGated;
        const itemActions = await getCurrentActions(item.filterId, itemGated ? null : cachedState.actions);

        const gate = validateOfflineGate({
          activeStageKey: activeStage.key,
          activeStageLabel: activeStage.label,
          online,
          currentLifecycle,
          actions: itemActions,
          hasGraph: !!cachedState.pipelineGraph?.stages,
          hasLinearPipeline: (cachedState.pipelineStages?.length ?? 0) > 0,
          pipelineGraph: cachedState.pipelineGraph,
          cycleInProgress,
          // Phase 8.7 cutover: derive checklist-pending from the resolved
          // tape rather than the deprecated cached pendingChecklist field.
          // itemActions is the executor-resolved tape for this filter.
          hasPendingChecklist: hasActionKind(itemActions, 'SUBMIT_CHECKLIST'),
          dryerReadingsSubmitted: cachedState.currentCycle?.dryerReadingsSubmitted,
          dryerStartedAt: cachedState.currentCycle?.dryerStartedAt ?? null,
          dryerDurationMinutes: cachedState.currentCycle?.dryerDurationMinutes ?? null,
          homeBlockId: cachedState.homeBlock?.id,
          blockChangeStatus: cachedState.blockChangeStatus,
          selectedBlockId: selectedBlock?.id,
          replacementBlocked: blockedIds.has(item.filterId),
        });
        if (!gate.ok) {
          failed.push(`${item.filterName}: ${gate.reason}`);
          continue;
        }
        // OFFLINE cross-block: never blocks (per config) — informational notice + proceed.
        // NONE mode shows nothing at all (no check, no notice).
        if (!online && blockChangeMode !== 'NONE' && cachedState.homeBlock?.id && selectedBlock?.id && cachedState.homeBlock.id !== selectedBlock.id) {
          setSuccess(`Note: ${item.filterName} belongs to ${cachedState.homeBlock.name}, not ${selectedBlock.name}. Recorded offline.`);
        }

        // 2026-06-06 cross-block gate (queue/"Submit All" path). The single-
        // scan handler (handleSubmit) pops the Request-Block-Change dialog when
        // a filter is being cleaned in a block other than its home and there is
        // no standing approval. The queue path lacked this gate, so it submitted
        // cross-block ops blindly: start-cycle was rejected (409
        // BLOCK_CHANGE_REQUIRED) and the follow-on advance then surfaced
        // "No active cleaning cycle". Mirror the single-scan behaviour here:
        // open the approval popup and STOP — do NOT start/advance. Online only
        // (offline cross-block is already caught by validateOfflineGate above).
        // Same-block / already-approved (MATCH / APPROVED) fall straight through
        // — normal cleaning is unaffected.
        //
        // Perf (2026-07-09): when this filter's cached home block IS the selected
        // block, it can never be a cross-block op, so the approval status can't be
        // CONFIRM/REQUIRED — skip the whole per-filter /current-state round-trip.
        // In the common batch workflow (operator scans filters belonging to the
        // block they picked) this eliminates one serial network call per filter,
        // roughly halving online submit time for 50–100 tags. Cold cache
        // (homeBlock unknown) falls through to the GET, unchanged.
        const sameHomeBlock =
          !!cachedState.homeBlock?.id && cachedState.homeBlock.id === selectedBlock?.id;
        if (online && selectedBlock?.id && !sameHomeBlock) {
          let bcStatus: string | null | undefined = cachedState.blockChangeStatus;
          let homeBlk: { id: string; name: string } | null | undefined = cachedState.homeBlock;
          // Refresh against the SELECTED block — the cached status may have been
          // primed without a cleaningAreaId and so wouldn't reflect this block.
          try {
            const cs = await apiClient.get<any>(`/api/filters/${item.filterId}/current-state?cleaningAreaId=${encodeURIComponent(selectedBlock.id)}`);
            bcStatus = cs?.blockChangeStatus ?? bcStatus;
            homeBlk = cs?.homeBlock ?? homeBlk;
          } catch { /* fall back to cached values on a transient read failure */ }
          if ((bcStatus === 'CONFIRM' || bcStatus === 'REQUIRED') && homeBlk?.id && !ackedBlockFiltersRef.current.has(item.filterId)) {
            core.dispatch({
              type: 'open_block_change',
              filterId: item.filterId,
              filterName: item.filterName,
              homeBlockId: homeBlk.id,
              homeBlockName: homeBlk.name,
              requestedBlockId: selectedBlock.id,
              requestedBlockName: selectedBlock.name,
            });
            setBlockChangeReason('');
            setScanQueue([]); setDryerDurations({});
            setLoading(false);
            return;
          }
        }
        // 2026-05-20: batch cycle-start. When any queued filter has no
        // active cycle, open the reason dialog for the FIRST such filter
        // and stash the rest in remainingBatch. On equipment-readings
        // submit, the handler will iterate remainingBatch and apply the
        // SAME reason + equipment readings to each — one reason dialog,
        // one equipment dialog, N cycle-starts. Pre-fix this case fell
        // through to "use single scan" for queue.length > 1, blocking
        // common batch workflows where operators scan multiple filters
        // for a fresh cycle (typical: Wash In on shift start).
        if (!cycleInProgress) {
          // Build the remainingBatch from ALL queued items after this one
          // — they share the reason + equipment dialog values when they
          // are all cycle-start candidates.
          const startIdx = scanQueue.findIndex(q => q.filterId === item.filterId);
          const rest = startIdx >= 0
            ? scanQueue.slice(startIdx + 1).map(q => ({ filterId: q.filterId, filterName: q.filterName }))
            : [];
          core.dispatch({
            type: 'open_reason',
            filterId: item.filterId,
            filterName: item.filterName,
            stage: activeStage.key,
            remainingBatch: rest.length > 0 ? rest : undefined,
          });
          setSelectedReason('');
          setJustification('');
          setPmReasonDue(false);
          // Drop the queue — the reason dialog (carrying remainingBatch)
          // drives the rest of the flow. Equipment-submit will iterate.
          setScanQueue([]); setDryerDurations({});
          setLoading(false);
          return;
        }

        // Issue #4 fix (2026-05-18): DRY_IN advance requires dryerAction +
        // dryerDurationMinutes when the dryer hasn't been started yet for this
        // cycle. handleSubmit (single-scan) opens the Set-Dryer-Duration dialog
        // for this case (line 979). The batch path used to fire a plain
        // advance which the server then rejected at replay time, leaving the
        // cycle stuck. Mirror the single-scan behavior here so the batch
        // mode also opens the dryer dialog when the queue has just one item.
        // 2026-05-20 PRE-ADVANCE CHECKLIST FIX: ANY queued filter (not just
        // DRY_IN entry) may have a pending checklist that the server enforces
        // before allowing advance. The single-scan handleSubmit at line ~1061
        // pre-resolves this via resolvePendingChecklistDialog(filterId,
        // resolvedActions) and dispatches open_checklist directly. The batch
        // loop previously relied on the post-loop findNextPendingChecklist
        // which calls the resolver WITHOUT serverActions — fallback path
        // uses local cache, which may be stale on fresh ops. Result:
        // multi-scan never opened the checklist dialog while single-scan
        // worked. Dispatch the dialog HERE using itemActions (fresh
        // server-resolved tape for THIS filter) and stash the rest of the
        // queue as remainingBatch — same continuation flow checklist dialog
        // already supports.
        if (hasActionKind(itemActions, 'SUBMIT_CHECKLIST')) {
          const dialogChecklists = await resolvePendingChecklistDialog(item.filterId, itemActions);
          if (dialogChecklists && dialogChecklists.length > 0) {
            // 2026-05-26: unified-batch — collect EVERY queued filter that is
            // at the same checklist gate so the operator answers once. The
            // current item is always included; downstream queue items are
            // included when their tape also has SUBMIT_CHECKLIST against the
            // same checklistProfileId set (same block + same profile = same
            // gate, which is the operator's expectation).
            const sigOf = (rows: any[]) =>
              rows.map((r: any) => `${r.checklistProfileId}@${r.profileVersion ?? 0}`).sort().join('|');
            const primarySig = sigOf(dialogChecklists);
            const batchMembers: Array<{ filterId: string; filterName: string }> = [
              { filterId: item.filterId, filterName: item.filterName },
            ];
            const startIdx = scanQueue.findIndex(q => q.filterId === item.filterId);
            const downstream = startIdx >= 0 ? scanQueue.slice(startIdx + 1) : [];
            for (const q of downstream) {
              try {
                const cs = await getCache<any>(`filter-state-${q.filterId}`) ?? {};
                // Offline interlock exemption (commit d8afc02) — drop the stale
                // gate-stripped server tape so a gated downstream filter still
                // recomputes its real (interlock-free) tape locally.
                const qGated = !online && !!cs.stageLookup?.[cs.currentState ?? '']?.interlockGated;
                const qActions = await getCurrentActions(q.filterId, qGated ? null : cs.actions);
                if (!hasActionKind(qActions, 'SUBMIT_CHECKLIST')) continue;
                const qChecklists = await resolvePendingChecklistDialog(q.filterId, qActions);
                if (!qChecklists || qChecklists.length === 0) continue;
                if (sigOf(qChecklists) === primarySig) {
                  batchMembers.push({ filterId: q.filterId, filterName: q.filterName });
                }
              } catch { /* skip — unresolved filters fall back to single-mode */ }
            }
            // AHU pre-flight BEFORE the (terminal) checklist opens.
            if ((await gateAhuBeforeChecklist(batchMembers.map(m => m.filterId))) === 'blocked') {
              setLoading(false);
              return;
            }
            setPendingBatch(batchMembers);
            core.dispatch({
              type: 'open_checklist',
              filterId: item.filterId,
              filterName: batchMembers.length > 1 ? `${batchMembers.length} filter(s)` : item.filterName,
              checklists: dialogChecklists,
            });
            setChecklistAnswers({});
            // 2026-05-20: KEEP scanQueue + dryerDurations populated so that
            // after the checklist dialog walks the batch and closes, the
            // useEffect watcher below can re-trigger handleSubmitQueue and
            // fire SET_DURATION for each queued filter (the gate is now
            // cleared post-checklist). Pre-fix we cleared the queue here,
            // which dropped the durations on the floor and left the
            // operator with no countdowns after batch checklist completion.
            setLoading(false);
            pendingBatchReplayRef.current = true;
            return;
          }
        }

        if (activeStage.key === 'DRY_IN') {
          const cyc = cachedState.currentCycle ?? {};
          const dryerStarted = !!cyc.dryerStartedAt && !!cyc.dryerDurationMinutes;
          if (!dryerStarted) {
            // 2026-05-20 PER-FILTER DURATION: each queued filter has its own
            // duration dropdown rendered inline in the queue list. The user
            // selects per-filter, then a single Submit-All drives the batch.
            // We get here only when handleSubmitQueue is called with at least
            // one filter still missing a duration — surface a clear error.
            const dur = dryerDurations[item.filterId];
            if (!dur) {
              failed.push(`${item.filterName}: pick a dryer duration in the queue row first`);
              continue;
            }
            // Task 3 (online): accumulate the SET_DURATION advance into the batch
            // instead of firing core.advance per-filter. Mirrors the offline
            // core.advance payload below exactly (targetState/cleaningAreaId/
            // dryerAction/dryerDurationMinutes/remarks) + the tapeVersion that
            // executeOrQueue would have merged from the cached filter-state row.
            // `skipChecklistDispatch` is a client-only dialog-control flag (not a
            // server field) so it's intentionally omitted. The post-loop
            // runBulkOnline dispatch owns successCount / setRecentOps /
            // serverActionsByFilter for these.
            if (online) {
              bulkOps.push({
                clientOpId: crypto.randomUUID(),
                filterId: item.filterId,
                kind: 'advance',
                payload: {
                  targetState: 'DRY_IN',
                  cleaningAreaId: selectedBlock?.id,
                  dryerAction: 'SET_DURATION',
                  dryerDurationMinutes: dur,
                  remarks: remarks || `Dryer started (${dur} min) - ${item.filterName}`,
                  ...(typeof cachedState.tapeVersion === 'number' ? { tapeVersion: cachedState.tapeVersion } : {}),
                },
              });
              continue;
            }
            // Has duration: fire SET_DURATION advance directly. Same payload
            // shape as handleDryerDurationSubmit, but called per-filter from
            // the batch loop instead of via the modal dialog.
            try {
              // 2026-05-26: skip the in-core dispatch entirely for
              // multi-filter DRY_IN SET_DURATION. The post-loop unified-
              // batch dispatch below groups every filter with a pending
              // gate into ONE dialog (filterName="N filter(s)") so the
              // operator answers once, then handleChecklistSubmit's batch
              // branch loops core.submitChecklist for each. If we let
              // core.advance dispatch per-filter inside the loop, filter
              // 2's dispatch trips assertOpenable on filter 1's
              // awaiting_checklist state. Also stash server actions so
              // the post-loop resolver uses authoritative server tape.
              const dryerRes = await core.advance({
                filterId: item.filterId,
                filterName: item.filterName,
                targetState: 'DRY_IN',
                cleaningAreaId: selectedBlock?.id,
                dryerAction: 'SET_DURATION',
                dryerDurationMinutes: dur,
                remarks: remarks || `Dryer started (${dur} min) - ${item.filterName}`,
                skipChecklistDispatch: true,
              });
              const dryerExec = dryerRes.executed;
              if (dryerExec && Array.isArray((dryerRes.result as any)?.actions)) {
                serverActionsByFilter.set(item.filterId, (dryerRes.result as any).actions);
              }
              setRecentOps(prev => [{ stage: 'Dryer Started', filter: item.filterName, time: formatTime(new Date()), queued: !dryerExec }, ...prev].slice(0, 200));
              // 2026-05-20 explicit IDB filters-store write — guarantees the
              // Currently Drying panel sees DRY_IN for this filter regardless
              // of whether core.advance's recomputeAndCacheFilterState ran
              // (it only runs on the offline-queued path; the online path
              // skips it). Without this, online batch dryer-start populated
              // the panel only after the next SWR refresh (15s polling
              // window) — operator saw nothing immediately.
              try {
                const { updateFilterStateLocally } = await import('@/lib/offline-store');
                await updateFilterStateLocally(item.filterId, 'DRY_IN', false);
              } catch { /* IDB write failure is non-fatal; SWR mutate is the fallback */ }
              // Mirror the dryer-timing cache write from handleDryerDurationSubmit.
              try {
                const cached = await getCache<any>(`filter-state-${item.filterId}`) ?? {};
                let eqGroup = cached.equipmentGroup ?? null;
                if (!eqGroup && selectedBlock?.id) {
                  const allGroups = await getCache<any[]>('equipment-groups') ?? [];
                  const blockGroups = allGroups.filter((g: any) => g.blockId === selectedBlock.id);
                  if (blockGroups.length === 1) eqGroup = blockGroups[0];
                }
                cache(`filter-state-${item.filterId}`, {
                  ...cached,
                  currentState: 'DRY_IN',
                  equipmentGroup: eqGroup,
                  currentCycle: {
                    ...(cached.currentCycle ?? {}),
                    status: 'IN_PROGRESS',
                    dryerDurationMinutes: dur,
                    dryerStartedAt: new Date().toISOString(),
                    cleaningAreaId: selectedBlock?.id ?? cached.currentCycle?.cleaningAreaId ?? null,
                  },
                }, 24 * 60 * 60 * 1000);
              } catch { /* ignore cache errors */ }
              successCount++;
            } catch (e: any) {
              failed.push(`${item.filterName}: ${e?.message ?? 'dryer start failed'}`);
            }
            continue;
          }
        }

        // Task 3 (online): accumulate the mid-cycle advance into the batch
        // instead of calling executeOrQueue per-filter. The payload mirrors the
        // offline executeOrQueue call below exactly (targetState/cleaningAreaId/
        // remarks) plus the tapeVersion executeOrQueue would have merged from the
        // cached filter-state row (only when it is a number — same guard as
        // use-offline.ts). Post-loop runBulkOnline owns successCount /
        // setRecentOps / serverActionsByFilter for these.
        // Dialog-first for the batch (2026-07-16). Resolve THIS filter's
        // post-stage checklist BEFORE the advance is dispatched. If one fires,
        // park the advance instead of sending it: the dialog opens after the
        // loop and each parked advance commits atomically with the answers as a
        // single `advance-with-checklist` item. Pre-fix, all N advances were
        // dispatched here and only THEN did the dialog open — an operator who
        // closed it left N committed stage transitions whose mandatory
        // checklists were never answered.
        //
        // Empty => no checklist here, or it couldn't be resolved. Both fall
        // through to the unchanged path below; the server re-validates either
        // way, and the post-loop resolver still catches the latter case.
        const advancePayload = {
          targetState: activeStage.key,
          cleaningAreaId: selectedBlock?.id,
          remarks: remarks || `${activeStage.label} - ${item.filterName}`,
        };
        const preChecklists = await resolveChecklistForTargetStage(
          item.filterId,
          activeStage.key,
          online,
        );
        if (preChecklists.length > 0) {
          deferredAdvances.set(item.filterId, {
            item: { filterId: item.filterId, filterName: item.filterName },
            payload: advancePayload,
            checklists: preChecklists,
          });
          continue;
        }

        if (online) {
          bulkOps.push({
            clientOpId: crypto.randomUUID(),
            filterId: item.filterId,
            kind: 'advance',
            payload: {
              ...advancePayload,
              ...(typeof cachedState.tapeVersion === 'number' ? { tapeVersion: cachedState.tapeVersion } : {}),
            },
          });
          continue;
        }
        const { executed, result } = await executeOrQueue('advance', item.filterId, item.filterName, {
          targetState: activeStage.key, cleaningAreaId: selectedBlock?.id,
          remarks: remarks || `${activeStage.label} - ${item.filterName}`,
        }, activeStage.key);
        if (!executed) {
          // Perf (2026-07-09): recompute this filter's cache row per item, but do
          // NOT refreshOfflineData() here. That call re-reads the whole IDB
          // filter store and setState-repaints the entire filter list; firing it
          // once per queued tag meant 50–100 full re-renders for an offline
          // batch. A single refreshOfflineData() after the loop (below) repaints
          // everything once.
          await recomputeAndCacheFilterState(item.filterId, activeStage.key, false, selectedBlock?.id ?? null);
        }
        // 2026-05-26: stash server tape so post-loop dispatch passes the
        // authoritative actions to resolvePendingChecklistDialog. The
        // earlier code relied solely on local recompute which was failing
        // for mid-cycle advances on profiles where every stage has a
        // checklist gate (the cache row's pendingChecklist field gets
        // clobbered by the trailing per-filter /current-state prime).
        if (executed && Array.isArray(result?.actions)) {
          serverActionsByFilter.set(item.filterId, result.actions);
        }
        successCount++;
        setRecentOps(prev => [{ stage: activeStage.key, filter: item.filterName, time: formatTime(new Date()), queued: !executed }, ...prev].slice(0, 200));
      } catch (e: any) {
        // Deep-review fix D6 (2026-05-17): REAUTH errors must NOT be swallowed
        // into the per-filter failure list — the reauth dialog needs to stay
        // open with the inline "Incorrect password" message and let the
        // operator retry, instead of closing on a generic batch-failure popup.
        // The two shapes (`.error` from REAUTH_REQUIRED / REAUTH_FAILED raw
        // re-throws in api-client.ts:67, `.code` from the constructed-Error
        // branch at line 104) cover both paths. Matches desktop L820-832.
        const errCode = e?.error ?? e?.code;
        if (errCode === 'REAUTH_FAILED' || errCode === 'REAUTH_REQUIRED') {
          throw e;
        }
        // Also let offline-cache recompute failures escape so the operator
        // sees a clear "offline state corrupted" error instead of silently
        // proceeding against stale cache (see D3b in offline-cache.ts).
        if (errCode === 'OFFLINE_CACHE_RECOMPUTE_FAILED') {
          throw e;
        }
        failed.push(`${item.filterName}: ${e.message ?? 'failed'}`);
        // B3/C2: record failures too so they render in the Failure section.
        setRecentOps(prev => [{ stage: activeStage.key, filter: item.filterName, time: formatTime(new Date()), status: 'failed' as const, msg: e.message ?? 'failed' }, ...prev].slice(0, 200));
      }
    }
    // Task 3: dispatch every ONLINE advance accumulated above in ONE
    // /bulk-operate POST (one reauth prompt for the whole batch). Runs AFTER the
    // loop but BEFORE the post-loop checklist dispatch, and feeds
    // serverActionsByFilter from the response so that block keeps working
    // unchanged. A wholesale transport failure keeps the scanQueue intact for
    // retry (per-item STALE_TAPE/validation failures surface as `failures`).
    if (online && bulkOps.length > 0) {
      const out = await runBulkOnline(bulkOps, 'ADVANCE_FILTER_STAGE');
      if (out === 'cancelled') return; // operator declined reauth — keep queue, no error banner
      if (out === 'transport_error') {
        setError('Could not reach the server to submit the batch. Please try Submit again.');
        return; // keep scanQueue intact for retry — do NOT clear it (finally clears loading)
      }
      successCount += out.okCount;
      for (const [fid, actions] of out.actionsByFilter) serverActionsByFilter.set(fid, actions);
      for (const r of out.results) {
        // Surface the operator-facing filter NAME (not the raw UUID) in both the
        // recent-ops list and the failure banner, matching every other message
        // in this handler. BulkClientItem carries no name, so map via the queue.
        const fname = scanQueueSnapshot.find(q => q.filterId === r.filterId)?.filterName ?? r.filterId;
        if (r.status === 'ok') {
          // DRY_IN SET_DURATION entries read as "Dryer Started" like every other
          // dryer-start path (offline batch + single) so the recent-ops icon +
          // per-stage list stay consistent online and offline.
          const op = bulkOps.find(o => o.filterId === r.filterId);
          const stageLabel = op?.payload?.dryerAction === 'SET_DURATION' ? 'Dryer Started' : activeStage.key;
          setRecentOps(prev => [{ stage: stageLabel, filter: fname, time: formatTime(new Date()), queued: false, status: 'ok' as const }, ...prev].slice(0, 200));
        } else {
          failed.push(`${fname}: ${r.error?.message ?? 'failed'}`);
          // B3/C2: record failures too so they render in the Failure section.
          setRecentOps(prev => [{ stage: activeStage.key, filter: fname, time: formatTime(new Date()), status: 'failed' as const, msg: r.error?.message ?? 'failed' }, ...prev].slice(0, 200));
        }
      }
    }
    // Offline parity: if any advanced item now has a pending checklist (per
    // the cleaning profile), open the dialog for the FIRST such filter and
    // stash the rest of the batch in `pendingChecklistBatch`. The cycle is
    // resumed inside `handleChecklistSubmit` after each successful submit.
    //
    // Pre-fix bug (PHASE_5_RECENT_WORK.md § 11, session 04-20): the original
    // `for…break` opened the dialog for the first matching filter and then
    // never iterated to the rest of the batch — every other pending filter
    // silently skipped the checklist gate.
    // 2026-05-20: open the checklist dialog whenever ANY queued filter has
    // a pending checklist — not just when at least one advance succeeded.
    // Pre-fix the gate was `if (successCount > 0)`, which meant batch-DRY_IN
    // submits where ALL filters needed a pre-DRY_IN checklist (every one
    // pushed to `failed` with "checklist required first") never opened the
    // dialog. Operator only saw the error toast and couldn't proceed.
    // 2026-07-16: dialog-first batch. Any filter whose advance was PARKED gets
    // its dialog opened here with nothing written yet. This runs BEFORE the
    // legacy post-advance resolver below and returns, because the two are
    // mutually exclusive: a parked filter has no committed advance for that
    // resolver to find, and dispatching twice would trip assertOpenable.
    if (deferredAdvances.size > 0) {
      const sigOfDeferred = (rows: any[]) =>
        rows.map((r: any) => `${r.checklistProfileId}@${r.profileVersion ?? 0}`).sort().join('|');
      // Same grouping rule as the legacy path: ONE dialog for the largest
      // same-signature group so the operator answers identical checklists once.
      const groups = new Map<string, Array<{ filterId: string; filterName: string }>>();
      for (const [, d] of deferredAdvances) {
        const sig = sigOfDeferred(d.checklists);
        const arr = groups.get(sig) ?? [];
        arr.push(d.item);
        groups.set(sig, arr);
      }
      let chosen: Array<{ filterId: string; filterName: string }> = [];
      for (const arr of groups.values()) {
        if (arr.length > chosen.length) chosen = arr;
      }
      // Filters in a SMALLER signature group are neither advanced nor parked —
      // they stay in the scan queue for a re-submit, matching the legacy path's
      // "the rest can be triggered on the next scan" behaviour.
      const primary = deferredAdvances.get(chosen[0].filterId)!;
      // AHU pre-flight BEFORE the (terminal) checklist opens — same as legacy.
      if ((await gateAhuBeforeChecklist(chosen.map(m => m.filterId))) === 'proceed') {
        const parked = new Map<string, { targetState: string; payload: Record<string, unknown> }>();
        for (const m of chosen) {
          const d = deferredAdvances.get(m.filterId)!;
          parked.set(m.filterId, { targetState: activeStage.key, payload: d.payload });
        }
        setPendingBatch(chosen);
        setPendingBatchDeferred(parked);
        core.dispatch({
          type: 'open_checklist',
          filterId: primary.item.filterId,
          filterName: chosen.length > 1 ? `${chosen.length} filter(s)` : primary.item.filterName,
          checklists: primary.checklists,
        });
        setChecklistAnswers({});
      }
      // Keep ONLY the parked filters in the queue. They were NOT advanced, so if
      // the operator closes the dialog nothing was written and the queue must
      // survive for a retry rather than making them re-scan 50-100 tags. The
      // checklist submit clears it.
      //
      // Mixed batch: filters that DID advance (bulkOps above) must be dropped —
      // leaving them in would let a re-submit advance them a second time.
      setScanQueue(prev => prev.filter(q => deferredAdvances.has(q.filterId)));
      setDryerDurations({});
      setRemarks('');
      if (successCount > 0) setSuccess(`${successCount} filter(s) → ${activeStage.label}${failed.length > 0 ? ` (${failed.length} failed)` : ''}`);
      if (failed.length > 0) setError(failed.join('\n'));
      if (online) await mutate('/api/assets/instances', undefined, { revalidate: true });
      refreshOfflineData();
      // Skip the legacy post-advance resolver + the unconditional queue clear.
      // eslint-disable-next-line no-useless-return
      return;
    }

    if (successCount > 0 || failed.length > 0) {
      try {
        // 2026-05-26: unified-batch post-advance dialog dispatch. Replaces the
        // per-filter cycling via `findNextPendingChecklist`+`remainingBatch`
        // (which made the operator re-answer the same checklist N times for
        // a same-block batch). Walk every filter that landed on a checklist
        // gate, group by signature, dispatch ONE dialog for the largest
        // group. Same answers POSTed to each member of the group on submit
        // (see handleChecklistSubmit batch branch).
        const sigOf = (rows: any[]) =>
          rows.map((r: any) => `${r.checklistProfileId}@${r.profileVersion ?? 0}`).sort().join('|');
        type Pending = { item: { filterId: string; filterName: string }; checklists: any[]; signature: string };
        const pending: Pending[] = [];
        for (const q of scanQueueSnapshot) {
          // 2026-05-26: skip filters whose dialog was already dispatched
          // by core.advance/startAndAdvance inside the loop (e.g. DRY_IN
          // SET_DURATION path). A second open_checklist from awaiting_
          // checklist trips assertOpenable.
          if (dialogDispatchedInLoop.has(q.filterId)) continue;
          try {
            // 2026-05-26: prefer server tape captured during the inner-loop
            // advance over a cache-driven local recompute. The local path
            // is fragile because the per-filter /current-state prime fires
            // AFTER this dispatch and overwrites the cache with the raw
            // response (which has no pendingChecklist field). Server tape
            // is authoritative.
            const serverActions = serverActionsByFilter.get(q.filterId);
            const checklists = await resolvePendingChecklistDialog(q.filterId, serverActions ?? undefined);
            if (checklists && checklists.length > 0) {
              pending.push({
                item: { filterId: q.filterId, filterName: q.filterName },
                checklists,
                signature: sigOf(checklists),
              });
            }
          } catch { /* per-filter resolver failure shouldn't poison the batch */ }
        }
        if (pending.length > 0) {
          // Pick the largest same-signature group; the rest (mixed signature
          // case) can be triggered on the next scan if they need attention —
          // matches today's "re-scan to retry" muscle memory.
          const groups = new Map<string, Pending[]>();
          for (const p of pending) {
            const arr = groups.get(p.signature) ?? [];
            arr.push(p);
            groups.set(p.signature, arr);
          }
          let chosen: Pending[] = [];
          for (const arr of groups.values()) {
            if (arr.length > chosen.length) chosen = arr;
          }
          const primary = chosen[0];
          const batchMembers = chosen.map(p => p.item);
          // AHU pre-flight BEFORE the (terminal) checklist opens.
          if ((await gateAhuBeforeChecklist(batchMembers.map(m => m.filterId))) === 'proceed') {
            setPendingBatch(batchMembers);
            core.dispatch({
              type: 'open_checklist',
              filterId: primary.item.filterId,
              filterName: batchMembers.length > 1 ? `${batchMembers.length} filter(s)` : primary.item.filterName,
              checklists: primary.checklists,
            });
            setChecklistAnswers({});
          }
        }
      } catch { /* ignore — user can re-scan to trigger */ }
    }
    setScanQueue([]); setDryerDurations({});
    // B1 (2026-07-10): clear the remarks box after a stage submit completes so the
    // note doesn't linger and get silently reused on the operator's next op (which
    // also surfaced as a checklist-gated advance carrying stale remarks).
    setRemarks('');
    if (successCount > 0) setSuccess(`${successCount} filter(s) → ${activeStage.label}${failed.length > 0 ? ` (${failed.length} failed)` : ''}`);
    if (failed.length > 0) setError(failed.join('\n'));
    // 2026-05-20: refresh BOTH the SWR cache (so allFilters sees the new
    // currentLifecycleState) AND the offline filter cache (so the
    // Currently Drying panel populates immediately for batch dryer-start
    // on DRY_IN stage). Pre-fix: tablet running offline after batch submit
    // didn't see the panel until the next reload because offlineFilters
    // was stale; the per-filter cache write was correct but allFilters
    // doesn't pull from there.
    //
    // Task 3: the old per-filter /current-state prime is gone. Each ok filter's
    // filter-state cache was already written from its server snapshot inside
    // runBulkOnline (the bulk snapshot IS the /current-state response — the
    // service returns getCurrentState(...) for each ok item), so re-fetching
    // /current-state per filter would be redundant work + a rate-limit risk.
    // Just force a hard revalidation of the instances list so allFilters sees
    // the new lifecycle states.
    if (online) await mutate('/api/assets/instances', undefined, { revalidate: true });
    refreshOfflineData();
    } catch (e: any) {
      // REAUTH bubbled out of the inner loop — the reauth dialog stays open
      // (managed by useReauth at the executeOrQueue site). Surface a clear
      // error so the operator knows the batch was interrupted; do NOT
      // pretend successCount items "succeeded" since the queue state is
      // ambiguous (some items may have been advanced, others not).
      const errCode = e?.error ?? e?.code;
      if (errCode === 'REAUTH_REQUIRED' || errCode === 'REAUTH_FAILED') {
        setError('Re-authentication required — please enter your password and re-submit the batch.');
      } else if (errCode === 'OFFLINE_CACHE_RECOMPUTE_FAILED') {
        setError(`Offline state recompute failed: ${e?.message ?? 'unknown'}. Re-scan to refresh the cache before continuing.`);
      } else {
        setError(e?.message ?? 'Batch submission failed');
      }
    } finally {
      setLoading(false);
    }
  };

  // 2026-05-20: batch-replay effect. When handleSubmitQueue's pre-DRY_IN
  // checklist gate opens a dialog, it sets pendingBatchReplayRef=true and
  // keeps scanQueue + dryerDurations populated. core.submitChecklist walks
  // the remaining batch (one dialog per filter that needs a checklist), then
  // closes when remainingBatch is empty (dialogState.kind transitions from
  // awaiting_checklist → none). This effect fires handleSubmitQueue again
  // on that transition — the gate is now cleared, so the loop reaches the
  // SET_DURATION advance for every queued filter.
  useEffect(() => {
    const prev = prevDialogKindRef.current;
    const curr = core.dialogState.kind;
    prevDialogKindRef.current = curr;
    if (
      prev === 'awaiting_checklist' &&
      curr === 'none' &&
      pendingBatchReplayRef.current &&
      scanQueue.length > 0 &&
      !loading
    ) {
      pendingBatchReplayRef.current = false;
      // Defer one tick so dialog close + SWR refresh land before replay.
      setTimeout(() => { handleSubmitQueue(); }, 50);
    }
    // handleSubmitQueue intentionally omitted — the ref guards re-entry and
    // including a function from this same component would force a new
    // closure each render and re-fire the effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [core.dialogState.kind, scanQueue.length, loading]);

  // Helper: detect network errors (fetch failures + CapacitorHttp native errors)
  const isNetworkError = (e: any): boolean => {
    if (!e) return false;
    const msg = String(e.message || e).toLowerCase();
    return msg.includes('failed to fetch') || msg.includes('network') || msg.includes('load failed')
      || msg.includes('failed to connect') || msg.includes('unable to resolve host')
      || msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('enetunreach')
      || e.name === 'TypeError';
  };

  // SPIS: single-source offline gate. Implementation lives in
  // `apps/web/src/lib/filter-ops/validate-offline-gate.ts`, shared with the
  // desktop page so the two cannot drift. See `feedback_batch_single_parity.md`
  // — desktop's `handleSubmitBatch` previously inlined the same logic; the
  // Phase 8.7 Wave-5 split lifted both copies into one.



  const handleSubmit = async () => {
    if (!scanValue.trim() || !activeStage || loading) return;
    setLoading(true); setError(''); setSuccess('');
    try {
      const resolved = await resolveFilter();
      if (!resolved) { setLoading(false); return; }
      const { filterId, filterName } = resolved;
      // Task 5: cached blocked-filter set (AHU replacement overdue), consulted
      // by the offline gate below on the !cycleInProgress (START) branch.
      const blockedIds = new Set<string>((await getCache<string[]>('blocked-filter-ids')) ?? []);

      let state: any;

      // === UNIFIED STATE RESOLUTION ===
      // Always try API first (works online), fall back to cache (works offline).
      // Single code path — no divergence between online/offline.
      const buildOfflineState = async () => {
        const cachedFilters = await getOfflineFilters();
        const cached = cachedFilters.find((f: any) => f.id === filterId);
        const cachedState = await getCache<any>(`filter-state-${filterId}`) ?? {};

        const currentLifecycle = cached?.currentLifecycleState || cachedState.currentState || null;
        // Phase 8.7 cutover (agent E): the offline state object no longer
        // carries the deprecated `nextAllowedStages` / `pendingChecklist`
        // fields. Downstream gate decisions read the tape directly via
        // `getCurrentActions(filterId, state.actions)`. The cache row is
        // still allowed to hold legacy mirrors for Wave 2 cleanup, but this
        // synthesized state object exposes only the tape-native shape.

        // Active cycle: server returns currentCycle with id+status, offline has cached version
        const cycle = cachedState.currentCycle ?? null;
        const hasCycle = cycle ? !!(cycle.status === 'IN_PROGRESS' || cycle.id) : !!cached?.currentCycleId;

        // Stage interlock is an ONLINE-only QA gate (commit d8afc02 — offline
        // cleaning is interlock-exempt). When the operator was ONLINE at WASH_OUT
        // / DRY_OUT, the server cached a tape with the leave (advance/bypass)
        // action stripped — only TERMINATE_CYCLE survives. Carrying that stale
        // stripped tape into offline mode strands the operator at the gate:
        // getCurrentActions() trusts a non-empty server tape verbatim, so it
        // never offers the advance and the offline op the replay would have
        // exempted can never be queued. Drop the cached server tape at a gated
        // stage so getCurrentActions() recomputes the (interlock-free) tape
        // locally and the offline advance is offered again. Non-gated stages are
        // unaffected; the desktop page already omits `actions` offline for the
        // same recompute behaviour.
        const interlockGatedNow = !!cachedState.stageLookup?.[currentLifecycle ?? '']?.interlockGated;

        return {
          filterId,
          filterName: cached?.name || filterName,
          currentState: currentLifecycle,
          currentCycle: hasCycle ? (cycle ?? { id: cached?.currentCycleId, status: 'IN_PROGRESS' }) : null,
          pipelineStages: cachedState.pipelineStages ?? [],
          pipelineGraph: cachedState.pipelineGraph ?? null,
          equipmentGroup: cachedState.equipmentGroup ?? null,
          isPmDue: cachedState.isPmDue ?? false,
          pmReasonKey: cachedState.pmReasonKey ?? null,
          blockChangeStatus: cachedState.blockChangeStatus ?? null,
          homeBlock: cachedState.homeBlock ?? null,
          actions: interlockGatedNow ? null : (cachedState.actions ?? null),
        };
      };

      if (online) {
        try {
          const csUrl = `/api/filters/${filterId}/current-state${selectedBlock?.id ? `?cleaningAreaId=${encodeURIComponent(selectedBlock.id)}` : ''}`;
          state = await apiClient.get<any>(csUrl);
          // Phase 8.7 cutover (agent E): route through cacheServerStateResponse
          // so the deprecated mirror field NAMES stay quarantined inside
          // offline-cache.ts. The cache row STILL persists pendingChecklist[]
          // + nextAllowedStages[] (local-context.ts:466 reads pendingChecklist
          // for CHECKLIST_COMPLETED synthesis — Wave 2 server work removes the
          // server-side emission and the cache writes drop out naturally).
          // stageLookup MUST be included — it's the per-stage authoritative
          // table the offline checklist + next-stage logic depends on (B.7).
          await cacheServerStateResponse(filterId, state);
        } catch (e: any) {
          if (isNetworkError(e)) {
            state = await buildOfflineState();
          } else {
            throw e;
          }
        }
      } else {
        state = await buildOfflineState();
      }

      // B7.4 (2026-05-02): surface the equipmentGroupSyncWarning advisory if
      // the server reported one. Online responses include it; offline-built
      // state does not, so this clears any stale value when offline.
      setEquipmentGroupSyncWarning(state.equipmentGroupSyncWarning ?? null);
      setInterlock(state.interlock ?? null);

      // Block duplicate submission
      const currentLifecycle = state.currentState;

      // Phase 8.6 part 2: resolve action tape (server-emitted when present,
      // else locally computed via the shared executor). Used by the gate AND
      // the post-gate "already at" / "next allowed" online checks below.
      const resolvedActions = await getCurrentActions(filterId, state.actions);
      const nextAllowed: string[] = resolvedActions
        .filter(a => a.type === 'ADVANCE_TO_STAGE' || a.type === 'SET_DRYER_DURATION')
        .map(a => (a as { params: { targetState: string } }).params.targetState);

      // Shared SPIS gate (same helper used by handleSubmitQueue).
      // Only enforced offline — online callers get richer server-side validation.
      if (!online) {
        const gate = validateOfflineGate({
          activeStageKey: activeStage.key,
          activeStageLabel: activeStage.label,
          online,
          currentLifecycle,
          actions: resolvedActions,
          hasGraph: !!state.pipelineGraph?.stages,
          hasLinearPipeline: (state.pipelineStages?.length ?? 0) > 0,
          pipelineGraph: state.pipelineGraph,
          cycleInProgress: !!state.currentCycle,
          // Phase 8.7 cutover: tape-derived. resolvedActions is the same tape
          // the gate validates against — single source of truth.
          hasPendingChecklist: hasActionKind(resolvedActions, 'SUBMIT_CHECKLIST'),
          dryerReadingsSubmitted: state.currentCycle?.dryerReadingsSubmitted,
          dryerStartedAt: state.currentCycle?.dryerStartedAt ?? null,
          dryerDurationMinutes: state.currentCycle?.dryerDurationMinutes ?? null,
          homeBlockId: state.homeBlock?.id,
          blockChangeStatus: state.blockChangeStatus,
          selectedBlockId: selectedBlock?.id,
          replacementBlocked: blockedIds.has(filterId),
        });
        if (!gate.ok) {
          if (gate.blockChangeRequired) {
            // Let the existing block-change dialog flow below handle this
            state.blockChangeStatus = 'REQUIRED';
          } else {
            setError(gate.reason);
            setLoading(false); return;
          }
        }
        // OFFLINE cross-block: never blocks (per config). Show an informational
        // notice that the filter belongs to another block and proceed (queues).
        // NONE mode shows nothing at all (no check, no notice).
        if (blockChangeMode !== 'NONE' && state.homeBlock?.id && selectedBlock?.id && state.homeBlock.id !== selectedBlock.id) {
          setSuccess(`Note: this filter belongs to ${state.homeBlock.name}, not ${selectedBlock.name}. Recorded offline.`);
        }
      }

      // B.10 — stale profile detection: if the in-progress cycle is bound to a
      // profile that no longer matches the live block-assigned profile, surface
      // a clear instruction instead of letting the user hit "next stage = wrong"
      // confusion. Operator must terminate-and-restart to pick up the new profile.
      if (state.profileSyncWarning) {
        const w = state.profileSyncWarning;
        setError(
          `This filter's active cycle is on profile "${w.cycleProfileName ?? w.cycleProfileId}", but the configured profile for this block is now "${w.expectedProfileName ?? w.expectedProfileId}". Terminate the current cycle and rescan to start fresh on the live profile.`
        );
        setLoading(false); return;
      }

      // DRY_IN: if temperature already recorded, direct user to Dry Out stage
      // (runs BEFORE generic nextAllowed check so the user gets a clear instruction
      // instead of the confusing "Already at DRY IN. Next: Dry Out")
      if (activeStage.key === 'DRY_IN' && state.currentCycle?.dryerReadingsSubmitted) {
        setError('Dry In complete — temperature already recorded. Scan on Dry Out stage to advance.');
        setLoading(false); return;
      }

      // Phase 8.6 part 2: tape-derived "already at this stage" check. The
      // tape's ADVANCE_TO_STAGE / SET_DRYER_DURATION targets are the next legal
      // moves; if the operator scanned the SAME stage they're already on,
      // there should be at least one onward move on the tape.
      if (currentLifecycle === activeStage.key && nextAllowed.length > 0) {
        setError(`Already at ${activeStage.label}. Next: ${nextAllowed.map((k: string) => k.replace(/_/g, ' ')).join(', ')}`);
        setLoading(false); return;
      }

      // Up-front block verification. If the filter belongs to a different
      // block and there is no standing approval, show the request-block-change
      // popup now and stop.
      // Offline: if homeBlock is cached and doesn't match selected block, block the operation.
      // NONE mode = no cross-block check at all → never force the prompt. We also
      // respect a cached 'MATCH' (the server stamps MATCH under NONE even for a
      // different block), so this works offline even if the config isn't cached.
      if (!online && blockChangeMode !== 'NONE' && state.blockChangeStatus !== 'MATCH'
        && state.homeBlock && selectedBlock?.id && state.homeBlock.id !== selectedBlock.id && state.blockChangeStatus !== 'APPROVED') {
        state.blockChangeStatus = 'REQUIRED';
      }
      if (state.blockChangeStatus === 'REQUIRED' && state.homeBlock && selectedBlock?.id) {
        core.dispatch({
          type: 'open_block_change',
          filterId,
          filterName: filterName || state.filterName || scanValue,
          homeBlockId: state.homeBlock.id,
          homeBlockName: state.homeBlock.name,
          requestedBlockId: selectedBlock.id,
          requestedBlockName: selectedBlock.name,
        });
        setBlockChangeReason('');
        setLoading(false);
        return;
      }

      // Phase 8.7 Wave-5: shared pre-advance checklist-dialog resolver. Pass
      // the tape resolved above so we don't recompute it.
      //
      // 2026-05-25 fix: GUARD against opening a checklist dialog that belongs
      // to a DIFFERENT stage than the one the operator selected. The original
      // gate fired whenever any SUBMIT_CHECKLIST was pending — even if the
      // cycle was stuck in WASH_OUT and the operator tapped WASH_IN looking
      // to start fresh, the cycle's WASH_OUT-pending checklist would pop up,
      // and the operator's clear intent (start fresh on WASH_IN) was hijacked.
      // Cycle CC-MUPS/RDU/0-005 (started 2026-05-20, sat in WASH_OUT for 5
      // days, then got "completed" today via a misrouted checklist submit)
      // is the smoking-gun example.
      //
      // New rule: only auto-open the checklist dialog if (a) the cycle's
      // current state equals the stage the operator selected (i.e. the
      // checklist is for the current step), OR (b) there's no active cycle
      // and this is a pre-cycle-start checklist (rare). Otherwise we point
      // the operator at the correct stage card so they can either complete
      // the pending checklist there or recognise that the cycle is stuck.
      {
        const dialogChecklists = await resolvePendingChecklistDialog(filterId, resolvedActions);
        if (dialogChecklists) {
          const stageMatches = currentLifecycle === activeStage.key;
          const noActiveCycle = !state.currentCycle;
          if (stageMatches || noActiveCycle) {
            // AHU pre-flight BEFORE the (terminal) checklist opens. Pass the
            // fresh `state` already resolved above (its currentState === the
            // stage this checklist is for) so the terminal check is exact — no
            // redundant re-fetch that could mis-fire the popup at other stages.
            if ((await gateAhuBeforeChecklist([filterId], { currentState: state.currentState, stageLookup: state.stageLookup })) === 'blocked') {
              setLoading(false);
              return;
            }
            // Single-scan: clear any stale unified-batch state from a prior
            // session so handleChecklistSubmit takes the single-mode path.
            setPendingBatch(null); setPendingBatchDeferred(null);
            core.dispatch({ type: 'open_checklist', filterId, filterName: filterName || state.filterName, checklists: dialogChecklists });
            setChecklistAnswers({});
            setLoading(false);
            return;
          }
          // Stage mismatch — show a clear instruction instead of hijacking the operator's intent.
          const atLabel = (currentLifecycle ?? 'an earlier stage').replace(/_/g, ' ');
          setError(
            `This filter has a pending checklist for ${atLabel}. Tap the ${atLabel} stage card to complete it before scanning on ${activeStage.label}.`,
          );
          setLoading(false);
          return;
        }
      }
      // Phase 8.6 part 2: tape-derived "wrong stage" check. activeStage must
      // appear as an ADVANCE / SET_DRYER target on the resolved tape; if not,
      // surface the legal next stages from the same tape.
      if (nextAllowed.length > 0 && !actionsForStage(activeStage.key, resolvedActions).some(a => a.type === 'ADVANCE_TO_STAGE' || a.type === 'SET_DRYER_DURATION')) {
        const atLabel = (currentLifecycle ?? 'START').replace(/_/g, ' ');
        setError(`Filter is at "${atLabel}". Next allowed: ${nextAllowed.map((k: string) => k.replace(/_/g, ' ')).join(', ')}`);
        setLoading(false); return;
      }
      // Check if there's an active cycle — no cycle means we need to start one (reason dialog)
      const hasActiveCycle = !!state.currentCycle;
      if (!hasActiveCycle) {
        // Don't silently auto-start PM. Open the reason picker; for a PM-due
        // filter, pre-select PM + flag it so the picker shows the PM banner.
        // Operator confirms PM (completes the My Tasks PM task) or picks another
        // reason (which leaves the PM task pending).
        const isPm = !!(state.isPmDue && state.pmReasonKey);
        core.dispatch({ type: 'open_reason', filterId, filterName: filterName || state.filterName, stage: activeStage.key });
        setSelectedReason(isPm ? state.pmReasonKey! : '');
        setJustification('');
        setPmReasonDue(isPm);
        setLoading(false); return;
      }
      if (activeStage.key === 'DRY_IN') {
        const cyc = state.currentCycle ?? {};
        if (cyc.dryerReadingsSubmitted) {
          setError('Dry In complete — temperature already recorded. Scan on Dry Out stage to advance.');
          setLoading(false); return;
        }
        const startedAt = cyc.dryerStartedAt ? new Date(cyc.dryerStartedAt).getTime() : null;
        const durationMin: number | null = cyc.dryerDurationMinutes ?? null;
        if (!startedAt || !durationMin) {
          core.dispatch({ type: 'open_dryer', filterId, filterName: filterName || state.filterName });
          setLoading(false); return;
        }
        const halfMs = (durationMin * 60_000) / 2;
        const elapsedMs = Date.now() - startedAt;
        if (elapsedMs < halfMs) {
          const remainingMin = Math.ceil((halfMs - elapsedMs) / 60_000);
          setError(`Dryer still running. Wait ${remainingMin} more minute(s).`);
          setLoading(false); return;
        }
        if (state.equipmentGroup) {
          core.dispatch({ type: 'open_equipment', filterId, filterName: filterName || state.filterName, stage: activeStage.key, groups: [], cycleGroup: state.equipmentGroup });
          setSelectedEquipGroup(state.equipmentGroup); setReadings({}); setLoading(false); return;
        }
      }

      const { executed, deferred } = await core.advance({
        filterId,
        filterName: filterName || state.filterName,
        targetState: activeStage.key,
        cleaningAreaId: selectedBlock?.id,
        remarks: remarks || `${activeStage.label} - ${filterName}`,
      });
      // Dialog-first (2026-07-16): this stage has a mandatory checklist, so
      // NOTHING was written — the dialog is open and the advance commits
      // atomically with the answers. Reporting "→ stage" / a recent-op here
      // would claim a transition that hasn't happened (and that Close will
      // discard). The checklist submit handler reports the combined result.
      if (deferred) {
        setScanValue(''); setRemarks('');
        setLoading(false);
        return;
      }
      setSuccess(`${filterName || state.filterName} → ${activeStage.label}${executed ? '' : ' (queued)'}`);
      setRecentOps(prev => [{ stage: activeStage.key, filter: filterName || state.filterName, time: formatTime(new Date()), queued: !executed }, ...prev].slice(0, 200));
      setScanValue(''); setRemarks('');
      if (executed) mutate('/api/assets/instances');
    } catch (e: any) {
      if ((e.code === 'BLOCK_CHANGE_CONFIRM' || e.code === 'BLOCK_CHANGE_REQUIRED') && e.connectionInfo) {
        core.dispatch({ type: 'open_block_change', filterId: e.connectionInfo.filterId, filterName: scanValue, homeBlockId: e.connectionInfo.homeBlockId, homeBlockName: e.connectionInfo.homeBlockName, requestedBlockId: e.connectionInfo.requestedBlockId, requestedBlockName: e.connectionInfo.requestedBlockName });
        setBlockChangeReason(''); setLoading(false); return;
      }
      setError(e.message ?? 'Failed');
    }
    setLoading(false);
  };

  // Pending cycle payload — saved when reason is selected, used by equipment dialog for offline compound queue
  const [pendingCyclePayload, setPendingCyclePayload] = useState<Record<string, any> | null>(null);

  const handleReasonSubmit = async () => {
    if (!reasonDialog || !selectedReason) return;
    setLoading(true); setError('');
    const cyclePayload = { cleaningReasonKey: selectedReason, cleaningJustification: justification || undefined, cleaningAreaId: selectedBlock?.id, acknowledgeBlockChange: ackedBlockFiltersRef.current.has(reasonDialog.filterId) };
    const advancePayload = { targetState: reasonDialog.stage, cleaningAreaId: selectedBlock?.id, remarks: remarks || `${reasonDialog.stage.replace(/_/g, ' ')} - ${reasonDialog.filterName}` };

    // Check for equipment groups BEFORE executing — works for both online and offline.
    // No API mutation yet, no reauth needed here.
    if (reasonDialog.stage === 'WASH_IN' && selectedBlock?.id) {
      let groups: any[] = [];
      if (online) {
        try { groups = await apiClient.get<any[]>(`/api/equipment-groups/by-block/${selectedBlock.id}`) ?? []; } catch { /* fall through with empty groups → no equipment dialog */ }
      } else {
        // Offline: use cached equipment groups
        const cachedGroups = await getCache<any[]>('equipment-groups') ?? [];
        groups = cachedGroups.filter((g: any) => g.blockId === selectedBlock.id);
      }
      if (groups.length > 0) {
        // Save the cycle payload — equipment dialog will use it for the compound operation
        // (handleEquipSubmit's `if (pendingCyclePayload)` branch reauth-wraps the actual mutation)
        setPendingCyclePayload(cyclePayload);
        // 2026-05-20: thread the batch list through to equipment dialog so
        // handleEquipSubmit can iterate after the first cycle-start completes.
        const batchRest = reasonDialog.remainingBatch;
        core.dispatch({ type: 'close' }); // close reason dialog
        core.dispatch({
          type: 'open_equipment',
          filterId: reasonDialog.filterId,
          filterName: reasonDialog.filterName,
          stage: reasonDialog.stage,
          groups,
          remainingBatch: batchRest,
        });
        setSelectedEquipGroup(null); setReadings({});
        setLoading(false); return;
      }
    }

    // 2026-07-09 fix: multi-filter no-equipment-group batch cycle-start. The
    // single-filter path below only ever started `reasonDialog.filterId` and
    // DROPPED `remainingBatch` — so a Wash In batch on a block WITHOUT an
    // equipment group started only the first filter. Handle the whole batch here
    // (mirrors handleEquipSubmit's cycle-start split); the single-filter path
    // below is left untouched.
    const noEqBatch = reasonDialog.remainingBatch ?? [];
    if (noEqBatch.length > 0) {
      const allFilters = [{ filterId: reasonDialog.filterId, filterName: reasonDialog.filterName }, ...noEqBatch];
      const stageLabel = reasonDialog.stage.replace(/_/g, ' ');
      const nameById = new Map(allFilters.map(f => [f.filterId, f.filterName]));
      const cycleStartActions = new Map<string, any[]>();
      const advanceFor = (fname: string) => ({ targetState: reasonDialog.stage, cleaningAreaId: selectedBlock?.id, remarks: remarks || `${stageLabel} - ${fname}` });
      try {
        if (online) {
          // ONE /bulk-operate covering every filter (no readings for a
          // no-equipment block). runBulkOnline handles reauth internally.
          const ops: BulkClientItem[] = allFilters.map(f => ({
            clientOpId: crypto.randomUUID(),
            filterId: f.filterId,
            kind: 'start-and-advance' as const,
            cyclePayload,
            advancePayload: advanceFor(f.filterName),
          }));
          const out = await runBulkOnline(ops, 'START_CLEANING_CYCLE');
          if (out === 'cancelled') { setLoading(false); return; }
          if (out === 'transport_error') { setError('Could not reach the server to start the cycles. Please try again.'); setLoading(false); return; }
          for (const [fid, actions] of out.actionsByFilter) cycleStartActions.set(fid, actions);
          for (const r of out.results) {
            if (r.status === 'ok') setRecentOps(prev => [{ stage: reasonDialog.stage, filter: nameById.get(r.filterId) ?? r.filterId, time: formatTime(new Date()), queued: false }, ...prev].slice(0, 200));
          }
          const failMsgs = out.results.flatMap(r => r.status === 'failed' ? [`${nameById.get(r.filterId) ?? r.filterId}: ${r.error?.message ?? 'failed'}`] : []);
          if (failMsgs.length > 0) setError(failMsgs.join('; '));
          if (out.okCount > 0) { setSuccess(`Started ${out.okCount} cycle(s)`); mutate('/api/assets/instances'); }
        } else {
          // Offline: per-filter start-and-advance, skipping the in-core checklist
          // dispatch so the unified dialog below covers the whole batch.
          for (const f of allFilters) {
            try {
              const res = await core.startAndAdvance({
                filterId: f.filterId,
                filterName: f.filterName,
                cyclePayload,
                advancePayload: advanceFor(f.filterName),
                targetState: reasonDialog.stage,
                cleaningAreaId: selectedBlock?.id,
                skipChecklistDispatch: true,
              });
              if (res.executed && Array.isArray((res.result as any)?.actions)) cycleStartActions.set(f.filterId, (res.result as any).actions);
              setRecentOps(prev => [{ stage: reasonDialog.stage, filter: f.filterName, time: formatTime(new Date()), queued: true }, ...prev].slice(0, 200));
            } catch (e: any) {
              setError(`${f.filterName}: ${e?.message ?? 'cycle-start failed'}`);
            }
          }
          setSuccess(`Queued ${allFilters.length} cycle(s)`);
        }
        setScanValue(''); setRemarks('');
        // Unified checklist dispatch — ONE dialog for all same-signature filters
        // (same pattern as handleEquipSubmit). Close the reason dialog otherwise.
        const sigOf = (rows: any[]) => rows.map((r: any) => `${r.checklistProfileId}@${r.profileVersion ?? 0}`).sort().join('|');
        type Pending = { item: { filterId: string; filterName: string }; checklists: any[]; signature: string };
        const pending: Pending[] = [];
        for (const f of allFilters) {
          try {
            const checklists = await resolvePendingChecklistDialog(f.filterId, cycleStartActions.get(f.filterId) ?? undefined);
            if (checklists && checklists.length > 0) pending.push({ item: f, checklists, signature: sigOf(checklists) });
          } catch { /* per-filter resolver failure shouldn't poison the batch */ }
        }
        if (pending.length > 0) {
          const groups = new Map<string, Pending[]>();
          for (const p of pending) { const arr = groups.get(p.signature) ?? []; arr.push(p); groups.set(p.signature, arr); }
          let chosen: Pending[] = [];
          for (const arr of groups.values()) if (arr.length > chosen.length) chosen = arr;
          const primary = chosen[0];
          const batchMembers = chosen.map(p => p.item);
          if ((await gateAhuBeforeChecklist(batchMembers.map(m => m.filterId))) === 'proceed') {
            setPendingBatch(batchMembers);
            core.dispatch({ type: 'open_checklist', filterId: primary.item.filterId, filterName: batchMembers.length > 1 ? `${batchMembers.length} filter(s)` : primary.item.filterName, checklists: primary.checklists });
            setChecklistAnswers({});
          } else {
            core.dispatch({ type: 'close' }); // AHU gate dialog is showing; drop the reason dialog
          }
        } else {
          core.dispatch({ type: 'close' }); // no checklist → close the reason dialog
        }
      } catch (e: any) {
        setError(e?.message ?? 'Failed to start cycles');
        core.dispatch({ type: 'close' });
      }
      setLoading(false);
      return;
    }

    // No equipment groups, SINGLE filter — fire the compound op. START_CLEANING_CYCLE
    // is reauth-gated for ADMIN role; wrap so the password dialog appears.
    await reauth.execute('START_CLEANING_CYCLE', async (password?) => {
      const { executed: cycleExecuted, deferred: cycleDeferred } = await core.startAndAdvance({
        filterId: reasonDialog.filterId,
        filterName: reasonDialog.filterName,
        cyclePayload,
        advancePayload,
        targetState: reasonDialog.stage,
        cleaningAreaId: selectedBlock?.id,
        password,
      });

      // Dialog-first (2026-07-16): the first stage has a mandatory checklist, so
      // NOTHING was written — not even the cycle start. The dialog is open and
      // the whole compound op fires on submit. Reporting "→ stage" / "(queued)"
      // here would claim a cycle + transition that have not happened and that
      // Close discards.
      if (cycleDeferred) {
        setScanValue(''); setRemarks('');
        return;
      }

      const stageLabel = reasonDialog.stage.replace(/_/g, ' ');
      setSuccess(`${reasonDialog.filterName} → ${stageLabel}${cycleExecuted ? '' : ' (queued)'}`);
      setRecentOps(prev => [{ stage: reasonDialog.stage, filter: reasonDialog.filterName, time: formatTime(new Date()), queued: !cycleExecuted }, ...prev].slice(0, 200));
      setScanValue(''); setRemarks('');
      if (cycleExecuted) mutate('/api/assets/instances');
      // Dialog close + checklist dispatch handled by core.startAndAdvance
    }, {
      onError: (e: any) => {
        if ((e?.code === 'BLOCK_CHANGE_CONFIRM' || e?.code === 'BLOCK_CHANGE_REQUIRED') && e?.connectionInfo) {
          core.dispatch({ type: 'close' }); // close reason dialog
          core.dispatch({ type: 'open_block_change', filterId: e.connectionInfo.filterId, filterName: reasonDialog?.filterName ?? '', homeBlockId: e.connectionInfo.homeBlockId, homeBlockName: e.connectionInfo.homeBlockName, requestedBlockId: e.connectionInfo.requestedBlockId, requestedBlockName: e.connectionInfo.requestedBlockName });
          setBlockChangeReason('');
          return;
        }
        setError(e?.message ?? 'Failed');
      },
    });
    setLoading(false);
  };

  const handleDryerDurationSubmit = async (minutes: number) => {
    if (!dryerDialog || dryerLoading) return;
    setDryerLoading(true); setDryerError('');
    try {
      const filterId = dryerDialog.filterId;
      const filterName = dryerDialog.filterName;
      const { executed } = await core.advance({
        filterId,
        filterName,
        targetState: 'DRY_IN',
        cleaningAreaId: selectedBlock?.id,
        dryerAction: 'SET_DURATION',
        dryerDurationMinutes: minutes,
        remarks: remarks || `Dryer started (${minutes} min) - ${filterName}`,
      });
      setSuccess(`${filterName} → Dryer running (${minutes} min)${executed ? '' : ' (queued)'}`);
      setRecentOps(prev => [{ stage: 'Dryer Started', filter: filterName, time: formatTime(new Date()), queued: !executed }, ...prev].slice(0, 200));
      // Cache dryer timing + equipmentGroup (offline + navigation persistence).
      // This is supplemental cache data (timer + group) beyond what
      // recomputeAndCacheFilterState covers; keep it here.
      try {
        const cached = await getCache<any>(`filter-state-${filterId}`) ?? {};
        // Resolve equipment group for offline temperature dropdown
        let eqGroup = cached.equipmentGroup ?? null;
        if (!eqGroup && selectedBlock?.id) {
          const allGroups = await getCache<any[]>('equipment-groups') ?? [];
          const blockGroups = allGroups.filter((g: any) => g.blockId === selectedBlock.id);
          if (blockGroups.length === 1) eqGroup = blockGroups[0];
        }
        cache(`filter-state-${filterId}`, {
          ...cached,
          currentState: 'DRY_IN',
          equipmentGroup: eqGroup,
          currentCycle: {
            ...(cached.currentCycle ?? {}),
            status: 'IN_PROGRESS',
            dryerDurationMinutes: minutes,
            dryerStartedAt: new Date().toISOString(),
            cleaningAreaId: selectedBlock?.id ?? cached.currentCycle?.cleaningAreaId ?? null,
          },
        }, 24 * 60 * 60 * 1000);
      } catch { /* ignore cache errors */ }
      setScanValue(''); setRemarks('');

      // 2026-05-20 batch dryer-start continuation. Apply the SAME duration
      // to each remaining filter in the batch. Sequential so cache writes +
      // audit order stay deterministic.
      const batchRest = dryerDialog.remainingBatch ?? [];
      if (batchRest.length > 0) {
        for (const rest of batchRest) {
          try {
            const { executed: restExecuted } = await core.advance({
              filterId: rest.filterId,
              filterName: rest.filterName,
              targetState: 'DRY_IN',
              cleaningAreaId: selectedBlock?.id,
              dryerAction: 'SET_DURATION',
              dryerDurationMinutes: minutes,
              remarks: remarks || `Dryer started (${minutes} min) - ${rest.filterName}`,
            });
            setRecentOps(prev => [{ stage: 'Dryer Started', filter: rest.filterName, time: formatTime(new Date()), queued: !restExecuted }, ...prev].slice(0, 200));
            // Mirror the dryer-timing cache write for each batched filter.
            try {
              const cached = await getCache<any>(`filter-state-${rest.filterId}`) ?? {};
              let eqGroup = cached.equipmentGroup ?? null;
              if (!eqGroup && selectedBlock?.id) {
                const allGroups = await getCache<any[]>('equipment-groups') ?? [];
                const blockGroups = allGroups.filter((g: any) => g.blockId === selectedBlock.id);
                if (blockGroups.length === 1) eqGroup = blockGroups[0];
              }
              cache(`filter-state-${rest.filterId}`, {
                ...cached,
                currentState: 'DRY_IN',
                equipmentGroup: eqGroup,
                currentCycle: {
                  ...(cached.currentCycle ?? {}),
                  status: 'IN_PROGRESS',
                  dryerDurationMinutes: minutes,
                  dryerStartedAt: new Date().toISOString(),
                  cleaningAreaId: selectedBlock?.id ?? cached.currentCycle?.cleaningAreaId ?? null,
                },
              }, 24 * 60 * 60 * 1000);
            } catch { /* ignore cache errors */ }
          } catch (batchErr: any) {
            // eslint-disable-next-line no-console
            console.warn(`[batch-dryer-start] ${rest.filterName} failed:`, batchErr);
            setDryerError(`${rest.filterName}: ${batchErr?.message ?? 'dryer start failed'}`);
          }
        }
        setSuccess(`Started dryer on ${batchRest.length + 1} filters (${minutes} min each)`);
      }

      // Close the dryer dialog. open_checklist from awaiting_dryer is illegal
      // (assertOpenable), so core.advance never auto-opens a checklist from here.
      // Dispatch close explicitly so the dialog dismisses.
      core.dispatch({ type: 'close' });
      if (executed) mutate('/api/assets/instances');
    } catch (e: any) {
      setDryerError(e.message ?? 'Failed to start dryer');
    }
    setDryerLoading(false);
  };

  // Mark a value the operator typed/picked. Editing an auto-filled value flips
  // provenance to AUTO_OVERRIDDEN (never silently stays AUTO).
  const setEquipReading = (instId: string, raw: string) => {
    setReadings(prev => {
      const next = { ...prev };
      const n = Number(raw);
      if (raw === '' || Number.isNaN(n)) delete next[instId];
      else next[instId] = n;
      return next;
    });
    setEquipSource(prev => ({ ...prev, [instId]: (prev[instId] === 'AUTO' || prev[instId] === 'AUTO_OVERRIDDEN') ? 'AUTO_OVERRIDDEN' : 'MANUAL' }));
  };

  // "Get Values": poll the SSRF-hardened server proxy, filling each auto
  // instrument as it arrives, retrying the still-pending ones for up to ~2 min,
  // then leaving them for manual entry. Aborts on dialog close (equipCancelRef).
  const handleGetValuesMobile = async () => {
    if (!equipDialog || !selectedEquipGroup || equipFetching) return;
    // Auto-fetch is online-only; offline there's nothing to poll (the button is
    // hidden too, but guard here so a stale render can't kick off a doomed loop).
    if (!online) return;
    const autoIds = (selectedEquipGroup.instruments ?? [])
      .filter((i: any) => i.stageKey === equipDialog.stage && i.autoFetchEnabled === true)
      .map((i: any) => i.id);
    if (autoIds.length === 0) return;
    equipCancelRef.current = false;
    setEquipFetching(true);
    const pending = new Set<string>(autoIds);
    setEquipPending(new Set(pending));
    setEquipFetchStatus(`Fetching ${autoIds.length} reading(s)…`);
    const start = Date.now();
    try {
      while (pending.size > 0 && (Date.now() - start) < 120_000) {
        if (equipCancelRef.current) return;
        let res: any = null;
        try {
          res = await apiClient.post<any>('/api/equipment-groups/fetch-readings', {
            filterId: equipDialog.filterId, groupId: selectedEquipGroup.id, stageKey: equipDialog.stage,
          });
        } catch { res = null; }
        if (equipCancelRef.current) return;
        for (const r of (res?.results ?? [])) {
          if (r?.ok && typeof r.value === 'number' && pending.has(r.instrumentId)) {
            setReadings(prev => ({ ...prev, [r.instrumentId]: r.value }));
            setEquipSource(prev => ({ ...prev, [r.instrumentId]: 'AUTO' }));
            pending.delete(r.instrumentId);
          }
        }
        setEquipPending(new Set(pending));
        if (pending.size === 0) break;
        setEquipFetchStatus(`Got ${autoIds.length - pending.size}/${autoIds.length}. Retrying…`);
        await new Promise(r => setTimeout(r, 5_000));
      }
    } finally {
      if (!equipCancelRef.current) {
        setEquipFetching(false);
        setEquipFetchStatus(pending.size > 0 ? `${pending.size} reading(s) couldn't be fetched — enter manually.` : 'All readings fetched.');
      }
    }
  };

  const handleEquipSubmit = async () => {
    if (!equipDialog || !selectedEquipGroup) return;
    // Validate all instrument readings are filled
    const stageInstruments = (selectedEquipGroup.instruments ?? []).filter((i: any) => i.stageKey === equipDialog.stage);
    for (const inst of stageInstruments) {
      if (readings[inst.id] === undefined) {
        setError(`Please select a value for ${inst.description}`);
        return;
      }
    }
    // Out-of-range readings are allowed but must be confirmed — recorded as a
    // deviation on the server.
    const oos = stageInstruments.filter((i: any) => {
      const v = readings[i.id];
      return v !== undefined && (v < i.operatingMin || v > i.operatingMax);
    });
    if (oos.length > 0) {
      const lines = oos.map((i: any) => `• ${i.description}: ${readings[i.id]} ${i.uom} (range ${i.operatingMin}–${i.operatingMax})`).join('\n');
      if (!window.confirm(`These readings are OUTSIDE the operating range:\n\n${lines}\n\nSubmit anyway?`)) return;
    }
    setLoading(true); setError('');
    // Snapshot equip dialog fields before any async dispatch that clears the state
    const equipFiltId = equipDialog.filterId;
    const equipFiltName = equipDialog.filterName;
    const equipStage = equipDialog.stage;
    // 2026-05-20 batch cycle-start: stash the remaining filters before the
    // dispatch clears equipDialog. After the first cycle-start completes,
    // iterate through these applying the SAME reason + equipment + readings.
    const batchRest = equipDialog.remainingBatch ?? [];
    try {
      const isDryerReadings = equipStage === 'DRY_IN';
      const targetState = isDryerReadings ? 'DRY_IN' : equipStage;

      // If we have a pending cycle payload (from reason dialog), use compound operation.
      // The start-cycle half is reauth-gated (START_CLEANING_CYCLE for ADMIN role) — wrap.
      // The plain-advance branch is NOT reauth-gated (POST /advance has no enforceReauth).
      let executed: boolean | undefined;
      // Bulk online path only: did the FIRST scanned filter (which drives the
      // shared success toast + recent-ops entry below) specifically fail? Keyed
      // separately from `executed` because okCount>0 would paint a false
      // "Success"/"(queued)" for that filter inside a partially-failed batch.
      let firstFilterFailed = false;
      // 2026-05-26: track whether core.startAndAdvance / core.advance opened
      // a checklist dialog. The trailing "close stale equipment dialog"
      // logic at the end of this handler used to read core.dialogState.kind
      // — a stale-closure value captured at handler entry — and would fire
      // close on top of the just-opened checklist dialog, killing the gate
      // on every L1-style profile (every-stage checklist). Now we trust the
      // hook's return value.
      let dialogOpenedByCore = false;
      // 2026-07-16: the single-filter advance deferred — the checklist dialog is
      // open and NOTHING was written yet. Everything below that reports a
      // completed stage (success toast, recent-ops) must be skipped; the
      // checklist submit handler reports the combined result instead.
      let deferredHere = false;
      // 2026-05-26: capture server tape per filter so the unified-batch
      // post-loop dispatch (below) groups same-signature filters into ONE
      // dialog. Pre-fix the cycle-start used the per-filter remainingBatch
      // cycling pattern which dropped 2 of 3 checklists in the multi-filter
      // L1 batch test on tablet HA28H13Z 2026-05-26 19:00 IST.
      const cycleStartActionsByFilter = new Map<string, any[]>();
      if (pendingCyclePayload) {
        const cyclePayloadSnap = pendingCyclePayload;
        if (online && batchRest.length > 0) {
          // Task 4 (2026-07-09) batch cycle-start via /bulk-operate: online
          // multi-filter fires ONE request covering the first filter + every
          // batched filter, replacing the first core.startAndAdvance PLUS the
          // per-filter batchRest loop below. runBulkOnline is reauth-capable
          // (opens the password dialog for a reauth-gated role, posts inline
          // otherwise) so NO reauth.execute wrapper is needed here. Single-filter
          // online AND all offline stay on the core.startAndAdvance path in the
          // else branch — byte-identical to before (single isn't a batch; core's
          // in-dispatch keeps opening its checklist gate).
          const allBatchFilters = [{ filterId: equipFiltId, filterName: equipFiltName }, ...batchRest];
          const ops: BulkClientItem[] = allBatchFilters.map(f => ({
            clientOpId: crypto.randomUUID(),
            filterId: f.filterId,
            kind: 'start-and-advance' as const,
            cyclePayload: cyclePayloadSnap,
            advancePayload: {
              targetState,
              cleaningAreaId: selectedBlock?.id,
              equipmentGroupId: selectedEquipGroup.id,
              instrumentReadings: readings,
              ...(isDryerReadings ? { dryerAction: 'SUBMIT_READINGS' } : {}),
              remarks: remarks || `${equipStage.replace(/_/g, ' ')} - ${f.filterName}`,
            },
          }));
          const out = await runBulkOnline(ops, 'START_CLEANING_CYCLE');
          // Operator declined reauth — keep the dialog + state, no error banner.
          if (out === 'cancelled') { setLoading(false); return; }
          // Wholesale transport failure — keep state so the operator can retry.
          if (out === 'transport_error') {
            setError('Could not reach the server to start the cycles. Please try again.');
            setLoading(false);
            return;
          }
          setPendingCyclePayload(null);
          // `executed` gates the instances mutate below: true if ANY filter
          // succeeded. The first-filter success toast is keyed separately on that
          // filter's OWN result (firstFilterFailed) so a partial/total failure
          // doesn't falsely claim equipFiltName succeeded or was queued offline.
          executed = out.okCount > 0;
          firstFilterFailed = out.results.find(r => r.filterId === equipFiltId)?.status === 'failed';
          // Feed the unified checklist dispatch (below) the authoritative
          // per-filter server actions, exactly as the per-filter loop did.
          for (const [fid, actions] of out.actionsByFilter) cycleStartActionsByFilter.set(fid, actions);
          // Recent-ops parity with the offline per-filter loop: one entry per
          // batched filter that succeeded (the first filter's entry is added by
          // the shared setRecentOps below). A start-and-advance that FAILS on the
          // advance half may have CREATED a cycle (server guards a re-start with
          // CYCLE_ACTIVE 409) — surface it via setError; operator re-scans to retry.
          const nameById = new Map(allBatchFilters.map(f => [f.filterId, f.filterName]));
          for (const r of out.results) {
            if (r.filterId === equipFiltId) continue;
            if (r.status === 'ok') {
              setRecentOps(prev => [{ stage: equipStage, filter: nameById.get(r.filterId) ?? r.filterId, time: formatTime(new Date()), queued: false }, ...prev].slice(0, 200));
            }
          }
          const failMsgs = out.results.flatMap(r =>
            r.status === 'failed'
              ? [`${nameById.get(r.filterId) ?? r.filterId}: ${r.error?.message ?? 'failed'}`]
              : []);
          if (failMsgs.length > 0) setError(failMsgs.join('; '));
        } else {
          // For multi-filter cycle-start: skip the in-core dispatch entirely
          // and let the post-loop unified-batch dispatch handle it. Same shape
          // as the multi-filter DRY_IN SET_DURATION path (handleSubmitQueue
          // line ~890). For single-filter, no batchRest, normal dispatch.
          const useUnifiedBatch = batchRest.length > 0;
          await reauth.execute('START_CLEANING_CYCLE', async (password?) => {
            const res = await core.startAndAdvance({
              filterId: equipFiltId,
              filterName: equipFiltName,
              cyclePayload: cyclePayloadSnap,
              advancePayload: {
                targetState,
                cleaningAreaId: selectedBlock?.id,
                equipmentGroupId: selectedEquipGroup.id,
                instrumentReadings: readings,
                ...(isDryerReadings ? { dryerAction: 'SUBMIT_READINGS' } : {}),
                remarks: remarks || `${equipStage.replace(/_/g, ' ')} - ${equipFiltName}`,
              },
              targetState,
              cleaningAreaId: selectedBlock?.id,
              password,
              skipChecklistDispatch: useUnifiedBatch,
            });
            executed = res.executed;
            dialogOpenedByCore = dialogOpenedByCore || res.dialogOpened;
            // Cycle-start deferred behind its first-stage checklist: nothing was
            // written (not even the cycle). Suppresses the success toast +
            // recent-ops below — the checklist submit fires the whole compound op
            // and reports. Only reachable when !useUnifiedBatch (the hook refuses
            // to defer a batch continuation).
            deferredHere = res.deferred === true;
            if (useUnifiedBatch && executed && Array.isArray((res.result as any)?.actions)) {
              cycleStartActionsByFilter.set(equipFiltId, (res.result as any).actions);
            }
          });
          setPendingCyclePayload(null);
          // If reauth dialog was cancelled or failed, `executed` stays undefined —
          // bail out without proceeding into the post-advance state mgmt below.
          if (typeof executed !== 'boolean') {
            setLoading(false);
            return;
          }
        }
      } else {
        const res = await core.advance({
          filterId: equipFiltId,
          filterName: equipFiltName,
          targetState,
          cleaningAreaId: selectedBlock?.id,
          equipmentGroupId: selectedEquipGroup.id,
          instrumentReadings: readings,
          ...(isDryerReadings ? { dryerAction: 'SUBMIT_READINGS' } : {}),
          remarks: remarks || `${equipStage.replace(/_/g, ' ')} - ${equipFiltName}`,
          // Dialog-first deferral would park this advance on the checklist
          // dialog and return — skipping the batch-continuation loop below.
          // Single-filter only.
          allowDefer: batchRest.length === 0,
        });
        executed = res.executed;
        dialogOpenedByCore = dialogOpenedByCore || res.dialogOpened;
        deferredHere = res.deferred === true;
      }

      // 2026-05-25 combined-screen UX: snapshot the readings the operator just
      // sent so the checklist dialog (auto-opened by resolveAndDispatchChecklist)
      // can show them at the top. selectedEquipGroup carries the instrument
      // metadata needed to render the values with their descriptions + uoms.
      const recap = (selectedEquipGroup?.instruments ?? [])
        .filter((i: any) => i.stageKey === equipStage && readings[i.id] !== undefined)
        .map((i: any) => ({
          description: i.description as string,
          value: formatByLeastCount(readings[i.id], i.leastCount),
          uom: i.uom as string,
        }));
      // Don't show the readings recap for the first filter if it specifically
      // failed the batch (its checklist won't open; showing its recap misleads).
      if (!firstFilterFailed) {
        setStageSubmitRecap({
          stage: equipStage,
          filterName: equipFiltName,
          readings: recap,
          submittedAt: formatTime(new Date()),
        });
      }
      const queued = !executed;
      // Skip the first-filter success toast + recent-ops entry when THAT filter
      // failed in an online batch (its failure is already surfaced via setError);
      // otherwise it falsely reads as "Success"/"(queued)".
      //
      // `deferredHere` (2026-07-16): the advance was NOT written — the checklist
      // dialog is open and it commits atomically on submit. `queued` is true here
      // only because `executed` is false, so this would print a "(queued)" that is
      // doubly wrong: nothing is queued, and no stage was reached. The checklist
      // submit handler reports the real outcome. The recap above IS still set —
      // it renders the readings at the top of the open dialog.
      if (!firstFilterFailed && !deferredHere) {
        setSuccess(`${equipFiltName} → ${equipStage.replace(/_/g, ' ')}${queued ? ' (queued)' : ''}`);
        setRecentOps(prev => [{ stage: equipStage, filter: equipFiltName, time: formatTime(new Date()), queued }, ...prev].slice(0, 200));
      }

      // 2026-05-20 batch cycle-start continuation. After the first filter's
      // start-and-advance completes, replay the SAME reason payload +
      // equipment + readings for each remaining filter in the queue. Sequential
      // (not parallel) so each cycle's auditTrail row is ordered + the
      // optimistic UI state stays consistent.
      if (batchRest.length > 0 && pendingCyclePayload) {
        // OFFLINE multi-filter: replay the SAME reason payload + equipment +
        // readings per remaining filter via core.startAndAdvance. ONLINE
        // multi-filter is already fully handled by the ONE runBulkOnline call
        // above (both the first filter AND every batchRest filter), so this
        // per-filter network loop is offline-only now. The unified checklist
        // dispatch that follows runs for BOTH paths (fed by
        // cycleStartActionsByFilter, populated online from out.actionsByFilter).
        if (!online) {
          const cyclePayloadSnap = pendingCyclePayload;
          const equipGroupSnap = selectedEquipGroup;
          const readingsSnap = readings;
          for (const rest of batchRest) {
            try {
              await reauth.execute('START_CLEANING_CYCLE', async (password?) => {
                const restRes = await core.startAndAdvance({
                  filterId: rest.filterId,
                  filterName: rest.filterName,
                  cyclePayload: cyclePayloadSnap,
                  advancePayload: {
                    targetState,
                    cleaningAreaId: selectedBlock?.id,
                    equipmentGroupId: equipGroupSnap.id,
                    instrumentReadings: readingsSnap,
                    ...(isDryerReadings ? { dryerAction: 'SUBMIT_READINGS' } : {}),
                    remarks: remarks || `${equipStage.replace(/_/g, ' ')} - ${rest.filterName}`,
                  },
                  targetState,
                  cleaningAreaId: selectedBlock?.id,
                  password,
                  // 2026-05-26: all batch iterations skip in-core dispatch.
                  // Unified-batch dispatch fires AFTER this loop completes,
                  // grouping all filters into one dialog. Replaces the old
                  // per-filter remainingBatch cycling pattern that dropped
                  // checklists when the operator didn't see/answer every
                  // sequential dialog.
                  skipChecklistDispatch: true,
                });
                if (restRes.executed && Array.isArray((restRes.result as any)?.actions)) {
                  cycleStartActionsByFilter.set(rest.filterId, (restRes.result as any).actions);
                }
              });
              setRecentOps(prev => [{ stage: equipStage, filter: rest.filterName, time: formatTime(new Date()), queued: false }, ...prev].slice(0, 200));
            } catch (batchErr: any) {
              // eslint-disable-next-line no-console
              console.warn(`[batch-cycle-start] ${rest.filterName} failed:`, batchErr);
              setError(`${rest.filterName}: ${batchErr?.message ?? 'cycle-start failed'}`);
            }
          }
        }
        setSuccess(`Started ${batchRest.length + 1} cycles successfully`);

        // 2026-05-26: unified-batch checklist dispatch for multi-filter
        // cycle-start. Walk every filter's server tape, group by checklist
        // signature, open ONE dialog covering all same-signature filters.
        // handleChecklistSubmit's batch branch then POSTs identical answers
        // to each member sequentially. Same pattern as the mid-cycle batch
        // path in handleSubmitQueue post-loop.
        try {
          const sigOf = (rows: any[]) =>
            rows.map((r: any) => `${r.checklistProfileId}@${r.profileVersion ?? 0}`).sort().join('|');
          type Pending = { item: { filterId: string; filterName: string }; checklists: any[]; signature: string };
          const pending: Pending[] = [];
          const allFiltersInBatch = [
            { filterId: equipFiltId, filterName: equipFiltName },
            ...batchRest.map(b => ({ filterId: b.filterId, filterName: b.filterName })),
          ];
          for (const f of allFiltersInBatch) {
            try {
              const serverActions = cycleStartActionsByFilter.get(f.filterId);
              const checklists = await resolvePendingChecklistDialog(f.filterId, serverActions ?? undefined);
              if (checklists && checklists.length > 0) {
                pending.push({ item: f, checklists, signature: sigOf(checklists) });
              }
            } catch { /* per-filter resolver failure shouldn't poison the batch */ }
          }
          if (pending.length > 0) {
            const groups = new Map<string, Pending[]>();
            for (const p of pending) {
              const arr = groups.get(p.signature) ?? [];
              arr.push(p);
              groups.set(p.signature, arr);
            }
            let chosen: Pending[] = [];
            for (const arr of groups.values()) {
              if (arr.length > chosen.length) chosen = arr;
            }
            const primary = chosen[0];
            const batchMembers = chosen.map(p => p.item);
            // AHU pre-flight BEFORE the (terminal) checklist opens.
            if ((await gateAhuBeforeChecklist(batchMembers.map(m => m.filterId))) === 'proceed') {
              setPendingBatch(batchMembers);
              core.dispatch({
                type: 'open_checklist',
                filterId: primary.item.filterId,
                filterName: batchMembers.length > 1 ? `${batchMembers.length} filter(s)` : primary.item.filterName,
                checklists: primary.checklists,
              });
              setChecklistAnswers({});
              dialogOpenedByCore = true;
            }
          }
        } catch { /* ignore — operator can re-scan to trigger */ }
      }

      setScanValue(''); setRemarks(''); setSelectedEquipGroup(null); setReadings({});
      // 2026-05-26 fix: explicit close ONLY when core did NOT open a
      // checklist dialog. Pre-fix this read `core.dialogState.kind` which is
      // a stale-closure snapshot from when the handler started ('awaiting_
      // equipment'), so the close fired AFTER open_checklist had transitioned
      // the state to 'awaiting_checklist' — killing the checklist dialog on
      // every L1-style profile where every stage has a gate. Now using the
      // hook's return-value signal so we close the equip dialog when (and
      // only when) the cycle write produced no gate transition.
      if (!dialogOpenedByCore) core.dispatch({ type: 'close' });
      if (executed) mutate('/api/assets/instances');
      // Dialog + checklist dispatch handled by core.advance / core.startAndAdvance
    } catch (e: any) {
      // B7.2: equipment-dialog flows go through `start-and-advance`, which
      // calls start-cycle → validateBlockChange. A cross-block scan there
      // can return 409 BLOCK_CHANGE_REQUIRED — pop the structured modal
      // (same shape as reason-dialog catch above) instead of swallowing
      // it as a generic "Failed" toast.
      if ((e?.code === 'BLOCK_CHANGE_CONFIRM' || e?.code === 'BLOCK_CHANGE_REQUIRED') && e?.connectionInfo) {
        core.dispatch({ type: 'close' }); // close equip dialog first (allowed → none)
        core.dispatch({
          type: 'open_block_change',
          filterId: e.connectionInfo.filterId,
          filterName: equipFiltName,
          homeBlockId: e.connectionInfo.homeBlockId,
          homeBlockName: e.connectionInfo.homeBlockName,
          requestedBlockId: e.connectionInfo.requestedBlockId,
          requestedBlockName: e.connectionInfo.requestedBlockName,
        });
        setBlockChangeReason('');
        setSelectedEquipGroup(null); setReadings({});
        setPendingCyclePayload(null);
        setLoading(false);
        return;
      }
      setError(e.message ?? 'Failed');
    }
    setLoading(false);
  };

  // 2026-07-02: AHU completion pre-flight — runs BEFORE the terminal checklist
  // opens, for BOTH modes (mirrors desktop filter-operations.tsx). Gated on
  // isTerminalChecklist so intermediate checklists are unaffected. Returns
  // 'blocked' when the operator must not open the checklist. Mobile resolves the
  // AHU as the filter's parentId (matches resolveAhuId server logic).
  const gateAhuBeforeChecklist = async (
    filterIds: string[],
    known?: { currentState?: string | null; stageLookup?: any },
  ): Promise<'proceed' | 'blocked'> => {
    // Reset any prior choice so a non-AHU / non-terminal submit carries none.
    ahuSetChoiceRef.current = null;
    if (ahuMode === 'NONE' || filterIds.length === 0) return 'proceed';
    // Terminal-checklist detection MUST use the exact state THIS checklist was
    // opened for. Single-scan passes the just-fetched /current-state (`known`) —
    // using it avoids a redundant second fetch that could return a different or
    // stale response (e.g. a prior cycle's Storage Out) and mis-fire the POPUP at
    // intermediate stages. Only when the caller has no resolved state (batch) do
    // we fetch, falling back to the IndexedDB cache when genuinely offline.
    let termState: any = known;
    if (!termState?.currentState || !termState?.stageLookup) {
      termState = await getCache<any>(`filter-state-${filterIds[0]}`).catch(() => null);
      try { termState = await apiClient.get<any>(`/api/filters/${filterIds[0]}/current-state`); }
      catch { /* genuinely offline → keep cached fallback */ }
    }
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
    // Fail-safe: a FAILED completion check must not read as "all siblings done"
    // for INTERLOCK — that silently defeats the gate. Block + surface it so the
    // operator retries rather than hitting the server 422 at submit. POPUP is
    // advisory, so a failed check there proceeds (already logged in the helper).
    if (failed && ahuMode === 'INTERLOCK') {
      setError('Could not verify AHU completion status. Check your connection and try again.');
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

  const handleChecklistSubmit = async () => {
    if (!checklistDialog) return;
    const checklists = (checklistDialog.checklists as any[]) ?? [];
    // Block an empty-questions checklist (failed/stale load) from posting an
    // empty answer set — the server rejects a real required checklist, so this
    // would dead-end the operator. Point to recovery instead. (The pipeline
    // never gates on a genuinely question-less checklist.)
    if (checklists.some((cl: any) => !Array.isArray(cl.questions) || cl.questions.length === 0)) {
      setError('This checklist could not load its questions. Reconnect and refresh, then reopen it before submitting.');
      return;
    }
    for (const cl of checklists) { for (const q of (cl.questions ?? [])) { if (q.required && (checklistAnswers[q.id] === undefined || checklistAnswers[q.id] === '')) { setError(`Answer required: "${q.question}"`); return; } } }
    setLoading(true); setError('');

    // 2026-07-03: a TERMINAL checklist (e.g. Storage Out → cycle completes) has
    // no follow-up step, so the DRY_IN-style batch replay must NOT fire —
    // otherwise it re-runs handleSubmitQueue over the now-completed filters
    // ("not in correct stage") and the scan queue lingers showing them. Detect
    // completion up-front (fresh state, cache fallback) and suppress the replay
    // BEFORE the dialog close can schedule it; the batch branch clears the queue.
    let willComplete = false;
    try {
      let fresh: any = null;
      // Always attempt fresh (not gated on the flaky `online` flag); cache fallback.
      try { fresh = await apiClient.get<any>(`/api/filters/${checklistDialog.filterId}/current-state`); }
      catch { fresh = await getCache<any>(`filter-state-${checklistDialog.filterId}`); }
      willComplete = isTerminalChecklist(fresh?.currentState, fresh?.stageLookup);
    } catch { /* leave willComplete=false → replay behaves exactly as before */ }
    if (willComplete) pendingBatchReplayRef.current = false;

    // 2026-07-02: the AHU completion pre-flight (POPUP + INTERLOCK) now runs
    // BEFORE the checklist opens (gateAhuBeforeChecklist), so there is no
    // submit-time POPUP pre-flight here. INTERLOCK still has a server-side 422
    // safety net caught below in case state changed between open and submit.

    // Phase A.1: send the version each profile was rendered against — server
    // returns 409 SCHEMA_DRIFT if the cycle pin doesn't match.
    const expectedProfileVersions: Record<string, number> = {};
    for (const cl of checklists) {
      if (typeof cl.profileVersion === 'number') {
        expectedProfileVersions[cl.checklistProfileId] = cl.profileVersion;
      }
    }
    // 2026-07-16: captured BEFORE either branch clears pendingBatchDeferred.
    // True => this submit also performs the parked ADVANCE for each member (one
    // atomic op per filter), so the scan queue must be cleared afterwards even
    // for a non-terminal stage — the filters have moved on and a re-submit would
    // advance them twice.
    const hadDeferred = !!(pendingBatchDeferred && pendingBatchDeferred.size > 0);
    // Task 5 (2026-07-09): ONLINE batch checklist submit via /bulk-operate — ONE
    // request covering every batch member, ONE reauth prompt. runBulkOnline is
    // reauth-capable (opens the password dialog for a reauth-gated role, posts
    // inline otherwise) so NO reauth.execute wrapper is used here — nesting it
    // inside reauth.execute would double-prompt. OFFLINE batch + every single
    // submit stay on the core.submitChecklist path in the reauth.execute block
    // below (byte-identical to before). Mirrors the Task 4 cycle-start split.
    const isBatchSubmit = !!(
      pendingBatch && pendingBatch.length > 0 &&
      pendingBatch.some(p => p.filterId === checklistDialog.filterId)
    );
    if (isBatchSubmit && online) {
      const batch = pendingBatch!;
      const nameById = new Map(batch.map(b => [b.filterId, b.filterName]));
      // Mirror executeOrQueue/use-offline.ts (L114-123): submit-checklist is
      // cycle-bound, so the server needs each filter's tapeVersion (409
      // STALE_TAPE otherwise). Read it from the SAME per-filter
      // `filter-state-<id>` cache row executeOrQueue reads, guarded to a number
      // — include only when present (same source as the Task 3 advance leaf,
      // L1243). expectedProfileVersions (SCHEMA_DRIFT 409) + filterSet (AHU
      // terminal-completion scope) are carried forward exactly as the current
      // core.submitChecklist call passes them. `password` is NOT in the payload:
      // it flows through runBulkOnline → reauth.executeWithResult → bulkOperate.
      const ops: BulkClientItem[] = await Promise.all(batch.map(async (item) => {
        const cachedState = await getCache<any>(`filter-state-${item.filterId}`).catch(() => null);
        // 2026-07-16: this filter's advance was PARKED by the dialog-first batch
        // — send both writes as ONE item so the server commits them in a single
        // transaction. Sending an `advance` item + a `submit-checklist` item
        // would be two per-item transactions and re-open the orphan window.
        const parked = pendingBatchDeferred?.get(item.filterId);
        return {
          clientOpId: crypto.randomUUID(),
          filterId: item.filterId,
          kind: parked ? ('advance-with-checklist' as const) : ('submit-checklist' as const),
          payload: {
            ...(parked ? parked.payload : {}),
            answers: checklistAnswers,
            expectedProfileVersions,
            ...(ahuSetChoiceRef.current ? { filterSet: ahuSetChoiceRef.current } : {}),
            ...(typeof cachedState?.tapeVersion === 'number' ? { tapeVersion: cachedState.tapeVersion } : {}),
          },
        };
      }));
      // Both gates when any item carries an advance — runBulkOnline's action is
      // only the reauth prompt label; the server enforces both regardless
      // (reauthActionsForItems maps advance-with-checklist to BOTH).
      const out = await runBulkOnline(ops, 'SUBMIT_CHECKLIST_WITH_SIGNATURE');
      // Operator declined reauth — keep the dialog + state, no error banner.
      if (out === 'cancelled') { setLoading(false); return; }
      if (out === 'transport_error') {
        setError('Could not reach the server to submit the checklist. Please try again.');
        setLoading(false);
        return;
      }
      // core never dispatched a close (no per-member core.submitChecklist), so
      // close the checklist dialog explicitly — same transition the loop relied
      // on. Ordering (close → state resets → mutate → setLoading) is kept
      // byte-identical to the loop branch so the batch-replay effect (L1454),
      // which keys off awaiting_checklist → none, behaves the same.
      if (core.dialogState.kind === 'awaiting_checklist') core.dispatch({ type: 'close' });
      setPendingBatch(null); setPendingBatchDeferred(null);
      setChecklistAnswers({});
      setStageSubmitRecap(null);
      setRemarks(''); // B1/B2: clear remarks after a checklist-gated submit too
      // Surface per-filter results by NAME (not the raw UUID out.failures carry)
      // — batch members carry filterName; map through it.
      const success = out.okCount;
      const failed = out.results
        .filter((r): r is Extract<BulkClientResult, { status: 'failed' }> => r.status === 'failed')
        .map(r => `${nameById.get(r.filterId) ?? r.filterId}: ${r.error?.message ?? 'failed'}`);
      if (failed.length > 0 && success === 0) {
        setError(failed.join('\n'));
      } else if (failed.length > 0) {
        setError(`${success} succeeded, ${failed.length} failed:\n${failed.join('\n')}`);
      } else {
        setSuccess(`Checklist submitted for ${success} filter(s)`);
      }
      // runBulkOnline already re-primed each filter's `filter-state-<id>` cache
      // from the bulk snapshot, so the per-filter /current-state prime the loop
      // branch did is unnecessary here. Still hard-revalidate the instances list
      // so completed cycles drop out of the view immediately.
      await mutate('/api/assets/instances', undefined, { revalidate: true });
      // Terminal checklist completed the cycles → clear the scan queue so the
      // finished filters don't linger and a re-submit can't re-process them.
      // (DRY_IN / non-terminal keeps the queue for its replay — see L1454.)
      // 2026-07-16: a deferred batch just performed the ADVANCE too (one atomic op
      // per filter), so those filters have moved on — the queue must be cleared or
      // a re-submit would advance them a second time. `hadDeferred` is captured
      // before `pendingBatchDeferred` is cleared.
      if (willComplete || hadDeferred) { setScanQueue([]); setDryerDurations({}); }
      setLoading(false);
      return;
    }

    // SUBMIT_CHECKLIST_WITH_SIGNATURE is reauth-gated for ADMIN role
    // (per system_config['action-reauth']). Wrap so the password dialog
    // appears when policy demands it. OFFLINE batch reaches the batch branch
    // inside (online-batch is handled above); single submits use the else path.
    await reauth.execute('SUBMIT_CHECKLIST_WITH_SIGNATURE', async (password?) => {
      // 2026-05-26: unified-batch branch. When pendingBatch is set AND the
      // open dialog's primary filter is part of that batch, submit the same
      // answers to every member sequentially. The primary-filter check
      // protects against a stale pendingBatch left over from a prior batch
      // session colliding with a fresh single-scan dialog. Mirrors desktop
      // filter-operations.tsx handleChecklistSubmit BATCH MODE branch.
      if (pendingBatch && pendingBatch.length > 0 && pendingBatch.some(p => p.filterId === checklistDialog.filterId)) {
        const batch = pendingBatch;
        let success = 0;
        let queued = 0; // offline-queued is a NORMAL outcome, NOT a failure
        const failed: string[] = [];
        for (const item of batch) {
          try {
            const { executed } = await core.submitChecklist({
              filterId: item.filterId,
              filterName: item.filterName,
              answers: checklistAnswers,
              expectedProfileVersions,
              filterSet: ahuSetChoiceRef.current ?? undefined,
              // 2026-07-16: pass THIS member's parked advance explicitly. One
              // dialog covers N filters, so only the primary has dialog state —
              // without this, members 2..N would queue a bare submit-checklist
              // against a stage their filter never entered.
              deferredAdvance: pendingBatchDeferred?.get(item.filterId),
              password,
            });
            success++;
            // `executed === false` means "accepted + queued for offline sync"
            // — the offline happy path. Do NOT push it into `failed`; that was
            // showing each queued filter as BOTH succeeded AND failed (the
            // "3 succeeded, 3 failed" error popup the operator saw offline).
            if (!executed) queued++;
          } catch (e: any) {
            // Re-throw REAUTH so the reauth.execute wrapper surfaces it.
            const errCode = e?.error ?? e?.code;
            if (errCode === 'REAUTH_FAILED' || errCode === 'REAUTH_REQUIRED') throw e;
            failed.push(`${item.filterName}: ${e?.message ?? 'failed'}`);
          }
        }
        // The last successful submitChecklist already dispatched close (no
        // remainingBatch carried). Force-close in case every item failed so
        // the dialog doesn't get stuck open.
        if (core.dialogState.kind === 'awaiting_checklist') core.dispatch({ type: 'close' });
        setPendingBatch(null); setPendingBatchDeferred(null);
        setChecklistAnswers({});
        setStageSubmitRecap(null);
        setRemarks(''); // B1/B2: clear remarks after a checklist-gated submit too
        if (failed.length > 0 && success === 0) {
          setError(failed.join('\n'));
        } else if (failed.length > 0) {
          setError(`${success} succeeded, ${failed.length} failed:\n${failed.join('\n')}`);
        } else if (queued > 0) {
          // Offline: everything accepted and queued — success, not an error.
          setSuccess(`Checklist queued for ${success} filter(s) — will sync when online`);
        } else {
          setSuccess(`Checklist submitted for ${success} filter(s)`);
        }
        // (Online batch submits are handled by the earlier runBulkOnline branch,
        // which returns before reaching here — so this branch is offline-only and
        // needs no online /current-state re-prime.)
        // Terminal checklist completed the cycles → nothing left to do. Clear the
        // scan queue so the finished filters don't linger and a re-submit can't
        // re-process them. (DRY_IN / non-terminal keeps the queue for its replay.)
        // 2026-07-16: a deferred batch just performed the ADVANCE too (one atomic op
      // per filter), so those filters have moved on — the queue must be cleared or
      // a re-submit would advance them a second time. `hadDeferred` is captured
      // before `pendingBatchDeferred` is cleared.
      if (willComplete || hadDeferred) { setScanQueue([]); setDryerDurations({}); }
        return;
      }

      try {
        const { executed } = await core.submitChecklist({
          filterId: checklistDialog.filterId,
          filterName: checklistDialog.filterName,
          answers: checklistAnswers,
          expectedProfileVersions,
          filterSet: ahuSetChoiceRef.current ?? undefined,
          password,
        });
        setSuccess(`Checklist submitted${executed ? '' : ' (queued)'}`);
        setChecklistAnswers({});
        setRemarks(''); // B1/B2: clear remarks after a checklist-gated submit too
        // Combined-screen UX: once the checklist is submitted, the stage flow
        // for this filter is fully complete — drop the recap so the next stage
        // doesn't show last cycle's data.
        setStageSubmitRecap(null);
        // Dialog close + offline cache-clear + batch walking handled by core.submitChecklist.
        // Robust refresh (see batch branch): hard revalidate + re-prime this
        // filter's /current-state so a completed cycle drops out of the view now.
        if (executed && online) {
          await mutate('/api/assets/instances', undefined, { revalidate: true });
          try {
            const st = await apiClient.get<any>(`/api/filters/${checklistDialog.filterId}/current-state`);
            if (st) await cache(`filter-state-${checklistDialog.filterId}`, st, 24 * 60 * 60 * 1000);
          } catch { /* best-effort prime */ }
        }
      } catch (e: any) {
        // INTERLOCK: server returns 422 AHU_INTERLOCK_PENDING only at the terminal
        // checklist (when shouldComplete=true). Show the blocking dialog; the
        // operator must click Close, then wait for siblings to finish.
        if (e?.code === 'AHU_INTERLOCK_PENDING' && ahuMode === 'INTERLOCK') {
          const info = e?.connectionInfo ?? {};
          const pending = (info.pendingFilters as { id: string; name: string; stage: string }[]) ?? [];
          const filters = (info.filters as { id: string; name: string; stage: string; done: boolean }[])
            ?? pending.map((p: any) => ({ ...p, done: false }));
          // Clear the page loading spinner BEFORE showing the blocking dialog so
          // the checklist Submit button doesn't spin behind the interlock modal.
          setLoading(false);
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
        // Re-throw so reauth.execute's onError handler displays the message.
        throw e;
      }
    }, {
      onError: (e: any) => setError(e?.message ?? 'Failed'),
    });
    setLoading(false);
  };

  // ─── My Tasks handlers ───────────────────────────────
  const toggleTaskExpand = (entryId: string) => {
    setExpandedTasks(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  /**
   * Mobile "Perform" flow — unlike desktop (which deep-links into a filter
   * list), mobile operators scan physical RFID tags. So "Perform" just tells
   * them "go clean filters from AHU X now", auto-opens the Wash In stage,
   * and pre-fills the selected block to whatever block the AHU belongs to.
   * The existing scan flow takes over from there — backend block-change
   * validation still applies, so a mis-scan from a wrong AHU surfaces
   * normally.
   */
  const performTask = (task: any) => {
    // Jump straight into the Wash In stage scan view
    const washIn = STAGES.find(s => s.key === 'WASH_IN');
    if (!washIn) return;
    setActiveStage(washIn);
    setView('stage');
    setScanValue(''); setRemarks(''); setError(''); setSelectedBlock(null);
    // B7.4 follow-up (Issue #1): mirror openStage — entering a fresh stage
    // context must drop any advisory tied to a prior cycle.
    setEquipmentGroupSyncWarning(null);
    setSuccess(`Ready to clean filters from ${task.ahuName}. Scan each filter now.`);
  };

  // ─── Approvals handlers ──────────────────────────────
  const handleApprovalAction = async (requestId: string, action: 'approve' | 'reject') => {
    setProcessingApproval(requestId);
    setError('');
    try {
      await apiClient.post(`/api/block-change-requests/${requestId}/${action}`, { comment: approvalComment.trim() || undefined });
      setSuccess(`Request ${action === 'approve' ? 'approved' : 'rejected'}`);
      setApprovalComment('');
      await mutateApprovals();
    } catch (e: any) {
      setError(e.message ?? `Failed to ${action} request`);
    }
    setProcessingApproval(null);
  };

  // 2026-06-09: block-change approval removed → operator self-confirm. Mark the
  // filter acknowledged; the next start sends acknowledgeBlockChange=true.
  const handleBlockChangeRequest = async () => {
    if (!blockChangeDialog || blockChangeSubmitting) return;
    if (blockChangeMode === 'APPROVAL') {
      if (!online) { setError('Block change requests need an internet connection.'); return; }
      setBlockChangeSubmitting(true);
      try {
        await apiClient.post('/api/block-change-requests', {
          filterId: blockChangeDialog.filterId, filterName: blockChangeDialog.filterName,
          fromBlockId: blockChangeDialog.homeBlockId, fromBlockName: blockChangeDialog.homeBlockName,
          toBlockId: blockChangeDialog.requestedBlockId, toBlockName: blockChangeDialog.requestedBlockName,
          reason: blockChangeReason.trim() || undefined,
        });
        setSuccess('Block change request submitted. Waiting for approval.');
        core.dispatch({ type: 'close' }); setScanValue('');
      } catch (e: any) { setError(e.message ?? 'Failed to submit request'); }
      setBlockChangeSubmitting(false);
      return;
    }
    // CONFIRM mode: self-confirm.
    ackedBlockFiltersRef.current.add(blockChangeDialog.filterId);
    core.dispatch({ type: 'close' });
    setBlockChangeReason('');
    setSuccess(`Confirmed. Scan ${blockChangeDialog.filterName} again to clean it in this block.`);
  };

  const genOpts = (min: number, max: number, step: number): number[] => { const o: number[] = []; if (step <= 0) return o; for (let v = min, i = 0; v <= max + 1e-9 && i < 10000; v = Math.round((v + step) * 1e10) / 1e10, i++) o.push(v); return o; };

  // 2026-05-21 fix: same as mobile-wrapper.tsx — only redirect when truly
  // unauthenticated. SWR's mutate(undefined,false) at logout leaves a cache
  // entry with value=undefined; on next mount isLoading is false (cache hit)
  // while user is briefly undefined → without the token guard below, the
  // operator was bounced back to /m/login right after a successful login.
  const hasAuthTokenInStorage = !!sessionStorage.getItem('access_token');
  if (!authLoading && !user && !hasAuthTokenInStorage) {
    return <Navigate to="/m/login" replace />;
  }
  if (tabletAccess && allowedFeatures.length > 0 && !hasFeature('login')) {
    return <Navigate to="/m/login" replace />;
  }

  return (
    <div className="h-[100dvh] flex flex-col bg-gradient-to-b from-slate-50 to-slate-100 select-none overflow-hidden">
      {/* ─── HEADER ─── */}
      {!hideHeader && <div className="bg-white/80 backdrop-blur-lg border-b border-slate-200/60 px-4 py-3 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-3">
          {view !== 'home' && (
            <button onClick={goHome} className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center active:bg-slate-200">
              <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </button>
          )}
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white text-xs font-extrabold shadow-lg shadow-cyan-500/20">DL</div>
          <div>
            <div className="text-sm font-bold text-slate-800 leading-tight">DigiLog</div>
            <div className="text-[10px] text-slate-400 leading-tight">{user?.fullName ?? user?.username}</div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium ${online ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-red-50 text-red-600 border border-red-200'}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`} />
            {online ? 'Online' : 'Offline'}
          </div>
          {online && (
            <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium ${dataCached ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'bg-yellow-50 text-yellow-600 border border-yellow-200'}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${dataCached ? 'bg-blue-500' : 'bg-yellow-400 animate-pulse'}`} />
              {dataCached ? 'Data Synced' : 'Syncing...'}
            </div>
          )}
          {pendingCount > 0 && (
            <div className="flex items-center gap-1">
              <button onClick={async () => {
                const r = await manualSync();
                if (r.synced > 0) setSuccess(`Synced ${r.synced} operation(s)`);
                if (r.failed > 0) {
                  const ops = await getQueueDetails();
                  const details = ops.filter((o: any) => o.status !== 'synced').map((o: any) => `${o.type}: ${o.filterName} — ${o.error || 'pending'}`).join('\n');
                  setError(details || lastSyncMessage || 'Sync failed');
                }
              }} disabled={syncing} className="px-2 py-1 bg-amber-50 border border-amber-200 rounded-full text-[10px] text-amber-700 font-medium">
                {syncing ? '⟳ Syncing...' : `${pendingCount} pending — sync`}
              </button>
              <button onClick={async () => { if (confirm('Clear all pending operations? They will not be synced.')) { await clearQueue(); setSuccess('Queue cleared'); } }} className="px-1.5 py-1 bg-red-50 border border-red-200 rounded-full text-[10px] text-red-600 font-medium">
                ✕
              </button>
            </div>
          )}
        </div>
      </div>}

      {/* Offline Banner */}
      {!hideHeader && !online && <div className="mx-4 mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-700 flex items-center gap-2"><span>📡</span> Working offline — operations queued for sync</div>}

      {/* Success / error / warning all surface as toast popups (2026-05-25).
          Inline banners removed — see the useEffect block above where success,
          error, equipmentGroupSyncWarning, and batchCacheError all fan out to
          toast.error / toast.success. */}
      {batchCacheError && online && (
        <div className="mx-4 mt-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 flex items-center justify-between gap-3">
          <span>⚠ Offline pre-cache failed. New filters may not work offline. {batchCacheError}</span>
          <button onClick={manualRecache} disabled={recaching} className="px-3 py-1 bg-amber-100 hover:bg-amber-200 disabled:opacity-50 rounded-lg text-xs font-semibold whitespace-nowrap">
            {recaching ? 'Re-caching…' : 'Retry'}
          </button>
        </div>
      )}
      {rfidError && view === 'stage' && (
        <div className="mx-4 mt-2 px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800 flex items-center justify-between gap-3">
          <span>📡 RFID reader: {rfidError}. You can still type/scan manually into the input.</span>
          <button
            onClick={async () => {
              setRfidError(null);
              const { reconnectRfid } = await import('@/lib/rfid-bridge');
              const r = await reconnectRfid();
              if (!r.ok) setRfidError(r.error ?? 'reconnect failed');
              else setSuccess('RFID reader reconnected');
            }}
            className="px-3 py-1 bg-amber-100 hover:bg-amber-200 rounded-lg text-xs font-semibold whitespace-nowrap">
            Reconnect
          </button>
        </div>
      )}
      {/* Stage interlock — paused awaiting QA approval (server already removed the
          advance action; this explains why). */}
      {interlock?.blocksLeaving && view === 'stage' && (
        <div className="mx-4 mt-2 px-4 py-3 bg-amber-50 border border-amber-300 rounded-xl text-sm text-amber-800 flex items-start gap-2">
          <span className="text-base leading-none">🛡️</span>
          <div>
            <div className="font-semibold">{interlockStageLabel(interlock.stageKey)} awaiting QA approval</div>
            <div className="text-amber-700 mt-0.5 text-[13px]">
              {interlock.status === 'REJECTED'
                ? 'Rejected — the filter has been sent back for re-cleaning.'
                : `${interlock.approverRole ?? 'An approver'} must verify and approve before this filter can continue.`}
            </div>
          </div>
        </div>
      )}
      {/* RFID debug overlay — shows every keydown the WebView receives so
          operators can verify whether UKB-mode keystrokes are arriving.
          Tap the floating button bottom-right to toggle. */}
      <button
        onClick={() => setRfidDebugVisible(v => !v)}
        className="fixed bottom-4 right-4 z-[60] w-10 h-10 rounded-full bg-slate-800/80 text-white text-xs font-bold shadow-lg active:bg-slate-700"
        title="Toggle RFID debug"
      >
        {rfidDebugVisible ? '✕' : 'ⓘ'}
      </button>
      {rfidDebugVisible && (
        <div className="fixed bottom-16 right-4 z-[60] w-80 max-h-96 bg-slate-900/95 text-emerald-300 text-[11px] font-mono rounded-xl shadow-2xl border border-slate-700 overflow-hidden flex flex-col">
          <div className="flex items-center justify-between px-3 py-2 border-b border-slate-700 bg-slate-800/60">
            <span className="text-slate-300 font-bold">RFID DEBUG ({rfidDebug.length})</span>
            <button onClick={() => setRfidDebug([])} className="text-amber-400 underline">clear</button>
          </div>
          <div className="overflow-y-auto p-2 space-y-0.5">
            {rfidDebug.length === 0 ? (
              <div className="text-slate-500 italic">Waiting for keystrokes… trigger the RFID reader now.</div>
            ) : (
              rfidDebug.map((line, i) => <div key={i}>{line}</div>)
            )}
          </div>
        </div>
      )}
      {/* Error banner removed 2026-05-25 — error surfaces via toast.error()
          popup in the useEffect above so it's visible from any view. Keeping
          this comment in case the inline banner is restored later. */}
      {/* equipmentGroupSyncWarning inline banner removed 2026-05-25 —
          replaced by toast.error popup in the useEffect above. Same content,
          better visibility from any view. */}

      {/* ─── CONTENT ─── */}
      <div className="flex-1 overflow-y-auto">

        {/* ═══ HOME VIEW ═══ */}
        {view === 'home' && !reasonDialog && !equipDialog && !checklistDialog && (
          <div className="p-4 space-y-4">
            {/* Status Card */}
            {hasFeature('filter_status') && <button onClick={() => setView('status')} className="w-full bg-white rounded-2xl border border-slate-200 p-5 shadow-sm active:shadow-none active:bg-slate-50 transition-all">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-lg shadow-cyan-500/20">
                    <span className="text-2xl">📊</span>
                  </div>
                  <div className="text-left">
                    <div className="text-base font-bold text-slate-800">Filter Status</div>
                    <div className="text-xs text-slate-400">{allFilters.length} total filters</div>
                  </div>
                </div>
                <svg className="w-5 h-5 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {STAGES.slice(0, 3).map(s => (
                  <div key={s.key} className={`${s.bg} ${s.border} border rounded-lg px-2 py-1.5 text-center`}>
                    <div className={`text-lg font-bold ${s.text}`}>{stageCounts[s.key] ?? 0}</div>
                    <div className="text-[9px] text-slate-500">{s.label}</div>
                  </div>
                ))}
              </div>
            </button>}

            {/* Quick access: My Tasks + Approvals */}
            {(hasFeature('my_tasks') || hasFeature('approvals')) && (
            <div className="grid grid-cols-2 gap-3">
              {hasFeature('my_tasks') && (
              <button onClick={() => setView('my-tasks')} className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm active:shadow-none active:scale-[0.98] transition-all text-left">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-teal-500 to-cyan-600 flex items-center justify-center mb-3 shadow-lg shadow-cyan-500/20">
                  <span className="text-2xl">🎯</span>
                </div>
                <div className="text-sm font-bold text-slate-800">My Tasks</div>
                <div className="text-xs text-slate-400 mt-0.5">Filters due for cleaning</div>
              </button>
              )}
              {hasFeature('approvals') && (
              <button onClick={() => setView('approvals')} className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm active:shadow-none active:scale-[0.98] transition-all text-left">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center mb-3 shadow-lg shadow-amber-500/20">
                  <span className="text-2xl">✅</span>
                </div>
                <div className="text-sm font-bold text-slate-800">Approvals</div>
                <div className="text-xs text-slate-400 mt-0.5">{isApprover ? 'Review requests' : 'Track your requests'}</div>
              </button>
              )}
              {/* Issue #7 fix — Cleaning Cycles tile on mobile */}
              <button onClick={() => setView('cycles')} className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm active:shadow-none active:scale-[0.98] transition-all text-left">
                <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-purple-500 to-indigo-600 flex items-center justify-center mb-3 shadow-lg shadow-indigo-500/20">
                  <span className="text-2xl">📋</span>
                </div>
                <div className="text-sm font-bold text-slate-800">Filter Cleaning Record</div>
                <div className="text-xs text-slate-400 mt-0.5">Recent cycle history</div>
              </button>
            </div>
            )}

            {/* Stage Cards Grid */}
            {hasFeature('filter_cleaning') && (
            <div className="grid grid-cols-2 gap-3">
              {STAGES.map(stage => (
                <button key={stage.key} onClick={() => openStage(stage)}
                  className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm active:shadow-none active:scale-[0.98] transition-all text-left">
                  <div className={`w-14 h-14 rounded-2xl bg-gradient-to-br ${stage.gradient} flex items-center justify-center mb-3 shadow-lg shadow-slate-300/30`}>
                    <span className="text-3xl">{stage.icon}</span>
                  </div>
                  <div className="text-sm font-bold text-slate-800">{stage.label}</div>
                  <div className="text-xs text-slate-400 mt-0.5">{stageCounts[stage.key] ?? 0} filter(s)</div>
                </button>
              ))}
            </div>
            )}

            {/* Logout */}
            {hasFeature('logout') && (
            <button onClick={logout} className="w-full py-3 bg-white border border-red-200 rounded-2xl text-sm font-medium text-red-600 active:bg-red-50 flex items-center justify-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
              Logout
            </button>
            )}

            {/* Recent */}
            {recentOps.length > 0 && (
              <div className="space-y-1">
                <h3 className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider px-1">Recent Operations</h3>
                {recentOps.slice(0, 5).map((op, i) => (
                  <div key={i} className="flex items-center justify-between bg-white border border-slate-200 rounded-xl px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="text-sm">{STAGES.find(s => s.key === op.stage)?.icon ?? '⚙️'}</span>
                      <span className="text-xs text-slate-700 font-medium">{op.filter}</span>
                    </div>
                    <span className="text-[10px] text-slate-400">{op.time} {op.queued ? '⏳' : ''}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══ STATUS VIEW ═══ */}
        {view === 'status' && (
          <div className="p-4 space-y-4">
            <h2 className="text-lg font-bold text-slate-800">Filter Status</h2>
            <div className="grid grid-cols-2 gap-3">
              {STAGES.map(s => (
                <div key={s.key} className={`bg-white border ${s.border} rounded-xl p-4`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-lg">{s.icon}</span>
                    <span className="text-xs font-semibold text-slate-600">{s.label}</span>
                  </div>
                  <div className={`text-2xl font-bold ${s.text}`}>{stageCounts[s.key] ?? 0}</div>
                </div>
              ))}
            </div>
            <div className="space-y-2">
              <h3 className="text-sm font-semibold text-slate-600">All Filters ({allFilters.length})</h3>
              {allFilters.map((f: any) => {
                const stageInfo = STAGES.find(s => s.key === f.currentLifecycleState);
                return (
                  <div key={f.id} className="bg-white border border-slate-200 rounded-xl px-4 py-3 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-medium text-slate-800">{f.name}</div>
                      {f.filterSet && <span className="text-[10px] text-slate-400">Set {f.filterSet.replace('SET_', '')}</span>}
                    </div>
                    <span className={`text-[10px] px-2.5 py-1 rounded-full border font-medium ${stageInfo ? `${stageInfo.bg} ${stageInfo.text} ${stageInfo.border}` : 'bg-slate-50 text-slate-400 border-slate-200'}`}>
                      {f.currentLifecycleState?.replace(/_/g, ' ') ?? 'To Be Cleaned'}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ═══ MY TASKS VIEW ═══ */}
        {view === 'my-tasks' && (
          <div className="p-4 space-y-4">
            <div>
              <h2 className="text-lg font-bold text-slate-800">My Tasks</h2>
              <p className="text-xs text-slate-500 mt-0.5">AHUs currently due for cleaning based on PM schedules</p>
            </div>

            {!online && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center text-xs text-slate-500">
                My Tasks requires an internet connection.
              </div>
            )}

            {online && dueTasksLoading && (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, i) => (
                  <div key={i} className="bg-white border border-slate-200 rounded-2xl h-24 animate-pulse" />
                ))}
              </div>
            )}

            {!dueTasksLoading && (!tasksSource?.tasks?.length && !tasksSource?.overdue?.length) && (
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="h-1.5 bg-gradient-to-r from-teal-400 to-cyan-500" />
                <div className="p-10 text-center">
                  <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-teal-50 to-cyan-50 flex items-center justify-center">
                    <span className="text-3xl">🎯</span>
                  </div>
                  <div className="text-sm font-semibold text-slate-700">Nothing due right now</div>
                  <div className="text-xs text-slate-400 mt-1">Tasks appear when a schedule window opens</div>
                </div>
              </div>
            )}

            {(tasksSource?.tasks ?? []).map((task: any) => {
              const expanded = expandedTasks.has(task.entryId);
              const statusColor =
                task.overallStatus === 'complete' ? { bar: 'from-emerald-400 to-emerald-500', badge: 'bg-emerald-50 text-emerald-700 border-emerald-100', dot: 'bg-emerald-500' }
                : task.overallStatus === 'in_progress' ? { bar: 'from-cyan-400 to-cyan-500', badge: 'bg-cyan-50 text-cyan-700 border-cyan-100', dot: 'bg-cyan-500' }
                : { bar: 'from-amber-400 to-amber-500', badge: 'bg-amber-50 text-amber-700 border-amber-100', dot: 'bg-amber-500' };
              const progressPct = task.totalFilters > 0 ? Math.round((task.cleanedCount / task.totalFilters) * 100) : 0;
              return (
                <div key={task.entryId} className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className={`h-1.5 bg-gradient-to-r ${statusColor.bar}`} />
                  <div className="p-4">
                    <button onClick={() => toggleTaskExpand(task.entryId)} className="w-full text-left">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <h3 className="text-base font-bold text-slate-800 truncate">{task.ahuName}</h3>
                            <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold border ${statusColor.badge}`}>
                              <span className={`w-1 h-1 rounded-full ${statusColor.dot}`} />
                              {task.overallStatus === 'complete' ? 'Complete' : task.overallStatus === 'in_progress' ? 'In Progress' : 'Pending'}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-500 mt-1">
                            {formatTime(new Date(task.plannedDate))} • {task.cleanedCount}/{task.totalFilters} cleaned
                          </div>
                          {task.totalFilters > 0 && (
                            <div className="mt-2 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                              <div className="h-full bg-gradient-to-r from-teal-400 to-cyan-500 transition-all" style={{ width: `${progressPct}%` }} />
                            </div>
                          )}
                        </div>
                        <svg className={`w-5 h-5 text-slate-400 shrink-0 transition-transform ${expanded ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                        </svg>
                      </div>
                    </button>

                    {expanded && (
                      <div className="mt-3 pt-3 border-t border-slate-100">
                        {task.filters.length === 0 ? (
                          <p className="text-[11px] text-slate-400 italic">No active child filters.</p>
                        ) : (
                          <div className="flex flex-wrap gap-1.5">
                            {task.filters.map((f: any) => {
                              const cls =
                                f.status === 'cleaned_in_window' ? 'bg-emerald-50 text-emerald-700 border-emerald-100'
                                : f.status === 'in_progress' ? 'bg-cyan-50 text-cyan-700 border-cyan-100'
                                : 'bg-amber-50 text-amber-700 border-amber-100';
                              // C4 (2026-07-10): show the filter's cleaning status as a
                              // readable label, not just the pill colour.
                              const statusLabel =
                                f.status === 'cleaned_in_window' ? 'Cleaned'
                                : f.status === 'in_progress' ? 'In progress'
                                : 'Pending';
                              // 2026-07-10: also show WHICH cleaning stage the filter is
                              // currently in (Wash In / Wash Out / Dry In / …). Resolve via
                              // the shared STAGES catalog so only a REAL cleaning stage shows
                              // — lifecycle markers like CLEANING_CYCLE_COMPLETED / idle
                              // (which aren't in STAGES) resolve to null and are omitted.
                              const stageLabel = f.currentStage
                                ? (STAGES.find((s: any) => s.key === f.currentStage)?.label ?? null)
                                : null;
                              return (
                                <span key={f.filterId} className={`inline-flex items-center gap-1 text-[10px] px-2 py-1 rounded-md border font-semibold ${cls}`}>
                                  {f.filterName}
                                  {stageLabel && <span className="font-normal opacity-70">· {stageLabel}</span>}
                                  <span className="font-normal opacity-70">· {statusLabel}</span>
                                </span>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}

                    {task.overallStatus === 'complete' ? (
                      <div className="mt-3 w-full py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl text-sm font-semibold text-center flex items-center justify-center gap-2">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                        </svg>
                        Completed
                      </div>
                    ) : (
                      <button
                        onClick={() => performTask(task)}
                        className="mt-3 w-full py-2.5 bg-gradient-to-r from-teal-600 to-cyan-600 text-white rounded-xl text-sm font-semibold shadow-lg shadow-cyan-500/25 active:shadow-none"
                      >
                        Perform →
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {(tasksSource?.overdue ?? []).length > 0 && (
              <div className="space-y-3 pt-2">
                <div className="flex items-center gap-2">
                  <span className="text-rose-600 text-sm">⚠</span>
                  <h3 className="text-sm font-bold text-slate-800">Overdue</h3>
                </div>
                {((tasksSource?.overdue ?? []) as any[]).map((task: any) => (
                  <div key={task.entryId} className="bg-white border border-rose-200 rounded-2xl overflow-hidden shadow-sm">
                    <div className="h-1.5 bg-gradient-to-r from-rose-400 to-rose-500" />
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <h3 className="text-base font-bold text-slate-800 truncate">{task.ahuName}</h3>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Window closed {formatTime(new Date(task.windowEnd))} • {task.cleanedCount}/{task.totalFilters} cleaned
                          </div>
                        </div>
                        <span className="inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold border bg-rose-50 text-rose-700 border-rose-100">
                          <span className="w-1 h-1 rounded-full bg-rose-500" />
                          Overdue
                        </span>
                      </div>
                      <button
                        onClick={() => performTask(task)}
                        className="mt-3 w-full py-2.5 bg-gradient-to-r from-rose-600 to-rose-700 text-white rounded-xl text-sm font-semibold shadow-lg shadow-rose-500/25 active:shadow-none"
                      >
                        Perform (overdue) →
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ═══ APPROVALS VIEW ═══ */}
        {view === 'approvals' && (
          <div className="p-4 space-y-4">
            <div>
              <h2 className="text-lg font-bold text-slate-800">Approvals</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                {isApprover ? 'Review and act on pending block change requests' : 'Track the status of requests you submitted'}
              </p>
            </div>

            {/* Status filter pills */}
            {online && (
              <div className="bg-slate-100 rounded-xl p-1 flex gap-1 overflow-x-auto">
                {(['ALL', 'PENDING', 'APPROVED', 'REJECTED'] as const).map(opt => (
                  <button
                    key={opt}
                    onClick={() => setApprovalsFilter(opt)}
                    className={`flex-1 min-w-[70px] px-3 py-1.5 rounded-lg text-[11px] font-semibold transition-colors ${
                      approvalsFilter === opt
                        ? 'bg-white text-cyan-700 shadow-sm'
                        : 'text-slate-500 active:bg-slate-200'
                    }`}
                  >
                    {opt === 'ALL' ? 'All' : opt[0] + opt.slice(1).toLowerCase()}
                  </button>
                ))}
              </div>
            )}

            {!online && (
              <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center text-xs text-slate-500">
                Approvals requires an internet connection.
              </div>
            )}

            {online && approvalsLoading && (
              <div className="space-y-3">
                {Array.from({ length: 2 }).map((_, i) => (
                  <div key={i} className="bg-white border border-slate-200 rounded-2xl h-32 animate-pulse" />
                ))}
              </div>
            )}

            {online && !approvalsLoading && approvals.length === 0 && stageApprovals.length === 0 && (
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="h-1.5 bg-gradient-to-r from-amber-400 to-orange-500" />
                <div className="p-10 text-center">
                  <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 flex items-center justify-center">
                    <span className="text-3xl">✅</span>
                  </div>
                  <div className="text-sm font-semibold text-slate-700">
                    {approvalsFilter === 'ALL'
                      ? (isApprover ? 'No requests' : 'No requests submitted yet')
                      : `No ${approvalsFilter.toLowerCase()} requests`}
                  </div>
                  <div className="text-xs text-slate-400 mt-1">
                    {isApprover ? 'Change the filter above to see other statuses' : 'Block change requests you submit will appear here'}
                  </div>
                </div>
              </div>
            )}

            {online && approvals.map((req: any) => {
              const processing = processingApproval === req.id;
              // Per-status styling — each DB status gets its own badge + accent
              const statusMeta =
                req.status === 'APPROVED'
                  ? { label: 'Approved', badge: 'bg-emerald-50 text-emerald-700 border-emerald-100', dot: 'bg-emerald-500', bar: 'from-emerald-400 to-emerald-500' }
                : req.status === 'REJECTED'
                  ? { label: 'Rejected', badge: 'bg-rose-50 text-rose-700 border-rose-100',        dot: 'bg-rose-500',    bar: 'from-rose-400 to-rose-500' }
                : req.status === 'EXPIRED'
                  ? { label: 'Used',     badge: 'bg-slate-100 text-slate-600 border-slate-200',    dot: 'bg-slate-400',   bar: 'from-slate-400 to-slate-500' }
                  : { label: 'Pending',  badge: 'bg-amber-50 text-amber-700 border-amber-100',     dot: 'bg-amber-500',   bar: 'from-amber-400 to-orange-500' };
              return (
                <div key={req.id} className="bg-white border border-slate-200 rounded-2xl overflow-hidden shadow-sm">
                  <div className={`h-1.5 bg-gradient-to-r ${statusMeta.bar}`} />
                  <div className="p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <h3 className="text-base font-bold text-slate-800 truncate">{req.filterName}</h3>
                        <div className="text-[11px] text-slate-400 mt-0.5">
                          Requested by {req.requestedByName ?? req.requestedBy} • {req.createdAt ? formatTime(new Date(req.createdAt)) : ''}
                        </div>
                      </div>
                      <span className={`inline-flex items-center gap-1 text-[10px] px-2 py-0.5 rounded-full font-semibold border ${statusMeta.badge}`}>
                        <span className={`w-1 h-1 rounded-full ${statusMeta.dot}`} />
                        {statusMeta.label}
                      </span>
                    </div>

                    <div className="bg-slate-50 rounded-xl p-3 text-xs space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500 w-16">From:</span>
                        <span className="font-semibold text-slate-700">{req.fromBlockName}</span>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="text-slate-500 w-16">To:</span>
                        <span className="font-semibold text-cyan-700">{req.toBlockName}</span>
                      </div>
                      {req.reason && (
                        <div className="flex items-start gap-2 pt-1">
                          <span className="text-slate-500 w-16">Reason:</span>
                          <span className="text-slate-600 flex-1">{req.reason}</span>
                        </div>
                      )}
                      {/* Surface approval/rejection metadata when present */}
                      {(req.status === 'APPROVED' || req.status === 'REJECTED') && (req.processedByName || req.processedAt) && (
                        <div className="flex items-start gap-2 pt-1 border-t border-slate-200 mt-2">
                          <span className="text-slate-500 w-16">{req.status === 'APPROVED' ? 'Approved by:' : 'Rejected by:'}</span>
                          <span className="text-slate-600 flex-1">
                            {req.processedByName ?? '—'}
                            {req.processedAt ? ` • ${formatTime(new Date(req.processedAt))}` : ''}
                          </span>
                        </div>
                      )}
                      {req.processedComment && (
                        <div className="flex items-start gap-2 pt-1">
                          <span className="text-slate-500 w-16">Comment:</span>
                          <span className="text-slate-600 flex-1 italic">{req.processedComment}</span>
                        </div>
                      )}
                    </div>

                    {/* Only show Approve/Reject for rows that are still pending */}
                    {isApprover && req.status === 'PENDING' && (
                      <div className="space-y-2">
                        <input
                          className="w-full bg-slate-50 border border-slate-200 rounded-xl px-3 py-2 text-xs text-slate-700 placeholder:text-slate-400 focus:border-cyan-400 outline-none"
                          placeholder="Comment (required) *"
                          value={processingApproval === req.id ? approvalComment : ''}
                          onChange={e => { setProcessingApproval(req.id); setApprovalComment(e.target.value); }}
                        />
                        <div className="flex gap-2">
                        <button
                          onClick={() => handleApprovalAction(req.id, 'reject')}
                          disabled={processing || !(processingApproval === req.id && approvalComment.trim())}
                          className="flex-1 py-2.5 bg-white border border-rose-200 text-rose-700 rounded-xl text-sm font-semibold active:bg-rose-50 disabled:opacity-50"
                        >
                          {processing ? '…' : 'Reject'}
                        </button>
                        <button
                          onClick={() => handleApprovalAction(req.id, 'approve')}
                          disabled={processing || !(processingApproval === req.id && approvalComment.trim())}
                          className="flex-1 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-xl text-sm font-semibold shadow-lg shadow-emerald-500/25 active:shadow-none disabled:opacity-50"
                        >
                          {processing ? '…' : 'Approve'}
                        </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
            {/* C3 (2026-07-10): Stage Approvals (interlock QA) — READ-ONLY on the
                tablet, honoring the same status filter. Approve/reject is done on
                the desktop. */}
            {online && stageApprovals.length > 0 && (
              <div className="space-y-2">
                <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Stage Approvals · QA</h3>
                {stageApprovals.map((sa: any) => {
                  const st = sa.status === 'APPROVED'
                    ? { label: 'Approved', badge: 'bg-emerald-50 text-emerald-700 border-emerald-100' }
                    : sa.status === 'REJECTED'
                    ? { label: 'Rejected', badge: 'bg-rose-50 text-rose-700 border-rose-100' }
                    : { label: 'Pending', badge: 'bg-amber-50 text-amber-700 border-amber-100' };
                  return (
                    <div key={sa.id} className="bg-white border border-slate-200 rounded-xl px-4 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium text-slate-800 truncate">{sa.detailsSnapshot?.filterName ?? sa.filterId}</span>
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border shrink-0 ${st.badge}`}>{st.label}</span>
                      </div>
                      <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>Stage: {interlockStageLabel(sa.stageKey)}</span>
                        {sa.requestedByName && <span>By: {sa.requestedByName}</span>}
                        {sa.status !== 'PENDING' && sa.decidedByName && <span>{sa.status === 'APPROVED' ? 'Approved' : 'Rejected'} by {sa.decidedByName}</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ═══ CLEANING CYCLES VIEW (Issue #7) ═══ */}
        {view === 'cycles' && (
          <div className="p-4 space-y-3">
            <div>
              <h2 className="text-lg font-bold text-slate-800">Filter Cleaning Record</h2>
              <p className="text-xs text-slate-500 mt-0.5">Recent cycles · {cyclesList.length}</p>
            </div>
            {!online && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700">
                Offline — showing last cached snapshot. Reconnect to refresh.
              </div>
            )}
            {online && cyclesLoading && (
              <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="bg-white border border-slate-200 rounded-2xl h-24 animate-pulse" />
              ))}</div>
            )}
            {cyclesList.length === 0 && !cyclesLoading && (
              <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-slate-500">
                No cleaning cycles yet.
              </div>
            )}
            {cyclesList.map((cyc: any) => {
              const isExpanded = expandedCycle === cyc.id;
              const statusBadge =
                cyc.status === 'COMPLETED' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' :
                cyc.status === 'TERMINATED' ? 'bg-rose-50 text-rose-700 border-rose-200' :
                'bg-blue-50 text-blue-700 border-blue-200';
              const durSec = cyc.completedAt
                ? Math.max(0, Math.floor((new Date(cyc.completedAt).getTime() - new Date(cyc.startedAt).getTime()) / 1000))
                : Math.max(0, Math.floor((Date.now() - new Date(cyc.startedAt).getTime()) / 1000));
              const durLabel = durSec >= 3600
                ? `${Math.floor(durSec / 3600)}h ${Math.floor((durSec % 3600) / 60)}m`
                : `${Math.floor(durSec / 60)}m ${durSec % 60}s`;
              const events = (cyc.events ?? []) as any[];
              return (
                <button key={cyc.id} onClick={() => setExpandedCycle(isExpanded ? null : cyc.id)}
                  className="w-full bg-white rounded-2xl border border-slate-200 p-3 shadow-sm active:bg-slate-50 text-left">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-bold text-slate-800 truncate">{cyc.filter?.name ?? cyc.filterName ?? cyc.cycleCode}</div>
                      <div className="text-[11px] text-slate-400 truncate">{cyc.cycleCode}</div>
                    </div>
                    <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${statusBadge}`}>
                      {cyc.status === 'IN_PROGRESS' ? 'In Progress' : cyc.status === 'COMPLETED' ? 'Completed' : 'Terminated'}
                    </span>
                  </div>
                  <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                    <div>
                      <div className="text-slate-400">Started</div>
                      <div className="text-slate-700 font-medium">{formatTime(new Date(cyc.startedAt))}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">Duration</div>
                      <div className="text-slate-700 font-medium">{durLabel}</div>
                    </div>
                    <div>
                      <div className="text-slate-400">Reason</div>
                      <div className="text-slate-700 font-medium truncate">{cyc.cleaningReasonLabel ?? '-'}</div>
                    </div>
                  </div>
                  {isExpanded && events.length > 0 && (
                    <div className="mt-3 pt-3 border-t border-slate-100 space-y-1.5">
                      {events.map((e: any, i: number) => (
                        <div key={e.id ?? i} className="flex items-center justify-between text-[11px] gap-2">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className="text-slate-400 shrink-0">{formatTime(new Date(e.performedAt))}</span>
                            <span className="font-medium text-slate-700 truncate">
                              {e.eventType === 'STATE_TRANSITION'
                                ? (e.fromState ? `${e.fromState.replace(/_/g, ' ')} → ${e.toState?.replace(/_/g, ' ')}` : (e.toState ? `To Be Cleaned → ${e.toState.replace(/_/g, ' ')}` : 'transition'))
                                : e.eventType.replace(/_/g, ' ').toLowerCase()}
                            </span>
                          </div>
                          {(e.attributes as any)?.action && (
                            <span className="text-[10px] text-slate-400 truncate">{(e.attributes as any).action.replace(/_/g, ' ').toLowerCase()}</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </button>
              );
            })}
          </div>
        )}

        {/* ═══ STAGE OPERATION VIEW ═══ */}
        {view === 'stage' && activeStage && !reasonDialog && !equipDialog && !checklistDialog && (
          <div className="p-4 space-y-4">
            <div className={`bg-gradient-to-br ${activeStage.gradient} rounded-2xl p-5 shadow-lg`}>
              <div className="flex items-center gap-3">
                <span className="text-4xl">{activeStage.icon}</span>
                <div>
                  <div className="text-xl font-bold text-white">{activeStage.label}</div>
                  <div className="text-white/70 text-sm">{stageCounts[activeStage.key] ?? 0} filter(s) in this stage</div>
                </div>
              </div>
            </div>

            {/* Block Selection */}
            {activeStage.needsBlock && !selectedBlock && (
              <div className="space-y-2">
                <h3 className="text-sm font-semibold text-slate-600">Select Block</h3>
                <div className="grid grid-cols-2 gap-2">
                  {blocks.map((b: any) => (
                    <button key={b.id} onClick={() => setSelectedBlock(b)}
                      className="bg-white border-2 border-slate-200 rounded-xl p-3 text-left active:border-cyan-500 active:bg-cyan-50 transition-colors">
                      <div className="text-sm font-semibold text-slate-700">{b.name}</div>
                    </button>
                  ))}
                  {/*
                    "Skip Block" is intentionally disabled for needsBlock: true stages.
                    Allowing it would set selectedBlock.id = null and bypass the offline
                    home-block vs current-block validation — non-compliant with 21 CFR Part 11
                    because a filter could then be advanced in any block without approval.
                  */}
                </div>
              </div>
            )}

            {/* Scan + Submit */}
            {(!activeStage.needsBlock || selectedBlock) && (
              <div className="space-y-3">
                {selectedBlock && (
                  <div className="flex items-center justify-between bg-cyan-50 border border-cyan-200 rounded-xl px-3 py-2">
                    <span className="text-xs text-cyan-700 font-medium">Block: {selectedBlock.name}</span>
                    <button onClick={() => {
                      // B7.4 follow-up (Issue #1): clear the equipment-group
                      // sync advisory when operator switches block intra-stage.
                      // The advisory is bound to the previously scanned filter
                      // and would leak onto the next scan view until the next
                      // current-state response replaces it. goHome already
                      // clears this; the in-place block change must too.
                      setEquipmentGroupSyncWarning(null);
                      setSelectedBlock(null);
                    }} className="text-[10px] text-cyan-600 underline">Change</button>
                  </div>
                )}

                <div className="flex gap-2">
                  {/* 2026-05-20: scan field is RFID-only — no manual text
                      entry. readOnly prevents the on-screen keyboard from
                      surfacing on tap AND blocks pasted/typed input from
                      appearing in the field. The global RFID-burst handler
                      above still writes the EPC into scanValue via
                      setScanValue (React state update bypasses readOnly).
                      The +Add button is gone — RFID auto-flush + Enter/Tab
                      submit are the only paths into the queue. */}
                  <input ref={scanInputRef} type="text" value={scanValue} readOnly
                    onBlur={() => {
                      setTimeout(() => {
                        const ae = document.activeElement;
                        if (!ae || ae === document.body) focusScanInput();
                      }, 50);
                    }}
                    placeholder="Scan RFID tag..."
                    data-rfid="true"
                    className="flex-1 bg-white border-2 border-slate-200 rounded-2xl px-4 py-4 text-base text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500 shadow-sm cursor-default" autoFocus />
                </div>

                {/* Scan Queue */}
                {scanQueue.length > 0 && (
                  <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-1.5">
                    <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Queue ({scanQueue.length})</div>
                    {scanQueue.map(q => (
                      <div key={q.filterId} className="flex items-center justify-between gap-2 py-1.5 px-2 bg-slate-50 rounded-lg">
                        <span className="text-sm font-medium text-slate-700 min-w-0 flex-1">
                          {q.filterName}
                          {q.ahuName && (
                            <span className="ml-2 text-xs font-normal text-slate-500">· {q.ahuName}</span>
                          )}
                        </span>
                        {/* 2026-05-20: per-filter dryer duration selector. Only
                            rendered on DRY_IN stage; the operator picks a value
                            for each filter, then Submit All iterates with
                            per-filter durations. Default 30 min set in
                            handleAddToQueue. */}
                        {activeStage?.key === 'DRY_IN' && (
                          <select
                            value={dryerDurations[q.filterId] ?? 30}
                            onChange={e => setDryerDurations(prev => ({ ...prev, [q.filterId]: Number(e.target.value) }))}
                            className="bg-white border border-slate-300 rounded-md px-2 py-1 text-xs text-slate-700 shrink-0"
                          >
                            {[5, 10, 15, 30, 45, 60, 90, 120, 180, 240].map(m => (
                              <option key={m} value={m}>{m} min</option>
                            ))}
                          </select>
                        )}
                        <button onClick={() => removeFromQueue(q.filterId)} className="text-red-400 text-xs hover:text-red-600 shrink-0">Remove</button>
                      </div>
                    ))}
                  </div>
                )}

                <textarea value={remarks} onChange={e => setRemarks(e.target.value)} placeholder="Remarks (optional)" rows={2}
                  className="w-full bg-white border border-slate-200 rounded-xl px-4 py-3 text-sm text-slate-700 placeholder:text-slate-400 focus:outline-none focus:border-cyan-500" />

                {/* 2026-05-20: tablet now ALWAYS queues on scan — no single-
                    scan auto-submit. Operator can scan multiple filters and
                    confirm the queue before submitting all. The "Submit"
                    button is disabled until at least one filter is queued. */}
                <button onClick={handleSubmitQueue} disabled={loading || scanQueue.length === 0}
                  className={`w-full py-4 bg-gradient-to-r ${activeStage.gradient} text-white rounded-2xl font-bold text-base disabled:opacity-40 active:opacity-90 flex items-center justify-center gap-2 shadow-lg`}>
                  {loading
                    ? <><div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /><span>Submitting{scanQueue.length > 0 ? ` ${scanQueue.length} filter${scanQueue.length === 1 ? '' : 's'}` : ''}…</span></>
                    : <>✓ Submit {scanQueue.length > 0 ? `All (${scanQueue.length})` : ''}</>}
                </button>
              </div>
            )}

            {/* Currently Drying Panel — shows filters with active dryer timers */}
            {activeStage.key === 'DRY_IN' && selectedBlock && (() => {
              // Scope to the selected block (rows carry parentId = their AHU).
              const dryingFilters = filtersInBlock(
                allFilters
                  .filter((f: any) => f.currentLifecycleState === 'DRY_IN')
                  .map((f: any) => ({ ...f, ahuId: f.ahuId ?? f.parentId })),
                selectedBlock?.id,
                ahuBlockMap,
              );
              if (dryingFilters.length === 0) return null;
              return (
                <div className="bg-white border border-amber-200 rounded-2xl overflow-hidden">
                  <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-4 py-2.5">
                    <h3 className="text-sm font-bold text-white">Currently Drying ({dryingFilters.length})</h3>
                  </div>
                  <div className="divide-y divide-slate-100">
                    {dryingFilters.map((f: any) => (
                      <DryingFilterCard
                        key={f.id}
                        filterId={f.id}
                        filterName={f.name}
                        online={online}
                        getCache={getCache}
                        executeOrQueue={executeOrQueue}
                        onSuccess={(msg) => { setSuccess(msg); mutate('/api/assets/instances'); refreshOfflineData(); }}
                        onError={setError}
                      />
                    ))}
                  </div>
                </div>
              );
            })()}

            {/* Stage Recent — split into Success / Failure (B3/C2), all shown (no 20 cap) */}
            {(() => {
              const stageOps = recentOps.filter(op => op.stage === activeStage.key);
              if (stageOps.length === 0) return null;
              const successOps = stageOps.filter(op => op.status !== 'failed');
              const failureOps = stageOps.filter(op => op.status === 'failed');
              return (
                <div className="space-y-3 mt-2">
                  {successOps.length > 0 && (
                    <div className="space-y-1">
                      <h3 className="text-[10px] font-semibold text-emerald-600 uppercase tracking-wider">Submitted · {successOps.length}</h3>
                      {successOps.map((op, i) => (
                        <div key={`s${i}`} className="flex items-center justify-between bg-white border border-emerald-200 rounded-lg px-3 py-2">
                          <span className="text-xs text-slate-700 font-medium">{op.filter}</span>
                          <span className="text-[10px] text-slate-400">{op.time} {op.queued ? '⏳' : '✓'}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {failureOps.length > 0 && (
                    <div className="space-y-1">
                      <h3 className="text-[10px] font-semibold text-red-600 uppercase tracking-wider">Failed · {failureOps.length}</h3>
                      {failureOps.map((op, i) => (
                        <div key={`f${i}`} className="flex items-start justify-between gap-2 bg-white border border-red-200 rounded-lg px-3 py-2">
                          <div className="min-w-0">
                            <span className="block text-xs text-slate-700 font-medium">{op.filter}</span>
                            {op.msg && <span className="block text-[10px] text-red-500 truncate">{op.msg}</span>}
                          </div>
                          <span className="text-[10px] text-slate-400 shrink-0">{op.time} ✕</span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })()}
          </div>
        )}
      </div>

      {/* ─── DIALOGS ─── */}

      {/* Reason */}
      {reasonDialog && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-end justify-center z-50">
          <div className="bg-white rounded-t-3xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl animate-slide-up">
            <div className="bg-gradient-to-r from-cyan-500 to-blue-600 px-5 py-4 rounded-t-3xl"><h2 className="text-lg font-bold text-white">Cleaning Reason</h2><p className="text-cyan-100 text-sm">{reasonDialog.filterName}</p></div>
            <div className="p-5 space-y-3 overflow-y-auto flex-1">
              {pmReasonDue && (
                <div className="px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-800">
                  This filter is in the <span className="font-semibold">PM schedule</span>. Reason defaults to <span className="font-semibold">PM</span> — confirm to continue, or pick another reason.
                  <span className="block text-xs text-emerald-600 mt-0.5">A non-PM reason leaves this task pending in My Tasks.</span>
                </div>
              )}
              {cleaningReasons.filter((r: any) => r.isActive !== false).map((r: any) => (
                <button key={r.key} onClick={() => setSelectedReason(r.key)} className={`w-full text-left px-4 py-3 rounded-xl border-2 ${selectedReason === r.key ? 'border-cyan-500 bg-cyan-50' : 'border-slate-200'}`}>
                  <div className="text-sm font-medium text-slate-800">{r.name}</div>
                  {r.requiresJustification && <div className="text-[10px] text-amber-600">Requires justification</div>}
                </button>
              ))}
              {cleaningReasons.find((r: any) => r.key === selectedReason)?.requiresJustification && (
                <textarea className="w-full border border-slate-200 rounded-xl px-4 py-2 text-sm" rows={2} placeholder="Justification (min 10 chars)" value={justification} onChange={e => setJustification(e.target.value)} />
              )}
            </div>
            {(() => {
              // Match server contract at start-cycle.ts:78 — block submit when
              // the selected reason has requiresJustification=true unless the
              // operator has typed at least 10 chars. Pre-fix the button was
              // enabled and the server returned 400 JUSTIFICATION_REQUIRED,
              // which use-core.ts then misclassified as "queued" (bug fix 5/25).
              const reason = cleaningReasons.find((r: any) => r.key === selectedReason);
              const needsJustification = !!reason?.requiresJustification;
              const justificationOk = !needsJustification || justification.trim().length >= 10;
              const submitDisabled = loading || !selectedReason || !justificationOk;
              return (
                <div className="p-4 border-t border-slate-200 flex gap-3">
                  <button onClick={() => core.dispatch({ type: 'close' })} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-medium">Cancel</button>
                  <button onClick={handleReasonSubmit} disabled={submitDisabled} className="flex-1 py-3 bg-cyan-600 text-white rounded-xl font-bold disabled:opacity-40">{loading ? 'Starting...' : 'Start'}</button>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* Equipment */}
      {equipDialog && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-end justify-center z-50">
          <div className="bg-white rounded-t-3xl w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl">
            <div className="bg-gradient-to-r from-amber-500 to-orange-500 px-5 py-4 rounded-t-3xl"><h2 className="text-lg font-bold text-white">{equipDialog.stage === 'DRY_IN' ? 'Dryer Temperature' : 'Equipment Readings'}</h2><p className="text-amber-100 text-sm">{equipDialog.filterName}</p></div>
            <div className="p-5 space-y-3 overflow-y-auto flex-1">
              {!equipDialog.cycleGroup && (equipDialog.groups as any[]).map((g: any) => (
                <button key={g.id} onClick={() => { setSelectedEquipGroup(g); setReadings({}); setEquipSource({}); setEquipFetchStatus(''); setEquipPending(new Set()); }} className={`w-full text-left px-4 py-3 rounded-xl border-2 ${selectedEquipGroup?.id === g.id ? 'border-cyan-500 bg-cyan-50' : 'border-slate-200'}`}>
                  <div className="text-sm font-medium text-slate-800">{g.name}</div>
                </button>
              ))}
              {selectedEquipGroup && (() => {
                const stageInsts = (selectedEquipGroup.instruments ?? []).filter((i: any) => i.stageKey === equipDialog.stage);
                // Auto-fetch is online-only. Offline → every instrument reverts to
                // the manual stepped-dropdown (operatingMin/Max + leastCount). P5.
                const isAutoInstrument = (i: any): boolean => i.autoFetchEnabled === true && online;
                const hasAuto = stageInsts.some(isAutoInstrument);
                return (
                  <>
                    {hasAuto && (
                      <button type="button" onClick={handleGetValuesMobile} disabled={equipFetching}
                        className="w-full flex items-center justify-center gap-2 px-3 py-2.5 text-sm font-semibold rounded-xl bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50">
                        {equipFetching ? <div className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>}
                        {equipFetching ? 'Fetching…' : 'Get Values'}
                      </button>
                    )}
                    {hasAuto && equipFetchStatus && <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">{equipFetchStatus}</div>}
                    {stageInsts.map((inst: any) => {
                      const val = readings[inst.id];
                      const src = equipSource[inst.id];
                      const oor = val !== undefined && (val < inst.operatingMin || val > inst.operatingMax);
                      return (
                        <div key={inst.id}>
                          <div className="flex items-center gap-2">
                            <label className="text-sm font-medium text-slate-700">{inst.description} ({inst.uom})</label>
                            {src === 'AUTO' && <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-cyan-50 border border-cyan-200 text-cyan-700">Auto</span>}
                            {src === 'AUTO_OVERRIDDEN' && <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded-full bg-amber-50 border border-amber-200 text-amber-700">Auto · edited</span>}
                          </div>
                          {isAutoInstrument(inst) ? (
                            <input type="number" step="any" inputMode="decimal" value={val ?? ''} onChange={e => setEquipReading(inst.id, e.target.value)}
                              placeholder={equipFetching && equipPending.has(inst.id) ? 'Fetching…' : 'Enter or fetch'}
                              className={`w-full mt-1 border rounded-xl px-4 py-3 text-sm bg-white ${oor ? 'border-amber-400' : 'border-slate-200'}`} />
                          ) : (
                            <select value={val ?? ''} onChange={e => setEquipReading(inst.id, e.target.value)} className="w-full mt-1 border border-slate-200 rounded-xl px-4 py-3 text-sm bg-white">
                              <option value="">Select...</option>{genOpts(inst.operatingMin, inst.operatingMax, inst.leastCount).map(v => <option key={v} value={v}>{formatByLeastCount(v, inst.leastCount)} {inst.uom}</option>)}
                            </select>
                          )}
                          {oor && <div className="mt-1 text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1">Operating range ({formatByLeastCount(inst.operatingMin, inst.leastCount)}–{formatByLeastCount(inst.operatingMax, inst.leastCount)} {inst.uom}) — confirm to submit.</div>}
                        </div>
                      );
                    })}
                  </>
                );
              })()}
            </div>
            <div className="p-4 border-t border-slate-200 flex gap-3"><button onClick={() => core.dispatch({ type: 'close' })} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-medium">Cancel</button><button onClick={handleEquipSubmit} disabled={loading || equipFetching || !selectedEquipGroup || (() => { const insts = (selectedEquipGroup?.instruments ?? []).filter((i: any) => i.stageKey === equipDialog.stage); return insts.length > 0 && insts.some((i: any) => readings[i.id] === undefined); })()} className="flex-1 py-3 bg-amber-500 text-white rounded-xl font-bold disabled:opacity-40">{loading ? 'Submitting...' : 'Submit'}</button></div>
          </div>
        </div>
      )}

      <DryerDurationDialog
        open={!!dryerDialog}
        filterName={dryerDialog?.filterName ?? ''}
        loading={dryerLoading}
        error={dryerError}
        onClose={() => { core.dispatch({ type: 'close' }); setDryerError(''); }}
        onSubmit={handleDryerDurationSubmit}
      />

      {/* Checklist — combined-screen UX (2026-05-25): the readings are
          already submitted server-side at this point; the dialog shows a
          ✓ confirmation banner up top with the stage info + readings recap
          (when available) so the operator sees BOTH on one screen instead
          of perceiving the checklist as an unrelated second step. The
          checklist questions themselves and the Submit button are below. */}
      {checklistDialog && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end justify-center z-50">
          <div className="bg-white rounded-t-3xl w-full max-w-lg max-h-[90vh] flex flex-col shadow-2xl animate-slide-up">
            <div className="bg-gradient-to-r from-purple-600 to-purple-700 px-5 py-4 rounded-t-3xl flex items-center gap-3 shrink-0">
              <svg className="w-6 h-6 text-purple-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
              <div><h2 className="text-lg font-bold text-white">Checklist Required</h2><p className="text-purple-100 text-sm">{checklistDialog.filterName}</p></div>
            </div>
            <div className="p-5 space-y-5 overflow-y-auto flex-1">
              {/* Stage-submitted recap (2026-05-25 combined-screen UX).
                  Only renders when the snapshot was actually captured during
                  the just-completed handleEquipSubmit. Pre-fix this also
                  fell back to `activeStage` which led to a misleading
                  "✓ Wash In submitted" header when the checklist opened
                  from a pending-cycle state where the operator hadn't gone
                  through the reason + equipment + readings dialogs. Now:
                  no recap → no banner. The operator's reason/equip flow
                  fires (via dispatch open_reason / open_equipment) BEFORE
                  the checklist ever auto-opens. */}
              {stageSubmitRecap && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <svg className="w-5 h-5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
                    </svg>
                    <div className="text-sm font-semibold text-emerald-800">
                      {stageSubmitRecap.stage.replace(/_/g, ' ')} submitted
                    </div>
                    <div className="text-[10px] text-emerald-600 ml-auto">{stageSubmitRecap.submittedAt}</div>
                  </div>
                  {stageSubmitRecap.readings.length > 0 ? (
                    <div className="space-y-1">
                      {stageSubmitRecap.readings.map((r, i) => (
                        <div key={i} className="flex justify-between text-xs">
                          <span className="text-emerald-700">{r.description}</span>
                          <span className="font-mono text-emerald-900 font-semibold">{r.value} {r.uom}</span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-xs text-emerald-700">Readings recorded. Please complete the checklist below to finalize this step.</div>
                  )}
                </div>
              )}
              {((checklistDialog.checklists as any[]) ?? []).map((cl: any) => (
                <div key={cl.pipelineNodeId}>
                  <h3 className="text-sm font-semibold text-purple-700 uppercase tracking-wider mb-3">{cl.checklistProfileName}</h3>
                  <div className="space-y-4">
                    {(!Array.isArray(cl.questions) || cl.questions.length === 0) && (
                      <div className="px-4 py-3 bg-amber-50 border border-amber-200 rounded-xl text-sm text-amber-800">
                        Couldn't load this checklist's questions. Reconnect and refresh, then reopen this checklist before submitting.
                      </div>
                    )}
                    {(cl.questions ?? []).map((q: any, qi: number, arr: any[]) => {
                      const prevSection = qi > 0 ? arr[qi - 1].section : null;
                      const showSection = q.section && q.section !== prevSection;
                      const val = checklistAnswers[q.id] ?? '';
                      const setVal = (v: any) => setChecklistAnswers(p => ({ ...p, [q.id]: v }));
                      return (
                        <div key={q.id}>
                          {showSection && <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mt-2 mb-1 border-b border-slate-200 pb-1">{q.section}</div>}
                          <div className="space-y-2">
                            <div className="flex items-start gap-2">
                              <span className="text-slate-400 text-xs font-mono mt-0.5 w-5 shrink-0">{qi + 1}.</span>
                              <div className="flex-1">
                                <p className="text-sm text-slate-700">{q.question}{q.required && <span className="text-red-600 ml-1">*</span>}</p>
                                {q.description && <p className="text-xs text-slate-400 mt-0.5">{q.description}</p>}
                              </div>
                            </div>
                            <div className="ml-7">
                              {q.questionType === 'YES_NO' ? (
                                <div className="flex gap-2">
                                  {['Yes', 'No'].map(opt => <button key={opt} type="button" onClick={() => setVal(opt)} aria-pressed={val === opt} className={`flex-1 py-2.5 rounded-xl text-sm border-2 transition-colors inline-flex items-center justify-center gap-1 ${val === opt ? 'font-bold bg-cyan-600 text-white border-cyan-600' : 'font-medium bg-white text-slate-600 border-slate-200'}`}>{val === opt && <span aria-hidden="true">✓</span>}{opt}</button>)}
                                </div>
                              ) : q.questionType === 'YES_NO_NA' ? (
                                <div className="flex gap-2">
                                  {['Yes', 'No', 'N/A'].map(opt => <button key={opt} type="button" onClick={() => setVal(opt)} aria-pressed={val === opt} className={`flex-1 py-2.5 rounded-xl text-sm border-2 transition-colors inline-flex items-center justify-center gap-1 ${val === opt ? 'font-bold bg-cyan-600 text-white border-cyan-600' : 'font-medium bg-white text-slate-600 border-slate-200'}`}>{val === opt && <span aria-hidden="true">✓</span>}{opt}</button>)}
                                </div>
                              ) : q.questionType === 'PASS_FAIL' ? (
                                <div className="flex gap-2">
                                  {['Pass', 'Fail'].map(opt => <button key={opt} type="button" onClick={() => setVal(opt)} aria-pressed={val === opt} className={`flex-1 py-2.5 rounded-xl text-sm border-2 transition-colors inline-flex items-center justify-center gap-1 ${val === opt ? `font-bold text-white ${opt === 'Pass' ? 'bg-green-600 border-green-600' : 'bg-red-600 border-red-600'}` : 'font-medium bg-white text-slate-600 border-slate-200'}`}>{val === opt && <span aria-hidden="true">✓</span>}{opt}</button>)}
                                </div>
                              ) : q.questionType === 'DROPDOWN' ? (
                                <select value={val} onChange={e => setVal(e.target.value)} className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:border-cyan-500 outline-none">
                                  <option value="">Select...</option>
                                  {(Array.isArray(q.options) ? q.options : []).map((opt: any, i: number) => <option key={i} value={typeof opt === 'string' ? opt : opt.value}>{typeof opt === 'string' ? opt : opt.label}</option>)}
                                </select>
                              ) : q.questionType === 'MULTI_SELECT' ? (
                                <div className="flex flex-wrap gap-2">
                                  {(Array.isArray(q.options) ? q.options : []).map((opt: any, i: number) => {
                                    const optVal = typeof opt === 'string' ? opt : opt.value;
                                    const optLabel = typeof opt === 'string' ? opt : opt.label;
                                    const selected = Array.isArray(val) && val.includes(optVal);
                                    return <button key={i} type="button" aria-pressed={selected} onClick={() => { const arr = Array.isArray(val) ? [...val] : []; setVal(selected ? arr.filter((v: string) => v !== optVal) : [...arr, optVal]); }} className={`px-3 py-2 rounded-xl text-sm border-2 transition-colors inline-flex items-center gap-1 ${selected ? 'font-bold bg-cyan-600 text-white border-cyan-600' : 'font-medium bg-white text-slate-600 border-slate-200'}`}>{selected && <span aria-hidden="true">✓</span>}{optLabel}</button>;
                                  })}
                                </div>
                              ) : q.questionType === 'NUMERIC' ? (
                                <div>
                                  <input type="number" value={val} onChange={e => setVal(e.target.value)}
                                    min={q.validation?.min} max={q.validation?.max} step={q.validation?.leastCount || 'any'}
                                    className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:border-cyan-500 outline-none" placeholder={q.validation?.unit ? `Enter value (${q.validation.unit})` : 'Enter value'} />
                                  {(q.validation?.min !== undefined || q.validation?.max !== undefined) && (
                                    <p className="text-xs text-slate-400 mt-1">Range: {q.validation.min ?? '—'} – {q.validation.max ?? '—'}{q.validation.unit ? ` ${q.validation.unit}` : ''}</p>
                                  )}
                                </div>
                              ) : q.questionType === 'PHOTO' ? (
                                <div>
                                  <input type="file" accept="image/*" capture="environment" onChange={e => {
                                    const file = e.target.files?.[0];
                                    if (!file) return;
                                    const reader = new FileReader();
                                    reader.onload = () => setVal(reader.result as string);
                                    reader.readAsDataURL(file);
                                  }} className="w-full text-sm text-slate-600 file:mr-3 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-medium file:bg-purple-50 file:text-purple-700 hover:file:bg-purple-100" />
                                  {val && typeof val === 'string' && val.startsWith('data:image') && (
                                    <img src={val} alt="Captured" className="mt-2 rounded-xl max-h-32 object-cover border border-slate-200" />
                                  )}
                                </div>
                              ) : q.questionType === 'SIGNATURE' ? (
                                <p className="text-xs text-slate-400 italic">Signature capture not available on tablet — will be collected online</p>
                              ) : (
                                <textarea value={val} onChange={e => setVal(e.target.value)} rows={2}
                                  className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-sm focus:border-cyan-500 outline-none" placeholder="Enter answer" />
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              ))}
              {/* Inline error banner replaced by toast.error() popup (2026-05-25) — see useEffect above. */}
            </div>
            <div className="px-5 pt-3 pb-1 text-[11px] text-slate-500 italic">
              This checklist is mandatory under 21 CFR §11 — closing here will keep the cycle paused. The dialog will reappear on the next scan.
            </div>
            <div className="px-5 py-4 border-t border-slate-200 shrink-0 flex gap-3">
              {/* Renamed Cancel → Close (2026-05-25): operators were treating
                  Cancel as "skip the checklist" — but the server-side gate
                  refuses to advance without it, so the dialog re-opened on
                  next action. "Close" + the hint above makes the contract
                  explicit. dispatch close still actually closes the dialog. */}
              <button onClick={() => { core.dispatch({ type: 'close' }); setPendingBatch(null); setPendingBatchDeferred(null); }} disabled={loading} className="flex-1 py-3 bg-slate-100 text-slate-600 rounded-xl font-medium hover:bg-slate-200 transition-colors disabled:opacity-40">Close</button>
              <button onClick={handleChecklistSubmit} disabled={loading} className="flex-1 py-3 bg-purple-600 text-white rounded-xl font-bold disabled:opacity-40 flex items-center justify-center gap-2 hover:bg-purple-500 transition-colors">
                {loading ? <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <>Submit Checklist</>}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Block Change Request Dialog */}
      {blockChangeDialog && (
        <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl overflow-hidden">
            <div className="h-1.5 bg-gradient-to-r from-amber-500 to-orange-500" />
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
                  <svg className="w-5 h-5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                  </svg>
                </div>
                <div>
                  <h3 className="text-lg font-bold text-slate-800">{blockChangeMode === 'APPROVAL' ? 'Block change approval needed' : 'Cleaning in a different block'}</h3>
                  <p className="text-xs text-slate-400">This filter belongs to another block</p>
                </div>
              </div>
              <div className="space-y-3 mb-5">
                <div className="bg-slate-50 rounded-xl p-3 text-sm">
                  <div className="text-slate-500">Filter: <span className="font-semibold text-slate-800">{blockChangeDialog.filterName}</span></div>
                  <div className="text-slate-500 mt-1">Belongs to: <span className="font-semibold text-slate-800">{blockChangeDialog.homeBlockName}</span></div>
                  <div className="text-slate-500 mt-1">Cleaning in: <span className="font-semibold text-amber-700">{blockChangeDialog.requestedBlockName}</span></div>
                </div>
                {blockChangeMode === 'APPROVAL' ? (
                  <div>
                    <p className="text-sm text-slate-600 mb-2">Cleaning this filter in <span className="font-semibold text-amber-700">{blockChangeDialog.requestedBlockName}</span> needs approval. Submit a request below.</p>
                    <textarea className="w-full bg-slate-50 border border-slate-200 rounded-xl px-4 py-2.5 text-sm text-slate-800 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 outline-none" rows={2}
                      value={blockChangeReason} onChange={e => setBlockChangeReason(e.target.value)}
                      placeholder="Why does this filter need to be cleaned in a different block?" />
                  </div>
                ) : (
                  <p className="text-sm text-slate-600">
                    This filter belongs to <span className="font-semibold">{blockChangeDialog.homeBlockName}</span>. You are cleaning it in{' '}
                    <span className="font-semibold text-amber-700">{blockChangeDialog.requestedBlockName}</span>. Continue with cleaning?
                  </p>
                )}
              </div>
              <div className="flex gap-3">
                <button onClick={() => { core.dispatch({ type: 'close' }); setScanValue(''); }}
                  className="flex-1 py-2.5 bg-slate-100 text-slate-600 rounded-xl text-sm font-medium">Cancel</button>
                <button onClick={handleBlockChangeRequest} disabled={blockChangeSubmitting || (blockChangeMode === 'APPROVAL' && !blockChangeReason.trim())}
                  className="flex-1 py-2.5 bg-gradient-to-r from-cyan-600 to-teal-600 text-white rounded-xl text-sm font-semibold disabled:opacity-50 shadow-lg shadow-cyan-500/25">
                  {blockChangeMode === 'APPROVAL' ? 'Request approval' : 'Continue with cleaning'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
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
    </div>
  );
}

/**
 * DryingFilterCard — Shows a single filter's dryer status with countdown + temperature selection.
 * Works both online (SWR polling) and offline (cached state).
 */
function DryingFilterCard({
  filterId, filterName, online, getCache, executeOrQueue, onSuccess, onError,
}: {
  filterId: string; filterName: string; online: boolean;
  getCache: <T>(key: string) => Promise<T | null>;
  executeOrQueue: any;
  onSuccess: (msg: string) => void; onError: (msg: string) => void;
}) {
  // Phase 8.7 Wave-5: shared 1Hz tick — same hook the desktop DryingFilterRow uses.
  const now = useNowTick();
  const [temp, setTemp] = useState<number | ''>('');
  const [submitting, setSubmitting] = useState(false);
  const [cycleData, setCycleData] = useState<any>(null);
  const [equipGroup, setEquipGroup] = useState<any>(null);
  // Restore previously selected temperature from cache (survives navigation)
  useEffect(() => {
    getCache<number>(`dryer-temp-${filterId}`).then(saved => {
      if (saved !== null && saved !== undefined) setTemp(saved);
    }).catch(err => {
      // IDB read failure means the operator's saved temp won't restore on
      // navigation back to the dryer card — recoverable (re-select), but
      // worth surfacing so IDB quota/lock issues are visible.
      // eslint-disable-next-line no-console -- intentional structured log
      console.warn(
        '[mobile-operations] dryer-temp restore failed —',
        err instanceof Error ? err.message : String(err),
      );
    });
  }, [filterId]);

  // Load dryer data from API (online) or cache (offline)
  useEffect(() => {
    const load = async () => {
      if (online) {
        try {
          const st = await import('../../lib/api-client').then(m => m.apiClient.get<any>(`/api/filters/${filterId}/current-state`));
          setCycleData(st?.currentCycle);
          setEquipGroup(st?.equipmentGroup);
          return;
        } catch { /* fall through to cache */ }
      }
      // Offline: use cached state
      const cached = await getCache<any>(`filter-state-${filterId}`);
      setCycleData(cached?.currentCycle);
      let grp = cached?.equipmentGroup ?? null;
      // Fallback: resolve from cached equipment groups
      if (!grp) {
        const allGroups = await getCache<any[]>('equipment-groups') ?? [];
        if (cached?.currentCycle?.cleaningAreaId) {
          const blockGroups = allGroups.filter((g: any) => g.blockId === cached.currentCycle.cleaningAreaId);
          if (blockGroups.length >= 1) grp = blockGroups[0];
        }
        // Last resort: if only one equipment group exists, use it
        if (!grp && allGroups.length === 1) grp = allGroups[0];
      }
      setEquipGroup(grp);
    };
    load();
    // Refresh every 15s when online
    if (online) {
      const interval = setInterval(load, 15000);
      return () => clearInterval(interval);
    }
  }, [filterId, online]);

  // Phase 8.7 Wave-5: shared countdown projection (same shape desktop uses).
  const projection = projectDryerCountdown(cycleData, now);
  const { startedAt, durationMin, halfReached, remainingMin, remainingSecPart, progressPct } = projection;

  // 2026-05-25: once dryer readings are submitted, hide the card entirely
  // until this filter re-enters DRY_IN in a future cycle. Desktop mirrors
  // this — see drying-filters-panel.tsx DryingFilterRow.
  if (cycleData?.dryerReadingsSubmitted) return null;

  if (!startedAt || !durationMin) {
    return (
      <div className="px-4 py-3 flex items-center justify-between">
        <span className="text-sm font-medium text-slate-700">{filterName}</span>
        <span className="text-[10px] text-slate-400">waiting for dryer start...</span>
      </div>
    );
  }

  // Phase 8.7 Wave-5: shared instrument lookup. Mobile keeps the linear
  // option-walker (preserves byte-equivalent runtime; desktop uses the
  // snapped flavour because of the original buildTempOptions implementation
  // there).
  const dryerInstrument = findDryerTempInstrument(equipGroup);
  const tempOptions: number[] = dryerInstrument
    ? buildTempOptionsLinear(dryerInstrument.operatingMin, dryerInstrument.operatingMax, dryerInstrument.leastCount)
    : [];
  const tempUom = dryerInstrument?.uom ?? '°C';

  const handleTempSubmit = async () => {
    if (!temp || submitting || !equipGroup) return;
    setSubmitting(true);
    try {
      const dryInInstruments = (equipGroup.instruments ?? []).filter((i: any) => i.stageKey === 'DRY_IN');
      const readings: Record<string, number> = {};
      for (const inst of dryInInstruments) {
        readings[inst.id] = (dryerInstrument && inst.id === dryerInstrument.id) ? Number(temp) : inst.operatingMin;
      }
      const { executed } = await executeOrQueue('advance', filterId, filterName, {
        targetState: 'DRY_IN',
        dryerAction: 'SUBMIT_READINGS',
        equipmentGroupId: equipGroup.id,
        instrumentReadings: readings,
        remarks: `Dryer temperature ${temp}${tempUom} - ${filterName}`,
      }, 'DRY_IN');
      // Phase 8.6 part 2: route the offline cache rewrite through the
      // shared `recomputeAndCacheFilterState` helper instead of a prop-drilled
      // callback. Same behaviour, no parent wiring.
      if (!executed) await recomputeAndCacheFilterState(filterId, 'DRY_IN', false, null);
      // Mark readings as submitted in cache (read AFTER recompute to get latest) + clear persisted temp
      try {
        const freshState = await getCache<any>(`filter-state-${filterId}`) ?? {};
        const { cacheData } = await import('@/lib/offline-store');
        cacheData(`filter-state-${filterId}`, { ...freshState, currentCycle: { ...(freshState.currentCycle ?? {}), dryerReadingsSubmitted: true } });
        cacheData(`dryer-temp-${filterId}`, null, 0);
      } catch (err) {
        // Cache update failure can cause the optimistic UI (set below via
        // setCycleData) to diverge from what /current-state will return
        // next time — operator may see "Complete" but the next page load
        // re-shows Dry In waiting. Surface so the failure is debuggable
        // instead of silently corrupting the offline cache view.
        // eslint-disable-next-line no-console -- intentional structured log
        console.warn(
          '[mobile-operations] dryer-reading cache update failed —',
          err instanceof Error ? err.message : String(err),
        );
      }
      // Update local component state so UI shows "Complete" immediately
      setCycleData((prev: any) => ({ ...(prev ?? {}), dryerReadingsSubmitted: true }));
      setTemp('');
      onSuccess(`${filterName} → Dry In complete (${temp}${tempUom})${executed ? '' : ' (queued)'}`);
    } catch (e: any) {
      onError(e.message ?? 'Failed');
    }
    setSubmitting(false);
  };

  return (
    <div className="px-4 py-3 space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-800">{filterName}</div>
          <div className="text-[10px] text-slate-500">{durationMin} min total</div>
        </div>
        <div className={`text-xs font-bold px-2.5 py-1 rounded-full ${cycleData?.dryerReadingsSubmitted ? 'bg-green-50 text-green-700 border border-green-200' : halfReached ? 'bg-green-50 text-green-700 border border-green-200' : 'bg-amber-50 text-amber-700 border border-amber-200'}`}>
          {cycleData?.dryerReadingsSubmitted ? 'Complete' : halfReached ? 'Ready' : `${remainingMin}:${String(remainingSecPart).padStart(2, '0')}`}
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${halfReached ? 'bg-green-500' : 'bg-amber-500'}`} style={{ width: `${progressPct}%` }} />
      </div>

      {/* Temperature already recorded */}
      {cycleData?.dryerReadingsSubmitted && (
        <div className="flex items-center gap-2 pt-1 px-1">
          <div className="flex-1 bg-green-50 border border-green-200 rounded-xl px-3 py-2.5 text-sm text-green-700 font-medium flex items-center gap-2">
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>
            Temperature recorded
          </div>
        </div>
      )}
      {/* Temperature selection — only when half-time reached and not yet submitted */}
      {halfReached && !cycleData?.dryerReadingsSubmitted && tempOptions.length > 0 && (
        <div className="flex items-center gap-2 pt-1">
          <select
            value={temp}
            onChange={e => {
              const val = e.target.value ? Number(e.target.value) : '';
              setTemp(val);
              if (val !== '') {
                // Persist dryer temp so it survives navigation. Surface IDB
                // failures so "temp got lost" isn't a silent mystery.
                import('@/lib/offline-store').then(({ cacheData }) => {
                  cacheData(`dryer-temp-${filterId}`, val, 24 * 60 * 60 * 1000);
                }).catch(err => {
                  // eslint-disable-next-line no-console -- intentional structured log
                  console.warn(
                    '[mobile-operations] dryer-temp persist failed —',
                    err instanceof Error ? err.message : String(err),
                  );
                });
              }
            }}
            disabled={submitting}
            className="flex-1 bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-800 focus:border-amber-400 outline-none"
          >
            <option value="">Select {tempUom}...</option>
            {tempOptions.map(v => <option key={v} value={v}>{formatByLeastCount(v, dryerInstrument?.leastCount)} {tempUom}</option>)}
          </select>
          <button
            onClick={handleTempSubmit}
            disabled={!temp || submitting}
            className="px-4 py-2.5 bg-gradient-to-r from-amber-500 to-orange-500 text-white rounded-xl text-sm font-bold disabled:opacity-40 active:opacity-90"
          >
            {submitting ? '...' : 'Submit'}
          </button>
        </div>
      )}
      {halfReached && !cycleData?.dryerReadingsSubmitted && tempOptions.length === 0 && (
        <div className="text-[10px] text-red-500">No temperature instrument configured for this equipment group</div>
      )}
    </div>
  );
}
