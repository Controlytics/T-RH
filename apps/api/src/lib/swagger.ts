import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { verifyToken } from './jwt.js';

export async function registerSwagger(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        // Rewritten 2026-10-07: this block still described upstream DigiLog
        // (its name, a forced password change on first login, tags for
        // subsystems this fork does not have).
        title: 'T&RH-Monitoring API',
        description: `# T&RH-Monitoring — REST API

Temperature and relative-humidity monitoring under 21 CFR Part 11: instruments
and their telemetry, alarms, functional locations, floor plans, reports with
approval, and a hash-chained audit trail with electronic-signature re-authentication.

## Authentication
1. **POST /api/auth/login** with a username and password returns a JWT access token.
2. Click **Authorize** (lock icon) and paste the token. The header sent is \`Authorization: Bearer <token>\`.
3. Every request after that carries it. Sessions are single per user; a second login is refused with **409 SESSION_CONFLICT** unless it asks to end the other session.

Some write actions are configured to require **re-authentication** (an
electronic signature): the request then also sends the user's password, in the
\`x-reauth-password\` header or as \`_currentPassword\` in the body. Without it
the action is refused with **401**. Many changes also require a reason in the body.

## Access in production
On a production server this page itself needs a valid token, sent as the same
\`Authorization: Bearer <token>\` header. In development it is open.

## Credentials
Accounts are created by an administrator. There is no shipped default password:
the first super admin's password is whatever was set when the database was seeded.

## Roles and permissions
Access is decided by **permissions** granted to a role, administered under
Configuration → Roles & Access. A new database is seeded with six roles:

| Role | Level | Starts with |
|------|-------|-------------|
| SUPER_ADMIN | 6 | Everything. Still audited like every other role (§11.10(e)) |
| ADMIN | 5 | User and configuration management |
| SUPERVISOR | 4 | Approvals |
| MAINTENANCE | 3 | Instrument upkeep |
| OPERATOR | 2 | Day-to-day operation |
| VIEWER | 1 | Read-only |

Roles can be edited, added and removed, so a running installation may differ.
An endpoint outside the caller's permissions returns **403**; an instrument
outside the caller's instrument scope returns **404**.`,
        version: '1.0.0',
        contact: {
          name: 'T&RH-Monitoring support',
        },
      },
      // Relative URL: "Try it out" calls the SAME origin that served /docs.
      // Works for localhost (host) and LAN IP (remote laptop) without hardcoding
      // scheme/host — and avoids the mixed-content block when API_HTTPS=true.
      servers: [
        {
          url: '/',
          description: 'This server (same origin as the docs page)',
        },
      ],
      // One entry per tag a route actually carries (re-derived 2026-10-07 by
      // grepping `tags: [` under src/). A tag with routes but no entry here
      // still renders, just without a description; an entry with no routes
      // renders as an empty heading — `Entities` was one until this change.
      tags: [
        { name: 'Health', description: 'Liveness probe' },
        { name: 'Auth', description: 'Login, logout, token refresh, password change and reset' },
        { name: 'Authentication', description: 'Access-token refresh' },
        { name: 'Users', description: 'User accounts — create, edit, enable / disable, unlock, password reset requests' },
        { name: 'User Groups', description: 'Groups of users' },
        { name: 'Roles', description: 'Roles, their permissions, sidebar, panels, instrument scope and attribute access' },
        { name: 'LDAP', description: 'Directory (LDAP) sign-in settings' },
        { name: 'Admin Requests', description: 'Requests sent to administrators from the login page' },
        { name: 'Super Admin', description: 'Super-admin statistics and API access lock' },
        { name: 'Super Admin - Data Management', description: 'Super-admin data management' },
        { name: 'Config', description: 'System configuration — password policy, session, date/time, branding, alarm settings, report settings and the other administered settings' },
        { name: 'Configuration', description: 'Registry of administered settings and the generic read / write of each' },
        { name: 'Instruments', description: 'Instruments, their attributes and telemetry, the dashboard overview and reading history' },
        { name: 'Instrument Profiles', description: 'Device profiles and the attribute keys each asks for' },
        { name: 'Ingest', description: 'Instrument telemetry ingest (HTTP; MQTT authorisation hook)' },
        { name: 'Functional Locations', description: 'The Block > Area hierarchy instruments are grouped by' },
        { name: 'Floorplans', description: 'Drawn floor plans, rooms, doors and room links' },
        { name: 'Dashboards', description: 'Custom dashboards, their widgets and who they are assigned to' },
        { name: 'Alarms', description: 'Alarms — list, filter, acknowledge' },
        { name: 'Alarm Webhooks', description: 'Outbound alarm annunciators (hooters) and their delivery log' },
        { name: 'Report Reviews', description: 'Report requests, approval and download of the approved copy' },
        { name: 'Audit', description: 'Hash-chained audit trail — query, export log and integrity verification' },
        { name: 'Notifications', description: 'In-app notifications for the signed-in user' },
        { name: 'Notification Settings', description: 'Email and SMS delivery settings, templates and delivery logs' },
        { name: 'Notification Rules', description: 'Which events notify whom, by which channel' },
        { name: 'Uploads', description: 'File uploads — profile photos, branding images, plan images' },
        { name: 'Backup', description: 'Database backup and restore' },
        { name: 'Help', description: 'Help articles' },
        { name: 'Debug Traces', description: 'Audited-action traces for troubleshooting' },
        { name: 'System Health', description: 'Request and system metrics' },
      ],
      components: {
        securitySchemes: {
          bearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
            description: 'JWT token obtained from POST /api/auth/login. Format: Bearer <token>',
          },
        },
      },
      security: [{ bearerAuth: [] }],
    },
  });

  // Swagger UI is auth-gated in production (audit API-5).
  // In non-production the auth hook is still registered but /docs is also in
  // auth.ts PUBLIC_PATHS so the check passes via two paths — harmless.
  const isProduction = process.env.NODE_ENV === 'production';
  await app.register(swaggerUi, {
    routePrefix: '/docs',
    uiConfig: {
      docExpansion: 'list',
      deepLinking: true,
      persistAuthorization: true,
      displayRequestDuration: true,
      filter: true,
      tryItOutEnabled: true,
      syntaxHighlight: { theme: 'monokai' },
    },
    staticCSP: false,
    uiHooks: {
      onRequest: async (req: any, reply: any) => {
        if (!isProduction) return; // allow in dev without token
        const header: string | undefined = req.headers?.authorization;
        if (!header?.startsWith('Bearer ')) {
          return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Bearer token required to access API docs' });
        }
        try {
          await verifyToken(header.slice(7));
        } catch {
          return reply.code(401).send({ error: 'UNAUTHORIZED', message: 'Invalid or expired token' });
        }
      },
    },
  });
}
