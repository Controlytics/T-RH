import { createContext, useContext, useCallback, useState } from 'react';
import type { ToastItem, ToastVariant } from '@/components/ui/toast';
import type { DialogMessage, DialogVariant } from '@/components/ui/message-dialog';

let idCounter = 0;

interface ToastAPI {
  // success()/error() show a blocking acknowledgement MODAL (operator clicks
  // OK) — used for explicit save-type actions app-wide. successToast()/
  // errorToast() are the non-blocking toast escape hatches for background
  // events (SWR load errors, sync, copy, etc.).
  success: (title: string, message?: string) => void;
  error: (title: string, message?: string) => void;
  successToast: (title: string, message?: string) => void;
  errorToast: (title: string, message?: string) => void;
  warning: (title: string, message?: string) => void;
  info: (title: string, message?: string) => void;
}

interface ToastContextValue {
  toasts: ToastItem[];
  dialogs: DialogMessage[];
  toast: ToastAPI;
  dismiss: (id: string) => void;
  dismissDialog: (id: string) => void;
}

export const ToastContext = createContext<ToastContextValue | null>(null);

export function useToastState(): ToastContextValue {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const [dialogs, setDialogs] = useState<DialogMessage[]>([]);

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const dismissDialog = useCallback((id: string) => {
    setDialogs((prev) => prev.filter((d) => d.id !== id));
  }, []);

  const addToast = useCallback((variant: ToastVariant, title: string, message?: string) => {
    const id = `toast-${++idCounter}`;
    setToasts((prev) => [...prev, { id, title, message, variant }]);
  }, []);

  const enqueueDialog = useCallback((variant: DialogVariant, title: string, message?: string) => {
    const id = `dialog-${++idCounter}`;
    setDialogs((prev) => [...prev, { id, variant, title, message }]);
  }, []);

  const toast: ToastAPI = {
    success: useCallback((title: string, message?: string) => enqueueDialog('success', title, message), [enqueueDialog]),
    error: useCallback((title: string, message?: string) => enqueueDialog('error', title, message), [enqueueDialog]),
    successToast: useCallback((title: string, message?: string) => addToast('success', title, message), [addToast]),
    errorToast: useCallback((title: string, message?: string) => addToast('error', title, message), [addToast]),
    warning: useCallback((title: string, message?: string) => addToast('warning', title, message), [addToast]),
    info: useCallback((title: string, message?: string) => addToast('info', title, message), [addToast]),
  };

  return { toasts, dialogs, toast, dismiss, dismissDialog };
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within a ToastProvider');
  return ctx;
}
