/**
 * JSON schemas for `/api/rule-chains` and `/api/rule-engine/v1` (rule chains,
 * 2026-11-03; spec §9).
 *
 * The response schemas are a FILTER, not documentation: Fastify strips every
 * field they do not name, silently. Every field is therefore named here, and
 * the shapes that are not fixed — the chain `document`, a node type's fields /
 * default config / relations (an array, or the string 'dynamic'), a debug
 * event's `data` and `metadata` — are declared loose (`additionalProperties:
 * true`, or `{}` for "any JSON"), since an object declared without it
 * serialises to `{}`.
 *
 * The body schemas check SHAPE only, and none of them requires `reason`: a
 * missing reason must answer 400 REASON_REQUIRED from the handler, not
 * Fastify's generic 400. `_currentPassword` is declared on every write body
 * (the web client sends the re-auth password in the body); `additionalProperties:
 * false` strips anything else before the handler runs.
 */
import { RULE_CHAIN_NAME_MAX } from '@digilog/shared';
import { errorResponses } from '../../lib/error-schemas.js';
import { RULE_CHAIN_REASON_MAX, RULE_DEBUG_LIST_MAX } from './service.js';

const reauthPassword = { _currentPassword: { type: 'string' } } as const;
const reason = { reason: { type: 'string', maxLength: RULE_CHAIN_REASON_MAX } } as const;
const looseObject = { type: 'object', additionalProperties: true } as const;

export const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

const summaryProps = {
  id: { type: 'string' },
  name: { type: 'string' },
  root: { type: 'boolean' },
  debugMode: { type: 'boolean' },
  nodeCount: { type: 'integer' },
  updatedAt: { type: 'string', format: 'date-time' },
  updatedBy: { type: 'string', nullable: true },
} as const;

export const detailSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    name: { type: 'string' },
    root: { type: 'boolean' },
    debugMode: { type: 'boolean' },
    reEnterOnRuleNodeWrites: { type: 'boolean' },
    document: looseObject,
    updatedAt: { type: 'string', format: 'date-time' },
    updatedBy: { type: 'string', nullable: true },
  },
} as const;

export const listResponse = {
  200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', properties: summaryProps } } } },
  ...errorResponses,
} as const;

export const detailResponse = { 200: detailSchema, ...errorResponses } as const;
export const createdResponse = { 201: detailSchema, ...errorResponses } as const;
export const noContentResponse = { 204: { type: 'null' }, ...errorResponses } as const;

export const importResponse = {
  201: {
    type: 'object',
    properties: { id: { type: 'string' }, warnings: { type: 'array', items: { type: 'string' } } },
  },
  ...errorResponses,
} as const;

/** The export is the ThingsBoard JSON as a file: declared loose so every key of it is sent. */
export const exportResponse = { 200: looseObject, ...errorResponses } as const;

export const nodeTypesResponse = {
  200: {
    type: 'object',
    properties: {
      data: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string' },
            tbClass: { type: 'string' },
            group: { type: 'string' },
            label: { type: 'string' },
            description: { type: 'string' },
            status: { type: 'string' },
            // A list of labels, or 'dynamic' (Switch, Device profile switch, Rule chain).
            relations: {},
            fields: { type: 'array', items: looseObject },
            defaultConfig: looseObject,
          },
        },
      },
    },
  },
  ...errorResponses,
} as const;

export const debugQuery = {
  type: 'object',
  properties: {
    nodeId: { type: 'string', format: 'uuid' },
    limit: { type: 'integer', minimum: 1, maximum: RULE_DEBUG_LIST_MAX, default: 100 },
    before: { type: 'string', format: 'date-time' },
  },
  additionalProperties: false,
} as const;

export const debugResponse = {
  200: {
    type: 'object',
    properties: {
      data: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            chainId: { type: 'string' },
            nodeId: { type: 'string' },
            ts: { type: 'string', format: 'date-time' },
            direction: { type: 'string' },
            relation: { type: 'string', nullable: true },
            msgId: { type: 'string' },
            msgType: { type: 'string' },
            originatorType: { type: 'string' },
            originatorId: { type: 'string' },
            data: {},
            metadata: looseObject,
            error: { type: 'string', nullable: true },
          },
        },
      },
    },
  },
  ...errorResponses,
} as const;

export const statsResponse = {
  200: {
    type: 'object',
    properties: {
      enabled: { type: 'boolean' },
      queueDepth: { type: 'integer' },
      dropped: { type: 'integer' },
      processedLastMinute: { type: 'integer' },
      chains: {
        type: 'array',
        items: { type: 'object', properties: { id: { type: 'string' }, processedLastMinute: { type: 'integer' } } },
      },
      // The engine's counters since the server started (C1): step_limit, hop_limit, timeouts,
      // steps_abandoned, durable_requeued … — DECLARED, or Fastify strips the map to {}.
      counters: { type: 'object', additionalProperties: { type: 'integer' } },
    },
  },
  ...errorResponses,
} as const;

export const createBody = {
  type: 'object',
  properties: {
    name: { type: 'string', maxLength: RULE_CHAIN_NAME_MAX * 4 },
    document: looseObject,
    debugMode: { type: 'boolean' },
    reEnterOnRuleNodeWrites: { type: 'boolean' },
    ...reason,
    ...reauthPassword,
  },
  additionalProperties: false,
} as const;

export const updateBody = {
  type: 'object',
  required: ['document', 'expectedUpdatedAt'],
  properties: {
    name: { type: 'string', maxLength: RULE_CHAIN_NAME_MAX * 4 },
    document: looseObject,
    debugMode: { type: 'boolean' },
    reEnterOnRuleNodeWrites: { type: 'boolean' },
    // The `updatedAt` the editor loaded. A save against a chain changed since is 409 STALE.
    expectedUpdatedAt: { type: 'string', format: 'date-time' },
    ...reason,
    ...reauthPassword,
  },
  additionalProperties: false,
} as const;

/** DELETE /:id, POST /:id/root. */
export const reasonBody = {
  type: 'object',
  properties: { ...reason, ...reauthPassword },
  additionalProperties: false,
} as const;

export const clearDebugBody = {
  type: 'object',
  properties: { nodeId: { type: 'string', format: 'uuid' }, ...reason, ...reauthPassword },
  additionalProperties: false,
} as const;

export const importBody = {
  type: 'object',
  required: ['json'],
  properties: {
    // The ThingsBoard export as an object, or its JSON text.
    json: { type: ['object', 'string'] },
    // Optional: the new chain's name (default: the export's). A name in use is 409 NAME_IN_USE.
    name: { type: 'string', maxLength: RULE_CHAIN_NAME_MAX * 4 },
    ...reason,
    ...reauthPassword,
  },
  additionalProperties: false,
} as const;

export const testScriptBody = {
  type: 'object',
  required: ['scriptType', 'script'],
  properties: {
    scriptType: { type: 'string', enum: ['filter', 'switch', 'transform', 'generator', 'log', 'details'] },
    script: { type: 'string' },
    msg: {},
    metadata: looseObject,
    msgType: { type: 'string' },
  },
  additionalProperties: false,
} as const;

/** `POST /api/rule-engine/v1/messages` — ThingsBoard's "REST API request" into the root chain (spec §5). */
export const injectBody = {
  type: 'object',
  required: ['data'],
  properties: {
    type: { type: 'string', maxLength: 255 },
    originatorCode: { type: 'string', maxLength: 255 },
    data: {},
    metadata: { type: 'object', additionalProperties: { type: 'string' } },
  },
  additionalProperties: false,
} as const;

export const injectResponse = {
  202: {
    type: 'object',
    properties: { accepted: { type: 'boolean' }, reason: { type: 'string' }, msgId: { type: 'string' } },
  },
  ...errorResponses,
} as const;
