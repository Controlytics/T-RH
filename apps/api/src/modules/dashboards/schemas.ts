/**
 * JSON schemas for `/api/dashboards` (dashboard builder phase 1, 2026-10-29).
 *
 * The response schemas are a FILTER, not documentation: Fastify strips any
 * field they do not name, silently. Every field of `DashboardSummary` /
 * `DashboardDetail` (`@digilog/shared`) is therefore named here, inner keys
 * included. `document` is declared as a free object on purpose — its shape is
 * the shared zod contract (`parseDashboardDocument` / `readDashboardDocument`),
 * and an object declared without `additionalProperties: true` serialises to
 * `{}` (the precedent is `WIDGETS_JSON_SCHEMA` in modules/config).
 *
 * The body schemas check SHAPE only. The rules that need the stored row or the
 * shared parser (a title blank once trimmed, the strict document parse, unknown
 * roles and users) run in the handler, after the role check, the 404 and the
 * re-auth, so the order of refusals is the brief's.
 */
import { errorResponses } from '../../lib/error-schemas.js';

export const DASHBOARD_TITLE_MAX = 200;
export const DASHBOARD_DESCRIPTION_MAX = 500;
export const ASSIGNMENT_ROLES_MAX = 50;
export const ASSIGNMENT_USERS_MAX = 500;

export const idParams = {
  type: 'object',
  properties: { id: { type: 'string', format: 'uuid' } },
  required: ['id'],
} as const;

const assignmentsProps = {
  roles: { type: 'array', items: { type: 'string' } },
  users: {
    type: 'array',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        username: { type: 'string' },
        fullName: { type: 'string', nullable: true },
      },
    },
  },
} as const;

export const assignmentsSchema = { type: 'object', properties: assignmentsProps } as const;

export const summaryProps = {
  id: { type: 'string' },
  title: { type: 'string' },
  description: { type: 'string', nullable: true },
  sourceSummary: {
    type: 'object',
    properties: { mode: { type: 'string' }, label: { type: 'string' } },
  },
  widgetCount: { type: 'integer' },
  updatedAt: { type: 'string', format: 'date-time' },
  // Sent to a SUPER_ADMIN only; absent (not null) for everyone else.
  assignments: assignmentsSchema,
} as const;

export const detailSchema = {
  type: 'object',
  properties: {
    ...summaryProps,
    document: { type: 'object', additionalProperties: true },
  },
} as const;

export const listResponse = {
  200: {
    type: 'object',
    properties: { data: { type: 'array', items: { type: 'object', properties: summaryProps } } },
  },
  ...errorResponses,
} as const;

export const detailResponse = { 200: detailSchema, ...errorResponses } as const;
export const createdResponse = { 201: detailSchema, ...errorResponses } as const;
export const assignmentsResponse = { 200: assignmentsSchema, ...errorResponses } as const;
export const deleteResponse = {
  200: { type: 'object', properties: { success: { type: 'boolean' } } },
  ...errorResponses,
} as const;

/** The web client sends the re-auth password in the body as well as the header. */
const reauthPassword = { _currentPassword: { type: 'string' } } as const;

export const createDashboardBody = {
  type: 'object',
  required: ['title'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: DASHBOARD_TITLE_MAX },
    description: { type: ['string', 'null'], maxLength: DASHBOARD_DESCRIPTION_MAX },
    document: { type: 'object', additionalProperties: true },
    ...reauthPassword,
  },
  additionalProperties: false,
} as const;

/**
 * `additionalProperties: false` is load-bearing: with it, Fastify's default
 * `removeAdditional` strips `createdBy` / `isDefault` / `createdAt` / `isActive`
 * before the handler runs (`__tests__/mass-assignment.test.ts`). The handler
 * also builds its `data` field by field, so neither guard depends on the other.
 */
export const updateDashboardBody = {
  type: 'object',
  required: ['expectedUpdatedAt'],
  properties: {
    title: { type: 'string', minLength: 1, maxLength: DASHBOARD_TITLE_MAX },
    description: { type: ['string', 'null'], maxLength: DASHBOARD_DESCRIPTION_MAX },
    document: { type: 'object', additionalProperties: true },
    // The `updatedAt` the editor loaded. A save against a row that has moved on
    // since is a 409 that writes nothing.
    expectedUpdatedAt: { type: 'string', format: 'date-time' },
    ...reauthPassword,
  },
  additionalProperties: false,
} as const;

export const assignmentsBody = {
  type: 'object',
  required: ['roles', 'userIds'],
  properties: {
    roles: { type: 'array', items: { type: 'string', minLength: 1, maxLength: 50 }, maxItems: ASSIGNMENT_ROLES_MAX, uniqueItems: true },
    userIds: { type: 'array', items: { type: 'string', format: 'uuid' }, maxItems: ASSIGNMENT_USERS_MAX, uniqueItems: true },
    ...reauthPassword,
  },
  additionalProperties: false,
} as const;
