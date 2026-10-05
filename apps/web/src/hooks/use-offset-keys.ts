import { useMemo } from 'react';
import useSWR from 'swr';
import { coerceSensorOffsetConfig, isOffsetAttributeKey } from '@digilog/shared';
import { safeStorage } from '../lib/safe-storage';

/**
 * Which attribute keys are SENSOR OFFSETS (2026-10-01) — so an offset's value
 * is typed with a + / - choice beside the number instead of free text.
 *
 * Asked only for a SUPER_ADMIN: offsets are SUPER_ADMIN-only, the server strips
 * them from everything any other role reads, and the config row is behind the
 * SUPER_ADMIN-only editor route — so for anyone else the answer is always "no"
 * and nothing is fetched. Read through the SAME `isOffsetAttributeKey` the
 * server applies.
 */
export function useOffsetKeys(): (key: string) => boolean {
  // The signed-in user from the SAME cached `/api/auth/me` request `useAuth`
  // makes — read directly so this hook needs no router (it renders inside
  // panels and forms that `useAuth`'s navigation would otherwise tie to one).
  const hasToken = !!safeStorage.session.get('access_token');
  const { data: user } = useSWR<{ role?: string }>(hasToken ? '/api/auth/me' : null);
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const { data } = useSWR<unknown>(isSuperAdmin ? '/api/config/dynamic/sensor-offsets' : null);
  return useMemo(() => {
    if (!isSuperAdmin) return () => false;
    const config = coerceSensorOffsetConfig(data);
    return (key: string) => isOffsetAttributeKey(config, key);
  }, [isSuperAdmin, data]);
}
