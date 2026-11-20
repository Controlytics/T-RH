import type { RefObject } from 'react';
import type { UseFormRegister } from 'react-hook-form';
import { imageFormatByBytes, type BrandingConfig } from '@digilog/shared';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';

interface LogoUploadSectionProps {
  logoUrl: string;
  primaryColor: string;
  secondaryColor: string;
  logoText: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onLogoUpload: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onRemoveLogo: () => void;
  register: UseFormRegister<BrandingConfig>;
  /** What went wrong with the last file chosen; '' = nothing. */
  error?: string;
}

export function LogoUploadSection({
  logoUrl,
  primaryColor,
  secondaryColor,
  logoText,
  fileInputRef,
  onLogoUpload,
  onRemoveLogo,
  register,
  error,
}: LogoUploadSectionProps) {
  // An UPLOADED logo (a data URL) a report cannot print — the shared rule the
  // report itself refuses on. A path (`/logo.jpg`) is fetched at report time
  // and judged there.
  const unprintable = !!logoUrl && logoUrl.startsWith('data:') && imageFormatByBytes(logoUrl) === null;
  return (
    <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-violet-500 via-purple-500 to-fuchsia-500" />
      <CardContent className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-slate-100 text-slate-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-slate-800">Logo</h3>
            <p className="text-xs text-slate-500">Upload your company logo</p>
          </div>
        </div>

        <div className="flex items-start gap-6">
          {/* Logo Preview */}
          <div className="flex-shrink-0">
            <div className="w-28 h-28 rounded-[var(--radius-card)] border-2 border-dashed border-slate-300 hover:border-violet-400 flex items-center justify-center bg-gradient-to-br from-slate-50 to-slate-100 overflow-hidden transition-all">
              {logoUrl ? (
                <img
                  src={logoUrl}
                  alt="Logo preview"
                  className="max-w-full max-h-full object-contain"
                />
              ) : (
                <div
                  className="w-20 h-20 rounded-xl flex items-center justify-center text-white font-bold text-3xl shadow-[var(--elev-2)]"
                  style={{
                    background: `linear-gradient(135deg, ${primaryColor || '#1e3a5f'}, ${secondaryColor || '#3b82f6'})`
                  }}
                >
                  {logoText || 'DL'}
                </div>
              )}
            </div>
          </div>

          {/* Upload Controls */}
          <div className="flex-1 space-y-3">
            <div className="flex gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                onChange={onLogoUpload}
                className="hidden"
                id="logo-upload"
              />
              <Button
                type="button"
                variant="outline"
                onClick={() => fileInputRef.current?.click()}
                className="rounded-xl hover:bg-violet-50 hover:text-violet-600 hover:border-violet-300"
              >
                <svg className="w-4 h-4 mr-2" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                </svg>
                Upload Logo
              </Button>
              {logoUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  onClick={onRemoveLogo}
                  className="text-red-600 hover:text-red-700 hover:bg-red-50 rounded-xl"
                >
                  <svg className="w-4 h-4 mr-1" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                  Remove
                </Button>
              )}
            </div>
            {/* Reports print PNG and JPEG only; any other image is saved as a PNG
                on upload (2026-11-20). This line said "PNG, JPG, SVG" while an SVG
                or a WebP refused every report download. */}
            <p className="text-xs text-slate-500 bg-slate-50 rounded-lg p-2">
              PNG or JPG. Other images (WebP, GIF, SVG) are saved as PNG so reports can print them. Max size: 2MB. If no logo, text will be displayed.
            </p>
            {unprintable && (
              <p data-testid="logo-unprintable" role="alert" className="text-sm text-amber-800 bg-amber-50 border border-amber-200 rounded-lg p-2">
                Reports cannot print this logo: it is not a PNG or JPEG image, so every report that uses the Branding
                logo is refused. Upload it again — it will be saved as a PNG — and click Save.
              </p>
            )}
            {error && <p data-testid="logo-error" role="alert" className="text-sm text-red-600">{error}</p>}
            <Input type="hidden" {...register('logoUrl')} />
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
