/**
 * useRfidScanField — controlled-input helpers for RFID scan fields.
 *
 * 2026-05-26 — built in response to a tablet bug on the RFID Assign page:
 * scanning a second RFID tag without clearing the field first concatenated
 * the new tag onto the existing value (TAG001 + TAG002 → "TAG001TAG002").
 * Root cause: a plain controlled `<input value={state} onChange=…>` has no
 * notion of "a new scan is starting" — every keystroke just appends.
 *
 * 2026-05-26 (revision) — operator follow-up: even after the initial fix,
 * tags were arriving as "half IDs" or in unexpected order. The first cut
 * tried to clear the field in onKeyDown BEFORE onChange fired, but a
 * controlled `<input>` re-applies React state to the DOM in the same tick,
 * so the onChange that fires next sees the full appended DOM value and
 * overwrites the cleared state with the appended string. The clear never
 * took effect.
 *
 * The fix in this revision moves all detection into onChange where we
 * have both the new DOM value AND the previous React state via a ref
 * (avoids the stale-closure trap). When we detect "new burst appended
 * onto an RFID-shaped old value", we keep only the new suffix.
 *
 * Behavior contracts:
 *
 *  1) Replace-only-the-new-suffix when a fresh scan burst lands on top
 *     of a previously-scanned tag.
 *     If the new DOM value starts with the previous React value AND the
 *     time gap is >300ms (= clear post-scan idle, not mid-burst) AND the
 *     previous value looks like an RFID (≥6 alphanumeric chars), we keep
 *     only the appended suffix. This catches every flavour of the
 *     "TAG001TAG002" append bug without dropping characters from
 *     slow manual typing.
 *
 *  2) Strip CR/LF/tab on every change.
 *     RFID readers in UKB mode often append \r, \n, or both at the end
 *     of a scan. Consumers always see a clean value with no terminator.
 *     Leading/trailing whitespace is also trimmed.
 *
 *  3) Duplicate-submit guard via isDuplicate(value).
 *     Returns true if the exact same value was submitted within the last
 *     1000ms. Callers should skip their submit when it returns true.
 *
 * Usage:
 *
 *   const rfid = useRfidScanField();
 *   <input
 *     data-rfid="true"
 *     value={rfid.value}
 *     onKeyDown={rfid.onKeyDown}
 *     onChange={rfid.onChange}
 *     autoFocus
 *   />
 *   <button onClick={() => {
 *     if (rfid.isDuplicate(rfid.value)) return;
 *     submit(rfid.value);
 *     rfid.setValue('');
 *   }}>Assign</button>
 *
 * `onKeyDown` is exported for two reasons: (a) parent components may
 * still want to intercept Enter for form submit (the assign button does);
 * (b) it resets the internal idle timer on Enter so that the burst AFTER
 * an Enter-terminated scan is recognised as "new" even though the gap
 * isn't naturally >300ms yet.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

interface UseRfidScanField {
  value: string;
  setValue: (v: string) => void;
  onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
  /**
   * Returns true if `value` was submitted within the dedupe window
   * (defaults to 1000ms). Caller should NOT proceed with the submit
   * when this returns true. On first-time / distinct submits, returns
   * false and arms the dedupe ref for the next call.
   */
  isDuplicate: (value: string) => boolean;
}

// Gap between input events that signals "this is a NEW scan burst, not
// a continuation of the old one". KC-series UHF readers in UKB mode emit
// characters at 3-50ms intervals during a scan and require ~1s between
// physical scans. 300ms catches the new burst while never tripping
// mid-scan.
const NEW_SCAN_IDLE_MS = 300;

// Window within which an identical value is treated as a duplicate submit.
const DUPLICATE_SUBMIT_MS = 1000;

/** Heuristic: only trip the "new scan replaces old value" logic when the
 *  old value LOOKS like a completed RFID (≥6 alphanumeric chars). This
 *  prevents dropping characters when the operator is typing a short value
 *  manually one slow keystroke at a time (which would otherwise be
 *  mistaken for a new scan burst). KC-series tags are 8 hex chars; setting
 *  the floor at 6 leaves a little slack for shorter tag formats while
 *  still excluding typical 1-3 char manual input bursts. */
function looksLikeCompletedRfidTag(v: string): boolean {
  return v.length >= 6 && /^[A-Za-z0-9]+$/.test(v);
}

export function useRfidScanField(): UseRfidScanField {
  const [value, setValueState] = useState('');
  // Ref mirror of `value` so onChange can read the current value without
  // closing over a stale render. setState updates schedule a re-render;
  // the next onChange in the same tick would otherwise see the old value.
  const valueRef = useRef('');
  const lastInputTimeRef = useRef(0);
  const lastSubmitRef = useRef<{ value: string; time: number }>({ value: '', time: 0 });

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const setValue = useCallback((v: string) => {
    setValueState(v);
    valueRef.current = v;
    if (v === '') lastInputTimeRef.current = 0;
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    // Enter is the scanner's burst terminator on KC-series UKB mode.
    // Reset the idle timer so the FIRST printable key after Enter is
    // recognised as "new burst" by onChange even though the natural gap
    // might be <300ms.
    if (e.key === 'Enter') lastInputTimeRef.current = 0;
  }, []);

  const onChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value;
    // Strip CR/LF/tab first; these are scan-burst terminators that should
    // never reach consumers.
    const stripped = raw.replace(/[\r\n\t]/g, '');
    const now = Date.now();
    const gap = now - lastInputTimeRef.current;
    const old = valueRef.current;

    let next: string;
    if (
      gap > NEW_SCAN_IDLE_MS &&
      old.length > 0 &&
      stripped.startsWith(old) &&
      stripped.length > old.length &&
      looksLikeCompletedRfidTag(old)
    ) {
      // New scan burst landed on top of a previously-completed RFID
      // value. Keep only the appended suffix — this is the new tag.
      next = stripped.slice(old.length).replace(/^\s+|\s+$/g, '');
    } else {
      next = stripped.replace(/^\s+|\s+$/g, '');
    }

    valueRef.current = next;
    setValueState(next);
    lastInputTimeRef.current = now;
  }, []);

  const isDuplicate = useCallback((submitted: string) => {
    if (!submitted) return false;
    const now = Date.now();
    const isDup =
      submitted === lastSubmitRef.current.value &&
      now - lastSubmitRef.current.time < DUPLICATE_SUBMIT_MS;
    if (!isDup) {
      lastSubmitRef.current = { value: submitted, time: now };
    }
    return isDup;
  }, []);

  return { value, setValue, onKeyDown, onChange, isDuplicate };
}
