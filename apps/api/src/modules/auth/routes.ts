import { type FastifyInstance } from 'fastify';
import { loginSchema, passwordChangeSchema } from '@digilog/shared';
import { errorResponses } from '../../lib/error-schemas.js';
import { AppError } from '../../lib/errors.js';
import { authService } from './auth.service.js';
import { prisma } from '../../lib/prisma.js';
import { signToken } from '../../lib/jwt.js';
import { enforceReauth } from '../../lib/reauth-check.js';
import { signOfflineReplayToken } from '../../lib/offline-replay-token.js';

export default async function authRoutes(app: FastifyInstance) {
  // POST /api/auth/login
  app.post('/login', {
    // Audit API-6: tight per-route bodyLimit — 4 KB is plenty for username+password JSON
    bodyLimit: 4096,
    config: {
      rateLimit: {
        max: 10,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => req.ip,
      },
    },
    schema: {
      tags: ['Auth'],
      summary: 'Login',
      description: 'Authenticate with username and password. Returns JWT token.',
      security: [],
      body: {
        type: 'object',
        required: ['username', 'password'],
        properties: {
          username: { type: 'string', example: 'your-username' },
          password: { type: 'string', example: 'your-password' },
          force: { type: 'boolean', description: 'Force login by terminating existing sessions' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            token: { type: 'string' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                username: { type: 'string' },
                fullName: { type: 'string' },
                role: { type: 'string' },
                forcePasswordChange: { type: 'boolean' },
                isTemporaryPassword: { type: 'boolean' },
              },
            },
            expiresIn: { type: 'string' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    try {
      return await authService.login(parsed.data.username, parsed.data.password, req.ip, req.headers['user-agent'], parsed.data.force);
    } catch (err) {
      // Special handling for session conflicts — include activeSession details
      if (err instanceof AppError && (err.code === 'SESSION_CONFLICT' || err.code === 'DIFFERENT_USER_SESSION_CONFLICT')) {
        return reply.code(err.statusCode).send({
          error: err.code, message: err.message, activeSession: (err as any).activeSession,
        });
      }
      // Audit API-2: attemptsRemaining block removed — field no longer sent in response
      throw err; // global error handler handles all other AppErrors
    }
  });

  // POST /api/auth/logout
  app.post('/logout', {
    schema: {
      tags: ['Auth'],
      summary: 'Logout',
      description: 'Terminate the current session. Optional body { reason } distinguishes a manual logout from an idle auto-logout in the audit trail.',
      body: {
        type: 'object',
        properties: { reason: { type: 'string', enum: ['manual', 'idle_timeout'] } },
        additionalProperties: false,
      },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } } },
    },
  }, async (req) => {
    const reason = (req.body as { reason?: string } | undefined)?.reason === 'idle_timeout' ? 'idle_timeout' : 'manual';
    await authService.logout(req.user.sessionId, req.user.username, req.user.role, req.ip, req.headers['user-agent'], reason);
    return { success: true };
  });


  // POST /api/auth/refresh — Refresh JWT token (extends session)
  app.post('/refresh', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    schema: {
      tags: ['Authentication'],
      summary: 'Refresh JWT token',
      description: 'Issue a new JWT token if the current session is still valid. Call this periodically to prevent token expiry.',
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string' },
            expiresIn: { type: 'string' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // req.user is already set by auth plugin (token was valid when this request started)
    const session = await prisma.session.findFirst({
      where: { id: req.user.sessionId, isActive: true },
    });
    if (!session) {
      return reply.code(401).send({ error: 'SESSION_INVALID', message: 'Session terminated' });
    }

    // Get session duration from config
    const sessionCfg = await prisma.systemConfig.findUnique({ where: { configKey: 'session' } });
    const durationHours = (sessionCfg?.configValue as any)?.sessionDurationHours ?? 8;

    // Read current user from DB to get latest role (in case it was changed by an admin)
    const currentUser = await prisma.user.findUnique({ where: { id: req.user.sub }, select: { role: true, username: true, status: true } });
    if (!currentUser || currentUser.status !== 'ENABLED') {
      return reply.code(401).send({ error: 'ACCOUNT_INACTIVE', message: 'Account is not active' });
    }

    // Issue a new token with fresh expiry and current role from DB
    const newToken = await signToken({
      sub: req.user.sub,
      username: currentUser.username,
      role: currentUser.role,
      sessionId: req.user.sessionId,
    }, durationHours);

    return { token: newToken, expiresIn: `${durationHours}h` };
  });

  // POST /api/auth/beacon-logout — unauthenticated, accepts token in body
  // Used by navigator.sendBeacon() on tab/browser close
  app.post('/beacon-logout', {
    schema: {
      tags: ['Auth'],
      summary: 'Beacon logout',
      description: 'Terminate session via sendBeacon on tab/browser close. Token sent in body since sendBeacon cannot set Authorization headers.',
      security: [],
      body: {
        type: 'object',
        required: ['token'],
        properties: {
          token: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { token } = req.body as { token: string };
    if (!token) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', message: 'Token is required' });
    }

    await authService.beaconLogout(token, req.ip, req.headers['user-agent']);
    return { success: true };
  });

  // GET /api/auth/me
  app.get('/me', {
    schema: {
      tags: ['Auth'],
      summary: 'Get current user',
      description: 'Returns the authenticated user profile',
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            username: { type: 'string' },
            fullName: { type: 'string' },
            email: { type: 'string' },
            department: { type: 'string', nullable: true },
            photoUrl: { type: 'string', nullable: true },
            role: { type: 'string' },
            status: { type: 'string' },
            forcePasswordChange: { type: 'boolean' },
            isTemporaryPassword: { type: 'boolean' },
            lastLogin: { type: 'string', nullable: true, format: 'date-time' },
            createdAt: { type: 'string', format: 'date-time' },
            permissions: { type: 'array', items: { type: 'string' } },
            scope: { type: 'string', nullable: true },
          },
        },
      },
    },
  }, async (req) => {
    return authService.getProfile(req.user.sub);
  });

  // PUT /api/auth/profile - Update own profile
  app.put('/profile', {
    schema: {
      tags: ['Auth'],
      summary: 'Update profile',
      description: 'Update the authenticated user\'s own profile',
      body: {
        type: 'object',
        properties: {
          fullName: { type: 'string', minLength: 2, maxLength: 100 },
          email: { type: 'string', format: 'email' },
          department: { type: 'string' },
          photoUrl: { type: 'string' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            username: { type: 'string' },
            fullName: { type: 'string' },
            email: { type: 'string' },
            department: { type: 'string', nullable: true },
            photoUrl: { type: 'string', nullable: true },
            role: { type: 'string' },
          },
          additionalProperties: true,
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    // H1 fix: gate self-profile updates behind reauth so a stolen JWT alone
    // cannot rewrite the user's email/photo to an attacker-controlled value.
    // The change-password endpoint is a separate flow with its own current-
    // password check; UPDATE_PROFILE is a distinct action so audit trails
    // can distinguish "user updated their profile" from "user changed password".
    const { ok } = await enforceReauth('UPDATE_PROFILE', req, reply);
    if (!ok) return;

    const body = req.body as { fullName?: string; email?: string; department?: string; photoUrl?: string };
    return authService.updateProfile(req.user.sub, body, req.ip, req.headers['user-agent'], req.user.sessionId);
  });

  // POST /api/auth/change-password
  app.post('/change-password', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    schema: {
      tags: ['Auth'],
      summary: 'Change password',
      description: 'Change the authenticated user\'s password. Validates against password policy.',
      body: {
        type: 'object',
        required: ['newPassword', 'confirmPassword'],
        properties: {
          currentPassword: { type: 'string', description: 'Required unless temporary password' },
          newPassword: { type: 'string', minLength: 8 },
          confirmPassword: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const parsed = passwordChangeSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'VALIDATION_ERROR', details: parsed.error.flatten() });
    }

    const { currentPassword, newPassword } = parsed.data;
    await authService.changePassword(req.user.sub, currentPassword, newPassword, req.ip, req.headers['user-agent'], req.user.sessionId);
    return { success: true, message: 'Password changed successfully' };
  });

  // POST /api/auth/verify (re-authentication for sensitive ops)
  app.post('/verify', {
    config: {
      rateLimit: {
        max: 5,
        timeWindow: '1 minute',
        keyGenerator: (req: any) => req.ip,
      },
    },
    schema: {
      tags: ['Auth'],
      summary: 'Re-authenticate',
      description: 'Re-verify password for sensitive operations. Returns a 5-min verification token.',
      body: {
        type: 'object',
        required: ['password'],
        properties: { password: { type: 'string' } },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, verificationToken: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const body = req.body as { password?: string };
    if (!body.password) {
      return reply.code(400).send({ error: 'VALIDATION', message: 'Password is required' });
    }

    const verificationToken = await authService.verify(req.user.sub, body.password, req.ip, req.headers['user-agent']);
    return { success: true, verificationToken };
  });

  // POST /api/auth/forgot-password (public endpoint for password reset requests)
  app.post('/forgot-password', {
    config: {
      skipAuth: true,
      rateLimit: {
        max: 3,
        timeWindow: '15 minutes',
        keyGenerator: (req: any) => req.ip,
      },
    },
    schema: {
      tags: ['Auth'],
      summary: 'Forgot password',
      description: 'Submit a password reset request. Always returns success to prevent user enumeration.',
      security: [],
      body: {
        type: 'object',
        required: ['username'],
        properties: { username: { type: 'string' } },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const body = req.body as { username?: string };
    if (!body.username) {
      return reply.code(400).send({ error: 'VALIDATION', message: 'User ID is required' });
    }

    // Always return the SAME generic message — a differential response (the old
    // distinct "already pending" branch) let an attacker enumerate usernames by
    // submitting twice, defeating this endpoint's own anti-enumeration goal.
    // Server-side dedup still happens inside forgotPassword().
    await authService.forgotPassword(body.username, req.ip, req.headers['user-agent']);
    return { success: true, message: 'If the user ID exists, a password reset request has been submitted.' };
  });

  // POST /api/auth/offline-grant — audit 2026-05-04 fix C1.
  //
  // Issue an HMAC-signed offline-replay grant token. Replaces the previous
  // unauthenticated `x-offline-replay: true` header. The grant proves that:
  //   - the holder is the named user (token sub == JWT sub)
  //   - the holder owned the password at issuance time (verified inline below)
  //   - the holder was on this session (token sid == JWT sessionId)
  // Default lifetime: 24h. Tablets fetch one at login (or on first transition
  // to offline mode) and present it on every replay call as
  // `x-offline-replay-token: <token>`.
  //
  // The password verify here is HARD-CODED (not configurable via the
  // action-reauth registry). The grant token IS the offline-mode auth proof —
  // if operators could disable the password check on grant issuance, the
  // entire C1 fix collapses (anyone with a JWT could mint grants). All the
  // configurable per-action reauth gates (RETIRE_FILTER etc.) accept the
  // grant via plugins/auth.ts in offline-replay mode; the grant endpoint
  // itself must hold its line.
  //
  // Audit row records the grant issuance with action GRANT_OFFLINE_REPLAY
  // for the audit trail (who minted what grant when, from which session/IP).
  // The legacy `x-offline-replay: true` header is now rejected upstream in
  // plugins/auth.ts.
  app.post('/offline-grant', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    schema: {
      tags: ['Auth'],
      summary: 'Issue offline-replay grant',
      description: 'Issue a signed offline-replay grant token. Required to replay queued offline operations after this branch. Bound to the calling user + session. Always requires the current password (sent in body field _currentPassword OR header x-reauth-password) — not configurable via the action-reauth registry.',
      body: {
        type: 'object',
        properties: {
          _currentPassword: { type: 'string', description: 'Current password (or send via x-reauth-password header).' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Send back as `x-offline-replay-token` header on replay.' },
            expiresAt: { type: 'string', format: 'date-time' },
          },
        },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const body = req.body as Record<string, unknown> | undefined;
    const password = (body?._currentPassword as string)
      ?? (req.headers['x-reauth-password'] as string);
    if (!password) {
      return reply.code(401).send({
        error: 'PASSWORD_REQUIRED',
        message: 'Current password is required to issue an offline-replay grant.',
      });
    }
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user) {
      return reply.code(401).send({ error: 'USER_NOT_FOUND', message: 'User not found.' });
    }
    const { verifyPassword } = await import('../../lib/password.js');
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      // Password guesses here count toward the SAME lockout as login/reauth, so a
      // stolen-session holder can't use this endpoint as a non-locking brute-force oracle.
      const { applyFailedPasswordAttempt } = await import('./auth.service.js');
      const { locked } = await applyFailedPasswordAttempt(user, req.ip, req.headers['user-agent']);
      if (locked) {
        return reply.code(403).send({
          error: 'ACCOUNT_LOCKED',
          message: 'Account locked due to multiple failed attempts. Contact administrator.',
        });
      }
      return reply.code(401).send({
        error: 'REAUTH_FAILED',
        message: 'Incorrect password. Please try again.',
      });
    }
    // Successful proof clears the consecutive-failure streak (guarded write).
    if (user.failedLoginAttempts > 0) {
      await prisma.user.update({ where: { id: user.id }, data: { failedLoginAttempts: 0 } });
    }

    const grant = await signOfflineReplayToken(req.user.sub, req.user.sessionId);

    // Audit grant issuance for traceability.
    const { auditLog } = await import('../../lib/audit.js');
    await auditLog({
      userId: req.user.username,
      userRole: req.user.role,
      action: 'GRANT_OFFLINE_REPLAY',
      targetType: 'session',
      targetId: req.user.sessionId,
      afterValue: { expiresAt: grant.expiresAt.toISOString() },
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
      sessionId: req.user.sessionId,
    });

    return { token: grant.token, expiresAt: grant.expiresAt.toISOString() };
  });
}
