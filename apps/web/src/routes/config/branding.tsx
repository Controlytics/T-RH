import { useState, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { brandingConfigSchema, type BrandingConfig } from '@digilog/shared';
import useSWR, { mutate as globalMutate } from 'swr';
import { apiClient } from '@/lib/api-client';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Dialog, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { LogoUploadSection } from './branding-components/logo-upload-section';
import { BackgroundUploadSection } from './branding-components/background-upload-section';
import { BrowserTabSection } from './branding-components/browser-tab-section';
import { ColorSettingsSection } from './branding-components/color-settings-section';
import { BrandingPreview } from './branding-components/branding-preview';
import { LoginBgSection } from './branding-components/login-bg-section';
import { THEMES, getThemeById } from '@/lib/themes';

export function BrandingConfigPage() {
  const navigate = useNavigate();
  const reauth = useReauth();
  const [error, setError] = useState('');
  const [showSuccessPopup, setShowSuccessPopup] = useState(false);
  const [showErrorPopup, setShowErrorPopup] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { data, mutate } = useSWR('/api/config/branding', { revalidateOnMount: true, dedupingInterval: 5000 });

  const { register, handleSubmit, watch, setValue, reset, formState: { errors, isSubmitting, isDirty } } = useForm<BrandingConfig>({
    resolver: zodResolver(brandingConfigSchema),
    defaultValues: brandingConfigSchema.parse({}),
  });

  // Reset form when data loads from API (only once)
  const [initialized, setInitialized] = useState(false);
  if (data && !initialized) {
    reset(data);
    setInitialized(true);
  }

  const watchedValues = watch();

  const handleLogoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    if (!file.type.startsWith('image/')) {
      setError('Please select an image file');
      return;
    }

    // Validate file size (max 2MB; stored as base64 in branding config)
    if (file.size > 2 * 1024 * 1024) {
      setError('Logo image must be less than 2MB');
      return;
    }

    // Convert to base64 data URI
    const reader = new FileReader();
    reader.onloadend = () => {
      // shouldDirty so the Save button (disabled unless dirty) enables after upload.
      setValue('logoUrl', reader.result as string, { shouldDirty: true });
      setError('');
    };
    reader.readAsDataURL(file);
  };

  const handleRemoveLogo = () => {
    setValue('logoUrl', '', { shouldDirty: true });
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const onSubmit = async (formData: BrandingConfig) => {
    setError('');
    await reauth.execute('UPDATE_BRANDING', async (password?) => {
      if (password) await apiClient.putWithReauth('/api/config/branding', formData, password);
      else await apiClient.put('/api/config/branding', formData);
      // Refresh the global branding cache so sidebar/login page updates
      await globalMutate('/api/config/branding');
      reset(formData);
      setShowSuccessPopup(true);
    }, {
      onError: (err) => {
        const errorMsg = (err as any)?.message || 'Failed to update';
        setError(errorMsg);
        setShowErrorPopup(true);
      },
    });
  };

  return (
    <div className="space-y-6 animate-fade-in">
      <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
        {/* Two Column Layout */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* Left Column - Settings */}
          <div className="space-y-6">
            <LogoUploadSection
              logoUrl={watchedValues.logoUrl}
              primaryColor={watchedValues.primaryColor}
              secondaryColor={watchedValues.secondaryColor}
              logoText={watchedValues.logoText}
              fileInputRef={fileInputRef}
              onLogoUpload={handleLogoUpload}
              onRemoveLogo={handleRemoveLogo}
              register={register}
            />

            {/* The background image is uploaded to disk and only its path is stored,
                so both fields are set through `setValue` with shouldDirty — the Save
                button is disabled unless the form is dirty, and the upload itself
                does not write the config. Nothing is applied until Save, which
                carries the existing UPDATE_BRANDING re-authentication. */}
            <BackgroundUploadSection
              backgroundUrl={watchedValues.backgroundUrl ?? ''}
              backgroundOpacity={watchedValues.backgroundOpacity ?? 12}
              onChange={(url) => setValue('backgroundUrl', url, { shouldDirty: true })}
              onOpacityChange={(v) => setValue('backgroundOpacity', v, { shouldDirty: true })}
            />

            {/* App Identity Section */}
            <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-blue-500 via-indigo-500 to-violet-500" />
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-slate-100 text-slate-600">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H5a2 2 0 00-2 2v9a2 2 0 002 2h14a2 2 0 002-2V8a2 2 0 00-2-2h-5m-4 0V5a2 2 0 114 0v1m-4 0a2 2 0 104 0m-5 8a2 2 0 100-4 2 2 0 000 4zm0 0c1.306 0 2.417.835 2.83 2M9 14a3.001 3.001 0 00-2.83 2M15 11h3m-3 4h2" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-800">App Identity</h3>
                    <p className="text-xs text-slate-500">Configure app name and branding text</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-700">Logo Text (fallback)</label>
                    <Input {...register('logoText')} maxLength={5} placeholder="DL" />
                    <p className="text-xs text-slate-400">Used when no logo is set</p>
                    {errors.logoText && <p className="text-xs text-red-500">{errors.logoText.message}</p>}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-700">App Name</label>
                    <Input {...register('appName')} placeholder="DigiLog" />
                    {errors.appName && <p className="text-xs text-red-500">{errors.appName.message}</p>}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-700">App Tagline</label>
                    <Input {...register('appTagline')} placeholder="21 CFR Part 11 Compliant" />
                    {errors.appTagline && <p className="text-xs text-red-500">{errors.appTagline.message}</p>}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Browser tab (2026-09-03). Placed after App Identity because the
                tab title is the fourth name on this page and reads as one of
                them; the favicon rides with it because they are one surface. */}
            <BrowserTabSection
              tabTitle={watchedValues.tabTitle ?? ''}
              faviconUrl={watchedValues.faviconUrl ?? ''}
              register={register}
              errors={errors}
              onFaviconChange={(url) => setValue('faviconUrl', url, { shouldDirty: true })}
            />

            {/* Company Info Section */}
            <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500" />
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-slate-100 text-slate-600">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-800">Company Information</h3>
                    <p className="text-xs text-slate-500">Your company details</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-700">Company Name</label>
                    <Input {...register('companyName')} placeholder="Company Name" />
                    {errors.companyName && <p className="text-xs text-red-500">{errors.companyName.message}</p>}
                  </div>
                  <div className="space-y-2">
                    <label className="text-sm font-semibold text-slate-700">Version</label>
                    <Input {...register('version')} placeholder="1.0" />
                    {errors.version && <p className="text-xs text-red-500">{errors.version.message}</p>}
                  </div>
                </div>
              </CardContent>
            </Card>

            {/* Theme Selector */}
            <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
              <div className="h-1 bg-gradient-to-r from-cyan-500 via-blue-500 to-violet-500" />
              <CardContent className="p-6">
                <div className="flex items-center gap-3 mb-5">
                  <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-slate-100 text-slate-600">
                    <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 21a4 4 0 01-4-4V5a2 2 0 012-2h4a2 2 0 012 2v12a4 4 0 01-4 4zm0 0h12a2 2 0 002-2v-4a2 2 0 00-2-2h-2.343M11 7.343l1.657-1.657a2 2 0 012.828 0l2.829 2.829a2 2 0 010 2.828l-8.486 8.485M7 17h.01" />
                    </svg>
                  </div>
                  <div>
                    <h3 className="font-bold text-slate-800">Color Theme</h3>
                    <p className="text-xs text-slate-500">Select a preset theme for the entire application</p>
                  </div>
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
                  {THEMES.map(theme => {
                    const isSelected = (watchedValues as any).colorTheme === theme.id || (!((watchedValues as any).colorTheme) && theme.id === 'ocean');
                    return (
                      <button key={theme.id} type="button"
                        onClick={() => {
                          setValue('colorTheme' as any, theme.id, { shouldDirty: true });
                          // Fill color pickers with theme values
                          setValue('primaryColor', theme.colors.primary, { shouldDirty: true });
                          setValue('secondaryColor', theme.colors.accent, { shouldDirty: true });
                          setValue('accentColor', theme.colors.gradientTo, { shouldDirty: true });
                          setValue('gradientStart', theme.colors.gradientFrom, { shouldDirty: true });
                          setValue('gradientMiddle', theme.colors.accent, { shouldDirty: true });
                          setValue('gradientEnd', theme.colors.gradientTo, { shouldDirty: true });
                          setValue('loginBgStart', theme.colors.loginBgStart, { shouldDirty: true });
                          setValue('loginBgEnd', theme.colors.loginBgEnd, { shouldDirty: true });
                        }}
                        className={`relative rounded-xl p-3 text-center transition-all ${isSelected
                          ? 'ring-2 ring-offset-2 shadow-[var(--elev-2)] scale-[1.02]'
                          : 'border border-slate-200 hover:border-slate-300 hover:shadow-[var(--elev-1)]'}`}
                        style={isSelected ? { borderColor: theme.colors.primary, '--tw-ring-color': theme.colors.primary } as React.CSSProperties : {}}>
                        {/* Color swatches */}
                        <div className="flex justify-center gap-1 mb-2">
                          <div className="w-6 h-6 rounded-full shadow-inner" style={{ backgroundColor: theme.colors.primary }} />
                          <div className="w-6 h-6 rounded-full shadow-inner" style={{ backgroundColor: theme.colors.accent }} />
                          <div className="w-6 h-6 rounded-full shadow-inner" style={{ backgroundColor: theme.colors.gradientTo }} />
                        </div>
                        {/* Gradient bar */}
                        <div className="h-1.5 rounded-full mb-2" style={{ background: `linear-gradient(to right, ${theme.colors.gradientFrom}, ${theme.colors.gradientTo})` }} />
                        <p className="text-xs font-semibold text-slate-700">{theme.name}</p>
                        <p className="text-[0.625rem] text-slate-400 leading-tight mt-0.5">{theme.description.split('—')[1]?.trim() || theme.description}</p>
                        {isSelected && (
                          <div className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full flex items-center justify-center" style={{ backgroundColor: theme.colors.primary }}>
                            {/* White because the ground is the THEME's own
                                primary colour, set inline above — a class-based
                                sweep cannot see that, so this one is explicit. */}
                            <svg className="w-3 h-3 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M5 13l4 4L19 7" /></svg>
                          </div>
                        )}
                      </button>
                    );
                  })}
                </div>
              </CardContent>
            </Card>

            <ColorSettingsSection
              register={register}
              errors={errors}
              watchedValues={watchedValues}
            />

            <LoginBgSection
              register={register}
              watchedValues={watchedValues}
            />
          </div>

          {/* Right Column - Live Preview */}
          <div className="lg:sticky lg:top-6 space-y-6">
            <BrandingPreview watchedValues={watchedValues} />

            {/* Action Buttons */}
            <Card className="border-0 shadow-[var(--elev-2)] overflow-hidden">
              <CardContent className="p-6">
                <div className="flex justify-end gap-3 pt-4 border-t border-slate-100">
                  <Button type="button" variant="outline" onClick={() => navigate('/config')}>
                    Cancel
                  </Button>
                  <Button type="submit" disabled={!isDirty || isSubmitting}>
                    {isSubmitting ? 'Saving...' : 'Save Changes'}
                  </Button>
                </div>
              </CardContent>
            </Card>

            {/* Info Banner */}
            <div className="relative overflow-hidden rounded-[var(--radius-card)] bg-gradient-to-r from-violet-50 via-purple-50 to-fuchsia-50 border border-violet-100/50 p-5">
              <div className="absolute top-0 right-0 w-40 h-40 bg-gradient-to-br from-violet-500/10 to-purple-500/10 rounded-full blur-3xl" />
              <div className="relative flex items-start gap-4">
                <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-slate-100 text-slate-600">
                  <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                  </svg>
                </div>
                <div>
                  <h3 className="font-bold text-violet-900 mb-1">Branding Tips</h3>
                  <p className="text-sm text-violet-700">
                    Changes apply globally across the application. Use consistent colors that reflect your company brand.
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      </form>

      {/* Success Popup */}
      <Dialog open={showSuccessPopup} onClose={() => setShowSuccessPopup(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-[var(--radius-card)] bg-gradient-to-br from-emerald-500 to-green-600 flex items-center justify-center shadow-[var(--elev-2)]">
              <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
              </svg>
            </div>
            <span className="text-emerald-700 text-xl font-bold">Success!</span>
          </DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <p className="text-slate-600">Branding configuration has been updated successfully. Changes are now live across the application.</p>
        </div>
        <div className="flex justify-end">
          <Button onClick={() => setShowSuccessPopup(false)} className="rounded-xl bg-gradient-to-r from-emerald-500 to-green-600">
            Done
          </Button>
        </div>
      </Dialog>

      {/* Error Popup */}
      <Dialog open={showErrorPopup} onClose={() => setShowErrorPopup(false)}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-3">
            <div className="w-14 h-14 rounded-[var(--radius-card)] bg-gradient-to-br from-red-500 to-rose-600 flex items-center justify-center shadow-[var(--elev-2)]">
              <svg className="w-7 h-7 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </div>
            <span className="text-red-700 text-xl font-bold">Update Failed</span>
          </DialogTitle>
        </DialogHeader>
        <div className="py-4">
          <p className="text-slate-600">{error || 'Failed to update branding configuration. Please try again.'}</p>
        </div>
        <div className="flex justify-end">
          <Button variant="outline" onClick={() => setShowErrorPopup(false)} className="rounded-xl">
            Close
          </Button>
        </div>
      </Dialog>

      {/* Reauth Dialog */}
      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
        actionLabel="Update Branding"
      />
    </div>
  );
}
