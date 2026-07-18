/**
 * Shared cleaning-profile stage-sequence rules.
 *
 * Single source of truth for "what stage can this filter legally move to next",
 * reused by BOTH:
 *   - the web "Edit Filter Status" dialog (constrains the options it shows +
 *     blocks invalid moves), and
 *   - server-side validation of manual lifecycle moves (changeLifecycleState).
 *
 * Rule parity with the tablet cleaning engine (cycle-write/advance.ts) is
 * guaranteed by reusing the SAME exported `findReachable()` the tablet path
 * uses — we do NOT re-derive the graph walk. `findReachable(node)` returns the
 * IMMEDIATE next STAGE(s) reachable from a node, walking through intermediate
 * CHECKLIST nodes but stopping at the next STAGE — i.e. "Wash Out → Dry" is
 * allowed, "Dirty → Storage Out" (a skip) is not.
 */
import { prisma } from '../../lib/prisma.js';
import { findReachable } from '@digilog/shared';
import { resolveFilterProfile, getProfilePipeline } from './filter-resolver.js';

export const COMPLETED_STATE = 'CLEANING_CYCLE_COMPLETED';

export interface FilterStageRules {
  /** Does the filter resolve to a cleaning profile with a pipeline? */
  hasProfile: boolean;
  profileId: string | null;
  profileName: string | null;
  /** Every STAGE stateKey in pipeline order (START → … → END). Drives P2's
   *  "missing stage = NA" and the dialog's ordered option list. */
  orderedStages: string[];
  /** The filter's current lifecycle state (may be null, or a non-cleaning
   *  operational state like INSTALLED / IN_USE). */
  currentStage: string | null;
  /** Whether the filter currently has an IN_PROGRESS cleaning cycle. Drives P3:
   *  a backward move with an active cycle breaks+restarts it; a cleaning move
   *  with no active cycle starts a fresh one. */
  hasActiveCycle: boolean;
  /** Valid immediate forward stage(s) from the current stage (one graph hop,
   *  through any CHECKLIST nodes). */
  immediateNext: string[];
  /** Whether the cycle would auto-complete (END reachable) from current. */
  leadsToEnd: boolean;
}

export type MoveClassification =
  | 'SAME'          // target === current — no-op
  | 'COMPLETE'      // target is CLEANING_CYCLE_COMPLETED
  | 'NON_CLEANING'  // target is an operational state not in the profile (INSTALLED/IN_USE/IDLE) — no sequence rule
  | 'START'         // no current cleaning stage; target is the pipeline's first stage
  | 'FORWARD'       // target is an immediate valid next stage
  | 'BACKWARD'      // target is an earlier cleaning stage in the pipeline
  | 'SKIP';         // target is a later cleaning stage but not the immediate next — INVALID

/**
 * Resolve a filter's cleaning-profile stage rules. Works whether or not the
 * filter currently has an active cycle (the dialog needs it pre-cycle too).
 */
export async function getFilterStageRules(filterId: string): Promise<FilterStageRules> {
  const filter = await prisma.assetInstance.findUnique({
    where: { id: filterId },
    select: {
      id: true,
      name: true,
      filterDetails: { select: { filterProfileId: true, filterSet: true, currentLifecycleState: true, currentCycleId: true } },
    },
  });
  const currentStage = filter?.filterDetails?.currentLifecycleState ?? null;
  // An "active" cycle is the pinned currentCycleId AND still IN_PROGRESS.
  let hasActiveCycle = false;
  const activeCycleId = filter?.filterDetails?.currentCycleId ?? null;
  if (activeCycleId) {
    const c = await prisma.cleaningCycle.findFirst({ where: { id: activeCycleId, status: 'IN_PROGRESS' }, select: { id: true } });
    hasActiveCycle = !!c;
  }
  const empty: FilterStageRules = {
    hasProfile: false, profileId: null, profileName: null,
    orderedStages: [], currentStage, hasActiveCycle, immediateNext: [], leadsToEnd: false,
  };
  if (!filter) return empty;

  const profileId = await resolveFilterProfile({
    id: filter.id,
    filterProfileId: filter.filterDetails?.filterProfileId ?? null,
    filterSet: filter.filterDetails?.filterSet ?? null,
    name: filter.name ?? null,
  });
  if (!profileId) return empty;

  const cp = await getProfilePipeline(profileId, false);
  if (!cp) return empty;

  const nodes = cp.stages as any[];
  const edges = cp.connections as any[];
  const orderedStages = orderStagesFromStart(nodes, edges);

  // Move FROM the current cleaning-stage node; if the current state is null or
  // a non-cleaning operational state (no matching STAGE node), fall back to the
  // START node so the dialog still offers the pipeline's first stage.
  const startNode = nodes.find((n) => n.nodeType === 'START');
  const fromNode = currentStage
    ? nodes.find((n) => n.nodeType === 'STAGE' && n.stateKey === currentStage) ?? startNode
    : startNode;
  const reach = fromNode
    ? findReachable(fromNode.id, nodes as any, edges as any)
    : { reachableStages: [] as string[], hasEndNext: false };

  return {
    hasProfile: true,
    profileId,
    profileName: (cp as any).name ?? null,
    orderedStages,
    currentStage,
    hasActiveCycle,
    immediateNext: [...new Set(reach.reachableStages)],
    leadsToEnd: reach.hasEndNext,
  };
}

/**
 * Does moving this filter to `target` start (or restart) a cleaning cycle?
 *   - With an active cycle: only a BACKWARD move (breaks current + starts new).
 *   - With no active cycle: any allowed cleaning-stage move (starts fresh).
 * COMPLETE, SKIP, SAME and non-cleaning operational states never start a cycle.
 * When true, the caller must supply a cleaning reason (D2: prompt operator).
 */
export function moveStartsCycle(rules: FilterStageRules, target: string): boolean {
  if (target === COMPLETED_STATE) return false;
  if (!rules.orderedStages.includes(target)) return false;
  const cls = classifyMove(rules, target);
  if (cls === 'SKIP' || cls === 'SAME') return false;
  return rules.hasActiveCycle ? cls === 'BACKWARD' : true;
}

/**
 * Ordered STAGE stateKeys for a profile id (FilterProfile OR CleaningProfile id).
 * Used by the Cleaning Cycles view to render "NA" for stages a cycle's profile
 * does not configure (P2). Returns [] when the profile can't be resolved.
 */
export async function getProfileOrderedStages(profileId: string): Promise<string[]> {
  const cp = await getProfilePipeline(profileId, false);
  if (!cp) return [];
  return orderStagesFromStart(cp.stages as any[], cp.connections as any[]);
}

/** Walk the pipeline from START, collecting STAGE stateKeys in traversal order. */
function orderStagesFromStart(nodes: any[], edges: any[]): string[] {
  const start = nodes.find((n) => n.nodeType === 'START');
  const ordered: string[] = [];
  const seen = new Set<string>();
  const visited = new Set<string>();
  const walk = (id: string) => {
    if (visited.has(id)) return;
    visited.add(id);
    const node = nodes.find((n) => n.id === id);
    if (node?.nodeType === 'STAGE' && node.stateKey && !seen.has(node.stateKey)) {
      seen.add(node.stateKey);
      ordered.push(node.stateKey);
    }
    for (const e of edges.filter((c) => c.fromStageId === id)) walk(e.toStageId);
  };
  if (start) walk(start.id);
  // Fallback: any STAGE nodes not reachable from START (malformed graph),
  // appended in sortOrder so the list is still complete for "missing = NA".
  for (const n of nodes) {
    if (n.nodeType === 'STAGE' && n.stateKey && !seen.has(n.stateKey)) {
      seen.add(n.stateKey);
      ordered.push(n.stateKey);
    }
  }
  return ordered;
}

/**
 * Classify a requested manual move against the profile sequence. Callers decide
 * what to allow:
 *   - P1 blocks only 'SKIP' (forward skip — invalid per spec).
 *   - 'BACKWARD' is allowed today as a plain move; P3 upgrades it to
 *     break-cycle-and-restart.
 *   - 'NON_CLEANING' (INSTALLED / IN_USE / IDLE …) carries no sequence rule.
 */
export function classifyMove(rules: FilterStageRules, target: string): MoveClassification {
  if (target === rules.currentStage) return 'SAME';
  if (target === COMPLETED_STATE) return 'COMPLETE';
  if (!rules.orderedStages.includes(target)) return 'NON_CLEANING';
  if (rules.immediateNext.includes(target)) return rules.currentStage ? 'FORWARD' : 'START';
  const ci = rules.orderedStages.indexOf(rules.currentStage ?? '');
  const ti = rules.orderedStages.indexOf(target);
  if (ci >= 0 && ti >= 0 && ti < ci) return 'BACKWARD';
  return 'SKIP';
}

export const INVALID_STAGE_MOVE_MESSAGE =
  'Invalid stage movement. Please follow the configured cleaning profile sequence.';

export interface StageOption {
  /** The lifecycle state token (a cleaning stage, or CLEANING_CYCLE_COMPLETED). */
  state: string;
  classification: MoveClassification;
  /** Whether the dialog should let the user pick this (everything except a SKIP). */
  allowed: boolean;
  /** True for the filter's current stage (rendered as current, not selectable). */
  isCurrent: boolean;
  /** True when picking this will start/restart a cleaning cycle — the dialog
   *  must then collect a cleaning reason (P3 / D2). */
  startsCycle: boolean;
}

/**
 * Pre-classify every cleaning stage (+ COMPLETED) for the dialog, so the FE
 * doesn't re-implement the sequence rules — it just renders + disables. The
 * SKIP entries are returned (greyed) so the user sees *why* they can't jump.
 */
export function buildStageOptions(rules: FilterStageRules): StageOption[] {
  const states = [...rules.orderedStages];
  if (!states.includes(COMPLETED_STATE)) states.push(COMPLETED_STATE);
  return states.map((state) => {
    const classification = classifyMove(rules, state);
    return {
      state,
      classification,
      allowed: classification !== 'SKIP',
      isCurrent: state === rules.currentStage,
      startsCycle: moveStartsCycle(rules, state),
    };
  });
}
