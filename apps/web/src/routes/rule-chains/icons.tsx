/** The marks the Rule Chains pages draw (rule chains, 2026-11-04). */

export function Svg({ d, className = 'h-4 w-4' }: { d: string; className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" viewBox="0 0 24 24" aria-hidden="true">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d={d} />
    </svg>
  );
}

export const PATHS = {
  chain: 'M6 3v12M18 9a9 9 0 01-9 9M21 6a3 3 0 11-6 0 3 3 0 016 0zM9 18a3 3 0 11-6 0 3 3 0 016 0z',
  plus: 'M12 4v16m8-8H4',
  upload: 'M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 4v12m0-12l-4 4m4-4l4 4',
  download: 'M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2M12 16V4m0 12l-4-4m4 4l4-4',
  open: 'M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z',
  root: 'M5 3l3.057 3.057M12 2v4m7 1l-3.057-.057M3 12h4m10 0h4M12 18v4m-7-3l3-3m8 0l3 3M12 9a3 3 0 100 6 3 3 0 000-6z',
  trash: 'M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16',
  undo: 'M3 10h10a5 5 0 015 5v2M3 10l5-5M3 10l5 5',
  redo: 'M21 10H11a5 5 0 00-5 5v2m15-7l-5-5m5 5l-5 5',
  bug: 'M12 20c-3.3 0-6-2.7-6-6v-3a6 6 0 0112 0v3c0 3.3-2.7 6-6 6zM12 20v-9M9 4l1.5 2M15 4l-1.5 2M6 13H3m18 0h-3M6 9L4 7m14 2l2-2M6 17l-2 2m14-2l2 2',
  save: 'M5 13l4 4L19 7',
  settings: 'M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065zM15 12a3 3 0 11-6 0 3 3 0 016 0z',
} as const;

export function RootBadge() {
  return (
    <span
      data-testid="root-badge"
      className="inline-flex items-center gap-1 rounded-full bg-amber-100 px-2 py-0.5 text-[0.75rem] font-bold uppercase tracking-wide text-amber-900 ring-1 ring-inset ring-amber-300"
    >
      <span aria-hidden>★</span>Root
    </span>
  );
}
