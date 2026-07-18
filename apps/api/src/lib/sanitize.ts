/**
 * Input sanitization using sanitize-html library.
 * Strips all HTML tags, attributes, and entities to prevent XSS attacks.
 */
import sanitizeHtml from 'sanitize-html';

/**
 * Strip all HTML from a string to prevent XSS attacks.
 * Uses sanitize-html library which handles:
 * - HTML tags and attributes
 * - HTML entities (e.g., &lt;script&gt;)
 * - CSS expressions
 * - JavaScript URIs (javascript:, data:)
 * - Event handlers (onclick, onerror, etc.)
 */
export function stripHtml(value: string): string {
  return sanitizeHtml(value, {
    allowedTags: [],
    allowedAttributes: {},
    disallowedTagsMode: 'recursiveEscape',
  }).trim();
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
