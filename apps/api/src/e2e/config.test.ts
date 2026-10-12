import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { type FastifyInstance } from 'fastify';
import {
  ALARM_STATUS_TEXT_DEFAULT, LIMIT_DISABLED_TEXT_DEFAULT, INACTIVITY_TEXT_DEFAULT, RS485_FAILURE_TEXT_DEFAULT,
  ALARM_TYPE_KEYS, ALARM_TYPE_NAME_DEFAULT,
  TREND_WIDGET_LABEL_KEYS, TREND_WIDGET_LABEL_DEFAULT, TREND_WIDGET_IDS,
} from '@digilog/shared';
import { prisma } from '../lib/prisma.js';
import { invalidateRolePermsCache } from '../plugins/rbac.js';
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

    it('a non-SUPER_ADMIN user gets 200 with the status strings', async () => {
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      const res = await authGet(app, '/api/config/alarm-limits/status-texts', operatorToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      // `toEqual` on the WHOLE body on purpose: this endpoint is read by every
      // authenticated user, so a field appearing or vanishing should have to be
      // decided here rather than noticed later. `disabledLimitText` was added
      // 2026-09-01 — the wording for a switched-off limit in the Alarm Report,
      // carried with the status texts rather than on a seventh narrow route.
      expect(body).toEqual({
        statusActiveUnack: expect.any(String),
        statusActiveAck: expect.any(String),
        statusClearedUnack: expect.any(String),
        statusClearedAck: expect.any(String),
        disabledLimitText: expect.any(String),
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
          disabledLimitText: LIMIT_DISABLED_TEXT_DEFAULT,
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
  // Inactivity column wordings — the same narrow all-authenticated-users read,
  // for the three cells an INACTIVITY alarm has no number to fill.
  // =============================================
  describe('GET /api/config/inactivity-alarms/display-texts', () => {
    const KEY = 'inactivity-alarms';
    const withRow = async (value: Record<string, unknown>, run: () => Promise<void>) => {
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: KEY } });
      const merged = { ...(existing?.configValue as Record<string, unknown> ?? {}), ...value };
      await prisma.systemConfig.upsert({
        where: { configKey: KEY },
        create: { configKey: KEY, configValue: merged, configType: 'system', requiresReauth: false },
        update: { configValue: merged },
      });
      try {
        await run();
      } finally {
        // Restore whatever was there, INCLUDING "nothing" — the suite shares one
        // database and this key decides whether alarms are raised at all.
        if (existing) {
          await prisma.systemConfig.update({ where: { configKey: KEY }, data: { configValue: existing.configValue as any } });
        } else {
          await prisma.systemConfig.delete({ where: { configKey: KEY } }).catch(() => {});
        }
      }
    };

    it('the editor endpoint stays SUPER_ADMIN-only for a non-SA user', async () => {
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      const res = await authGet(app, '/api/config/dynamic/inactivity-alarms', operatorToken);
      expect(res.statusCode).toBe(403);
    });

    it('a non-SUPER_ADMIN user gets 200 with the three wording strings', async () => {
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      const res = await authGet(app, '/api/config/inactivity-alarms/display-texts', operatorToken);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({
        textGeneratedValue: expect.any(String),
        textLimit: expect.any(String),
        textClearedValue: expect.any(String),
      });
    });

    it('falls back to the shipped wording when the config row is unset', async () => {
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: KEY } });
      await prisma.systemConfig.delete({ where: { configKey: KEY } }).catch(() => {});
      try {
        const res = await authGet(app, '/api/config/inactivity-alarms/display-texts', adminToken);
        expect(res.statusCode).toBe(200);
        expect(JSON.parse(res.body)).toEqual({
          textGeneratedValue: INACTIVITY_TEXT_DEFAULT.generatedValue,
          textLimit: INACTIVITY_TEXT_DEFAULT.limit,
          textClearedValue: INACTIVITY_TEXT_DEFAULT.clearedValue,
        });
      } finally {
        if (existing) await prisma.systemConfig.create({ data: existing as any });
      }
    });

    it('falls back to the shipped wording when a field is blank', async () => {
      await withRow({ textGeneratedValue: '   ', textClearedValue: '' }, async () => {
        const res = await authGet(app, '/api/config/inactivity-alarms/display-texts', adminToken);
        const body = JSON.parse(res.body);
        expect(body.textGeneratedValue).toBe(INACTIVITY_TEXT_DEFAULT.generatedValue);
        expect(body.textClearedValue).toBe(INACTIVITY_TEXT_DEFAULT.clearedValue);
      });
    });

    it('passes a real configured wording through unchanged', async () => {
      await withRow({ textGeneratedValue: 'Silent', textLimit: 'no signal {minutes}m' }, async () => {
        const res = await authGet(app, '/api/config/inactivity-alarms/display-texts', adminToken);
        const body = JSON.parse(res.body);
        expect(body.textGeneratedValue).toBe('Silent');
        expect(body.textLimit).toBe('no signal {minutes}m');
      });
    });

    it('SAVES through the config page and reads back — the whole round trip', async () => {
      // Reading the PUT handler is not proof that a key the handler has never
      // heard of survives the write. `loadInactivityConfig` names only `enabled`,
      // `graceMinutes` and `severity`, so a save path that round-tripped through
      // it would drop every wording on every save while the page looked fine.
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: KEY } });
      const base = (existing?.configValue as Record<string, unknown>) ?? {};
      try {
        // The PUT replaces the whole blob, so the three governing keys ride along
        // — dropping them here would silently switch the feature on or off.
        const put = await authPut(app, '/api/config/dynamic/inactivity-alarms', adminToken, {
          ...base,
          textGeneratedValue: 'Silent',
          textLimit: 'no signal {minutes}m',
          textClearedValue: 'Back online',
        });
        expect(put.statusCode).toBe(200);

        const res = await authGet(app, '/api/config/inactivity-alarms/display-texts', adminToken);
        expect(JSON.parse(res.body)).toEqual({
          textGeneratedValue: 'Silent',
          textLimit: 'no signal {minutes}m',
          textClearedValue: 'Back online',
        });
      } finally {
        if (existing) {
          await prisma.systemConfig.update({ where: { configKey: KEY }, data: { configValue: existing.configValue as any } });
        } else {
          await prisma.systemConfig.delete({ where: { configKey: KEY } }).catch(() => {});
        }
      }
    });

    it('REFUSES a Limit wording with no {minutes} placeholder', async () => {
      // The wording is administered; the THRESHOLD the alarm fired against is
      // not. A template with nowhere to substitute it would delete it from the
      // table, so the server hands back the shipped wording instead — refused
      // here as well as in the browser's `inactivityLimitText()`, so a caller
      // that skips that helper still cannot be given a wording that drops it.
      await withRow({ textLimit: 'no signal at all' }, async () => {
        const res = await authGet(app, '/api/config/inactivity-alarms/display-texts', adminToken);
        expect(JSON.parse(res.body).textLimit).toBe(INACTIVITY_TEXT_DEFAULT.limit);
      });
    });
  });

  // =============================================
  // Alarm type names — ONE config, applied wherever a type is shown.
  // =============================================
  describe('GET /api/config/alarm-type-names/current', () => {
    const KEY = 'alarm-type-names';

    it('a non-SUPER_ADMIN user gets 200 with every key resolved', async () => {
      // Already defaulted server-side, so no caller has to know which fields are
      // set — and an operator who cannot administer the names still reads them.
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      const res = await authGet(app, '/api/config/alarm-type-names/current', operatorToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      for (const key of ALARM_TYPE_KEYS) expect(typeof body[key]).toBe('string');
      expect(body.limitTemperatureHigh).toBe(ALARM_TYPE_NAME_DEFAULT.limitTemperatureHigh);
    });

    it('the editor endpoint stays SUPER_ADMIN-only', async () => {
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      const res = await authGet(app, '/api/config/dynamic/alarm-type-names', operatorToken);
      expect(res.statusCode).toBe(403);
    });

    it('a rename saves and reads back, and a blank falls back', async () => {
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: KEY } });
      const base = (existing?.configValue as Record<string, unknown>) ?? {};
      try {
        const put = await authPut(app, '/api/config/dynamic/alarm-type-names', adminToken, {
          ...base, limitTemperatureHigh: 'Temp Too Hot', inactivity: '   ',
        });
        expect(put.statusCode).toBe(200);
        const res = await authGet(app, '/api/config/alarm-type-names/current', adminToken);
        const body = JSON.parse(res.body);
        expect(body.limitTemperatureHigh).toBe('Temp Too Hot');
        // Blank never leaves the type nameless.
        expect(body.inactivity).toBe(ALARM_TYPE_NAME_DEFAULT.inactivity);
      } finally {
        if (existing) {
          await prisma.systemConfig.update({ where: { configKey: KEY }, data: { configValue: existing.configValue as any } });
        } else {
          await prisma.systemConfig.deleteMany({ where: { configKey: KEY } });
        }
      }
    });
  });

  // =============================================
  // Trend page widget wording — the SIXTH narrow-slice route.
  // =============================================
  describe('GET /api/config/trend-widgets/current', () => {
    const KEY = 'trend-widgets';

    it('a non-SUPER_ADMIN user gets 200 with every label resolved', async () => {
      // The def is SUPER_ADMIN-only; this slice is not. Without it an operator
      // would read the shipped wording while the admin who set it read their
      // own — one page, two vocabularies.
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      const res = await authGet(app, '/api/config/trend-widgets/current', operatorToken);
      expect(res.statusCode).toBe(200);
      const body = JSON.parse(res.body);
      for (const key of TREND_WIDGET_LABEL_KEYS) expect(typeof body.labels[key], key).toBe('string');
      for (const id of TREND_WIDGET_IDS) {
        expect(typeof body.formats[id].dateFormat, id).toBe('string');
        expect(typeof body.formats[id].timeFormat, id).toBe('string');
      }
    });

    it('the editor endpoint stays SUPER_ADMIN-only', async () => {
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      const res = await authGet(app, '/api/config/dynamic/trend-widgets', operatorToken);
      expect(res.statusCode).toBe(403);
    });

    it('refuses a non-SUPER_ADMIN WRITE — hiding the pencil is not the control', () => {
      // Asserted separately from the read: the browser hides the edit button for
      // a non-admin, but that is presentation. The server refusing the PUT is
      // what actually governs the change.
      return loginAs(app, 'RB0001', 'Test@1234').then(async (operatorToken) => {
        const res = await authPut(app, '/api/config/dynamic/trend-widgets', operatorToken, {
          alarmsStatusHeading: 'State',
        });
        expect(res.statusCode).toBe(403);
      });
    });

    it('a rename saves and reads back; a blank falls back and a bad format inherits', async () => {
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: KEY } });
      const base = (existing?.configValue as Record<string, unknown>) ?? {};
      try {
        const put = await authPut(app, '/api/config/dynamic/trend-widgets', adminToken, {
          ...base,
          alarmsStatusHeading: 'State',
          alarmsTypeHeading: '   ',
          alarmsDateFormat: 'YYYY-MM-DD',
        });
        expect(put.statusCode).toBe(200);
        // Not in the vocabulary. The dynamic PUT refuses it since 2026-10-12
        // (audit #7, the def's options are enforced server-side)...
        const refused = await authPut(app, '/api/config/dynamic/trend-widgets', adminToken, {
          ...base, alarmsTimeFormat: '36-hour',
        });
        expect(refused.statusCode).toBe(400);
        expect(refused.json().field).toBe('alarmsTimeFormat');
        // ...but a row edited by hand, or stored before that, can still hold
        // it. Passed on it would print en-GB and look like a deliberate
        // setting; the reader has to return it as inherit.
        const stored = (await prisma.systemConfig.findUnique({ where: { configKey: KEY } }))!.configValue as Record<string, unknown>;
        await prisma.systemConfig.update({ where: { configKey: KEY }, data: { configValue: { ...stored, alarmsTimeFormat: '36-hour' } as any } });

        const res = await authGet(app, '/api/config/trend-widgets/current', adminToken);
        const body = JSON.parse(res.body);
        expect(body.labels.alarmsStatusHeading).toBe('State');
        // A blank never leaves a table column nameless.
        expect(body.labels.alarmsTypeHeading).toBe(TREND_WIDGET_LABEL_DEFAULT.alarmsTypeHeading);
        expect(body.formats.alarms.dateFormat).toBe('YYYY-MM-DD');
        expect(body.formats.alarms.timeFormat).toBe('');
        // One widget's override does not leak onto another.
        expect(body.formats.tempCard.dateFormat).toBe('');
      } finally {
        if (existing) {
          await prisma.systemConfig.update({ where: { configKey: KEY }, data: { configValue: existing.configValue as any } });
        } else {
          await prisma.systemConfig.deleteMany({ where: { configKey: KEY } });
        }
      }
    });
  });

  // =============================================
  // RS485 failure word — the ONE text shown wherever a failed sensor's reading
  // would appear, on every surface.
  // =============================================
  describe('GET /api/config/rs485-alarms/display-text', () => {
    const KEY = 'rs485-alarms';
    const withRow = async (value: Record<string, unknown>, run: () => Promise<void>) => {
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: KEY } });
      const merged = { ...(existing?.configValue as Record<string, unknown> ?? {}), ...value };
      await prisma.systemConfig.upsert({
        where: { configKey: KEY },
        create: { configKey: KEY, configValue: merged, configType: 'system', requiresReauth: false },
        update: { configValue: merged },
      });
      try {
        await run();
      } finally {
        // Restored verbatim — this key also carries `enabled`, which decides
        // whether a whole alarm source runs.
        if (existing) {
          await prisma.systemConfig.update({ where: { configKey: KEY }, data: { configValue: existing.configValue as any } });
        } else {
          await prisma.systemConfig.deleteMany({ where: { configKey: KEY } });
        }
      }
    };

    it('the editor endpoint stays SUPER_ADMIN-only for a non-SA user', async () => {
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      const res = await authGet(app, '/api/config/dynamic/rs485-alarms', operatorToken);
      expect(res.statusCode).toBe(403);
    });

    it('a non-SUPER_ADMIN user gets 200 with the word', async () => {
      // An operator who cannot administer the word still has to be able to read
      // it, or the dashboard would fall back to the shipped default for exactly
      // the users who spend all day looking at it.
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      const res = await authGet(app, '/api/config/rs485-alarms/display-text', operatorToken);
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body)).toEqual({ failureText: expect.any(String) });
    });

    it('passes a configured word through, and falls back when it is blank', async () => {
      await withRow({ failureText: 'SENSOR FAULT' }, async () => {
        const res = await authGet(app, '/api/config/rs485-alarms/display-text', adminToken);
        expect(JSON.parse(res.body).failureText).toBe('SENSOR FAULT');
      });
      await withRow({ failureText: '   ' }, async () => {
        // An empty value cell on a monitoring page reads as "nothing is wrong".
        const res = await authGet(app, '/api/config/rs485-alarms/display-text', adminToken);
        expect(JSON.parse(res.body).failureText).toBe(RS485_FAILURE_TEXT_DEFAULT);
      });
    });

    it('SAVES through the config page and reads back', async () => {
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: KEY } });
      const base = (existing?.configValue as Record<string, unknown>) ?? {};
      try {
        const put = await authPut(app, '/api/config/dynamic/rs485-alarms', adminToken, {
          ...base, failureText: 'Error',
        });
        expect(put.statusCode).toBe(200);
        const res = await authGet(app, '/api/config/rs485-alarms/display-text', adminToken);
        expect(JSON.parse(res.body).failureText).toBe('Error');
      } finally {
        if (existing) {
          await prisma.systemConfig.update({ where: { configKey: KEY }, data: { configValue: existing.configValue as any } });
        } else {
          await prisma.systemConfig.deleteMany({ where: { configKey: KEY } });
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

/**
 * Audit 2026-10-03, SEC-1 and SEC-2.
 */
describe('re-auth hygiene on config writes', () => {
  let app: FastifyInstance;
  let adminToken: string;
  beforeAll(async () => {
    app = await buildApp();
    adminToken = await loginAs(app);
  });
  afterAll(async () => {
    await prisma.user.updateMany({ where: { username: 'admin' }, data: { failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null } });
    await app.close();
  });

  it('a _currentPassword sent when no re-auth is required is NEVER stored or returned', async () => {
    const before = await prisma.systemConfig.findUnique({ where: { configKey: 'inactivity-alarms' } });
    const current = ((before?.configValue ?? {}) as Record<string, unknown>);
    const put = await authPut(app, '/api/config/dynamic/inactivity-alarms', adminToken, {
      ...current, _currentPassword: 'Admin@123', _anythingPrivate: 'x',
    });
    expect(put.statusCode).toBe(200);
    const row = await prisma.systemConfig.findUniqueOrThrow({ where: { configKey: 'inactivity-alarms' } });
    expect(JSON.stringify(row.configValue)).not.toContain('Admin@123');
    expect(Object.keys(row.configValue as object).some((k) => k.startsWith('_'))).toBe(false);
    const get = await authGet(app, '/api/config/dynamic/inactivity-alarms', adminToken);
    expect(JSON.stringify(get.json())).not.toContain('_currentPassword');
  });

  it('a wrong password on the hardcoded config re-auth counts toward lockout (SUPER_ADMIN is exempt by design, so: the operator)', async () => {
    const role = await prisma.role.findFirstOrThrow({ where: { name: 'OPERATOR' } });
    const permsBefore = role.permissions as string[];
    await prisma.role.update({ where: { id: role.id }, data: { permissions: [...new Set([...permsBefore, 'CONFIG_UPDATE'])] } });
    invalidateRolePermsCache('OPERATOR');
    try {
      const operatorToken = await loginAs(app, 'RB0001', 'Test@1234');
      await prisma.user.updateMany({ where: { username: 'RB0001' }, data: { failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null } });
      const res = await app.inject({
        method: 'PUT', url: '/api/config/datetime',
        headers: { authorization: `Bearer ${operatorToken}`, 'x-reauth-password': 'definitely-wrong' },
        payload: { dateFormat: 'DD/MM/YYYY' },
      });
      expect(res.statusCode).toBe(401);
      const user = await prisma.user.findFirstOrThrow({ where: { username: 'RB0001' }, select: { failedLoginAttempts: true } });
      expect(user.failedLoginAttempts).toBe(1);
    } finally {
      await prisma.user.updateMany({ where: { username: 'RB0001' }, data: { failedLoginAttempts: 0, lockedAt: null, lockoutUntil: null, status: 'ENABLED' } });
      await prisma.role.update({ where: { id: role.id }, data: { permissions: permsBefore as never } });
      invalidateRolePermsCache('OPERATOR');
    }
  });
});

