import { useMemo } from 'react';
import useSWR from 'swr';
import type { RoleData } from '@digilog/shared';

export function useRoleColors() {
  const { data: rolesData } = useSWR<RoleData[]>('/api/roles/active', { revalidateOnMount: true, dedupingInterval: 0 });

  const roleColors = useMemo(() => {
    const colors: Record<string, string> = {};
    rolesData?.forEach(role => {
      colors[role.name] = `${role.color} text-white`;
    });
    return colors;
  }, [rolesData]);

  return { roleColors, rolesData };
}
