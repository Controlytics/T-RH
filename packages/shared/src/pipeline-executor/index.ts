/**
 * @digilog/shared/pipeline-executor — public surface (Phase 8.5).
 *
 * The shared executor — pure, runtime-agnostic guard functions consumed by
 * both `apps/api` (server transitions) and `apps/web` (FE / offline replay).
 * Phase 8.5 fills in the bodies; this barrel exposes guards under the names
 * the Phase 8.5 inventory specifies.
 *
 * Module layout (per inventory § "Proposed Shared Module Layout"):
 *   transitions.ts   — cycle / profile / target-state guards (15)
 *   checklist.ts     — schema-drift + answer-shape guards (3)
 *   dryer.ts         — dryer SET_DURATION + SUBMIT_READINGS gates (6)
 *   instruments.ts   — equipment-group + reading-validation guards (8)
 *   bypass.ts        — bypass flow guards (3)
 *   justification.ts — bypass + terminate justification (1, used twice)
 *   parameters.ts    — PARAM_CAPTURE block validation (2)
 *   actions.ts       — computeNextActions(ctx) → ActionTape
 *   context.ts       — LocalContext type + cross-runtime loader stubs
 *   types.ts         — slice projections + GuardResult / ValidationResult
 */

// ── Types ────────────────────────────────────────────────────────────────
export type {
  GuardResult,
  ValidationFailure,
  ValidationResult,
  ProfileNode,
  ProfileEdge,
  ChecklistQuestion,
  StageInfo,
  ProfileSlice,
  CycleSlice,
  FilterEventSlice,
  FilterParent,
  FilterSlice,
  EquipmentGroupSlice,
  ChecklistProfileSlice,
  AssetTemplateSlice,
  TapeStage,
  TapeConnection,
  TapeQuestion,
  TapeInstrument,
  TapeChecklistProfile,
} from './types.js';

export type { LocalContext } from './context.js';

// ── Context loaders (stubs in shared; real impls in apps/api + apps/web) ─
export { loadLocalContext, loadLocalContextFromCache } from './context.js';

// ── Transitions / cycle / profile ────────────────────────────────────────
export {
  // primary inventory guards
  assertCycleActive,
  assertNoCycleActive,
  assertProfileAssigned,
  assertProfileActive,
  assertProfileEnabled,
  assertChecklistGatePassed,
  assertNotCycleComplete,
  assertTargetStateReachable,
  assertTargetStateExists,
  assertTapeVersionFresh,
  // helpers + tape-friendly wrappers
  assertCanTransition,
  getReachableStages,
  leadsToEnd,
  collectChecklistsAfterStage,
  findReachable,
  buildStageLookup,
  prettyStageLabel,
} from './transitions.js';

// ── Checklist ────────────────────────────────────────────────────────────
export {
  assertChecklistSchemaFresh,
  assertRequiredChecklistAnswered,
  assertChecklistAnswerKeysValid,
} from './checklist.js';
export type { ResolvedChecklist } from './checklist.js';

// ── Dryer ────────────────────────────────────────────────────────────────
export {
  assertDryerActionValid,
  assertDryerDurationValid,
  assertInDryInForReadings,
  assertDryerStarted,
  assertDryerHalfTimeElapsed,
  assertDryerHalfTimeBeforeLeavingDryIn,
  assertDryerReadingsSubmittedBeforeLeavingDryIn,
} from './dryer.js';

// ── Instruments + Equipment Group ────────────────────────────────────────
export {
  assertEquipmentGroupValid,
  assertInstrumentReadingRequired,
  assertInstrumentReadingValid,
  assertInstrumentReadingInRange,
  assertAllInstrumentReadings,
  assertSingleEquipmentGroupPerBlock,
  assertEquipmentGroupSelected,
  assertEquipmentGroupVersionExists,
} from './instruments.js';

// ── Bypass ───────────────────────────────────────────────────────────────
export {
  assertBypassAllowed,
  assertBypassTargetStateValid,
  assertCanBypassTo,
} from './bypass.js';

// ── Justification (bypass + terminate share this) ────────────────────────
export { assertJustificationValid } from './justification.js';

// ── Parameters ───────────────────────────────────────────────────────────
export {
  assertParametersRequired,
  assertParametersInRange,
  extractParameterDefs,
} from './parameters.js';
export type { ParameterDef, ParameterValueMap } from './parameters.js';

// ── Tape generator ───────────────────────────────────────────────────────
export { computeNextActions, computeTapeVersion } from './actions.js';
