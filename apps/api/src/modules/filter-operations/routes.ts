/**
 * Filter Operations Routes — Cycle management, advance, bypass, checklist, events, cycles.
 */
import type { FastifyInstance } from 'fastify';
import { FilterOperationsService } from './filter-operations.service.js';
import { buildContext } from '../../lib/build-context.js';
import { errorResponses } from '../../lib/error-schemas.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { getFilterStageRules, buildStageOptions } from './stage-rules.js';
import { getCleaningReasons } from './filter-resolver.js';
import { computeAhuCompletionStatus, computeAhuBatchStatus, computeAhuSetAvailability, findProfilesWithoutFinalChecklist } from './ahu-completion-gate.js';
import { reauthActionsForItems, type BulkOpItem } from './cycle-write/bulk-operate.js';

// Input bounds (2026-07-09 QA — "unbounded free-text / object" finding): cap every
// free-text and open-object field at the schema edge so an oversized payload is
// rejected with 400 BEFORE it can reach the immutable, hash-chained audit_trail /
// filter_event rows. Unbounded input is a storage-growth + payload-DoS vector, and
// unlike an ordinary table a bloated audit row can't be cleaned up afterward.
// Generous — real operator input is a sentence or two; only abuse or a bug hits the
// ceiling. `justification` fields keep their own minLength alongside this max.
const MAX_TEXT_LEN = 2000;      // remarks / justification / short free-text keys
const MAX_OBJECT_PROPS = 500;   // parameters / checklistData / instrumentReadings / answers key counts

// Stage stateKeys are free-form in the cleaning-profile schema but are only ever
// created from a fixed dropdown (CLEANING_STAGES) as UPPER_SNAKE identifiers
// (WASH_IN … STORAGE_OUT). Constrain advance/bypass targetState to that shape at
// the schema edge so garbage (spaces / lowercase / injection / oversized) is
// rejected up front — while still accepting any conventionally-named stage,
// including future ones, so it can't regress. The service
// (assertTargetStateReachable / assertTargetStateExists) stays the authoritative
// check against the profile's ACTUAL states. 64-char ceiling (max real key = 11).
const STATE_KEY_PATTERN = '^[A-Z][A-Z0-9_]{0,63}$';

// bulk-operate's item schema shares one `payload`/`cyclePayload`/`advancePayload`
// object across all four op kinds (advance | start-and-advance | submit-checklist |
// advance-with-checklist — the last one being a union of the advance + checklist
// fields, already covered here),
// so this is the union of every free-text/constrained field from the single-item
// /:id/advance, /:id/start-cycle, and /:id/submit-checklist body schemas above —
// each field's bound copied verbatim from its single-route sibling. See the
// 2026-07-09 review comment above MAX_TEXT_LEN/MAX_OBJECT_PROPS for why this
// matters: without it, batch payloads could carry unbounded free-text into the
// audit_trail / filter_event rows via a path the single-item routes already close.
const BULK_PAYLOAD_PROPERTIES = {
  // shared with /:id/advance and /:id/bypass
  targetState: { type: 'string', pattern: STATE_KEY_PATTERN },
  // shared with /:id/advance, /:id/bypass, /:id/terminate-cycle
  remarks: { type: 'string', maxLength: MAX_TEXT_LEN },
  justification: { type: 'string', minLength: 10, maxLength: MAX_TEXT_LEN },
  // /:id/start-cycle
  cleaningReasonKey: { type: 'string', maxLength: MAX_TEXT_LEN },
  cleaningJustification: { type: 'string', maxLength: MAX_TEXT_LEN },
  cleaningAreaId: { type: 'string', format: 'uuid' },
  equipmentGroupId: { type: 'string', format: 'uuid' },
  acknowledgeBlockChange: { type: 'boolean' },
  // /:id/advance
  parameters: { type: 'object', maxProperties: MAX_OBJECT_PROPS },
  equipmentId: { type: 'string', format: 'uuid' },
  checklistData: { type: 'object', maxProperties: MAX_OBJECT_PROPS },
  instrumentReadings: { type: 'object', additionalProperties: { type: 'number' }, maxProperties: MAX_OBJECT_PROPS },
  dryerAction: { type: 'string', enum: ['SET_DURATION', 'SUBMIT_READINGS'] },
  dryerDurationMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
  // /:id/submit-checklist
  answers: { type: 'object', additionalProperties: true, maxProperties: MAX_OBJECT_PROPS },
  expectedProfileVersions: { type: 'object', additionalProperties: { type: 'integer' }, maxProperties: MAX_OBJECT_PROPS },
  filterSet: { type: 'string', enum: ['ALL', 'SET_A', 'SET_B'] },
  // shared staleness guard across all write routes
  tapeVersion: { type: 'integer' },
  offlinePerformedAt: { type: 'string', format: 'date-time' },
  clientOpId: { type: 'string' },
};

export default async function filterOperationsRoutes(app: FastifyInstance) {
  const service = new FilterOperationsService();

  // P1 (2026-06-03): valid cleaning-profile stage options for the web
  // "Edit Filter Status" dialog. Returns the profile's ordered stages + a
  // per-stage classification so the dialog only offers legal moves and can
  // show "Invalid stage movement…" for skips. Works with or without an active
  // cycle. Reuses getFilterStageRules → the SAME findReachable() the tablet
  // uses, so manual web moves run identical sequence rules to tablet cleaning.
  app.get('/:id/stage-options', {
    preHandler: [app.requirePermission('ASSET_READ')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Valid next cleaning stages for a filter (web manual status update)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      response: {
        200: {
          type: 'object',
          properties: {
            hasProfile: { type: 'boolean' },
            hasActiveCycle: { type: 'boolean' },
            profileName: { type: 'string', nullable: true },
            currentStage: { type: 'string', nullable: true },
            orderedStages: { type: 'array', items: { type: 'string' } },
            immediateNext: { type: 'array', items: { type: 'string' } },
            options: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  state: { type: 'string' },
                  classification: { type: 'string' },
                  allowed: { type: 'boolean' },
                  isCurrent: { type: 'boolean' },
                  startsCycle: { type: 'boolean' },
                },
              },
            },
            // P3: cleaning reasons for the move that starts a cycle. The dialog
            // shows this picker when the selected option has startsCycle=true.
            cleaningReasons: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    const rules = await getFilterStageRules(id);
    const cleaningReasons = rules.hasProfile && rules.profileId
      ? await getCleaningReasons(rules.profileId)
      : [];
    return {
      hasProfile: rules.hasProfile,
      hasActiveCycle: rules.hasActiveCycle,
      profileName: rules.profileName,
      currentStage: rules.currentStage,
      orderedStages: rules.orderedStages,
      immediateNext: rules.immediateNext,
      options: buildStageOptions(rules),
      cleaningReasons,
    };
  });

  app.get('/:id/current-state', {
    preHandler: [app.requirePermission('ASSET_READ')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Get filter current state and next actions',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      querystring: {
        type: 'object',
        properties: {
          cleaningAreaId: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            filterId: { type: 'string' },
            filterName: { type: 'string', nullable: true },
            currentState: { type: 'string', nullable: true },
            currentCycle: { type: 'object', nullable: true, additionalProperties: true },
            nextBlocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pipelineStages: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pipelineGraph: { type: 'object', nullable: true, additionalProperties: true },
            profile: { type: 'object', nullable: true, additionalProperties: true },
            filterSet: { type: 'string', nullable: true },
            totalCycles: { type: 'integer' },
            equipmentGroup: { type: 'object', nullable: true, additionalProperties: true },
            blockEquipmentGroups: { type: 'array', items: { type: 'object', additionalProperties: true } },
            homeBlock: {
              type: 'object',
              nullable: true,
              properties: { id: { type: 'string' }, name: { type: 'string' } },
            },
            blockChangeStatus: { type: 'string', nullable: true, enum: ['MATCH', 'CONFIRM', 'APPROVED', 'REQUIRED'] },
            blockChangeMode: { type: 'string', enum: ['CONFIRM', 'APPROVAL'] },
            isPmDue: { type: 'boolean' },
            pmReasonKey: { type: 'string', nullable: true },
            profileSyncWarning: {
              type: 'object',
              nullable: true,
              additionalProperties: true,
              properties: {
                cycleProfileId: { type: 'string' },
                cycleProfileName: { type: 'string', nullable: true },
                expectedProfileId: { type: 'string' },
                expectedProfileName: { type: 'string', nullable: true },
                recommendation: { type: 'string' },
              },
            },
            // L3 (2026-05-02): advisory warning when admin has edited the
            // cycle's pinned EquipmentGroup. Readings still validate against
            // the pinned snapshot.
            equipmentGroupSyncWarning: {
              type: 'object',
              nullable: true,
              additionalProperties: true,
              properties: {
                groupId: { type: 'string' },
                pinnedVersion: { type: 'integer' },
                liveVersion: { type: 'integer' },
                recommendation: { type: 'string' },
              },
            },
            stageLookup: {
              type: 'object',
              additionalProperties: {
                type: 'object',
                properties: {
                  nextStages: { type: 'array', items: { type: 'string' } },
                  pendingChecklistProfileIds: { type: 'array', items: { type: 'string' } },
                  leadsToEnd: { type: 'boolean' },
                  // Undeclared until 2026-07-15, so fast-json-stringify silently
                  // dropped it. Online that only hid the QA banner (actions[] is
                  // declared and still gated), but the OFFLINE tablet reads this
                  // flag out of the cached response: `!!undefined === false` let
                  // an operator advance out of an interlock stage with no QA
                  // approval. See mobile-operations.tsx interlockGatedNow.
                  interlockGated: { type: 'boolean' },
                },
              },
              description: 'Per-stage lookup for offline use: from a given stateKey, what comes next + which checklists fire',
            },
            interlock: {
              type: 'object',
              nullable: true,
              additionalProperties: true,
              description: 'Stage-interlock display state (blocksLeaving, pending QA approval) for the current stage',
            },
            // Phase 8.7 cutover (decision-tape architecture): the action tape
            // is now the authoritative server-emitted contract. The FE consumes
            // `actions[]` + `tapeVersion` directly; the old `nextAllowedStages`
            // and `pendingChecklist` fields have been removed. additionalProperties:true
            // on each action lets the per-type discriminated union shapes
            // (validations, params subtypes) flow through unchanged.
            actions: {
              type: 'array',
              items: { type: 'object', additionalProperties: true, properties: { type: { type: 'string' }, label: { type: 'string' } } },
              description: 'Decision-tape: ordered list of permitted next actions for the current cycle state',
            },
            tapeVersion: {
              type: 'integer',
              description: 'Monotonic per-cycle version derived from profileVersion + recent events; clients send this back with writes for staleness checks',
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    const { cleaningAreaId } = (req.query ?? {}) as { cleaningAreaId?: string };
    return service.getCurrentState(ctx, id, cleaningAreaId);
  });

  // Batch: get current-state for all filters in one call (for offline caching)
  app.get('/batch-states', {
    preHandler: [app.requirePermission('ASSET_READ')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Get current state for all filters (for offline caching)',
      querystring: {
        type: 'object',
        properties: {
          cleaningAreaId: { type: 'string', format: 'uuid' },
        },
      },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    const { cleaningAreaId } = (req.query ?? {}) as { cleaningAreaId?: string };
    return service.getBatchStates(ctx, cleaningAreaId);
  });

  app.post('/:id/start-cycle', {
    preHandler: [app.requirePermission('FILTER_OPERATE')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Start a new cleaning cycle',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['cleaningReasonKey'],
        properties: {
          cleaningReasonKey: { type: 'string', maxLength: MAX_TEXT_LEN },
          cleaningJustification: { type: 'string', maxLength: MAX_TEXT_LEN },
          cleaningAreaId: { type: 'string', format: 'uuid' },
          equipmentGroupId: { type: 'string', format: 'uuid' },
          offlinePerformedAt: { type: 'string', format: 'date-time' },
          clientOpId: { type: 'string', description: 'Client-generated UUID for idempotent replay' },
          acknowledgeBlockChange: { type: 'boolean', description: 'Operator confirmed cleaning in a different block (Continue with cleaning)' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            cycleCode: { type: 'string' },
            filterId: { type: 'string' },
            status: { type: 'string' },
            sequenceNumber: { type: 'integer' },
          },
          additionalProperties: true,
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('START_CLEANING_CYCLE', req, reply);
    if (!ok) return;

    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    const result = await service.startCycle(ctx, id, req.body);
    return reply.code(201).send(result);
  });

  app.post('/:id/advance', {
    preHandler: [app.requirePermission('FILTER_OPERATE')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Advance filter to next stage',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['targetState', 'tapeVersion'],
        properties: {
          targetState: { type: 'string', pattern: STATE_KEY_PATTERN },
          parameters: { type: 'object', maxProperties: MAX_OBJECT_PROPS },
          equipmentId: { type: 'string', format: 'uuid' },
          cleaningAreaId: { type: 'string', format: 'uuid' },
          remarks: { type: 'string', maxLength: MAX_TEXT_LEN },
          checklistData: { type: 'object', maxProperties: MAX_OBJECT_PROPS },
          equipmentGroupId: { type: 'string', format: 'uuid' },
          instrumentReadings: { type: 'object', additionalProperties: { type: 'number' }, maxProperties: MAX_OBJECT_PROPS },
          dryerAction: { type: 'string', enum: ['SET_DURATION', 'SUBMIT_READINGS'] },
          dryerDurationMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
          offlinePerformedAt: { type: 'string', format: 'date-time' },
          clientOpId: { type: 'string', description: 'Client-generated UUID for idempotent replay' },
          // Phase 8.7 cutover (decision-tape architecture): required staleness
          // guard. Server compares to the live tapeVersion derived from
          // (profileVersion, filterEventCount) and rejects with 409 STALE_TAPE
          // if mismatched. FE always reads tapeVersion from getCurrentState or
          // a prior write response and sends it back.
          tapeVersion: { type: 'integer', description: 'Required staleness guard; rejected with 409 STALE_TAPE on mismatch' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            filterId: { type: 'string' },
            filterName: { type: 'string', nullable: true },
            currentState: { type: 'string', nullable: true },
            currentCycle: { type: 'object', nullable: true, additionalProperties: true },
            nextBlocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pipelineStages: { type: 'array', items: { type: 'object', additionalProperties: true } },
            profile: { type: 'object', nullable: true, additionalProperties: true },
            filterSet: { type: 'string', nullable: true },
            totalCycles: { type: 'integer' },
            equipmentGroup: { type: 'object', nullable: true, additionalProperties: true },
            // Phase 8.7 cutover: post-write tape so FE can consume next-action
            // state without a follow-up getCurrentState round-trip.
            actions: {
              type: 'array',
              items: { type: 'object', additionalProperties: true, properties: { type: { type: 'string' }, label: { type: 'string' } } },
              description: 'Decision-tape: ordered list of permitted next actions after this write',
            },
            tapeVersion: {
              type: 'integer',
              description: 'Monotonic per-cycle version after this write; send back as the staleness guard on the next write',
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('ADVANCE_FILTER_STAGE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.advance(ctx, id, req.body);
  });

  // Atomic advance + post-stage checklist (2026-07-16). The bare /advance above
  // commits the transition BEFORE the operator answers the stage's mandatory
  // checklist — closing the dialog leaves an orphaned 21 CFR §11 record of a
  // stage entry whose required attestation was never given. This op does both in
  // ONE transaction (both or neither). See cycle-write/advance-with-checklist.ts
  // and tasks/ATOMIC-ADVANCE-CHECKLIST-PLAN.md.
  //
  // Gates: identical to running both ops — same FILTER_OPERATE permission, and
  // BOTH reauth actions are enforced so the composed path can never be used to
  // slip past a gate that either single op would have applied.
  app.post('/:id/advance-with-checklist', {
    preHandler: [app.requirePermission('FILTER_OPERATE')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Advance to next stage AND submit that stage\'s checklist atomically',
      description:
        'Performs the stage advance and its post-stage checklist in a single transaction. '
        + 'Rejects with 400 NO_CHECKLIST_AT_TARGET when no active checklist follows targetState '
        + '(use POST /:id/advance for those stages).',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        // Union of the /advance and /submit-checklist required fields.
        required: ['targetState', 'answers', 'tapeVersion'],
        properties: {
          // ── advance half ──
          targetState: { type: 'string', pattern: STATE_KEY_PATTERN },
          parameters: { type: 'object', maxProperties: MAX_OBJECT_PROPS },
          equipmentId: { type: 'string', format: 'uuid' },
          cleaningAreaId: { type: 'string', format: 'uuid' },
          remarks: { type: 'string', maxLength: MAX_TEXT_LEN },
          equipmentGroupId: { type: 'string', format: 'uuid' },
          instrumentReadings: { type: 'object', additionalProperties: { type: 'number' }, maxProperties: MAX_OBJECT_PROPS },
          dryerAction: { type: 'string', enum: ['SET_DURATION', 'SUBMIT_READINGS'] },
          dryerDurationMinutes: { type: 'integer', minimum: 1, maximum: 1440 },
          // ── checklist half ──
          answers: {
            type: 'object',
            additionalProperties: true,
            maxProperties: MAX_OBJECT_PROPS,
            description: 'Map of questionId -> answer value, for the checklist AFTER targetState',
          },
          expectedProfileVersions: {
            type: 'object',
            additionalProperties: { type: 'integer' },
            maxProperties: MAX_OBJECT_PROPS,
            description: 'Phase A.1: client-cached version per checklistProfileId. 409 SCHEMA_DRIFT on mismatch.',
          },
          filterSet: { type: 'string', enum: ['ALL', 'SET_A', 'SET_B'], description: 'AHU-completion filter-set scope for the INTERLOCK gate' },
          // ── shared ──
          offlinePerformedAt: { type: 'string', format: 'date-time' },
          clientOpId: { type: 'string', description: 'Client-generated UUID for idempotent replay; stamped on BOTH events' },
          tapeVersion: { type: 'integer', description: 'Required staleness guard; rejected with 409 STALE_TAPE on mismatch' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            filterId: { type: 'string' },
            filterName: { type: 'string', nullable: true },
            currentState: { type: 'string', nullable: true },
            currentCycle: { type: 'object', nullable: true, additionalProperties: true },
            nextBlocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pipelineStages: { type: 'array', items: { type: 'object', additionalProperties: true } },
            profile: { type: 'object', nullable: true, additionalProperties: true },
            filterSet: { type: 'string', nullable: true },
            totalCycles: { type: 'integer' },
            equipmentGroup: { type: 'object', nullable: true, additionalProperties: true },
            actions: {
              type: 'array',
              items: { type: 'object', additionalProperties: true, properties: { type: { type: 'string' }, label: { type: 'string' } } },
              description: 'Decision-tape: ordered list of permitted next actions after this write',
            },
            tapeVersion: {
              type: 'integer',
              description: 'Monotonic per-cycle version after this write; send back as the staleness guard on the next write',
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // Both actions — this op performs both writes, so it must clear both gates.
    const { ok } = await enforceReauth(['ADVANCE_FILTER_STAGE', 'SUBMIT_CHECKLIST_WITH_SIGNATURE'], req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.advanceWithChecklist(ctx, id, req.body);
  });

  app.post('/:id/submit-checklist', {
    preHandler: [app.requirePermission('FILTER_OPERATE')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Submit checklist answers for current stage',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['answers', 'tapeVersion'],
        properties: {
          answers: {
            type: 'object',
            additionalProperties: true,
            maxProperties: MAX_OBJECT_PROPS,
            description: 'Map of questionId -> answer value',
          },
          offlinePerformedAt: { type: 'string', format: 'date-time' },
          clientOpId: { type: 'string', description: 'Client-generated UUID for idempotent replay' },
          expectedProfileVersions: {
            type: 'object',
            additionalProperties: { type: 'integer' },
            maxProperties: MAX_OBJECT_PROPS,
            description: 'Phase A.1: client-cached version per checklistProfileId. Server returns 409 SCHEMA_DRIFT if any version mismatches the cycle pin.',
          },
          // Phase 8.7 cutover (decision-tape architecture): required staleness
          // guard. See /advance route comment.
          tapeVersion: { type: 'integer', description: 'Required staleness guard; rejected with 409 STALE_TAPE on mismatch' },
          // 2026-07-03: operator's runtime AHU filter-set choice. Scopes the
          // INTERLOCK gate to the same roster the pre-popup chooser showed.
          // Omitted / 'ALL' = every filter under the AHU (legacy behavior).
          filterSet: { type: 'string', enum: ['ALL', 'SET_A', 'SET_B'], description: 'AHU-completion filter-set scope for the INTERLOCK gate' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            filterId: { type: 'string' },
            filterName: { type: 'string', nullable: true },
            currentState: { type: 'string', nullable: true },
            currentCycle: { type: 'object', nullable: true, additionalProperties: true },
            nextBlocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pipelineStages: { type: 'array', items: { type: 'object', additionalProperties: true } },
            profile: { type: 'object', nullable: true, additionalProperties: true },
            filterSet: { type: 'string', nullable: true },
            totalCycles: { type: 'integer' },
            equipmentGroup: { type: 'object', nullable: true, additionalProperties: true },
            // Phase 8.7 cutover: post-write tape.
            actions: {
              type: 'array',
              items: { type: 'object', additionalProperties: true, properties: { type: { type: 'string' }, label: { type: 'string' } } },
              description: 'Decision-tape: ordered list of permitted next actions after this write',
            },
            tapeVersion: {
              type: 'integer',
              description: 'Monotonic per-cycle version after this write; send back as the staleness guard on the next write',
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('SUBMIT_CHECKLIST_WITH_SIGNATURE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.submitChecklist(ctx, id, req.body as any);
  });

  app.post('/:id/bypass', {
    preHandler: [app.requirePermission('FILTER_BYPASS')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Bypass pipeline stage (deviation)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['targetState', 'justification', 'tapeVersion'],
        properties: {
          targetState: { type: 'string', pattern: STATE_KEY_PATTERN },
          justification: { type: 'string', minLength: 10, maxLength: MAX_TEXT_LEN },
          parameters: { type: 'object', maxProperties: MAX_OBJECT_PROPS },
          offlinePerformedAt: { type: 'string', format: 'date-time' },
          clientOpId: { type: 'string', description: 'Client-generated UUID for idempotent replay' },
          // Phase 8.7 cutover (decision-tape architecture): required staleness guard.
          tapeVersion: { type: 'integer', description: 'Required staleness guard; rejected with 409 STALE_TAPE on mismatch' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            filterId: { type: 'string' },
            filterName: { type: 'string', nullable: true },
            currentState: { type: 'string', nullable: true },
            currentCycle: { type: 'object', nullable: true, additionalProperties: true },
            nextBlocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pipelineStages: { type: 'array', items: { type: 'object', additionalProperties: true } },
            profile: { type: 'object', nullable: true, additionalProperties: true },
            filterSet: { type: 'string', nullable: true },
            totalCycles: { type: 'integer' },
            equipmentGroup: { type: 'object', nullable: true, additionalProperties: true },
            // Phase 8.7 cutover: post-write tape.
            actions: {
              type: 'array',
              items: { type: 'object', additionalProperties: true, properties: { type: { type: 'string' }, label: { type: 'string' } } },
              description: 'Decision-tape: ordered list of permitted next actions after this write',
            },
            tapeVersion: {
              type: 'integer',
              description: 'Monotonic per-cycle version after this write; send back as the staleness guard on the next write',
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('BYPASS_FILTER_STAGE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.bypass(ctx, id, req.body);
  });

  app.post('/bulk-operate', {
    preHandler: [app.requirePermission('FILTER_OPERATE')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Batch cleaning ops (advance / start-and-advance / submit-checklist) in one request',
      body: {
        type: 'object',
        required: ['items'],
        properties: {
          items: {
            type: 'array',
            minItems: 1,
            maxItems: 200,
            items: {
              type: 'object',
              required: ['clientOpId', 'filterId', 'kind'],
              properties: {
                clientOpId: { type: 'string', maxLength: 100 },
                filterId: { type: 'string', format: 'uuid' },
                kind: { type: 'string', enum: ['advance', 'start-and-advance', 'submit-checklist', 'advance-with-checklist'] },
                // Each of payload / cyclePayload / advancePayload is a superset schema
                // covering the union of fields the single-item /advance, /start-cycle,
                // and /submit-checklist routes accept (a batch item's actual shape
                // depends on `kind`). additionalProperties:true + maxProperties stays
                // as a backstop for fields not enumerated below, but every free-text /
                // constrained field is bounded here exactly as its single-route sibling
                // bounds it, so an oversized batch payload can't reach the immutable
                // audit_trail / filter_event rows any more than a single-item call can.
                payload: { type: 'object', additionalProperties: true, maxProperties: MAX_OBJECT_PROPS, properties: BULK_PAYLOAD_PROPERTIES },
                cyclePayload: { type: 'object', additionalProperties: true, maxProperties: MAX_OBJECT_PROPS, properties: BULK_PAYLOAD_PROPERTIES },
                advancePayload: { type: 'object', additionalProperties: true, maxProperties: MAX_OBJECT_PROPS, properties: BULK_PAYLOAD_PROPERTIES },
              },
            },
          },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            results: {
              type: 'array',
              items: { type: 'object', additionalProperties: true },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { items } = req.body as { items: BulkOpItem[] };
    const { ok } = await enforceReauth(reauthActionsForItems(items), req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    return service.bulkOperate(ctx, items);
  });

  // ── Retire a filter ──
  app.post('/:id/retire', {
    // M2 fix (2026-06-30): drop FILTER_OPERATE fallback — require FILTER_RETIRE (the
    // perm the UI gates on) so operate-only roles can't retire via API bypass.
    preHandler: [app.requirePermission('FILTER_RETIRE')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Retire a filter permanently',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['remarks'],
        properties: { remarks: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LEN } },
      },
      response: {
        200: {
          type: 'object',
          properties: { success: { type: 'boolean' } },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('RETIRE_FILTER', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    const { remarks } = req.body as { remarks: string };
    return service.retire(ctx, id, remarks);
  });

  // ── Replace a filter ──
  app.post('/:id/replace', {
    // M2 fix (2026-06-30): drop FILTER_OPERATE fallback — require FILTER_REPLACE.
    preHandler: [app.requirePermission('FILTER_REPLACE')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Replace a filter (retire old + create new)',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['remarks'],
        properties: { remarks: { type: 'string', minLength: 1, maxLength: MAX_TEXT_LEN } },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            oldFilterId: { type: 'string' },
            newFilterId: { type: 'string' },
            newFilterName: { type: 'string' },
            identifiersMoved: { type: 'integer' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('REPLACE_FILTER', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    const { remarks } = req.body as { remarks: string };
    return service.replace(ctx, id, remarks);
  });

  // ── List retired filters ──
  app.get('/retirements', {
    preHandler: [app.requirePermission('ASSET_READ')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'List all retired filters',
      response: {
        200: { type: 'array', items: { type: 'object', additionalProperties: true } },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.getRetirements(ctx);
  });

  // ── List replacements ──
  app.get('/replacements', {
    preHandler: [app.requirePermission('ASSET_READ')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'List filter replacement history',
      response: {
        200: { type: 'array', items: { type: 'object', additionalProperties: true } },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const ctx = buildContext(req);
    return service.getReplacements(ctx);
  });

  app.post('/:id/terminate-cycle', {
    preHandler: [app.requirePermission('FILTER_BYPASS')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Terminate active cleaning cycle',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string', format: 'uuid' } } },
      body: {
        type: 'object',
        required: ['justification', 'tapeVersion'],
        properties: {
          justification: { type: 'string', minLength: 10, maxLength: MAX_TEXT_LEN },
          offlinePerformedAt: { type: 'string', format: 'date-time' },
          clientOpId: { type: 'string', description: 'Client-generated UUID for idempotent replay' },
          // Phase 8.7 cutover (decision-tape architecture): required staleness guard.
          tapeVersion: { type: 'integer', description: 'Required staleness guard; rejected with 409 STALE_TAPE on mismatch' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            filterId: { type: 'string' },
            filterName: { type: 'string', nullable: true },
            currentState: { type: 'string', nullable: true },
            currentCycle: { type: 'object', nullable: true, additionalProperties: true },
            nextBlocks: { type: 'array', items: { type: 'object', additionalProperties: true } },
            pipelineStages: { type: 'array', items: { type: 'object', additionalProperties: true } },
            profile: { type: 'object', nullable: true, additionalProperties: true },
            filterSet: { type: 'string', nullable: true },
            totalCycles: { type: 'integer' },
            equipmentGroup: { type: 'object', nullable: true, additionalProperties: true },
            // Phase 8.7 cutover: post-write tape.
            actions: {
              type: 'array',
              items: { type: 'object', additionalProperties: true, properties: { type: { type: 'string' }, label: { type: 'string' } } },
              description: 'Decision-tape: ordered list of permitted next actions after this write',
            },
            tapeVersion: {
              type: 'integer',
              description: 'Monotonic per-cycle version after this write; send back as the staleness guard on the next write',
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('TERMINATE_CLEANING_CYCLE', req, reply);
    if (!ok) return;
    const ctx = buildContext(req);
    const { id } = req.params as { id: string };
    return service.terminateCycle(ctx, id, req.body as { justification: string; clientOpId?: string; tapeVersion?: number });
  });

  // ── Task 8: profiles without a terminal CHECKLIST before END ──────────────
  // Used by the admin config UI to warn that INTERLOCK mode cannot enforce
  // these profiles (they auto-complete via `advance()`, never reaching
  // `submit-checklist` where the gate fires).
  app.get('/cleaning-profiles/without-final-checklist', {
    preHandler: [app.requirePermission('ASSET_READ')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'List active cleaning profiles whose final stage has no terminal CHECKLIST before END',
      description:
        'Returns cleaning profiles in which the final STAGE leads directly to END without a ' +
        'CHECKLIST node on the path. These profiles cannot be enforced by AHU INTERLOCK mode ' +
        'because the operator never reaches the submit-checklist gate that triggers the check.',
      response: {
        200: {
          type: 'object',
          properties: {
            profiles: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                },
                required: ['id', 'name'],
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async () => {
    return { profiles: await findProfilesWithoutFinalChecklist() };
  });

  // ── AHU completion status ─────────────────────────────────────────────────
  // Returns how many sibling filters are still pending for the given AHU.
  // Optional ?exclude= query param omits the calling filter from the sibling count
  // (mirrors the exclude arg of computeAhuCompletionStatus).
  app.get('/ahu/:ahuId/completion-status', {
    preHandler: [app.requirePermission('ASSET_READ')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'AHU completion status — which sibling filters are still pending',
      params: { type: 'object', required: ['ahuId'], properties: { ahuId: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          exclude: { type: 'string' },
          // Operator's runtime filter-set choice; omitted / 'ALL' = every filter.
          set: { type: 'string', enum: ['ALL', 'SET_A', 'SET_B'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            allAtFinal: { type: 'boolean' },
            ahuName: { type: 'string' },
            pending: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  stage: { type: 'string' },
                },
              },
            },
            filters: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  stage: { type: 'string' },
                  done: { type: 'boolean' },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { ahuId } = req.params as { ahuId: string };
    const { exclude, set } = (req.query ?? {}) as { exclude?: string; set?: 'ALL' | 'SET_A' | 'SET_B' };
    return computeAhuCompletionStatus(ahuId, exclude ?? '', set);
  });

  // ── AHU completion status — BATCH (multi-AHU carousel) ──────────────────────
  // Given the filter ids in a submission batch, return one status block per
  // distinct AHU. Powers the multi-AHU dialog on desktop + tablet.
  app.post('/ahu-completion-status/batch', {
    preHandler: [app.requirePermission('ASSET_READ')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'AHU completion status for every AHU in a submission batch',
      body: {
        type: 'object',
        required: ['filterIds'],
        properties: {
          filterIds: { type: 'array', items: { type: 'string' } },
          // Operator's runtime filter-set choice; omitted / 'ALL' = every filter.
          set: { type: 'string', enum: ['ALL', 'SET_A', 'SET_B'] },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            ahus: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  ahuId: { type: 'string' },
                  ahuName: { type: 'string' },
                  allAtFinal: { type: 'boolean' },
                  filters: {
                    type: 'array',
                    items: {
                      type: 'object',
                      properties: {
                        id: { type: 'string' },
                        name: { type: 'string' },
                        stage: { type: 'string' },
                        done: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { filterIds, set } = (req.body ?? {}) as { filterIds: string[]; set?: 'ALL' | 'SET_A' | 'SET_B' };
    return computeAhuBatchStatus(Array.isArray(filterIds) ? filterIds : [], set);
  });

  // ── AHU set availability — does this batch span BOTH Set A and Set B? ────────
  // Drives whether the frontend surfaces the A/B/All chooser. When false, the
  // choice is meaningless (no A/B split) so the client proceeds as ALL.
  app.post('/ahu-set-availability', {
    preHandler: [app.requirePermission('ASSET_READ')],
    schema: {
      tags: ['Filter Operations'],
      summary: 'Whether a submission batch spans both Set A and Set B filters',
      body: {
        type: 'object',
        required: ['filterIds'],
        properties: { filterIds: { type: 'array', items: { type: 'string' } } },
      },
      response: {
        200: { type: 'object', properties: { hasBothSets: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req) => {
    const { filterIds } = (req.body ?? {}) as { filterIds: string[] };
    return computeAhuSetAvailability(Array.isArray(filterIds) ? filterIds : []);
  });
}
