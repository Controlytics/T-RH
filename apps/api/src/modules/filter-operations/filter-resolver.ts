/**
 * Filter Operations — filter / profile / pipeline resolution helpers.
 *
 * Extracted from filter-operations.service.ts. These are leaf I/O helpers
 * the orchestrator class composes. Pure moves — no behavioral changes.
 */
import type { RequestContext } from '../../types/context.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../lib/errors.js';
import type { BatchReadCache } from './batch-cache.js';

export type ResolvedFilter = {
  id: string;
  name: string | null;
  parentId: string | null;
  filterProfileId: string | null;
  currentLifecycleState: string | null;
  currentCycleId: string | null;
  filterSet: string | null;
};

export async function getFilter(filterId: string, _ctx: RequestContext): Promise<ResolvedFilter> {
  // parentId is required by retire() to snapshot the original tree position
  // into customAttributes._preRetireParentId so unretire can restore it.
  // Filter cycle state lives on FilterDetails (Step 6) — include + flatten so
  // the rest of this service keeps reading filter.{filterProfileId, currentLifecycleState, currentCycleId, filterSet} unchanged.
  const inst = await prisma.assetInstance.findFirst({
    where: { id: filterId },
    select: {
      id: true, name: true, parentId: true,
      filterDetails: { select: { filterProfileId: true, currentLifecycleState: true, currentCycleId: true, filterSet: true } },
    },
  });
  if (!inst) throw new AppError(404, 'NOT_FOUND', 'Filter not found');
  return {
    id: inst.id,
    name: inst.name ?? null,
    parentId: inst.parentId ?? null,
    filterProfileId: inst.filterDetails?.filterProfileId ?? null,
    currentLifecycleState: inst.filterDetails?.currentLifecycleState ?? null,
    currentCycleId: inst.filterDetails?.currentCycleId ?? null,
    filterSet: (inst.filterDetails?.filterSet ?? null) as string | null,
  };
}

export async function getFilterHomeBlock(filterId: string, cache?: BatchReadCache): Promise<{ blockId: string; blockName: string } | null> {
  let currentId: string | null = filterId;
  const visited = new Set<string>();
  while (currentId) {
    if (visited.has(currentId)) break;
    visited.add(currentId);
    // M39: under getBatchStates every filter climbs this chain, so the shared
    // ancestors (AHU, area, block) get re-read once per filter. Memoise the node
    // read by id — keyed `hb:` because this projection differs from the ones the
    // profile-assignment walks below use.
    const readNode = () => prisma.assetInstance.findUnique({
      where: { id: currentId! },
      select: { id: true, name: true, parentId: true, template: { select: { templateKind: true } } },
    });
    const inst: { id: string; name: string; parentId: string | null; template: { templateKind: string } | null } | null =
      cache ? await cache.memo(`hb:${currentId}`, readNode) : await readNode();
    if (!inst) break;
    if (inst.template?.templateKind === 'BLOCK') {
      return { blockId: inst.id, blockName: inst.name };
    }
    currentId = inst.parentId;
  }
  return null;
}

/**
 * What the caller must still do to spend the clearance it just got.
 *
 * `consumeApproval` is set ONLY when APPROVAL mode let this start through on the
 * strength of an existing approved request. The caller is then obliged to spend
 * it inside its own transaction (see start-cycle) — an approval is single-use.
 * Every other path (no block change, NONE, CONFIRM, offline replay) returns {}.
 */
export type BlockChangeClearance = { consumeApproval?: { filterId: string; toBlockId: string } };

export async function validateBlockChange(
  filterId: string,
  cleaningAreaId: string | undefined,
  ctx: RequestContext,
  acknowledged = false,
): Promise<BlockChangeClearance> {
  if (!cleaningAreaId) return {};
  const homeBlock = await getFilterHomeBlock(filterId);
  if (!homeBlock) return {};
  if (homeBlock.blockId === cleaningAreaId) return {};

  // 2026-06-09: cross-block handling is CONFIGURABLE (config `block-change-approval.mode`)
  // and gates ONLINE ONLY. Offline never blocks — the FE shows an informational notice
  // and proceeds, and the queued op replays here with isOfflineReplay set, which we pass.
  // An offline replay never consumes an approval either — it was never gated on
  // one, so spending one here would silently burn an approval the operator has
  // not used yet.
  if (ctx?.isOfflineReplay) return {};

  const { blockChangeService } = await import('../block-change-requests/block-change.service.js');
  const mode = await blockChangeService.getMode();
  // NONE: no cross-block check at all — any filter may be cleaned in any block,
  // nothing shown or asked. (Cycle-integrity is still enforced separately by
  // validateAdvanceBlock: a cycle can't span blocks once started.)
  if (mode === 'NONE') return {};
  const targetBlock = await prisma.assetInstance.findUnique({
    where: { id: cleaningAreaId },
    select: { name: true },
  });
  const info = {
    filterId,
    mode,
    homeBlockId: homeBlock.blockId,
    homeBlockName: homeBlock.blockName,
    requestedBlockId: cleaningAreaId,
    requestedBlockName: targetBlock?.name ?? '',
  };

  if (mode === 'APPROVAL') {
    // Needs an approved (un-expired) block-change request for this filter→block.
    // The approval is SPENT by the caller inside its own transaction — this read
    // only establishes that one is available. Returning the token rather than
    // consuming here keeps the find+update under the caller's row lock.
    if (await blockChangeService.hasApproval(filterId, cleaningAreaId)) {
      return { consumeApproval: { filterId, toBlockId: cleaningAreaId } };
    }
    throw new AppError(409, 'BLOCK_CHANGE_REQUIRED',
      `This filter belongs to ${homeBlock.blockName}. Request approval to clean it in ${targetBlock?.name ?? 'another block'}.`,
      info);
  }

  // CONFIRM mode: operator self-confirm.
  if (acknowledged) return {};
  throw new AppError(409, 'BLOCK_CHANGE_CONFIRM',
    `This filter belongs to ${homeBlock.blockName}. You are cleaning it in ${targetBlock?.name ?? 'another block'}. Continue with cleaning?`,
    info);
}

/**
 * Advance-time block guard (2026-06-06 fix). The cycle's block is frozen at
 * start (cleaning_cycles.cleaning_area_id). A stage submitted for a DIFFERENT
 * block must be rejected — pre-fix advance() destructured cleaningAreaId,
 * recorded it on the event, but NEVER validated it, so an operator could run
 * a later stage (e.g. DRY_IN) in another block with no block-change request.
 * Config-gated by the same super-admin toggle as start (isEnforcementEnabled).
 *
 * This is a pre-write gate ONLY: it throws before advance() mutates any cycle
 * state and does not change cycle mechanics, stage flow, or cycle codes.
 * Distinct code BLOCK_MISMATCH (not BLOCK_CHANGE_REQUIRED) so the FE surfaces
 * a plain rejection rather than the request-approval popup — a frozen cycle
 * can't be moved to another block, so requesting approval would be a dead end.
 */
export async function validateAdvanceBlock(
  cycle: { filterId?: string; cleaningAreaId?: string | null } | null,
  cleaningAreaId: string | undefined,
): Promise<void> {
  if (!cleaningAreaId) return; // FE sent no block on this advance — nothing to check
  const cycleBlockId = cycle?.cleaningAreaId ?? null;
  // Same block, or a legacy cycle started with no block bound → allow.
  if (!cycleBlockId || cleaningAreaId === cycleBlockId) return;

  // Cross-block mode NONE = no block restriction ANYWHERE (per user). The
  // start-time gate (validateBlockChange) already no-ops under NONE; this
  // mid-cycle guard must too, otherwise an operator who selected a different
  // block for a later stage hits BLOCK_MISMATCH even though blocks are meant to
  // be unrestricted. CONFIRM/APPROVAL keep the guard (a cycle can't span blocks).
  const { blockChangeService } = await import('../block-change-requests/block-change.service.js');
  if (await blockChangeService.getMode() === 'NONE') return;

  // A cycle is frozen to the block it started in. A stage submitted for a
  // different block is always rejected (the cycle can't move blocks mid-flight).
  const [cycleBlock, reqBlock] = await Promise.all([
    prisma.assetInstance.findUnique({ where: { id: cycleBlockId }, select: { name: true } }),
    prisma.assetInstance.findUnique({ where: { id: cleaningAreaId }, select: { name: true } }),
  ]);
  throw new AppError(409, 'BLOCK_MISMATCH',
    `This cleaning cycle is running in ${cycleBlock?.name ?? 'its starting block'}. Perform this stage in ${cycleBlock?.name ?? 'that block'}, not ${reqBlock?.name ?? 'a different block'}.`,
    {
      filterId: cycle?.filterId,
      cycleBlockId,
      cycleBlockName: cycleBlock?.name ?? '',
      requestedBlockId: cleaningAreaId,
      requestedBlockName: reqBlock?.name ?? '',
    },
  );
}

export function getNextStageKeys(fromNodeId: string, stages: any[], connections: any[]): string[] {
  const outConns = connections.filter((c: any) => c.fromStageId === fromNodeId);
  const nextStageIds = outConns.map((c: any) => c.toStageId);
  const nextStages = stages.filter((s: any) => nextStageIds.includes(s.id));
  return nextStages.filter((s: any) => s.nodeType === 'STAGE').map((s: any) => s.stateKey!).filter(Boolean);
}

export function extractBlocks(stages: any[]): { nodeType: string; configuration: any }[] {
  return stages.filter((s: any) => !['STAGE', 'END', 'START', 'CHECKLIST'].includes(s.nodeType))
    .map((s: any) => ({ nodeType: s.nodeType, configuration: s.configuration }));
}

/**
 * Configurable / convention-based fallback. Reads two sources in order:
 *   1. `system_config['default-cleaning-profile'].profileId` — admin-set default
 *   2. First `FilterCleaningProfile` with status=ACTIVE, oldest first
 *
 * Used as the FINAL fallback in resolveFilterProfile() — when neither the
 * filter's direct filterProfileId nor any cleaning-profile-assignment rule
 * matches. Pre-fix, the absence of either threw NO_PROFILE at start-cycle
 * and operators on the tablet saw "no cleaning profile assigned" even when
 * a perfectly usable pipeline existed in the system. Per 2026-05-25 user
 * request: filter_profile_id should not be required for a cycle to start.
 */
async function getDefaultCleaningProfileId(cache?: BatchReadCache): Promise<string | null> {
  // M39: the whole resolution is config-driven and filter-independent, so the
  // batch path memoises the RESULT rather than each read inside it.
  if (cache) return cache.memo('default-cleaning-profile-id', () => getDefaultCleaningProfileId());
  const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'default-cleaning-profile' } });
  const configured = (cfg?.configValue as { profileId?: string } | null)?.profileId;
  if (configured) {
    const exists = await prisma.filterCleaningProfile.findFirst({ where: { id: configured, status: 'ACTIVE' } });
    if (exists) return exists.id;
  }
  const firstActive = await prisma.filterCleaningProfile.findFirst({
    where: { status: 'ACTIVE' },
    orderBy: { createdAt: 'asc' },
    select: { id: true },
  });
  return firstActive?.id ?? null;
}

export async function resolveFilterProfile(filter: { id: string; filterProfileId: string | null; filterSet: string | null; name: string | null }, cache?: BatchReadCache): Promise<string | null> {
  // 1. Direct assignment takes priority
  if (filter.filterProfileId) return filter.filterProfileId;

  // 2. Check config-based assignment
  // M39: one config row, re-read once per filter pre-fix.
  const readAssignment = () => prisma.systemConfig.findUnique({ where: { configKey: 'cleaning-profile-assignment' } });
  const configRow = cache
    ? await cache.memo('cfg:cleaning-profile-assignment', readAssignment)
    : await readAssignment();
  const config = configRow?.configValue as { mode: string; rules: Array<{ matchValue: string; profileId: string }> } | null;
  if (!config || !config.rules || config.rules.length === 0) {
    // No rules at all — go straight to default fallback.
    return getDefaultCleaningProfileId(cache);
  }

  // 3. Get filter's attributes and ancestors for matching
  // Keyed `attrs:` — a different projection from the `hb:` home-block walk.
  const readInstance = () => prisma.assetInstance.findUnique({
    where: { id: filter.id },
    select: { attributes: true, parentId: true },
  });
  const instance = cache ? await cache.memo(`attrs:${filter.id}`, readInstance) : await readInstance();
  const attrs = (instance?.attributes as Record<string, any>) ?? {};

  switch (config.mode) {
    case 'BY_FILTER_SIZE': {
      // 2026-05-29 bug fix #2: historically the only UI that wrote filter-size
      // data stored it under the `micronSize` key, so this matched micronSize.
      // 2026-06-02: `filterSize` is now a real, distinct field-option. We still
      // prefer `micronSize` here for BACKWARD-COMPAT — existing BY_FILTER_SIZE
      // rules have their matchValue configured against micron values, and no
      // existing filter carries a real `filterSize` yet. Flip the precedence to
      // `filterSize ?? micronSize` only after deciding how legacy rules migrate.
      const filterSize = String(attrs.micronSize ?? attrs.filterSize ?? '');
      const rule = config.rules.find(r => String(r.matchValue) === filterSize);
      if (rule?.profileId) return rule.profileId;
      return getDefaultCleaningProfileId(cache);
    }
    case 'BY_FILTER_SET': {
      // 2026-05-29 bug fix #1: filter_details.filter_set stores the prefixed
      // enum value 'SET_A' / 'SET_B'; FE previously seeded rule matchValue as
      // 'A' / 'B' (unprefixed). 'B' !== 'SET_B' → no match → fell through to
      // the default profile. Normalise BOTH sides by stripping the SET_
      // prefix so new (canonical) and legacy (unprefixed) configs both work.
      // Uppercase FIRST then strip — guarantees lower-case inputs like
      // 'set_b' also normalize correctly. (Production filter_set is always
      // 'SET_A'/'SET_B' but defence in depth costs nothing here.)
      const normalize = (v: string | null | undefined) => (v ?? '').toUpperCase().replace(/^SET_/, '');
      const target = normalize(filter.filterSet);
      const rule = config.rules.find(r => normalize(r.matchValue) === target);
      if (rule?.profileId) return rule.profileId;
      return getDefaultCleaningProfileId(cache);
    }
    case 'BY_AHU': {
      // Filter's parent is typically AHU
      if (instance?.parentId) {
        const rule = config.rules.find(r => r.matchValue === instance.parentId);
        if (rule?.profileId) return rule.profileId;
      }
      return getDefaultCleaningProfileId(cache);
    }
    case 'BY_BLOCK': {
      // Walk up: Filter -> AHU -> ... -> Block
      let currentId = instance?.parentId;
      const visited = new Set<string>();
      while (currentId && !visited.has(currentId)) {
        visited.add(currentId);
        const rule = config.rules.find(r => r.matchValue === currentId);
        if (rule) return rule.profileId;
        // M39: shared ancestors again — memoised on the `parent:` projection.
        const readParent = () => prisma.assetInstance.findUnique({ where: { id: currentId! }, select: { parentId: true } });
        const parent = cache ? await cache.memo(`parent:${currentId}`, readParent) : await readParent();
        currentId = parent?.parentId ?? null;
      }
      return getDefaultCleaningProfileId(cache);
    }
    case 'BY_ENTITY': {
      const rule = config.rules.find(r => r.matchValue === filter.id);
      if (rule?.profileId) return rule.profileId;
      return getDefaultCleaningProfileId(cache);
    }
    default:
      return getDefaultCleaningProfileId(cache);
  }
}

export async function getProfilePipeline(profileId: string, requireActive: boolean = false) {
  // Try as FilterProfile first (has cleaningProfileId reference)
  const fp = await prisma.filterProfile.findUnique({ where: { id: profileId } });
  const cleaningProfileId = fp ? fp.cleaningProfileId : profileId;

  // Try as CleaningProfile directly (from config-based assignment)
  const cp = await prisma.filterCleaningProfile.findUnique({
    where: { id: cleaningProfileId },
    include: { stages: { orderBy: { sortOrder: 'asc' } }, connections: true },
  });

  // If profile is disabled (not ACTIVE), block operations that require it
  if (cp && requireActive && cp.status !== 'ACTIVE') {
    return null;
  }

  return cp;
}

export async function getCleaningReasons(profileId?: string) {
  if (profileId) {
    // Try as FilterProfile first, then as CleaningProfile directly
    const fp = await prisma.filterProfile.findUnique({ where: { id: profileId } });
    const cpId = fp ? fp.cleaningProfileId : profileId;
    const cp = await prisma.filterCleaningProfile.findUnique({ where: { id: cpId } });
    if (cp?.cleaningReasons) return cp.cleaningReasons as any[];
  }
  const cfg = await prisma.systemConfig.findUnique({ where: { configKey: 'filter-cleaning-reasons' } });
  const val = cfg?.configValue as any;
  return Array.isArray(val) ? val : (val?.value ?? []);
}
