/**
 * Shared JSON Schema definitions for error responses.
 * Spread into route schema `response` objects so Fastify accepts
 * non-200 status codes in reply.code().
 */

const errorBody = {
  type: 'object' as const,
  properties: {
    error: { type: 'string' as const },
    message: { type: 'string' as const },
  },
  additionalProperties: true,
};

/** Common error response schemas keyed by HTTP status code */
export const errorResponses = {
  400: errorBody,
  401: errorBody,
  403: errorBody,
  404: errorBody,
  409: errorBody,
  413: errorBody,
  500: errorBody,
};
