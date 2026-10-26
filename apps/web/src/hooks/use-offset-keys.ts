import { useMemo } from 'react';
import useSWR from 'swr';
import { safeStorage } from '../lib/safe-storage';

/**
 * Which attribute keys are SENSOR OFFSETS (2026-10-01) — so an offset's value
 * is typed with a + / - choice beside the number instead of free text.
 *
 * The SERVER's answer (`GET /api/instruments/offset-keys`, 2026-10-26): every
 * instrument profile's offset keys, folded. Until then this hook fetched the
 * raw `sensor-offsets` config and classified keys itself — server logic in the
 * browser, and wrong once the keys moved onto each profile. Asked only for a
 * SUPER_ADMIN: offsets are SUPER_ADMIN-only and the server names none to
 * anyone else, so for every other role the answer is "no" and nothing is
 * fetched.
 */
export function useOffsetKeys(): (key: string) => boolean {
  // The signed-in user from the SAME cached `/api/auth/me` request `useAuth`
  // makes — read directly so this hook needs no router (it renders inside
  // panels and forms that `useAuth`'s navigation would otherwise tie to one).
  const hasToken = !!safeStorage.session.get('access_token');
  const { data: user } = useSWR<{ role?: string }>(hasToken ? '/api/auth/me' : null);
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const { data } = useSWR<{ keys: string[] }>(isSuperAdmin ? '/api/instruments/offset-keys' : null);
  return useMemo(() => {
    if (!isSuperAdmin) return () => false;
    const keys = new Set(data?.keys ?? []);
    return (key: string) => keys.has(key.trim().toLowerCase());
  }, [isSuperAdmin, data]);
}
