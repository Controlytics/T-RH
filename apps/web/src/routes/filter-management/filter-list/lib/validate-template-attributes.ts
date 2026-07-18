/**
 * Pure helper that returns the names of any required template-attribute
 * fields the operator left blank.
 *
 * Used by both the single-filter create flow (`submitCreateFilter`) and the
 * Block/Area/AHU hierarchy create flow (`handleCreate`) in `filter-list.tsx`.
 *
 * Mirrors backend `validateAttributeValues()` in
 * `apps/api/src/modules/assets/helpers/attribute-validator.ts` for the
 * required-field check; the FE call is purely a UX guard so the operator
 * sees a single inline error instead of waiting on a 400 from the create
 * endpoint. Backend is still authoritative.
 *
 * Memory rule: feedback_dynamic_template_fields.md — create dialogs MUST
 * honor template attributeSchema fields (not just hard-coded core columns).
 * Audit H5 (2026-05-04): the hierarchy dialog ignored required fields and
 * could create Block/Area/AHU rows with blank required attributes.
 */

import type { TemplateField } from '../types';

/**
 * Return the field names of any required attributes whose value is missing
 * (undefined, null, or an all-whitespace string). Empty array means valid.
 */
export function findMissingRequiredAttributes(
  attrs: Record<string, unknown>,
  schema: TemplateField[],
): string[] {
  if (!Array.isArray(schema) || schema.length === 0) return [];
  return schema
    .filter((f) => f.required)
    .filter((f) => {
      const v = attrs[f.fieldName];
      return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
    })
    .map((f) => f.fieldName);
}
