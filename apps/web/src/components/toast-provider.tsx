import { createElement, useEffect } from 'react';
import { ToastContext, useToastState } from '@/hooks/use-toast';
import { ToastContainer } from '@/components/ui/toast';
import { MessageDialog } from '@/components/ui/message-dialog';
import { registerSwrToast, unregisterSwrToast } from '@/lib/swr-config';

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const state = useToastState();

  useEffect(() => {
    // SWR background/load errors use the NON-blocking error toast (not the
    // modal) — a failed revalidation/poll must not pop a blocking dialog.
    registerSwrToast(state.toast.errorToast);
    return () => unregisterSwrToast();
  }, [state.toast.errorToast]);

  return createElement(
    ToastContext.Provider,
    { value: state },
    children,
    createElement(ToastContainer, { toasts: state.toasts, onDismiss: state.dismiss }),
    // One acknowledgement modal at a time (FIFO) — success or error, shown
    // after an explicit toast.success(...) / toast.error(...).
    state.dialogs.length > 0
      ? createElement(MessageDialog, { item: state.dialogs[0], onDismiss: state.dismissDialog })
      : null,
  );
}
