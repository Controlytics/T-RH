import { Dialog, DialogHeader, DialogTitle, DialogFooter } from './dialog';
import { Button } from './button';

interface ErrorPopupProps {
  error: string;
  onClose: () => void;
}

export function ErrorPopup({ error, onClose }: ErrorPopupProps) {
  if (!error) return null;

  return (
    <Dialog open={!!error} onClose={onClose} priority>
      <DialogHeader>
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-red-100">
            <svg className="w-6 h-6 text-red-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          </div>
          <DialogTitle>Error</DialogTitle>
        </div>
      </DialogHeader>
      <p className="text-sm text-slate-700 leading-relaxed">{error}</p>
      <DialogFooter>
        <Button onClick={onClose}>OK</Button>
      </DialogFooter>
    </Dialog>
  );
}
