import { describe, it, expect } from 'vitest';
import { stripHtml, sanitizeStrings } from '../sanitize.js';

/**
 * The app's input-sanitization layer had NO test coverage until 2026-07-15 —
 * noticed while bumping sanitize-html 2.17.2 → 2.17.6 for GHSA-9mrh-v2v3-xpfm.
 * Bumping the library under a security control with nothing to catch a
 * behaviour change is a blind swap, so these pin what every text field relies on.
 *
 * NOTE THE NAME LIES. `stripHtml` does not strip — `disallowedTagsMode:
 * 'recursiveEscape'` ESCAPES markup into entities:
 *   '<b>Wash</b> In'            -> '&lt;b&gt;Wash&lt;/b&gt; In'
 *   '<img src=x onerror=alert(1)>' -> '&lt;img /&gt;'   (attributes dropped)
 * The security property is "never emits a raw executable tag", NOT "removes
 * markup". Tests below assert the ACTUAL behaviour; an earlier draft of this
 * file asserted the name's implied behaviour and was simply wrong.
 */
describe('stripHtml', () => {
  it('escapes tags rather than removing them (the name is misleading)', () => {
    expect(stripHtml('<b>Wash</b> In')).toBe('&lt;b&gt;Wash&lt;/b&gt; In');
  });

  it('escapes a script element and neutralises it', () => {
    expect(stripHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });

  it('drops event-handler attributes and escapes the tag', () => {
    expect(stripHtml('<img src=x onerror=alert(1)>')).toBe('&lt;img /&gt;');
  });

  it('trims surrounding whitespace', () => {
    expect(stripHtml('  padded  ')).toBe('padded');
  });

  it('leaves plain text untouched', () => {
    expect(stripHtml('AHU-01 filter, set B')).toBe('AHU-01 filter, set B');
  });

  it('leaves an empty string empty', () => {
    expect(stripHtml('')).toBe('');
  });

  /**
   * Known lossy behaviour, deliberately pinned rather than fixed here. The
   * 2026-07-04 audit reverted a sanitizeStrings rollout on dynamic-routes for
   * exactly this: legitimate operator text is mangled. Entity-encoding is
   * correct for HTML output but wrong for text a report renders verbatim — so
   * think hard before applying stripHtml to a new free-text field.
   */
  it('entity-encodes bare & and < in legitimate operator text (lossy — known)', () => {
    expect(stripHtml('Wear & tear')).toBe('Wear &amp; tear');
    expect(stripHtml('temp < 5')).toBe('temp &lt; 5');
  });

  // ── GHSA-9mrh-v2v3-xpfm regression guard ──
  // The advisory is a COMPLETE allowedTags bypass, but only for configs that
  // allow `option`/`textarea`. We allow NO tags, so recursiveEscape re-escapes
  // the decoded text on the way out and we were never exploitable. These pin
  // that: if anyone ever adds a tag to allowedTags, the PoC leaks a raw tag and
  // these fail loudly.
  it('escapes the advisory PoC instead of emitting a raw tag (option)', () => {
    const out = stripHtml('<option>&lt;img src=x onerror=alert(1)&gt;</option>');
    expect(out).not.toMatch(/<img/);
    expect(out).toBe('&lt;option&gt;&lt;img src=x onerror=alert(1)&gt;&lt;/option&gt;');
  });

  it('escapes the advisory PoC instead of emitting a raw tag (textarea)', () => {
    const out = stripHtml('<textarea>&#x3C;svg onload=alert(1)&#x3E;</textarea>');
    expect(out).not.toMatch(/<svg/);
  });

  it('never emits a raw executable tag for any known bypass shape', () => {
    for (const payload of [
      '<select><option>&lt;img src=x onerror=alert(1)&gt;</option></select>',
      '<option>&#60;script&#62;alert(1)&#60;/script&#62;</option>',
      '<textarea>&lt;script&gt;alert(1)&lt;/script&gt;</textarea>',
      '<noscript>&lt;img src=x onerror=alert(1)&gt;</noscript>',
      '<style>&lt;img src=x onerror=alert(1)&gt;</style>',
    ]) {
      expect(stripHtml(payload)).not.toMatch(/<(script|img|svg)\b/i);
    }
  });
});

describe('sanitizeStrings', () => {
  it('escapes every string field', () => {
    expect(sanitizeStrings({ name: '<b>F1</b>' })).toEqual({ name: '&lt;b&gt;F1&lt;/b&gt;' });
  });

  it('skips the named keys — a password must survive verbatim', () => {
    // Escaping a password containing markup would silently change the secret and
    // lock the user out.
    const out = sanitizeStrings({ username: '<b>joe</b>', password: '<P@ss>word' }, ['password']);
    expect(out.password).toBe('<P@ss>word');
    expect(out.username).toBe('&lt;b&gt;joe&lt;/b&gt;');
  });

  it('recurses into nested objects', () => {
    expect(sanitizeStrings({ a: { b: { c: '<i>deep</i>' } } }))
      .toEqual({ a: { b: { c: '&lt;i&gt;deep&lt;/i&gt;' } } });
  });

  it('handles arrays of strings and of objects', () => {
    expect(sanitizeStrings({ tags: ['<b>x</b>', 'y'], rows: [{ n: '<i>z</i>' }] }))
      .toEqual({ tags: ['&lt;b&gt;x&lt;/b&gt;', 'y'], rows: [{ n: '&lt;i&gt;z&lt;/i&gt;' }] });
  });

  it('leaves non-string scalars alone', () => {
    expect(sanitizeStrings({ n: 5, b: true, nul: null })).toEqual({ n: 5, b: true, nul: null });
  });

  it('does not mutate its input', () => {
    const input = { name: '<b>F1</b>' };
    sanitizeStrings(input);
    expect(input.name).toBe('<b>F1</b>');
  });

  it('applies skipKeys at every depth', () => {
    const out = sanitizeStrings({ outer: { password: '<b>keep</b>', name: '<b>strip</b>' } }, ['password']);
    expect((out.outer as any).password).toBe('<b>keep</b>');
    expect((out.outer as any).name).toBe('&lt;b&gt;strip&lt;/b&gt;');
  });
});
