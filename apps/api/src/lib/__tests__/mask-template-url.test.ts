import { describe, it, expect } from 'vitest';
import {
  SECRET_MASK as M,
  maskTemplateSecrets,
  restoreMaskedTemplate,
  maskUrlSecrets,
  restoreMaskedUrl,
  isSecretName,
} from '../mask-secrets.js';

/**
 * Audit 2026-10-12 follow-up. Masking where a secret has a RECOGNISABLE shape:
 *  - the SMS gateway body template's secret-NAMED fields (MSG91 `authkey`,
 *    `"api_key"`, `password=`…), JSON or form-encoded;
 *  - a webhook URL's secret-named query values (`?token=…`), names kept.
 * Mask-means-keep on save, matched by name and occurrence.
 */
describe('isSecretName', () => {
  it.each(['authkey', 'api_key', 'apiKey', 'token', 'access_token', 'secret', 'password', 'pwd', 'passwd', 'signature', 'sig', 'Authorization', 'credential'])(
    'treats %s as secret', (n) => expect(isSecretName(n)).toBe(true),
  );
  it.each(['mobiles', 'message', 'sender', 'route', 'to', 'relay', 'channel', 'country'])(
    'does not treat %s as secret', (n) => expect(isSecretName(n)).toBe(false),
  );
});

describe('maskTemplateSecrets / restoreMaskedTemplate', () => {
  const json = '{"authkey":"REAL-KEY-1","mobiles":"{phone}","message":"{message}","sender":"DIGLOG","password":"p@ss"}';
  const form = 'apikey=REAL-KEY-2&to={phone}&msg={message}&sig=abc123';

  it('masks secret-named JSON and form values, keeps everything else readable', () => {
    expect(maskTemplateSecrets(json)).toBe(`{"authkey":"${M}","mobiles":"{phone}","message":"{message}","sender":"DIGLOG","password":"${M}"}`);
    expect(maskTemplateSecrets(form)).toBe(`apikey=${M}&to={phone}&msg={message}&sig=${M}`);
  });

  it('never masks a placeholder, even under a secret-looking name', () => {
    expect(maskTemplateSecrets('{"token":"{message}"}')).toBe('{"token":"{message}"}');
  });

  it('a round trip restores the stored secrets, and an edited field keeps its edit', () => {
    const shown = maskTemplateSecrets(json);
    expect(restoreMaskedTemplate(shown, json)).toEqual({ value: json });
    const edited = shown.replace('DIGLOG', 'NEWSND');
    expect(restoreMaskedTemplate(edited, json)).toEqual({ value: json.replace('DIGLOG', 'NEWSND') });
    expect(restoreMaskedTemplate(maskTemplateSecrets(form), form)).toEqual({ value: form });
  });

  it('refuses a mask with nothing stored behind it', () => {
    expect(restoreMaskedTemplate(`{"newkey":"${M}"}`, json)).toHaveProperty('unresolved');
  });
});

describe('maskUrlSecrets — secret NAMES only (webhooks)', () => {
  it('masks a secret-named query value and leaves the rest', () => {
    expect(maskUrlSecrets('http://10.0.0.5/hooter?token=abc&relay=1', { secretNamesOnly: true }))
      .toBe(`http://10.0.0.5/hooter?token=${M}&relay=1`);
    expect(maskUrlSecrets('http://user:pw@10.0.0.5/x', { secretNamesOnly: true })).toBe(`http://user:${M}@10.0.0.5/x`);
    expect(maskUrlSecrets('http://10.0.0.5/alarm', { secretNamesOnly: true })).toBe('http://10.0.0.5/alarm');
  });

  it('round-trips through restoreMaskedUrl', () => {
    const url = 'http://10.0.0.5/hooter?token=abc&relay=1';
    expect(restoreMaskedUrl(maskUrlSecrets(url, { secretNamesOnly: true })!, url)).toEqual({ url });
  });
});
