/**
 * Notification Delivery System — Types
 */

export interface EmailConfig {
  // SMTP Server
  host: string;
  port: number;
  secure: boolean;           // true for TLS (465), false for STARTTLS (587)
  enabled: boolean;
  /**
   * Verify the SMTP server's TLS certificate. Defaults to TRUE (secure) when
   * absent — this was hardcoded `false` in both transporters until 2026-07-15,
   * which meant any forged certificate was accepted and an on-path attacker
   * could harvest the SMTP password / OAuth2 access token and read or alter all
   * outbound mail. Set false only for an internal mail server with a
   * self-signed cert. Mirrors LdapConfig.tlsRejectUnauthorized.
   */
  tlsRejectUnauthorized?: boolean;

  // Sender info
  fromEmail: string;
  fromName: string;

  // SMTP Provider preset
  smtpProvider?: 'custom' | 'gmail' | 'office365' | 'sendgrid' | 'aws-ses';

  // Authentication type (like ThingsBoard)
  authType: 'basic' | 'oauth2';

  // Basic auth fields
  username: string;
  password?: string;

  // OAuth2 fields (Microsoft Azure AD / Google / Custom)
  oauth2Provider?: 'microsoft' | 'office365' | 'google' | 'custom';
  clientId?: string;
  clientSecret?: string;
  providerTenantId?: string;    // Microsoft Azure AD Tenant ID
  refreshToken?: string;        // Google OAuth2 refresh token
  tokenUrl?: string;            // Custom OAuth2 token endpoint
  scope?: string;               // Custom OAuth2 scope

  // Timeouts
  connectionTimeout?: number;
  socketTimeout?: number;
}

export interface SmsConfig {
  // P3 (2026-05-02): AWS SNS removed — never had a non-CLI integration; users
  // who want AWS can hit it via the http-gateway template. MSG91, Plivo,
  // AfricasTalking, Kaleyra etc. all run through `http-gateway`.
  provider: 'twilio' | 'vonage' | 'http-gateway';
  enabled: boolean;
  // Twilio
  twilioAccountSid?: string;
  twilioAuthToken?: string;
  twilioFromNumber?: string;
  // Vonage
  vonageApiKey?: string;
  vonageApiSecret?: string;
  vonageFromNumber?: string;
  // Generic HTTP gateway — covers MSG91, Plivo, AfricasTalking, Kaleyra, custom
  // backends, etc. via configurable URL + headers + body template (placeholders
  // {phone} and {message}).
  httpGatewayUrl?: string;
  httpGatewayMethod?: 'GET' | 'POST';
  httpGatewayHeaders?: Record<string, string>;
  httpGatewayBodyTemplate?: string;
  // #sms-2xx: optional regex the response body MUST match for the send to count
  // as delivered (authoritative when set). Gateways that return HTTP 200 on
  // failure need this — e.g. `"status"\s*:\s*"success"`. Empty → 2xx + an
  // unambiguous-JSON-failure fallback decides.
  httpGatewaySuccessRegex?: string;
  // Common
  defaultCountryCode?: string;
  senderId?: string;
}

export interface NotificationPayload {
  channel: 'EMAIL' | 'SMS';
  recipient: string;           // email address or phone number
  subject?: string;            // for email
  message: string;             // plain text or HTML
  templateId?: string;         // optional template reference
  variables?: Record<string, string>;  // template variables
  triggeredBy?: string;        // system, manual, notification-rule
  metadata?: Record<string, unknown>;
}

export interface DeliveryResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export interface NotificationChannel {
  name: string;
  send(payload: NotificationPayload): Promise<DeliveryResult>;
  testConnection(): Promise<DeliveryResult>;
}
