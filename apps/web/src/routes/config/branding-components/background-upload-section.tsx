import { useRef, useState } from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { apiClient } from '@/lib/api-client';

/**
 * The application background image (2026-08-27).
 *
 * DELIBERATELY NOT the logo's pattern. The logo is read with `FileReader` and stored
 * as a base64 data URI inside the branding config; a background is far larger, and
 * `system_config` is read constantly while a branding change is AUDITED — an inlined
 * image would land twice in a §11 before/after record. So this uploads to disk via
 * `POST /api/uploads/branding-background` and stores only the returned path.
 *
 * The upload goes through `apiClient.postFormData`, never a hand-rolled `fetch`: the
 * profile-photo upload in this repo once read its token from `localStorage`, a key
 * nothing in the app writes.
 */

interface Props {
  backgroundUrl: string;
  backgroundOpacity: number;
  onChange: (url: string) => void;
  onOpacityChange: (value: number) => void;
  disabled?: boolean;
}

export function BackgroundUploadSection({
  backgroundUrl,
  backgroundOpacity,
  onChange,
  onOpacityChange,
  disabled,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const opacity = Number.isFinite(backgroundOpacity) ? backgroundOpacity : 12;

  const upload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setError('');

    // The server re-checks both of these against the file's magic bytes; refusing
    // here only saves a round trip, it is not the security boundary.
    if (!file.type.startsWith('image/')) {
      setError('Select an image file (JPEG, PNG, GIF or WebP).');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('Image must be 5MB or smaller.');
      return;
    }

    setBusy(true);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await apiClient.postFormData<{ url: string }>('/api/uploads/branding-background', form);
      onChange(res.url);
    } catch (err) {
      setError((err as { message?: string })?.message || 'Upload failed.');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = () => {
    setError('');
    onChange('');
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500" />
      <CardContent className="p-6 space-y-4">
        <h3 className="text-sm font-semibold text-slate-800">Background Image</h3>

        <div className="rounded-xl border border-slate-200 bg-slate-50 overflow-hidden">
          {backgroundUrl ? (
            <div
              className="h-40 bg-white"
              style={{
                backgroundImage: `url(${JSON.stringify(backgroundUrl)})`,
                backgroundSize: 'contain',
                backgroundRepeat: 'no-repeat',
                backgroundPosition: 'center',
                opacity: Math.min(100, Math.max(0, opacity)) / 100,
              }}
            />
          ) : (
            <div className="flex h-40 items-center justify-center text-sm text-slate-400">No background set</div>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp"
            className="hidden"
            onChange={upload}
            disabled={disabled || busy}
          />
          <Button type="button" variant="outline" disabled={disabled || busy} onClick={() => inputRef.current?.click()}>
            {busy ? 'Uploading…' : backgroundUrl ? 'Replace image' : 'Upload image'}
          </Button>
          {backgroundUrl && (
            <Button type="button" variant="outline" disabled={disabled || busy} onClick={remove}>
              Remove
            </Button>
          )}
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <label htmlFor="bg-strength" className="text-sm text-slate-700">Strength</label>
            <span className="text-sm tabular-nums text-slate-600">{opacity}%</span>
          </div>
          <input
            id="bg-strength"
            type="range"
            min={0}
            max={100}
            step={1}
            value={opacity}
            disabled={disabled}
            onChange={(e) => onOpacityChange(Number(e.target.value))}
            className="w-full"
          />
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}
      </CardContent>
    </Card>
  );
}
