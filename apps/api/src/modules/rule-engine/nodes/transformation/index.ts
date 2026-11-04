import { registerNode } from '../../registry.js';
import { CHANGE_ORIGINATOR, changeOriginator } from './change-originator.js';
import { COPY_KEYS, copyKeys } from './copy-keys.js';
import { DEDUPLICATION, deduplication, deduplicationLifecycle } from './deduplication.js';
import { DELETE_KEYS, deleteKeys } from './delete-keys.js';
import { JSON_PATH, jsonPathNode } from './json-path.js';
import { RENAME_KEYS, renameKeys } from './rename-keys.js';
import { SCRIPT_TRANSFORM, scriptTransform } from './script.js';
import { SPLIT_ARRAY, splitArray } from './split-array.js';
import { TO_EMAIL, toEmail } from './to-email.js';

/**
 * Transformation rule nodes (rule chains, 2026-11-03; Task 4).
 * `registerAllNodes()` (../index.ts) calls this on every engine start;
 * registering is idempotent. The nine BUILT transformation types of
 * `@digilog/shared`'s catalogue, ThingsBoard's semantics — each file says which
 * ThingsBoard class it is and where it is narrowed.
 *
 * Deduplication registers lifecycle hooks, so the engine polls `rule_chains`
 * every 5 s for changed nodes (as it does for any lifecycle type).
 */
export function registerTransformationNodes(): void {
  registerNode(CHANGE_ORIGINATOR, changeOriginator);
  registerNode(COPY_KEYS, copyKeys);
  registerNode(DEDUPLICATION, deduplication, deduplicationLifecycle);
  registerNode(DELETE_KEYS, deleteKeys);
  registerNode(JSON_PATH, jsonPathNode);
  registerNode(RENAME_KEYS, renameKeys);
  registerNode(SCRIPT_TRANSFORM, scriptTransform);
  registerNode(SPLIT_ARRAY, splitArray);
  registerNode(TO_EMAIL, toEmail);
}
