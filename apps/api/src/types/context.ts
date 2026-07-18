/**
 * Request context passed from route handlers to services.
 * Decouples services from Fastify's request object.
 */
export interface RequestContext {
  userId: string;      // req.user.username
  userSub: string;     // req.user.sub (UUID)
  userRole: string;    // req.user.role
  ipAddress: string;   // req.ip
  userAgent?: string;  // req.headers['user-agent']
  sessionId: string;   // req.user.sessionId
  // True when the request carries the x-offline-replay header. Cycle-write
  // implementations consult this to decide whether to honor the operator-
  // supplied offlinePerformedAt or fall through to the server clock — see
  // apps/api/src/lib/offline-time-window.ts (audit 2026-05-04 fix C2).
  // Optional so test fixtures (~14 files) that synthesize RequestContext
  // literals without this field default to "online" semantics naturally.
  isOfflineReplay?: boolean;
}

