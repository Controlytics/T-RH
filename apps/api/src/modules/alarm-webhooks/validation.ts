/**
 * Validation for an alarm-webhook target draft.
 *
 * Design: docs/superpowers/specs/2026-08-27-alarm-webhook-annunciator-design.md
 *
 * Everything here is checked BEFORE storage. A target is configured once and then
 * fires unattended for months; a fault that only shows up at send time shows up
 * during an excursion, which is the worst possible moment to discover it.
 */

import {
  ALARM_WEBHOOK_METHODS,
  ALARM_WEBHOOK_VARIABLES,
  type AlarmWebhookMethod,
} from '@digilog/shared';

export interface TargetFieldError { field: string; message: string }

export interface TargetDraft {
  name: string;
  description?: string | null;
  url: string;
  method: string;
  headers: Record<string, string>;
  contentType: string;
  bodyTemplate: string;
  successRegex: string | null;
  timeoutMs: number;
  cooldownSeconds: number;
  scopeLocationIds: string[];
  scopeInstrumentIds: string[];
}

/** Every variable any event can provide — the union the template may draw from. */
const KNOWN_VARIABLES = new Set(Object.values(ALARM_WEBHOOK_VARIABLES).flatMap((v) => [...v]));

/**
 * Why the stored headers could not be sent, or null. Judged by the SAME
 * `Headers` constructor `fetch` applies at delivery, so the two cannot drift;
 * each pair is tried alone so the message names the offending header.
 */
export function invalidHeader(headers: unknown): string | null {
  if (headers === undefined || headers === null) return null;
  if (typeof headers !== 'object' || Array.isArray(headers)) return 'Headers must be a map of header name to value.';
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (typeof value !== 'string') return `Header "${name}" must have a string value.`;
    try {
      new Headers({ [name]: value });
    } catch {
      return `Header "${name}" cannot be sent: the name or its value is not a valid HTTP header (check for spaces in the name or line breaks in the value).`;
    }
  }
  return null;
}

export function validateTargetDraft(d: TargetDraft): TargetFieldError | null {
  if (!d.name?.trim()) return { field: 'name', message: 'Name is required.' };

  // http/https only. NOT an allowlist — a hooter lives on the operator's LAN and any
  // allowlist would have to contain it. This rejects file:/ftp:/gopher: schemes, which
  // no hooter speaks and which fetch would treat very differently.
  let parsed: URL;
  try { parsed = new URL(d.url); } catch { return { field: 'url', message: 'Enter a full URL, e.g. http://192.168.1.60/alarm' }; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { field: 'url', message: 'URL must start with http:// or https://' };
  }

  if (!ALARM_WEBHOOK_METHODS.includes(d.method as AlarmWebhookMethod)) {
    return { field: 'method', message: `Method must be one of ${ALARM_WEBHOOK_METHODS.join(', ')}.` };
  }

  // Headers are handed to `fetch` as-is at send time (deliver.ts). A name with
  // a space or a value carrying CR/LF is refused by `Headers` with a TypeError
  // — inside the worker, on EVERY delivery, during an excursion, with the log
  // row saying only that fetch threw. The same constructor is the judge here,
  // so what is stored is exactly what will send (audit 2026-10-03, API-20).
  const headerProblem = invalidHeader(d.headers);
  if (headerProblem) return { field: 'headers', message: headerProblem };

  if (!d.bodyTemplate?.trim()) return { field: 'bodyTemplate', message: 'Body template is required.' };

  // Caught HERE rather than at send time: an unknown placeholder renders literally, so
  // the hooter would receive `${nonsence}` in a regulated payload and nobody would know
  // until an excursion.
  for (const m of d.bodyTemplate.matchAll(/\$\{([^}]+)\}/g)) {
    const key = m[1].trim();
    if (!KNOWN_VARIABLES.has(key)) {
      return { field: 'bodyTemplate', message: `Unknown variable \${${key}}.` };
    }
  }

  // Validated before storage so a bad pattern can never reach the worker, where it
  // would fail every delivery closed with no obvious cause.
  if (d.successRegex) {
    try { new RegExp(d.successRegex); }
    catch { return { field: 'successRegex', message: 'Not a valid regular expression.' }; }
  }

  if (!Number.isInteger(d.timeoutMs) || d.timeoutMs < 100 || d.timeoutMs > 60_000) {
    return { field: 'timeoutMs', message: 'Timeout must be between 100 and 60000 ms.' };
  }
  if (!Number.isInteger(d.cooldownSeconds) || d.cooldownSeconds < 0 || d.cooldownSeconds > 86_400) {
    return { field: 'cooldownSeconds', message: 'Cooldown must be between 0 and 86400 seconds.' };
  }

  // An empty scope is LEGAL and means the target fires for nothing. Deliberate: a
  // target may be created before its instruments exist. The list route returns a
  // resolved instrument count so an accidental zero is visible on screen.
  return null;
}
