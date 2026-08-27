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
  severities: string[] | null;
  cooldownSeconds: number;
  scopeLocationIds: string[];
  scopeInstrumentIds: string[];
}

/**
 * EXACTLY `enum AlarmSeverity` in prisma/schema.prisma (verified 2026-08-27). There is
 * no WARNING: a target narrowed to a severity the system never raises would look
 * configured and be silent forever.
 */
const SEVERITIES = ['CRITICAL', 'MAJOR', 'MINOR'];

/** Every variable any event can provide — the union the template may draw from. */
const KNOWN_VARIABLES = new Set(Object.values(ALARM_WEBHOOK_VARIABLES).flatMap((v) => [...v]));

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

  if (d.severities !== null) {
    for (const s of d.severities) {
      if (!SEVERITIES.includes(s)) return { field: 'severities', message: `Unknown severity "${s}".` };
    }
  }

  // An empty scope is LEGAL and means the target fires for nothing. Deliberate: a
  // target may be created before its instruments exist. The list route returns a
  // resolved instrument count so an accidental zero is visible on screen.
  return null;
}
