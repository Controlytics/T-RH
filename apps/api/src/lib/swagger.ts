import type { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { verifyToken } from './jwt.js';

export async function registerSwagger(app: FastifyInstance) {
  await app.register(swagger, {
    openapi: {
      openapi: '3.0.3',
      info: {
        title: 'DigiLog API',
        description: `# 21 CFR Part 11 Compliant Digital Logbook — REST API

## Authentication
1. Use **POST /api/auth/login** to obtain a JWT token
2. Click **Authorize** (lock icon) and enter: \`Bearer <your-token>\`
3. All subsequent requests will include the token

## Default Credentials
- Contact your system administrator for initial credentials
- First login will require password change

## Roles & Permissions
| Role | Level | Description |
|------|-------|-------------|
| SUPER_ADMIN | 6 | Full access, actions not audited |
| ADMIN | 5 | User & config management |
| SUPERVISOR | 4 | Approval workflows |
| MAINTENANCE | 3 | Entity management |
| OPERATOR | 2 | Data entry |
| VIEWER | 1 | Read-only access |`,
        version: '1.0.0',
        contact: {
          name: 'DigiLog Support',
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
      tags: [
        { name: 'Health', description: 'Health check endpoint' },
        { name: 'Auth', description: 'Authentication — login, logout, password management, re-verification' },
        { name: 'Users', description: 'User management — CRUD, stats, enable/disable, unlock, password reset requests' },
        { name: 'Roles', description: 'Role management — CRUD, permissions, hierarchy' },
        { name: 'Config', description: 'System configuration — password policy, login security, session, datetime, branding, user ID, field IDs, action re-authentication, alarm columns, audit templates, pagination' },
        { name: 'Audit', description: 'Audit trail — immutable SHA-256 checksummed logs with filtering and integrity verification' },
        { name: 'Notifications', description: 'Notifications — role-based user alerts and badges' },
        { name: 'Notification Settings', description: 'Notification delivery settings — email (SMTP/OAuth2), SMS (AWS SNS/Twilio/Vonage), templates, delivery logs' },
        { name: 'Notification Rules', description: 'Notification rules — event-based routing with multi-channel delivery (email, SMS, in-app), recipient targeting, cooldown' },
        { name: 'Uploads', description: 'File uploads — profile photos (JPEG, PNG, GIF, WebP, max 5MB)' },
        { name: 'Backup', description: 'Database backup & restore — export (JSON, SQL, CSV, BAK), validate, and restore with SHA-256 checksum integrity' },
        { name: 'Entity Templates', description: 'Entity template management — reusable blueprints for entity types with alarm rules and checklist schemas' },
        { name: 'Entities', description: 'Entity instance management — create, configure, and operate entity instances in parent-child hierarchies' },
        { name: 'Entity Identifiers', description: 'Entity identifiers — QR, RFID, NFC, Barcode, Manual identifiers' },
        // 2026-07-03: removed 10 dead tags for subsystems torn out in Phase 6/7
        // (Data Ingestion, Rule Chains, UNS, Telemetry, Alarms, Export, Retention,
        // Connectivity, MQTT Internal, Entity Relationships) — they rendered as
        // empty categories in /docs since no route carries them anymore.
        { name: 'Help', description: 'Help articles — versioned documentation with CRUD and version history' },
        { name: 'Debug Traces', description: 'Debug traces — audited-action pipeline traces for troubleshooting' },
        { name: 'System Health', description: 'System health — request tracking, throughput stats, and system metrics' },
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
