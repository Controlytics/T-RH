/**
 * Notification Delivery Routes — API endpoints for email/SMS configuration,
 * sending test notifications, and querying delivery logs.
 */

import { type FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { errorResponses } from '../../lib/error-schemas.js';
import { buildContext } from '../../lib/build-context.js';
import { prisma } from '../../lib/prisma.js';
import { invalidateNotificationConfigCache } from './config-loader.js';
import { sendNotification, sendTestNotification, testChannel } from './delivery.service.js';
import { auditLog } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import { maskSecrets } from '../../lib/mask-secrets.js';

// HTML-escape any value reflected into the OAuth2 callback HTML responses
// (the provider-controlled error / error_description / token-exchange message
// are otherwise a reflected-XSS vector — audit H-4).
const escapeHtml = (s: unknown): string =>
  String(s ?? '').replace(/[&<>"']/g, (c) => (({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string));
import { enforceReauth } from '../../lib/reauth-check.js';

const MASK = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';

// Audit allowlists \u2014 keys whose values are safe to persist into the immutable,
// hash-chained audit trail. Anything absent is redacted (see lib/mask-secrets.ts
// for why this is an allowlist). The PUT handlers below rehydrate the REAL stored
// secrets into `body` whenever the client echoes a mask sentinel, so the body
// reaching auditLog carries live credentials on essentially every save.
const EMAIL_AUDIT_SAFE_KEYS = [
  'host', 'port', 'secure', 'username', 'fromEmail', 'fromName', 'enabled',
  // Security-relevant and non-secret — an inspector should be able to see WHEN
  // someone turned certificate verification off.
  'tlsRejectUnauthorized',
  // OAuth2 identifiers are public halves of the credential pair, not secrets.
  'oauth2Provider', 'clientId', 'providerTenantId', 'oauth2Configured',
];
const SMS_AUDIT_SAFE_KEYS = [
  'provider', 'enabled', 'defaultCountryCode', 'senderId',
  // Twilio SID / Vonage key are public identifiers; their paired tokens are not.
  'twilioAccountSid', 'twilioFromNumber', 'vonageApiKey', 'vonageFromNumber',
  'httpGatewayMethod', 'httpGatewaySuccessRegex',
  // Deliberately absent: httpGatewayUrl + httpGatewayBodyTemplate. Both are
  // operator-authored free text and the common SMS gateways (MSG91, Plivo,
  // Kaleyra) embed the API key directly in the query string / body template.
];

export default async function notificationDeliveryRoutes(app: FastifyInstance) {

  // ====== Email Configuration ======

  app.get('/email', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Get email (SMTP) configuration',
      description: 'Retrieve the current SMTP email configuration. Password is masked.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    const config = await prisma.systemConfig.findUnique({ where: { configKey: 'notification-email' } });
    const value = (config?.configValue ?? {}) as Record<string, unknown>;
    if (value.password) value.password = MASK;
    if (value.clientSecret) value.clientSecret = MASK;
    // Don't leak OAuth2 tokens to frontend
    delete value.accessToken;
    delete value.tokenExpiresAt;
    if (value.refreshToken) value.refreshToken = MASK;
    // #low-batch (CSRF): the pending OAuth2 `state` is a server-only anti-forgery
    // secret — never expose it on read, or a CONFIG_READ user could read the live
    // state and forge the callback, defeating the very protection it provides.
    delete value.oauth2PendingState;
    delete value.oauth2PendingStateAt;
    return value;
  });

  app.put('/email', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Update email (SMTP) configuration',
      description: 'Configure SMTP settings for sending email notifications.',
      body: {
        type: 'object',
        properties: {
          host: { type: 'string', description: 'SMTP host (e.g. smtp.gmail.com)' },
          port: { type: 'integer', description: 'SMTP port (587 for TLS, 465 for SSL)' },
          secure: { type: 'boolean', description: 'Use SSL/TLS (true for port 465)' },
          tlsRejectUnauthorized: {
            type: 'boolean',
            description: "Verify the SMTP server's TLS certificate. Defaults to true. Set false ONLY for an internal mail server with a self-signed certificate — disabling it lets an on-path attacker present a forged certificate and capture the SMTP credentials and all outbound mail.",
          },
          username: { type: 'string', description: 'SMTP username / email' },
          password: { type: 'string', description: 'SMTP password or app-specific password' },
          fromEmail: { type: 'string', description: 'Sender email address' },
          fromName: { type: 'string', description: 'Sender display name' },
          enabled: { type: 'boolean', description: 'Enable/disable email notifications' },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_EMAIL_CONFIG', req, reply);
    if (!ok) return;

    const body = req.body as Record<string, unknown>;
    const ctx = buildContext(req);

    // Preserve masked secrets — don't overwrite with bullet characters
    const secretFields = ['password', 'clientSecret', 'refreshToken'];
    const hasMaskedSecret = secretFields.some(f => body[f] === MASK);
    if (hasMaskedSecret) {
      const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'notification-email' } });
      const existingValue = (existing?.configValue ?? {}) as Record<string, unknown>;
      for (const field of secretFields) {
        if (body[field] === MASK) {
          body[field] = existingValue[field];
        }
      }
      // Also preserve OAuth2 tokens that frontend doesn't send
      for (const tokenField of ['accessToken', 'refreshToken', 'tokenExpiresAt', 'oauth2Configured']) {
        if (existingValue[tokenField] !== undefined && body[tokenField] === undefined) {
          body[tokenField] = existingValue[tokenField];
        }
      }
    }

    await prisma.systemConfig.upsert({
      where: { configKey: 'notification-email' },
      update: { configValue: body as any, updatedBy: ctx.userId },
      create: { configKey: 'notification-email', configValue: body as any, configType: 'notification', requiresReauth: false, updatedBy: ctx.userId },
    });

    invalidateNotificationConfigCache();
    await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'UPDATE_EMAIL_CONFIG', targetType: 'system_config', targetId: 'notification-email', afterValue: maskSecrets(body, EMAIL_AUDIT_SAFE_KEYS) });
    return { success: true };
  });

  app.post('/email/test', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Test email configuration',
      description: 'Verify SMTP connection and optionally send a test email.',
      body: {
        type: 'object',
        properties: { recipient: { type: 'string', description: 'Email to send test to (optional)' } },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, error: { type: 'string' } } },
      },
    },
  }, async (req) => {
    const { recipient } = (req.body ?? {}) as { recipient?: string };
    if (recipient) {
      const result = await sendTestNotification('EMAIL', recipient);
      return { success: result.success, message: result.success ? `Test email sent to ${recipient}` : undefined, error: result.error };
    }
    const result = await testChannel('EMAIL');
    return { success: result.success, message: result.success ? 'SMTP connection verified successfully' : undefined, error: result.error };
  });


  // ====== OAuth2 Authorization Code Flow ======

  // GET /api/notification-settings/email/oauth2/redirect-uri
  app.get('/email/oauth2/redirect-uri', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Get OAuth2 redirect URI',
      description: 'Returns the redirect URI to configure in Azure AD / Google app registration.',
      response: { 200: { type: 'object', properties: { redirectUri: { type: 'string' } } } },
    },
  }, async (req) => {
    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const redirectUri = `${proto}://${host}/api/notification-settings/email/oauth2/code`;
    return { redirectUri };
  });

  // GET /api/notification-settings/email/oauth2/authorize
  app.get('/email/oauth2/authorize', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Get OAuth2 authorization URL',
      description: 'Returns the URL to redirect the user to for OAuth2 authorization.',
      response: { 200: { type: 'object', properties: { authUrl: { type: 'string' } } } },
    },
  }, async (req) => {
    const config = await prisma.systemConfig.findUnique({ where: { configKey: 'notification-email' } });
    const value = (config?.configValue ?? {}) as Record<string, unknown>;

    const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
    const proto = req.headers['x-forwarded-proto'] || 'http';
    const redirectUri = `${proto}://${host}/api/notification-settings/email/oauth2/code`;

    const provider = String(value.oauth2Provider ?? 'microsoft');
    const clientId = String(value.clientId ?? '');
    const tenantId = String(value.providerTenantId ?? 'common');

    if (!clientId) {
      return { authUrl: '' };
    }

    // #low-batch (CSRF, RFC 6749 §10.12): mint an unpredictable `state`, persist it
    // server-side (only this authenticated CONFIG_UPDATE admin can set it), and echo
    // it in the auth URL. The callback verifies it before exchanging the code, so an
    // attacker-initiated code (carrying THEIR state) can't link their mailbox.
    const state = randomUUID();
    await prisma.systemConfig.update({
      where: { configKey: 'notification-email' },
      data: { configValue: { ...value, oauth2PendingState: state, oauth2PendingStateAt: Date.now() } as any },
    });

    let authUrl = '';
    if (provider === 'microsoft' || provider === 'office365') {
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: 'offline_access https://outlook.office365.com/SMTP.Send',
        response_mode: 'query',
        prompt: 'consent',
        state,
      });
      authUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
    } else if (provider === 'google') {
      const params = new URLSearchParams({
        client_id: clientId,
        response_type: 'code',
        redirect_uri: redirectUri,
        scope: 'https://mail.google.com/',
        access_type: 'offline',
        prompt: 'consent',
        state,
      });
      authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;
    }

    return { authUrl };
  });

  // GET /api/notification-settings/email/oauth2/code — OAuth2 callback (receives auth code)
  app.get('/email/oauth2/code', {
    schema: {
      tags: ['Notification Settings'],
      summary: 'OAuth2 callback endpoint',
      description: 'Handles the OAuth2 authorization code callback. Exchanges code for tokens.',
      querystring: {
        type: 'object',
        properties: {
          code: { type: 'string' },
          error: { type: 'string' },
          error_description: { type: 'string' },
          state: { type: 'string' },
        },
      },
    },
  }, async (req, reply) => {
    const query = req.query as { code?: string; error?: string; error_description?: string; state?: string };

    if (query.error) {
      return reply.type('text/html').send(`<html><body><h2>OAuth2 Error</h2><p>${escapeHtml(query.error)}: ${escapeHtml(query.error_description ?? '')}</p><script>window.close();</script></body></html>`);
    }

    if (!query.code) {
      return reply.type('text/html').send('<html><body><h2>Error</h2><p>No authorization code received.</p><script>window.close();</script></body></html>');
    }

    try {
      const config = await prisma.systemConfig.findUnique({ where: { configKey: 'notification-email' } });
      const value = (config?.configValue ?? {}) as Record<string, unknown>;

      // #low-batch (CSRF): verify the `state` echoed by the provider matches the
      // one this server minted in /authorize (unpredictable, admin-set, one-time,
      // 10-min TTL). Without this an attacker could feed the admin a code bound to
      // the ATTACKER's mailbox and hijack outbound notification email. Reject BEFORE
      // any token exchange.
      const storedState = String(value.oauth2PendingState ?? '');
      const storedStateAt = Number(value.oauth2PendingStateAt ?? 0);
      const STATE_TTL_MS = 10 * 60 * 1000;
      if (!query.state || !storedState || query.state !== storedState || Date.now() - storedStateAt > STATE_TTL_MS) {
        return reply.type('text/html').send('<html><body><h2>Authorization Error</h2><p>Invalid or expired authorization state. Please restart the connection from the notification settings page.</p><script>window.close();</script></body></html>');
      }

      const host = req.headers['x-forwarded-host'] || req.headers.host || 'localhost:3000';
      const proto = req.headers['x-forwarded-proto'] || 'http';
      const redirectUri = `${proto}://${host}/api/notification-settings/email/oauth2/code`;

      const provider = String(value.oauth2Provider ?? 'microsoft');
      const clientId = String(value.clientId ?? '');
      const clientSecret = String(value.clientSecret ?? '');
      const tenantId = String(value.providerTenantId ?? 'common');

      let tokenUrl = '';
      let body: URLSearchParams;

      if (provider === 'microsoft' || provider === 'office365') {
        tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
        body = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: query.code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
          scope: 'offline_access https://outlook.office365.com/SMTP.Send',
        });
      } else {
        // Google
        tokenUrl = 'https://oauth2.googleapis.com/token';
        body = new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          code: query.code,
          redirect_uri: redirectUri,
          grant_type: 'authorization_code',
        });
      }

      const tokenRes = await fetch(tokenUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString().replace(/%7E/gi, '~'),
      });

      const tokenData = await tokenRes.json() as Record<string, unknown>;
      // OAuth2 token exchange completed (status logged only for debugging)
      // OAuth2 redirect processed
      // OAuth2 client authenticated
      // OAuth2 credentials verified

      if (!tokenRes.ok) {
        const errMsg = String(tokenData.error_description ?? tokenData.error ?? 'Token exchange failed');
        return reply.type('text/html').send(`<html><body><h2>Token Error</h2><p>${escapeHtml(errMsg)}</p><script>window.close();</script></body></html>`);
      }

      // Save tokens to config
      const updatedConfig = {
        ...value,
        accessToken: tokenData.access_token,
        refreshToken: tokenData.refresh_token ?? value.refreshToken,
        tokenExpiresAt: Date.now() + (Number(tokenData.expires_in ?? 3600) * 1000),
        oauth2Configured: true,
        // One-time use: consume the pending state so the same code+state can't be replayed.
        oauth2PendingState: null,
        oauth2PendingStateAt: null,
      };

      await prisma.systemConfig.update({
        where: { configKey: 'notification-email' },
        data: { configValue: updatedConfig as any },
      });

      invalidateNotificationConfigCache();
      // OAuth2 tokens saved successfully

      return reply.type('text/html').send(`<html><body>
        <h2 style="color:green">OAuth2 Authorization Successful!</h2>
        <p>Tokens have been saved. You can close this window.</p>
        <script>
          if (window.opener) { window.opener.postMessage({ type: 'oauth2-success' }, '*'); }
          setTimeout(function() { window.close(); }, 2000);
        </script>
      </body></html>`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return reply.type('text/html').send(`<html><body><h2>Error</h2><p>${escapeHtml(msg)}</p><script>window.close();</script></body></html>`);
    }
  });

  // GET /api/notification-settings/email/oauth2/status
  app.get('/email/oauth2/status', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Check OAuth2 token status',
      response: { 200: { type: 'object', properties: { configured: { type: 'boolean' }, hasRefreshToken: { type: 'boolean' }, tokenExpiresAt: { type: 'string' } } } },
    },
  }, async () => {
    const config = await prisma.systemConfig.findUnique({ where: { configKey: 'notification-email' } });
    const value = (config?.configValue ?? {}) as Record<string, unknown>;
    return {
      configured: !!value.oauth2Configured,
      hasRefreshToken: !!value.refreshToken,
      tokenExpiresAt: value.tokenExpiresAt ? new Date(Number(value.tokenExpiresAt)).toISOString() : null,
    };
  });

  // ====== SMS Configuration ======

  app.get('/sms', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Get SMS configuration',
      description: 'Retrieve the current SMS provider configuration. Secrets are masked.',
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async () => {
    const config = await prisma.systemConfig.findUnique({ where: { configKey: 'notification-sms' } });
    const value = (config?.configValue ?? {}) as Record<string, unknown>;
    const sensitiveKeys = ['twilioAuthToken', 'vonageApiSecret'];
    for (const key of sensitiveKeys) { if (value[key]) value[key] = MASK; }
    return value;
  });

  app.put('/sms', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Update SMS configuration',
      description: 'Configure SMS provider settings (Twilio, Vonage, or HTTP Gateway). HTTP Gateway covers MSG91 / Plivo / AfricasTalking / Kaleyra / custom backends via a configurable URL + body template.',
      body: {
        type: 'object',
        properties: {
          provider: { type: 'string', enum: ['twilio', 'vonage', 'http-gateway'] },
          enabled: { type: 'boolean' },
          defaultCountryCode: { type: 'string' },
          senderId: { type: 'string' },
          twilioAccountSid: { type: 'string' },
          twilioAuthToken: { type: 'string' },
          twilioFromNumber: { type: 'string' },
          vonageApiKey: { type: 'string' },
          vonageApiSecret: { type: 'string' },
          vonageFromNumber: { type: 'string' },
          httpGatewayUrl: { type: 'string' },
          httpGatewayMethod: { type: 'string', enum: ['GET', 'POST'] },
          httpGatewayHeaders: { type: 'object', additionalProperties: { type: 'string' } },
          httpGatewayBodyTemplate: { type: 'string' },
          httpGatewaySuccessRegex: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', properties: { success: { type: 'boolean' } } },
        ...errorResponses,
      },
    },
  }, async (req, reply) => {
    const { ok } = await enforceReauth('UPDATE_SMS_CONFIG', req, reply);
    if (!ok) return;

    const body = req.body as Record<string, unknown>;
    const ctx = buildContext(req);

    const sensitiveKeys = ['twilioAuthToken', 'vonageApiSecret'];
    const existing = await prisma.systemConfig.findUnique({ where: { configKey: 'notification-sms' } });
    const existingValue = (existing?.configValue ?? {}) as Record<string, unknown>;
    for (const key of sensitiveKeys) { if (body[key] === MASK) body[key] = existingValue[key]; }

    await prisma.systemConfig.upsert({
      where: { configKey: 'notification-sms' },
      update: { configValue: body as any, updatedBy: ctx.userId },
      create: { configKey: 'notification-sms', configValue: body as any, configType: 'notification', requiresReauth: false, updatedBy: ctx.userId },
    });

    invalidateNotificationConfigCache();
    await auditLog({ userId: ctx.userId, userRole: ctx.userRole, action: 'UPDATE_SMS_CONFIG', targetType: 'system_config', targetId: 'notification-sms', afterValue: maskSecrets(body, SMS_AUDIT_SAFE_KEYS) });
    return { success: true };
  });

  app.post('/sms/test', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Test SMS configuration',
      description: 'Send a test SMS to verify provider configuration.',
      body: { type: 'object', required: ['recipient'], properties: { recipient: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, message: { type: 'string' }, error: { type: 'string' } } } },
    },
  }, async (req) => {
    const { recipient } = req.body as { recipient: string };
    const result = await sendTestNotification('SMS', recipient);
    return { success: result.success, message: result.success ? `Test SMS sent to ${recipient}` : undefined, error: result.error };
  });

  // ====== Send Notification (Manual) ======

  app.post('/send', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Send a notification',
      description: 'Manually send an email or SMS notification.',
      body: {
        type: 'object',
        required: ['channel', 'recipient', 'message'],
        properties: {
          channel: { type: 'string', enum: ['EMAIL', 'SMS'] },
          recipient: { type: 'string' },
          subject: { type: 'string' },
          message: { type: 'string' },
          variables: { type: 'object', additionalProperties: { type: 'string' } },
        },
      },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, messageId: { type: 'string' }, error: { type: 'string' } } } },
    },
  }, async (req) => {
    const body = req.body as { channel: 'EMAIL' | 'SMS'; recipient: string; subject?: string; message: string; variables?: Record<string, string> };
    return sendNotification({ ...body, triggeredBy: 'manual' });
  });

  // ====== Notification Logs ======

  app.get('/logs', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Get notification delivery logs',
      description: 'Retrieve paginated notification delivery logs with optional filters.',
      querystring: {
        type: 'object',
        properties: {
          page: { type: 'integer', minimum: 1, default: 1 },
          limit: { type: 'integer', minimum: 1, default: 25 },
          channel: { type: 'string', enum: ['EMAIL', 'SMS'] },
          status: { type: 'string', enum: ['PENDING', 'SENT', 'DELIVERED', 'FAILED', 'RETRYING'] },
          startDate: { type: 'string' },
          endDate: { type: 'string' },
          search: { type: 'string' },
        },
      },
      response: {
        200: { type: 'object', properties: { data: { type: 'array', items: { type: 'object', additionalProperties: true } }, total: { type: 'integer' }, page: { type: 'integer' }, limit: { type: 'integer' }, totalPages: { type: 'integer' } } },
      },
    },
  }, async (req) => {
    const query = req.query as { page?: number; limit?: number; channel?: string; status?: string; startDate?: string; endDate?: string; search?: string };
    const page = query.page ?? 1;
    const limit = query.limit ?? 25;
    const where: Record<string, unknown> = {};
    if (query.channel) where.channel = query.channel;
    if (query.status) where.status = query.status;
    if (query.startDate || query.endDate) {
      where.createdAt = {};
      if (query.startDate) (where.createdAt as any).gte = new Date(query.startDate);
      if (query.endDate) (where.createdAt as any).lte = new Date(query.endDate);
    }
    if (query.search) {
      where.OR = [
        { recipient: { contains: query.search, mode: 'insensitive' } },
        { subject: { contains: query.search, mode: 'insensitive' } },
      ];
    }

    const [data, total] = await Promise.all([
      prisma.notificationLog.findMany({ where: where as any, orderBy: { createdAt: 'desc' }, skip: (page - 1) * limit, take: limit }),
      prisma.notificationLog.count({ where: where as any }),
    ]);

    return { data, total, page, limit, totalPages: Math.ceil(total / limit) };
  });

  app.get('/logs/stats', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Get notification delivery statistics',
      response: { 200: { type: 'object', properties: { email: { type: 'object', additionalProperties: { type: 'integer' } }, sms: { type: 'object', additionalProperties: { type: 'integer' } }, total: { type: 'integer' } } } },
    },
  }, async () => {
    const [emailSent, emailFailed, smsSent, smsFailed, total] = await Promise.all([
      prisma.notificationLog.count({ where: { channel: 'EMAIL', status: 'SENT' } }),
      prisma.notificationLog.count({ where: { channel: 'EMAIL', status: 'FAILED' } }),
      prisma.notificationLog.count({ where: { channel: 'SMS', status: 'SENT' } }),
      prisma.notificationLog.count({ where: { channel: 'SMS', status: 'FAILED' } }),
      prisma.notificationLog.count(),
    ]);
    return { email: { sent: emailSent, failed: emailFailed }, sms: { sent: smsSent, failed: smsFailed }, total };
  });

  app.delete('/logs/:id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Delete a notification log entry',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    // Fetch first: gives a real 404 (Prisma's P2025 on a missing id surfaced as a
    // 500) AND captures the dispatch evidence before the row is destroyed.
    const existing = await prisma.notificationLog.findUnique({ where: { id } });
    if (!existing) throw new NotFoundError('Notification log not found');

    const ctx = buildContext(req);
    await prisma.$transaction(async (tx) => {
      await auditLog({
        userId: ctx.userId, userRole: ctx.userRole,
        action: 'NOTIFICATION_LOG_DELETED',
        targetType: 'notification_log', targetId: id,
        beforeValue: {
          channel: existing.channel, status: existing.status, recipient: existing.recipient,
          subject: existing.subject, templateId: existing.templateId,
          triggeredBy: existing.triggeredBy, sentAt: existing.sentAt, createdAt: existing.createdAt,
        },
        signatureMeaning: `${existing.channel} delivery log to "${existing.recipient}" permanently deleted`,
        ipAddress: ctx.ipAddress, userAgent: ctx.userAgent, sessionId: ctx.sessionId,
      }, tx);
      await tx.notificationLog.delete({ where: { id } });
    });

    return { success: true };
  });

  // ====== Notification Templates ======

  app.get('/templates', {
    preHandler: [app.requirePermission('CONFIG_READ')],
    schema: { tags: ['Notification Settings'], summary: 'List notification templates', response: { 200: { type: 'array', items: { type: 'object', additionalProperties: true } } } },
  }, async () => prisma.notificationTemplate.findMany({ orderBy: { name: 'asc' } }));

  app.post('/templates', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Create notification template',
      body: {
        type: 'object',
        required: ['name', 'channel', 'bodyTemplate'],
        properties: { name: { type: 'string' }, channel: { type: 'string', enum: ['EMAIL', 'SMS'] }, subject: { type: 'string' }, bodyTemplate: { type: 'string' }, description: { type: 'string' }, variables: { type: 'array', items: { type: 'string' } } },
      },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req) => {
    const body = req.body as any;
    return prisma.notificationTemplate.create({ data: { name: body.name, channel: body.channel, subject: body.subject, bodyTemplate: body.bodyTemplate, description: body.description, variables: body.variables, createdBy: req.user.username } });
  });

  app.put('/templates/:id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Update notification template',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      body: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, subject: { type: 'string' }, bodyTemplate: { type: 'string' }, description: { type: 'string' }, variables: { type: 'array', items: { type: 'string' } }, isActive: { type: 'boolean' } } },
      response: { 200: { type: 'object', additionalProperties: true } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    // Whitelist updatable fields — never spread req.body into Prisma (mass-assignment
    // guard; the schema's additionalProperties:false is belt, this is suspenders since
    // ajv is not configured with global removeAdditional). Provenance columns
    // (createdBy, channel, createdAt) are intentionally NOT updatable here.
    const body = req.body as Record<string, unknown>;
    const data: Record<string, unknown> = {};
    for (const key of ['name', 'subject', 'bodyTemplate', 'description', 'variables', 'isActive'] as const) {
      if (key in body) data[key] = body[key];
    }
    return prisma.notificationTemplate.update({ where: { id }, data });
  });

  app.delete('/templates/:id', {
    preHandler: [app.requirePermission('CONFIG_UPDATE')],
    schema: {
      tags: ['Notification Settings'],
      summary: 'Delete notification template',
      params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' } } } },
    },
  }, async (req) => {
    const { id } = req.params as { id: string };
    await prisma.notificationTemplate.delete({ where: { id } });
    return { success: true };
  });
}
