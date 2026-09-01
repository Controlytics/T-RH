import { describe, it, expect } from 'vitest';
import { decideRs485, type Rs485Sample } from '../rs485-decide.js';
import { isSensorFailureValue, renderRawValue, describeRs485, coerceReading } from '@digilog/shared';

const sample = (over: Partial<Rs485Sample> = {}): Rs485Sample => ({
  value: 21.5,
  isActive: true,
  hasOpenAlarm: false,
  ...over,
});

describe('what counts as a sensor failure', () => {
  it('accepts a finite number, and 0 is a real reading', () => {
    expect(isSensorFailureValue(21.5)).toBe(false);
    expect(isSensorFailureValue(0)).toBe(false);
    expect(isSensorFailureValue(-40)).toBe(false);
  });

  it('rejects the text a failed RS485 probe actually sends', () => {
    expect(isSensorFailureValue('NA')).toBe(true);
    expect(isSensorFailureValue('ERR')).toBe(true);
  });

  it('ACCEPTS a quoted number — it is a reading, not a fault', () => {
    // Reversed on operator instruction, 2026-08-31: a device that sends "23.5"
    // has reported 23.5, and JSON quoting is a firmware artefact, not a broken
    // probe. Safe only because `coerceReading` is the ONE definition every
    // consumer uses — the dashboard plots it and the limits judge it too.
    expect(isSensorFailureValue('23.5')).toBe(false);
    expect(isSensorFailureValue(' -40 ')).toBe(false);
    expect(coerceReading('23.5')).toBe(23.5);
  });

  it('still refuses an EMPTY string — Number("") is 0 and that is a trap', () => {
    expect(isSensorFailureValue('')).toBe(true);
    expect(isSensorFailureValue('   ')).toBe(true);
    expect(coerceReading('')).toBeNull();
  });

  it('still refuses a number with a unit or a word', () => {
    expect(isSensorFailureValue('25 C')).toBe(true);
    expect(isSensorFailureValue('NA')).toBe(true);
  });

  it('rejects NaN, Infinity, booleans, objects and null', () => {
    expect(isSensorFailureValue(NaN)).toBe(true);
    expect(isSensorFailureValue(Infinity)).toBe(true);
    expect(isSensorFailureValue(true)).toBe(true);
    expect(isSensorFailureValue({ v: 1 })).toBe(true);
    expect(isSensorFailureValue(null)).toBe(true);
  });
});

describe('raising', () => {
  it('raises on a non-numeric reading', () => {
    expect(decideRs485(sample({ value: 'NA' }))).toBe('raise');
  });

  it('does not raise on a good reading', () => {
    expect(decideRs485(sample({ value: 21.5 }))).toBe('none');
    expect(decideRs485(sample({ value: 0 }))).toBe('none');
  });

  it('does not raise when the instrument sent nothing on this slot', () => {
    // A temperature-only logger has no humidity key, and an instrument that has
    // never reported has neither. Silence is INACTIVITY's question.
    expect(decideRs485(sample({ value: undefined }))).toBe('none');
  });

  it('does not raise for a decommissioned instrument', () => {
    expect(decideRs485(sample({ value: 'NA', isActive: false }))).toBe('none');
  });

  it('does not raise a second time while one is already open', () => {
    expect(decideRs485(sample({ value: 'NA', hasOpenAlarm: true }))).toBe('none');
  });
});

describe('clearing — the rule that inverts the inactivity pass', () => {
  it('clears when a NUMBER arrives again', () => {
    expect(decideRs485(sample({ value: 21.5, hasOpenAlarm: true }))).toBe('clear');
    expect(decideRs485(sample({ value: 0, hasOpenAlarm: true }))).toBe('clear');
  });

  it('HOLDS the alarm open when the instrument goes silent', () => {
    // The single most important case in this file. Silence cannot prove a probe
    // was repaired, and the moment a broken device falls quiet is precisely when
    // the fault is LEAST resolved. An inactivity-shaped pass would clear here.
    expect(decideRs485(sample({ value: undefined, hasOpenAlarm: true }))).toBe('none');
  });

  it('HOLDS the alarm open while the sensor keeps reporting rubbish', () => {
    expect(decideRs485(sample({ value: 'NA', hasOpenAlarm: true }))).toBe('none');
  });

  it('clears an open alarm even on a decommissioned instrument', () => {
    // Retiring an instrument must not strand an open regulated record. The
    // isActive guard suppresses RAISING, which is a different question.
    expect(decideRs485(sample({ value: 21.5, isActive: false, hasOpenAlarm: true }))).toBe('clear');
  });
});

describe('how the offending value is recorded', () => {
  it('writes a string bare — the quotes are transport, not something the sensor said', () => {
    expect(renderRawValue('NA')).toBe('NA');
  });

  it('keeps a non-string legible rather than printing [object Object]', () => {
    expect(renderRawValue(true)).toBe('true');
    expect(renderRawValue({ v: 1 })).toBe('{"v":1}');
  });

  it('truncates, so a chatty device cannot fill an audit column or a webhook body', () => {
    const long = 'X'.repeat(500);
    const out = renderRawValue(long);
    expect(out.length).toBe(120);
    expect(out.endsWith('…')).toBe(true);
  });

  it('names the metric and the value in one wording used by server and browser', () => {
    expect(describeRs485('TEMPERATURE', 'NA')).toBe('temperature reported NA instead of a number');
    expect(describeRs485('HUMIDITY', 'ERR')).toBe('humidity reported ERR instead of a number');
  });
});
