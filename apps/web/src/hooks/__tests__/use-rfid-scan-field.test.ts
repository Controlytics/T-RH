/**
 * Unit tests for useRfidScanField.
 *
 * Pins the three contracts:
 *   1) onChange replaces with only the new suffix when a fresh scan burst
 *      lands on top of an RFID-shaped old value. Critical: the OLD bug
 *      this addresses is scanning "TAG002" into a field that already held
 *      "TAG001" producing "TAG001TAG002" instead of "TAG002". The
 *      revision 2026-05-26 moved this detection into onChange (not
 *      onKeyDown) because controlled `<input>` re-applies React state
 *      to the DOM in the same tick, so an onKeyDown clear gets
 *      overwritten by the onChange that fires next.
 *   2) onChange strips CR/LF/tab and trims whitespace.
 *   3) isDuplicate returns true only for the same value within 1000ms.
 *
 * The hook is consumed by:
 *   - mobile-wrapper.tsx RFID Assign view (existing input)
 *   - mobile-wrapper.tsx Filter Status → Scan RFID modal
 */
import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useRfidScanField } from '../use-rfid-scan-field';

function makeKeyEvent(key: string): React.KeyboardEvent<HTMLInputElement> {
  return {
    key,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  } as any;
}

function makeChangeEvent(value: string): React.ChangeEvent<HTMLInputElement> {
  return { target: { value } } as any;
}

describe('useRfidScanField', () => {
  it('starts empty', () => {
    const { result } = renderHook(() => useRfidScanField());
    expect(result.current.value).toBe('');
  });

  it('setValue updates the controlled value', () => {
    const { result } = renderHook(() => useRfidScanField());
    act(() => result.current.setValue('CA000C01'));
    expect(result.current.value).toBe('CA000C01');
  });

  it('onChange strips CR/LF/tab characters', () => {
    const { result } = renderHook(() => useRfidScanField());
    act(() => result.current.onChange(makeChangeEvent('CA000C01\r\n')));
    expect(result.current.value).toBe('CA000C01');
  });

  it('onChange trims leading/trailing whitespace', () => {
    const { result } = renderHook(() => useRfidScanField());
    act(() => result.current.onChange(makeChangeEvent('   CA000C01   ')));
    expect(result.current.value).toBe('CA000C01');
  });

  it('onChange typed normally: every char appends to running value', () => {
    // Mid-burst (gap < 300ms between each key) — should accumulate normally.
    const { result } = renderHook(() => useRfidScanField());
    act(() => result.current.onChange(makeChangeEvent('C')));
    act(() => result.current.onChange(makeChangeEvent('CA')));
    act(() => result.current.onChange(makeChangeEvent('CA0')));
    expect(result.current.value).toBe('CA0');
  });

  it('SECOND scan replaces old RFID-shaped value with only the new suffix', async () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRfidScanField());

    // Burst 1: simulate scanning CA000C01
    act(() => result.current.onChange(makeChangeEvent('CA000C01')));
    expect(result.current.value).toBe('CA000C01');

    // Time passes (scanner is idle between scans for >1s in practice).
    vi.advanceTimersByTime(1500);

    // Burst 2: scanner emits keys T-A-G-X-X-X-X-X. Each native input event
    // sees the DOM value = old + new chars so far (because the DOM has the
    // appended chars from the previous render's controlled-value plus the
    // new keystrokes).
    act(() => result.current.onChange(makeChangeEvent('CA000C01T')));
    // The hook should detect this is a new burst on top of an RFID-shaped
    // old value and keep only the new suffix.
    expect(result.current.value).toBe('T');

    // Subsequent chars in burst 2 fire rapidly (no new burst trigger).
    act(() => result.current.onChange(makeChangeEvent('TA')));
    expect(result.current.value).toBe('TA');
    act(() => result.current.onChange(makeChangeEvent('TAG002')));
    expect(result.current.value).toBe('TAG002');

    vi.useRealTimers();
  });

  it('does NOT replace when old value is too short (manual typing protected)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRfidScanField());

    // Old value 'AB' is below the 6-char RFID-shape threshold.
    act(() => result.current.onChange(makeChangeEvent('AB')));
    expect(result.current.value).toBe('AB');

    // Time passes (operator paused while typing manually).
    vi.advanceTimersByTime(1000);

    // Next char arrives — append, not replace.
    act(() => result.current.onChange(makeChangeEvent('ABC')));
    expect(result.current.value).toBe('ABC');

    vi.useRealTimers();
  });

  it('does NOT replace when old value contains non-alphanumeric (not RFID-shaped)', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRfidScanField());

    // 'Hello!' has 6 chars but the '!' fails the alphanumeric check.
    act(() => result.current.onChange(makeChangeEvent('Hello!')));
    vi.advanceTimersByTime(1000);
    act(() => result.current.onChange(makeChangeEvent('Hello!X')));
    expect(result.current.value).toBe('Hello!X');

    vi.useRealTimers();
  });

  it('Enter resets the idle timer so the burst AFTER Enter is recognised as new', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRfidScanField());

    // Burst 1
    act(() => result.current.onChange(makeChangeEvent('CA000C01')));
    // Enter fires — should reset the idle timer
    act(() => result.current.onKeyDown(makeKeyEvent('Enter')));

    // No simulated time passes here — without the Enter reset, gap would
    // still be tiny and the next onChange would APPEND instead of replace.
    act(() => result.current.onChange(makeChangeEvent('CA000C01T')));
    expect(result.current.value).toBe('T');

    vi.useRealTimers();
  });

  it('onKeyDown is a no-op for non-Enter keys (detection lives in onChange)', () => {
    const { result } = renderHook(() => useRfidScanField());
    act(() => result.current.setValue('CA000C01'));
    act(() => result.current.onKeyDown(makeKeyEvent('A')));
    // No mutation — value is unchanged by onKeyDown alone.
    expect(result.current.value).toBe('CA000C01');
  });

  it('isDuplicate returns true on the same value submitted within 1000ms', () => {
    const { result } = renderHook(() => useRfidScanField());
    expect(result.current.isDuplicate('CA000C01')).toBe(false);
    expect(result.current.isDuplicate('CA000C01')).toBe(true);
    // Different value resets the dedupe
    expect(result.current.isDuplicate('CA000C03')).toBe(false);
  });

  it('isDuplicate returns false after the 1000ms window', () => {
    vi.useFakeTimers();
    const { result } = renderHook(() => useRfidScanField());
    expect(result.current.isDuplicate('CA000C01')).toBe(false);
    vi.advanceTimersByTime(1100);
    expect(result.current.isDuplicate('CA000C01')).toBe(false);
    vi.useRealTimers();
  });

  it('isDuplicate returns false on empty input', () => {
    const { result } = renderHook(() => useRfidScanField());
    expect(result.current.isDuplicate('')).toBe(false);
  });

  it('setValue("") clears both state and the dedupe / idle refs', () => {
    const { result } = renderHook(() => useRfidScanField());
    act(() => result.current.setValue('CA000C01'));
    act(() => result.current.setValue(''));
    expect(result.current.value).toBe('');
  });
});
