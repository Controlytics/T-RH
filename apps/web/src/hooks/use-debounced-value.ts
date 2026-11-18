import { useEffect, useState } from 'react';

/**
 * `value`, held back until it has stopped changing for `ms`.
 *
 * For a search box that drives a request (performance audit 2026-11-17, G1-09):
 * without it every keystroke is a new SWR key and so a new request — ten to twenty
 * of them for one word, each a server-side search and count. The Instruments list
 * has debounced its search since it was built; the alarm panel and the trend page's
 * alarms widget did not.
 */
export function useDebouncedValue<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}
