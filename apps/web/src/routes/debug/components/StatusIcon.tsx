import type { PipelineTrace } from '../types';

// ---------------------------------------------------------------------------
// Status icon (inline SVG, no lucide-react)
// ---------------------------------------------------------------------------

export function StatusIcon({ status }: { status: PipelineTrace['finalStatus'] }) {
  if (status === 'SUCCESS') {
    return (
      <div className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-100 flex items-center justify-center">
        <svg className="w-3.5 h-3.5 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" />
        </svg>
      </div>
    );
  }
  if (status === 'SUCCESS_WITH_WARNINGS') {
    return (
      <div className="flex-shrink-0 w-5 h-5 rounded-full bg-amber-100 flex items-center justify-center">
        <svg className="w-3.5 h-3.5 text-amber-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z" />
        </svg>
      </div>
    );
  }
  if (status === 'FAILED') {
    return (
      <div className="flex-shrink-0 w-5 h-5 rounded-full bg-red-100 flex items-center justify-center">
        <svg className="w-3 h-3 text-red-600" fill="currentColor" viewBox="0 0 24 24">
          <circle cx="12" cy="12" r="10" />
        </svg>
      </div>
    );
  }
  // DLQ
  return (
    <div className="flex-shrink-0 w-5 h-5 rounded-full bg-yellow-100 flex items-center justify-center">
      <svg className="w-3 h-3 text-yellow-600" fill="currentColor" viewBox="0 0 24 24">
        <circle cx="12" cy="12" r="10" />
      </svg>
    </div>
  );
}
