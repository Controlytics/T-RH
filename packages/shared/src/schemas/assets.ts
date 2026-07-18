import { z } from 'zod';

// =============================================
// Attribute Schema Definitions
// =============================================

export const ATTRIBUTE_DATA_TYPES = [
  'TEXT', 'INTEGER', 'FLOAT', 'DATE', 'DATETIME', 'BOOLEAN', 'DROPDOWN', 'URL', 'FILE',
] as const;

export const TELEMETRY_DATA_TYPES = [
  'INTEGER', 'FLOAT', 'BOOLEAN', 'STRING', 'ENUM',
] as const;

export const RELATIONSHIP_TYPES = [
  'CONTAINS', 'CONTAINED_IN', 'CONNECTED_TO',
  'FEEDS', 'FED_BY', 'DEPENDS_ON', 'DEPENDED_ON_BY',
  'BACKS_UP', 'BACKED_UP_BY', 'MONITORS', 'MONITORED_BY',
  'CUSTOM',
] as const;

export const IDENTIFIER_TYPES = [
  'QR', 'BARCODE', 'RFID', 'NFC', 'MANUAL',
] as const;

export const ASSET_STATUSES = [
  'Active', 'Inactive', 'Under Maintenance', 'Commissioning', 'Decommissioned',
] as const;

// Inverse relationship mapping
export const INVERSE_RELATIONSHIP_MAP: Record<string, string> = {
  CONTAINS: 'CONTAINED_IN',
  CONTAINED_IN: 'CONTAINS',
  CONNECTED_TO: 'CONNECTED_TO',
  FEEDS: 'FED_BY',
  FED_BY: 'FEEDS',
  DEPENDS_ON: 'DEPENDED_ON_BY',
  DEPENDED_ON_BY: 'DEPENDS_ON',
  BACKS_UP: 'BACKED_UP_BY',
  BACKED_UP_BY: 'BACKS_UP',
  MONITORS: 'MONITORED_BY',
  MONITORED_BY: 'MONITORS',
  CUSTOM: 'CUSTOM',
};

const numericConstraintsSchema = z.object({
  enabled: z.boolean().default(false),
  min: z.number().optional(),
  max: z.number().optional(),
  resolution: z.number().positive().optional(),
}).optional();

const attributeDefinitionSchema = z.object({
  fieldName: z.string().min(1).max(100),
  dataType: z.enum(ATTRIBUTE_DATA_TYPES),
  required: z.boolean().default(false),
  defaultValue: z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()]).optional(),
  unit: z.string().max(20).optional(),
  dropdownOptions: z.array(z.string()).optional(),
  numericConstraints: numericConstraintsSchema,
});

const expectedIdentifierSchema = z.object({
  identifierType: z.enum(IDENTIFIER_TYPES),
  label: z.string().max(100).optional(),
  required: z.boolean().default(false),
});

const telemetryDefinitionSchema = z.object({
  fieldName: z.string().min(1).max(100),
  dataType: z.enum(TELEMETRY_DATA_TYPES),
  unit: z.string().max(20).optional(),
  description: z.string().max(255).optional(),
});

// Checklist question types
export const CHECKLIST_QUESTION_TYPES = [
  'PASS_FAIL', 'YES_NO', 'YES_NO_NA', 'MCQ', 'MULTI_SELECT',
  'TEXT', 'NUMERIC', 'DROPDOWN', 'PHOTO', 'DATE_TIME',
  'SIGNATURE', 'YES_NO_COMMENT', 'CALCULATED', 'CONDITIONAL',
] as const;

const checklistItemSchema = z.object({
  question: z.string().min(1).max(500),
  questionType: z.enum(CHECKLIST_QUESTION_TYPES),
  required: z.boolean().default(false),
  section: z.string().max(100).optional(),           // grouping header
  description: z.string().max(500).optional(),        // help text
  options: z.array(z.string()).default([]),            // for MCQ, MULTI_SELECT, DROPDOWN
  passCriteria: z.string().max(200).optional(),       // for PASS_FAIL
  numericUnit: z.string().max(20).optional(),         // for NUMERIC
  numericMin: z.number().optional(),                  // for NUMERIC
  numericMax: z.number().optional(),                  // for NUMERIC
  calculatedExpression: z.string().max(500).optional(), // for CALCULATED
  conditionalField: z.string().max(100).optional(),   // for CONDITIONAL — depends on which question
  conditionalValue: z.string().max(200).optional(),   // for CONDITIONAL — trigger value
});

// =============================================
// Template Schemas
// =============================================

export const TRANSPORT_TYPES = ['MQTT', 'HTTP', 'WEBSOCKET'] as const;
export const CREDENTIAL_TYPES = ['TOKEN', 'BASIC', 'X509'] as const;

export const TEMPLATE_CATEGORIES = [
  'General', 'Equipment', 'Room', 'Building', 'Sensor',
  'Vehicle', 'Utility', 'Process', 'Storage', 'Laboratory',
] as const;

// Canonical template-kind codes seeded as system kinds (isSystem=true) by
// prisma/seed.ts. SUPER_ADMIN can add additional kinds at runtime via the
// Configuration UI (Configuration → Template Kinds). The Filter Management /
// Cleaning Operations / Mobile pages route by code; system kinds preserve
// their codes to keep page-routing stable.
export const SYSTEM_TEMPLATE_KIND_CODES = [
  'BLOCK', 'AREA', 'AHU', 'FILTER', 'EQUIPMENT', 'OTHER',
] as const;
export type SystemTemplateKindCode = (typeof SYSTEM_TEMPLATE_KIND_CODES)[number];

// Validation only constrains the code shape (uppercase letters, digits,
// underscores). The list of valid codes is dynamic — fetched from
// /api/template-kinds at runtime. Server-side, the FK on AssetTemplate
// enforces the value exists in the lookup table.
const templateKindCodeSchema = z
  .string()
  .min(1)
  .max(50)
  .regex(/^[A-Z][A-Z0-9_]*$/, 'Template-kind code must be UPPER_SNAKE_CASE');

export const createAssetTemplateSchema = z.object({
  name: z.string().min(1).max(100),
  description: z.string().max(500).optional(),
  category: z.enum(TEMPLATE_CATEGORIES).default('General'),
  icon: z.string().max(50).default('box'),
  templateKind: templateKindCodeSchema.default('OTHER'),
  attributeSchema: z.array(attributeDefinitionSchema).default([]),
  telemetrySchema: z.array(telemetryDefinitionSchema).default([]),
  expectedIdentifiers: z.array(expectedIdentifierSchema).default([]),
  expectedRelationships: z.array(z.record(z.unknown())).default([]),
  statusLifecycle: z.array(z.record(z.unknown())).default([]),
  checklistSchema: z.array(checklistItemSchema).default([]),
  maxParentConnections: z.number().int().min(0).optional().default(1), // 0=no parents, 1+=limit
  maxConnections: z.number().int().min(0).optional().default(10), // 0=unlimited, N=max total connections
  // Transport & Connectivity
  dataIngestionEnabled: z.boolean().default(false),
  transportType: z.enum(TRANSPORT_TYPES).nullable().optional(),
  credentialType: z.enum(CREDENTIAL_TYPES).default('TOKEN').optional(),
  inactivityTimeout: z.number().int().min(0).default(60).optional(), // seconds
  defaultMaxDataRate: z.number().int().min(0).default(600).optional(), // max messages per window
  autoProvision: z.boolean().default(true).optional(),
});

// Cross-field validation for transport & credential type compatibility
const transportCredentialRefine = (data: Record<string, any>, ctx: z.RefinementCtx) => {
  if (data.credentialType === 'X509' && data.transportType && data.transportType !== 'MQTT') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'X.509 Certificate credentials are only supported with MQTT transport',
      path: ['credentialType'],
    });
  }
  if (data.dataIngestionEnabled && !data.transportType) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Transport protocol is required when data ingestion is enabled',
      path: ['transportType'],
    });
  }
};

export const createAssetTemplateValidated = createAssetTemplateSchema.superRefine(transportCredentialRefine);
export const updateAssetTemplateSchema = createAssetTemplateSchema.partial();

export type CreateAssetTemplateInput = z.infer<typeof createAssetTemplateSchema>;
export type UpdateAssetTemplateInput = z.infer<typeof updateAssetTemplateSchema>;

// =============================================
// Instance Schemas
// =============================================

export const createAssetInstanceSchema = z.object({
  name: z.string().min(1).max(255),
  description: z.string().optional(),
  templateId: z.string().uuid(),
  status: z.string().max(50).default('Active'),
  attributes: z.record(z.unknown()).default({}),
  telemetryConfig: z.record(z.unknown()).default({}),
  customAttributes: z.record(z.unknown()).default({}),
  parentId: z.string().uuid().nullable().optional(),
  // Audit 2026-05-05 fix #1: optional FilterDetails fields the create dialog
  // sends for filter-kind templates. Schema accepts them so the route doesn't
  // strip them before reaching instance.service.ts:111-128 which now persists
  // them onto the FilterDetails sidecar.
  // Server validates: filterSet must be 'A' or 'B' if supplied; filterProfileId
  // FK constraint catches a bad UUID. Both are silently ignored for non-FILTER
  // templates (the FilterDetails create branch never runs).
  filterSet: z.enum(['A', 'B']).nullable().optional(),
  filterProfileId: z.string().uuid().nullable().optional(),
});

export const updateAssetInstanceSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().optional(),
  status: z.string().max(50).optional(),
  attributes: z.record(z.unknown()).optional(),
  telemetryConfig: z.record(z.unknown()).optional(),
  customAttributes: z.record(z.unknown()).optional(),
  parentId: z.string().uuid().nullable().optional(),
  // Same FE/DB enum dance as createAssetInstanceSchema — EditFilterDialog
  // sends 'A'/'B' and instance.service.update() translates to the
  // Prisma `FilterSetLabel` enum (SET_A/SET_B) before upserting onto
  // FilterDetails. Both are silently ignored for non-FILTER templates.
  filterSet: z.enum(['A', 'B']).nullable().optional(),
  filterProfileId: z.string().uuid().nullable().optional(),
});

export type CreateAssetInstanceInput = z.infer<typeof createAssetInstanceSchema>;
export type UpdateAssetInstanceInput = z.infer<typeof updateAssetInstanceSchema>;

// =============================================
// Relationship Schemas
// =============================================

export const createAssetRelationshipSchema = z.object({
  sourceAssetId: z.string().uuid(),
  targetAssetId: z.string().uuid(),
  relationshipType: z.enum(RELATIONSHIP_TYPES),
  customLabel: z.string().max(100).optional(),
  notes: z.string().optional(),
});

export type CreateAssetRelationshipInput = z.infer<typeof createAssetRelationshipSchema>;

// =============================================
// Identifier Schemas
// =============================================

export const createAssetIdentifierSchema = z.object({
  assetId: z.string().uuid(),
  identifierType: z.enum(IDENTIFIER_TYPES),
  identifierValue: z.string().min(1).max(255),
  label: z.string().max(100).optional(),
  isPrimary: z.boolean().default(false),
});

export type CreateAssetIdentifierInput = z.infer<typeof createAssetIdentifierSchema>;

// =============================================
// Query Schemas
// =============================================

export const assetQuerySchema = z.object({
  search: z.string().optional(),
  templateId: z.string().uuid().optional(),
  status: z.string().optional(),
  parentId: z.string().uuid().nullable().optional(),
  isActive: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  // 2026-07-03: record lists are uncapped per user request. An OMITTED limit is
  // undefined → the service resolves it to "return ALL rows" (no Prisma `take`).
  // A provided value is honored. No default (would silently cap) and no max
  // (would hide rows past the cap) — the row count itself is the only bound.
  limit: z.coerce.number().int().min(1).optional(),
});

export const templateQuerySchema = z.object({
  search: z.string().optional(),
  isActive: z.string().optional(),
  page: z.coerce.number().int().min(1).default(1),
  // 2026-07-03: uncapped — see assetQuerySchema note above.
  limit: z.coerce.number().int().min(1).optional(),
});

export type AssetQueryInput = z.infer<typeof assetQuerySchema>;
export type TemplateQueryInput = z.infer<typeof templateQuerySchema>;



