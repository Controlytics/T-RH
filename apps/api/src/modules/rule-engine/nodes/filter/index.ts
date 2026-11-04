import { registerNode } from '../../registry.js';
import { ALARM_STATUS_FILTER, alarmStatusFilter } from './alarm-status-filter.js';
import { CHECK_FIELDS_PRESENCE, checkFieldsPresence } from './check-fields-presence.js';
import { CHECK_RELATION_PRESENCE, checkRelationPresence } from './check-relation-presence.js';
import { DEVICE_PROFILE_SWITCH, deviceProfileSwitch } from './device-profile-switch.js';
import { ENTITY_TYPE_FILTER, entityTypeFilter } from './entity-type-filter.js';
import { ENTITY_TYPE_SWITCH, entityTypeSwitch } from './entity-type-switch.js';
import { MESSAGE_TYPE_FILTER, messageTypeFilter } from './message-type-filter.js';
import { MESSAGE_TYPE_SWITCH, messageTypeSwitch } from './message-type-switch.js';
import { SCRIPT_FILTER, scriptFilter } from './script.js';
import { SWITCH, switchNode } from './switch.js';

/**
 * Filter rule nodes (rule chains, 2026-11-03; Task 4). `registerAllNodes()`
 * (../index.ts) calls this on every engine start; registering is idempotent.
 * The ten BUILT filter types of `@digilog/shared`'s catalogue, ThingsBoard's
 * semantics — each file says which ThingsBoard class it is and where it is
 * narrowed.
 */
export function registerFilterNodes(): void {
  registerNode(ALARM_STATUS_FILTER, alarmStatusFilter);
  registerNode(CHECK_FIELDS_PRESENCE, checkFieldsPresence);
  registerNode(CHECK_RELATION_PRESENCE, checkRelationPresence);
  registerNode(DEVICE_PROFILE_SWITCH, deviceProfileSwitch);
  registerNode(ENTITY_TYPE_FILTER, entityTypeFilter);
  registerNode(ENTITY_TYPE_SWITCH, entityTypeSwitch);
  registerNode(MESSAGE_TYPE_FILTER, messageTypeFilter);
  registerNode(MESSAGE_TYPE_SWITCH, messageTypeSwitch);
  registerNode(SCRIPT_FILTER, scriptFilter);
  registerNode(SWITCH, switchNode);
}
