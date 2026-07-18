/**
 * Email Channel — Sends emails via SMTP using nodemailer.
 * Supports Basic Auth and OAuth2 (Microsoft Azure AD / Google).
 * Similar to ThingsBoard mail server configuration.
 */

import nodemailer from "nodemailer";
import dns from "dns";
import type { EmailConfig, NotificationPayload, DeliveryResult, NotificationChannel as IChannel } from '../types.js';
import { getEmailConfig } from '../config-loader.js';

let transporter: nodemailer.Transporter | null = null;
let currentConfigHash = "";

// Force IPv4 DNS resolution to avoid EC2 IPv6 ENETUNREACH
const ipv4Lookup: any = (hostname: any, options: any, callback: any) => {
  if (typeof options === "function") {
    callback = options;
    options = { family: 4 };
  } else {
    options = typeof options === "number" ? { family: 4 } : { ...options, family: 4 };
  }
  return dns.lookup(hostname, options, callback as any);
};
let cachedOAuthToken: { token: string; expiresAt: number } | null = null;

function configHash(config: EmailConfig): string {
  // #notif-1 fix: include the basic-auth password so a password rotation busts the
  // cached transporter. Without it the hash was unchanged on rotation → getTransporter
  // returned a transporter built with the OLD password and every send failed until an
  // API restart (the basic-auth catch never self-heals). In-memory equality key only,
  // never logged. (oauth2 bypasses this cache entirely, see getTransporter.)
  return `${config.host}:${config.port}:${config.username}:${config.secure}:${config.authType}:${config.clientId ?? ''}:${config.password ?? ''}`;
}

/**
 * Fetch OAuth2 access token from Microsoft Azure AD or Google.
 */
async function fetchOAuth2Token(config: EmailConfig): Promise<string> {
  // Return cached token if still valid (with 60s buffer)
  if (cachedOAuthToken && cachedOAuthToken.expiresAt > Date.now() + 60000) {
    return cachedOAuthToken.token;
  }

  if (config.oauth2Provider === 'microsoft' || config.oauth2Provider === 'office365') {
    const tenantId = config.providerTenantId || 'common';
    const tokenUrl = `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;

    // Check if we have a saved access token from Authorization Code flow
    const savedToken = (config as any).accessToken as string | undefined;
    const savedExpiry = (config as any).tokenExpiresAt as number | undefined;
    const savedRefresh = config.refreshToken;

    if (savedToken && savedExpiry && savedExpiry > Date.now() + 60000) {
      // Use saved access token (still valid)
      cachedOAuthToken = { token: savedToken, expiresAt: savedExpiry };
      return savedToken;
    }

    let body: URLSearchParams;
    if (savedRefresh) {
      // Refresh Token flow (from Authorization Code grant)
      body = new URLSearchParams({
        client_id: config.clientId!,
        client_secret: config.clientSecret!,
        refresh_token: savedRefresh,
        grant_type: 'refresh_token',
        scope: 'offline_access https://outlook.office365.com/SMTP.Send',
      });
    } else {
      // Client Credentials flow (fallback)
      body = new URLSearchParams({
        client_id: config.clientId!,
        client_secret: config.clientSecret!,
        scope: 'https://outlook.office365.com/.default',
        grant_type: 'client_credentials',
      });
    }

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString().replace(/%7E/gi, '~'),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Microsoft OAuth2 token error: ${err}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number; refresh_token?: string };
    cachedOAuthToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in * 1000),
    };

    // Persist new tokens back to DB if we got a refresh token
    if (savedRefresh) {
      try {
        const { PrismaClient } = await import('@prisma/client');
        const prisma = new PrismaClient();
        const dbConfig = await prisma.systemConfig.findUnique({ where: { configKey: 'notification-email' } });
        if (dbConfig) {
          const val = (dbConfig.configValue ?? {}) as Record<string, unknown>;
          val.accessToken = data.access_token;
          val.tokenExpiresAt = Date.now() + (data.expires_in * 1000);
          if (data.refresh_token) val.refreshToken = data.refresh_token;
          await prisma.systemConfig.update({ where: { configKey: 'notification-email' }, data: { configValue: val as any } });
        }
        await prisma.$disconnect();
      } catch { /* best effort */ }
    }

    return data.access_token;

  } else if (config.oauth2Provider === 'google') {
    // Google OAuth2 — Refresh Token flow
    const tokenUrl = 'https://oauth2.googleapis.com/token';

    const body = new URLSearchParams({
      client_id: config.clientId!,
      client_secret: config.clientSecret!,
      refresh_token: config.refreshToken!,
      grant_type: 'refresh_token',
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString().replace(/%7E/gi, '~'),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Google OAuth2 token error: ${err}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    cachedOAuthToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in * 1000),
    };
    return data.access_token;

  } else {
    // Custom OAuth2 provider
    if (!config.tokenUrl) throw new Error('OAuth2 token URL not configured');

    const body = new URLSearchParams({
      client_id: config.clientId!,
      client_secret: config.clientSecret!,
      grant_type: 'client_credentials',
    });
    if (config.scope) body.set('scope', config.scope);

    const res = await fetch(config.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString().replace(/%7E/gi, '~'),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`OAuth2 token error: ${err}`);
    }

    const data = await res.json() as { access_token: string; expires_in: number };
    cachedOAuthToken = {
      token: data.access_token,
      expiresAt: Date.now() + (data.expires_in * 1000),
    };
    return data.access_token;
  }
}

async function getTransporter(config: EmailConfig): Promise<nodemailer.Transporter> {
  const hash = configHash(config);
  if (transporter && currentConfigHash === hash && config.authType !== 'oauth2') {
    return transporter;
  }

  if (config.authType === 'oauth2') {
    // OAuth2 authentication
    const accessToken = await fetchOAuth2Token(config);

    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        type: 'OAuth2',
        user: config.username,
        accessToken,
      },
      tls: {
        // Secure by default. This was hardcoded `false` in BOTH transporters
        // until 2026-07-15, reading no config at all — so a LAN attacker
        // presenting a forged certificate could harvest the SMTP password /
        // OAuth2 access token and read or modify every outbound mail. Same
        // class as the LDAP TLS default fixed the same day; an explicit
        // opt-out remains for internal servers with self-signed certs.
        rejectUnauthorized: config.tlsRejectUnauthorized ?? true,
      },
      family: 4,
      dnsLookup: ipv4Lookup,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    } as any);
  } else {
    // Basic auth (username + password)
    transporter = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: {
        user: config.username,
        pass: config.password,
      },
      tls: {
        // Secure by default. This was hardcoded `false` in BOTH transporters
        // until 2026-07-15, reading no config at all — so a LAN attacker
        // presenting a forged certificate could harvest the SMTP password /
        // OAuth2 access token and read or modify every outbound mail. Same
        // class as the LDAP TLS default fixed the same day; an explicit
        // opt-out remains for internal servers with self-signed certs.
        rejectUnauthorized: config.tlsRejectUnauthorized ?? true,
      },
      family: 4,
      dnsLookup: ipv4Lookup,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    } as any);
  }

  currentConfigHash = hash;
  return transporter;
}

/**
 * Wrap plain text message in a clean HTML email template.
 */
function wrapInHtmlTemplate(subject: string, body: string, isHtml: boolean): string {
  const content = isHtml ? body : body.replace(/\n/g, '<br>');
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${subject}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:'Segoe UI',Tahoma,Geneva,Verdana,sans-serif;">
  <div style="max-width:600px;margin:20px auto;background:#ffffff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#4f46e5,#7c3aed);padding:24px 32px;">
      <h1 style="color:#ffffff;margin:0;font-size:20px;font-weight:600;">DigiLog Notification</h1>
    </div>
    <div style="padding:32px;">
      <h2 style="color:#1e293b;margin:0 0 16px 0;font-size:18px;">${subject}</h2>
      <div style="color:#475569;font-size:14px;line-height:1.7;">
        ${content}
      </div>
    </div>
    <div style="background:#f8fafc;padding:16px 32px;border-top:1px solid #e2e8f0;">
      <p style="color:#94a3b8;font-size:12px;margin:0;text-align:center;">
        This is an automated notification from DigiLog. Do not reply to this email.
      </p>
    </div>
  </div>
</body>
</html>`;
}

export const emailChannel: IChannel = {
  name: 'EMAIL',

  async send(payload: NotificationPayload): Promise<DeliveryResult> {
    const config = await getEmailConfig();
    if (!config || !config.enabled) {
      return { success: false, error: 'Email notifications are not enabled' };
    }

    try {
      const transport = await getTransporter(config);
      const isHtml = payload.message.includes('<') && payload.message.includes('>');
      const htmlBody = wrapInHtmlTemplate(
        payload.subject ?? 'DigiLog Notification',
        payload.message,
        isHtml,
      );

      const result = await transport.sendMail({
        from: `"${config.fromName}" <${config.fromEmail}>`,
        to: payload.recipient,
        subject: payload.subject ?? 'DigiLog Notification',
        text: payload.message.replace(/<[^>]*>/g, ''),
        html: htmlBody,
      });

      return {
        success: true,
        messageId: result.messageId,
      };
    } catch (err) {
      // Invalidate cached token on auth errors so next attempt gets a fresh one
      if (config.authType === 'oauth2') {
        cachedOAuthToken = null;
        transporter = null;
        currentConfigHash = '';
      }
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },

  async testConnection(): Promise<DeliveryResult> {
    const config = await getEmailConfig();
    if (!config || !config.enabled) {
      return { success: false, error: 'Email notifications are not enabled' };
    }

    try {
      if (config.authType === 'oauth2') {
        // Test OAuth2 token fetch first
        await fetchOAuth2Token(config);
      }
      const transport = await getTransporter(config);
      await transport.verify();
      return { success: true, messageId: 'connection-verified' };
    } catch (err) {
      cachedOAuthToken = null;
      transporter = null;
      currentConfigHash = '';
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  },
};
