import { z } from 'zod';

export const brandingConfigSchema = z.object({
  // Logo & App Identity
  appName: z.string().min(1).max(50).default('DigiLog'),
  appTagline: z.string().max(100).default('21 CFR Part 11 Compliant Digital Logbook'),
  logoText: z.string().min(1).max(5).default('DL'),
  logoUrl: z.string().max(3000000).default(''), // URL or data URI for logo image; ~3M chars ≈ a 2MB base64 image (raised from 500k 2026-06-29)

  // Company Info
  companyName: z.string().min(1).max(100).default('Controlytics AI Pvt Ltd'),
  version: z.string().min(1).max(20).default('1.0'),

  // Colors
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#1e3a5f'),
  secondaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3b82f6'),
  accentColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#8b5cf6'),

  // Gradient colors for decorative elements
  gradientStart: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#3b82f6'),
  gradientMiddle: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#8b5cf6'),
  gradientEnd: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#ec4899'),

  // Background colors
  loginBgStart: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#0f172a'),
  loginBgEnd: z.string().regex(/^#[0-9A-Fa-f]{6}$/).default('#1e3a5f'),
  // Color theme preset
  colorTheme: z.string().default('ocean'),
});

export const passwordPolicySchema = z.object({
  // Password Settings
  minLength: z.number().min(8).max(32).default(8),
  maxLength: z.number().min(32).max(128).default(128),
  requireUppercase: z.boolean().default(true),
  requireLowercase: z.boolean().default(true),
  requireNumbers: z.boolean().default(true),
  requireSpecialChars: z.boolean().default(true),
  minUppercase: z.number().min(0).default(1),
  minLowercase: z.number().min(0).default(1),
  minNumbers: z.number().min(0).default(1),
  minSpecialChars: z.number().min(0).default(1),
  preventReuseCount: z.number().min(1).max(24).default(12),
  cannotBeUserId: z.boolean().default(true),
  cannotContainUserId: z.boolean().default(true),

  // Login Security Settings (moved from loginSecuritySchema)
  maxFailedAttempts: z.number().min(3).max(10).default(5),

  // Password Expiry
  passwordExpiryDays: z.number().min(0).max(365).default(90), // 0 = disabled
  // Days before expiry to start warning the affected user (one notification per
  // day for the last N days, plus a one-time notice on the expiry day). 0 = off.
  expiryNotificationDays: z.number().min(0).max(90).default(0),

  // Session Settings (moved from sessionConfigSchema)
  autoLogoutEnabled: z.boolean().default(true),
  idleTimeoutMinutes: z.number().min(5).max(60).default(15),
  warningMinutes: z.number().min(1).max(5).default(2),
});

// Keep these schemas for backward compatibility with existing data
export const loginSecuritySchema = z.object({
  lockoutType: z.enum(['TEMPORARY', 'PERMANENT']).default('TEMPORARY'),
  lockoutDurationMinutes: z.number().min(15).max(1440).default(30),
});

export const sessionConfigSchema = z.object({
  sessionDurationHours: z.number().min(1).max(24).default(8),
  autoLogoutEnabled: z.boolean().default(true),
  idleTimeoutMinutes: z.number().min(5).max(60).default(15),
  warningMinutes: z.number().min(1).max(5).default(2),
});

export const datetimeConfigSchema = z.object({
  dateFormat: z.enum(['DD/MM/YYYY', 'MM/DD/YYYY', 'YYYY-MM-DD', 'DD-MMM-YYYY', 'MMM DD, YYYY']).default('DD/MM/YYYY'),
  timeFormat: z.enum(['12-hour', '24-hour']).default('24-hour'),
  timezone: z.literal('Asia/Kolkata').default('Asia/Kolkata'),
});

// User ID Configuration Schema
export const userIdConfigSchema = z.object({
  // Format type
  format: z.enum([
    'NUMBERS_ONLY',           // e.g., 12345
    'LETTERS_ONLY',           // e.g., ABCDE
    'LETTERS_NUMBERS',        // e.g., ABC123
    'PREFIX_NUMBERS',         // e.g., EMP001
    'PREFIX_LETTERS',         // e.g., USR-ABC
    'PREFIX_LETTERS_NUMBERS', // e.g., EMP-AB12
    'CUSTOM_PATTERN',         // Custom regex pattern
  ]).default('LETTERS_NUMBERS'),

  // Length settings (fixed length)
  length: z.number().min(3).max(20).default(6),

  // Prefix settings (when format includes PREFIX_*)
  prefix: z.string().max(10).default(''),
  prefixSeparator: z.enum(['-', '_', '', '/']).default('-'),

  // Case settings for letters
  letterCase: z.enum(['UPPERCASE', 'LOWERCASE', 'MIXED']).default('UPPERCASE'),

  // Auto-generation settings
  autoGenerate: z.boolean().default(false),
  startNumber: z.number().min(1).default(1),

  // Custom pattern (regex) - only used when format is CUSTOM_PATTERN
  customPattern: z.string().max(100).default(''),
  customPatternExample: z.string().max(50).default(''),
  customPatternDescription: z.string().max(200).default(''),
});

// Audit Templates Configuration Schema
export const auditTemplatesSchema = z.record(z.string(), z.string());

// Pagination Configuration Schema
export const paginationConfigSchema = z.object({
  limit: z.number().min(5).max(1000).default(100),
  count: z.number().min(2).max(10).default(3),
  options: z.array(z.number().min(5)).min(2).max(10).default([10, 25, 50]),
}).refine(data => data.options.every(opt => opt <= data.limit), {
  message: 'All option values must be less than or equal to the limit',
  path: ['options'],
});

// Export Limit Configuration Schema (SUPER_ADMIN-only).
//
// Guards report/export size. Client-side PDF (jsPDF) / Excel (xlsx) generation
// builds the whole file in the browser tab's memory and OOMs past tens of
// thousands of rows. `maxRecords` is the configurable SOFT limit; the zod
// `.max()` is the HARD ceiling the admin can never exceed (set below the
// observed ~50–60k failure point). `message` is the user-facing text shown when
// an export is blocked — `{count}` (attempted rows) and `{max}` (the limit) are
// substituted at render time; either placeholder may be omitted safely.
export const EXPORT_LIMIT_HARD_CEILING = 50000;
export const EXPORT_LIMIT_DEFAULT_MAX = 10000;
export const EXPORT_LIMIT_DEFAULT_MESSAGE =
  'The current filters match {count} records, which exceeds the maximum export limit of {max}. Please narrow your date range or filters and try again.';

export const exportLimitConfigSchema = z.object({
  maxRecords: z.number().int().min(1).max(EXPORT_LIMIT_HARD_CEILING).default(EXPORT_LIMIT_DEFAULT_MAX),
  message: z.string().min(1).max(500).default(EXPORT_LIMIT_DEFAULT_MESSAGE),
});
export type ExportLimitConfig = z.infer<typeof exportLimitConfigSchema>;

// Offline Cache Configuration Schema (SUPER_ADMIN-only).
//
// `cacheStalenessHours` — TTL applied to client-side snapshot caches
// (filter state, templates, cleaning reasons, equipment groups, etc.). After
// this many hours since the entry was written, the client treats the entry as
// stale and forces a refetch on next read. Mobile previously hardcoded 24h;
// desktop had no TTL. The configured value now applies to both.
//
// `cacheHardCutoffHours` — defense-in-depth read-only-lockout threshold. If
// the client has had NO successful server contact for this many hours, the
// UI enters a read-only mode (banner + blocker; mutations refused). Designed
// for the 21 CFR Part 11 posture where an operator on a tablet must not
// continue producing records against a server they can no longer verify
// against.
export const offlineCacheConfigSchema = z.object({
  cacheStalenessHours: z.number().min(0.01).max(168).default(24),
  cacheHardCutoffHours: z.number().min(0.01).max(168).default(24),
});

export type BrandingConfig = z.infer<typeof brandingConfigSchema>;
export type PasswordPolicyConfig = z.infer<typeof passwordPolicySchema>;
export type LoginSecurityConfig = z.infer<typeof loginSecuritySchema>;
export type SessionConfig = z.infer<typeof sessionConfigSchema>;
export type DatetimeConfig = z.infer<typeof datetimeConfigSchema>;
export type UserIdConfig = z.infer<typeof userIdConfigSchema>;
export type AuditTemplatesConfig = z.infer<typeof auditTemplatesSchema>;
export type PaginationConfig = z.infer<typeof paginationConfigSchema>;
export type OfflineCacheConfig = z.infer<typeof offlineCacheConfigSchema>;

// Instrument Attributes Configuration (SUPER_ADMIN-only).
//
// Which attribute KEYS the New Instrument form asks for. Values are entered per
// instrument by whoever registers it; the keys are administered here so the
// same idea does not end up stored as "Room", "room" and "Room No" across three
// operators, which is what makes a free-form key/value store unfilterable.
//
// Stored as one key per line because an admin editing this is writing a list of
// words — JSON punctuation would be a way for that to fail. `parseInstrument
// AttributeKeys` is the single definition of what a line means, so the form and
// any later consumer cannot disagree.
export const INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT = 'Block\nArea\nLocation\nRoom\nCalibration Due\nAsset Tag';

/**
 * Three keys that are NOT stored as attribute rows: they are real columns on
 * the instrument (`block` / `area` / `location`), because the Instruments list
 * filters on them and its Placement column reads them.
 *
 * They appear in the configured key list like any other key — the operator sees
 * one Attributes section and no special-cased trio (2026-08-07 request) — and
 * the create form routes them to their column instead of writing an attribute.
 * Left as plain attributes they would look identical on screen while quietly
 * emptying the placement filters for every instrument registered from then on.
 *
 * Matched case-insensitively, since the key list is free text.
 */
export const INSTRUMENT_PLACEMENT_COLUMNS: Record<string, 'block' | 'area' | 'location'> = {
  block: 'block',
  area: 'area',
  location: 'location',
};

/** The instrument column a configured key writes to, or null for an attribute. */
export function placementColumnFor(key: string): 'block' | 'area' | 'location' | null {
  return INSTRUMENT_PLACEMENT_COLUMNS[key.trim().toLowerCase()] ?? null;
}
export const instrumentAttributesConfigSchema = z.object({
  keys: z.string().max(2000).default(INSTRUMENT_ATTRIBUTE_KEYS_DEFAULT),
});
export type InstrumentAttributesConfig = z.infer<typeof instrumentAttributesConfigSchema>;

/**
 * One key per line. Trimmed, blanks dropped, duplicates removed
 * CASE-INSENSITIVELY (the whole point is to stop "Room" and "room" both
 * existing), first spelling wins.
 *
 * NOT capped (2026-08-07, operator decision — a 25-key ceiling was tried and
 * removed). The only bound is the setting's own `max(2000)` characters, which
 * is a storage guard on the stored string, not a judgement about how long a
 * registration form ought to be. If the form ever gets unwieldy, fix it in the
 * form's layout, not by silently discarding keys an admin deliberately added:
 * dropping key 26 without saying so is the kind of quiet data loss that is
 * found months later.
 */
export function parseInstrumentAttributeKeys(raw: string | null | undefined): string[] {
  if (!raw) return [];
  const seen = new Set<string>();
  const keys: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const key = line.trim();
    if (!key) continue;
    const fold = key.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    keys.push(key);
  }
  return keys;
}

// Instrument Activity Configuration (SUPER_ADMIN-only).
//
// When does an instrument count as ACTIVE? "It is sending telemetry" needs a
// cut-off, and the cut-off is a site decision, not ours: a cleanroom probe
// reporting every 30s and a calibration rig read once a shift are both healthy,
// and a fixed window would libel one of them.
//
// Two-tier, deliberately. An instrument that declares `expectedIntervalSec` is
// judged against ITS OWN contract (times the slack below) — that is the honest
// measure and it needs no configuration. `activeWindowMinutes` is the fallback
// for the instruments that declare nothing, which in practice is most of them.
export const INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN = 1440; // 24 hours
/**
 * Slack on a declared interval before it counts as missed. A device reporting
 * every 60s is not inactive at 61s — jitter, retries and clock skew all live in
 * that gap, and a status that flickers on jitter is one people stop reading.
 */
export const INSTRUMENT_ACTIVE_INTERVAL_SLACK = 2;

export const instrumentActivityConfigSchema = z.object({
  activeWindowMinutes: z.coerce.number().int().min(1).max(525_600).default(INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN),
});
export type InstrumentActivityConfig = z.infer<typeof instrumentActivityConfigSchema>;

/**
 * Is this instrument currently receiving telemetry?
 *
 * `now` is injected, never read from a global: a status the whole page is
 * coloured on cannot be tested at a fixed point otherwise.
 *
 * Says nothing about whether the instrument is ENABLED. A disabled instrument
 * cannot report, so it will also read inactive here — but the two are different
 * facts (nobody turned it off vs we turned it off) and the UI shows them
 * separately.
 */
export function isInstrumentReporting(
  lastSeenAt: string | Date | null | undefined,
  expectedIntervalSec: number | null | undefined,
  activeWindowMinutes: number = INSTRUMENT_ACTIVE_WINDOW_DEFAULT_MIN,
  now: Date = new Date(),
): boolean {
  if (!lastSeenAt) return false;
  const age = now.getTime() - new Date(lastSeenAt).getTime();
  // A device whose clock runs ahead reports a future timestamp. Treat it as
  // fresh rather than as infinitely stale.
  if (age <= 0) return true;
  const limit = expectedIntervalSec
    ? expectedIntervalSec * 1000 * INSTRUMENT_ACTIVE_INTERVAL_SLACK
    : activeWindowMinutes * 60_000;
  return age <= limit;
}
