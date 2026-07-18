// Small amber pill marking a record that was inserted manually via the
// SUPER_ADMIN Filter Data Management "Create" tool (a back-/future-dated record,
// not a natively-captured one). Rendered wherever such rows surface so they are
// visually distinguishable. Renders nothing unless `manual` is true.
export function ManualEntryBadge({ manual, className = '' }: { manual?: boolean | null; className?: string }) {
  if (!manual) return null;
  return (
    <span
      title="Inserted manually via Filter Data Management — not a system-captured record"
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-bold uppercase tracking-wide bg-amber-50 text-amber-700 border border-amber-200 ${className}`}
    >
      <svg className="w-2.5 h-2.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
      </svg>
      Manual entry
    </span>
  );
}
