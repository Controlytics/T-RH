/**
 * Input sanitization using sanitize-html library.
 * Strips all HTML tags, attributes, and entities to prevent XSS attacks.
 */
import sanitizeHtml from 'sanitize-html';

const TAG_LIKE = /<\s*\/?\s*[a-zA-Z]/;

/**
 * sanitize-html only ever EMITS these three entities in a text context (verified
 * against unicode, numeric and named-entity inputs: `&copy;` → `©`, `&#x1F600;`
 * → 😀, quotes and apostrophes pass through raw). So decoding this set is
 * complete for our own output — which is all we need, since arbitrary input
 * entities are normalised by the parser before we ever see them. `&quot;`/`&#39;`
 * are included defensively in case the config gains an attribute context.
 *
 * Single regex pass on purpose: replacements do not cascade within a pass, so
 * `&amp;lt;` decodes to `&lt;` and NOT to `<`. The loop below is what converges
 * multiply-encoded input, under the fail-safe.
 */
const ENTITY = /&(lt|gt|quot|#39|amp);/g;
const ENTITY_MAP: Record<string, string> = {
  '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&amp;': '&',
};
const decodeBasic = (v: string): string => v.replace(ENTITY, (m) => ENTITY_MAP[m]);

/**
 * Remove HTML from a string, returning PLAIN TEXT.
 *
 * Previously this escaped instead of stripping (`disallowedTagsMode:
 * 'recursiveEscape'`), which was safe but corrupted ordinary operator text:
 * `R&D Dept` was stored as `R&amp;D Dept`, and since React escapes again on
 * output it rendered on screen as `R&amp;D Dept`. Ampersands are common in real
 * names (R&D, Q&A, "Wear & tear"), so that mangling was guaranteed to bite.
 *
 * Trade-off, deliberate and lossy in the other direction: stripping DISCARDS the
 * content of anything tag-shaped, so `Filter <spare> unit` becomes `Filter unit`
 * where escaping would have preserved it as `Filter &lt;spare&gt; unit`.
 * Angle-bracket words in operator text are far rarer than ampersands.
 *
 * Sanitize→decode is iterated to a fixed point because decoding can REVIVE
 * markup: pre-encoded `&lt;script&gt;` decodes to a live `<script>` tag, and a
 * single strip+decode would have stored it verbatim. That matters beyond the
 * SPA (which escapes on output) — notification email templates render HTML.
 */
export function stripHtml(value: string): string {
  const strip = (v: string) => sanitizeHtml(v, { allowedTags: [], allowedAttributes: {} });

  let cur = value;
  for (let i = 0; i < 5; i++) {
    const next = decodeBasic(strip(cur));
    if (next === cur) break;
    cur = next;
  }

  // FAIL SAFE. The loop's last operation is a decode, so a value that exits on
  // the iteration cap rather than converging could still carry revived markup.
  // Never return markup: fall back to the old escaping mode, which is lossy in
  // appearance but cannot emit a raw tag.
  if (TAG_LIKE.test(cur)) {
    return sanitizeHtml(value, {
      allowedTags: [],
      allowedAttributes: {},
      disallowedTagsMode: 'recursiveEscape',
    }).trim();
  }
  return cur.trim();
}

/**
 * Sanitize all string fields in an object (recursive — handles nested objects and arrays).
 * Skips null/undefined values and non-string types.
 * Optionally skip specific keys (e.g., 'password', 'passwordHash').
 */
export function sanitizeStrings<T extends Record<string, any>>(
  obj: T,
  skipKeys: string[] = [],
): T {
  const result = { ...obj };
  for (const key of Object.keys(result)) {
    if (skipKeys.includes(key)) continue;
    if (typeof result[key] === 'string') {
      (result as any)[key] = stripHtml(result[key]);
    } else if (result[key] && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      (result as any)[key] = sanitizeStrings(result[key], skipKeys);
    } else if (Array.isArray(result[key])) {
      (result as any)[key] = result[key].map((item: any) =>
        typeof item === 'string' ? stripHtml(item) :
        (item && typeof item === 'object') ? sanitizeStrings(item, skipKeys) : item
      );
    }
  }
  return result;
}
