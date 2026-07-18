/**
 * Pipeline-executor — internal-to-executor types (Phase 8.4c scaffold).
 *
 * Phase 8.5 fills in the concrete guard logic. This file defines the shapes
 * the guards consume and emit so the next-phase implementer doesn't have to
 * negotiate them.
 *
 * ── Why these aren't `import type from '@prisma/client'` ─────────────────
 * The original Option-D spec listed Prisma model types directly. Two reasons
 * we deviate:
 *
 *   1. `Block`, `Area`, `AHU`, `Filter` are NOT Prisma models. They are all
 *      `AssetInstance` rows discriminated by `template.templateKind`. The
 *      schema has `AssetInstance` + `FilterDetails` (1:1 sidecar) only —
 *      see `apps/api/prisma/schema.prisma:487` and `:531`.
 *
 *   2. `packages/shared` has no `@prisma/client` dependency, and adding one
 *      would couple the FE bundle to Prisma's generated client. The shared
 *      package must remain runtime-agnostic so both `apps/api` (server,
 *      reads through Prisma) and `apps/web` (FE, reads through IDB cache)
 *      can supply a `LocalContext` from their own data sources.
 *
 * The interfaces here describe ONLY the fields the executor reads. Both
 * sides project their data into these shapes before calling the executor.
 *
 * ── Type aliases preserved from Phase 8.0/8.1 ────────────────────────────
 * Pipeline graph + question shapes are already canonical in
 * `packages/shared/src/types/action-tape.ts` (consumed by the existing tape
 * generator). We re-alias them here so executor callers have the names the
 * Option-D plan uses (`ProfileNode`, `ProfileEdge`, `ChecklistQuestion`)
 * without duplicating definitions — drift impossible by construction.
 */
import type {
  TapeStage,
  TapeConnection,
  TapeQuestion,
  TapeInstrument,
  TapeChecklistProfile,
} from '../types/action-tape.js';

// ── Pipeline graph aliases ───────────────────────────────────────────────
//
// Re-export the existing tape types under the names the Option-D plan uses.
// Phase 8.5 guards consume `LocalContext.profile.nodes/edges` as these
// shapes; they are the same shapes the live tape generator already walks.

/** Node in a FilterCleaningProfile pipeline graph (STAGE | CHECKLIST | START | END | ...). */
export type ProfileNode = TapeStage;

/** Directed edge between two ProfileNodes. */
export type ProfileEdge = TapeConnection;

/** Question shape inside a ChecklistProfile — mirrors what the operator sees. */
export type ChecklistQuestion = TapeQuestion;

// Re-export raw tape types too — callers may need both vocabularies during
// the 8.5 transition.
export type { TapeStage, TapeConnection, TapeQuestion, TapeInstrument, TapeChecklistProfile };

// ── stageLookup row shape ────────────────────────────────────────────────
//
// Mirrors the per-STAGE entry built in
// `apps/api/src/modules/filter-operations/filter-operations.service.ts:632`:
//   const stageLookup: Record<string, {
//     nextStages: string[];
//     pendingChecklistProfileIds: string[];
//     leadsToEnd: boolean;
//   }>
//
// FE today reads this directly from `getCurrentState()` to render advance /
// checklist gating without re-walking the pipeline graph. Phase 8.5
// guards read it the same way.
export interface StageInfo {
  /** stateKeys reachable in one walk forward (skipping CHECKLIST nodes). */
  nextStages: string[];
  /** ChecklistProfile ids whose questions must be answered before advance. */
  pendingChecklistProfileIds: string[];
  /** true when the next non-CHECKLIST node forward is END. */
  leadsToEnd: boolean;
}

// ── GuardResult ──────────────────────────────────────────────────────────
//
// Pure guards return GuardResult. Server-side wrappers convert
// `{ ok: false }` into `AppError` throws; FE wrappers surface them as
// blocking-action UI. Identical decision logic on both sides — drift
// impossible.
export type GuardResult =
  | { ok: true }
  | { ok: false; code: string; message: string; details?: Record<string, unknown> };

// ── ValidationResult ─────────────────────────────────────────────────────
//
// Slightly looser than GuardResult — used by guards that batch-validate
// multiple inputs (e.g. instrument readings against operating ranges) and
// need to return per-input failure detail.
export interface ValidationFailure {
  field: string;
  code: string;
  message: string;
  details?: Record<string, unknown>;
}

export type ValidationResult =
  | { ok: true }
  | { ok: false; failures: ValidationFailure[] };

// ── Lightweight projections of Prisma rows ───────────────────────────────
//
// These project the SUBSET of each model the executor reads. Phase 8.5
// guards depend ONLY on these fields. Whatever supplies the LocalContext
// (server: prisma, FE: IDB cache) is responsible for projecting into them.

/**
 * FilterCleaningProfile slice the executor reads, plus its graph (nodes +
 * edges) which on the wire live in `FilterPipelineStage` + `FilterPipelineConnection`
 * tables but are co-loaded for graph walks.
 */
export interface ProfileSlice {
  id: string;
  lineageId: string;
  name: string;
  flowMode: string; // 'STRICT' | 'BYPASS_ENABLED' | 'SEQUENTIAL' | ...
  version: number;
  status: string; // 'DRAFT' | 'ACTIVE' | ...
  cleaningReasons: unknown; // Json — left opaque; guards inspect specific keys when relevant
  nodes: ProfileNode[];
  edges: ProfileEdge[];
}

/** CleaningCycle slice the executor reads. */
export interface CycleSlice {
  id: string;
  cycleCode: string;
  filterId: string;
  profileId: string;
  profileVersion: number;
  status: string; // 'IN_PROGRESS' | 'COMPLETED' | 'TERMINATED'
  cleaningAreaId: string | null;
  equipmentGroupId: string | null;
  /** Phase A.4 — pinned EquipmentGroup version at cycle start. */
  equipmentGroupVersionPin: number | null;
  /** Phase A.1 — pinned ChecklistProfile versions per profileId at cycle start. */
  checklistVersionPins: Record<string, number> | null;
  /** Dryer state — only meaningful while filter is in DRY_IN. */
  dryerStartedAt: Date | string | null;
  dryerDurationMinutes: number | null;
  dryerReadingsSubmitted: boolean;
  cleaningReasonKey: string;
  cleaningReasonLabel: string;
  startedAt: Date | string;
  completedAt: Date | string | null;
  terminatedAt: Date | string | null;
}

/**
 * FilterEvent slice the executor reads. Only the fields guards inspect —
 * full payload not needed (the audit trail keeps that).
 */
export interface FilterEventSlice {
  id: string;
  cycleId: string | null;
  eventType: string; // 'CHECKLIST_COMPLETED' | 'STATE_TRANSITION' | 'BYPASS' | ...
  fromState: string | null;
  toState: string | null;
  performedAt: Date | string;
  attributes: Record<string, unknown>;
}

/**
 * Filter slice — projection of `AssetInstance` (templateKind=FILTER) joined
 * with its FilterDetails sidecar and its containment ancestry (block / area /
 * AHU). Guards read these to enforce block-restriction, parent-cycle, etc.
 *
 * Block / Area / AHU here are NOT separate Prisma models — they are
 * AssetInstance rows further up the parent chain, projected into the same
 * minimal shape.
 */
export interface FilterParent {
  id: string;
  name: string;
  templateKind: string; // 'BLOCK' | 'AREA' | 'AHU' | ...
}

export interface FilterSlice {
  id: string;
  name: string;
  parentId: string | null;
  /** Resolved from FilterDetails (Step 6 sidecar). */
  filterProfileId: string | null;
  currentLifecycleState: string | null;
  currentCycleId: string | null;
  filterSet: string | null;
  /** Containment ancestors when resolvable; `null` when not yet loaded. */
  block: FilterParent | null;
  area: FilterParent | null;
  ahu: FilterParent | null;
}

/** EquipmentGroup slice — group + instruments composite (Phase A.4 pattern). */
export interface EquipmentGroupSlice {
  id: string;
  name: string;
  blockId: string;
  isActive: boolean;
  version: number;
  instruments: TapeInstrument[];
}

/** ChecklistProfile slice — profile metadata + ordered questions. */
export interface ChecklistProfileSlice {
  id: string;
  name: string;
  isActive: boolean;
  version: number;
  questions: ChecklistQuestion[];
}

/**
 * AssetTemplate slice — only the fields that gate filter-operations
 * decisions (e.g. attributeSchema for instrument-reading validation, alarm
 * rules for deviation classification).
 */
export interface AssetTemplateSlice {
  id: string;
  name: string;
  templateKind: string;
  version: number;
  attributeSchema: unknown;
  alarmRules: unknown;
}

// ── Re-exports of types this module's siblings will consume ──────────────
export type { LocalContext } from './context.js';
