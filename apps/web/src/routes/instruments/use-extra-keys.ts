import { useCallback, useState } from 'react';

/**
 * Per-user, per-instrument extra telemetry keys shown on the trend page.
 *
 * PER-VIEWER (localStorage), not administered: which extra keys someone wants
 * charted is a personal convenience, not a governed setting like the
 * temperature/humidity slots. Keyed `digilog.trendKeys.<instrumentId>` so two
 * instruments never share a list.
 *
 * Every read and write is wrapped in try/catch — a private window, a browser
 * with site data blocked, or a full quota all throw on access, and an
 * unguarded read would take the whole trend page down with it rather than
 * just losing this one convenience.
 */

function storageKey(instrumentId: string): string {
  return `digilog.trendKeys.${instrumentId}`;
}

export function readExtraKeys(instrumentId: string): string[] {
  try {
    const raw = localStorage.getItem(storageKey(instrumentId));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

export function writeExtraKeys(instrumentId: string, keys: string[]): void {
  try {
    localStorage.setItem(storageKey(instrumentId), JSON.stringify(keys));
  } catch {
    // Storage blocked or full — the picker just won't remember across a
    // reload for this session. Not worth surfacing as an error.
  }
}

export function useExtraKeys(instrumentId: string): {
  keys: string[];
  add: (k: string) => void;
  remove: (k: string) => void;
} {
  const [keys, setKeys] = useState<string[]>(() => readExtraKeys(instrumentId));

  const add = useCallback((k: string) => {
    setKeys((prev) => {
      if (prev.includes(k)) return prev;
      const next = [...prev, k];
      writeExtraKeys(instrumentId, next);
      return next;
    });
  }, [instrumentId]);

  const remove = useCallback((k: string) => {
    setKeys((prev) => {
      const next = prev.filter((existing) => existing !== k);
      writeExtraKeys(instrumentId, next);
      return next;
    });
  }, [instrumentId]);

  return { keys, add, remove };
}
