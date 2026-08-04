import { describe, it, expect } from 'vitest';
import { stripHtml, sanitizeStrings } from '../sanitize.js';

/**
 * The app's input-sanitization layer had NO test coverage until 2026-07-15 —
 * noticed while bumping sanitize-html 2.17.2 → 2.17.6 for GHSA-9mrh-v2v3-xpfm.
 * Bumping the library under a security control with nothing to catch a
 * behaviour change is a blind swap, so these pin what every text field relies on.
 *
 * 2026-08-04: `stripHtml` now genuinely STRIPS and returns plain text. It used
 * to escape (`disallowedTagsMode: 'recursiveEscape'`), which never emitted a raw
 * tag but corrupted ordinary text — `R&D Dept` was stored as `R&amp;D Dept` and,
 * because React escapes again on output, rendered as `R&amp;D Dept` on screen.
 *
 * The security property is UNCHANGED and is the thing to defend: the return
 * value never contains a raw executable tag. It is now enforced two ways — a
 * sanitize→decode fixed-point loop (decoding alone would revive pre-encoded
 * `&lt;script&gt;` into a live tag) plus a fail-safe that reverts to escaping if
 * anything tag-shaped survives.
 */
describe('stripHtml', () => {
  it('strips tags and keeps their text content', () => {
    expect(stripHtml('<b>Wash</b> In')).toBe('Wash In');
  });

  it('removes a script element entirely, content included', () => {
    expect(stripHtml('<script>alert(1)</script>')).toBe('');
    expect(stripHtml('<script>alert(1)</script>QA Tester')).toBe('QA Tester');
  });

  it('removes a tag carrying event-handler attributes', () => {
    expect(stripHtml('<img src=x onerror=alert(1)>')).toBe('');
  });

  /**
   * The regression that motivated the change. These are the shapes that appear
   * in real operator text; every one of them used to be stored mangled.
   */
  it('leaves ampersands and comparison operators intact (was the corruption)', () => {
    expect(stripHtml('R&D Dept')).toBe('R&D Dept');
    expect(stripHtml('Wear & tear')).toBe('Wear & tear');
    expect(stripHtml('temp < 5')).toBe('temp < 5');
    expect(stripHtml('5 > 3 always')).toBe('5 > 3 always');
  });

  /**
   * The cost of stripping, pinned so it is a decision and not a surprise:
   * tag-shaped words lose their content, where escaping would have kept them.
   */
  it('DISCARDS tag-shaped words — the accepted trade-off (lossy)', () => {
    expect(stripHtml('Filter <spare> unit')).toBe('Filter  unit');
  });

  /**
   * Decoding is what makes the change possible and is also what makes it
   * dangerous: a single strip-then-decode turns already-encoded input into a
   * live tag. The fixed-point loop must collapse it instead.
   */
  it('does not revive pre-encoded markup into a live tag', () => {
    expect(stripHtml('&lt;script&gt;alert(1)&lt;/script&gt;')).toBe('');
    expect(stripHtml('&amp;lt;script&amp;gt;alert(1)')).not.toMatch(/<script/i);
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

  // ── GHSA-9mrh-v2v3-xpfm regression guard ──
  // The advisory is a COMPLETE allowedTags bypass, but only for configs that
  // allow `option`/`textarea`. We allow NO tags, so the PoC's inner payload is
  // discarded with its container. These pin that: if anyone ever adds a tag to
  // allowedTags, the PoC leaks a raw tag and these fail loudly.
  it('discards the advisory PoC instead of emitting a raw tag (option)', () => {
    const out = stripHtml('<option>&lt;img src=x onerror=alert(1)&gt;</option>');
    expect(out).not.toMatch(/<img/);
    expect(out).toBe('');
  });

  it('discards the advisory PoC instead of emitting a raw tag (textarea)', () => {
    const out = stripHtml('<textarea>&#x3C;svg onload=alert(1)&#x3E;</textarea>');
    expect(out).not.toMatch(/<svg/);
  });

  /**
   * The invariant that must hold no matter how stripHtml is implemented: the
   * return value never carries anything tag-shaped. Broader than the old
   * script|img|svg check, so a mutation payload that reassembles into some other
   * element cannot slip through.
   */
  it('never emits a raw tag for any known bypass or mutation shape', () => {
    for (const payload of [
      '<select><option>&lt;img src=x onerror=alert(1)&gt;</option></select>',
      '<option>&#60;script&#62;alert(1)&#60;/script&#62;</option>',
      '<textarea>&lt;script&gt;alert(1)&lt;/script&gt;</textarea>',
      '<noscript>&lt;img src=x onerror=alert(1)&gt;</noscript>',
      '<style>&lt;img src=x onerror=alert(1)&gt;</style>',
      '<scr<script>ipt>alert(1)</scr</script>ipt>',
      '<<script>script>alert(1)<</script>/script>',
      '&lt;&lt;script&gt;&gt;alert(1)',
      '&#38;lt;script&#38;gt;alert(1)',
      '<svg/onload=alert(1)>',
      '"><script>alert(1)</script>',
      '<a href="javascript:alert(1)">x</a>',
    ]) {
      expect(stripHtml(payload)).not.toMatch(/<\s*\/?\s*[a-zA-Z]/);
    }
  });
});

describe('sanitizeStrings', () => {
  it('strips markup from every string field', () => {
    expect(sanitizeStrings({ name: '<b>F1</b>' })).toEqual({ name: 'F1' });
  });

  it('skips the named keys — a password must survive verbatim', () => {
    // Sanitizing a password containing markup would silently change the secret
    // and lock the user out.
    const out = sanitizeStrings({ username: '<b>joe</b>', password: '<P@ss>word' }, ['password']);
    expect(out.password).toBe('<P@ss>word');
    expect(out.username).toBe('joe');
  });

  it('recurses into nested objects', () => {
    expect(sanitizeStrings({ a: { b: { c: '<i>deep</i>' } } }))
      .toEqual({ a: { b: { c: 'deep' } } });
  });

  it('handles arrays of strings and of objects', () => {
    expect(sanitizeStrings({ tags: ['<b>x</b>', 'y'], rows: [{ n: '<i>z</i>' }] }))
      .toEqual({ tags: ['x', 'y'], rows: [{ n: 'z' }] });
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
    expect((out.outer as any).name).toBe('strip');
  });
});
