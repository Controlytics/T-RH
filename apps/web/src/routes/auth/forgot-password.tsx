import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useBranding } from '@/hooks/use-branding';
import { apiClient } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

export function ForgotPasswordPage() {
  const navigate = useNavigate();
  const { branding } = useBranding();
  const [username, setUsername] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username.trim()) {
      setError('Please enter your User ID');
      return;
    }

    setError('');
    setIsSubmitting(true);

    try {
      await apiClient.post('/api/auth/forgot-password', { username: username.trim() });
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message || 'Failed to submit request. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div
      className="flex min-h-screen items-center justify-center p-8"
      style={{
        background: `linear-gradient(to bottom right, ${branding.loginBgStart}, ${branding.loginBgEnd}, ${branding.loginBgStart})`
      }}
    >
      <div className="w-full max-w-md">
        <div className="relative bg-white/95 backdrop-blur-sm rounded-3xl shadow-2xl overflow-hidden">
          <div
            className="h-2"
            style={{
              background: `linear-gradient(to right, ${branding.gradientStart}, ${branding.gradientMiddle}, ${branding.gradientEnd})`
            }}
          />

          <div className="p-8 pt-6">
            {/* Branding */}
            <div className="text-center mb-8">
              {branding.logoUrl ? (
                <div className="inline-flex items-center justify-center w-40 h-28 mb-4">
                  <img
                    src={branding.logoUrl}
                    alt={branding.appName}
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              ) : (
                <div
                  className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-4 shadow-xl"
                  style={{
                    background: `linear-gradient(to bottom right, ${branding.primaryColor}, ${branding.secondaryColor})`,
                    boxShadow: `0 10px 40px -10px ${branding.secondaryColor}50`
                  }}
                >
                  <span className="text-2xl font-bold text-white tracking-tight">{branding.logoText}</span>
                </div>
              )}
              <h1
                className="text-2xl font-bold mb-2"
                style={{
                  backgroundImage: `linear-gradient(to right, ${branding.primaryColor}, ${branding.secondaryColor})`,
                  backgroundClip: 'text',
                  WebkitBackgroundClip: 'text',
                  WebkitTextFillColor: 'transparent',
                }}
              >
                Forgot Password
              </h1>
              <p className="text-sm text-slate-500">
                {submitted
                  ? 'Your request has been submitted'
                  : 'Enter your User ID to request a password reset'}
              </p>
            </div>

            {submitted ? (
              <div className="space-y-6">
                <div className="flex items-center gap-3 rounded-xl bg-gradient-to-r from-emerald-50 to-emerald-100 border border-emerald-200 p-4">
                  <div className="w-10 h-10 rounded-full bg-emerald-500 flex items-center justify-center shrink-0">
                    <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                  <div>
                    <p className="text-sm font-semibold text-emerald-800">Request Submitted</p>
                    <p className="text-sm text-emerald-700 mt-1">
                      If your User ID exists in our system, your administrator will be notified.
                      Please contact your administrator to receive your temporary password.
                    </p>
                  </div>
                </div>

                <Button
                  type="button"
                  className="w-full h-12 text-base font-semibold rounded-xl"
                  style={{
                    background: `linear-gradient(to right, ${branding.primaryColor}, ${branding.secondaryColor})`,
                  }}
                  onClick={() => navigate('/login')}
                >
                  Back to Login
                </Button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-5">
                {error && (
                  <div className="flex items-center gap-3 rounded-xl bg-gradient-to-r from-red-50 to-red-100 border border-red-200 p-4">
                    <div className="w-10 h-10 rounded-full bg-red-500 flex items-center justify-center shrink-0">
                      <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </div>
                    <p className="text-sm text-red-700 font-medium">{error}</p>
                  </div>
                )}

                <div className="space-y-2">
                  <label className="block text-sm font-semibold text-slate-700">User ID</label>
                  <div className="relative">
                    <div className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400">
                      <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
                      </svg>
                    </div>
                    <Input
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      placeholder="Enter your User ID"
                      autoFocus
                      className="h-12 pl-12 pr-4 text-base rounded-xl border-2 border-slate-200 bg-slate-50/50 transition-all"
                    />
                  </div>
                </div>

                <div className="rounded-xl bg-amber-50 border border-amber-200 p-4">
                  <div className="flex gap-3">
                    <svg className="w-5 h-5 text-amber-600 shrink-0 mt-0.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
                    </svg>
                    <div className="text-sm text-amber-800">
                      <p className="font-semibold">How it works:</p>
                      <ol className="mt-1 ml-4 list-decimal text-amber-700 space-y-0.5">
                        <li>Submit your User ID</li>
                        <li>Your administrator will receive a notification</li>
                        <li>Contact your administrator for the temporary password</li>
                        <li>Log in and set a new password</li>
                      </ol>
                    </div>
                  </div>
                </div>

                <div className="space-y-3">
                  <Button
                    type="submit"
                    className="w-full h-12 text-base font-semibold rounded-xl transition-all hover:-translate-y-0.5"
                    style={{
                      background: `linear-gradient(to right, ${branding.primaryColor}, ${branding.secondaryColor})`,
                      boxShadow: `0 10px 40px -10px ${branding.secondaryColor}50`,
                    }}
                    disabled={isSubmitting}
                  >
                    {isSubmitting ? (
                      <span className="flex items-center gap-2">
                        <svg className="animate-spin h-5 w-5" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
                        </svg>
                        Submitting...
                      </span>
                    ) : 'Submit Request'}
                  </Button>

                  <button
                    type="button"
                    className="w-full text-sm font-semibold transition-colors py-2"
                    style={{ color: branding.secondaryColor }}
                    onClick={() => navigate('/login')}
                  >
                    Back to Login
                  </button>
                </div>
              </form>
            )}

            {/* Company info */}
            <div className="mt-8 pt-6 border-t border-slate-200 text-center">
              <p className="text-base font-bold text-slate-700">{branding.companyName}</p>
              <p className="text-sm text-slate-500 mt-1 font-semibold">Version {branding.version}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
