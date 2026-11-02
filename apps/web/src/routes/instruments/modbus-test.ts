import { MODBUS_UNIT_ID, type ModbusRegisterMap } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import type { StatusTone } from '@/components/ui/status-badge';

/**
 * `POST /api/instruments/modbus/test` — ONE module for the request, the
 * answer's shape and the words a failure is shown with, used by the whole-map
 * Test connection panel and the register map's per-key Test (change request
 * CR-1, ledger Ruling CR1-2: a per-key Test is this same route with a one-key
 * map). Two copies of the pill vocabulary would drift into two words for one
 * failure.
 *
 * Nothing here decides anything about the device: the values, the failure
 * sentence and which key is judged are the response's. The browser checks only
 * that the request is COMPLETE (an address, a port, a Slave ID) before sending
 * it — whether the address is allowed, in use, or answering is the server's.
 */

/** What the SERVER said a key is judged as (the response's `judgedAs`). */
export type JudgedAs = 'TEMPERATURE' | 'HUMIDITY' | null;

/** The server's answer, as it sends it. */
export type TestAnswer =
  | {
    ok: true;
    elapsedMs: number;
    requests: number;
    values: { key: string; value: unknown; judgedAs: JudgedAs }[];
    rejected: { key: string; reason: string }[];
  }
  | { ok: false; code: string; message: string };

/**
 * A request the server refused outright (400 / 403 / 429): its status, code and
 * message. `status` is kept because a 429 from the rate-limit plugin carries no
 * code of ours — its `error` is the HTTP phrase "Too Many Requests".
 */
export interface Refusal { refused: true; status: number | undefined; code: string | undefined; message: string }

export type TestOutcome = TestAnswer | Refusal;
export type Failure = Refusal | Extract<TestAnswer, { ok: false }>;

/** Where and how to read: the address, the Slave ID, and the instrument it is (if stored). */
export interface TestTarget {
  profileId: string;
  host: string;
  port: number;
  unitId: number;
  /** A stored instrument, so its own address is not reported as in use. */
  instrumentId?: string;
}

/** The request body. Serialised, it is also the SIGNATURE a result was read with. */
export function testBody(target: TestTarget, map: ModbusRegisterMap): Record<string, unknown> {
  return {
    profileId: target.profileId,
    modbusHost: target.host,
    modbusPort: target.port,
    modbusUnitId: target.unitId,
    modbusRegisters: map,
    ...(target.instrumentId ? { instrumentId: target.instrumentId } : {}),
  };
}

/**
 * Why a target cannot be tested yet, or null when it can. Completeness only —
 * the words name the field to fill, never a rule of the server's.
 */
export function targetProblem(target: Pick<TestTarget, 'host' | 'port' | 'unitId'>): string | null {
  if (target.host.trim() === '') return 'Set the IP address to test.';
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) return 'Set a port from 1 to 65535 to test.';
  if (!Number.isInteger(target.unitId) || target.unitId < MODBUS_UNIT_ID.min || target.unitId > MODBUS_UNIT_ID.max) {
    return `Set a Slave ID from ${MODBUS_UNIT_ID.min} to ${MODBUS_UNIT_ID.max} to test.`;
  }
  return null;
}

/** Sends the request; a refusal comes back as a `Refusal`, never as a throw. */
export async function runModbusTest(body: Record<string, unknown>): Promise<TestOutcome> {
  try {
    return await apiClient.post<TestAnswer>('/api/instruments/modbus/test', body);
  } catch (err) {
    const e = err as { message?: string; code?: string; status?: number };
    return { refused: true, status: e.status, code: e.code, message: e.message ?? 'The test could not be run.' };
  }
}

export const isAnswered = (o: TestOutcome): o is Extract<TestAnswer, { ok: true }> => 'ok' in o && o.ok;

/**
 * The pill for a failure. The CODE picks only the word and the colour; the
 * sentence beside it is the server's `message`, printed verbatim. A device
 * that failed is red; a setting or another instrument standing in the way is
 * amber. A code not listed (a 403) still prints its message.
 */
const PILL: Record<string, { tone: StatusTone; word: string }> = {
  NO_ANSWER: { tone: 'danger', word: 'No answer' },
  REFUSED: { tone: 'danger', word: 'Refused' },
  DEVICE_EXCEPTION: { tone: 'danger', word: 'Register refused' },
  BAD_RESPONSE: { tone: 'danger', word: 'Bad answer' },
  READING_OFF: { tone: 'warn', word: 'Reading off' },
  ADDRESS_IN_USE: { tone: 'warn', word: 'In use' },
  ADDRESS_NOT_ALLOWED: { tone: 'warn', word: 'Not allowed' },
  VALIDATION_ERROR: { tone: 'warn', word: 'Invalid' },
};
/** 30 tests a minute per user (ledger Ruling CR1-7); the sentence is the server's. */
const TOO_MANY = { tone: 'warn' as StatusTone, word: 'Too many tests' };
const NOT_TESTED = { tone: 'danger' as StatusTone, word: 'Not tested' };

export function pillFor(failure: Failure): { tone: StatusTone; word: string } {
  if ('refused' in failure && failure.status === 429) return TOO_MANY;
  return (failure.code && PILL[failure.code]) || NOT_TESTED;
}

/** "Temperature" / "Humidity" for a judged key, null for one the server did not judge. */
export function judgedWord(j: JudgedAs): string | null {
  if (j === 'TEMPERATURE') return 'Temperature';
  if (j === 'HUMIDITY') return 'Humidity';
  return null;
}
