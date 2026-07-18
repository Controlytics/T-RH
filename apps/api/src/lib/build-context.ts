import type { FastifyRequest } from 'fastify';
import type { RequestContext } from '../types/context.js';

/**
 * Build a RequestContext from a Fastify request.
 * Used by route handlers to pass context to service methods.
 */
export function buildContext(req: FastifyRequest): RequestContext {
  return {
    userId: req.user.username,
    userSub: req.user.sub,
    userRole: req.user.role,
    ipAddress: req.ip,
    userAgent: req.headers['user-agent'],
    sessionId: req.user.sessionId,
  };
}
