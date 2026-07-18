import { useEffect } from 'react';

/**
 * Global RFID input guard.
 *
 * RFID readers in UKB mode type tag IDs as rapid keystrokes into whatever
 * field has focus. This guard intercepts those bursts and blocks them from
 * entering non-RFID fields.
 *
 * Only inputs with data-rfid="true" attribute will receive RFID input.
 * All other inputs are protected.
 *
 * Detection: tracks keystroke timing. If 3+ characters arrive within 30ms
 * each (way faster than human typing), it's flagged as RFID input and
 * blocked from non-RFID fields.
 */
export function useRfidGuard() {
  useEffect(() => {
    const timestamps: number[] = [];
    const MAX_TRACK = 10;

    // How fast characters arrive to be considered RFID (ms between keys)
    // RFID readers type at 3-50ms intervals. Humans type at 80-300ms.
    const SPEED_THRESHOLD = 80;
    // How many consecutive fast keys to trigger blocking
    const MIN_FAST_KEYS = 3;

    const handler = (e: KeyboardEvent) => {
      // Only track printable characters
      if (e.key.length !== 1) return;

      // Allow if focused element is an RFID input
      const target = e.target as HTMLElement;
      if (target.getAttribute('data-rfid') === 'true') return;

      // Track timestamp
      const now = Date.now();
      timestamps.push(now);
      if (timestamps.length > MAX_TRACK) timestamps.shift();

      // Check if recent keystrokes are RFID-fast
      if (timestamps.length >= MIN_FAST_KEYS) {
        const recentCount = MIN_FAST_KEYS;
        let allFast = true;
        for (let i = timestamps.length - 1; i > timestamps.length - recentCount; i--) {
          if (timestamps[i] - timestamps[i - 1] > SPEED_THRESHOLD) {
            allFast = false;
            break;
          }
        }

        if (allFast) {
          // This is RFID input — block it from non-RFID fields
          e.preventDefault();
          e.stopImmediatePropagation();
          return;
        }
      }
    };

    // Also block the Enter key that RFID sends after the tag ID
    const enterHandler = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return;
      const target = e.target as HTMLElement;
      if (target.getAttribute('data-rfid') === 'true') return;

      // If recent input was RFID-fast, block this Enter too
      if (timestamps.length >= MIN_FAST_KEYS) {
        const now = Date.now();
        const lastKey = timestamps[timestamps.length - 1];
        if (now - lastKey < 200) {
          // Enter arrived right after fast input — RFID Enter, block it
          e.preventDefault();
          e.stopImmediatePropagation();
          timestamps.length = 0;
        }
      }
    };

    document.addEventListener('keydown', handler, true);
    document.addEventListener('keydown', enterHandler, true);
    return () => {
      document.removeEventListener('keydown', handler, true);
      document.removeEventListener('keydown', enterHandler, true);
    };
  }, []);
}
