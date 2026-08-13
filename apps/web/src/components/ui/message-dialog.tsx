import { useEffect } from 'react';
import { themeButton } from '@/lib/theme-styles';

export type DialogVariant = 'success' | 'error';

export interface DialogMessage {
  id: string;
  variant: DialogVariant;
  title: string;
  message?: string;
}

// App-wide acknowledgement modal shown (via ToastProvider) after an explicit
// user action succeeds (`toast.success`) or fails (`toast.error`). The operator
// must click OK (Esc / backdrop also dismiss). Background/SWR events use the
// non-blocking `successToast` / `errorToast` toasts instead.
const VARIANTS: Record<DialogVariant, {
  header: string;
  okStyle: React.CSSProperties;
  iconPath: string;
  defaultMessage: string;
}> = {
  success: {
    header: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))',
    okStyle: themeButton,
    iconPath: 'M5 13l4 4L19 7', // check
    defaultMessage: 'Your changes have been saved successfully.',
  },
  error: {
    header: 'linear-gradient(to right, #dc2626, #b91c1c)',
    okStyle: { background: 'linear-gradient(to right, #dc2626, #b91c1c)' },
    iconPath: 'M6 18L18 6M6 6l12 12', // X
    defaultMessage: 'Something went wrong. Please try again.',
  },
};

export function MessageDialog({ item, onDismiss }: { item: DialogMessage; onDismiss: (id: string) => void }) {
  const v = VARIANTS[item.variant];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onDismiss(item.id); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [item.id, onDismiss]);

  return (
    <div
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-center justify-center z-[80] p-4"
      onClick={() => onDismiss(item.id)}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="bg-white border border-slate-200 rounded-2xl w-full max-w-sm overflow-hidden shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 flex items-center gap-3" style={{ background: v.header }}>
          <div className="w-9 h-9 rounded-full bg-white/20 flex items-center justify-center shrink-0">
            <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d={v.iconPath} />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-white">{item.title}</h2>
        </div>

        <div className="px-6 py-5">
          <p className="text-sm text-slate-600">{item.message ?? v.defaultMessage}</p>
        </div>

        <div className="px-6 pb-5">
          <button
            autoFocus
            onClick={() => onDismiss(item.id)}
            className="w-full py-2.5 text-white rounded-lg font-semibold hover:opacity-90 transition-all"
            style={v.okStyle}
          >
            OK
          </button>
        </div>
      </div>
    </div>
  );
}
