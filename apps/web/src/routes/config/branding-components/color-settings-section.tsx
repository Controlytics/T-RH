import type { UseFormRegister, FieldErrors } from 'react-hook-form';
import type { BrandingConfig } from '@digilog/shared';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';

interface ColorSettingsSectionProps {
  register: UseFormRegister<BrandingConfig>;
  errors: FieldErrors<BrandingConfig>;
  watchedValues: BrandingConfig;
}

export function ColorSettingsSection({
  register,
  errors,
  watchedValues,
}: ColorSettingsSectionProps) {
  return (
    <>
      {/* Primary Colors Section */}
      <Card className="border-0 shadow-xl overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-rose-500 via-pink-500 to-fuchsia-500" />
        <CardContent className="p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-rose-500 to-pink-600 text-white shadow-lg shadow-rose-500/25">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
              </svg>
            </div>
            <div>
              <h3 className="font-bold text-slate-800">Primary Colors</h3>
              <p className="text-xs text-slate-500">Main theme colors</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="space-y-2">
              <label className="text-sm font-semibold text-slate-700">Primary Color</label>
              <div className="flex gap-2">
                <div className="relative">
                  <input
                    type="color"
                    {...register('primaryColor')}
                    className="h-11 w-14 rounded-xl border-2 border-slate-200 cursor-pointer hover:border-slate-300 transition-colors"
                  />
                </div>
                <Input {...register('primaryColor')} placeholder="#1e3a5f" className="flex-1 rounded-xl h-11 font-mono text-sm" />
              </div>
              {errors.primaryColor && <p className="text-xs text-red-500">{errors.primaryColor.message}</p>}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-slate-700">Secondary Color</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  {...register('secondaryColor')}
                  className="h-11 w-14 rounded-xl border-2 border-slate-200 cursor-pointer hover:border-slate-300 transition-colors"
                />
                <Input {...register('secondaryColor')} placeholder="#3b82f6" className="flex-1 rounded-xl h-11 font-mono text-sm" />
              </div>
              {errors.secondaryColor && <p className="text-xs text-red-500">{errors.secondaryColor.message}</p>}
            </div>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-slate-700">Accent Color</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  {...register('accentColor')}
                  className="h-11 w-14 rounded-xl border-2 border-slate-200 cursor-pointer hover:border-slate-300 transition-colors"
                />
                <Input {...register('accentColor')} placeholder="#8b5cf6" className="flex-1 rounded-xl h-11 font-mono text-sm" />
              </div>
              {errors.accentColor && <p className="text-xs text-red-500">{errors.accentColor.message}</p>}
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Gradient Colors Section */}
      <Card className="border-0 shadow-xl overflow-hidden">
        <div className="h-1 bg-gradient-to-r from-amber-500 via-orange-500 to-red-500" />
        <CardContent className="p-6">
          <div className="flex items-center gap-3 mb-5">
            <div className="p-2.5 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 text-white shadow-lg shadow-amber-500/25">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" />
              </svg>
            </div>
            <div>
              <h3 className="font-bold text-slate-800">Gradient Colors</h3>
              <p className="text-xs text-slate-500">Decorative bar gradient</p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
            <div className="space-y-2">
              <label className="text-sm font-semibold text-slate-700">Gradient Start</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  {...register('gradientStart')}
                  className="h-11 w-14 rounded-xl border-2 border-slate-200 cursor-pointer hover:border-slate-300 transition-colors"
                />
                <Input {...register('gradientStart')} placeholder="#3b82f6" className="flex-1 rounded-xl h-11 font-mono text-sm" />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-slate-700">Gradient Middle</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  {...register('gradientMiddle')}
                  className="h-11 w-14 rounded-xl border-2 border-slate-200 cursor-pointer hover:border-slate-300 transition-colors"
                />
                <Input {...register('gradientMiddle')} placeholder="#8b5cf6" className="flex-1 rounded-xl h-11 font-mono text-sm" />
              </div>
            </div>
            <div className="space-y-2">
              <label className="text-sm font-semibold text-slate-700">Gradient End</label>
              <div className="flex gap-2">
                <input
                  type="color"
                  {...register('gradientEnd')}
                  className="h-11 w-14 rounded-xl border-2 border-slate-200 cursor-pointer hover:border-slate-300 transition-colors"
                />
                <Input {...register('gradientEnd')} placeholder="#ec4899" className="flex-1 rounded-xl h-11 font-mono text-sm" />
              </div>
            </div>
          </div>
          {/* Gradient Preview */}
          <div className="space-y-2">
            <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Preview</label>
            <div
              className="h-4 rounded-full shadow-inner"
              style={{
                background: `linear-gradient(to right, ${watchedValues.gradientStart || '#3b82f6'}, ${watchedValues.gradientMiddle || '#8b5cf6'}, ${watchedValues.gradientEnd || '#ec4899'})`
              }}
            />
          </div>
        </CardContent>
      </Card>
    </>
  );
}
