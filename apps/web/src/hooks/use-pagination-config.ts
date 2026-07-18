import useSWR from 'swr';

interface PaginationConfigData {
  limit: number;
  count: number;
  options: number[];
}

export function usePaginationConfig(): number[] {
  const { data } = useSWR<PaginationConfigData>(
    '/api/config/pagination/current',
    { revalidateOnMount: true, dedupingInterval: 5000, revalidateOnFocus: false }
  );
  return data?.options ?? [10, 25, 50];
}

export function usePaginationDefaults(): { options: number[]; defaultLimit: number } {
  const { data } = useSWR<PaginationConfigData>(
    '/api/config/pagination/current',
    { revalidateOnMount: true, dedupingInterval: 5000, revalidateOnFocus: false }
  );
  return {
    options: data?.options ?? [10, 25, 50],
    defaultLimit: data?.limit ?? 20,
  };
}
