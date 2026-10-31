/**
 * Modbus TCP protocol layer (FC 03 / 04, read-only). Imports nothing from the
 * API — only node built-ins and @digilog/shared — so it can move into its own
 * package unchanged.
 */
export { readDevice, type ReadDeviceOptions, type ReadResult } from './client.js';
export { planReads, wordKey, type ReadRequest } from './plan.js';
export { decodeMap, type Rejected } from './decode.js';
export {
  modbusErrorMessage,
  DEFAULT_CONNECT_TIMEOUT_MS,
  DEFAULT_RESPONSE_TIMEOUT_MS,
  type ModbusErrorCode,
  type ModbusErrorContext,
} from './errors.js';
