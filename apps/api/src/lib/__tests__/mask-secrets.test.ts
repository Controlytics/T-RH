import { describe, it, expect } from 'vitest';
import { maskSecrets, REDACTED } from '../mask-secrets.js';

/**
 * Audit L136 regression coverage. These tests pin the leak fix for the two
 * notification-delivery config audit sites. The allowlists here mirror
 * EMAIL_AUDIT_SAFE_KEYS / SMS_AUDIT_SAFE_KEYS in
 * modules/notification-delivery/routes.ts.
 */

const EMAIL_SAFE = [
  'host', 'port', 'secure', 'username', 'fromEmail', 'fromName', 'enabled',
  'oauth2Provider', 'clientId', 'providerTenantId', 'oauth2Configured',
];
const SMS_SAFE = [
  'provider', 'enabled', 'defaultCountryCode', 'senderId',
  'twilioAccountSid', 'twilioFromNumber', 'vonageApiKey', 'vonageFromNumber',
  'httpGatewayMethod', 'httpGatewaySuccessRegex',
];

/** Flatten to a single string so a leaked secret anywhere in the tree fails. */
const serialize = (v: unknown) => JSON.stringify(v);

describe('maskSecrets', () => {
  it('keeps allowlisted keys and redacts everything else', () => {
    const out = maskSecrets({ host: 'smtp.gmail.com', port: 587, password: 'hunter2' }, EMAIL_SAFE) as any;
    expect(out.host).toBe('smtp.gmail.com');
    expect(out.port).toBe(587);
    expect(out.password).toBe(REDACTED);
  });

  it('preserves the key itself so the audit row still records the field was submitted', () => {
    const out = maskSecrets({ password: 'hunter2' }, EMAIL_SAFE) as any;
    expect(Object.keys(out)).toContain('password');
  });

  it('does not mutate the input object', () => {
    const input = { host: 'smtp.example.com', password: 'hunter2' };
    maskSecrets(input, EMAIL_SAFE);
    expect(input.password).toBe('hunter2');
  });

  describe('email config (the rehydrated-secret path)', () => {
    // The PUT /email handler substitutes the REAL stored secrets back into `body`
    // when the client echoes the mask sentinel, so this is the shape that actually
    // reaches auditLog on a routine save.
    const rehydratedBody = {
      host: 'smtp.office365.com',
      port: 587,
      secure: false,
      username: 'noreply@acme.com',
      fromEmail: 'noreply@acme.com',
      fromName: 'Acme',
      enabled: true,
      clientId: 'public-client-id',
      oauth2Provider: 'microsoft',
      providerTenantId: 'tenant-123',
      oauth2Configured: true,
      password: 'REAL-SMTP-PASSWORD',
      clientSecret: 'REAL-CLIENT-SECRET',
      refreshToken: 'REAL-REFRESH-TOKEN',
      accessToken: 'REAL-ACCESS-TOKEN',
      tokenExpiresAt: 1893456000000,
      oauth2PendingState: 'REAL-CSRF-STATE',
    };

    it('redacts every secret named in the finding', () => {
      const out = maskSecrets(rehydratedBody, EMAIL_SAFE) as any;
      for (const key of ['password', 'clientSecret', 'refreshToken', 'accessToken', 'tokenExpiresAt', 'oauth2PendingState']) {
        expect(out[key], `${key} must be redacted`).toBe(REDACTED);
      }
    });

    it('leaks no secret substring anywhere in the serialized output', () => {
      const s = serialize(maskSecrets(rehydratedBody, EMAIL_SAFE));
      for (const secret of ['REAL-SMTP-PASSWORD', 'REAL-CLIENT-SECRET', 'REAL-REFRESH-TOKEN', 'REAL-ACCESS-TOKEN', 'REAL-CSRF-STATE']) {
        expect(s).not.toContain(secret);
      }
    });

    it('still records the non-secret config for the inspector', () => {
      const out = maskSecrets(rehydratedBody, EMAIL_SAFE) as any;
      expect(out).toMatchObject({
        host: 'smtp.office365.com', port: 587, username: 'noreply@acme.com',
        enabled: true, clientId: 'public-client-id', oauth2Provider: 'microsoft',
      });
    });
  });

  describe('sms config', () => {
    const smsBody = {
      provider: 'http-gateway',
      enabled: true,
      defaultCountryCode: '+91',
      senderId: 'ACMEIN',
      twilioAccountSid: 'AC-public-sid',
      twilioAuthToken: 'REAL-TWILIO-TOKEN',
      vonageApiKey: 'public-vonage-key',
      vonageApiSecret: 'REAL-VONAGE-SECRET',
      httpGatewayUrl: 'https://api.msg91.com/send?authkey=REAL-URL-APIKEY',
      httpGatewayMethod: 'POST',
      httpGatewayHeaders: { Authorization: 'Bearer REAL-BEARER-TOKEN', 'Content-Type': 'application/json' },
      httpGatewayBodyTemplate: '{"authkey":"REAL-TEMPLATE-APIKEY","to":"{{recipient}}"}',
      httpGatewaySuccessRegex: '"type":"success"',
    };

    it('redacts the scalar provider secrets', () => {
      const out = maskSecrets(smsBody, SMS_SAFE) as any;
      expect(out.twilioAuthToken).toBe(REDACTED);
      expect(out.vonageApiSecret).toBe(REDACTED);
    });

    // The core of the finding: secrets live in the VALUES of httpGatewayHeaders,
    // not in the key names. An allowlist redacts the whole bag by omission — this
    // is the case a denylist of secret key names would silently miss.
    it('redacts bearer tokens nested in httpGatewayHeaders values', () => {
      const out = maskSecrets(smsBody, SMS_SAFE) as any;
      expect(out.httpGatewayHeaders).toBe(REDACTED);
      expect(serialize(out)).not.toContain('REAL-BEARER-TOKEN');
    });

    it('redacts credentials embedded in the gateway URL and body template', () => {
      const s = serialize(maskSecrets(smsBody, SMS_SAFE));
      expect(s).not.toContain('REAL-URL-APIKEY');
      expect(s).not.toContain('REAL-TEMPLATE-APIKEY');
    });

    it('leaks no secret substring anywhere in the serialized output', () => {
      const s = serialize(maskSecrets(smsBody, SMS_SAFE));
      for (const secret of ['REAL-TWILIO-TOKEN', 'REAL-VONAGE-SECRET', 'REAL-URL-APIKEY', 'REAL-BEARER-TOKEN', 'REAL-TEMPLATE-APIKEY']) {
        expect(s).not.toContain(secret);
      }
    });

    it('keeps the public identifiers and routing config', () => {
      const out = maskSecrets(smsBody, SMS_SAFE) as any;
      expect(out).toMatchObject({
        provider: 'http-gateway', enabled: true, senderId: 'ACMEIN',
        twilioAccountSid: 'AC-public-sid', vonageApiKey: 'public-vonage-key',
        httpGatewayMethod: 'POST',
      });
    });
  });

  describe('fail-closed behaviour', () => {
    // The property that makes this robust against the next secret field someone
    // adds to a config shape without thinking about the audit trail.
    it('redacts an unknown future field by default', () => {
      const out = maskSecrets({ host: 'smtp.example.com', someNewApiKey: 'FUTURE-SECRET' }, EMAIL_SAFE) as any;
      expect(out.someNewApiKey).toBe(REDACTED);
    });

    it('applies the allowlist at every depth, not just the top level', () => {
      const out = maskSecrets({ enabled: true, nested: { deeper: { token: 'DEEP-SECRET' } } }, ['enabled']) as any;
      expect(serialize(out)).not.toContain('DEEP-SECRET');
    });

    it('recurses into arrays', () => {
      const out = maskSecrets({ enabled: [{ token: 'ARRAY-SECRET', enabled: true }] }, ['enabled']) as any;
      expect(serialize(out)).not.toContain('ARRAY-SECRET');
      expect(out.enabled[0].enabled).toBe(true);
    });

    it('redacts everything when the allowlist is empty', () => {
      const out = maskSecrets({ a: 1, b: 2 }, []) as any;
      expect(out).toEqual({ a: REDACTED, b: REDACTED });
    });

    it('accepts a Set as well as an array', () => {
      const out = maskSecrets({ host: 'h', password: 'p' }, new Set(['host'])) as any;
      expect(out.host).toBe('h');
      expect(out.password).toBe(REDACTED);
    });
  });

  describe('non-object inputs', () => {
    it('passes scalars and null through unchanged', () => {
      expect(maskSecrets('plain', EMAIL_SAFE)).toBe('plain');
      expect(maskSecrets(42, EMAIL_SAFE)).toBe(42);
      expect(maskSecrets(null, EMAIL_SAFE)).toBeNull();
      expect(maskSecrets(undefined, EMAIL_SAFE)).toBeUndefined();
    });

    it('preserves allowlisted null and false values rather than redacting them', () => {
      const out = maskSecrets({ secure: false, fromName: null }, EMAIL_SAFE) as any;
      expect(out.secure).toBe(false);
      expect(out.fromName).toBeNull();
    });
  });
});
