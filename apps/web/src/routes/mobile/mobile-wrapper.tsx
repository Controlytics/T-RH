import { Fragment, useState, useEffect, useRef, useMemo } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import useSWR, { mutate } from 'swr';
import { apiClient, api } from '../../lib/api-client';
import { useAuth } from '../../hooks/use-auth';
import { useDatetimeFormat } from '../../hooks/use-datetime-format';
import { useOffline } from '../../hooks/use-offline';
import { useReauth } from '@/hooks/use-reauth';
import { useAndroidBackButton } from '@/hooks/use-android-back-button';
import { retireOrReplaceFilter } from '@/lib/filter-lifecycle-actions';
import { effectiveCycleStatus } from '@/lib/cleaning-cycle-report';
import { useRfidScanField } from '@/hooks/use-rfid-scan-field';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { scopeFiltersToCascade, countByStage } from '@/lib/filter-status-scope';
import { resolveAncestry, type FilterAncestry } from '@/lib/filter-ancestry';
import { useBlockChangeApproval } from '@/hooks/use-block-change-approval';
import { ReauthDialog } from '@/components/reauth-dialog';
import { onSyncEvent } from '../../lib/sync-engine';
import { useOfflineConfig } from '../../hooks/use-offline-config';
import { HardCutoffBlocker } from '../../components/hard-cutoff-blocker';
import { ConnectivityRibbon } from '../../components/mobile/connectivity-ribbon';
import { FailedOpsPanel } from '../../components/failed-ops-panel';
import { syncAllDataForOffline, type SyncProgress } from '../../lib/offline-sync-service';
import { triggerSync, startSyncPolling } from '../../lib/sync-since';
import { MobileOperationsPage } from './mobile-operations';
import { CLEANING_STAGES_MOBILE as STAGES, STATUS_STAGE_OPTIONS } from '../../lib/filter-constants';

type View = 'home' | 'status' | 'my-tasks' | 'approvals' | 'operations' | 'rfid-assign' | 'replace' | 'cycles' | 'cycle-detail' | 'replacement-tasks' | 'notifications';

// Show "NA" when a replacement-schedule value wasn't entered (null/empty) or was
// a stray "[object Object]" from a non-text spreadsheet cell.
const naText = (v: unknown): string => {
  const s = (v ?? '').toString().trim();
  return !s || s === '[object Object]' ? 'NA' : s;
};

// Humanize a filter attribute key for display (micronSize → Micron, etc.).
const ATTR_LABELS: Record<string, string> = {
  micronSize: 'Micron', filterSize: 'Dimensions', filterType: 'Type', ahuType: 'AHU Type',
  manufacturer: 'Make', model: 'Model', serialNumber: 'Serial', installDate: 'Installed',
  lastCleaningDate: 'Last Cleaned', filterClass: 'Class', efficiency: 'Efficiency',
};
const prettyAttrKey = (k: string): string =>
  ATTR_LABELS[k] ?? k.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase()).trim();
// Non-empty scalar attribute entries of a filter, for the "all details" display.
const filterDetailPairs = (f: any): Array<[string, string]> =>
  Object.entries(f?.attributes ?? {})
    .filter(([, v]) => v != null && typeof v !== 'object' && String(v).trim() !== '' && String(v) !== '[object Object]')
    .slice(0, 10)
    .map(([k, v]) => [prettyAttrKey(k), String(v)] as [string, string]);

// Build identifier->filter map from identifiers list
// Cleaning-stage filter-event types — mirrors the server's
// CLEANING_STAGE_EVENT_TYPES (hierarchy.service.ts). "Last Cleaned" tracks the
// latest of these, so the tablet's date moves on EVERY stage (each WASH/DRY/
// STORAGE advance + bypass + completion), not only on full-cycle completion.
const CLEANING_STAGE_EVENTS = new Set(['STATE_TRANSITION', 'BYPASS_DEVIATION', 'CYCLE_COMPLETED']);

// Cycle status chip — uses effectiveCycleStatus so a cycle ended by retire/replace
// shows "Retired"/"Replaced" (not the raw "Terminated"), matching the web record.
const CYCLE_STATUS_UI: Record<string, { badge: string; label: string }> = {
  IN_PROGRESS: { badge: 'bg-blue-50 text-blue-700 border-blue-200', label: 'In Progress' },
  COMPLETED: { badge: 'bg-emerald-50 text-emerald-700 border-emerald-200', label: 'Completed' },
  TERMINATED: { badge: 'bg-rose-50 text-rose-700 border-rose-200', label: 'Terminated' },
  RETIRED: { badge: 'bg-amber-50 text-amber-700 border-amber-200', label: 'Retired' },
  REPLACED: { badge: 'bg-purple-50 text-purple-700 border-purple-200', label: 'Replaced' },
};
const cycleStatusUi = (cyc: any) => CYCLE_STATUS_UI[effectiveCycleStatus(cyc)] ?? CYCLE_STATUS_UI.IN_PROGRESS;

// Replacement-task status chip (computedStatus from /tasks).
const REPL_STATUS_META: Record<string, { label: string; cls: string }> = {
  DUE:         { label: 'Due',         cls: 'text-rose-700 bg-rose-50 border-rose-200' },
  IN_PROGRESS: { label: 'In Progress', cls: 'text-amber-700 bg-amber-50 border-amber-200' },
  PENDING:     { label: 'Upcoming',    cls: 'text-slate-600 bg-slate-100 border-slate-200' },
  MISSED:      { label: 'Overdue',     cls: 'text-red-700 bg-red-50 border-red-200' },
  COMPLETED:   { label: 'Completed',   cls: 'text-emerald-700 bg-emerald-50 border-emerald-200' },
};

// Latest cleaning-stage event time for a filter across the given cycles (each
// cycle carries `events` when fetched with includeEvents=true).
function latestStageEventAt(cycles: any[], filterId: string): string | null {
  let latest: string | null = null;
  for (const c of cycles) {
    if (c.filterId !== filterId) continue;
    for (const ev of (c.events ?? [])) {
      if (!CLEANING_STAGE_EVENTS.has(ev.eventType) || !ev.performedAt) continue;
      if (!latest || ev.performedAt > latest) latest = ev.performedAt;
    }
  }
  return latest;
}

// Effective "Last Cleaned" for the tablet — mirrors the server's zipLastCleaned:
// prefer the latest cleaning-stage event timestamp, else fall back to the manual
// attributes.lastCleaningDate seed (strict YYYY-MM-DD; 'NA' / blank ignored).
// Keeps the tablet consistent with the Web Filters page.
function effectiveLastCleaned(cycleAt: string | undefined | null, attrs: any): string | null {
  if (cycleAt) return cycleAt;
  const raw = attrs?.lastCleaningDate;
  return typeof raw === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

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

export function MobileWrapperPage() {
  const { user, isLoading: authLoading, logout: authLogout } = useAuth();
  const { formatTime, formatDate, formatDateTime, config: datetimeConfig } = useDatetimeFormat();
  // W2: mobile entry point bypasses AppLayout, so wire the offline-cache
  // config bootstrap here too. The hook is a no-op when the user isn't
  // authenticated yet (SWR doesn't fire on null key inside it).
  useOfflineConfig();
  const { online, pendingCount, syncing, lastSyncMessage, manualSync, clearQueue, getQueueDetails, cacheFilterData, getOfflineFilters, cache, getCache } = useOffline();
  const reauth = useReauth();
  // Audit 2026-05-04 follow-up: shared block-change approval flow with web
  // approvals page so the two implementations can't drift again. Uses its
  // own reauth instance (the `reauth` above is for RFID assign/unassign).
  const blockChangeApproval = useBlockChangeApproval();
  const mobileNav = useNavigate();

  // Tablet access control — which features are allowed for this role.
  // 2026-05-21: use the `configured` flag the server now returns to distinguish
  // "no admin config exists for this role" (default all-allowed) from
  // "admin configured this role with an empty allowlist" (deny everything).
  // Without this the FE backwards-compat path treated empty as all-allowed,
  // letting supervisors into my-tasks/rfid-assign that admin had unchecked.
  const { data: tabletAccess } = useSWR(user && online ? '/api/config/tablet-access/my-features' : null);
  const allowedFeatures: string[] = (tabletAccess as any)?.allowed ?? [];
  const tabletConfigured: boolean = (tabletAccess as any)?.configured === true;
  const hasFeature = (f: string) => !tabletConfigured || allowedFeatures.includes(f);

  // 2026-05-21: auth/feature redirects are deferred to the final JSX block
  // (just above the main `return (` below). Returning early HERE skipped the
  // ~50 hooks that follow, so on logout (`useAuth.mutate(undefined, false)`
  // → user becomes undefined → re-render) React 19 threw error #300
  // "Rendered fewer hooks than expected." The component's "Something went
  // wrong" overlay swallowed the crash. Keep all hook calls unconditional.

  const logout = async () => {
    await authLogout();
    mobileNav('/m/login', { replace: true });
  };

  const [view, setView] = useState<View>('home');
  const [selectedStageKey, setSelectedStageKey] = useState<string | null>(null);

  // 2026-05-21: bounce the operator back to home if they're on a view their
  // role isn't allowed to use (admin disabled the feature mid-session, or the
  // tabletAccess config changed via a different device). Map each view to its
  // gating feature key; views not in the map are unconditionally reachable.
  useEffect(() => {
    if (!tabletAccess) return;
    const featureForView: Partial<Record<View, string>> = {
      status: 'filter_status',
      'my-tasks': 'my_tasks',
      approvals: 'approvals',
      'rfid-assign': 'rfid_assign',
      operations: 'filter_cleaning',
    };
    const feature = featureForView[view];
    if (feature && !hasFeature(feature)) {
      setView('home');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, tabletConfigured, allowedFeatures.join(',')]);
  // 2026-05-20: Filter Status drill-down. Tapping a stage card on the Status
  // view now filters the list below by that stage (read-only details — Name,
  // AHU, Last Cleaned, Stage) instead of routing into the scan-operations
  // page. Tap a second time / tap "Show all" to clear.
  const [statusStageFilter, setStatusStageFilter] = useState<string | null>(null);
  // 2026-05-21: cascading hierarchy filters for the Status view —
  // Block → Area → AHU → Filter. Each dropdown narrows the next.
  const [statusBlockId, setStatusBlockId] = useState<string>('all');
  const [statusAreaId, setStatusAreaId] = useState<string>('all');
  const [statusAhuId, setStatusAhuId] = useState<string>('all');
  const [statusFilterId, setStatusFilterId] = useState<string>('all');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  // ===== CENTRALIZED OFFLINE DATA SYNC =====
  // On login (while online), sync ALL master data in one go.
  // Then keep SWR for live data refresh while online.
  const [dataCached, setDataCached] = useState(false);
  const [syncProgress, setSyncProgress] = useState<SyncProgress | null>(null);
  // 2026-05-21: tablet operator explicit ask — the same APK can be installed
  // on many tablets and operators move between them. Every app open must
  // pull a fresh copy of master data (instances, identifiers, templates,
  // cleaning reasons, equipment groups, profile assignments, etc.) so an
  // identifier added on one tablet shows up on another without manual
  // intervention. Plus we re-sync whenever the app comes back from
  // background (visibilitychange) so leaving the tablet for an hour and
  // returning doesn't scan against stale data.
  useEffect(() => {
    if (!user) return;
    // Do NOT hard-gate on the `online` flag — it's an unreliable false-negative
    // on Android WebViews, and gating here meant a stuck-false flag silently
    // skipped the open-sync, leaving the cache stale (a newly added filter,
    // reassigned tag, or fresh cycle never landed → "Filter not found"). Attempt
    // whenever EITHER signal says reachable; a genuinely-offline attempt fails
    // fast and soft-fails inside syncAllDataForOffline.
    if (!online && !navigator.onLine) return;
    // Mark cache stale until the fresh sync completes — UI shows "Syncing…"
    setDataCached(false);
    syncAllDataForOffline((progress) => {
      setSyncProgress(progress);
      if (progress.done) setDataCached(true);
    });
  }, [online, user]);
  // Re-sync on foreground (visibilitychange) so the cache reflects any
  // server-side changes that happened while the tablet was backgrounded.
  useEffect(() => {
    if (!user) return;
    const onVisible = () => {
      if (document.visibilityState === 'visible' && navigator.onLine) {
        setDataCached(false);
        syncAllDataForOffline((progress) => {
          setSyncProgress(progress);
          if (progress.done) setDataCached(true);
        });
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [user]);

  // Phase 8.4b — versioned-cache sync (Option D). Runs in parallel with the
  // legacy syncAllDataForOffline above. Different cache (the v5 sync stores
  // vs. legacy `cache` key/value blobs) — additive, doesn't replace. Wires
  // up visibilitychange + online + 60s poll triggers so the cache stays
  // fresh while the tablet is foregrounded. Will replace the legacy path
  // in 8.6 once the shared executor lands.
  useEffect(() => {
    if (!user) return;
    triggerSync('mobile-app-start');
    const teardown = startSyncPolling();
    return () => teardown();
  }, [user]);

  // Re-sync after operations are synced back to server (keeps cache fresh)
  useEffect(() => {
    const cleanup = onSyncEvent((event) => {
      if (event.type === 'complete' && event.synced && event.synced > 0 && online) {
        // Full re-sync after successful operation sync
        syncAllDataForOffline((progress) => {
          setSyncProgress(progress);
        });
        mutate('/api/assets/instances');
      }
    });
    return cleanup;
  }, [online]);

  // SWR for live data while online (refresh intervals for real-time updates)
  // May 16 H19 tuning (2026-05-20): bumped intervals to halve API load.
  // Stage-by-stage workflows operate on minute-scale, so 30-60s polling is
  // well below operator-perceptible staleness.
  const { data: instancesData } = useSWR(online ? '/api/assets/instances' : null, { refreshInterval: 30000 });
  const { data: templatesData } = useSWR(online ? '/api/assets/templates' : null);
  const { data: identifiersData, mutate: mutateIdentifiers } = useSWR(online ? '/api/assets/identifiers' : null, { refreshInterval: 60000 });

  // My Tasks filters (mirror the desktop My Tasks page). Time period drives the
  // server query (/due?from=&to=); search / block / area / status filter client-side.
  const [taskSearch, setTaskSearch] = useState('');
  const [taskBlock, setTaskBlock] = useState('');   // block id
  const [taskArea, setTaskArea] = useState('');     // area id
  const [taskFrom, setTaskFrom] = useState('');
  const [taskTo, setTaskTo] = useState('');
  const [taskStatus, setTaskStatus] = useState<'all' | 'pending' | 'completed' | 'overdue'>('all');
  const [taskFiltersOpen, setTaskFiltersOpen] = useState(false);

  // My Tasks + Approvals. The /due key carries the from/to period so the server
  // returns tasks for the selected window (empty = "due now + overdue").
  const dueKey = (() => {
    if (!online) return null;
    const qs = new URLSearchParams();
    if (taskFrom) qs.set('from', taskFrom);
    if (taskTo) qs.set('to', taskTo);
    const s = qs.toString();
    return `/api/pm-schedules/due${s ? `?${s}` : ''}`;
  })();
  const { data: dueTasksData, mutate: mutateDueTasks, isLoading: dueTasksLoading } =
    useSWR(dueKey, { refreshInterval: view === 'my-tasks' ? 30000 : 120000 });

  // Notifications (overdue deviations etc.) — bell badge + center view.
  const { data: notifData, mutate: mutateNotifs } =
    useSWR<any>(online ? '/api/notifications?limit=50' : null, { refreshInterval: view === 'notifications' ? 15000 : 60000 });
  const notifications: any[] = notifData?.data ?? [];
  const unreadCount: number = notifData?.unreadCount ?? 0;
  const markNotifRead = async (n: any) => {
    if (n.isRead) return;
    try { await apiClient.put(`/api/notifications/${n.id}/read`, {}); mutateNotifs(); } catch { /* ignore */ }
  };
  const markAllNotifsRead = async () => {
    try { await apiClient.put('/api/notifications/mark-all-read', {}); mutateNotifs(); } catch { /* ignore */ }
  };

  const isApprover = user?.role === 'SUPER_ADMIN' || (user?.permissions ?? []).includes('BLOCK_CHANGE_APPROVE');
  const [approvalsFilter, setApprovalsFilter] = useState<'PENDING' | 'APPROVED' | 'REJECTED' | 'ALL'>(isApprover ? 'PENDING' : 'ALL');
  const approvalsKey = online
    ? `/api/block-change-requests?page=1&limit=50&status=${approvalsFilter}${!isApprover ? '&mine=true' : ''}`
    : null;
  const { data: approvalsData, mutate: mutateApprovals, isLoading: approvalsLoading } =
    useSWR<any>(approvalsKey, { refreshInterval: view === 'approvals' ? 30000 : 120000 });

  // Issue #7 fix (2026-05-18): cleaning-cycles list for mobile.
  // 2026-05-20: also load when view==='status' so the new stage-detail drill-down
  // can derive "Last cleaned" per filter from the most-recent COMPLETED cycle.
  const { data: cyclesData, isLoading: cyclesLoading } =
    useSWR<any>(online && (view === 'cycles' || view === 'status' || view === 'rfid-assign' || view === 'replace') ? '/api/filters/cycles?page=1&limit=200&includeEvents=true' : null,
      { refreshInterval: view === 'cycles' ? 30000 : 0 });
  const [offlineCycles, setOfflineCycles] = useState<any[]>([]);
  const [expandedCycle, setExpandedCycle] = useState<string | null>(null);
  // 2026-05-21: cycle list filters + selected-cycle for detail view.
  // cycleAhuId='all' shows every AHU's cycles, otherwise scoped to one AHU.
  // cycleFilterId='all' shows every filter's cycles, otherwise scoped to one
  // filter. cycleFrom/cycleTo are local `datetime-local` ISO strings (no TZ);
  // we parse to Date for comparison. selectedCycleId drives view='cycle-detail'.
  const [cycleAhuId, setCycleAhuId] = useState<string>('all');
  const [cycleFilterId, setCycleFilterId] = useState<string>('all');
  const [cycleFrom, setCycleFrom] = useState<string>('');
  const [cycleTo, setCycleTo] = useState<string>('');
  const [selectedCycleId, setSelectedCycleId] = useState<string | null>(null);
  useEffect(() => { if (cyclesData?.data) cache('cleaning-cycles-recent', cyclesData.data); }, [cyclesData, cache]);
  useEffect(() => {
    if (!online && view === 'cycles') getCache<any[]>('cleaning-cycles-recent').then(c => setOfflineCycles(c ?? []));
  }, [online, view, getCache]);
  const cyclesList: any[] = (online ? (cyclesData?.data ?? []) : offlineCycles) as any[];

  // Cycle detail fetch — fires only when view='cycle-detail' AND we have an id.
  // Returns the full cycle row including events[] with enrichedAnswers (checklist
  // questions+answers) and instrumentReadings (submitted values) per event.
  const { data: cycleDetailData, isLoading: cycleDetailLoading } = useSWR<any>(
    online && selectedCycleId && view === 'cycle-detail' ? `/api/filters/cycles/${selectedCycleId}` : null,
  );
  // Offline fallback: synthesize detail from the list row if we have it cached.
  const cycleDetail: any = cycleDetailData
    ?? (selectedCycleId ? cyclesList.find((c: any) => c.id === selectedCycleId) : null);

  // Offline data from IndexedDB cache
  const [offlineTasks, setOfflineTasks] = useState<any>(null);
  const [offlineApprovals, setOfflineApprovals] = useState<any[]>([]);
  const [offlineFilters, setOfflineFilters] = useState<any[]>([]);
  const [offlineTemplates, setOfflineTemplates] = useState<any[]>([]);
  const [offlineReasons, setOfflineReasons] = useState<any[]>([]);

  // RFID Assign state
  const [rfidSearch, setRfidSearch] = useState('');
  const [rfidSelectedFilter, setRfidSelectedFilter] = useState<{ id: string; name: string } | null>(null);
  // 2026-05-26: rfidInput moved off plain useState onto useRfidScanField.
  // Fixes the multi-scan-append bug + adds duplicate-submit debounce.
  const rfidScan = useRfidScanField();
  const [rfidSubmitting, setRfidSubmitting] = useState(false);
  const [rfidError, setRfidError] = useState('');
  const [rfidSuccess, setRfidSuccess] = useState('');

  // 2026-05-26: Filter Status → Scan RFID modal state. Operator taps
  // "Scan RFID" on the Status view, scans a tag, sees the mapped
  // filter's current state + Block→Area→AHU hierarchy + last cleaned.
  //
  // The scan capture uses a HIDDEN uncontrolled input — not a visible
  // controlled one — for two reasons drawn directly from operator
  // feedback on the tablet:
  //
  //   1. Multiple scans were concatenating ("CA000C01CA000C03" on
  //      one line). Controlled inputs accumulate React-state across
  //      scan bursts when the next burst arrives before React flushes
  //      its render. An uncontrolled input + DOM-snapshot-on-Enter
  //      bypasses the race entirely.
  //   2. The operator should NOT be able to manually type a tag value
  //      into the field. The modal is for scan-driven lookup, not
  //      keyboard entry. A hidden input with a read-only display chip
  //      removes the text-entry affordance while still capturing
  //      scanner-emitted keystrokes (it's autofocused; the modal's
  //      onClick refocuses it if the user taps elsewhere).
  //
  // `scanRfidValue` is set on Enter (the scan-burst terminator emitted
  // by the KC-series scanner) from the input's .value snapshot, then
  // the input is cleared so the next scan starts from empty regardless
  // of how rapid the back-to-back scans are.
  const [scanRfidOpen, setScanRfidOpen] = useState(false);
  const [scanRfidValue, setScanRfidValue] = useState('');
  const [scanRfidError, setScanRfidError] = useState('');
  const scanRfidInputRef = useRef<HTMLInputElement>(null);
  const scanRfidLastSubmitRef = useRef<{ value: string; time: number }>({ value: '', time: 0 });
  // 2026-05-21: cascading hierarchy filters for the RFID Assign filter list —
  // Block → Area → AHU → Filter, mirroring the Status view.
  const [rfidBlockId, setRfidBlockId] = useState<string>('all');
  const [rfidAreaId, setRfidAreaId] = useState<string>('all');
  const [rfidAhuId, setRfidAhuId] = useState<string>('all');
  const [rfidFilterId, setRfidFilterId] = useState<string>('all');

  // Replace-filter view: same Block → Area → AHU → Filter cascade as RFID
  // Assign, then a remarks-gated confirm. Online-only for v1 (replace creates
  // a new server-side AssetInstance + relationships — can't be queued offline).
  const [replaceBlockId, setReplaceBlockId] = useState<string>('all');
  const [replaceAreaId, setReplaceAreaId] = useState<string>('all');
  const [replaceAhuId, setReplaceAhuId] = useState<string>('all');
  const [replaceFilterId, setReplaceFilterId] = useState<string>('all');
  const [replaceSearch, setReplaceSearch] = useState('');
  const [replaceSelectedFilter, setReplaceSelectedFilter] = useState<{ id: string; name: string } | null>(null);
  const [replaceRemarks, setReplaceRemarks] = useState('');
  const [replaceSubmitting, setReplaceSubmitting] = useState(false);
  const [replaceError, setReplaceError] = useState('');
  const [replaceSuccess, setReplaceSuccess] = useState('');
  // Scan-to-select for replacement (ADDITIVE — the Block→Area→AHU→Filter cascade
  // + name search below are unchanged). Scanning a filter's RFID/QR tag resolves
  // it via the identifier→filter map and pre-selects it for the confirm step.
  const replaceScan = useRfidScanField();
  const [replaceScanError, setReplaceScanError] = useState('');

  // ── Replacement Schedule tasks (separate tile → own page, online-only) ──
  // /tasks returns EVERY approved entry with live AHU-filter progress (a task
  // covers ALL filters under its AHU). Split into Pending (still needs replacing)
  // and Completed for the two tabs on the page.
  const { data: replDueData, mutate: mutateReplDue } = useSWR(online ? '/api/replacement-schedules/tasks' : null, { refreshInterval: 30000 });
  const replAllTasks = ((replDueData as any)?.data ?? []) as any[];
  const replDueTasks = replAllTasks.filter((t: any) => t.computedStatus !== 'COMPLETED');
  const replCompletedTasks = replAllTasks.filter((t: any) => t.computedStatus === 'COMPLETED');
  const [replTaskTab, setReplTaskTab] = useState<'pending' | 'completed'>('pending');
  // 2026-06-04 (per user): Replacement Tasks are open to ANY role on the tablet
  // — operators run scheduled replacements from the tablet and shouldn't need a
  // special permission. (Web view/upload stays role-gated; the execute still
  // requires REPLACE_FILTER reauth, so the 21 CFR signature + audit is kept.)
  const canReplacementTasks = true;
  const [activeReplTask, setActiveReplTask] = useState<any | null>(null);
  const replTaskScan = useRfidScanField();
  const [replTaskError, setReplTaskError] = useState('');
  const [replTaskSubmitting, setReplTaskSubmitting] = useState(false);
  // Pick-from-list selection for the active replacement task (multi-select,
  // capped at qtyRemaining). Additive to the scan box above it.
  const [replTaskSelected, setReplTaskSelected] = useState<Set<string>>(new Set());
  const [replTaskSearch, setReplTaskSearch] = useState('');
  const replBatchResultRef = useRef<{ done: number; failed: string[] } | null>(null);

  const [expandedTasks, setExpandedTasks] = useState<Set<string>>(new Set());
  const [processingApproval, setProcessingApproval] = useState<string | null>(null);
  const [approvalComment, setApprovalComment] = useState('');

  // Cache live SWR data for offline fallback
  useEffect(() => { if (instancesData?.data) cacheFilterData(instancesData.data); }, [instancesData]);
  // Only snapshot the unfiltered "due now" view for offline use — caching a
  // period-filtered result would make the offline My Tasks show the wrong set.
  useEffect(() => { if (dueTasksData && !taskFrom && !taskTo) cache('due-tasks', dueTasksData); }, [dueTasksData, taskFrom, taskTo]);
  useEffect(() => { if (approvalsData?.data) cache('approvals', approvalsData.data); }, [approvalsData]);

  // Load cached data for offline use
  const refreshOfflineData = () => {
    getOfflineFilters().then(setOfflineFilters);
    getCache<any[]>('templates').then(t => setOfflineTemplates(t ?? []));
    getCache<any[]>('cleaning-reasons').then(r => setOfflineReasons(r ?? []));
    getCache<any>('due-tasks').then(t => { if (t) setOfflineTasks(t); });
    getCache<any[]>('approvals').then(a => { if (a) setOfflineApprovals(a); });
  };
  useEffect(() => { refreshOfflineData(); }, []);
  useEffect(() => { if (!online) refreshOfflineData(); }, [online]);
  // Issue #5 fix (2026-05-18): home/status tile counters were rendering
  // stale state-counts after offline submits. pendingCount changes whenever
  // the queue grows (new offline op) or shrinks (sync completed), so it's
  // the right tripwire for re-reading the IndexedDB filter cache and
  // updating the counts.
  useEffect(() => { refreshOfflineData(); }, [pendingCount]);

  const approvals: any[] = (online ? approvalsData?.data : null) ?? offlineApprovals;
  const tasksSource = (online ? dueTasksData : null) ?? offlineTasks;

  // ── My Tasks filtering (mirrors desktop my-tasks/index.tsx) ──
  const allDueTasks = (tasksSource?.tasks ?? []) as any[];
  const allOverdueTasks = (tasksSource?.overdue ?? []) as any[];

  // Block / Area dropdown options derived from the current task set (works
  // offline — no extra API calls). Areas cascade from the selected block.
  const taskBlockOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of [...allDueTasks, ...allOverdueTasks]) if (t.blockId) m.set(t.blockId, t.blockName ?? t.blockId);
    return [...m.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
  }, [tasksSource]);
  const taskAreaOptions = useMemo(() => {
    const m = new Map<string, { name: string; blockId: string | null }>();
    for (const t of [...allDueTasks, ...allOverdueTasks]) if (t.areaId) m.set(t.areaId, { name: t.areaName ?? t.areaId, blockId: t.blockId ?? null });
    return [...m.entries()]
      .map(([id, v]) => ({ id, name: v.name, blockId: v.blockId }))
      .filter(a => !taskBlock || a.blockId === taskBlock)
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [tasksSource, taskBlock]);

  const taskMatchesFilters = (t: any) => {
    const q = taskSearch.trim().toLowerCase();
    if (q && !((t.ahuName ?? '').toLowerCase().includes(q)
      || (t.blockName ?? '').toLowerCase().includes(q)
      || (t.areaName ?? '').toLowerCase().includes(q))) return false;
    if (taskBlock && t.blockId !== taskBlock) return false;
    if (taskArea && t.areaId !== taskArea) return false;
    return true;
  };

  // Status tab: All shows everything; Pending = pending + in-progress;
  // Completed = complete; Overdue = the separate overdue array (its own tab).
  const visibleDueTasks = allDueTasks.filter(t => {
    if (!taskMatchesFilters(t)) return false;
    if (taskStatus === 'pending') return t.overallStatus === 'pending' || t.overallStatus === 'in_progress';
    if (taskStatus === 'completed') return t.overallStatus === 'complete';
    if (taskStatus === 'overdue') return false;
    return true; // 'all'
  });
  const visibleOverdueTasks = allOverdueTasks.filter(t =>
    taskMatchesFilters(t) && (taskStatus === 'all' || taskStatus === 'overdue'));

  // Per-category counts for the toggle badges (respect search/block/area filters).
  const taskCounts = {
    all: allDueTasks.filter(taskMatchesFilters).length + allOverdueTasks.filter(taskMatchesFilters).length,
    pending: allDueTasks.filter(t => taskMatchesFilters(t) && (t.overallStatus === 'pending' || t.overallStatus === 'in_progress')).length,
    completed: allDueTasks.filter(t => taskMatchesFilters(t) && t.overallStatus === 'complete').length,
    overdue: allOverdueTasks.filter(taskMatchesFilters).length,
  };
  const taskFiltersActive = !!(taskSearch || taskBlock || taskArea || taskFrom || taskTo || taskStatus !== 'all');
  const clearTaskFilters = () => { setTaskSearch(''); setTaskBlock(''); setTaskArea(''); setTaskFrom(''); setTaskTo(''); setTaskStatus('all'); };

  const templates = (online ? (templatesData?.data ?? []) : offlineTemplates) as any[];
  const instances = online ? ((instancesData?.data ?? []) as any[]) : offlineFilters;
  // Multi-template support: a tenant can have several FILTER-kind templates
  // (e.g. HEPA vs ULPA with different attributeSchemas). Membership check via
  // Set; matches the pattern used in filter-list.tsx:149. The single-id
  // lookup that was here before would drop filters belonging to any FILTER
  // template after the first one returned by `.find()`.
  const filterTemplateIds = new Set(
    templates.filter((t: any) => t.templateKind === 'FILTER').map((t: any) => t.id),
  );
  // Instance rows carry templateId but NOT templateKind (/api/assets/instances),
  // so ancestry has to resolve kind through the template list.
  const kindByTemplateId = new Map<string, string>(
    (templates as any[]).map((t: any) => [t.id, t.templateKind]),
  );
  const kindOfInstance = (i: any): string | null =>
    i?.template?.templateKind ?? kindByTemplateId.get(i?.templateId) ?? null;
  const allFilters = instances.filter((f: any) =>
    (filterTemplateIds.has(f.templateId) || f.template?.templateKind === 'FILTER') &&
    f.isActive !== false && f.status !== 'Retired',
  );

  // NOTE: stage counts are NOT computed here. They must be derived from the
  // same cascade-scoped array the Status list renders, or the tiles report
  // site-wide numbers while the list shows one block. See the Status view.

  // 2026-05-21: cycles-view filter helpers (depend on allFilters + instances).
  // AHUs are derived from the set of parent ids referenced by any filter row.
  const filterParentByFilterId = new Map<string, string | null>(
    (allFilters as any[]).map((f: any) => [f.id, (f.parentId ?? null) as string | null]),
  );
  const ahuIdsWithFilters = new Set<string>(
    (allFilters as any[]).map((f: any) => f.parentId).filter((p: any): p is string => typeof p === 'string'),
  );
  const ahuOptions: any[] = (instances as any[])
    .filter((i: any) => ahuIdsWithFilters.has(i.id))
    .sort((a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
  // When AHU is selected, the Filter dropdown narrows to that AHU's filters.
  const filterOptionsForAhu: any[] = cycleAhuId === 'all'
    ? (allFilters as any[])
    : (allFilters as any[]).filter((f: any) => f.parentId === cycleAhuId);

  // Filtered cycles list — combines AHU, single-filter, and date-range filters.
  const filteredCyclesList: any[] = cyclesList.filter((c: any) => {
    if (cycleAhuId !== 'all') {
      const parent = filterParentByFilterId.get(c.filterId);
      if (parent !== cycleAhuId) return false;
    }
    if (cycleFilterId !== 'all' && c.filterId !== cycleFilterId) return false;
    const t = c.startedAt ? new Date(c.startedAt).getTime() : 0;
    if (cycleFrom) {
      const fromMs = new Date(cycleFrom).getTime();
      if (Number.isFinite(fromMs) && t < fromMs) return false;
    }
    if (cycleTo) {
      const toMs = new Date(cycleTo).getTime();
      if (Number.isFinite(toMs) && t > toMs) return false;
    }
    return true;
  });

  useEffect(() => { if (success) { const t = setTimeout(() => setSuccess(''), 4000); return () => clearTimeout(t); } }, [success]);
  useEffect(() => { if (error) { const t = setTimeout(() => setError(''), 6000); return () => clearTimeout(t); } }, [error]);

  const openStage = (stageKey: string) => {
    setSelectedStageKey(stageKey);
    setView('operations');
    setError(''); setSuccess('');
  };

  const goHome = () => {
    setView('home');
    setSelectedStageKey(null);
    setError('');
    setSuccess('');
    setRfidSearch('');
    setRfidSelectedFilter(null);
    rfidScan.setValue('');
    setRfidError('');
    setRfidSuccess('');
    setScanRfidOpen(false);
    setScanRfidValue('');
    setScanRfidError('');
    // 2026-05-17 stale-stage-counter fix: revalidate `instances` on
    // home-enter. Matches the same fix in mobile-operations.tsx::goHome —
    // SWR's 15s refresh interval can leave the dashboard reading the
    // pre-cycle stage breakdown for up to 15s after a submit, which felt
    // like a broken cycle during today's offline test. Online-only; offline
    // mode keeps the prior server snapshot until reconnect.
    if (online) mutate('/api/assets/instances');
  };

  // ─── RFID Assign handlers ───
  const allIdentifiers = ((identifiersData as any) ?? []) as any[];
  const rfidTagsByFilter = new Map<string, any[]>();
  for (const ident of allIdentifiers) {
    if (ident.identifierType === 'RFID' && ident.assetId) {
      const arr = rfidTagsByFilter.get(ident.assetId) ?? [];
      arr.push(ident);
      rfidTagsByFilter.set(ident.assetId, arr);
    }
  }
  const currentRfidTags = rfidSelectedFilter ? (rfidTagsByFilter.get(rfidSelectedFilter.id) ?? []) : [];

  // Audit 2026-05-04 fix (web-routes review C3): RFID assign/unassign on the
  // tablet path bypassed reauth. Web equivalents in
  // assets/hooks/use-asset-mutations.ts already wrap in reauth — tablet path
  // had drifted. CREATE_ASSET_IDENTIFIER / DELETE_ASSET_IDENTIFIER actions
  // already declared in packages/shared/src/types/reauth-actions.ts:47-48.
  const assignRfid = () => {
    if (!rfidSelectedFilter || !rfidScan.value.trim()) {
      setRfidError('Enter or scan a tag value.');
      return;
    }
    const tagValue = rfidScan.value.trim();
    // 2026-05-26: guard against double-fire from the scanner emitting the
    // same physical scan twice within ~1s. Silent skip — the operator
    // already saw a success toast from the first submit.
    if (rfidScan.isDuplicate(tagValue)) return;
    setRfidSubmitting(true);
    setRfidError('');
    setRfidSuccess('');
    const filterName = rfidSelectedFilter.name;
    reauth.execute(
      'CREATE_ASSET_IDENTIFIER',
      async (password?: string) => {
        const body = {
          assetId: rfidSelectedFilter!.id,
          identifierType: 'RFID',
          identifierValue: tagValue,
        };
        if (password) {
          await api.postWithReauth('/api/assets/identifiers', body, password);
        } else {
          await apiClient.post('/api/assets/identifiers', body);
        }
      },
      {
        onSuccess: async () => {
          setRfidSuccess(`Tag assigned to "${filterName}"`);
          rfidScan.setValue('');
          await mutateIdentifiers();
          setRfidSubmitting(false);
        },
        onError: (err: any) => {
          setRfidError(err?.message ?? 'Failed to assign tag');
          setRfidSubmitting(false);
        },
      },
    );
  };

  const unassignRfid = (identifierId: string) => {
    setRfidSubmitting(true);
    setRfidError('');
    setRfidSuccess('');
    reauth.execute(
      'DELETE_ASSET_IDENTIFIER',
      async (password?: string) => {
        if (password) {
          await api.deleteWithReauth(`/api/assets/identifiers/${identifierId}`, password);
        } else {
          await apiClient.delete(`/api/assets/identifiers/${identifierId}`);
        }
      },
      {
        onSuccess: async () => {
          setRfidSuccess('Tag removed');
          await mutateIdentifiers();
          setRfidSubmitting(false);
        },
        onError: (err: any) => {
          setRfidError(err?.message ?? 'Failed to remove tag');
          setRfidSubmitting(false);
        },
      },
    );
  };

  // ─── Replace-filter handler ───
  // Backend gates POST /:id/replace with requireAnyPermission(FILTER_OPERATE,
  // FILTER_REPLACE); mirror that here so the tile/view only appear for roles
  // the server will actually accept. SUPER_ADMIN bypasses (project rule).
  const replacePerms = user?.permissions ?? [];
  const canReplace = user?.role === 'SUPER_ADMIN'
    || replacePerms.includes('FILTER_REPLACE')
    || replacePerms.includes('FILTER_OPERATE');

  const closeReplace = () => {
    setReplaceSelectedFilter(null);
    setReplaceRemarks('');
    setReplaceError('');
    setReplaceSuccess('');
    setReplaceSubmitting(false);
    replaceScan.setValue('');
    setReplaceScanError('');
  };

  // Resolve a scanned tag → filter and pre-select it for replacement. Reuses the
  // same identifier→filter map as the Status "Scan RFID" lookup and the cleaning
  // scan flow, so a tag scanned here behaves identically to one scanned elsewhere.
  const resolveReplaceScan = () => {
    const raw = replaceScan.value.trim();
    if (!raw) return;
    const map = buildIdentifierMap(allIdentifiers);
    const hit = map[raw] ?? map[raw.toUpperCase()] ?? map[raw.toLowerCase()];
    if (!hit) {
      setReplaceScanError(`No filter found for tag "${raw}". Check the tag is assigned, or pick the filter manually below.`);
      replaceScan.setValue('');
      return;
    }
    setReplaceSelectedFilter({ id: hit.filterId, name: hit.filterName });
    setReplaceRemarks(''); setReplaceError(''); setReplaceSuccess(''); setReplaceScanError('');
    replaceScan.setValue('');
  };

  // ── Replacement-task: scan the old filter → replace it against the task entry ──
  // Wraps the existing replace action via the schedule execute endpoint (which
  // increments qty + logs the execution). REPLACE_FILTER reauth gates it.
  const resolveAndExecuteReplTask = () => {
    if (!activeReplTask) return;
    const raw = replTaskScan.value.trim();
    if (!raw) { setReplTaskError('Scan a filter tag to replace.'); return; }
    const map = buildIdentifierMap(allIdentifiers);
    const hit = map[raw] ?? map[raw.toUpperCase()] ?? map[raw.toLowerCase()];
    if (!hit) { setReplTaskError(`No filter found for tag "${raw}".`); replTaskScan.setValue(''); return; }
    setReplTaskSubmitting(true); setReplTaskError('');
    const taskId = activeReplTask.id;
    const ahuName = activeReplTask.ahuName;
    reauth.execute('REPLACE_FILTER', async (password?: string) => {
      const body = { oldFilterId: hit.filterId, remarks: `Replaced via schedule task (AHU ${ahuName})` };
      if (password) await api.postWithReauth(`/api/replacement-schedules/entries/${taskId}/execute`, body, password);
      else await api.post(`/api/replacement-schedules/entries/${taskId}/execute`, body);
    }, {
      onSuccess: async () => {
        // Feedback = the task list refreshes (qty decrements / task clears).
        replTaskScan.setValue(''); setReplTaskSubmitting(false); setActiveReplTask(null);
        await mutateReplDue();
        if (online) { await mutate('/api/assets/instances'); await mutateIdentifiers(); }
      },
      onError: (e: any) => { setReplTaskError(e?.message ?? 'Failed to replace filter'); setReplTaskSubmitting(false); },
    });
  };

  // ── Replacement-task: replace the picked filters (multi-select) in one batch ──
  // Same endpoint + REPLACE_FILTER reauth as the scan path — just loops over the
  // selected filter ids. One reauth covers the whole batch (the in-memory reauth
  // cache keeps subsequent calls signed). Per-filter errors are collected so one
  // bad row doesn't abort the rest; REAUTH errors are re-thrown so the dialog
  // (not a generic popup) handles them.
  const executeBatchReplTask = () => {
    if (!activeReplTask || replTaskSelected.size === 0) return;
    const ids = [...replTaskSelected];
    const taskId = activeReplTask.id;
    const ahuName = activeReplTask.ahuName;
    setReplTaskSubmitting(true); setReplTaskError('');
    reauth.execute('REPLACE_FILTER', async (password?: string) => {
      let done = 0; const failed: string[] = [];
      for (const fid of ids) {
        try {
          const body = { oldFilterId: fid, remarks: `Replaced via schedule task (AHU ${ahuName})` };
          if (password) await api.postWithReauth(`/api/replacement-schedules/entries/${taskId}/execute`, body, password);
          else await api.post(`/api/replacement-schedules/entries/${taskId}/execute`, body);
          done++;
        } catch (e: any) {
          const code = e?.error ?? e?.code;
          // Let the reauth flow handle its own errors (open/keep the dialog).
          if (code === 'REAUTH_FAILED' || code === 'REAUTH_REQUIRED') throw e;
          const fname = (allFilters as any[]).find((f: any) => f.id === fid)?.name ?? 'a filter';
          failed.push(`${fname}: ${e?.message ?? 'failed'}`);
        }
      }
      replBatchResultRef.current = { done, failed };
    }, {
      onSuccess: async () => {
        setReplTaskSubmitting(false);
        replTaskScan.setValue('');
        setReplTaskSelected(new Set());
        const res = replBatchResultRef.current;
        await mutateReplDue();
        if (online) { await mutate('/api/assets/instances'); await mutateIdentifiers(); }
        if (res && res.failed.length > 0) {
          // Stay on the task so the operator can retry the failed ones.
          setReplTaskError(`Replaced ${res.done}, ${res.failed.length} failed — ${res.failed.join('; ')}`);
        } else {
          setActiveReplTask(null);
        }
        replBatchResultRef.current = null;
      },
      onError: (e: any) => { setReplTaskError(e?.message ?? 'Failed to replace filters'); setReplTaskSubmitting(false); },
    });
  };

  const handleReplaceSubmit = () => {
    if (!replaceSelectedFilter || !replaceRemarks.trim()) return;
    const target = replaceSelectedFilter;
    setReplaceSubmitting(true);
    setReplaceError('');
    setReplaceSuccess('');
    // ONE shared reauth+network path with the web filter-list panel
    // (filter-lifecycle-actions.ts) so the two can never drift. The new filter
    // keeps the same RFID tag — replace() moves the identifier old → new.
    retireOrReplaceFilter(reauth, 'replace', target.id, replaceRemarks, {
      onSuccess: async (result) => {
        const newName = result?.newFilterName ?? 'new filter';
        const tagNote = result?.identifiersMoved ? ' · tag carried over' : '';
        setReplaceSuccess(`"${target.name}" replaced → ${newName}${tagNote}`);
        setReplaceSelectedFilter(null);
        setReplaceRemarks('');
        setReplaceSubmitting(false);
        // Refresh the master data so the retired filter drops out and the new
        // one appears with its carried-over tag.
        if (online) { await mutate('/api/assets/instances'); await mutateIdentifiers(); }
      },
      onError: (err: any) => {
        setReplaceError(err?.message ?? 'Failed to replace filter');
        setReplaceSubmitting(false);
      },
    });
  };

  // ---- My Tasks handlers ----
  const toggleTaskExpand = (entryId: string) => {
    setExpandedTasks(prev => {
      const next = new Set(prev);
      if (next.has(entryId)) next.delete(entryId);
      else next.add(entryId);
      return next;
    });
  };

  const performTask = (_task: any) => {
    // Jump straight into the operations view with WASH_IN pre-selected
    openStage('WASH_IN');
  };

  // ---- Approvals handlers ----
  const handleApprovalAction = (requestId: string, action: 'approve' | 'reject') => {
    setProcessingApproval(requestId);
    setError('');
    blockChangeApproval.process(requestId, action, approvalComment.trim(), {
      mutateKeys: approvalsKey ? [approvalsKey] : [],
      onSuccess: () => {
        setSuccess(`Request ${action === 'approve' ? 'approved' : 'rejected'}`);
        setApprovalComment('');
        // mutateApprovals is the SWR key-bound mutator; the hook also fires
        // mutate(approvalsKey) but we keep this for the local SWR instance.
        void mutateApprovals();
        setProcessingApproval(null);
      },
      onError: (e: any) => {
        setError(e.message ?? `Failed to ${action} request`);
        setProcessingApproval(null);
      },
    });
  };

  // Android hardware/gesture back button (Capacitor APK only — no-op on web).
  // Contract: dismiss the topmost overlay → else return to the Home view → else
  // (already Home) swallow. We deliberately NEVER call App.exitApp(): exiting
  // destroys the WebView and clears sessionStorage (where access_token lives),
  // which is exactly the "back button logged me out" behaviour being removed.
  // Lifecycle the OS still owns (not handled here, verified inherent):
  //   • minimise → process stays warm → session lives until the idle timeout
  //   • removed from recents → process killed → sessionStorage gone → re-login
  useAndroidBackButton(() => {
    // 1. Re-auth password prompts (rendered outside the view switch). Back
    //    cancels the prompt and unwinds the submit flags it was gating.
    if (reauth.isOpen) {
      reauth.cancel();
      setRfidSubmitting(false);
      setReplaceSubmitting(false);
      setReplTaskSubmitting(false);
      return;
    }
    if (blockChangeApproval.reauth.isOpen) {
      blockChangeApproval.reauth.cancel();
      setProcessingApproval(null);
      return;
    }
    // 2. Filter-lookup scan modal.
    if (scanRfidOpen) {
      setScanRfidOpen(false);
      return;
    }
    // 3. Anywhere but Home → return to Home, clearing transient sub-state so the
    //    next entry into a view starts clean.
    if (view !== 'home') {
      setView('home');
      setRfidSelectedFilter(null);
      setReplaceSelectedFilter(null);
      setSelectedCycleId(null);
      setActiveReplTask(null);
      return;
    }
    // 4. Already Home — stop here. No exit, no minimise, no logout.
    //    (HardCutoffBlocker, if shown, stays up regardless — back must not
    //    bypass the offline read-only overlay.)
  });

  // 2026-05-21 fix: only redirect when there is truly no auth state.
  // useAuth.logout()'s mutate(undefined, false) leaves the SWR cache for
  // /api/auth/me holding `undefined`. On the next login + this wrapper mount,
  // SWR returns isLoading=false immediately (cache "hit" with undefined) while
  // the new /api/auth/me request is still in flight, so `user` is briefly
  // undefined even though a fresh token sits in sessionStorage. Without the
  // token check below, the guard fired during that gap and bounced the
  // operator straight back to /m/login — the "page refresh on 1st login"
  // operators reported.
  const hasAuthTokenInStorage = !!sessionStorage.getItem('access_token');
  if (!authLoading && !user && !hasAuthTokenInStorage) {
    return <Navigate to="/m/login" replace />;
  }
  if (tabletAccess && allowedFeatures.length > 0 && !hasFeature('login')) {
    return <Navigate to="/m/login" replace />;
  }

  return (
    <div className="h-[100dvh] flex flex-col bg-gradient-to-b from-slate-50 to-slate-100 select-none overflow-hidden">
      {/* W6: connectivity ribbon — sticky at top of mobile shell. Renders
          green/red/orange based on online + sync state, with sync stage
          messages from the W5 engine events. */}
      <ConnectivityRibbon online={online} pendingCount={pendingCount} syncing={syncing} />
      <FailedOpsPanel />
      {/* --- HEADER --- */}
      <div className="bg-white/80 backdrop-blur-lg border-b border-slate-200/60 px-4 py-3 flex items-center justify-between shrink-0 z-10">
        <div className="flex items-center gap-3">
          {view !== 'home' && (
            <button onClick={goHome} className="w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center active:bg-slate-200">
              <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" /></svg>
            </button>
          )}
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center text-white text-xs font-extrabold shadow-lg shadow-cyan-500/20">DL</div>
          <div className="font-display text-sm font-semibold text-slate-800 leading-tight">DigiLog</div>
        </div>
        <div className="flex items-center gap-2">
          {/* Notification bell + unread badge */}
          <button onClick={() => setView('notifications')}
            className="relative w-9 h-9 rounded-xl bg-slate-100 flex items-center justify-center active:bg-slate-200"
            aria-label="Notifications">
            <svg className="w-5 h-5 text-slate-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.8} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" />
            </svg>
            {unreadCount > 0 && (
              <span className="absolute -top-1 -right-1 min-w-[16px] h-4 px-1 rounded-full bg-rose-500 text-white text-[9px] font-bold flex items-center justify-center">
                {unreadCount > 99 ? '99+' : unreadCount}
              </span>
            )}
          </button>
          <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium ${online ? 'bg-emerald-50 text-emerald-600 border border-emerald-200' : 'bg-red-50 text-red-600 border border-red-200'}`}>
            <div className={`w-1.5 h-1.5 rounded-full ${online ? 'bg-emerald-500' : 'bg-red-500 animate-pulse'}`} />
            {online ? 'Online' : 'Offline'}
          </div>
          {online && (
            <div className={`flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-medium ${dataCached ? 'bg-blue-50 text-blue-600 border border-blue-200' : 'bg-yellow-50 text-yellow-600 border border-yellow-200'}`}>
              <div className={`w-1.5 h-1.5 rounded-full ${dataCached ? 'bg-blue-500' : 'bg-yellow-400 animate-pulse'}`} />
              {dataCached ? 'Data Synced' : (syncProgress?.step?.replace('Syncing ', '').replace('...', '') || 'Syncing...')}
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
                {syncing ? '\u27F3 Syncing...' : `${pendingCount} pending \u2014 sync`}
              </button>
              <button onClick={async () => { if (confirm('Clear all pending operations? They will not be synced.')) { await clearQueue(); setSuccess('Queue cleared'); } }} className="px-1.5 py-1 bg-red-50 border border-red-200 rounded-full text-[10px] text-red-600 font-medium">
                \u2715
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Offline Banner */}
      {!online && <div className="mx-4 mt-2 px-3 py-2 bg-amber-50 border border-amber-200 rounded-xl text-[11px] text-amber-700 flex items-center gap-2">Working offline — operations queued for sync</div>}

      {/* Toast */}
      {success && <div className="mx-4 mt-2 px-4 py-3 bg-emerald-50 border border-emerald-200 rounded-xl text-sm text-emerald-700 font-medium shadow-sm">\u2713 {success}</div>}
      {error && <div className="mx-4 mt-2 px-4 py-3 bg-red-50 border border-red-200 rounded-xl text-sm text-red-700 shadow-sm">{error}</div>}

      {/* --- CONTENT ---
          `replacement-tasks` renders as a separate flex-1 sibling below (its
          own scroller). This main scroller must collapse (display:none) when
          that view is active — otherwise two flex-1 siblings split the height
          50/50, leaving the top half blank and pushing the task content into
          the bottom half. */}
      <div className={`flex-1 overflow-y-auto ${view === 'replacement-tasks' ? 'hidden' : ''}`}>

        {/* === HOME VIEW (2026-05-21 UI refresh — premium instrument-dashboard) ===
            Operator greeting → pipeline visualization → quick-action cards with
            live data → ghost utility row. Bricolage Grotesque display face +
            JetBrains Mono for counts. Staggered fade-in via animate-rise. */}
        {view === 'home' && (() => {
          const firstName = (user?.fullName ?? user?.username ?? 'Operator').split(/\s+/)[0];
          const hour = new Date().getHours();
          const greeting = hour < 5 ? 'Working late' : hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : hour < 21 ? 'Good evening' : 'Working late';
          return (
          <div className="bg-dot-grid min-h-full">
            <div className="p-4 space-y-4 max-w-2xl mx-auto">
              {/* === Greeting strip === */}
              <div className="animate-rise flex items-end justify-between gap-3 pt-1" style={{ animationDelay: '0ms' }}>
                <div className="min-w-0">
                  <div className="text-[11px] uppercase tracking-[0.18em] text-slate-400 font-medium">{greeting}</div>
                  <div className="flex items-baseline gap-2 min-w-0">
                    <h1 className="font-display text-[28px] font-semibold text-slate-900 leading-tight truncate">{firstName}</h1>
                    {user?.username && user.username !== firstName && (
                      <span className="font-mono-tab text-[13px] text-slate-500 font-medium leading-tight shrink-0">&middot; {user.username}</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1 shrink-0">
                  <div className="font-mono-tab text-[10px] text-slate-500 leading-none">{new Date().toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', timeZone: datetimeConfig.timezone }).toUpperCase()}</div>
                  <div className="inline-flex items-center gap-1.5 px-2 py-1 rounded-full bg-slate-900 text-white text-[10px] font-medium tracking-wide">
                    <span className="w-1.5 h-1.5 rounded-full bg-emerald-400" />
                    {user?.role?.replace('_', ' ') ?? 'OPERATOR'}
                  </div>
                </div>
              </div>

              {/* 2026-05-21 follow-up: removed Cleaning Pipeline hero + the
                  My Tasks / Approvals / Cycles cards on operator request.
                  Those views are still reachable via the wrapper's existing
                  setView() entry points (header chips / future bottom nav).
                  Home stays focused on the operator's primary task: tap a
                  scan station to start cleaning. */}

              {/* === Direct-stage scan stations === */}
              {hasFeature('filter_cleaning') && (
                <div className="animate-rise" style={{ animationDelay: '300ms' }}>
                  <div className="flex items-center justify-between mb-2 px-1">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400 font-medium">Scan stations</div>
                    <div className="font-mono-tab text-[10px] text-slate-400">tap to start</div>
                  </div>
                  <div className="grid grid-cols-3 gap-2.5">
                    {STAGES.map((stage) => (
                      <button key={stage.key} onClick={() => openStage(stage.key)}
                        className="tile-lift relative bg-white rounded-2xl border border-slate-200 p-3 text-left overflow-hidden">
                        <div className={`w-10 h-10 rounded-xl bg-gradient-to-br ${stage.gradient} grid place-items-center shadow-[0_4px_12px_-4px_rgba(15,23,42,0.25)] text-xl mb-2`}>
                          {stage.icon}
                        </div>
                        <div className="font-display text-[12px] font-semibold text-slate-900 leading-tight">{stage.label}</div>
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* === Cycles + RFID Assign — paired row === */}
              <div className="animate-rise grid grid-cols-2 gap-2.5 pt-1" style={{ animationDelay: '360ms' }}>
                <button onClick={() => setView('cycles')} className="tile-lift bg-white rounded-2xl border border-slate-200 px-4 py-3 flex items-center gap-2.5 text-left">
                  <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600 grid place-items-center text-white shrink-0">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2M9 12h6m-6 4h6" /></svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-[13px] font-semibold text-slate-900 leading-tight">Filter Cleaning Record</div>
                    <div className="text-[10px] text-slate-400 truncate">recent history</div>
                  </div>
                </button>
                {hasFeature('rfid_assign') && online ? (
                  <button onClick={() => setView('rfid-assign')} className="tile-lift bg-white rounded-2xl border border-slate-200 px-4 py-3 flex items-center gap-2.5 text-left">
                    <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-fuchsia-600 grid place-items-center text-white shrink-0">
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" /></svg>
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="font-display text-[13px] font-semibold text-slate-900 leading-tight">RFID Assign</div>
                      <div className="text-[10px] text-slate-400 truncate">tag &middot; untag</div>
                    </div>
                  </button>
                ) : <div className="bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 flex items-center gap-2.5 opacity-60">
                  <div className="w-8 h-8 rounded-lg bg-slate-200 grid place-items-center text-slate-400 shrink-0">
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M8.288 15.038a5.25 5.25 0 017.424 0M5.106 11.856c3.807-3.808 9.98-3.808 13.788 0M1.924 8.674c5.565-5.565 14.587-5.565 20.152 0M12.53 18.22l-.53.53-.53-.53a.75.75 0 011.06 0z" /></svg>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="font-display text-[13px] font-semibold text-slate-400 leading-tight">RFID Assign</div>
                    <div className="text-[10px] text-slate-400 truncate">offline</div>
                  </div>
                </div>}
              </div>

              {/* === Replace Filter — its own row (online-only) === */}
              {canReplace && (
                <div className="animate-rise" style={{ animationDelay: '390ms' }}>
                  {online ? (
                    <button onClick={() => { closeReplace(); setReplaceBlockId('all'); setReplaceAreaId('all'); setReplaceAhuId('all'); setReplaceFilterId('all'); setReplaceSearch(''); setView('replace'); }}
                      className="tile-lift w-full bg-white rounded-2xl border border-slate-200 px-4 py-3 flex items-center gap-2.5 text-left">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-600 grid place-items-center text-white shrink-0">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-display text-[13px] font-semibold text-slate-900 leading-tight">Replace Filter</div>
                        <div className="text-[10px] text-slate-400 truncate">retire old &middot; create new &middot; same tag</div>
                      </div>
                    </button>
                  ) : (
                    <div className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 flex items-center gap-2.5 opacity-60">
                      <div className="w-8 h-8 rounded-lg bg-slate-200 grid place-items-center text-slate-400 shrink-0">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-display text-[13px] font-semibold text-slate-400 leading-tight">Replace Filter</div>
                        <div className="text-[10px] text-slate-400 truncate">offline — needs connection</div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* === Replacement Tasks — separate tile → own page (online-only) === */}
              {canReplacementTasks && (
                <div className="animate-rise" style={{ animationDelay: '405ms' }}>
                  {online ? (
                    <button onClick={() => { setActiveReplTask(null); replTaskScan.setValue(''); setReplTaskError(''); setView('replacement-tasks'); }}
                      className="tile-lift w-full bg-white rounded-2xl border border-slate-200 px-4 py-3 flex items-center gap-2.5 text-left">
                      <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-rose-500 to-pink-600 grid place-items-center text-white shrink-0">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-display text-[13px] font-semibold text-slate-900 leading-tight">Replacement Tasks</div>
                        <div className="text-[10px] text-slate-400 truncate">scheduled filter replacements due</div>
                      </div>
                      {replDueTasks.length > 0 && (
                        <span className="text-[11px] font-bold text-white bg-rose-500 rounded-full px-2 py-0.5 shrink-0">{replDueTasks.length}</span>
                      )}
                    </button>
                  ) : (
                    <div className="w-full bg-slate-50 border border-slate-100 rounded-2xl px-4 py-3 flex items-center gap-2.5 opacity-60">
                      <div className="w-8 h-8 rounded-lg bg-slate-200 grid place-items-center text-slate-400 shrink-0">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z" /></svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="font-display text-[13px] font-semibold text-slate-400 leading-tight">Replacement Tasks</div>
                        <div className="text-[10px] text-slate-400 truncate">offline — needs connection</div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* === Logout — its own row === */}
              {hasFeature('logout') && (
                <button onClick={logout} className="animate-rise tile-lift w-full bg-white rounded-2xl border border-rose-200 px-4 py-3.5 flex items-center justify-center gap-2.5 text-rose-600 font-display text-[13px] font-semibold active:bg-rose-50" style={{ animationDelay: '420ms' }}>
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" /></svg>
                  Logout
                </button>
              )}

              {/* === Footer build tag === */}
              <div className="pt-2 pb-1 text-center font-mono-tab text-[9px] tracking-[0.2em] text-slate-300 uppercase">
                DigiLog v1.0 &middot; 21 CFR Part 11
              </div>
            </div>
          </div>
          );
        })()}

        {/* === STATUS VIEW === */}
        {view === 'status' && (() => {
          // 2026-05-20: stage cards now filter the list below (read-only
          // drill-down) instead of routing to the scan-operations page.
          // Operators tapped them expecting "show me everything in WASH_IN"
          // but got dropped into the queueing flow — confusing and wrong.
          //
          // For each filter we look up:
          //   - AHU name via instances.find(parentId)
          //   - Last cleaned timestamp via the most recent cleaning-stage EVENT
          //     across the filter's cycles (loaded with includeEvents when
          //     view==='status'), so it moves on every stage — not just on
          //     full-cycle completion.
          const cycles: any[] = (cyclesData?.data ?? []) as any[];
          const lastCleanedByFilter = new Map<string, string>();
          for (const c of cycles) {
            if (!c.filterId) continue;
            for (const ev of (c.events ?? [])) {
              if (!CLEANING_STAGE_EVENTS.has(ev.eventType) || !ev.performedAt) continue;
              const prev = lastCleanedByFilter.get(c.filterId);
              if (!prev || ev.performedAt > prev) lastCleanedByFilter.set(c.filterId, ev.performedAt);
            }
          }
          // 2026-05-21: walk the hierarchy filter→AHU→Area→Block. Each instance
          // row carries `parentId`; we use that to build per-filter ancestry,
          // then derive distinct sets at each tier for the cascading dropdowns.
          const instById = new Map((instances as any[]).map((i: any) => [i.id, i] as [string, any]));
          const ahuById = instById;
          // Ancestry is resolved by template KIND, not by depth: an AHU sits
          // either under an Area or DIRECTLY under a Block (see the hierarchy
          // note in lib/ahu-block-map.ts — both are legal). Walking positionally
          // mislabelled a Block as the area for the 3 block-parented AHUs, so
          // their 28 filters reported blockId:null and vanished from the Status
          // tab whenever a block was selected.
          const filterAncestors = new Map<string, FilterAncestry>();
          for (const f of (allFilters as any[])) {
            filterAncestors.set(f.id, resolveAncestry(f, instById, kindOfInstance));
          }
          const allBlockIds = new Set<string>();
          const allAreaIds = new Set<string>();
          const allAhuIds = new Set<string>();
          for (const a of filterAncestors.values()) {
            if (a.blockId) allBlockIds.add(a.blockId);
            if (a.areaId) allAreaIds.add(a.areaId);
            if (a.ahuId) allAhuIds.add(a.ahuId);
          }
          const sortByName = (a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
          const blockOptions = [...allBlockIds].map((id) => instById.get(id)).filter(Boolean).sort(sortByName);
          const areaOptions = [...allAreaIds]
            .map((id) => instById.get(id)).filter(Boolean)
            .filter((area: any) => statusBlockId === 'all' || area.parentId === statusBlockId)
            .sort(sortByName);
          const ahuOptionsStatus = [...allAhuIds]
            .map((id) => instById.get(id)).filter(Boolean)
            .filter((ahu: any) => {
              // Kind-aware: a block-parented AHU has no area, and its block is
              // its DIRECT parent. Walking ahu.parent.parent for the block drops
              // it from this dropdown entirely.
              const anc = resolveAncestry(ahu, instById, kindOfInstance);
              if (statusAreaId !== 'all' && anc.areaId !== statusAreaId) return false;
              if (statusBlockId !== 'all' && anc.blockId !== statusBlockId) return false;
              return true;
            })
            .sort(sortByName);
          const filterOptionsStatus = (allFilters as any[])
            .filter((f: any) => {
              const a = filterAncestors.get(f.id);
              if (!a) return false;
              if (statusBlockId !== 'all' && a.blockId !== statusBlockId) return false;
              if (statusAreaId !== 'all' && a.areaId !== statusAreaId) return false;
              if (statusAhuId !== 'all' && a.ahuId !== statusAhuId) return false;
              return true;
            })
            .slice()
            .sort(sortByName);
          // Searchable-select option lists. 'All' is kept as the first entry so
          // the sentinel 'all' value keeps driving the cascade unchanged.
          const statusAhuSelectOptions = [
            { value: 'all', label: 'All' },
            ...ahuOptionsStatus.map((a: any) => ({ value: a.id, label: a.name })),
          ];
          const statusFilterSelectOptions = [
            { value: 'all', label: 'All' },
            ...filterOptionsStatus.map((f: any) => ({ value: f.id, label: f.name })),
          ];
          // One scoped array feeds BOTH the stage tiles and the list, so a tile
          // count can never disagree with the rows underneath it.
          const cascadeScoped = scopeFiltersToCascade(allFilters as any[], filterAncestors, {
            blockId: statusBlockId,
            areaId: statusAreaId,
            ahuId: statusAhuId,
            filterId: statusFilterId,
          });
          // Counts deliberately ignore statusStageFilter: including it would
          // zero every other tile the moment one is picked.
          const stageCounts = countByStage(cascadeScoped);
          const visibleFilters = cascadeScoped.filter((f: any) => {
            if (statusStageFilter && f.currentLifecycleState !== statusStageFilter) return false;
            return true;
          });
          const cascadeActive = statusBlockId !== 'all' || statusAreaId !== 'all' || statusAhuId !== 'all' || statusFilterId !== 'all';
          return (
          <div className="p-4 space-y-4">
            {/* 2026-05-26: header row — title + Scan RFID quick action.
                Tapping the button opens a modal that looks up the scanned
                tag against the cached identifier list and shows the
                mapped filter's current state + Block→Area→AHU hierarchy. */}
            <div className="flex items-center justify-between gap-3">
              <h2 className="text-lg font-bold text-slate-800">Filter Status</h2>
              <button
                onClick={() => { setScanRfidValue(''); setScanRfidError(''); setScanRfidOpen(true); }}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-white bg-gradient-to-r from-violet-500 to-purple-600 shadow-md shadow-violet-500/20 active:shadow-none"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8.111 16.404a5.5 5.5 0 017.778 0M12 20h.01m-7.08-7.071c3.904-3.905 10.236-3.905 14.141 0M1.394 9.393c5.857-5.857 15.355-5.857 21.213 0" /></svg>
                Scan RFID
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3">
              {STAGES.map(s => {
                const isActive = statusStageFilter === s.key;
                return (
                  <button
                    key={s.key}
                    onClick={() => setStatusStageFilter(isActive ? null : s.key)}
                    className={`bg-white border-2 rounded-xl p-4 text-left active:scale-[0.98] transition-all ${isActive ? 'border-cyan-500 shadow-md' : s.border}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-lg">{s.icon}</span>
                      <span className="text-xs font-semibold text-slate-600">{s.label}</span>
                    </div>
                    <div className={`text-2xl font-bold ${s.text}`}>{stageCounts[s.key] ?? 0}</div>
                  </button>
                );
              })}
            </div>
            {statusStageFilter && (
              <button
                onClick={() => setStatusStageFilter(null)}
                className="text-xs text-cyan-600 font-medium underline active:text-cyan-700"
              >
                Show all filters
              </button>
            )}
            <div className="space-y-2">
              <div className="flex items-baseline justify-between">
                <h3 className="text-sm font-semibold text-slate-600">
                  {statusStageFilter
                    ? `${STATUS_STAGE_OPTIONS.find(o => o.value === statusStageFilter)?.label ?? 'Filters'} (${visibleFilters.length})`
                    : `All Filters (${visibleFilters.length})`}
                </h3>
                {cascadeActive && (
                  <button
                    onClick={() => { setStatusBlockId('all'); setStatusAreaId('all'); setStatusAhuId('all'); setStatusFilterId('all'); }}
                    className="text-[11px] text-cyan-600 font-medium underline active:text-cyan-700"
                  >clear</button>
                )}
              </div>

              {/* 4-up hierarchy dropdown row: Block / Area / AHU / Filter */}
              <div className="bg-white rounded-2xl border border-slate-200 p-2 grid grid-cols-4 gap-1.5">
                <div>
                  <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">Block</label>
                  <select
                    value={statusBlockId}
                    onChange={(e) => {
                      const v = e.target.value;
                      setStatusBlockId(v);
                      // cascade-reset descendants if they no longer fit
                      if (v !== 'all') {
                        if (statusAreaId !== 'all') {
                          const area = instById.get(statusAreaId);
                          if (!area || area.parentId !== v) setStatusAreaId('all');
                        }
                        if (statusAhuId !== 'all') {
                          const ahu = instById.get(statusAhuId);
                          // Kind-aware: a block-parented AHU still belongs to the
                          // chosen block; the old area-hop reset it to 'all'.
                          const ahuBlockId = ahu ? resolveAncestry(ahu, instById, kindOfInstance).blockId : null;
                          if (ahuBlockId !== v) setStatusAhuId('all');
                        }
                        if (statusFilterId !== 'all') {
                          const anc = filterAncestors.get(statusFilterId);
                          if (anc?.blockId !== v) setStatusFilterId('all');
                        }
                      }
                    }}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:outline-none focus:border-cyan-500 focus:bg-white truncate"
                  >
                    <option value="all">All</option>
                    {blockOptions.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">Area</label>
                  <select
                    value={statusAreaId}
                    onChange={(e) => {
                      const v = e.target.value;
                      setStatusAreaId(v);
                      if (v !== 'all') {
                        if (statusAhuId !== 'all') {
                          const ahu = instById.get(statusAhuId);
                          if (!ahu || ahu.parentId !== v) setStatusAhuId('all');
                        }
                        if (statusFilterId !== 'all') {
                          const anc = filterAncestors.get(statusFilterId);
                          if (anc?.areaId !== v) setStatusFilterId('all');
                        }
                      }
                    }}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:outline-none focus:border-cyan-500 focus:bg-white truncate"
                  >
                    <option value="all">All</option>
                    {areaOptions.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">AHU</label>
                  <SearchableSelect
                    value={statusAhuId}
                    onChange={(v) => {
                      setStatusAhuId(v);
                      if (v !== 'all' && statusFilterId !== 'all') {
                        const anc = filterAncestors.get(statusFilterId);
                        if (anc?.ahuId !== v) setStatusFilterId('all');
                      }
                    }}
                    options={statusAhuSelectOptions}
                    searchPlaceholder="Search AHU…"
                    align="right"
                    triggerClassName="h-auto bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:border-cyan-500 focus:ring-0 focus:bg-white shadow-none hover:shadow-none"
                  />
                </div>
                <div>
                  <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">Filter</label>
                  <SearchableSelect
                    value={statusFilterId}
                    onChange={setStatusFilterId}
                    options={statusFilterSelectOptions}
                    searchPlaceholder="Search filter…"
                    align="right"
                    triggerClassName="h-auto bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:border-cyan-500 focus:ring-0 focus:bg-white shadow-none hover:shadow-none"
                  />
                </div>
                {/* Stage sits on its own row: it is filter STATE, not hierarchy,
                    and five columns would leave no room for "Storage Out". */}
                <div className="col-span-4">
                  <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">Stage</label>
                  <select
                    value={statusStageFilter ?? 'all'}
                    onChange={(e) => setStatusStageFilter(e.target.value === 'all' ? null : e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:outline-none focus:border-cyan-500 focus:bg-white truncate"
                  >
                    {STATUS_STAGE_OPTIONS.map((o) => (
                      <option key={o.value} value={o.value}>{o.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {visibleFilters.map((f: any) => {
                const stageInfo = STAGES.find(s => s.key === f.currentLifecycleState);
                const ahu = ahuById.get(f.parentId);
                // Prefer the server's authoritative lastCleanedAt (lib/last-cleaned.ts);
                // fall back to the client cycle-derivation only when offline / absent.
                const lastCleaned = f.lastCleanedAt ?? effectiveLastCleaned(lastCleanedByFilter.get(f.id), f.attributes);
                return (
                  <div key={f.id} className="bg-white border border-slate-200 rounded-xl px-4 py-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm font-medium text-slate-800 truncate">{f.name}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          AHU: <span className="text-slate-700">{ahu?.name ?? '—'}</span>
                        </div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          Last Cleaned: <span className="text-slate-700">{lastCleaned ? formatDateTime(lastCleaned) : '—'}</span>
                        </div>
                      </div>
                      <span className={`text-[10px] px-2.5 py-1 rounded-full border font-medium whitespace-nowrap ${stageInfo ? `${stageInfo.bg} ${stageInfo.text} ${stageInfo.border}` : 'bg-slate-50 text-slate-400 border-slate-200'}`}>
                        {f.currentLifecycleState?.replace(/_/g, ' ') ?? 'To Be Cleaned'}
                      </span>
                    </div>
                  </div>
                );
              })}
              {visibleFilters.length === 0 && (
                <div className="text-sm text-slate-400 text-center py-6">No filters in this stage</div>
              )}
            </div>
          </div>
          );
        })()}

        {/* === MY TASKS VIEW === */}
        {view === 'my-tasks' && (
          <div className="p-4 space-y-4">
            <div>
              <h2 className="text-lg font-bold text-slate-800">My Tasks</h2>
              <p className="text-xs text-slate-500 mt-0.5">AHUs due for cleaning per PM schedules — filter by period, block, area or status</p>
            </div>

            {(online || tasksSource) && (
              <div className="space-y-2">
                {/* Status category toggle */}
                <div className="grid grid-cols-4 gap-1.5">
                  {([
                    ['all', 'All', taskCounts.all],
                    ['pending', 'Pending', taskCounts.pending],
                    ['completed', 'Completed', taskCounts.completed],
                    ['overdue', 'Overdue', taskCounts.overdue],
                  ] as const).map(([key, label, count]) => {
                    const active = taskStatus === key;
                    return (
                      <button
                        key={key}
                        onClick={() => setTaskStatus(key)}
                        className={`flex flex-col items-center justify-center py-2 rounded-xl text-xs font-semibold border transition-colors ${
                          active
                            ? (key === 'overdue' ? 'bg-rose-600 text-white border-rose-600' : 'bg-gradient-to-r from-teal-600 to-cyan-600 text-white border-transparent')
                            : 'bg-white text-slate-600 border-slate-200'
                        }`}
                      >
                        <span>{label}</span>
                        <span className={`mt-0.5 text-[10px] ${active ? 'text-white/80' : 'text-slate-400'}`}>{count}</span>
                      </button>
                    );
                  })}
                </div>

                {/* Search + collapsible-filters toggle */}
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <svg className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                    </svg>
                    <input
                      type="text"
                      value={taskSearch}
                      onChange={e => setTaskSearch(e.target.value)}
                      placeholder="Search AHU, block or area…"
                      className="w-full bg-white border border-slate-200 rounded-xl pl-9 pr-3 py-2 text-sm text-slate-700 placeholder:text-slate-400 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 outline-none"
                    />
                  </div>
                  <button
                    onClick={() => setTaskFiltersOpen(o => !o)}
                    className={`px-3 rounded-xl border text-sm font-semibold flex items-center gap-1 ${taskFiltersActive ? 'border-cyan-300 text-cyan-700 bg-cyan-50' : 'border-slate-200 text-slate-600 bg-white'}`}
                  >
                    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 4h18M6 8h12M10 12h4M11 16h2" />
                    </svg>
                    Filters
                  </button>
                </div>

                {/* Collapsible: time period + block + area + clear */}
                {taskFiltersOpen && (
                  <div className="bg-white border border-slate-200 rounded-xl p-3 space-y-3">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">From</label>
                        <input type="date" disabled={!online} value={taskFrom} onChange={e => setTaskFrom(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-sm text-slate-700 outline-none focus:border-cyan-400 disabled:opacity-50" />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">To</label>
                        <input type="date" disabled={!online} value={taskTo} onChange={e => setTaskTo(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-sm text-slate-700 outline-none focus:border-cyan-400 disabled:opacity-50" />
                      </div>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Block</label>
                        <select value={taskBlock} onChange={e => { setTaskBlock(e.target.value); setTaskArea(''); }}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-sm text-slate-700 outline-none focus:border-cyan-400">
                          <option value="">All blocks</option>
                          {taskBlockOptions.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">Area</label>
                        <select value={taskArea} onChange={e => setTaskArea(e.target.value)}
                          className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-sm text-slate-700 outline-none focus:border-cyan-400">
                          <option value="">All areas</option>
                          {taskAreaOptions.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                        </select>
                      </div>
                    </div>
                    {!online && <p className="text-[10px] text-slate-400">Date period needs an internet connection.</p>}
                    {taskFiltersActive && (
                      <button onClick={clearTaskFilters} className="w-full py-2 rounded-lg text-xs font-semibold text-slate-500 border border-slate-200 hover:bg-slate-50">
                        Clear all filters
                      </button>
                    )}
                  </div>
                )}
              </div>
            )}

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

            {!dueTasksLoading && visibleDueTasks.length === 0 && visibleOverdueTasks.length === 0 && (
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="h-1.5 bg-gradient-to-r from-teal-400 to-cyan-500" />
                <div className="p-10 text-center">
                  <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-teal-50 to-cyan-50 flex items-center justify-center">
                    <span className="text-3xl">{'\u{1F3AF}'}</span>
                  </div>
                  <div className="text-sm font-semibold text-slate-700">{taskFiltersActive ? 'No matching tasks' : 'Nothing due right now'}</div>
                  <div className="text-xs text-slate-400 mt-1">{taskFiltersActive ? 'Try adjusting or clearing the filters' : 'Tasks appear when a schedule window opens'}</div>
                </div>
              </div>
            )}

            {visibleDueTasks.map((task: any) => {
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
                            {formatTime(new Date(task.plannedDate))} {'\u2022'} {task.cleanedCount}/{task.totalFilters} cleaned
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
                              return (
                                <span key={f.filterId} className={`inline-flex text-[10px] px-2 py-1 rounded-md border font-semibold ${cls}`}>
                                  {f.filterName}
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
                        Perform {'\u2192'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}

            {visibleOverdueTasks.length > 0 && (
              <div className="space-y-3 pt-2">
                <div className="flex items-center gap-2">
                  <span className="text-rose-600 text-sm">{'\u26A0'}</span>
                  <h3 className="text-sm font-bold text-slate-800">Overdue</h3>
                </div>
                {(visibleOverdueTasks as any[]).map((task: any) => (
                  <div key={task.entryId} className="bg-white border border-rose-200 rounded-2xl overflow-hidden shadow-sm">
                    <div className="h-1.5 bg-gradient-to-r from-rose-400 to-rose-500" />
                    <div className="p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0 flex-1">
                          <h3 className="text-base font-bold text-slate-800 truncate">{task.ahuName}</h3>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            Window closed {formatTime(new Date(task.windowEnd))} {'\u2022'} {task.cleanedCount}/{task.totalFilters} cleaned
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
                        Perform (overdue) {'\u2192'}
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* === APPROVALS VIEW === */}
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

            {online && !approvalsLoading && approvals.length === 0 && (
              <div className="bg-white border border-slate-200 rounded-2xl overflow-hidden">
                <div className="h-1.5 bg-gradient-to-r from-amber-400 to-orange-500" />
                <div className="p-10 text-center">
                  <div className="w-14 h-14 mx-auto mb-3 rounded-2xl bg-gradient-to-br from-amber-50 to-orange-50 flex items-center justify-center">
                    <span className="text-3xl">{'\u2705'}</span>
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
              // Per-status styling
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
                          Requested by {req.requestedByName ?? req.requestedBy} {'\u2022'} {req.createdAt ? formatTime(new Date(req.createdAt)) : ''}
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
                            {req.processedByName ?? '\u2014'}
                            {req.processedAt ? ` \u2022 ${formatTime(new Date(req.processedAt))}` : ''}
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
                          {processing ? '\u2026' : 'Reject'}
                        </button>
                        <button
                          onClick={() => handleApprovalAction(req.id, 'approve')}
                          disabled={processing || !(processingApproval === req.id && approvalComment.trim())}
                          className="flex-1 py-2.5 bg-gradient-to-r from-emerald-600 to-teal-600 text-white rounded-xl text-sm font-semibold shadow-lg shadow-emerald-500/25 active:shadow-none disabled:opacity-50"
                        >
                          {processing ? '\u2026' : 'Approve'}
                        </button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}

        {/* === NOTIFICATIONS VIEW === */}
        {view === 'notifications' && (
          <div className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-base font-bold text-slate-800">Notifications</h2>
              {unreadCount > 0 && (
                <button onClick={markAllNotifsRead} className="text-[12px] text-cyan-600 font-semibold active:text-cyan-700">Mark all read</button>
              )}
            </div>
            {!online ? (
              <div className="text-center py-16 text-[13px] text-slate-400">Notifications need a connection.</div>
            ) : notifications.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <svg className="w-12 h-12 text-slate-200" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.2} d="M15 17h5l-1.405-1.405A2.032 2.032 0 0118 14.158V11a6.002 6.002 0 00-4-5.659V5a2 2 0 10-4 0v.341C7.67 6.165 6 8.388 6 11v3.159c0 .538-.214 1.055-.595 1.436L4 17h5m6 0v1a3 3 0 11-6 0v-1m6 0H9" /></svg>
                <span className="text-[13px] text-slate-400 font-medium">No notifications</span>
              </div>
            ) : (
              notifications.map((n: any) => {
                const isOverdue = n.type === 'PM_OVERDUE';
                const isDone = n.type === 'PM_OVERDUE_COMPLETED';
                return (
                  <button key={n.id} onClick={() => markNotifRead(n)}
                    className={`w-full text-left rounded-2xl border px-4 py-3 active:opacity-80 transition-opacity ${n.isRead ? 'bg-white border-slate-200' : 'bg-cyan-50/40 border-cyan-200'}`}>
                    <div className="flex items-start gap-2.5">
                      {!n.isRead && <span className="w-2 h-2 rounded-full bg-cyan-500 mt-1.5 shrink-0" />}
                      <div className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 ${isOverdue ? 'bg-rose-50 text-rose-600' : isDone ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-500'}`}>
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          {isDone
                            ? <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                            : <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />}
                        </svg>
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] font-semibold text-slate-800">{n.title}</div>
                        <div className="text-[12px] text-slate-600 mt-0.5 leading-snug">{n.message}</div>
                        <div className="text-[10px] text-slate-400 mt-1">{formatDateTime(n.createdAt)}</div>
                      </div>
                    </div>
                  </button>
                );
              })
            )}
          </div>
        )}

        {/* === OPERATIONS VIEW (renders MobileOperationsPage with proper offline support) === */}
        {view === 'operations' && (
          <div className="flex-1 overflow-y-auto">
            <MobileOperationsPage initialStageKey={selectedStageKey ?? undefined} hideHeader />
          </div>
        )}

        {/* === CLEANING CYCLES VIEW — list with filters (2026-05-21) ===
            From + To datetime + filter dropdown narrow the list. Cards show
            date AND time. Tap → setSelectedCycleId + view='cycle-detail'. */}
        {view === 'cycles' && (
          <div className="p-4 space-y-3 max-w-2xl mx-auto">
            <div className="flex items-baseline justify-between">
              <div>
                <h2 className="font-display text-[22px] font-semibold text-slate-900 leading-tight">Filter Cleaning Record</h2>
                <p className="text-[11px] text-slate-500 mt-0.5 font-mono-tab">
                  showing <span className="text-slate-700 font-semibold">{filteredCyclesList.length}</span> of {cyclesList.length}
                </p>
              </div>
              {(cycleAhuId !== 'all' || cycleFilterId !== 'all' || cycleFrom || cycleTo) && (
                <button
                  onClick={() => { setCycleAhuId('all'); setCycleFilterId('all'); setCycleFrom(''); setCycleTo(''); }}
                  className="text-[11px] text-cyan-600 font-medium underline active:text-cyan-700"
                >clear filters</button>
              )}
            </div>

            {/* Filter strip — AHU + Filter side-by-side, then From / To side-by-side */}
            <div className="bg-white rounded-2xl border border-slate-200 p-3 space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] uppercase tracking-[0.15em] text-slate-400 font-medium mb-1">AHU</label>
                  <select
                    value={cycleAhuId}
                    onChange={(e) => {
                      const nextAhu = e.target.value;
                      setCycleAhuId(nextAhu);
                      // If the currently-selected filter doesn't belong to the new AHU, reset it.
                      if (nextAhu !== 'all' && cycleFilterId !== 'all') {
                        const stillValid = (allFilters as any[]).some((f: any) => f.id === cycleFilterId && f.parentId === nextAhu);
                        if (!stillValid) setCycleFilterId('all');
                      }
                    }}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 font-medium focus:outline-none focus:border-cyan-500 focus:bg-white"
                  >
                    <option value="all">All AHUs</option>
                    {ahuOptions.map((a: any) => (
                      <option key={a.id} value={a.id}>{a.name}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-[0.15em] text-slate-400 font-medium mb-1">Filter</label>
                  <select
                    value={cycleFilterId}
                    onChange={(e) => setCycleFilterId(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 text-sm text-slate-800 font-medium focus:outline-none focus:border-cyan-500 focus:bg-white"
                  >
                    <option value="all">All filters</option>
                    {filterOptionsForAhu.slice().sort((a: any, b: any) => (a.name ?? '').localeCompare(b.name ?? '')).map((f: any) => (
                      <option key={f.id} value={f.id}>{f.name}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-[10px] uppercase tracking-[0.15em] text-slate-400 font-medium mb-1">From</label>
                  <input
                    type="datetime-local"
                    value={cycleFrom}
                    onChange={(e) => setCycleFrom(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-[12px] text-slate-800 font-mono-tab focus:outline-none focus:border-cyan-500 focus:bg-white"
                  />
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-[0.15em] text-slate-400 font-medium mb-1">To</label>
                  <input
                    type="datetime-local"
                    value={cycleTo}
                    onChange={(e) => setCycleTo(e.target.value)}
                    className="w-full bg-slate-50 border border-slate-200 rounded-lg px-2 py-2 text-[12px] text-slate-800 font-mono-tab focus:outline-none focus:border-cyan-500 focus:bg-white"
                  />
                </div>
              </div>
            </div>

            {!online && (
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-xs text-amber-700">
                Offline &mdash; showing last cached snapshot. Reconnect to refresh.
              </div>
            )}
            {online && cyclesLoading && (
              <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => (
                <div key={i} className="bg-white border border-slate-200 rounded-2xl h-24 animate-pulse" />
              ))}</div>
            )}
            {filteredCyclesList.length === 0 && !cyclesLoading && (
              <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center text-sm text-slate-500">
                {cyclesList.length === 0 ? 'No cleaning cycles yet.' : 'No cycles match these filters.'}
              </div>
            )}
            {filteredCyclesList.map((cyc: any) => {
              const statusUi = cycleStatusUi(cyc);
              const statusBadge = statusUi.badge;
              const durSec = cyc.completedAt
                ? Math.max(0, Math.floor((new Date(cyc.completedAt).getTime() - new Date(cyc.startedAt).getTime()) / 1000))
                : Math.max(0, Math.floor((Date.now() - new Date(cyc.startedAt).getTime()) / 1000));
              const durLabel = durSec >= 3600
                ? `${Math.floor(durSec / 3600)}h ${Math.floor((durSec % 3600) / 60)}m`
                : `${Math.floor(durSec / 60)}m ${durSec % 60}s`;
              return (
                <button key={cyc.id} onClick={() => { setSelectedCycleId(cyc.id); setView('cycle-detail'); }}
                  className="tile-lift w-full bg-white rounded-2xl border border-slate-200 p-3.5 shadow-sm text-left">
                  <div className="flex items-start justify-between gap-2">
                    <div className="flex-1 min-w-0">
                      <div className="font-display text-[14px] font-semibold text-slate-900 truncate leading-tight">{cyc.filter?.name ?? cyc.filterName ?? cyc.cycleCode}</div>
                      <div className="text-[11px] text-slate-400 truncate font-mono-tab mt-0.5">{cyc.cycleCode}</div>
                    </div>
                    <span className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold border ${statusBadge}`}>
                      {statusUi.label}
                    </span>
                  </div>
                  <div className="mt-2.5 grid grid-cols-3 gap-2">
                    <div>
                      <div className="text-[9.5px] uppercase tracking-wider text-slate-400 font-medium">Started</div>
                      <div className="text-[11.5px] text-slate-800 font-mono-tab leading-tight mt-0.5">{formatDate(cyc.startedAt)}</div>
                      <div className="text-[10.5px] text-slate-500 font-mono-tab leading-tight">{formatTime(new Date(cyc.startedAt))}</div>
                    </div>
                    <div>
                      <div className="text-[9.5px] uppercase tracking-wider text-slate-400 font-medium">Duration</div>
                      <div className="text-[11.5px] text-slate-800 font-mono-tab leading-tight mt-0.5">{durLabel}</div>
                    </div>
                    <div>
                      <div className="text-[9.5px] uppercase tracking-wider text-slate-400 font-medium">Reason</div>
                      <div className="text-[11.5px] text-slate-700 font-medium truncate leading-tight mt-0.5">{cyc.cleaningReasonLabel ?? '—'}</div>
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}

        {/* === CLEANING CYCLE DETAIL — full event timeline (2026-05-21) ===
            Mirrors apps/web/src/routes/cleaning-cycles/timeline.tsx but on the
            tablet. Shows stage transitions (with date+time), instrument
            readings, and checklist Q&A from cycle.events[].enrichedAnswers. */}
        {view === 'cycle-detail' && (() => {
          const STAGE_LABELS: Record<string, string> = {
            WASH_IN: 'Wash In', WASH_OUT: 'Wash Out', DRY_IN: 'Dry In', DRY_OUT: 'Dry Out',
            STORAGE_IN: 'Storage In', STORAGE_OUT: 'Storage Out', START: 'Start', END: 'End',
          };
          const EVENT_STYLE: Record<string, { label: string; dot: string; ring: string; bg: string }> = {
            CYCLE_STARTED:       { label: 'Cycle Started',       dot: 'bg-cyan-500',    ring: 'ring-cyan-200',    bg: 'bg-cyan-50/60' },
            STATE_TRANSITION:    { label: 'Stage Moved',         dot: 'bg-blue-500',    ring: 'ring-blue-200',    bg: 'bg-blue-50/60' },
            PARAMETER_CAPTURE:   { label: 'Readings Captured',   dot: 'bg-purple-500',  ring: 'ring-purple-200',  bg: 'bg-purple-50/60' },
            CHECKLIST_COMPLETED: { label: 'Checklist Submitted', dot: 'bg-emerald-500', ring: 'ring-emerald-200', bg: 'bg-emerald-50/60' },
            BYPASS_DEVIATION:    { label: 'Bypass Deviation',    dot: 'bg-rose-500',    ring: 'ring-rose-200',    bg: 'bg-rose-50/60' },
            EQUIPMENT_LINKED:    { label: 'Equipment Linked',    dot: 'bg-amber-500',   ring: 'ring-amber-200',   bg: 'bg-amber-50/60' },
            CYCLE_COMPLETED:     { label: 'Cycle Completed',     dot: 'bg-emerald-600', ring: 'ring-emerald-200', bg: 'bg-emerald-50/60' },
            APPROVAL_GRANTED:    { label: 'Approval Granted',    dot: 'bg-emerald-500', ring: 'ring-emerald-200', bg: 'bg-emerald-50/60' },
            REMARK_ADDED:        { label: 'Remark Added',        dot: 'bg-slate-500',   ring: 'ring-slate-200',   bg: 'bg-slate-50/60' },
          };
          const goBackToCycles = () => { setSelectedCycleId(null); setView('cycles'); };
          if (cycleDetailLoading && !cycleDetail) {
            return (
              <div className="p-4 space-y-3 max-w-2xl mx-auto">
                <button onClick={goBackToCycles} className="text-[12px] text-slate-500 font-medium inline-flex items-center gap-1 active:text-slate-700">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                  Back
                </button>
                <div className="bg-white rounded-2xl border border-slate-200 p-8 grid place-items-center">
                  <div className="w-7 h-7 border-2 border-cyan-500 border-t-transparent rounded-full animate-spin" />
                </div>
              </div>
            );
          }
          if (!cycleDetail) {
            return (
              <div className="p-4 space-y-3 max-w-2xl mx-auto">
                <button onClick={goBackToCycles} className="text-[12px] text-slate-500 font-medium inline-flex items-center gap-1 active:text-slate-700">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                  Back to Cycles
                </button>
                <div className="bg-white rounded-2xl border border-slate-200 p-8 text-center text-sm text-slate-500">Cycle not found.</div>
              </div>
            );
          }
          const events = (cycleDetail.events ?? []) as any[];
          const durSec = cycleDetail.completedAt
            ? Math.max(0, Math.floor((new Date(cycleDetail.completedAt).getTime() - new Date(cycleDetail.startedAt).getTime()) / 1000))
            : Math.max(0, Math.floor((Date.now() - new Date(cycleDetail.startedAt).getTime()) / 1000));
          const durLabel = durSec >= 3600
            ? `${Math.floor(durSec / 3600)}h ${Math.floor((durSec % 3600) / 60)}m`
            : `${Math.floor(durSec / 60)}m ${durSec % 60}s`;
          const detailStatusUi = cycleStatusUi(cycleDetail);
          const statusBadge = detailStatusUi.badge;
          return (
            <div className="p-4 space-y-3 max-w-2xl mx-auto">
              {/* Header strip */}
              <div className="flex items-center justify-between">
                <button onClick={goBackToCycles} className="text-[12px] text-slate-500 font-medium inline-flex items-center gap-1.5 active:text-slate-700">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                  Cycles
                </button>
                <span className={`px-2.5 py-1 rounded-full text-[10px] font-semibold border ${statusBadge}`}>
                  {detailStatusUi.label}
                </span>
              </div>

              {/* Summary card */}
              <div className="bg-white rounded-2xl border border-slate-200 p-4 shadow-sm">
                <div className="font-display text-[18px] font-semibold text-slate-900 leading-tight">{cycleDetail.filterName ?? cycleDetail.filter?.name ?? cycleDetail.cycleCode}</div>
                <div className="text-[11px] text-slate-400 font-mono-tab mt-0.5">{cycleDetail.cycleCode}</div>
                <div className="grid grid-cols-2 gap-2.5 mt-3">
                  <div className="bg-slate-50 rounded-lg px-3 py-2">
                    <div className="text-[9px] uppercase tracking-wider text-slate-400 font-semibold">Started</div>
                    <div className="text-[12px] text-slate-800 font-mono-tab mt-0.5 leading-tight">{formatDate(cycleDetail.startedAt)}</div>
                    <div className="text-[11px] text-slate-500 font-mono-tab leading-tight">{formatTime(new Date(cycleDetail.startedAt))}</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg px-3 py-2">
                    <div className="text-[9px] uppercase tracking-wider text-slate-400 font-semibold">{cycleDetail.completedAt ? 'Completed' : 'Duration so far'}</div>
                    {cycleDetail.completedAt ? (
                      <>
                        <div className="text-[12px] text-slate-800 font-mono-tab mt-0.5 leading-tight">{formatDate(cycleDetail.completedAt)}</div>
                        <div className="text-[11px] text-slate-500 font-mono-tab leading-tight">{formatTime(new Date(cycleDetail.completedAt))}</div>
                      </>
                    ) : (
                      <div className="text-[14px] text-slate-800 font-mono-tab mt-0.5 leading-tight font-semibold">{durLabel}</div>
                    )}
                  </div>
                  <div className="bg-slate-50 rounded-lg px-3 py-2">
                    <div className="text-[9px] uppercase tracking-wider text-slate-400 font-semibold">Duration</div>
                    <div className="text-[14px] text-slate-800 font-mono-tab mt-0.5 leading-tight font-semibold">{durLabel}</div>
                  </div>
                  <div className="bg-slate-50 rounded-lg px-3 py-2">
                    <div className="text-[9px] uppercase tracking-wider text-slate-400 font-semibold">Reason</div>
                    <div className="text-[12px] text-slate-700 font-medium mt-0.5 leading-tight">{cycleDetail.cleaningReasonLabel ?? cycleDetail.cleaningReasonKey ?? '—'}</div>
                  </div>
                </div>
                {cycleDetail.cleaningJustification && (
                  <div className="mt-3 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-[12px] text-amber-700 italic leading-snug">
                    {cycleDetail.cleaningJustification}
                  </div>
                )}
              </div>

              {/* Event timeline */}
              <div className="space-y-2">
                <div className="text-[10px] uppercase tracking-[0.18em] text-slate-400 font-medium px-1">Event timeline &middot; <span className="font-mono-tab">{events.length}</span></div>
                {events.length === 0 ? (
                  <div className="bg-white border border-slate-200 rounded-2xl p-6 text-center text-sm text-slate-500">No events recorded.</div>
                ) : (
                  events.map((ev: any, idx: number) => {
                    const style = EVENT_STYLE[ev.eventType] ?? EVENT_STYLE.REMARK_ADDED;
                    const attrs = (ev.attributes ?? {}) as Record<string, any>;
                    const readings: any[] = Array.isArray(attrs.instrumentReadings) ? attrs.instrumentReadings : [];
                    const enrichedAnswers: any[] = Array.isArray(ev.enrichedAnswers) ? ev.enrichedAnswers : [];
                    return (
                      <div key={ev.id ?? idx} className={`relative bg-white rounded-2xl border border-slate-200 overflow-hidden`}>
                        {/* color accent strip */}
                        <div className={`absolute left-0 top-0 bottom-0 w-1 ${style.dot}`} />
                        <div className={`pl-4 pr-3.5 py-3 ${style.bg}`}>
                          <div className="flex items-start justify-between gap-2 mb-1.5">
                            <div className="font-display text-[13px] font-semibold text-slate-900 leading-tight">
                              {style.label}
                              {ev.eventType === 'STATE_TRANSITION' && ev.toState && (
                                <span className="ml-1.5 text-[11px] font-mono-tab text-slate-500">&rarr; {STAGE_LABELS[ev.toState] ?? ev.toState.replace(/_/g, ' ')}</span>
                              )}
                            </div>
                            <div className="text-right shrink-0">
                              <div className="text-[10.5px] text-slate-700 font-mono-tab leading-tight">{formatDate(ev.performedAt)}</div>
                              <div className="text-[10px] text-slate-500 font-mono-tab leading-tight">{formatTime(new Date(ev.performedAt))}</div>
                            </div>
                          </div>
                          {(ev.performedByUsername || ev.performedByName) && (
                            <div className="text-[10.5px] text-slate-500">by <span className="text-slate-700 font-medium font-mono-tab">{ev.performedByUsername ?? ev.performedByName}</span></div>
                          )}
                          {ev.toState && (
                            <div className="flex items-center gap-1.5 mt-1.5">
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-white border border-slate-200 text-slate-500 font-mono-tab">{ev.fromState ? (STAGE_LABELS[ev.fromState] ?? ev.fromState) : 'To Be Cleaned'}</span>
                              <svg className="w-3 h-3 text-slate-300" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.5}><path strokeLinecap="round" strokeLinejoin="round" d="M13 7l5 5m0 0l-5 5m5-5H6" /></svg>
                              <span className="px-1.5 py-0.5 rounded text-[10px] bg-white border border-slate-300 text-slate-700 font-mono-tab font-semibold">{STAGE_LABELS[ev.toState] ?? ev.toState}</span>
                            </div>
                          )}
                        </div>
                        {/* Instrument readings */}
                        {readings.length > 0 && (
                          <div className="px-4 pt-2.5 pb-3 space-y-1.5">
                            <div className="text-[9.5px] uppercase tracking-wider text-slate-400 font-semibold">Submitted readings</div>
                            <div className="grid grid-cols-2 gap-1.5">
                              {readings.map((r: any, ri: number) => (
                                <div key={ri} className="bg-slate-50 border border-slate-100 rounded-lg px-2.5 py-1.5">
                                  <div className="text-[10px] text-slate-400 truncate">{r.description ?? r.instrumentCode ?? `Reading ${ri + 1}`}</div>
                                  <div className="flex items-baseline gap-1 mt-0.5">
                                    <span className="text-[14px] text-slate-900 font-mono-tab font-semibold leading-none">{String(r.value ?? '—')}</span>
                                    <span className="text-[10px] text-slate-500">{r.uom ?? r.unit ?? ''}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Checklist Q&A */}
                        {enrichedAnswers.length > 0 && (
                          <div className="px-4 pt-2.5 pb-3 space-y-1.5">
                            <div className="text-[9.5px] uppercase tracking-wider text-slate-400 font-semibold">Checklist responses &middot; <span className="font-mono-tab">{enrichedAnswers.length}</span></div>
                            <div className="space-y-1.5">
                              {enrichedAnswers.map((qa: any, qi: number) => (
                                <div key={qa.questionId ?? qi} className="bg-slate-50 border border-slate-100 rounded-lg px-3 py-2 flex items-start gap-2">
                                  <div className="font-mono-tab text-[10px] text-slate-400 font-medium pt-0.5 shrink-0">{String(qi + 1).padStart(2, '0')}.</div>
                                  <div className="min-w-0 flex-1">
                                    <div className="text-[12px] text-slate-700 leading-snug">{qa.question}</div>
                                    <div className="text-[12px] text-slate-900 font-semibold mt-0.5 break-words">
                                      {typeof qa.answer === 'boolean' ? (qa.answer ? 'Yes' : 'No') : String(qa.answer ?? '—')}
                                    </div>
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                        {/* Remarks / deviation */}
                        {ev.remarks && (
                          <div className="px-4 pb-3 text-[12px] text-slate-500 italic">{ev.remarks}</div>
                        )}
                        {ev.deviationDetails && (
                          <div className="mx-3 mb-3 px-3 py-2 bg-rose-50 border border-rose-200 rounded-lg text-[12px] text-rose-700">
                            Deviation: {(ev.deviationDetails as any).justification || JSON.stringify(ev.deviationDetails)}
                          </div>
                        )}
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          );
        })()}

        {/* === RFID ASSIGN VIEW === */}
        {view === 'rfid-assign' && (() => {
          // Re-derive hierarchy locally so this view stays self-contained and
          // doesn't depend on status-view internals.
          const rfidInstById = new Map((instances as any[]).map((i: any) => [i.id, i] as [string, any]));
          const rfidFilterAncestors = new Map<string, FilterAncestry>();
          for (const f of (allFilters as any[])) {
            rfidFilterAncestors.set(f.id, resolveAncestry(f, rfidInstById, kindOfInstance));
          }
          const rfidBlockIds = new Set<string>();
          const rfidAreaIds = new Set<string>();
          const rfidAhuIds = new Set<string>();
          for (const a of rfidFilterAncestors.values()) {
            if (a.blockId) rfidBlockIds.add(a.blockId);
            if (a.areaId) rfidAreaIds.add(a.areaId);
            if (a.ahuId) rfidAhuIds.add(a.ahuId);
          }
          const byName = (a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
          const rfidBlockOptions = [...rfidBlockIds].map((id) => rfidInstById.get(id)).filter(Boolean).sort(byName);
          const rfidAreaOptions = [...rfidAreaIds]
            .map((id) => rfidInstById.get(id)).filter(Boolean)
            .filter((area: any) => rfidBlockId === 'all' || area.parentId === rfidBlockId)
            .sort(byName);
          const rfidAhuOptions = [...rfidAhuIds]
            .map((id) => rfidInstById.get(id)).filter(Boolean)
            .filter((ahu: any) => {
              const anc = resolveAncestry(ahu, rfidInstById, kindOfInstance);
              if (rfidAreaId !== 'all' && anc.areaId !== rfidAreaId) return false;
              if (rfidBlockId !== 'all' && anc.blockId !== rfidBlockId) return false;
              return true;
            })
            .sort(byName);
          const rfidFilterOptions = (allFilters as any[])
            .filter((f: any) => {
              const a = rfidFilterAncestors.get(f.id);
              if (!a) return false;
              if (rfidBlockId !== 'all' && a.blockId !== rfidBlockId) return false;
              if (rfidAreaId !== 'all' && a.areaId !== rfidAreaId) return false;
              if (rfidAhuId !== 'all' && a.ahuId !== rfidAhuId) return false;
              return true;
            })
            .slice().sort(byName);
          const rfidVisibleFilters = (allFilters as any[]).filter((f: any) => {
            const a = rfidFilterAncestors.get(f.id);
            if (!a) return false;
            if (rfidBlockId !== 'all' && a.blockId !== rfidBlockId) return false;
            if (rfidAreaId !== 'all' && a.areaId !== rfidAreaId) return false;
            if (rfidAhuId !== 'all' && a.ahuId !== rfidAhuId) return false;
            if (rfidFilterId !== 'all' && f.id !== rfidFilterId) return false;
            if (rfidSearch && !f.name?.toLowerCase().includes(rfidSearch.toLowerCase())) return false;
            return true;
          });
          const rfidCascadeActive = rfidBlockId !== 'all' || rfidAreaId !== 'all' || rfidAhuId !== 'all' || rfidFilterId !== 'all';

          // ── Selected-filter full detail (rendered in the selected branch below).
          // Block/Area/AHU come from the local ancestor map; the rest off the
          // filter row's attributes. Last Cleaned is derived from cleaning-cycle
          // stage events (same as the Status view) since the instances payload
          // does not carry a server-computed lastCleanedAt — cyclesData is now
          // loaded for this view too.
          const rfidSelFilter = rfidSelectedFilter
            ? (allFilters as any[]).find((f: any) => f.id === rfidSelectedFilter.id)
            : null;
          const rfidSelAnc = rfidSelectedFilter ? rfidFilterAncestors.get(rfidSelectedFilter.id) : null;
          const rfidSelBlock = rfidSelAnc?.blockId ? rfidInstById.get(rfidSelAnc.blockId) : null;
          const rfidSelArea = rfidSelAnc?.areaId ? rfidInstById.get(rfidSelAnc.areaId) : null;
          const rfidSelAhu = rfidSelAnc?.ahuId ? rfidInstById.get(rfidSelAnc.ahuId) : null;
          const rfidSelCycles: any[] = (cyclesData?.data ?? []) as any[];
          const rfidSelLastCleaned = rfidSelFilter
            ? (rfidSelFilter.lastCleanedAt ?? effectiveLastCleaned(latestStageEventAt(rfidSelCycles, rfidSelFilter.id), rfidSelFilter.attributes))
            : null;
          const rfidSelStage = rfidSelFilter ? STAGES.find((s) => s.key === rfidSelFilter.currentLifecycleState) : null;
          const rfidSelSet = rfidSelFilter?.filterSet ? `Set ${String(rfidSelFilter.filterSet).replace('SET_', '')}` : 'NA';
          const rfidSelDate = (iso: string | null) => (iso ? (formatDate(iso) || 'NA') : 'NA');
          const rfidSelDetails: Array<[string, string]> = [
            ['Block', naText(rfidSelBlock?.name)],
            ['Area', naText(rfidSelArea?.name)],
            ['AHU', naText(rfidSelAhu?.name)],
            ['AHU Type', naText(rfidSelFilter?.attributes?.ahuType)],
            ['Filter Type', naText(rfidSelFilter?.attributes?.filterType)],
            ['Set', rfidSelSet],
            ['Dimensions', naText(rfidSelFilter?.attributes?.filterSize)],
            ['Micron Size', naText(rfidSelFilter?.attributes?.micronSize)],
            ['Last Cleaned', rfidSelDate(rfidSelLastCleaned)],
          ];
          return (
          <div className="p-4 space-y-4 max-w-2xl mx-auto">
            {!rfidSelectedFilter ? (
              <>
                <div className="flex items-baseline justify-between">
                  <h2 className="font-display text-[20px] font-semibold text-slate-900">Select filter</h2>
                  {rfidCascadeActive && (
                    <button
                      onClick={() => { setRfidBlockId('all'); setRfidAreaId('all'); setRfidAhuId('all'); setRfidFilterId('all'); }}
                      className="text-[11px] text-cyan-600 font-medium underline active:text-cyan-700"
                    >clear</button>
                  )}
                </div>

                {/* 4-up hierarchy dropdown row — same pattern as Status view */}
                <div className="bg-white rounded-2xl border border-slate-200 p-2 grid grid-cols-4 gap-1.5">
                  <div>
                    <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">Block</label>
                    <select
                      value={rfidBlockId}
                      onChange={(e) => {
                        const v = e.target.value;
                        setRfidBlockId(v);
                        if (v !== 'all') {
                          if (rfidAreaId !== 'all') {
                            const area = rfidInstById.get(rfidAreaId);
                            if (!area || area.parentId !== v) setRfidAreaId('all');
                          }
                          if (rfidAhuId !== 'all') {
                            const ahu = rfidInstById.get(rfidAhuId);
                            const ahuBlockId = ahu ? resolveAncestry(ahu, rfidInstById, kindOfInstance).blockId : null;
                            if (ahuBlockId !== v) setRfidAhuId('all');
                          }
                          if (rfidFilterId !== 'all') {
                            const anc = rfidFilterAncestors.get(rfidFilterId);
                            if (anc?.blockId !== v) setRfidFilterId('all');
                          }
                        }
                      }}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:outline-none focus:border-violet-500 focus:bg-white truncate"
                    >
                      <option value="all">All</option>
                      {rfidBlockOptions.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">Area</label>
                    <select
                      value={rfidAreaId}
                      onChange={(e) => {
                        const v = e.target.value;
                        setRfidAreaId(v);
                        if (v !== 'all') {
                          if (rfidAhuId !== 'all') {
                            const ahu = rfidInstById.get(rfidAhuId);
                            if (!ahu || ahu.parentId !== v) setRfidAhuId('all');
                          }
                          if (rfidFilterId !== 'all') {
                            const anc = rfidFilterAncestors.get(rfidFilterId);
                            if (anc?.areaId !== v) setRfidFilterId('all');
                          }
                        }
                      }}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:outline-none focus:border-violet-500 focus:bg-white truncate"
                    >
                      <option value="all">All</option>
                      {rfidAreaOptions.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">AHU</label>
                    <select
                      value={rfidAhuId}
                      onChange={(e) => {
                        const v = e.target.value;
                        setRfidAhuId(v);
                        if (v !== 'all' && rfidFilterId !== 'all') {
                          const anc = rfidFilterAncestors.get(rfidFilterId);
                          if (anc?.ahuId !== v) setRfidFilterId('all');
                        }
                      }}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:outline-none focus:border-violet-500 focus:bg-white truncate"
                    >
                      <option value="all">All</option>
                      {rfidAhuOptions.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">Filter</label>
                    <select
                      value={rfidFilterId}
                      onChange={(e) => setRfidFilterId(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:outline-none focus:border-violet-500 focus:bg-white truncate"
                    >
                      <option value="all">All</option>
                      {rfidFilterOptions.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] uppercase tracking-[0.15em] text-slate-400 font-medium mb-1">Search by name</label>
                  <input
                    type="text"
                    value={rfidSearch}
                    onChange={e => setRfidSearch(e.target.value)}
                    placeholder="Type to narrow…"
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                  />
                </div>

                <div className="space-y-2">
                  <div className="text-[11px] text-slate-500 font-mono-tab px-1">
                    showing <span className="text-slate-800 font-semibold">{Math.min(rfidVisibleFilters.length, 60)}</span> of {rfidVisibleFilters.length}
                  </div>
                  {rfidVisibleFilters.length === 0 && (
                    <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-500">No filters match.</div>
                  )}
                  {/* 2026-05-26: assignment status is encoded in card color
                      so operators can scan the list visually without having
                      to read each line. Green = at least one tag assigned;
                      red = no tag yet. Right-side mono shows the FIRST tag
                      ID when assigned (with "+N more" if multiple). */}
                  {rfidVisibleFilters.slice(0, 60).map((f: any) => {
                    const tags = rfidTagsByFilter.get(f.id) ?? [];
                    const isAssigned = tags.length > 0;
                    const firstTag = isAssigned ? (tags[0]?.identifierValue ?? '') : '';
                    return (
                      <button key={f.id} onClick={() => { setRfidSelectedFilter({ id: f.id, name: f.name }); setRfidError(''); setRfidSuccess(''); }}
                        className={`tile-lift w-full rounded-xl border-2 p-3 text-left flex items-center justify-between transition-colors ${
                          isAssigned
                            ? 'bg-emerald-50 border-emerald-300 active:bg-emerald-100'
                            : 'bg-rose-50 border-rose-300 active:bg-rose-100'
                        }`}>
                        <div className="min-w-0 flex-1">
                          <div className="font-display text-[13px] font-semibold text-slate-900 truncate leading-tight">{f.name}</div>
                          <div className="flex items-center gap-1.5 mt-1 min-w-0">
                            <span className={`inline-block w-1.5 h-1.5 rounded-full shrink-0 ${isAssigned ? 'bg-emerald-500' : 'bg-rose-500'}`} aria-hidden="true" />
                            <span className={`text-[10.5px] font-semibold shrink-0 ${isAssigned ? 'text-emerald-700' : 'text-rose-700'}`}>
                              {isAssigned ? 'Tag Assigned' : 'Tag Not Assigned'}
                            </span>
                            {isAssigned && firstTag && (
                              <>
                                <span className="text-[10.5px] text-slate-400 shrink-0">|</span>
                                <span className="text-[10.5px] font-mono text-slate-700 truncate" title={firstTag}>{firstTag}</span>
                                {tags.length > 1 && (
                                  <span className="text-[10.5px] text-slate-500 shrink-0">+{tags.length - 1}</span>
                                )}
                              </>
                            )}
                          </div>
                        </div>
                        <svg className={`w-4 h-4 shrink-0 ${isAssigned ? 'text-emerald-400' : 'text-rose-400'}`} fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" /></svg>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              <>
                <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] text-slate-400 uppercase tracking-wider font-bold">Selected Filter</div>
                      <div className="text-base font-bold text-slate-800 mt-0.5 break-all">{rfidSelectedFilter.name}</div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className={`text-[10px] px-2.5 py-1 rounded-full border font-medium whitespace-nowrap ${rfidSelStage ? `${rfidSelStage.bg} ${rfidSelStage.text} ${rfidSelStage.border}` : 'bg-slate-50 text-slate-400 border-slate-200'}`}>
                        {rfidSelFilter?.currentLifecycleState?.replace(/_/g, ' ') ?? 'To Be Cleaned'}
                      </span>
                      <button onClick={() => { setRfidSelectedFilter(null); rfidScan.setValue(''); setRfidError(''); setRfidSuccess(''); }}
                        className="text-xs font-semibold text-violet-600">Change</button>
                    </div>
                  </div>

                  {/* Full filter detail so the operator can confirm they're
                      tagging the right filter without leaving this view. */}
                  <div className="grid grid-cols-3 gap-2">
                    {rfidSelDetails.map(([label, value]) => (
                      <div key={label} className="bg-slate-50 rounded-lg border border-slate-200 p-2 min-w-0">
                        <div className="text-[9px] uppercase tracking-wider text-slate-400 font-medium">{label}</div>
                        <div className="text-[11px] text-slate-800 font-semibold mt-0.5 truncate" title={value}>{value}</div>
                      </div>
                    ))}
                  </div>
                </div>

                {rfidError && (
                  <div className="rounded-xl bg-red-50 border border-red-200 p-3 text-sm text-red-700">{rfidError}</div>
                )}
                {rfidSuccess && (
                  <div className="rounded-xl bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-700">{rfidSuccess}</div>
                )}

                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Assigned Tags</label>
                  {currentRfidTags.length === 0 ? (
                    <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 text-center text-sm text-slate-400">No RFID tag assigned yet.</div>
                  ) : (
                    <div className="space-y-2">
                      {currentRfidTags.map((tag: any) => (
                        <div key={tag.id} className="bg-white rounded-xl border border-slate-200 p-3 flex items-center justify-between">
                          <div>
                            <div className="text-xs text-slate-400">RFID</div>
                            <div className="text-sm font-mono font-semibold text-slate-800 break-all">{tag.identifierValue}</div>
                          </div>
                          <button onClick={() => unassignRfid(tag.id)} disabled={rfidSubmitting}
                            className="px-3 py-1.5 rounded-lg text-xs font-semibold text-red-600 border border-red-200 bg-red-50 active:bg-red-100 disabled:opacity-50">
                            Remove
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Assign New Tag</label>
                  {/* 2026-05-26: input bound to useRfidScanField — auto
                      clears between scan bursts (fixes multi-scan append),
                      trims CR/LF on every change. Enter-key submits the
                      currently-displayed value so the operator can either
                      scan-and-Enter or scan-and-tap. */}
                  <input
                    data-rfid="true"
                    type="text"
                    value={rfidScan.value}
                    onKeyDown={(e) => {
                      rfidScan.onKeyDown(e);
                      if (e.key === 'Enter' && rfidScan.value.trim() && !rfidSubmitting) {
                        e.preventDefault();
                        assignRfid();
                      }
                    }}
                    onChange={rfidScan.onChange}
                    placeholder="Scan or enter tag value..."
                    autoFocus
                    className="w-full px-3 py-3 border border-slate-200 rounded-xl text-base font-mono bg-white focus:ring-2 focus:ring-violet-500 focus:border-violet-500"
                  />
                  <button onClick={assignRfid} disabled={rfidSubmitting || !rfidScan.value.trim()}
                    className="w-full mt-3 py-3 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-violet-500 to-purple-600 shadow-lg shadow-violet-500/20 active:shadow-none disabled:opacity-50 disabled:cursor-not-allowed">
                    {rfidSubmitting ? 'Assigning...' : 'Assign Tag'}
                  </button>
                </div>
              </>
            )}
          </div>
          );
        })()}

        {/* === REPLACE FILTER VIEW (online-only) === */}
        {view === 'replace' && (() => {
          // Self-contained Block → Area → AHU → Filter cascade, same pattern as
          // the RFID Assign view above. Selecting a filter opens a remarks-gated
          // confirm; submit runs the shared replace path (tag carries over).
          const repInstById = new Map((instances as any[]).map((i: any) => [i.id, i] as [string, any]));
          const repAncestors = new Map<string, FilterAncestry>();
          for (const f of (allFilters as any[])) {
            repAncestors.set(f.id, resolveAncestry(f, repInstById, kindOfInstance));
          }
          const repBlockIds = new Set<string>(); const repAreaIds = new Set<string>(); const repAhuIds = new Set<string>();
          for (const a of repAncestors.values()) { if (a.blockId) repBlockIds.add(a.blockId); if (a.areaId) repAreaIds.add(a.areaId); if (a.ahuId) repAhuIds.add(a.ahuId); }
          const byName = (a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? ''));
          const repBlockOptions = [...repBlockIds].map(id => repInstById.get(id)).filter(Boolean).sort(byName);
          const repAreaOptions = [...repAreaIds].map(id => repInstById.get(id)).filter(Boolean)
            .filter((area: any) => replaceBlockId === 'all' || area.parentId === replaceBlockId).sort(byName);
          const repAhuOptions = [...repAhuIds].map(id => repInstById.get(id)).filter(Boolean)
            .filter((ahu: any) => {
              const anc = resolveAncestry(ahu, repInstById, kindOfInstance);
              if (replaceAreaId !== 'all' && anc.areaId !== replaceAreaId) return false;
              if (replaceBlockId !== 'all' && anc.blockId !== replaceBlockId) return false;
              return true;
            }).sort(byName);
          const matchesCascade = (f: any) => {
            const a = repAncestors.get(f.id); if (!a) return false;
            if (replaceBlockId !== 'all' && a.blockId !== replaceBlockId) return false;
            if (replaceAreaId !== 'all' && a.areaId !== replaceAreaId) return false;
            if (replaceAhuId !== 'all' && a.ahuId !== replaceAhuId) return false;
            return true;
          };
          const repFilterOptions = (allFilters as any[]).filter(matchesCascade).slice().sort(byName);
          const repVisibleFilters = (allFilters as any[]).filter((f: any) => {
            if (!matchesCascade(f)) return false;
            if (replaceFilterId !== 'all' && f.id !== replaceFilterId) return false;
            if (replaceSearch && !f.name?.toLowerCase().includes(replaceSearch.toLowerCase())) return false;
            return true;
          });
          const repCascadeActive = replaceBlockId !== 'all' || replaceAreaId !== 'all' || replaceAhuId !== 'all' || replaceFilterId !== 'all';
          const selTags = replaceSelectedFilter ? (rfidTagsByFilter.get(replaceSelectedFilter.id) ?? []) : [];

          // ── Selected-filter full detail for the confirm panel (same set as the
          // RFID Assign view). Block/Area/AHU from the local ancestor map; the
          // rest off the filter row; Last Cleaned derived from cycle stage events.
          const repSelFilter = replaceSelectedFilter
            ? (allFilters as any[]).find((f: any) => f.id === replaceSelectedFilter.id)
            : null;
          const repSelAnc = replaceSelectedFilter ? repAncestors.get(replaceSelectedFilter.id) : null;
          const repSelBlock = repSelAnc?.blockId ? repInstById.get(repSelAnc.blockId) : null;
          const repSelArea = repSelAnc?.areaId ? repInstById.get(repSelAnc.areaId) : null;
          const repSelAhu = repSelAnc?.ahuId ? repInstById.get(repSelAnc.ahuId) : null;
          const repSelCycles: any[] = (cyclesData?.data ?? []) as any[];
          const repSelLastCleaned = repSelFilter
            ? (repSelFilter.lastCleanedAt ?? effectiveLastCleaned(latestStageEventAt(repSelCycles, repSelFilter.id), repSelFilter.attributes))
            : null;
          const repSelStage = repSelFilter ? STAGES.find((s) => s.key === repSelFilter.currentLifecycleState) : null;
          const repSelSet = repSelFilter?.filterSet ? `Set ${String(repSelFilter.filterSet).replace('SET_', '')}` : 'NA';
          const repSelDate = (iso: string | null) => (iso ? (formatDate(iso) || 'NA') : 'NA');
          const repSelDetails: Array<[string, string]> = [
            ['Block', naText(repSelBlock?.name)],
            ['Area', naText(repSelArea?.name)],
            ['AHU', naText(repSelAhu?.name)],
            ['AHU Type', naText(repSelFilter?.attributes?.ahuType)],
            ['Filter Type', naText(repSelFilter?.attributes?.filterType)],
            ['Set', repSelSet],
            ['Dimensions', naText(repSelFilter?.attributes?.filterSize)],
            ['Micron Size', naText(repSelFilter?.attributes?.micronSize)],
            ['Last Cleaned', repSelDate(repSelLastCleaned)],
          ];
          return (
          <div className="p-4 space-y-4 max-w-2xl mx-auto">
            {replaceSuccess && (
              <div className="bg-emerald-50 border border-emerald-200 text-emerald-700 rounded-xl px-4 py-3 text-sm font-medium">{replaceSuccess}</div>
            )}
            {replaceError && (
              <div className="bg-rose-50 border border-rose-200 text-rose-700 rounded-xl px-4 py-3 text-sm font-medium">{replaceError}</div>
            )}
            {!replaceSelectedFilter ? (
              <>
                <div className="flex items-baseline justify-between">
                  <h2 className="font-display text-[20px] font-semibold text-slate-900">Replace — select filter</h2>
                  {repCascadeActive && (
                    <button
                      onClick={() => { setReplaceBlockId('all'); setReplaceAreaId('all'); setReplaceAhuId('all'); setReplaceFilterId('all'); }}
                      className="text-[11px] text-amber-600 font-medium underline active:text-amber-700"
                    >clear</button>
                  )}
                </div>

                {/* ── Scan-to-select (additive; manual cascade/search remain below) ── */}
                <div className="bg-white rounded-2xl border border-amber-200 p-3">
                  <label className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.15em] text-amber-600 font-semibold mb-1.5">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M12 4v1m0 14v1m8-8h-1M5 12H4m12.95 4.95l-.7-.7M7.05 7.05l-.7-.7m12.6 0l-.7.7M7.05 16.95l-.7.7M9 9h6v6H9z" /></svg>
                    Scan filter tag
                  </label>
                  <input
                    data-rfid="true"
                    type="text"
                    value={replaceScan.value}
                    onKeyDown={(e) => {
                      replaceScan.onKeyDown(e);
                      if (e.key === 'Enter') { e.preventDefault(); resolveReplaceScan(); }
                    }}
                    onChange={replaceScan.onChange}
                    placeholder="Scan or type RFID/QR tag, then Enter"
                    autoFocus
                    className="w-full px-3 py-3 border border-amber-200 rounded-xl text-base font-mono bg-amber-50/40 focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
                  />
                  {replaceScanError && <div className="text-[11px] text-rose-600 mt-1.5 font-medium">{replaceScanError}</div>}
                  <div className="text-[10.5px] text-slate-400 mt-1.5">Scan the filter's tag to select it instantly — or pick it manually below.</div>
                </div>

                <div className="bg-white rounded-2xl border border-slate-200 p-2 grid grid-cols-4 gap-1.5">
                  <div>
                    <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">Block</label>
                    <select value={replaceBlockId}
                      onChange={(e) => { setReplaceBlockId(e.target.value); setReplaceAreaId('all'); setReplaceAhuId('all'); setReplaceFilterId('all'); }}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:outline-none focus:border-amber-500 focus:bg-white truncate">
                      <option value="all">All</option>
                      {repBlockOptions.map((b: any) => <option key={b.id} value={b.id}>{b.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">Area</label>
                    <select value={replaceAreaId}
                      onChange={(e) => { setReplaceAreaId(e.target.value); setReplaceAhuId('all'); setReplaceFilterId('all'); }}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:outline-none focus:border-amber-500 focus:bg-white truncate">
                      <option value="all">All</option>
                      {repAreaOptions.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">AHU</label>
                    <select value={replaceAhuId}
                      onChange={(e) => { setReplaceAhuId(e.target.value); setReplaceFilterId('all'); }}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:outline-none focus:border-amber-500 focus:bg-white truncate">
                      <option value="all">All</option>
                      {repAhuOptions.map((a: any) => <option key={a.id} value={a.id}>{a.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-[9px] uppercase tracking-[0.12em] text-slate-400 font-medium mb-0.5 px-0.5">Filter</label>
                    <select value={replaceFilterId}
                      onChange={(e) => setReplaceFilterId(e.target.value)}
                      className="w-full bg-slate-50 border border-slate-200 rounded-lg px-1.5 py-1.5 text-[11px] text-slate-800 font-medium focus:outline-none focus:border-amber-500 focus:bg-white truncate">
                      <option value="all">All</option>
                      {repFilterOptions.map((f: any) => <option key={f.id} value={f.id}>{f.name}</option>)}
                    </select>
                  </div>
                </div>

                <div>
                  <label className="block text-[10px] uppercase tracking-[0.15em] text-slate-400 font-medium mb-1">Search by name</label>
                  <input type="text" value={replaceSearch} onChange={e => setReplaceSearch(e.target.value)}
                    placeholder="Type to narrow…"
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:ring-2 focus:ring-amber-500 focus:border-amber-500" />
                </div>

                <div className="space-y-2">
                  <div className="text-[11px] text-slate-500 font-mono-tab px-1">
                    showing <span className="text-slate-800 font-semibold">{Math.min(repVisibleFilters.length, 60)}</span> of {repVisibleFilters.length}
                  </div>
                  {repVisibleFilters.length === 0 && (
                    <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-500">No filters match.</div>
                  )}
                  {repVisibleFilters.slice(0, 60).map((f: any) => {
                    const tags = rfidTagsByFilter.get(f.id) ?? [];
                    const firstTag = tags[0]?.identifierValue ?? '';
                    return (
                      <button key={f.id} onClick={() => { setReplaceSelectedFilter({ id: f.id, name: f.name }); setReplaceRemarks(''); setReplaceError(''); setReplaceSuccess(''); }}
                        className="tile-lift w-full rounded-xl border border-slate-200 bg-white p-3 text-left flex items-center justify-between active:bg-slate-50 transition-colors">
                        <div className="min-w-0 flex-1">
                          <div className="font-display text-[13px] font-semibold text-slate-900 truncate leading-tight">{f.name}</div>
                          <div className="text-[10.5px] text-slate-400 mt-0.5 truncate">
                            {firstTag ? <>tag <span className="font-mono-tab text-slate-600">{firstTag}</span>{tags.length > 1 ? ` +${tags.length - 1}` : ''}</> : 'no tag'}
                          </div>
                        </div>
                        <svg className="w-4 h-4 text-slate-300 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" /></svg>
                      </button>
                    );
                  })}
                </div>
              </>
            ) : (
              /* ── Confirm panel for the chosen filter ── */
              <div className="space-y-4">
                <div className="flex items-center gap-2">
                  <button onClick={() => { setReplaceSelectedFilter(null); setReplaceError(''); }}
                    className="text-[12px] text-slate-500 font-medium active:text-slate-700 flex items-center gap-1">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.4}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg>
                    back to list
                  </button>
                </div>
                <h2 className="font-display text-[20px] font-semibold text-slate-900">Replace filter</h2>

                <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 flex-1">
                      <label className="block text-[10px] uppercase tracking-[0.15em] text-slate-400 font-medium mb-1">Filter ID</label>
                      <div className="font-display text-[15px] font-semibold text-slate-900 break-all">{replaceSelectedFilter.name}</div>
                    </div>
                    <span className={`text-[10px] px-2.5 py-1 rounded-full border font-medium whitespace-nowrap shrink-0 ${repSelStage ? `${repSelStage.bg} ${repSelStage.text} ${repSelStage.border}` : 'bg-slate-50 text-slate-400 border-slate-200'}`}>
                      {repSelFilter?.currentLifecycleState?.replace(/_/g, ' ') ?? 'To Be Cleaned'}
                    </span>
                  </div>

                  {/* Full filter detail so the operator can confirm they're
                      replacing the right filter before committing. */}
                  <div className="grid grid-cols-3 gap-2">
                    {repSelDetails.map(([label, value]) => (
                      <div key={label} className="bg-slate-50 rounded-lg border border-slate-200 p-2 min-w-0">
                        <div className="text-[9px] uppercase tracking-wider text-slate-400 font-medium">{label}</div>
                        <div className="text-[11px] text-slate-800 font-semibold mt-0.5 truncate" title={value}>{value}</div>
                      </div>
                    ))}
                  </div>

                  <div>
                    <label className="block text-[10px] uppercase tracking-[0.15em] text-slate-400 font-medium mb-1">RFID tag (carries over)</label>
                    <div className="font-mono-tab text-[13px] text-slate-700">
                      {selTags.length > 0 ? selTags.map((t: any) => t.identifierValue).join(', ') : <span className="text-slate-400">none assigned</span>}
                    </div>
                  </div>
                </div>

                <div className="bg-amber-50 border border-amber-200 text-amber-800 rounded-xl p-3 text-xs">
                  This retires the current filter and creates a new replacement with the same details, RFID tag, and an incremented ID suffix. The action is permanent.
                </div>

                <div>
                  <label className="block text-[10px] uppercase tracking-[0.15em] text-slate-400 font-medium mb-1">Remarks <span className="text-rose-500">*</span></label>
                  <textarea value={replaceRemarks} onChange={e => setReplaceRemarks(e.target.value)} rows={3}
                    placeholder="Reason for replacement…"
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm bg-white resize-none focus:ring-2 focus:ring-amber-500 focus:border-amber-500" />
                </div>

                <div className="flex items-center gap-3">
                  <button onClick={() => { setReplaceSelectedFilter(null); setReplaceRemarks(''); setReplaceError(''); }}
                    className="flex-1 px-4 py-3 border border-slate-300 rounded-xl text-sm font-semibold text-slate-600 active:bg-slate-100">
                    Cancel
                  </button>
                  <button onClick={handleReplaceSubmit} disabled={!replaceRemarks.trim() || replaceSubmitting || !online}
                    className="flex-1 px-4 py-3 rounded-xl text-sm font-semibold text-white bg-amber-600 active:bg-amber-700 disabled:opacity-50 disabled:cursor-not-allowed">
                    {replaceSubmitting ? 'Replacing…' : 'Replace Filter'}
                  </button>
                </div>
                {!online && <div className="text-[11px] text-rose-500 text-center">Offline — replacement needs a connection.</div>}
              </div>
            )}
          </div>
          );
        })()}
      </div>

      {/* 2026-05-26: Filter Status → Scan RFID lookup modal.
          Opens from the "Scan RFID" button on the Status view. The
          operator scans a tag; the modal looks it up against the
          cached `allIdentifiers` list (which is already populated for
          the RFID Assign view, so no extra fetch) and renders the
          mapped filter's name + current state + Block→Area→AHU
          hierarchy + last cleaned timestamp.

          Lookup states:
            - empty input  → idle "scan a tag" prompt
            - input set, no identifier match → "Tag not assigned"
            - input set, identifier found but no filter row → "orphan"
              (rare — stale cache)
            - input set, identifier + filter both resolve → details
              card. */}
      {scanRfidOpen && (() => {
        const tag = scanRfidValue.trim();
        const instByIdLookup = new Map((instances as any[]).map((i: any) => [i.id, i] as [string, any]));
        const filterTemplateIdsLookup = new Set(
          templates.filter((t: any) => t.templateKind === 'FILTER').map((t: any) => t.id),
        );
        type LookupResult =
          | { kind: 'idle' }
          | { kind: 'not_found' }
          | { kind: 'orphan'; tag: string }
          | { kind: 'wrong_kind'; tag: string; name: string }
          | { kind: 'ok'; tag: string; filter: any; ahu: any; area: any; block: any; lastCleaned: string | null };
        let result: LookupResult = { kind: 'idle' };
        if (tag) {
          const ident = allIdentifiers.find(
            (i: any) => i.identifierType === 'RFID' && i.identifierValue === tag,
          );
          if (!ident) {
            result = { kind: 'not_found' };
          } else {
            const filter = (instances as any[]).find((f: any) => f.id === ident.assetId);
            if (!filter) {
              result = { kind: 'orphan', tag };
            } else if (
              !(filterTemplateIdsLookup.has(filter.templateId) || filter.template?.templateKind === 'FILTER')
            ) {
              result = { kind: 'wrong_kind', tag, name: filter.name };
            } else {
              // Kind-aware: a block-parented AHU has no area, and positional
              // walking showed the Block's name in the Area slot and blanked
              // the Block.
              const scanAnc = resolveAncestry(filter, instByIdLookup, kindOfInstance);
              const ahu = scanAnc.ahuId ? instByIdLookup.get(scanAnc.ahuId) : null;
              const area = scanAnc.areaId ? instByIdLookup.get(scanAnc.areaId) : null;
              const block = scanAnc.blockId ? instByIdLookup.get(scanAnc.blockId) : null;
              // Latest cleaning-stage event (every stage, not just completion).
              const cycles: any[] = (cyclesData?.data ?? []) as any[];
              const lastCleaned = effectiveLastCleaned(latestStageEventAt(cycles, filter.id), filter.attributes);
              result = { kind: 'ok', tag, filter, ahu, area, block, lastCleaned };
            }
          }
        }
        // Respect the app's date/time config (dateFormat/timeFormat/timezone)
        // instead of a hardcoded locale format.
        const fmt = (iso: string | null) => {
          const s = iso ? formatDateTime(iso) : '';
          return s || '—';
        };
        const stageInfo = result.kind === 'ok' ? STAGES.find(s => s.key === result.filter.currentLifecycleState) : null;
        return (
          <div
            className="fixed inset-0 z-50 flex items-end justify-center bg-slate-900/40 backdrop-blur-sm"
            onClick={() => setScanRfidOpen(false)}
            // Refocus the hidden scan input whenever any part of the
            // modal (incl. the dimmer) is interacted with — if the user
            // taps the result card, the input mustn't lose focus,
            // otherwise the next scan goes to document.body and gets
            // blocked by the global RFID guard.
            onMouseDown={() => scanRfidInputRef.current?.focus()}
          >
            <div
              className="w-full max-w-2xl bg-white rounded-t-3xl shadow-2xl max-h-[90dvh] overflow-y-auto"
              onClick={(e) => e.stopPropagation()}
              onMouseDown={(e) => { e.stopPropagation(); scanRfidInputRef.current?.focus(); }}
            >
              <div className="sticky top-0 bg-gradient-to-r from-violet-500 to-purple-600 px-5 py-4 rounded-t-3xl flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold text-white">Scan RFID</h2>
                  <p className="text-violet-100 text-xs">Look up filter by tag</p>
                </div>
                <button onClick={() => setScanRfidOpen(false)} className="w-9 h-9 rounded-xl bg-white/15 flex items-center justify-center text-white active:bg-white/25">
                  <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
                </button>
              </div>

              <div className="p-5 space-y-4">
                {/* Hidden uncontrolled input that captures scanner
                    keystrokes. data-rfid="true" lets the global
                    use-rfid-guard hook pass the fast-burst keys through.
                    autoFocus + the modal's refocus-on-interact handlers
                    keep this focused even when the operator taps the
                    result card. On Enter (KC-series burst terminator),
                    we snapshot .value, clear the DOM input, and lift the
                    snapshot into React state for the lookup below.
                    Using `defaultValue` + DOM-snapshot is critical here:
                    a controlled `<input value={state}>` has a
                    React-render-race that causes back-to-back scans to
                    concatenate ("CA000C01CA000C03") under rapid timing —
                    the bug operators reported on the tablet. */}
                <input
                  ref={scanRfidInputRef}
                  data-rfid="true"
                  type="text"
                  defaultValue=""
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      const el = e.currentTarget;
                      // Strip CR/LF/tab/whitespace inline — same contract
                      // as useRfidScanField's onChange cleanup.
                      const raw = el.value;
                      const cleaned = raw.replace(/[\r\n\t]/g, '').replace(/^\s+|\s+$/g, '');
                      // Clear the DOM input BEFORE handling — guarantees
                      // the next scan starts from empty no matter what.
                      el.value = '';
                      if (!cleaned) return;
                      // Duplicate-submit guard: same value within 1s is
                      // silently dropped (KC-series scanners sometimes
                      // double-fire on an unsteady physical scan).
                      const now = Date.now();
                      if (
                        cleaned === scanRfidLastSubmitRef.current.value &&
                        now - scanRfidLastSubmitRef.current.time < 1000
                      ) {
                        return;
                      }
                      scanRfidLastSubmitRef.current = { value: cleaned, time: now };
                      setScanRfidValue(cleaned);
                      setScanRfidError('');
                    }
                  }}
                  autoFocus
                  tabIndex={-1}
                  aria-hidden="true"
                  // Visually hidden but still focusable + key-receiving.
                  // `pointer-events: none` would block focus, so we just
                  // collapse the box and zero out opacity instead.
                  style={{
                    position: 'absolute',
                    left: '-9999px',
                    top: 'auto',
                    width: 1,
                    height: 1,
                    overflow: 'hidden',
                    opacity: 0,
                  }}
                />

                {/* Read-only display chip — shows the LAST committed
                    scan value (or "Awaiting scan..." when empty). No
                    text-entry possible because the chip is a div, not
                    an input, per operator request. */}
                <div>
                  <label className="block text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">RFID Tag</label>
                  <div
                    onClick={() => scanRfidInputRef.current?.focus()}
                    className={`w-full min-h-[3rem] px-3 py-3 border-2 rounded-xl text-base font-mono break-all select-none cursor-default flex items-center justify-between gap-3 ${
                      scanRfidValue
                        ? 'border-violet-300 bg-violet-50 text-slate-900'
                        : 'border-dashed border-slate-300 bg-slate-50 text-slate-400'
                    }`}
                  >
                    <span className="flex-1">{scanRfidValue || 'Awaiting scan...'}</span>
                    {scanRfidValue && (
                      <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider text-violet-600 font-bold shrink-0">
                        <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
                        Scanned
                      </span>
                    )}
                  </div>
                  {scanRfidError && (
                    <div className="mt-2 text-xs text-rose-600 font-medium">{scanRfidError}</div>
                  )}
                </div>

                {result.kind === 'idle' && (
                  <div className="rounded-xl bg-slate-50 border border-slate-200 p-6 text-center text-sm text-slate-500">
                    Scan a tag to look up the mapped filter.
                  </div>
                )}

                {result.kind === 'not_found' && (
                  <div className="rounded-xl bg-rose-50 border-2 border-rose-300 p-4 text-sm">
                    <div className="font-semibold text-rose-700">Tag Not Assigned</div>
                    <div className="text-rose-600 mt-1 break-all font-mono text-xs">{tag}</div>
                    <div className="text-slate-600 mt-2 text-xs">This RFID is not mapped to any filter. Assign it from the RFID Assign view first.</div>
                  </div>
                )}

                {result.kind === 'orphan' && (
                  <div className="rounded-xl bg-amber-50 border-2 border-amber-300 p-4 text-sm">
                    <div className="font-semibold text-amber-800">Stale RFID Mapping</div>
                    <div className="text-amber-700 mt-1 break-all font-mono text-xs">{result.tag}</div>
                    <div className="text-slate-600 mt-2 text-xs">The tag is mapped to an asset that no longer exists. Refresh the page or contact admin.</div>
                  </div>
                )}

                {result.kind === 'wrong_kind' && (
                  <div className="rounded-xl bg-amber-50 border-2 border-amber-300 p-4 text-sm">
                    <div className="font-semibold text-amber-800">Not a Filter</div>
                    <div className="text-amber-700 mt-1 text-xs">Tag <span className="font-mono break-all">{result.tag}</span> is mapped to <span className="font-semibold">"{result.name}"</span>, which is not a FILTER-kind asset.</div>
                  </div>
                )}

                {result.kind === 'ok' && (
                  <div className="rounded-2xl bg-emerald-50 border-2 border-emerald-300 p-4 space-y-3">
                    <div className="flex items-start justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-[10px] uppercase tracking-wider text-emerald-700 font-bold">Match Found</div>
                        <div className="text-base font-bold text-slate-900 mt-0.5 break-all">{result.filter.name}</div>
                      </div>
                      <span className={`text-[10px] px-2.5 py-1 rounded-full border font-medium whitespace-nowrap ${stageInfo ? `${stageInfo.bg} ${stageInfo.text} ${stageInfo.border}` : 'bg-slate-50 text-slate-400 border-slate-200'}`}>
                        {result.filter.currentLifecycleState?.replace(/_/g, ' ') ?? 'To Be Cleaned'}
                      </span>
                    </div>

                    <div className="grid grid-cols-3 gap-2 text-xs">
                      <div className="bg-white rounded-lg border border-emerald-200 p-2">
                        <div className="text-[9px] uppercase tracking-wider text-slate-400 font-medium">Block</div>
                        <div className="text-slate-800 font-semibold mt-0.5 truncate" title={result.block?.name ?? '—'}>{result.block?.name ?? '—'}</div>
                      </div>
                      <div className="bg-white rounded-lg border border-emerald-200 p-2">
                        <div className="text-[9px] uppercase tracking-wider text-slate-400 font-medium">Area</div>
                        <div className="text-slate-800 font-semibold mt-0.5 truncate" title={result.area?.name ?? '—'}>{result.area?.name ?? '—'}</div>
                      </div>
                      <div className="bg-white rounded-lg border border-emerald-200 p-2">
                        <div className="text-[9px] uppercase tracking-wider text-slate-400 font-medium">AHU</div>
                        <div className="text-slate-800 font-semibold mt-0.5 truncate" title={result.ahu?.name ?? '—'}>{result.ahu?.name ?? '—'}</div>
                      </div>
                    </div>

                    <div className="bg-white rounded-lg border border-emerald-200 p-2">
                      <div className="text-[9px] uppercase tracking-wider text-slate-400 font-medium">RFID Tag</div>
                      <div className="text-slate-800 font-mono text-xs mt-0.5 break-all">{result.tag}</div>
                    </div>

                    <div className="bg-white rounded-lg border border-emerald-200 p-2">
                      <div className="text-[9px] uppercase tracking-wider text-slate-400 font-medium">Last Cleaned</div>
                      <div className="text-slate-800 text-xs mt-0.5">{fmt(result.lastCleaned)}</div>
                    </div>
                  </div>
                )}

                <div className="flex items-center justify-between gap-2 pt-2">
                  <button
                    onClick={() => {
                      setScanRfidValue('');
                      setScanRfidError('');
                      scanRfidLastSubmitRef.current = { value: '', time: 0 };
                      if (scanRfidInputRef.current) scanRfidInputRef.current.value = '';
                      scanRfidInputRef.current?.focus();
                    }}
                    className="px-3 py-2 rounded-xl text-xs font-semibold text-slate-700 bg-slate-100 active:bg-slate-200"
                  >
                    Clear
                  </button>
                  <button
                    onClick={() => setScanRfidOpen(false)}
                    className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-slate-700 active:bg-slate-800"
                  >
                    Close
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* === Replacement Tasks (separate page) === */}
      {view === 'replacement-tasks' && (
        <div className="flex-1 overflow-y-auto">
          <div className="p-4 space-y-4 max-w-2xl mx-auto">
            <button onClick={() => { setActiveReplTask(null); setView('home'); }} className="text-[12px] text-slate-500 font-medium active:text-slate-700 flex items-center gap-1">
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.4}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg> Home
            </button>
            <h2 className="font-display text-[20px] font-semibold text-slate-900">Replacement Tasks</h2>

            {!activeReplTask ? (
              <>
                {/* Pending / Completed tabs */}
                <div className="flex gap-2">
                  {(['pending', 'completed'] as const).map((tab) => (
                    <button key={tab} onClick={() => setReplTaskTab(tab)}
                      className={`flex-1 py-2 rounded-xl text-[12px] font-semibold border transition-colors ${replTaskTab === tab ? 'bg-rose-500 text-white border-rose-500' : 'bg-white text-slate-600 border-slate-200 active:bg-slate-50'}`}>
                      {tab === 'pending' ? `Pending (${replDueTasks.length})` : `Completed (${replCompletedTasks.length})`}
                    </button>
                  ))}
                </div>
                {(() => {
                  const list = replTaskTab === 'pending' ? replDueTasks : replCompletedTasks;
                  if (list.length === 0) {
                    return <div className="bg-white border border-slate-200 rounded-xl p-8 text-center text-sm text-slate-500">{replTaskTab === 'pending' ? 'No pending replacement tasks.' : 'No completed replacement tasks yet.'}</div>;
                  }
                  return (
                    <div className="space-y-2">
                      {list.map((t: any) => {
                        const meta = REPL_STATUS_META[t.computedStatus] ?? REPL_STATUS_META.PENDING;
                        const isCompleted = t.computedStatus === 'COMPLETED';
                        return (
                          <button key={t.id} disabled={isCompleted}
                            onClick={isCompleted ? undefined : () => { setActiveReplTask(t); replTaskScan.setValue(''); setReplTaskError(''); setReplTaskSelected(new Set()); setReplTaskSearch(''); }}
                            className={`tile-lift w-full rounded-xl border border-slate-200 bg-white p-3 text-left flex items-center justify-between ${isCompleted ? 'opacity-90' : 'active:bg-slate-50'}`}>
                            <div className="min-w-0 flex-1">
                              <div className="flex items-center gap-2">
                                <div className="font-display text-[14px] font-semibold text-slate-900 truncate">{t.ahuName}</div>
                                <span className={`text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded-full border shrink-0 ${meta.cls}`}>{meta.label}</span>
                              </div>
                              <div className="text-[11px] text-slate-500 mt-0.5">micron {naText(t.filterMicron)} · dimensions {naText(t.filterSize)}</div>
                              <div className="text-[10.5px] text-slate-400 mt-0.5">{isCompleted ? 'scheduled' : 'due by'} {t.windowEnd ? formatDate(t.windowEnd) : '—'}</div>
                            </div>
                            <span className={`text-[11px] font-bold rounded-full px-2.5 py-1 shrink-0 border ${isCompleted ? 'text-emerald-700 bg-emerald-50 border-emerald-200' : 'text-rose-600 bg-rose-50 border-rose-200'}`}>
                              {isCompleted ? `${t.replaced}/${t.total} done` : `${t.qtyRemaining} of ${t.qty} left`}
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })()}
              </>
            ) : (() => {
              // ── Pick-from-list candidates: active filters under this task's AHU
              // that haven't been replaced yet for THIS task. Per user (2026-06-15):
              // the task covers the WHOLE AHU (no micron/size filter), and a filter
              // already swapped under this task (its replacement id is in
              // replacedNewFilterIds) drops off the list — what's left is exactly the
              // "still to replace" set. Name search narrows further.
              const replacedSet = new Set<string>(activeReplTask.replacedNewFilterIds ?? []);
              const ahuFilters = (allFilters as any[]).filter((f: any) => f.parentId === activeReplTask.ahuId && !replacedSet.has(f.id));
              const q = replTaskSearch.trim().toLowerCase();
              const candidates = (q ? ahuFilters.filter((f: any) => (f.name ?? '').toLowerCase().includes(q)) : ahuFilters)
                .slice().sort((a: any, b: any) => String(a.name ?? '').localeCompare(String(b.name ?? '')));
              const remaining = activeReplTask.qtyRemaining ?? activeReplTask.qty ?? 0;
              const atCap = replTaskSelected.size >= remaining;
              const toggleSel = (fid: string) => setReplTaskSelected(prev => {
                const next = new Set(prev);
                if (next.has(fid)) next.delete(fid);
                else { if (next.size >= remaining) return prev; next.add(fid); }
                return next;
              });
              return (
              <div className="space-y-4">
                <button onClick={() => { setActiveReplTask(null); replTaskScan.setValue(''); setReplTaskError(''); setReplTaskSelected(new Set()); setReplTaskSearch(''); }} className="text-[12px] text-slate-500 font-medium flex items-center gap-1">
                  <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={2.4}><path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" /></svg> back to tasks
                </button>
                <div className="bg-white border border-slate-200 rounded-2xl p-4">
                  <div className="font-display text-[15px] font-semibold text-slate-900">{activeReplTask.ahuName}</div>
                  <div className="text-[12px] text-slate-500 mt-0.5">scheduled spec: micron {naText(activeReplTask.filterMicron)} · dimensions {naText(activeReplTask.filterSize)}</div>
                  <div className="text-[12px] text-rose-600 font-medium mt-1">{remaining} of {activeReplTask.total ?? activeReplTask.qty} filters still to replace</div>
                  {activeReplTask.replaced > 0 && (
                    <div className="text-[11px] text-emerald-600 font-medium mt-0.5">{activeReplTask.replaced} already replaced for this task</div>
                  )}
                </div>
                <div>
                  <label className="block text-[10px] uppercase tracking-[0.15em] text-rose-600 font-semibold mb-1.5">Scan filter to replace</label>
                  <input data-rfid="true" type="text" value={replTaskScan.value}
                    onKeyDown={(e) => { replTaskScan.onKeyDown(e); if (e.key === 'Enter' && !replTaskSubmitting) { e.preventDefault(); resolveAndExecuteReplTask(); } }}
                    onChange={replTaskScan.onChange} placeholder="Scan or type the old filter's tag, then Enter" autoFocus
                    className="w-full px-3 py-3 border border-rose-200 rounded-xl text-base font-mono bg-rose-50/40 focus:ring-2 focus:ring-rose-500 focus:border-rose-500" />
                  <div className="text-[10.5px] text-slate-400 mt-1.5">Scan replaces one filter instantly — or pick from the list below.</div>
                </div>

                {/* ── Pick from the AHU's filters (multi-select up to qty) ── */}
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <label className="block text-[10px] uppercase tracking-[0.15em] text-slate-500 font-semibold">
                      Filters in {activeReplTask.ahuName}
                    </label>
                    <span className="text-[10.5px] text-slate-400">select up to {remaining}</span>
                  </div>
                  <input type="text" value={replTaskSearch} onChange={e => setReplTaskSearch(e.target.value)}
                    placeholder="Search by filter name…"
                    className="w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:ring-2 focus:ring-rose-500 focus:border-rose-500" />
                  {candidates.length === 0 ? (
                    <div className="bg-white border border-slate-200 rounded-xl p-6 text-center text-sm text-slate-500">
                      {ahuFilters.length === 0 ? 'No active filters found under this AHU.' : 'No filters match your search.'}
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {candidates.slice(0, 80).map((f: any) => {
                        const tags = rfidTagsByFilter.get(f.id) ?? [];
                        const firstTag = tags[0]?.identifierValue ?? '';
                        const selected = replTaskSelected.has(f.id);
                        const disabled = !selected && atCap;
                        return (
                          <button key={f.id} onClick={() => toggleSel(f.id)} disabled={disabled}
                            className={`tile-lift w-full rounded-xl border p-3 text-left flex items-center gap-3 transition-colors ${
                              selected ? 'border-rose-300 bg-rose-50' : 'border-slate-200 bg-white active:bg-slate-50'
                            } ${disabled ? 'opacity-40' : ''}`}>
                            <span className={`w-5 h-5 rounded-md border flex items-center justify-center shrink-0 ${
                              selected ? 'bg-rose-500 border-rose-500' : 'border-slate-300 bg-white'
                            }`}>
                              {selected && <svg className="w-3.5 h-3.5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24" strokeWidth={3}><path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" /></svg>}
                            </span>
                            <div className="min-w-0 flex-1">
                              <div className="font-display text-[13px] font-semibold text-slate-900 truncate leading-tight">{f.name}</div>
                              <div className="mt-1 grid grid-cols-2 gap-x-3 gap-y-0.5 text-[10px] text-slate-500">
                                {filterDetailPairs(f).map(([label, val]) => (
                                  <div key={label} className="truncate"><span className="text-slate-400">{label}:</span> {val}</div>
                                ))}
                                <div className="truncate"><span className="text-slate-400">Tag:</span> {firstTag ? <span className="font-mono-tab text-slate-600">{firstTag}</span> : 'none'}</div>
                              </div>
                            </div>
                          </button>
                        );
                      })}
                      {candidates.length > 80 && (
                        <div className="text-[10.5px] text-slate-400 text-center">Showing first 80 — search to narrow.</div>
                      )}
                    </div>
                  )}
                </div>

                {replTaskError && <div className="text-[12px] text-rose-700 font-medium">{replTaskError}</div>}

                <button onClick={executeBatchReplTask} disabled={replTaskSubmitting || replTaskSelected.size === 0}
                  className="w-full py-3 rounded-xl text-sm font-semibold text-white bg-gradient-to-r from-rose-500 to-pink-600 shadow-lg active:shadow-none disabled:opacity-50">
                  {replTaskSubmitting
                    ? 'Replacing…'
                    : replTaskSelected.size === 0 ? 'Select filters to replace' : `Replace ${replTaskSelected.size} selected filter${replTaskSelected.size === 1 ? '' : 's'}`}
                </button>
              </div>
              );
            })()}
          </div>
        </div>
      )}

      {/* --- BOTTOM NAVIGATION --- */}
      {view !== 'operations' && (
        <div className="bg-white/90 backdrop-blur-lg border-t border-slate-200/60 px-2 py-2 flex items-center justify-around shrink-0 z-10">
          {/* 2026-05-21: bottom-nav buttons gated by hasFeature so admin's
              tablet-access allowlist actually blocks navigation. Home is
              always reachable (it's the safe landing for any logged-in user). */}
          <button onClick={() => setView('home')} className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-colors ${view === 'home' ? 'text-cyan-600' : 'text-slate-400'}`}>
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6" /></svg>
            <span className="text-[10px] font-semibold">Home</span>
          </button>
          {hasFeature('filter_status') && (
            <button onClick={() => setView('status')} className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-colors ${view === 'status' ? 'text-cyan-600' : 'text-slate-400'}`}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" /></svg>
              <span className="text-[10px] font-semibold">Status</span>
            </button>
          )}
          {hasFeature('my_tasks') && (
            <button onClick={() => setView('my-tasks')} className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-colors ${view === 'my-tasks' ? 'text-cyan-600' : 'text-slate-400'}`}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" /></svg>
              <span className="text-[10px] font-semibold">My Tasks</span>
            </button>
          )}
          {hasFeature('approvals') && (
            <button onClick={() => setView('approvals')} className={`flex flex-col items-center gap-0.5 px-3 py-1.5 rounded-xl transition-colors ${view === 'approvals' ? 'text-cyan-600' : 'text-slate-400'}`}>
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
              <span className="text-[10px] font-semibold">Approvals</span>
            </button>
          )}
        </div>
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={() => { reauth.cancel(); setRfidSubmitting(false); setReplaceSubmitting(false); setReplTaskSubmitting(false); }}
        actionLabel="RFID Tag"
      />
      <ReauthDialog
        open={blockChangeApproval.reauth.isOpen}
        password={blockChangeApproval.reauth.password}
        error={blockChangeApproval.reauth.error}
        isVerifying={blockChangeApproval.reauth.isVerifying}
        onPasswordChange={blockChangeApproval.reauth.setPassword}
        onConfirm={blockChangeApproval.reauth.confirm}
        onCancel={() => { blockChangeApproval.reauth.cancel(); setProcessingApproval(null); }}
        actionLabel="Process Block Change"
      />
      {/* W4: read-only blocker overlay when hard-cutoff window elapsed */}
      <HardCutoffBlocker />
    </div>
  );
}
