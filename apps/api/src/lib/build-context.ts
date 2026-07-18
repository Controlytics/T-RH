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
    // Audit 2026-05-04 fix C1: derive from the verified-grant flag set by
    // the auth plugin, NOT directly from the header. A request that sent
    // `x-offline-replay: true` without a valid grant has already been
    // rejected upstream — but defense in depth: if anything reaches here
    // without offlineReplayVerified, treat as online (server-clock path).
    isOfflineReplay: req.offlineReplayVerified === true,
  };
}
