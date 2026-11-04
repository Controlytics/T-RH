import { registerNode } from '../../registry.js';
import { CLEAR_ALARM_TYPE, clearAlarm } from './clear-alarm.js';
import { CREATE_ALARM_TYPE, createAlarm } from './create-alarm.js';
import { DELAY_TYPE, delay } from './delay.js';
import { DELETE_ATTRIBUTES_TYPE, SAVE_ATTRIBUTES_TYPE, deleteAttributes, saveAttributes } from './attributes.js';
import { DEVICE_PROFILE_TYPE, deviceProfile } from './device-profile.js';
import { GENERATOR_TYPE, generatorInput, startGenerator, stopGenerator } from './generator.js';
import { LOG_TYPE, logNode } from './log.js';
import { MATH_FUNCTION_TYPE, mathFunction } from './math-function.js';
import { MESSAGE_COUNT_TYPE, countMessage, startMessageCount, stopMessageCount } from './message-count.js';
import { SAVE_TIMESERIES_TYPE, saveTimeseries } from './save-timeseries.js';

/**
 * Action rule nodes (rule chains, 2026-11-03; Task 5). `registerAllNodes()`
 * (../index.ts) calls this on every engine start; registering is idempotent.
 *
 * The eleven BUILT action nodes of the catalogue (`@digilog/shared`
 * `rule-nodes.ts`; Device profile joined them 2026-11-04 as a pass-through).
 * Every `later` / `none` action type registers nothing and falls to the
 * engine's UNSUPPORTED_NODE failure. Generator and Message count have a
 * lifecycle (their timers).
 */
export function registerActionNodes(): void {
  registerNode(CLEAR_ALARM_TYPE, clearAlarm);
  registerNode(CREATE_ALARM_TYPE, createAlarm);
  registerNode(DELAY_TYPE, delay);
  registerNode(DELETE_ATTRIBUTES_TYPE, deleteAttributes);
  registerNode(DEVICE_PROFILE_TYPE, deviceProfile);
  registerNode(GENERATOR_TYPE, generatorInput, { onInit: startGenerator, onDestroy: stopGenerator });
  registerNode(LOG_TYPE, logNode);
  registerNode(MATH_FUNCTION_TYPE, mathFunction);
  registerNode(MESSAGE_COUNT_TYPE, countMessage, { onInit: startMessageCount, onDestroy: stopMessageCount });
  registerNode(SAVE_ATTRIBUTES_TYPE, saveAttributes);
  registerNode(SAVE_TIMESERIES_TYPE, saveTimeseries);
}
