/**
 * PARAM_CAPTURE block parameter guards (Phase 8.5).
 *
 * Pure portions of advance() in
 * `apps/api/src/modules/filter-operations/filter-operations.service.ts`
 * (lines 1263-1282). Validates the caller-submitted `parameters` map against
 * the profile's `PARAM_CAPTURE` block configurations.
 */
import type { GuardResult, LocalContext } from './types.js';

/**
 * Per-parameter definition from a PARAM_CAPTURE block configuration.
 *
 * Mirrors the shape inside `block.configuration.parameters[i]`:
 *   { key: string; label: string; required?: boolean; min?: number; max?: number }
 */
export interface ParameterDef {
  key: string;
  label: string;
  required?: boolean;
  min?: number;
  max?: number;
}

/**
 * Per-call shape of the `parameters` map: `{ [key]: { value: number | string } }`.
 * Mirrors the original `parameters[param.key].value` access at line 1272.
 */
export type ParameterValueMap = Record<string, { value: number | string } | undefined>;

/**
 * Guard #18: required parameters present.
 *
 * Mirrors advance():1268-1270 — for each required parameter def, throw if
 * the parameters map either omits the key or has a falsy entry.
 *
 * Returns on the FIRST missing required param (preserving original behavior
 * + the original parity-test fixture set).
 */
export function assertParametersRequired(
  _ctx: LocalContext,
  parameters: ParameterValueMap | null | undefined,
  paramDefs: ParameterDef[],
): GuardResult {
  for (const param of paramDefs) {
    if (!param.required) continue;
    const entry = parameters?.[param.key];
    if (!entry) {
      return {
        ok: false,
        code: 'PARAM_REQUIRED',
        message: `Required parameter missing: ${param.label}`,
      };
    }
  }
  return { ok: true };
}

/**
 * Guard #19: parameters in min/max bounds.
 *
 * Mirrors advance():1271-1280. Throws on first failure; min < failure has
 * its own message, max > failure has its own message — exact mirror of source.
 */
export function assertParametersInRange(
  _ctx: LocalContext,
  parameters: ParameterValueMap | null | undefined,
  paramDefs: ParameterDef[],
): GuardResult {
  if (!parameters) return { ok: true };
  for (const param of paramDefs) {
    const entry = parameters[param.key];
    if (!entry) continue; // not present — required-check already caught it
    const val = entry.value as number;
    if (param.min !== undefined && val < param.min) {
      return {
        ok: false,
        code: 'PARAM_OUT_OF_RANGE',
        message: `${param.label} below minimum (${param.min})`,
      };
    }
    if (param.max !== undefined && val > param.max) {
      return {
        ok: false,
        code: 'PARAM_OUT_OF_RANGE',
        message: `${param.label} above maximum (${param.max})`,
      };
    }
  }
  return { ok: true };
}

/**
 * Helper: extract all PARAM_CAPTURE parameter defs from a profile's nodes.
 * Mirrors advance():1263-1267.
 */
export function extractParameterDefs(
  nodes: Array<{ nodeType: string; configuration: unknown }>,
): ParameterDef[] {
  const defs: ParameterDef[] = [];
  for (const block of nodes) {
    if (block.nodeType !== 'PARAM_CAPTURE') continue;
    const config = block.configuration as { parameters?: ParameterDef[] } | null;
    if (!config?.parameters) continue;
    for (const p of config.parameters) defs.push(p);
  }
  return defs;
}
