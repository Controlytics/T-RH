/**
 * Decision-tape architecture — shared types (Phase 8.1).
 *
 * The action tape is the server-emitted contract that tells the FE exactly
 * which actions are permitted at the current cycle state. The FE eventually
 * (Phase 8.4 cutover) becomes a dumb renderer with zero pipeline-graph walking.
 *
 * Phase 8.0 shipped the types + pure-function generator + parallel-validation
 * harness inside `apps/api/src/modules/filter-operations/tape/`. Phase 8.1
 * (this file) lifts those types into `@digilog/shared` so the FE renderer
 * skeleton consumes the exact same shapes the server emits — no duplicate
 * declarations, no drift.
 *
 * Field-name policy (per advisor guidance 2026-05-02): mirror existing
 * server/FE field names so the parity harness doesn't have to translate.
 *   - `targetState` (matches advance() body field)
 *   - `instrumentIds` (matches EquipmentGroupInstrument.id key shape)
 *   - `checklistProfileId` + `versionPin` (matches Phase A.1 contract)
 *   - `questions` payload mirrors `resolveChecklistQuestions()` output shape
 *     (see filter-operations.service.ts:127-145).
 */

/** Question shape — must match what the existing pendingChecklist[] returns. */
export interface TapeQuestion {
  id: string;
  question: string;
  questionType: string;
  required: boolean;
  section: string | null;
  description: string | null;
  options: unknown[];
  validation: Record<string, unknown>;
  sortOrder: number;
}

/** Pipeline graph shape consumed by generateTape(). Mirrors FilterPipelineStage / Connection. */
export interface TapeStage {
  id: string;
  stateKey: string | null;
  nodeType: string; // 'STAGE' | 'CHECKLIST' | 'START' | 'END' | 'PARAM_CAPTURE' | other
  configuration: Record<string, unknown>;
  sortOrder?: number;
}

export interface TapeConnection {
  fromStageId: string;
  toStageId: string;
}

/** Equipment-group instrument shape — mirrors EquipmentGroupInstrument fields the generator reads. */
export interface TapeInstrument {
  id: string;
  description?: string;
  instrumentId?: string;
  stageKey: string;
  uom?: string;
  operatingMin: number;
  operatingMax: number;
  leastCount?: number;
  sortOrder?: number;
}

/** Cycle slice the generator needs. Subset of CleaningCycle. */
export interface TapeCycle {
  id: string;
  profileId: string;
  profileVersion: number;
  status: string;
  cleaningAreaId: string | null;
  equipmentGroupId: string | null;
  equipmentGroupVersionPin: number | null;
  checklistVersionPins: Record<string, number> | null;
  dryerStartedAt: Date | null;
  dryerDurationMinutes: number | null;
  dryerReadingsSubmitted: boolean;
}

/** Pinned cleaning profile (with stages + connections). NOT the live one when a cycle exists. */
export interface TapePinnedProfile {
  id: string;
  name: string;
  flowMode: string; // 'SEQUENTIAL' | 'BYPASS_ENABLED' | etc
  stages: TapeStage[];
  connections: TapeConnection[];
}

/** Pinned equipment group snapshot (post-L1 resolution). */
export interface TapePinnedEquipmentGroup {
  id: string;
  version: number;
  instruments: TapeInstrument[];
}

/** Resolved checklist profile (with questions) — keyed by profile id. */
export interface TapeChecklistProfile {
  profileId: string;
  versionPin: number;
  name?: string;
  questions: TapeQuestion[];
}

/** Recent checklist-completion event slice. Mirrors FilterEvent we already query. */
export interface TapeChecklistEvent {
  eventType: 'CHECKLIST_COMPLETED';
  attributes: { afterStage?: string | null;[k: string]: unknown };
}

/**
 * Full input to generateTape(). All inputs are passed in — no I/O — so the
 * function is pure and trivially testable. The caller (in getCurrentState())
 * is responsible for reading prisma + assembling this object.
 */
export interface TapeInput {
  cycle: TapeCycle | null;
  filter: { id: string; currentLifecycleState: string | null };
  pinnedProfile: TapePinnedProfile | null;
  pinnedEquipmentGroup: TapePinnedEquipmentGroup | null;
  /** Map keyed by checklistProfileId → resolved profile + questions. */
  pinnedChecklistProfiles: Map<string, TapeChecklistProfile>;
  recentChecklistEvents: TapeChecklistEvent[];
  /**
   * Total FilterEvent count for the cycle (any event type). Used to derive
   * tapeVersion. Must include STATE_TRANSITION events so the tapeVersion
   * actually changes between stage transitions — without this, two consecutive
   * `getCurrentState()` calls before/after an advance would produce the same
   * tapeVersion despite the action list having changed entirely.
   */
  filterEventCount: number;
  now: Date;
}

// ── Action types ────────────────────────────────────────────────────────────

export type ActionKind =
  | 'ADVANCE_TO_STAGE'
  | 'SUBMIT_CHECKLIST'
  | 'SUBMIT_DRYER_READINGS'
  | 'SET_DRYER_DURATION'
  | 'BYPASS_STAGE'
  | 'TERMINATE_CYCLE'
  | 'COMPLETE_CYCLE';

export interface OperatingRangeMap {
  [instrumentId: string]: { min: number; max: number };
}

/** ADVANCE_TO_STAGE — generic forward transition (excluding dryer-specific paths). */
export interface AdvanceToStageAction {
  type: 'ADVANCE_TO_STAGE';
  label: string;
  params: {
    targetState: string;
    /** When set, the operator MUST submit readings for these instrument ids. */
    requiresInstrumentReadings?: string[];
  };
  validations?: {
    operatingRanges?: OperatingRangeMap;
  };
}

/** SUBMIT_CHECKLIST — fires when a CHECKLIST node is pending after the current stage. */
export interface SubmitChecklistAction {
  type: 'SUBMIT_CHECKLIST';
  label: string;
  params: {
    checklistProfileId: string;
    versionPin: number;
    afterStage: string;
    questions: TapeQuestion[];
  };
  blocking: true;
}

/** SUBMIT_DRYER_READINGS — fires when filter is at DRY_IN, dryer started, half-time elapsed. */
export interface SubmitDryerReadingsAction {
  type: 'SUBMIT_DRYER_READINGS';
  label: string;
  params: {
    instrumentIds: string[];
  };
  validations: {
    /** Half of the dryer duration in milliseconds. FE uses this + dryerStartedAt to render countdown. */
    halfDurationMs: number;
    operatingRanges: OperatingRangeMap;
  };
}

/** SET_DRYER_DURATION — fires when next stage is DRY_IN and dryer not yet started. */
export interface SetDryerDurationAction {
  type: 'SET_DRYER_DURATION';
  label: string;
  params: {
    targetState: 'DRY_IN';
    minMinutes: number;
    maxMinutes: number;
  };
}

/** BYPASS_STAGE — only emitted when profile.flowMode allows bypass. */
export interface BypassStageAction {
  type: 'BYPASS_STAGE';
  label: string;
  params: {
    targetState: string;
  };
  requiresJustification: { minLength: number };
}

/** TERMINATE_CYCLE — always available while cycle is IN_PROGRESS. */
export interface TerminateCycleAction {
  type: 'TERMINATE_CYCLE';
  label: string;
  requiresJustification: { minLength: number };
}

/** COMPLETE_CYCLE — emitted when next stage leads to END. Server auto-advances on accept. */
export interface CompleteCycleAction {
  type: 'COMPLETE_CYCLE';
  label: string;
}

export type Action =
  | AdvanceToStageAction
  | SubmitChecklistAction
  | SubmitDryerReadingsAction
  | SetDryerDurationAction
  | BypassStageAction
  | TerminateCycleAction
  | CompleteCycleAction;

export interface ActionTape {
  /** Current cycle state — same value as filter.currentLifecycleState. */
  state: string | null;
  actions: Action[];
  /**
   * Monotonic-ish per-cycle. Phase 8.0 placeholder: profileVersion * 1000 + filterEventCount.
   * Stable for fixed inputs; changes when the action list could change. Phase 8.4 may revisit.
   */
  tapeVersion: number;
}

/**
 * Phase 8.3: discriminated payload returned (in `details`) on a 409 response
 * when the client-submitted tapeVersion did not match the live server
 * tapeVersion. The client should refetch state, surface a "another operator
 * changed this cycle" toast, and let the operator retry against fresh data.
 *
 * On the FE this surfaces as `(error as any).code === 'STALE_TAPE'` with
 * `(error as any).currentTapeVersion: number` lifted from `details` by
 * api-client. The `StaleTapeError` interface here is a type-guard target —
 * it is NOT a thrown class.
 */
export interface StaleTapeError {
  code: 'STALE_TAPE';
  currentTapeVersion: number;
  message: string;
}
