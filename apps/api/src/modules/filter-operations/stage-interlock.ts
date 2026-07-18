/**
 * Cleaning Stage Interlock — the two-point QA approval gate.
 *
 * After WASH_OUT and after DRY_OUT a cycle pauses: completing the stage creates
 * a PENDING CleaningStageApproval routed to a configurable approver role, and
 * the operator cannot LEAVE the stage until the latest approval for that
 * (cycle, stage) is APPROVED. Reject moves the filter back (WASH_OUT→WASH_IN,
 * DRY_OUT→DRY_IN) and the operator re-cleans.
 *
 * Enforcement layers:
 *   - server gate (assertStageApprovedToLeave) — authoritative, in advance/bypass.
 *   - cached tape/stageLookup interlockGated flag — stops the OFFLINE client at a
 *     gated stage (offline can't reach an approver, per the "block until online"
 *     decision). Computed in current-state.ts from this module's primitives.
 *
 * No runtime effect until config `stage-interlock.enabled` is turned on.
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import { createNotification } from '../notifications/notification.service.js';
import type { BatchReadCache } from './batch-cache.js';

type Tx = Parameters<Parameters<typeof prisma.$transaction>[0]>[0];

/**
 * Fixed interlock points (per spec — NOT configurable): the gated stage and the
 * state the filter returns to when the approver rejects.
 */
export const INTERLOCK_POINTS: Record<string, { rejectToStateKey: string }> = {
  WASH_OUT: { rejectToStateKey: 'WASH_IN' },
  DRY_OUT: { rejectToStateKey: 'DRY_IN' },
};

export interface StageInterlockConfig {
  enabled: boolean;
  requireDifferentApprover: boolean;
  washOutApproverRole: string;
  dryOutApproverRole: string;
}

const DEFAULTS: StageInterlockConfig = {
  enabled: false,
  requireDifferentApprover: true,
  washOutApproverRole: 'ADMIN',
  dryOutApproverRole: 'ADMIN',
};

export async function getInterlockConfig(cache?: BatchReadCache): Promise<StageInterlockConfig> {
  // M39: one config row that getCurrentState reads unconditionally, so the batch
  // path re-read it once per filter. Memoise the resolved config for the batch.
  if (cache) return cache.memo('interlock-config', () => getInterlockConfig());
  const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'stage-interlock' } });
  const v = (cfg?.configValue ?? {}) as Partial<StageInterlockConfig>;
  const role = (x: unknown, fallback: string) =>
    (typeof x === 'string' && x.trim()) ? x.trim() : fallback;
  return {
    enabled: v.enabled === true,
    requireDifferentApprover: v.requireDifferentApprover !== false,
    washOutApproverRole: role(v.washOutApproverRole, DEFAULTS.washOutApproverRole),
    dryOutApproverRole: role(v.dryOutApproverRole, DEFAULTS.dryOutApproverRole),
  };
}

/** Type-guard: is this stateKey one of the fixed interlock points? (static, config-free) */
export function isInterlockStage(stateKey: string | null | undefined): stateKey is string {
  return !!stateKey && Object.prototype.hasOwnProperty.call(INTERLOCK_POINTS, stateKey);
}

export function getApproverRoleForStage(stageKey: string, config: StageInterlockConfig): string {
  if (stageKey === 'DRY_OUT') return config.dryOutApproverRole;
  return config.washOutApproverRole; // WASH_OUT (and any other point) → wash-out role
}

/** Latest approval for (cycle, stage) — highest attempt first, then most recent. */
export function getLatestApproval(cycleId: string, stageKey: string) {
  return prisma.cleaningStageApproval.findFirst({
    where: { cycleId, stageKey },
    orderBy: [{ attemptSeq: 'desc' }, { requestedAt: 'desc' }],
  });
}

/**
 * Gate: an operator may LEAVE an interlock stage only if the LATEST approval for
 * (cycle, stage) is APPROVED. Throws 423 otherwise. No-op when interlock is
 * disabled, fromState is not a gated stage, or it's an in-place transition
 * (target === from, e.g. the dryer SET_DURATION/SUBMIT_READINGS at DRY_IN).
 */
export async function assertStageApprovedToLeave(params: {
  cycleId: string;
  fromState: string | null;
  targetState: string;
  config?: StageInterlockConfig;
}): Promise<void> {
  const { cycleId, fromState, targetState } = params;
  if (!isInterlockStage(fromState)) return;
  if (targetState === fromState) return; // in-place — not a leave
  const config = params.config ?? (await getInterlockConfig());
  if (!config.enabled) return;
  const latest = await getLatestApproval(cycleId, fromState);
  if (latest?.status === 'APPROVED') return;
  if (latest?.status === 'REJECTED') {
    throw new AppError(
      423,
      'STAGE_APPROVAL_REJECTED',
      `${prettyStage(fromState)} was rejected by the approver. The filter must restart from ${prettyStage(INTERLOCK_POINTS[fromState].rejectToStateKey)}.`,
    );
  }
  throw new AppError(
    423,
    'STAGE_APPROVAL_PENDING',
    `${prettyStage(fromState)} is awaiting approval from ${getApproverRoleForStage(fromState, config)} before this filter can continue.`,
  );
}

export interface FilterApprovalDetails {
  filterName: string | null;
  block: string | null;
  area: string | null;
  ahu: string | null;
  ahuType: string | null;
  micronSize: string | null;
  filterType: string | null;
  filterDimensions: string | null;
  filterSet: string | null;
}

/**
 * Frozen snapshot of the filter's identity + context for the approver. Reads
 * filter attributes from the typed `filters` table (filter.id === assetInstance.id
 * via the mirror), filterSet from FilterDetails, and walks the asset_instances
 * ancestor chain resolving block/area/AHU by templateKind (depth varies — never
 * assume a fixed number of levels).
 */
export async function collectFilterApprovalDetails(filterId: string): Promise<FilterApprovalDetails> {
  const [filterRow, fd, self] = await Promise.all([
    prisma.filter.findUnique({ where: { id: filterId }, select: { attributes: true } }),
    prisma.filterDetails.findUnique({ where: { assetInstanceId: filterId }, select: { filterSet: true } }),
    prisma.assetInstance.findUnique({ where: { id: filterId }, select: { name: true, parentId: true } }),
  ]);
  const attrs = (filterRow?.attributes ?? {}) as Record<string, unknown>;

  let block: string | null = null;
  let area: string | null = null;
  let ahu: string | null = null;
  let parentId = self?.parentId ?? null;
  const visited = new Set<string>();
  let guard = 0;
  while (parentId && guard++ < 12 && !visited.has(parentId)) {
    visited.add(parentId);
    const node = await prisma.assetInstance.findUnique({
      where: { id: parentId },
      select: { name: true, parentId: true, template: { select: { templateKind: true } } },
    });
    if (!node) break;
    const kind = node.template?.templateKind ?? null;
    if (kind === 'AHU' && !ahu) ahu = node.name;
    else if (kind === 'AREA' && !area) area = node.name;
    else if (kind === 'BLOCK' && !block) block = node.name;
    parentId = node.parentId;
  }

  const str = (v: unknown): string | null =>
    typeof v === 'string' ? (v.trim() || null) : v == null ? null : String(v);

  return {
    filterName: self?.name ?? null,
    block,
    area,
    ahu,
    ahuType: str(attrs.ahuType),
    micronSize: str(attrs.micronSize),
    filterType: str(attrs.filterType),
    filterDimensions: str(attrs.filterSize), // `filterSize` attribute == physical dimensions
    filterSet: fd?.filterSet ?? null,
  };
}

/**
 * Create a PENDING approval for (cycle, stage) if none is currently open. MUST be
 * called inside the advance transaction so the approval commits atomically with
 * entering the stage (no window where the filter sits at WASH_OUT with no gate).
 * Idempotent: returns null if an open PENDING already exists. attemptSeq =
 * (max prior attemptSeq for cycle+stage) + 1 so reject→redo loops stay distinct.
 */
export async function requestStageApprovalTx(
  tx: Tx,
  params: {
    cycleId: string;
    filterId: string;
    stageKey: string;
    approverRole: string;
    detailsSnapshot: FilterApprovalDetails;
    ctx: RequestContext;
  },
) {
  const { cycleId, filterId, stageKey, approverRole, detailsSnapshot, ctx } = params;
  const openPending = await tx.cleaningStageApproval.findFirst({
    where: { cycleId, stageKey, status: 'PENDING' },
    select: { id: true },
  });
  if (openPending) return null;
  const last = await tx.cleaningStageApproval.findFirst({
    where: { cycleId, stageKey },
    orderBy: { attemptSeq: 'desc' },
    select: { attemptSeq: true },
  });
  return tx.cleaningStageApproval.create({
    data: {
      cycleId,
      filterId,
      stageKey,
      status: 'PENDING',
      approverRole,
      rejectToStateKey: INTERLOCK_POINTS[stageKey].rejectToStateKey,
      attemptSeq: (last?.attemptSeq ?? 0) + 1,
      detailsSnapshot: detailsSnapshot as object,
      requestedBy: ctx.userSub,
      requestedByName: ctx.userId,
    },
  });
}

/** Best-effort notification to the approver role. Never breaks the cycle. */
export async function notifyStageApprovalRequested(
  row: { id: string; filterId: string; stageKey: string; approverRole: string },
  filterName: string | null,
  ctx: RequestContext,
): Promise<void> {
  try {
    await createNotification({
      type: 'STAGE_APPROVAL_REQUESTED',
      title: 'Cleaning stage awaiting your approval',
      message: `${prettyStage(row.stageKey)} for filter "${filterName ?? row.filterId}" needs your approval before cleaning can continue.`,
      forRole: row.approverRole,
      metadata: { stageApprovalId: row.id, filterId: row.filterId, stageKey: row.stageKey },
      createdBy: ctx.userId,
    });
  } catch (e) {
    console.error('[stage-interlock] notify approver failed:', (e as Error).message);
  }
}

/** "WASH_OUT" → "Wash Out". */
export function prettyStage(stateKey: string): string {
  return stateKey
    .split('_')
    .map((w) => w.charAt(0) + w.slice(1).toLowerCase())
    .join(' ');
}
