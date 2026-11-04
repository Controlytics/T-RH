import { registerUnsupportedNode } from './unsupported.js';
import { registerFilterNodes } from './filter/index.js';
import { registerEnrichmentNodes } from './enrichment/index.js';
import { registerTransformationNodes } from './transformation/index.js';
import { registerActionNodes } from './action/index.js';
import { registerExternalNodes } from './external/index.js';
import { registerFlowNodes } from './flow/index.js';

/**
 * Registers every rule node handler (rule chains, 2026-11-03). `engine.start()`
 * calls `registerAllNodes()` once per start; registering is idempotent.
 *
 * ONE FILE PER GROUP: each task registers its handlers in its own group's
 * `nodes/<group>/index.ts` (filter, transformation, flow — Task 4; enrichment,
 * action — Task 5; external — Task 6). Nobody edits THIS file.
 *
 * A type with no registered handler sends every message to `Failure` with
 * `metadata.error = "UNSUPPORTED_NODE: …"` (engine.ts, unsupported.ts).
 */
export function registerAllNodes(): void {
  registerUnsupportedNode();
  registerFilterNodes();
  registerEnrichmentNodes();
  registerTransformationNodes();
  registerActionNodes();
  registerExternalNodes();
  registerFlowNodes();
}
