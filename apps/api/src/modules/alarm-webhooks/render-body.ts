/**
 * Renders a webhook body template.
 *
 * DELIBERATELY NOT notification-delivery/template-engine.ts:resolveTemplate(). That
 * function HTML-escapes every substituted value (`"` -> `&quot;`, `&` -> `&amp;`),
 * which is right for an email body and wrong for a JSON payload. Instrument codes
 * here are unrestricted free text by design, so an instrument named
 * `Chiller "A" & B` would produce a body the hooter rejects as malformed —
 * intermittently, for one instrument, looking exactly like a network fault.
 */

const VARIABLE_REGEX = /\$\{([^}]+)\}/g;

function isJson(contentType: string): boolean {
  return contentType.toLowerCase().includes('json');
}

/** Escapes for insertion INSIDE a JSON string literal (no surrounding quotes). */
function jsonInner(value: string): string {
  const quoted = JSON.stringify(value);
  return quoted.slice(1, -1);
}

export function renderWebhookBody(
  template: string,
  variables: Record<string, string>,
  contentType: string,
): string {
  const escape = isJson(contentType) ? jsonInner : (v: string) => v;
  return template.replace(VARIABLE_REGEX, (match, key: string) => {
    const value = variables[key.trim()];
    // An unknown placeholder stays literal — matching resolveTemplate's behaviour —
    // so a typo shows up in the stored requestBody instead of becoming "".
    if (value === undefined) return match;
    return escape(String(value));
  });
}
