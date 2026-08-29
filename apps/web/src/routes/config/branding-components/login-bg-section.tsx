import type { UseFormRegister } from 'react-hook-form';
import type { BrandingConfig } from '@digilog/shared';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';

interface LoginBgSectionProps {
  register: UseFormRegister<BrandingConfig>;
  watchedValues: BrandingConfig;
}

export function LoginBgSection({ register, watchedValues }: LoginBgSectionProps) {
  return (
    <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
      <div className="h-1 bg-gradient-to-r from-slate-600 via-slate-500 to-slate-400" />
      <CardContent className="p-6">
        <div className="flex items-center gap-3 mb-5">
          <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-slate-100 text-slate-600">
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          </div>
          <div>
            <h3 className="font-bold text-slate-800">Login Background</h3>
            <p className="text-xs text-slate-500">Login page gradient background</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-4">
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">Background Start</label>
            <div className="flex gap-2">
              <input
                type="color"
                {...register('loginBgStart')}
                className="h-10 w-14 cursor-pointer rounded-[var(--radius-control)] border border-slate-300 bg-white p-1 transition-colors hover:border-slate-400"
              />
              <Input {...register('loginBgStart')} placeholder="#0f172a" className="flex-1 rounded-xl h-11 font-mono text-sm" />
            </div>
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold text-slate-700">Background End</label>
            <div className="flex gap-2">
              <input
                type="color"
                {...register('loginBgEnd')}
                className="h-10 w-14 cursor-pointer rounded-[var(--radius-control)] border border-slate-300 bg-white p-1 transition-colors hover:border-slate-400"
              />
              <Input {...register('loginBgEnd')} placeholder="#1e3a5f" className="flex-1 rounded-xl h-11 font-mono text-sm" />
            </div>
          </div>
        </div>
        {/* Background Preview */}
        <div className="space-y-2">
          <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider">Preview</label>
          <div
            className="h-24 rounded-xl flex items-center justify-center shadow-inner"
            style={{
              background: `linear-gradient(to bottom right, ${watchedValues.loginBgStart || '#0f172a'}, ${watchedValues.loginBgEnd || '#1e3a5f'})`
            }}
          >
            <span className="text-white/60 text-sm font-medium">Login Background</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
