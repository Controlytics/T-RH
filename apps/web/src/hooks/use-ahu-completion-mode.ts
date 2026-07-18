import useSWR from 'swr';

interface AhuCompletionModeData {
  mode: string;
}

export function useAhuCompletionMode(): 'NONE' | 'POPUP' | 'INTERLOCK' {
  const { data } = useSWR<AhuCompletionModeData>(
    '/api/config/ahu-completion-process/current',
    { revalidateOnMount: true, dedupingInterval: 5000, revalidateOnFocus: false }
  );
  const m = data?.mode;
  return m === 'INTERLOCK' || m === 'POPUP' ? m : 'NONE';
}
