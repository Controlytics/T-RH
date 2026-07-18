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
