/**
 * Decision-tape types — re-export shim (Phase 8.1).
 *
 * The actual definitions live in `packages/shared/src/types/action-tape.ts`
 * so server + FE consume the same source of truth (no drift, no duplicate
 * declarations). This shim preserves the existing `./types.js` import path
 * inside the api module so we don't have to rewire 3 server files for purely
 * cosmetic gain. The parity test in `__tests__/tape-parity.test.ts` continues
 * to guarantee shape stability.
 */
export type {
  TapeQuestion,
  TapeStage,
  TapeConnection,
  TapeInstrument,
  TapeCycle,
  TapePinnedProfile,
  TapePinnedEquipmentGroup,
  TapeChecklistProfile,
  TapeChecklistEvent,
  TapeInput,
  ActionKind,
  OperatingRangeMap,
  AdvanceToStageAction,
  SubmitChecklistAction,
  SubmitDryerReadingsAction,
  SetDryerDurationAction,
  BypassStageAction,
  TerminateCycleAction,
  CompleteCycleAction,
  Action,
  ActionTape,
} from '@digilog/shared';
