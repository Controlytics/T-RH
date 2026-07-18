/**
 * Reusable LocalContext fixtures for Phase 8.5 (shared executor) and Phase 8.6
 * (FE consumes executor) unit tests.
 *
 * Each builder returns a fully-populated LocalContext for one canonical scenario
 * pulled from `tasks/INVENTORY-2026-05-02-step8.5-guards.md` Artifact 3. Inputs
 * are pure data — no Prisma, no fetch, no I/O. Builders accept a partial
 * override so individual tests can tweak just the field they care about without
 * re-declaring the entire context.
 *
 * Conventions:
 *   - Stable ids (test-* / scenario-* prefixes) so failure diffs are readable.
 *   - `now` pinned to 2026-05-02T12:00:00Z so dryer / time math is deterministic.
 *   - The 5–7 node profile shape mirrors what the live tape generator walks:
 *     START -> WASH_IN -> WASH_OUT -> DRY_IN -> DRY_OUT -> END (+ optional
 *     CHECKLIST node before WASH_OUT in the pendingChecklist scenario).
 *   - StageLookup is pre-computed to match what `getCurrentState()` ships down
 *     today. Phase 8.5 derives it inside the executor; we keep the precomputed
 *     shape so guard tests don't depend on the buildStageLookup() helper being
 *     final.
 *
 * Slice shapes are intentionally projected from `types.ts` only — no invented
 * fields. If a test needs a field these fixtures don't expose, extend the
 * fixture file rather than introducing ad-hoc shapes elsewhere.
 */
import type {
  AssetTemplateSlice,
  ChecklistProfileSlice,
  CycleSlice,
  EquipmentGroupSlice,
  FilterEventSlice,
  FilterSlice,
  LocalContext,
  ProfileSlice,
  StageInfo,
} from '../types.js';

// ── Constants ────────────────────────────────────────────────────────────

/** Pinned wall-clock for deterministic dryer / time math. */
export const FIXTURE_NOW = new Date('2026-05-02T12:00:00Z').getTime();

/** Default operator user shared by every scenario (override per-test if needed). */
export const FIXTURE_USER: LocalContext['user'] = {
  id: 'test-user-1',
  role: 'OPERATOR',
  permissions: ['FILTER_OPERATE', 'FILTER_VIEW'],
};

// ── Profile builders ─────────────────────────────────────────────────────

/**
 * Standard 6-node SEQUENTIAL profile:
 *   START -> WASH_IN -> WASH_OUT -> DRY_IN -> DRY_OUT -> END.
 *
 * Used by every scenario except `pendingChecklistContext()` which inserts a
 * CHECKLIST node between WASH_IN and WASH_OUT.
 */
function standardProfile(flowMode = 'SEQUENTIAL'): ProfileSlice {
  return {
    id: 'profile-std-1',
    lineageId: 'lineage-std',
    name: 'Standard Cleaning',
    flowMode,
    version: 3,
    status: 'ACTIVE',
    cleaningReasons: { keys: ['ROUTINE', 'PM'] },
    nodes: [
      { id: 'n-start', stateKey: null, nodeType: 'START', configuration: {}, sortOrder: 0 },
      { id: 'n-wash-in', stateKey: 'WASH_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 1 },
      { id: 'n-wash-out', stateKey: 'WASH_OUT', nodeType: 'STAGE', configuration: {}, sortOrder: 2 },
      { id: 'n-dry-in', stateKey: 'DRY_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 3 },
      { id: 'n-dry-out', stateKey: 'DRY_OUT', nodeType: 'STAGE', configuration: {}, sortOrder: 4 },
      { id: 'n-end', stateKey: null, nodeType: 'END', configuration: {}, sortOrder: 5 },
    ],
    edges: [
      { fromStageId: 'n-start', toStageId: 'n-wash-in' },
      { fromStageId: 'n-wash-in', toStageId: 'n-wash-out' },
      { fromStageId: 'n-wash-out', toStageId: 'n-dry-in' },
      { fromStageId: 'n-dry-in', toStageId: 'n-dry-out' },
      { fromStageId: 'n-dry-out', toStageId: 'n-end' },
    ],
  };
}

/** Profile with a CHECKLIST node between WASH_IN and WASH_OUT. */
function profileWithChecklist(): ProfileSlice {
  return {
    id: 'profile-cl-1',
    lineageId: 'lineage-cl',
    name: 'Standard + Checklist',
    flowMode: 'SEQUENTIAL',
    version: 4,
    status: 'ACTIVE',
    cleaningReasons: { keys: ['ROUTINE', 'PM'] },
    nodes: [
      { id: 'n-start', stateKey: null, nodeType: 'START', configuration: {}, sortOrder: 0 },
      { id: 'n-wash-in', stateKey: 'WASH_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 1 },
      {
        id: 'n-cl-after-wash-in',
        stateKey: null,
        nodeType: 'CHECKLIST',
        configuration: { checklistProfileId: 'cl-prof-1' },
        sortOrder: 2,
      },
      { id: 'n-wash-out', stateKey: 'WASH_OUT', nodeType: 'STAGE', configuration: {}, sortOrder: 3 },
      { id: 'n-dry-in', stateKey: 'DRY_IN', nodeType: 'STAGE', configuration: {}, sortOrder: 4 },
      { id: 'n-dry-out', stateKey: 'DRY_OUT', nodeType: 'STAGE', configuration: {}, sortOrder: 5 },
      { id: 'n-end', stateKey: null, nodeType: 'END', configuration: {}, sortOrder: 6 },
    ],
    edges: [
      { fromStageId: 'n-start', toStageId: 'n-wash-in' },
      { fromStageId: 'n-wash-in', toStageId: 'n-cl-after-wash-in' },
      { fromStageId: 'n-cl-after-wash-in', toStageId: 'n-wash-out' },
      { fromStageId: 'n-wash-out', toStageId: 'n-dry-in' },
      { fromStageId: 'n-dry-in', toStageId: 'n-dry-out' },
      { fromStageId: 'n-dry-out', toStageId: 'n-end' },
    ],
  };
}

// ── Lookup builders ──────────────────────────────────────────────────────

/** Pre-computed stageLookup for the standard 4-stage profile. */
function standardStageLookup(): Record<string, StageInfo> {
  return {
    WASH_IN: { nextStages: ['WASH_OUT'], pendingChecklistProfileIds: [], leadsToEnd: false },
    WASH_OUT: { nextStages: ['DRY_IN'], pendingChecklistProfileIds: [], leadsToEnd: false },
    DRY_IN: { nextStages: ['DRY_OUT'], pendingChecklistProfileIds: [], leadsToEnd: false },
    DRY_OUT: { nextStages: [], pendingChecklistProfileIds: [], leadsToEnd: true },
  };
}

/** stageLookup that surfaces a pending checklist after WASH_IN. */
function checklistStageLookup(): Record<string, StageInfo> {
  return {
    WASH_IN: {
      nextStages: ['WASH_OUT'],
      pendingChecklistProfileIds: ['cl-prof-1'],
      leadsToEnd: false,
    },
    WASH_OUT: { nextStages: ['DRY_IN'], pendingChecklistProfileIds: [], leadsToEnd: false },
    DRY_IN: { nextStages: ['DRY_OUT'], pendingChecklistProfileIds: [], leadsToEnd: false },
    DRY_OUT: { nextStages: [], pendingChecklistProfileIds: [], leadsToEnd: true },
  };
}

// ── Slice builders ───────────────────────────────────────────────────────

function defaultFilter(currentLifecycleState: string | null, currentCycleId: string | null): FilterSlice {
  return {
    id: 'filter-1',
    name: 'F-A-1',
    parentId: 'ahu-1',
    filterProfileId: 'fp-1',
    currentLifecycleState,
    currentCycleId,
    filterSet: 'PRIMARY',
    block: { id: 'block-1', name: 'Block A', templateKind: 'BLOCK' },
    area: { id: 'area-1', name: 'Area 1', templateKind: 'AREA' },
    ahu: { id: 'ahu-1', name: 'AHU-1', templateKind: 'AHU' },
  };
}

function defaultCycle(profile: ProfileSlice, overrides: Partial<CycleSlice> = {}): CycleSlice {
  return {
    id: 'cycle-1',
    cycleCode: 'C-2026-001',
    filterId: 'filter-1',
    profileId: profile.id,
    profileVersion: profile.version,
    status: 'IN_PROGRESS',
    cleaningAreaId: 'block-1',
    equipmentGroupId: null,
    equipmentGroupVersionPin: null,
    checklistVersionPins: null,
    dryerStartedAt: null,
    dryerDurationMinutes: null,
    dryerReadingsSubmitted: false,
    cleaningReasonKey: 'ROUTINE',
    cleaningReasonLabel: 'Routine cleaning',
    startedAt: new Date('2026-05-02T10:00:00Z'),
    completedAt: null,
    terminatedAt: null,
    ...overrides,
  };
}

function defaultEquipmentGroup(): EquipmentGroupSlice {
  return {
    id: 'eg-1',
    name: 'Block A Probes',
    blockId: 'block-1',
    isActive: true,
    version: 4,
    instruments: [
      {
        id: 'instr-temp-1',
        instrumentId: 'TEMP-01',
        description: 'DRY_OUT temperature probe',
        stageKey: 'DRY_OUT',
        uom: 'C',
        operatingMin: 20,
        operatingMax: 60,
        leastCount: 0.1,
        sortOrder: 0,
      },
      {
        id: 'instr-rh-1',
        instrumentId: 'RH-01',
        description: 'DRY_OUT humidity probe',
        stageKey: 'DRY_OUT',
        uom: '%',
        operatingMin: 30,
        operatingMax: 70,
        leastCount: 0.1,
        sortOrder: 1,
      },
    ],
  };
}

function defaultChecklistProfile(): ChecklistProfileSlice {
  return {
    id: 'cl-prof-1',
    name: 'Post-Wash Verification',
    isActive: true,
    version: 2,
    questions: [
      {
        id: 'q-1',
        question: 'Drain valve closed?',
        questionType: 'YES_NO',
        required: true,
        section: 'Pre-checks',
        description: null,
        options: [],
        validation: {},
        sortOrder: 0,
      },
      {
        id: 'q-2',
        question: 'Operator initials',
        questionType: 'TEXT',
        required: true,
        section: 'Sign-off',
        description: null,
        options: [],
        validation: { maxLength: 6 },
        sortOrder: 1,
      },
    ],
  };
}

function defaultAssetTemplate(): AssetTemplateSlice {
  return {
    id: 'tmpl-filter-1',
    name: 'Standard Filter Template',
    templateKind: 'FILTER',
    version: 1,
    attributeSchema: { fields: [] },
    alarmRules: { rules: [] },
  };
}

// ── Helper: events for a transition history ──────────────────────────────

function cycleStartedEvent(cycleId: string): FilterEventSlice {
  return {
    id: 'evt-start',
    cycleId,
    eventType: 'CYCLE_STARTED',
    fromState: null,
    toState: null,
    performedAt: new Date('2026-05-02T10:00:00Z'),
    attributes: {},
  };
}

function transitionEvent(
  id: string,
  cycleId: string,
  fromState: string | null,
  toState: string | null,
  performedAt: string,
): FilterEventSlice {
  return {
    id,
    cycleId,
    eventType: 'STATE_TRANSITION',
    fromState,
    toState,
    performedAt: new Date(performedAt),
    attributes: {},
  };
}

// ── Public builders (1 per scenario) ─────────────────────────────────────

/**
 * Scenario 1 — empty cycle (state=NEW). The filter has a profile assigned but
 * no cycle row yet. Guards that gate on `cycle` being null hit this fixture.
 *
 * Note: LocalContext.cycle is non-optional in the slice projection — when there
 * is no live cycle the server / FE must still produce a CycleSlice-shaped
 * placeholder. We use a status='NONE' sentinel here. Guards that check
 * `cycle.status` for IN_PROGRESS will fail-closed against this scenario, which
 * matches the inventory's `assertCycleActive` semantics.
 */
export function emptyCycleContext(overrides: Partial<LocalContext> = {}): LocalContext {
  const profile = standardProfile();
  const cycle: CycleSlice = {
    id: 'no-cycle',
    cycleCode: '',
    filterId: 'filter-1',
    profileId: profile.id,
    profileVersion: profile.version,
    status: 'NONE',
    cleaningAreaId: null,
    equipmentGroupId: null,
    equipmentGroupVersionPin: null,
    checklistVersionPins: null,
    dryerStartedAt: null,
    dryerDurationMinutes: null,
    dryerReadingsSubmitted: false,
    cleaningReasonKey: '',
    cleaningReasonLabel: '',
    startedAt: new Date(FIXTURE_NOW),
    completedAt: null,
    terminatedAt: null,
  };
  return {
    profile,
    cycle,
    events: [],
    stageLookup: standardStageLookup(),
    filter: defaultFilter(null, null),
    equipmentGroup: null,
    checklistProfile: null,
    assetTemplate: defaultAssetTemplate(),
    user: FIXTURE_USER,
    now: FIXTURE_NOW,
    ...overrides,
  };
}

/**
 * Scenario 2 — mid-WASH cycle. Cycle is IN_PROGRESS at WASH_IN with one prior
 * STATE_TRANSITION event from null to WASH_IN. No checklist in profile, so no
 * pending gate.
 */
export function midWashContext(overrides: Partial<LocalContext> = {}): LocalContext {
  const profile = standardProfile();
  const cycle = defaultCycle(profile);
  return {
    profile,
    cycle,
    events: [
      cycleStartedEvent(cycle.id),
      transitionEvent('evt-1', cycle.id, null, 'WASH_IN', '2026-05-02T10:05:00Z'),
    ],
    stageLookup: standardStageLookup(),
    filter: defaultFilter('WASH_IN', cycle.id),
    equipmentGroup: null,
    checklistProfile: null,
    assetTemplate: defaultAssetTemplate(),
    user: FIXTURE_USER,
    now: FIXTURE_NOW,
    ...overrides,
  };
}

/**
 * Scenario 3 — mid-WASH with a pending checklist. Profile carries a CHECKLIST
 * node after WASH_IN, no CHECKLIST_COMPLETED event has been emitted yet, and
 * the resolved ChecklistProfile is cached. `assertChecklistGatePassed` should
 * fail-closed here.
 */
export function pendingChecklistContext(overrides: Partial<LocalContext> = {}): LocalContext {
  const profile = profileWithChecklist();
  const cycle = defaultCycle(profile, {
    checklistVersionPins: { 'cl-prof-1': 2 },
  });
  return {
    profile,
    cycle,
    events: [
      cycleStartedEvent(cycle.id),
      transitionEvent('evt-1', cycle.id, null, 'WASH_IN', '2026-05-02T10:05:00Z'),
    ],
    stageLookup: checklistStageLookup(),
    filter: defaultFilter('WASH_IN', cycle.id),
    equipmentGroup: null,
    checklistProfile: defaultChecklistProfile(),
    assetTemplate: defaultAssetTemplate(),
    user: FIXTURE_USER,
    now: FIXTURE_NOW,
    ...overrides,
  };
}

/**
 * Scenario 4 — DRY_IN with countdown active. Dryer started 30 min ago, total
 * duration 60 min, so half-time has elapsed (30 >= 30). Used by
 * `assertDryerHalfTimeElapsed` / `assertDryerStarted` happy-path tests.
 */
export function dryInActiveContext(overrides: Partial<LocalContext> = {}): LocalContext {
  const profile = standardProfile();
  // 30 min before FIXTURE_NOW, with 60 min total duration.
  const dryerStarted = new Date(FIXTURE_NOW - 30 * 60 * 1000);
  const cycle = defaultCycle(profile, {
    dryerStartedAt: dryerStarted,
    dryerDurationMinutes: 60,
    dryerReadingsSubmitted: false,
  });
  return {
    profile,
    cycle,
    events: [
      cycleStartedEvent(cycle.id),
      transitionEvent('evt-1', cycle.id, null, 'WASH_IN', '2026-05-02T10:05:00Z'),
      transitionEvent('evt-2', cycle.id, 'WASH_IN', 'WASH_OUT', '2026-05-02T10:30:00Z'),
      transitionEvent('evt-3', cycle.id, 'WASH_OUT', 'DRY_IN', '2026-05-02T11:30:00Z'),
    ],
    stageLookup: standardStageLookup(),
    filter: defaultFilter('DRY_IN', cycle.id),
    equipmentGroup: defaultEquipmentGroup(),
    checklistProfile: null,
    assetTemplate: defaultAssetTemplate(),
    user: FIXTURE_USER,
    now: FIXTURE_NOW,
    ...overrides,
  };
}

/**
 * Scenario 5 — DRY_OUT awaiting instrument readings. Equipment group has two
 * DRY_OUT-stage instruments, dryer readings already submitted. Used by
 * `assertInstrumentReadingRequired` / `assertInstrumentReadingInRange`.
 */
export function dryOutAwaitingReadingsContext(overrides: Partial<LocalContext> = {}): LocalContext {
  const profile = standardProfile();
  const eg = defaultEquipmentGroup();
  const cycle = defaultCycle(profile, {
    equipmentGroupId: eg.id,
    equipmentGroupVersionPin: eg.version,
    dryerStartedAt: new Date(FIXTURE_NOW - 90 * 60 * 1000),
    dryerDurationMinutes: 60,
    dryerReadingsSubmitted: true,
  });
  return {
    profile,
    cycle,
    events: [
      cycleStartedEvent(cycle.id),
      transitionEvent('evt-1', cycle.id, null, 'WASH_IN', '2026-05-02T10:05:00Z'),
      transitionEvent('evt-2', cycle.id, 'WASH_IN', 'WASH_OUT', '2026-05-02T10:30:00Z'),
      transitionEvent('evt-3', cycle.id, 'WASH_OUT', 'DRY_IN', '2026-05-02T10:45:00Z'),
      transitionEvent('evt-4', cycle.id, 'DRY_IN', 'DRY_OUT', '2026-05-02T11:50:00Z'),
    ],
    stageLookup: standardStageLookup(),
    filter: defaultFilter('DRY_OUT', cycle.id),
    equipmentGroup: eg,
    checklistProfile: null,
    assetTemplate: defaultAssetTemplate(),
    user: FIXTURE_USER,
    now: FIXTURE_NOW,
    ...overrides,
  };
}

/**
 * Scenario 6 — flowMode='BYPASS_ENABLED'. Profile permits any-stage-from-any-stage
 * jumps with justification. Cycle is mid-WASH so bypass is plausible from here.
 * Used by `assertBypassAllowed` happy-path tests.
 */
export function bypassEnabledContext(overrides: Partial<LocalContext> = {}): LocalContext {
  const profile = standardProfile('BYPASS_ENABLED');
  const cycle = defaultCycle(profile);
  return {
    profile,
    cycle,
    events: [
      cycleStartedEvent(cycle.id),
      transitionEvent('evt-1', cycle.id, null, 'WASH_IN', '2026-05-02T10:05:00Z'),
    ],
    stageLookup: standardStageLookup(),
    filter: defaultFilter('WASH_IN', cycle.id),
    equipmentGroup: null,
    checklistProfile: null,
    assetTemplate: defaultAssetTemplate(),
    user: FIXTURE_USER,
    now: FIXTURE_NOW,
    ...overrides,
  };
}

/**
 * Scenario 7 — flowMode='LOCKED'. Strict next-stage-only. Cycle at WASH_IN can
 * only legally advance to WASH_OUT; bypass attempts must be rejected with
 * BYPASS_FORBIDDEN.
 *
 * Note: 'LOCKED' is a synthetic test value — the live schema uses
 * 'STRICT' or 'SEQUENTIAL' for non-bypass modes. The inventory uses the
 * 'LOCKED' label so we keep it for fixture symmetry; tests should treat
 * 'STRICT'/'SEQUENTIAL'/'LOCKED' as equivalent (anything that is not
 * 'BYPASS_ENABLED' triggers the bypass guard).
 */
export function lockedContext(overrides: Partial<LocalContext> = {}): LocalContext {
  const profile = standardProfile('LOCKED');
  const cycle = defaultCycle(profile);
  return {
    profile,
    cycle,
    events: [
      cycleStartedEvent(cycle.id),
      transitionEvent('evt-1', cycle.id, null, 'WASH_IN', '2026-05-02T10:05:00Z'),
    ],
    stageLookup: standardStageLookup(),
    filter: defaultFilter('WASH_IN', cycle.id),
    equipmentGroup: null,
    checklistProfile: null,
    assetTemplate: defaultAssetTemplate(),
    user: FIXTURE_USER,
    now: FIXTURE_NOW,
    ...overrides,
  };
}

/**
 * Scenario 8 — TERMINATED cycle. cycle.status='TERMINATED', terminatedAt set,
 * filter no longer references the cycle. No further actions are valid.
 * Used by guards that gate on cycle being IN_PROGRESS.
 */
export function terminatedContext(overrides: Partial<LocalContext> = {}): LocalContext {
  const profile = standardProfile();
  const cycle = defaultCycle(profile, {
    status: 'TERMINATED',
    terminatedAt: new Date('2026-05-02T11:30:00Z'),
  });
  return {
    profile,
    cycle,
    events: [
      cycleStartedEvent(cycle.id),
      transitionEvent('evt-1', cycle.id, null, 'WASH_IN', '2026-05-02T10:05:00Z'),
      {
        id: 'evt-terminate',
        cycleId: cycle.id,
        eventType: 'CYCLE_TERMINATED',
        fromState: 'WASH_IN',
        toState: null,
        performedAt: new Date('2026-05-02T11:30:00Z'),
        attributes: { justification: 'Equipment failure mid-cycle.' },
      },
    ],
    stageLookup: standardStageLookup(),
    filter: defaultFilter(null, null),
    equipmentGroup: null,
    checklistProfile: null,
    assetTemplate: defaultAssetTemplate(),
    user: FIXTURE_USER,
    now: FIXTURE_NOW,
    ...overrides,
  };
}
