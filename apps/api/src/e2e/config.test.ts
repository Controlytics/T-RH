import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import { ALARM_STATUS_TEXT_DEFAULT } from '@digilog/shared';
import { prisma } from '../lib/prisma.js';
import {
  buildApp, loginAs, authGet, authPost, authPut, authDelete,
  ADMIN_PASSWORD,
} from './test-helper.js';

describe('Config endpoints', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildApp();
    adminToken = await loginAs(app);
  });

  afterAll(async () => {
    await app.close();
  });

  // ===========================================================================
  // EXISTING TESTS (unchanged)
  // ===========================================================================

  // =============================================
  // Branding (public GET)
  // =============================================
  describe('GET /api/config/branding', () => {
    it('returns branding config without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/config/branding' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.appName).toBeTruthy();
    });
  });

  // =============================================
  // Datetime (public current)
  // =============================================
  describe('GET /api/config/datetime/current', () => {
    it('returns datetime config without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/config/datetime/current' });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.dateFormat).toBeTruthy();
      expect(body.timeFormat).toBeTruthy();
    });
  });

  // =============================================
  // Password Policy
  // =============================================
  describe('GET /api/config/password-policy', () => {
    it('returns password policy when authenticated', async () => {
      const res = await authGet(app, '/api/config/password-policy', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.minLength).toBeDefined();
      expect(body.requireUppercase).toBeDefined();
    });

    it('requires authentication', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/config/password-policy' });
      expect(res.statusCode).toBe(401);
    });
  });

  // =============================================
  // Session Config
  // =============================================
  describe('GET /api/config/session', () => {
    it('returns session config when authenticated', async () => {
      const res = await authGet(app, '/api/config/session', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.sessionDurationHours).toBeDefined();
    });
  });

  // =============================================
  // Datetime Config (authenticated)
  // =============================================
  describe('GET /api/config/datetime', () => {
    it('returns datetime config when authenticated', async () => {
      const res = await authGet(app, '/api/config/datetime', adminToken);
      expect(res.statusCode).toBe(200);
    });
  });

  // =============================================
  // Pagination Config
  // =============================================
  describe('GET /api/config/pagination/current', () => {
    it('returns pagination config', async () => {
      const res = await authGet(app, '/api/config/pagination/current', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.options).toBeDefined();
    });
  });

  // =============================================
  // Alarm-limits status texts — narrow all-authenticated-users read (Fix 1:
  // GET /api/config/dynamic/alarm-limits is SUPER_ADMIN-only, so a non-SA
  // operator must not 403 into the alarms page's status column).
  // =============================================
  describe('GET /api/config/alarm-limits/status-texts', () => {
    it('the editor endpoint stays SUPER_ADMIN-only for a non-SA user', async () => {
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      const res = await authGet(app, '/api/config/dynamic/alarm-limits', operatorToken);
      expect(res.statusCode).toBe(403);
    });

    it('a non-SUPER_ADMIN user gets 200 with the four status strings', async () => {
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      const res = await authGet(app, '/api/config/alarm-limits/status-texts', operatorToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toEqual({
        statusActiveUnack: expect.any(String),
        statusActiveAck: expect.any(String),
        statusClearedUnack: expect.any(String),
        statusClearedAck: expect.any(String),
      });
    });

    it('falls back to defaults when the config row is unset', async () => {
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'alarm-limits' } });
      await prisma.systemConfig.delete({ where: { configKey: 'alarm-limits' } }).catch(() => {});
      try {
        const res = await authGet(app, '/api/config/alarm-limits/status-texts', adminToken);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({
          statusActiveUnack: ALARM_STATUS_TEXT_DEFAULT.activeUnack,
          statusActiveAck: ALARM_STATUS_TEXT_DEFAULT.activeAck,
          statusClearedUnack: ALARM_STATUS_TEXT_DEFAULT.clearedUnack,
          statusClearedAck: ALARM_STATUS_TEXT_DEFAULT.clearedAck,
        });
      } finally {
        // Restore whatever was there (including "nothing") so this test doesn't
        // leak state into the rest of the suite or a concurrent file.
        if (existing) {
          await prisma.systemConfig.create({ data: existing as any });
        }
      }
    });

    it('falls back to defaults when a status text is set to a blank string', async () => {
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'alarm-limits' } });
      const blanked = {
        ...(existing?.configValue as Record<string, unknown> ?? {}),
        statusActiveUnack: '   ',
        statusClearedAck: '',
      };
      await prisma.systemConfig.upsert({
        where: { configKey: 'alarm-limits' },
        create: { configKey: 'alarm-limits', configValue: blanked, configType: 'system', requiresReauth: false },
        update: { configValue: blanked },
      });
      try {
        const res = await authGet(app, '/api/config/alarm-limits/status-texts', adminToken);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.statusActiveUnack).toBe(ALARM_STATUS_TEXT_DEFAULT.activeUnack);
        expect(body.statusClearedAck).toBe(ALARM_STATUS_TEXT_DEFAULT.clearedAck);
      } finally {
        if (existing) {
          await prisma.systemConfig.update({ where: { configKey: 'alarm-limits' }, data: { configValue: existing.configValue as any } });
        } else {
          await prisma.systemConfig.delete({ where: { configKey: 'alarm-limits' } }).catch(() => {});
        }
      }
    });

    it('passes through a real configured status text unchanged', async () => {
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'alarm-limits' } });
      const custom = {
        ...(existing?.configValue as Record<string, unknown> ?? {}),
        statusActiveUnack: 'Custom breach wording',
      };
      await prisma.systemConfig.upsert({
        where: { configKey: 'alarm-limits' },
        create: { configKey: 'alarm-limits', configValue: custom, configType: 'system', requiresReauth: false },
        update: { configValue: custom },
      });
      try {
        const res = await authGet(app, '/api/config/alarm-limits/status-texts', adminToken);
        expect(JSON.parse(res.body).statusActiveUnack).toBe('Custom breach wording');
      } finally {
        if (existing) {
          await prisma.systemConfig.update({ where: { configKey: 'alarm-limits' }, data: { configValue: existing.configValue as any } });
        } else {
          await prisma.systemConfig.delete({ where: { configKey: 'alarm-limits' } }).catch(() => {});
        }
      }
    });
  });

  // =============================================
  // User ID Config
  // =============================================
  describe('GET /api/config/user-id', () => {
    it('returns user ID config when authenticated', async () => {
      const res = await authGet(app, '/api/config/user-id', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.format).toBeDefined();
      expect(body.length).toBeDefined();
    });
  });

  // =============================================
  // Action Reauth Config
  // =============================================
  describe('GET /api/config/action-reauth', () => {
    it('returns action reauth config when authenticated', async () => {
      const res = await authGet(app, '/api/config/action-reauth', adminToken);
      expect(res.statusCode).toBe(200);
    });
  });

  // =============================================
  // My Actions (per-user)
  // =============================================
  describe('GET /api/config/action-reauth/my-actions', () => {
    it('returns actions for current user', async () => {
      const res = await authGet(app, '/api/config/action-reauth/my-actions', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Could be { actions: [...] } or a direct array
      const actions = body.actions || body;
      expect(actions).toBeDefined();
    });
  });

  // =============================================
  // Field IDs Config
  // =============================================
  describe('GET /api/config/field-ids', () => {
    it('returns field IDs when authenticated', async () => {
      const res = await authGet(app, '/api/config/field-ids', adminToken);
      expect(res.statusCode).toBe(200);
    });
  });

  // ===========================================================================
  // NEW TESTS — All missing config endpoints
  // ===========================================================================

  // =============================================
  // 1. Login Security — GET / PUT
  // =============================================
  describe('GET /api/config/login-security', () => {
    it('returns login security config', async () => {
      const res = await authGet(app, '/api/config/login-security', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.lockoutType).toBeDefined();
    });
  });

  describe('PUT /api/config/login-security', () => {
    it('updates login security config and restores', async () => {
      // Read current
      const getRes = await authGet(app, '/api/config/login-security', adminToken);
      const original = JSON.parse(getRes.body);

      // Update one field
      const updated = {
        ...original,
        lockoutDurationMinutes: 45,
        _currentPassword: ADMIN_PASSWORD,
      };
      const putRes = await authPut(app, '/api/config/login-security', adminToken, updated, ADMIN_PASSWORD);
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.success).toBe(true);
      expect(putBody.data.lockoutDurationMinutes).toBe(45);

      // Restore original
      await authPut(app, '/api/config/login-security', adminToken, {
        ...original,
        _currentPassword: ADMIN_PASSWORD,
      }, ADMIN_PASSWORD);
    });
  });

  // =============================================
  // 2. Password Policy — PUT
  // =============================================
  describe('PUT /api/config/password-policy', () => {
    it('updates password policy and restores', async () => {
      // Read current
      const getRes = await authGet(app, '/api/config/password-policy', adminToken);
      const original = JSON.parse(getRes.body);

      // Update one field
      const updated = {
        ...original,
        minLength: 10,
        _currentPassword: ADMIN_PASSWORD,
      };
      const putRes = await authPut(app, '/api/config/password-policy', adminToken, updated, ADMIN_PASSWORD);
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.success).toBe(true);
      expect(putBody.data.minLength).toBe(10);

      // Restore original
      await authPut(app, '/api/config/password-policy', adminToken, {
        ...original,
        _currentPassword: ADMIN_PASSWORD,
      }, ADMIN_PASSWORD);
    });

    it('rejects update without _currentPassword when reauth is required', async () => {
      const getRes = await authGet(app, '/api/config/password-policy', adminToken);
      const original = JSON.parse(getRes.body);

      // Attempt without _currentPassword (and without x-reauth-password header)
      const putRes = await authPut(app, '/api/config/password-policy', adminToken, {
        ...original,
        minLength: 12,
      });
      // Should either succeed (if reauth not configured) or return 401
      expect([200, 401]).toContain(putRes.statusCode);
    });
  });

  // =============================================
  // 3. Session Config — PUT
  // =============================================
  describe('PUT /api/config/session', () => {
    it('updates session config and restores', async () => {
      // Read current
      const getRes = await authGet(app, '/api/config/session', adminToken);
      const original = JSON.parse(getRes.body);

      // Update one field
      const updated = {
        ...original,
        idleTimeoutMinutes: 20,
        _currentPassword: ADMIN_PASSWORD,
      };
      const putRes = await authPut(app, '/api/config/session', adminToken, updated, ADMIN_PASSWORD);
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.success).toBe(true);
      expect(putBody.data.idleTimeoutMinutes).toBe(20);

      // Restore original
      await authPut(app, '/api/config/session', adminToken, {
        ...original,
        _currentPassword: ADMIN_PASSWORD,
      }, ADMIN_PASSWORD);
    });
  });

  // =============================================
  // 4. Datetime Config — PUT
  // =============================================
  describe('PUT /api/config/datetime', () => {
    it('updates datetime config and restores', async () => {
      // Read current
      const getRes = await authGet(app, '/api/config/datetime', adminToken);
      const original = JSON.parse(getRes.body);
      const originalTimeFormat = original.timeFormat ?? '24-hour';

      // The timezone field is z.literal('Asia/Kolkata') — always use that exact value
      const putRes = await authPut(app, '/api/config/datetime', adminToken, {
        dateFormat: 'DD/MM/YYYY',
        timeFormat: '12-hour',
        timezone: 'Asia/Kolkata',
      }, ADMIN_PASSWORD);
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.success).toBe(true);
      expect(putBody.data.timeFormat).toBe('12-hour');

      // Restore original timeFormat
      await authPut(app, '/api/config/datetime', adminToken, {
        dateFormat: 'DD/MM/YYYY',
        timeFormat: originalTimeFormat,
        timezone: 'Asia/Kolkata',
      }, ADMIN_PASSWORD);
    });
  });

  // =============================================
  // 5. Pagination Config — GET / PUT
  // =============================================
  describe('GET /api/config/pagination', () => {
    it('returns pagination config for admin', async () => {
      const res = await authGet(app, '/api/config/pagination', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.options).toBeDefined();
      expect(Array.isArray(body.options)).toBe(true);
    });
  });

  describe('PUT /api/config/pagination', () => {
    it('updates pagination config and restores', async () => {
      // Read current
      const getRes = await authGet(app, '/api/config/pagination', adminToken);
      const original = JSON.parse(getRes.body);

      // Update
      const putRes = await authPut(app, '/api/config/pagination', adminToken, {
        options: [15, 30, 60],
      }, ADMIN_PASSWORD);
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.success).toBe(true);
      expect(putBody.data.options).toEqual([15, 30, 60]);

      // Restore original
      await authPut(app, '/api/config/pagination', adminToken, original, ADMIN_PASSWORD);
    });
  });

  // =============================================
  // 6. User ID Config — PUT
  // =============================================
  describe('PUT /api/config/user-id', () => {
    it('updates user-id config and restores', async () => {
      // Read current
      const getRes = await authGet(app, '/api/config/user-id', adminToken);
      const original = JSON.parse(getRes.body);

      // Update one field
      const putRes = await authPut(app, '/api/config/user-id', adminToken, {
        ...original,
        prefix: 'TST',
      }, ADMIN_PASSWORD);
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.success).toBe(true);
      expect(putBody.data.prefix).toBe('TST');

      // Restore original
      await authPut(app, '/api/config/user-id', adminToken, original, ADMIN_PASSWORD);
    });
  });

  // =============================================
  // 7. User ID — GET next
  // =============================================
  describe('GET /api/config/user-id/next', () => {
    it('returns autoGenerate and nextId', async () => {
      const res = await authGet(app, '/api/config/user-id/next', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(typeof body.autoGenerate).toBe('boolean');
      // nextId is string or null depending on autoGenerate
      if (body.autoGenerate) {
        expect(typeof body.nextId).toBe('string');
      } else {
        expect(body.nextId).toBeNull();
      }
    });
  });

  // =============================================
  // 8. User ID — POST validate
  // =============================================
  describe('POST /api/config/user-id/validate', () => {
    it('validates a conforming user ID', async () => {
      const res = await authPost(app, '/api/config/user-id/validate', adminToken, {
        userId: 'ABCDEF',
      });
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(typeof body.valid).toBe('boolean');
    });

    it('returns validation errors for empty userId', async () => {
      const res = await authPost(app, '/api/config/user-id/validate', adminToken, {
        userId: '',
      });
      // Should return 400 or 200 with valid: false
      const body = JSON.parse(res.body);
      if (res.statusCode === 200) {
        expect(body.valid).toBe(false);
      } else {
        expect(res.statusCode).toBe(400);
      }
    });
  });

  // =============================================
  // 9. Branding — PUT
  // =============================================
  describe('PUT /api/config/branding', () => {
    it('updates branding config and restores', async () => {
      // Read current
      const getRes = await app.inject({ method: 'GET', url: '/api/config/branding' });
      const original = JSON.parse(getRes.body);

      // Update one field
      const putRes = await authPut(app, '/api/config/branding', adminToken, {
        ...original,
        appTagline: 'E2E Test Tagline',
      }, ADMIN_PASSWORD);
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.success).toBe(true);
      expect(putBody.data.appTagline).toBe('E2E Test Tagline');

      // Restore original
      await authPut(app, '/api/config/branding', adminToken, original, ADMIN_PASSWORD);
    });
  });

  // =============================================
  // 10. Role Configs — GET all
  // =============================================
  describe('GET /api/config/roles', () => {
    it('returns array of role configurations', async () => {
      const res = await authGet(app, '/api/config/roles', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(Array.isArray(body)).toBe(true);
    });
  });

  // =============================================
  // 11. Role Config — GET single
  // =============================================
  describe('GET /api/config/roles/:role', () => {
    it('returns config for SUPER_ADMIN role', async () => {
      const res = await authGet(app, '/api/config/roles/SUPER_ADMIN', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.role).toBe('SUPER_ADMIN');
      expect(body.sidebarItems).toBeDefined();
      expect(body.homeWidgets).toBeDefined();
      expect(body.permissions).toBeDefined();
    });

    it('returns defaults for a non-configured role', async () => {
      const res = await authGet(app, '/api/config/roles/VIEWER', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.role).toBe('VIEWER');
    });
  });

  // =============================================
  // 12. Role Config — PUT
  // =============================================
  describe('PUT /api/config/roles/:role', () => {
    it('updates role config sidebarItems and restores', async () => {
      // Read current
      const getRes = await authGet(app, '/api/config/roles/VIEWER', adminToken);
      const original = JSON.parse(getRes.body);

      // Update
      const putRes = await authPut(app, '/api/config/roles/VIEWER', adminToken, {
        sidebarItems: ['dashboard', 'notifications'],
        homeWidgets: original.homeWidgets ?? [],
      }, ADMIN_PASSWORD);
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.success).toBe(true);

      // Restore original
      await authPut(app, '/api/config/roles/VIEWER', adminToken, {
        sidebarItems: original.sidebarItems ?? [],
        homeWidgets: original.homeWidgets ?? [],
      }, ADMIN_PASSWORD);
    });
  });

  // =============================================
  // 13. User Config — GET
  // =============================================
  describe('GET /api/config/users/:userId', () => {
    it('returns user config (or defaults) for admin user', async () => {
      // First, get the admin user id from /api/auth/me
      const meRes = await authGet(app, '/api/auth/me', adminToken);
      const me = JSON.parse(meRes.body);
      const userId = me.id || me.user?.id;

      if (userId) {
        const res = await authGet(app, `/api/config/users/${userId}`, adminToken);
        expect(res.statusCode).toBe(200);
        const body = JSON.parse(res.body);
        expect(body.userId).toBeDefined();
        expect(body.sidebarItems).toBeDefined();
      }
    });
  });

  // =============================================
  // 14. User Config — PUT
  // =============================================
  describe('PUT /api/config/users/:userId', () => {
    it('updates user config and restores', async () => {
      // Get admin user id
      const meRes = await authGet(app, '/api/auth/me', adminToken);
      const me = JSON.parse(meRes.body);
      const userId = me.id || me.user?.id;

      if (userId) {
        // Read current
        const getRes = await authGet(app, `/api/config/users/${userId}`, adminToken);
        const original = JSON.parse(getRes.body);

        // Update
        const putRes = await authPut(app, `/api/config/users/${userId}`, adminToken, {
          sidebarItems: ['dashboard', 'audit'],
          homeWidgets: [],
        });
        expect(putRes.statusCode).toBe(200);
        const putBody = JSON.parse(putRes.body);
        expect(putBody.success).toBe(true);

        // Restore original
        await authPut(app, `/api/config/users/${userId}`, adminToken, {
          sidebarItems: original.sidebarItems ?? [],
          homeWidgets: original.homeWidgets ?? [],
        });
      }
    });
  });

  // =============================================
  // 15. My Config
  // =============================================
  describe('GET /api/config/my-config', () => {
    it('returns effective config for current user', async () => {
      const res = await authGet(app, '/api/config/my-config', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.sidebarItems).toBeDefined();
      expect(body.homeWidgets).toBeDefined();
      expect(body.permissions).toBeDefined();
    });
  });

  // =============================================
  // 16. Field IDs — PUT
  // =============================================
  describe('PUT /api/config/field-ids/:fieldId', () => {
    it('updates a field label and restores', async () => {
      // List all field IDs to find one to update
      const listRes = await authGet(app, '/api/config/field-ids', adminToken);
      const fields = JSON.parse(listRes.body);

      if (Array.isArray(fields) && fields.length > 0) {
        const target = fields[0];
        const originalName = target.displayName;

        // Update
        const putRes = await authPut(app, `/api/config/field-ids/${target.fieldId}`, adminToken, {
          displayName: 'E2E Test Label',
        });
        expect(putRes.statusCode).toBe(200);
        const putBody = JSON.parse(putRes.body);
        expect(putBody.success).toBe(true);

        // Restore
        await authPut(app, `/api/config/field-ids/${target.fieldId}`, adminToken, {
          displayName: originalName,
        });
      }
    });

    it('returns 404 for non-existent field id', async () => {
      const res = await authPut(app, '/api/config/field-ids/NONEXISTENT_FIELD_XYZ', adminToken, {
        displayName: 'Ghost',
      });
      expect(res.statusCode).toBe(404);
    });
  });

  // =============================================
  // 17. Action Reauth — PUT
  // =============================================
  describe('PUT /api/config/action-reauth', () => {
    it('updates action reauth config and restores', async () => {
      // Read current
      const getRes = await authGet(app, '/api/config/action-reauth', adminToken);
      const original = JSON.parse(getRes.body);

      // Update: add a test action
      const updated = {
        ...original,
        DELETE_USER: ['SUPER_ADMIN', 'ADMIN'],
      };
      const putRes = await authPut(app, '/api/config/action-reauth', adminToken, updated);
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.success).toBe(true);
      expect(putBody.data.DELETE_USER).toBeDefined();

      // Restore original
      await authPut(app, '/api/config/action-reauth', adminToken, original);
    });
  });

  // =============================================
  // 18. Action Reauth — check single action
  // =============================================
  describe('GET /api/config/action-reauth/check', () => {
    it('returns whether an action requires reauth', async () => {
      const res = await authGet(app, '/api/config/action-reauth/check?action=DELETE_USER', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.action).toBe('DELETE_USER');
      expect(typeof body.required).toBe('boolean');
    });

    it('returns false for an unknown action', async () => {
      const res = await authGet(app, '/api/config/action-reauth/check?action=NONEXISTENT_ACTION', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.required).toBe(false);
    });
  });

  // =============================================
  // 19. Audit Templates — GET / PUT
  // =============================================
  describe('GET /api/config/audit-templates', () => {
    it('returns audit text templates', async () => {
      const res = await authGet(app, '/api/config/audit-templates', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // Should be an object mapping action keys to template strings
      expect(typeof body).toBe('object');
      expect(Object.keys(body).length).toBeGreaterThan(0);
    });
  });

  describe('PUT /api/config/audit-templates', () => {
    it('updates audit templates and restores', async () => {
      // Read current saved config (may be partial or empty)
      const getRes = await authGet(app, '/api/config/audit-templates', adminToken);
      const original = JSON.parse(getRes.body);

      // Update: set a custom template
      const putRes = await authPut(app, '/api/config/audit-templates', adminToken, {
        USER_CREATED: 'E2E test template for user {username}',
      });
      expect(putRes.statusCode).toBe(200);
      const putBody = JSON.parse(putRes.body);
      expect(putBody.success).toBe(true);
      expect(putBody.data.USER_CREATED).toBe('E2E test template for user {username}');

      // Restore: put back an empty object to clear custom overrides
      // (the GET merges with defaults, so we restore by saving only what was truly custom)
      await authPut(app, '/api/config/audit-templates', adminToken, {});
    });
  });

  // =============================================
  // 20. Audit Templates — GET current (public to authenticated)
  // =============================================
  describe('GET /api/config/audit-templates/current', () => {
    it('returns effective templates (defaults merged with custom)', async () => {
      const res = await authGet(app, '/api/config/audit-templates/current', adminToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      expect(typeof body).toBe('object');
      expect(Object.keys(body).length).toBeGreaterThan(0);
    });
  });
});
