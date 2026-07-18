import useSWR from 'swr';
import { apiClient } from '../lib/api-client';
import { useAuth } from './use-auth';

/**
 * use-super-admin-lock — reads/flips the global "Super Admin API access"
 * kill-switch. Only meaningful for SUPER_ADMIN users; for everyone else the
 * endpoint is role-gated (403), so we don't fetch it.
 *
 * `enabled` defaults to TRUE until the server says otherwise — we must never
 * flash the lockdown screen on a transient `undefined` while the request is in
 * flight (that would briefly hide the whole app from a superadmin whose access
 * is actually fine).
 */
export function useSuperAdminLock() {
  const { user } = useAuth();
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  const { data, isLoading, mutate } = useSWR<{ enabled: boolean }>(
    isSuperAdmin ? '/api/super-admin/api-lock' : null,
    // Re-check on focus so a flip made elsewhere (or via DB) reflects quickly.
    { refreshInterval: 0, revalidateOnFocus: true },
  );

  const enabled = data?.enabled ?? true;

  /** Flip the switch. `password` is required — the backend re-auths every flip. */
  const setEnabled = async (next: boolean, password: string): Promise<boolean> => {
    const res = await apiClient.putWithReauth<{ enabled: boolean }>(
      '/api/super-admin/api-lock',
      { enabled: next },
      password,
    );
    await mutate({ enabled: res.enabled }, { revalidate: false });
    return res.enabled;
  };

  return { isSuperAdmin, enabled, isLoading, mutate, setEnabled };
}
