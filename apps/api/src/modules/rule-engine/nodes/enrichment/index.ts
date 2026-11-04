import { registerNode } from '../../registry.js';
import { CALCULATE_DELTA_TYPE, calculateDelta, dropDeltaCache } from './calculate-delta.js';
import { ORIGINATOR_ATTRIBUTES_TYPE, originatorAttributes } from './originator-attributes.js';
import { ORIGINATOR_FIELDS_TYPE, originatorFields } from './originator-fields.js';
import { ORIGINATOR_TELEMETRY_TYPE, originatorTelemetry } from './originator-telemetry.js';
import { RELATED_DEVICE_ATTRIBUTES_TYPE, relatedDeviceAttributes } from './related-device-attributes.js';
import { TENANT_ATTRIBUTES_TYPE, tenantAttributes } from './tenant-attributes.js';
import { TENANT_DETAILS_TYPE, tenantDetails } from './tenant-details.js';

/**
 * Enrichment rule nodes (rule chains, 2026-11-03; Task 5). `registerAllNodes()`
 * (../index.ts) calls this on every engine start; registering is idempotent.
 *
 * The seven BUILT enrichment nodes of the catalogue (`@digilog/shared`
 * `rule-nodes.ts`). Customer attributes / details and Fetch device credentials
 * (none) and Related entity data (later) register nothing and fall to the
 * engine's UNSUPPORTED_NODE failure.
 */
export function registerEnrichmentNodes(): void {
  registerNode(CALCULATE_DELTA_TYPE, calculateDelta, { onDestroy: dropDeltaCache });
  registerNode(ORIGINATOR_ATTRIBUTES_TYPE, originatorAttributes);
  registerNode(ORIGINATOR_FIELDS_TYPE, originatorFields);
  registerNode(ORIGINATOR_TELEMETRY_TYPE, originatorTelemetry);
  registerNode(RELATED_DEVICE_ATTRIBUTES_TYPE, relatedDeviceAttributes);
  registerNode(TENANT_ATTRIBUTES_TYPE, tenantAttributes);
  registerNode(TENANT_DETAILS_TYPE, tenantDetails);
}
