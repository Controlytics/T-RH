import { useRef, useState } from 'react';
import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import { BRANDING_TAB_TITLE_DEFAULT, type BrandingConfig } from '@digilog/shared';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { apiClient } from '@/lib/api-client';

/**
 * The browser TAB — its title and its icon (2026-09-03).
 *
 * One card for both, because they are one thing on screen: the operator asked for
 * the tab to be renamed AND for its icon to be changeable, and splitting them
 * across two cards would make the pair harder to find than either alone.
 *
 * The icon follows the BACKGROUND's pattern, not the LOGO's: uploaded to disk with
 * only the path stored, because a branding change is audited and an inlined data
 * URI would land twice in a §11 before/after record. Its own upload route rather
 * than /branding-background because a favicon is the one case where an operator
 * reaches for a .ico.
 *
 * Nothing here writes the config. Both controls mark the form dirty and the change
 * lands on Save, which carries the existing UPDATE_BRANDING re-authentication.
 */

interface Props {
  tabTitle: string;
  faviconUrl: string;
  register: UseFormRegister<BrandingConfig>;
  errors: FieldErrors<BrandingConfig>;
  onFaviconChange: (url: string) => void;
  disabled?: boolean;
}

export function BrowserTabSection({ tabTitle, faviconUrl, register, errors, onFaviconChange, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');

    // The server re-checks against the file's magic bytes; refusing here only saves
    // a round trip and MUST NOT be the stricter of the two.
    //
    // Hence `file.type &&`: a `.ico` frequently arrives with an EMPTY type, because
    // the browser could not map the extension. A bare `!startsWith('image/')` test
    // therefore rejects the exact format this route exists for, before the request
    // is even made, under a message that lists ICO as accepted — which presents as
    // "I uploaded my icon and nothing happened". An unknown type goes to the server
    // and is judged on its bytes.
    if (file.type && !file.type.startsWith('image/')) {
      setError('Select an image file (ICO, PNG, JPEG, GIF or WebP).');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Icon must be 5MB or smaller.');
      return;
    }

    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiClient.postFormData<{ url: string }>('/api/uploads/branding-favicon', form);
      onFaviconChange(res.url);
    } catch (err) {
      setError((err as { message?: string })?.message || 'Upload failed.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = () => {
    setError('');
    onFaviconChange('');
    if (inputRef.current) inputRef.current.value = '';
  };

  // Blank is the state of a fresh install; the tab then keeps the icon shipped in
  // index.html, so the preview shows that rather than an empty square.
  const previewIcon = faviconUrl || '/pwa-192x192.png';

  return (
    <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-sky-500 via-cyan-500 to-teal-500" />
      <CardContent className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-slate-100 text-slate-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v10a2 2 0 01-2 2H6a2 2 0 01-2-2V6z" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-slate-800">Browser Tab</h3>
            <p className="text-xs text-slate-500">Title and icon shown on the browser tab</p>
          </div>
        </div>

        {/* What the tab will read. Cheap to draw and the only way to judge a tab
            title without opening one. */}
        <div className="mb-5 rounded-xl border border-slate-200 bg-slate-100 p-3">
          <div className="inline-flex max-w-full items-center gap-2 rounded-t-lg bg-white px-3 py-2 shadow-[var(--elev-1)]">
            <img src={previewIcon} alt="" className="h-4 w-4 shrink-0 rounded-sm object-contain" />
            <span className="truncate text-sm text-slate-700">{tabTitle || BRANDING_TAB_TITLE_DEFAULT}</span>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">Tab Title</label>
            <Input {...register('tabTitle')} placeholder={BRANDING_TAB_TITLE_DEFAULT} disabled={disabled} />
            {errors.tabTitle && <p className="text-xs text-red-500">{errors.tabTitle.message}</p>}
          </div>

          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">Tab Icon</label>
            <input
              ref={inputRef}
              type="file"
              accept="image/x-icon,image/vnd.microsoft.icon,.ico,image/png,image/jpeg,image/gif,image/webp"
              className="hidden"
              onChange={upload}
              disabled={disabled || busy}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
                {busy ? 'Uploading…' : faviconUrl ? 'Replace icon' : 'Upload icon'}
              </Button>
              {faviconUrl && (
                <Button type="button" variant="outline" disabled={disabled || busy} onClick={remove}>
                  Remove
                </Button>
              )}
            </div>
            {errors.faviconUrl && <p className="text-xs text-red-500">{errors.faviconUrl.message}</p>}
          </div>
        </div>

        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
      </CardContent>
    </Card>
  );
}
