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
}

