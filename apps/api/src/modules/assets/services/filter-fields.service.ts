// Single source for the concrete Filter field-option master data. Per the
// A-01 direction (D2=A), filter fields come from the runtime
// `filter-field-options` config — NOT the asset-template attributeSchema.
// Used by single-create (Slice 1) and bulk upload (Slice 2).
import { prisma } from '../../../lib/prisma.js';
import { stripHtml } from '../../../lib/sanitize.js';

export interface FilterFieldOptions {
  ahuType: string[];
  filterType: string[];
  micronSize: string[];
  filterSize: string[];
}

export interface FilterFieldInput {
  ahuType?: string | null;
  filterType?: string | null;
  micronSize?: string | null;
  filterSize?: string | null; // physical dimensions, e.g. 610×610×292mm — distinct from micronSize
  lastCleaningDate?: string | null; // 'NA' | 'YYYY-MM-DD' | '' | null
}

// The attribute keys `validateAndBuildFilterAttributes` owns. update() walks
// this list to tell "field omitted → don't touch" apart from "field sent empty
// → clear it"; the builder itself cannot report that (both look like an absent
// key in its output).
export const FILTER_ATTRIBUTE_FIELDS = ['ahuType', 'filterType', 'micronSize', 'filterSize', 'lastCleaningDate'] as const;

export interface FilterFieldError { field: string; value: string; message: string; }
export interface FilterFieldResult { attributes: Record<string, unknown>; errors: FilterFieldError[]; }

// Short in-memory cache so a 200-row bulk upload (each row validates + each
// create re-validates) collapses to ONE config query instead of 400+ (audit
// perf N+1). 10s TTL — longer than any single request, far shorter than the
// gap between an admin editing field-options and re-downloading a template.
let _optsCache: { opts: FilterFieldOptions; at: number } | null = null;
const FIELD_OPTIONS_TTL_MS = 10_000;

// Reads the same config row the web app reads via GET /api/filters/field-options.
export async function loadFilterFieldOptions(): Promise<FilterFieldOptions> {
  if (_optsCache && Date.now() - _optsCache.at < FIELD_OPTIONS_TTL_MS) return _optsCache.opts;
  const row = await prisma.systemConfig.findUnique({ where: { configKey: 'filter-field-options' } });
  const stored = row?.configValue as { value?: Record<string, unknown> } | undefined;
  const inner = (stored && typeof stored === 'object' && 'value' in stored ? stored.value : {}) ?? {};
  const opts: FilterFieldOptions = {
    ahuType: Array.isArray((inner as any).ahuType) ? ((inner as any).ahuType as string[]) : ['Process', 'Non Process'],
    filterType: Array.isArray((inner as any).filterType) ? ((inner as any).filterType as string[]) : [],
    micronSize: Array.isArray((inner as any).micronSize) ? ((inner as any).micronSize as string[]) : [],
    filterSize: Array.isArray((inner as any).filterSize) ? ((inner as any).filterSize as string[]) : [],
  };
  _optsCache = { opts, at: Date.now() };
  return opts;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Optional-but-validated, mirroring single-create (no asterisk there): a blank
// field is omitted; a present field must be in the live master-data list.
export async function validateAndBuildFilterAttributes(input: FilterFieldInput): Promise<FilterFieldResult> {
  const opts = await loadFilterFieldOptions();
  const attributes: Record<string, unknown> = {};
  const errors: FilterFieldError[] = [];

  const checkList = (field: 'ahuType' | 'filterType' | 'micronSize', list: string[]) => {
    const raw = (input[field] ?? '').toString().trim();
    if (!raw) return;
    const match = list.find((o) => o.toLowerCase() === raw.toLowerCase());
    if (!match) errors.push({ field, value: raw, message: `must be one of: ${list.join(', ')}` });
    else attributes[field] = match;
  };
  checkList('ahuType', opts.ahuType);
  checkList('filterType', opts.filterType);
  checkList('micronSize', opts.micronSize);

  // filterSize is FREE TEXT (physical dimensions, e.g. "610×610×292mm") — NOT a
  // dropdown. Trim + strip HTML and store if non-empty; no master-data validation.
  const fsizeRaw = stripHtml((input.filterSize ?? '').toString()).trim();
  if (fsizeRaw) attributes.filterSize = fsizeRaw;

  const lcd = (input.lastCleaningDate ?? '').toString().trim();
  if (lcd) {
    if (lcd.toUpperCase() === 'NA') {
      attributes.lastCleaningDate = 'NA';
    } else if (ISO_DATE.test(lcd) && new Date(`${lcd}T00:00:00Z`).toISOString().slice(0, 10) === lcd) {
      // Round-trip guards against calendar-invalid dates (e.g. 2026-02-30,
      // which Date.parse silently rolls over) — must reject for 21 CFR records.
      attributes.lastCleaningDate = lcd;
    } else {
      errors.push({ field: 'lastCleaningDate', value: lcd, message: 'must be a date (YYYY-MM-DD) or NA' });
    }
  }

  return { attributes, errors };
}
