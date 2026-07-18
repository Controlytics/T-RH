import { useCallback, useState } from 'react';

export interface RecentSubmission {
  stage: string;
  filter: string;
  block?: string;
  time: string;
}

interface UseRecentSubmissionsReturn {
  /** Current list, newest first, capped at the configured size. */
  recentSubmissions: RecentSubmission[];
  /**
   * Push one or more submissions to the front. Accepts a single entry or
   * an array (the batch handlers push N at once). Caller no longer has to
   * remember the `[...newOnes, ...prev].slice(0, 10)` boilerplate.
   */
  record: (entryOrEntries: RecentSubmission | RecentSubmission[]) => void;
}

/**
 * Tiny hook isolating the "recent submissions" UI state that filter-operations
 * shows under the stage grid. Pure state encapsulation — no I/O, no
 * coordination with offline cache or sync engine. Lives next to the other
 * filter-operations hooks so the extraction lineage is obvious.
 *
 * Why this is worth a separate hook: the inline pattern
 *
 *     setRecentSubmissions(prev => [{ stage, filter, block, time }, ...prev].slice(0, 10));
 *
 * appears 8+ times across `handleSubmitBatch`, `handleReasonSubmit`,
 * `handleEquipmentSubmit`, `handleDryerDurationSubmit`, `handleChecklistSubmit`,
 * etc. — each occurrence with the same `.slice(0, 10)` capping rule and the
 * same `[newOnes, ...prev]` ordering. Any future change (different cap, drop
 * stale entries, add an icon field) had to be applied at every site.
 */
export function useRecentSubmissions(maxKept: number = 10): UseRecentSubmissionsReturn {
  const [recentSubmissions, setRecentSubmissions] = useState<RecentSubmission[]>([]);

  const record = useCallback((entryOrEntries: RecentSubmission | RecentSubmission[]) => {
    const incoming = Array.isArray(entryOrEntries) ? entryOrEntries : [entryOrEntries];
    if (incoming.length === 0) return;
    setRecentSubmissions(prev => [...incoming, ...prev].slice(0, maxKept));
  }, [maxKept]);

  return { recentSubmissions, record };
}
