import type { BrandingConfig } from '@digilog/shared';
import { Card, CardContent } from '@/components/ui/card';

interface BrandingPreviewProps {
  watchedValues: BrandingConfig;
}

export function BrandingPreview({ watchedValues }: BrandingPreviewProps) {
  return (
    <Card className="border-0 shadow-xl overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-violet-500 via-purple-500 to-fuchsia-500" />
      <CardContent className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="p-2.5 rounded-xl bg-gradient-to-br from-violet-500 to-purple-600 text-white shadow-lg shadow-violet-500/25">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-slate-800">Live Preview</h3>
            <p className="text-xs text-slate-500">See your changes in real-time</p>
          </div>
        </div>

        {/* Login Preview */}
        <div
          className="rounded-[var(--radius-card)] p-8 shadow-2xl"
          style={{
            background: `linear-gradient(to bottom right, ${watchedValues.loginBgStart || '#0f172a'}, ${watchedValues.loginBgEnd || '#1e3a5f'})`
          }}
        >
          <div className="bg-white/95 backdrop-blur-sm rounded-[var(--radius-card)] shadow-2xl overflow-hidden max-w-sm mx-auto">
            <div
              className="h-2"
              style={{
                background: `linear-gradient(to right, ${watchedValues.gradientStart || '#3b82f6'}, ${watchedValues.gradientMiddle || '#8b5cf6'}, ${watchedValues.gradientEnd || '#ec4899'})`
              }}
            />
            <div className="p-8 text-center">
              {/* Logo Preview */}
              {watchedValues.logoUrl ? (
                <div className="inline-flex items-center justify-center w-20 h-20 mb-4">
                  <img
                    src={watchedValues.logoUrl}
                    alt="Logo preview"
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              ) : (
                <div
                  className="inline-flex items-center justify-center w-16 h-16 rounded-xl mb-4 shadow-xl"
                  style={{
                    background: `linear-gradient(to bottom right, ${watchedValues.primaryColor || '#1e3a5f'}, ${watchedValues.secondaryColor || '#3b82f6'})`
                  }}
                >
                  <span className="text-2xl font-bold text-white">{watchedValues.logoText || 'DL'}</span>
                </div>
              )}
              <h2
                className="text-2xl font-bold mb-1"
                style={{
                  backgroundImage: `linear-gradient(to right, ${watchedValues.primaryColor || '#1e3a5f'}, ${watchedValues.secondaryColor || '#3b82f6'})`,
                  backgroundClip: 'text',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                {watchedValues.appName || 'DigiLog'}
              </h2>
              <p className="text-xs text-slate-500 mb-6">{watchedValues.appTagline || '21 CFR Part 11 Compliant'}</p>

              {/* Mock Login Form */}
              <div className="space-y-3 mb-6">
                <div className="h-10 rounded-lg bg-slate-100 border border-slate-200" />
                <div className="h-10 rounded-lg bg-slate-100 border border-slate-200" />
                <div
                  className="h-10 rounded-lg flex items-center justify-center text-white text-sm font-semibold"
                  style={{
                    background: `linear-gradient(to right, ${watchedValues.primaryColor || '#1e3a5f'}, ${watchedValues.secondaryColor || '#3b82f6'})`
                  }}
                >
                  Sign In
                </div>
              </div>

              <div className="pt-4 border-t border-slate-100">
                <p className="text-sm font-semibold text-slate-600">{watchedValues.companyName || 'Company Name'}</p>
                <p className="text-xs text-slate-400">Version {watchedValues.version || '1.0'}</p>
              </div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
