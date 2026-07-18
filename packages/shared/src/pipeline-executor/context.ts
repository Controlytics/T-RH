/**
 * LocalContext — the single argument every pure guard takes (Phase 8.4c
 * scaffold).
 *
 * The context is a snapshot of every entity the executor reads, projected
 * into runtime-agnostic shapes (see `./types.ts` for the rationale on why
 * we don't import `@prisma/client` here). Both sides build a LocalContext
 * before invoking guards:
 *
 *   • Server (`apps/api`): `loadLocalContext(filterId)` reads through
 *     prisma + projects each row into the slice shapes.
 *   • FE (`apps/web` / mobile): `loadLocalContextFromCache(filterId)` reads
 *     through the IDB versioned cache (`Phase 8.4` adds the version columns
 *     + `/api/sync/since`).
 *
 * The two builder functions live in their respective apps in Phase 8.5 (see
 * `tasks/PLAN-2026-05-02-step8-OPTION-D.md`). For 8.4c we expose only the
 * type signatures here so guards can type-check, plus `NOT_IMPLEMENTED`
 * stubs that will be relocated to apps/* in 8.5.
 *
 * Why stubs instead of leaving the functions undeclared?
 *   - 8.5 implementer gets a typed signature target to match.
 *   - The smoke test (and Phase 8.5's first test) can import the symbol
 *     without a workspace-cross-dependency dance.
 *   - The stub body documents WHY a shared package can't actually load
 *     real data (Prisma I/O is not portable across runtimes).
 */
import type {
  ProfileSlice,
  CycleSlice,
  FilterEventSlice,
  FilterSlice,
  EquipmentGroupSlice,
  ChecklistProfileSlice,
  AssetTemplateSlice,
  StageInfo,
} from './types.js';

/**
 * Snapshot of every entity the executor reads. Built once per request /
 * action and passed by reference to each guard. Guards must not mutate it.
 *
 * NOTE: Uses millisecond timestamps (`number`) so guards stay
 * runtime-agnostic — server passes `Date.now()`, FE passes the same. Date
 * objects in slice fields (e.g. `cycle.dryerStartedAt`) are preserved as
 * `Date | string | null` because Prisma yields `Date` while IDB/JSON
 * yields ISO strings; guards normalize per-field.
 */
export interface LocalContext {
  /** Cleaning profile (with nodes + edges) the cycle is pinned to. */
  profile: ProfileSlice;
  /** The CleaningCycle whose state the operator is acting on. */
  cycle: CycleSlice;
  /** All FilterEvents for this cycle, oldest first. Used by checklist gating. */
  events: FilterEventSlice[];
  /**
   * Per-stateKey lookup table the FE today receives directly via
   * `getCurrentState()`. Phase 8.5 derives it from `profile.nodes/edges`
   * inside the executor; for now, callers may pre-compute and pass in to
   * preserve parity with the existing `stageLookup` shape.
   */
  stageLookup: Record<string, StageInfo>;
  /** The filter being acted on (with block/area/AHU ancestors when loaded). */
  filter: FilterSlice;
  /** EquipmentGroup pinned to the cycle (or null if none bound). */
  equipmentGroup: EquipmentGroupSlice | null;
  /**
   * ChecklistProfile relevant to the next gate. NOTE: Phase 8.5 may switch
   * this to a `Record<profileId, ChecklistProfileSlice>` once the executor
   * walks all checklist nodes — current shape mirrors how
   * `filter-operations.service.ts` currently resolves a single profile per
   * call.
   */
  checklistProfile: ChecklistProfileSlice | null;
  /** AssetTemplate of the filter — read by alarm/validation guards. */
  assetTemplate: AssetTemplateSlice | null;
  /** Acting user — guards read role + permissions for RBAC checks. */
  user: { id: string; role: string; permissions: string[] };
  /**
   * Current wall-clock time in ms-since-epoch. Injected (never read via
   * `Date.now()` inside guards) so tests can fix the clock and replay
   * deterministic outputs.
   */
  now: number;
}

// ── Builder signatures ───────────────────────────────────────────────────
//
// Phase 8.5 fills these in. The server-side reads through prisma; the FE
// side reads through IDB. Both produce a fully-populated LocalContext.

/**
 * Server-side LocalContext loader. Phase 8.5 implementation lives in
 * `apps/api/src/modules/filter-operations/local-context.ts` and uses the
 * apps/api prisma client. THIS exported stub is a typed placeholder so
 * shared code can reference the signature without importing prisma.
 */
export async function loadLocalContext(_filterId: string): Promise<LocalContext> {
  throw new Error(
    'NOT_IMPLEMENTED — pipeline-executor/context.loadLocalContext — Phase 8.5 (server-side impl moves to apps/api/src/modules/filter-operations/local-context.ts)',
  );
}

/**
 * FE/IDB-side LocalContext loader. Phase 8.5 implementation lives in
 * `apps/web/src/lib/local-context.ts` (or similar) and reads through the
 * Phase 8.4 versioned IDB cache. THIS exported stub is a typed placeholder.
 */
export async function loadLocalContextFromCache(
  _filterId: string,
): Promise<LocalContext> {
  throw new Error(
    'NOT_IMPLEMENTED — pipeline-executor/context.loadLocalContextFromCache — Phase 8.5 (FE-side impl moves to apps/web/src/lib/local-context.ts)',
  );
}
