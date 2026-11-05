import { RULE_MATH_OPERATIONS, RULE_RELATION_SUCCESS } from '@digilog/shared';
import type { RuleContext } from '../../context.js';
import { copyMessage, RULE_ENGINE_ORIGIN_KEY, type RuleMessage } from '../../message.js';
import { compileExpression, evaluateExpression } from './math-expression.js';
import {
  ATTRIBUTE_SCOPES, bodyFields, instrumentIdOf, javaDoubleToString, javaLong, javaLongText, processPattern, roundHalfUp, toNumber,
  type JsonObject,
} from './support.js';

/**
 * MATH FUNCTION — ThingsBoard's `TbMathNode` (rule chains, Task 5).
 *
 * ARGUMENTS, each a number from: MESSAGE_BODY (a key of the message data),
 * MESSAGE_METADATA, ATTRIBUTE (the
 * originator instrument's attribute), TIME_SERIES (its latest reading) or
 * CONSTANT (the key IS the number). A quoted number is a number; a missing
 * value takes `defaultValue`, else the message FAILS naming it. ATTRIBUTE /
 * TIME_SERIES keys may be patterns.
 *
 * OPERATIONS: ThingsBoard's list with Java's semantics — trigonometry in
 * radians; FLOOR_DIV / FLOOR_MOD on the arguments truncated to whole numbers
 * (Java's `(long)` cast, then `Math.floorDiv` / `floorMod`; a zero divisor
 * fails); GET_EXP is `Math.getExponent` (the unbiased binary exponent); RAD /
 * DEG Java's constants. CUSTOM evaluates `customFunction` over the arguments BY
 * NAME with a small parser of ThingsBoard's own grammar (exp4j: `^` is power,
 * implicit multiplication, its functions and constants) — NOT the script VM,
 * where `x^2` would be XOR (`math-expression.ts`). A result that is not a
 * finite number (√−1, x / 0, log 0) FAILS rather than store NaN or Infinity.
 *
 * RESULT (ThingsBoard's rule, TB-P 2026-11-05): for GET_EXP / CEIL / FLOOR or
 * at `resultValuePrecision` 0 (also when it is absent, as ThingsBoard's `int`
 * defaults) the result is TRUNCATED toward zero (`(long) value` — 7.5 → 7, no
 * rounding); otherwise rounded HALF_UP to the precision. It goes to
 * MESSAGE_BODY, MESSAGE_METADATA (text: `Long.toString` / `Double.toString` —
 * "7", "5.0", "1.0E7"), ATTRIBUTE (saved through the attribute writer,
 * `attributeScope`, as the text of the number; NO Attributes Updated message, as
 * TbMathNode sends none) or TIME_SERIES (written at the server time through the
 * ingest write path — the UNROUNDED result, as ThingsBoard's `DoubleDataEntry(result)`);
 * for the last two `addToBody` / `addToMetadata` also put the truncated / rounded
 * value on the message. Out on `Success`.
 *
 * NARROWED / KEPT DIFFERENT: a result that is not finite FAILS (ThingsBoard
 * stores `(long) NaN = 0` / Long.MAX on the integer path and fails on the double
 * path); ATTRIBUTE / TIME_SERIES result keys are patterns everywhere (ThingsBoard
 * saves under the RAW key text and puts the processed key on the message).
 */
export const MATH_FUNCTION_TYPE = 'tb:action:math-function';

type ArgType = 'ATTRIBUTE' | 'TIME_SERIES' | 'MESSAGE_BODY' | 'MESSAGE_METADATA' | 'CONSTANT';
interface MathArgument { name?: string | null; type: ArgType; key: string; defaultValue?: number | null; attributeScope?: string | null }
interface MathResult {
  type: 'ATTRIBUTE' | 'TIME_SERIES' | 'MESSAGE_BODY' | 'MESSAGE_METADATA';
  key: string;
  resultValuePrecision?: number;
  addToBody?: boolean;
  addToMetadata?: boolean;
  attributeScope?: string | null;
}
interface MathConfig extends JsonObject {
  operation: string;
  customFunction?: string | null;
  arguments: MathArgument[];
  result: MathResult;
}

const DEGREES_TO_RADIANS = 0.017453292519943295;
const RADIANS_TO_DEGREES = 57.29577951308232;

/** Java's `Math.getExponent(double)`: the unbiased exponent — −1023 for 0 and subnormals, 1024 for NaN / ∞. */
export function getExponent(x: number): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setFloat64(0, x);
  return ((view.getUint16(0) >>> 4) & 0x7ff) - 1023;
}

function floorDiv(x: number, y: number): number {
  const a = Math.trunc(x);
  const b = Math.trunc(y);
  if (b === 0) throw new Error('MATH_DIVISION_BY_ZERO: / by zero');
  return Math.floor(a / b);
}

const ONE: Record<string, (a: number) => number> = {
  SIN: Math.sin, SINH: Math.sinh, COS: Math.cos, COSH: Math.cosh, TAN: Math.tan, TANH: Math.tanh,
  ACOS: Math.acos, ASIN: Math.asin, ATAN: Math.atan, EXP: Math.exp, EXPM1: Math.expm1, SQRT: Math.sqrt,
  CBRT: Math.cbrt, GET_EXP: getExponent, LOG: Math.log, LOG10: Math.log10, LOG1P: Math.log1p,
  CEIL: Math.ceil, FLOOR: Math.floor, ABS: Math.abs, SIGNUM: Math.sign,
  RAD: (a) => a * DEGREES_TO_RADIANS, DEG: (a) => a * RADIANS_TO_DEGREES,
};
const TWO: Record<string, (a: number, b: number) => number> = {
  ADD: (a, b) => a + b, SUB: (a, b) => a - b, MULT: (a, b) => a * b, DIV: (a, b) => a / b,
  ATAN2: Math.atan2, HYPOT: Math.hypot, MIN: Math.min, MAX: Math.max, POW: Math.pow,
  FLOOR_DIV: floorDiv, FLOOR_MOD: (a, b) => Math.trunc(a) - floorDiv(a, b) * Math.trunc(b),
};

const keyOf = (type: string, key: string, msg: RuleMessage) =>
  (type === 'ATTRIBUTE' || type === 'TIME_SERIES' ? processPattern(String(key ?? ''), msg).trim() : String(key ?? ''));

async function argumentValues(ctx: RuleContext<MathConfig>, msg: RuleMessage, args: MathArgument[]): Promise<number[]> {
  const keys = args.map((a) => keyOf(a.type, a.key, msg));
  const attrKeys = [...new Set(keys.filter((_, i) => args[i].type === 'ATTRIBUTE'))];
  const tsKeys = [...new Set(keys.filter((_, i) => args[i].type === 'TIME_SERIES'))];
  const instrumentId = attrKeys.length > 0 || tsKeys.length > 0 ? instrumentIdOf(msg, 'Math function') : null;
  const [attributes, latest] = await Promise.all([
    instrumentId && attrKeys.length > 0 ? ctx.services.attributes.get(instrumentId, attrKeys) : Promise.resolve({} as Record<string, string>),
    instrumentId && tsKeys.length > 0 ? ctx.services.telemetry.latest(instrumentId, tsKeys) : Promise.resolve({} as Record<string, { value: unknown }>),
  ]);
  const fields = bodyFields(msg.data);
  return args.map((arg, i) => {
    const key = keys[i];
    let raw: unknown;
    let found: boolean;
    let missing: string;
    switch (arg.type) {
      case 'CONSTANT': {
        const n = toNumber(key);
        if (n === null) throw new Error(`MATH_ARGUMENT_INVALID: the constant "${key}" is not a number`);
        return n;
      }
      case 'MESSAGE_BODY':
        found = !!fields && Object.prototype.hasOwnProperty.call(fields, key);
        raw = found ? fields![key] : undefined;
        missing = `Message body has no '${key}'`;
        break;
      case 'MESSAGE_METADATA':
        found = Object.prototype.hasOwnProperty.call(msg.metadata, key);
        raw = found ? msg.metadata[key] : undefined;
        missing = `Message metadata has no '${key}'`;
        break;
      case 'ATTRIBUTE':
        found = Object.prototype.hasOwnProperty.call(attributes, key);
        raw = found ? attributes[key] : undefined;
        missing = `Attribute '${key}' was not found on the originator instrument`;
        break;
      case 'TIME_SERIES':
        found = Object.prototype.hasOwnProperty.call(latest, key);
        raw = found ? latest[key].value : undefined;
        missing = `Latest reading '${key}' was not found on the originator instrument`;
        break;
      default:
        throw new Error(`MATH_ARGUMENT_INVALID: unknown argument type "${String((arg as { type: unknown }).type)}"`);
    }
    if (!found || raw === null || raw === undefined) {
      if (typeof arg.defaultValue === 'number' && Number.isFinite(arg.defaultValue)) return arg.defaultValue;
      throw new Error(missing);
    }
    const n = toNumber(raw);
    if (n === null) throw new Error(`Can't convert value '${typeof raw === 'string' ? raw : JSON.stringify(raw)}' to double!`);
    return n;
  });
}

function operate(cfg: MathConfig, values: number[]): number {
  const op = cfg.operation;
  const spec = RULE_MATH_OPERATIONS.find((o) => o.value === op);
  if (!spec) throw new Error(`MATH_OPERATION_UNKNOWN: "${op}"`);
  if (values.length < spec.minArgs || values.length > spec.maxArgs) {
    throw new Error(`MATH_ARGUMENTS_INVALID: ${op} takes ${spec.minArgs === spec.maxArgs ? spec.minArgs : `${spec.minArgs} to ${spec.maxArgs}`} argument(s), not ${values.length}`);
  }
  if (op === 'CUSTOM') {
    const vars: Record<string, number> = {};
    cfg.arguments.forEach((a, i) => {
      const name = typeof a.name === 'string' ? a.name.trim() : '';
      if (!name) throw new Error('MATH_ARGUMENTS_INVALID: a CUSTOM expression names its arguments — argument ' + (i + 1) + ' has no name');
      vars[name] = values[i];
    });
    return evaluateExpression(compileExpression(cfg.customFunction ?? ''), vars);
  }
  if (ONE[op]) return ONE[op](values[0]);
  return TWO[op](values[0], values[1]);
}

/** ThingsBoard's `TbRuleNodeMathFunctionType.isIntegerResult()`: the three functions whose result is a whole number. */
const INTEGER_RESULT_OPERATIONS = new Set(['GET_EXP', 'CEIL', 'FLOOR']);

export async function mathFunction(ctx: RuleContext<MathConfig>, msg: RuleMessage): Promise<void> {
  const cfg = ctx.config;
  const args = Array.isArray(cfg.arguments) ? cfg.arguments : [];
  const result = operate(cfg, await argumentValues(ctx, msg, args));
  if (!Number.isFinite(result)) throw new Error(`MATH_RESULT_NOT_FINITE: ${cfg.operation} came out as ${result}`);
  const res = cfg.result;
  const precision = typeof res.resultValuePrecision === 'number' && res.resultValuePrecision >= 0 ? Math.floor(res.resultValuePrecision) : 0;
  // TbMathNode.isIntegerResult: an integer-result function OR precision 0 → `(long) value`
  // (toward zero, no rounding), written as a long; otherwise HALF_UP at the precision,
  // written in metadata by `Double.toString` ("5.0").
  const integer = INTEGER_RESULT_OPERATIONS.has(cfg.operation) || precision === 0;
  const value = integer ? javaLong(result) : roundHalfUp(result, precision);
  const text = integer ? javaLongText(result) : javaDoubleToString(value);
  const key = keyOf(res.type, res.key, msg);
  if (!key) throw new Error('MATH_RESULT_KEY_REQUIRED: the result key came out blank');

  const out = copyMessage(msg);
  const toBody = () => {
    const fields = bodyFields(out.data);
    if (!fields) throw new Error('DATA_NOT_OBJECT: Math function writes into the message data, which is not a JSON object');
    fields[key] = value;
  };
  switch (res.type) {
    case 'MESSAGE_BODY':
      toBody();
      break;
    case 'MESSAGE_METADATA':
      out.metadata[key] = text;
      break;
    case 'ATTRIBUTE': {
      const scope = typeof res.attributeScope === 'string' && (ATTRIBUTE_SCOPES as readonly string[]).includes(res.attributeScope) ? res.attributeScope : 'SERVER_SCOPE';
      // No Attributes Updated message: TbMathNode.saveAttribute passes no notification callback.
      await ctx.services.attributes.save(instrumentIdOf(msg, 'Math function'), { [key]: String(value) }, ctx.origin, false, scope, { updated: 'none' });
      if (res.addToBody === true) toBody();
      if (res.addToMetadata === true) out.metadata[key] = text;
      break;
    }
    case 'TIME_SERIES':
      // ThingsBoard stores the UNROUNDED result (`new DoubleDataEntry(key, result)`); only the
      // copies added to the message are truncated / rounded (ruling P-3).
      // The message rides along (review A I2): a reading this changes is audited as the rule engine, naming it.
      await ctx.services.telemetry.write(instrumentIdOf(msg, 'Math function'), [{ key, value: result, ts: new Date() }], ctx.origin,
        { message: { id: msg.id, origin: msg.metadata[RULE_ENGINE_ORIGIN_KEY] } });
      if (res.addToBody === true) toBody();
      if (res.addToMetadata === true) out.metadata[key] = text;
      break;
    default:
      throw new Error(`MATH_RESULT_INVALID: unknown result type "${String((res as { type: unknown }).type)}"`);
  }
  ctx.tellNext(out, RULE_RELATION_SUCCESS);
}
