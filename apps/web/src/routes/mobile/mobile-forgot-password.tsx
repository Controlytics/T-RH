import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiClient } from '../../lib/api-client';
import { useBranding } from '../../hooks/use-branding';

/**
 * Tablet forgot-password screen. Mirrors the desktop /forgot-password flow:
 * operator submits their User ID, server logs the request and notifies admins,
 * admin issues a temporary password out-of-band. Backend always returns 200
 * to prevent username enumeration.
 */
export function MobileForgotPasswordPage() {
  const navigate = useNavigate();
  const { branding } = useBranding();
  const [username, setUsername] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!username.trim()) {
      setError('Please enter your User ID');
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      await apiClient.post('/api/auth/forgot-password', { username: username.trim() });
      setSubmitted(true);
    } catch (e: any) {
      setError(e?.message ?? 'Failed to submit request');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      className="min-h-screen flex items-center justify-center p-6"
      style={{
        background: `linear-gradient(to bottom right, ${branding.loginBgStart}, ${branding.loginBgEnd}, ${branding.loginBgStart})`,
      }}
    >
      <div className="bg-white/95 backdrop-blur-sm rounded-3xl shadow-2xl w-full max-w-sm overflow-hidden">
        <div className="h-2" style={{ background: `linear-gradient(to right, ${branding.gradientStart}, ${branding.gradientMiddle}, ${branding.gradientEnd})` }} />
        <div className="p-8 space-y-6">
          <div className="text-center">
            {branding.logoUrl ? (
              <div className="inline-flex items-center justify-center w-40 h-28 mb-4">
                <img src={branding.logoUrl} alt={branding.appName} className="max-w-full max-h-full object-contain" />
              </div>
            ) : (
              <div className="w-16 h-16 rounded-2xl flex items-center justify-center text-white text-2xl font-bold mx-auto mb-4 shadow-xl"
                style={{ background: `linear-gradient(to bottom right, ${branding.primaryColor}, ${branding.secondaryColor})` }}>
                {branding.logoText}
              </div>
            )}
            <h1 className="text-xl font-bold mb-1"
              style={{ backgroundImage: `linear-gradient(to right, ${branding.primaryColor}, ${branding.secondaryColor})`, backgroundClip: 'text', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>
              Forgot Password
            </h1>
            <p className="text-sm text-slate-500">
              {submitted ? 'Your request has been submitted' : 'Request a password reset from your administrator'}
            </p>
          </div>

          {submitted ? (
            <div className="space-y-5">
              <div className="flex items-start gap-3 rounded-xl bg-emerald-50 border border-emerald-200 p-4">
                <div className="w-9 h-9 rounded-full bg-emerald-500 flex items-center justify-center shrink-0">
                  <svg className="w-5 h-5 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                  </svg>
                </div>
                <div className="text-sm text-emerald-800">
                  <p className="font-semibold">Request submitted</p>
                  <p className="text-emerald-700 mt-1">If your User ID exists, your administrator will receive a notification. Contact them to receive your temporary password.</p>
                </div>
              </div>
              <button onClick={() => navigate('/m/login', { replace: true })}
                className="w-full py-4 text-white rounded-xl font-bold text-base"
                style={{ background: `linear-gradient(to right, ${branding.primaryColor}, ${branding.secondaryColor})` }}>
                Back to Login
              </button>
            </div>
          ) : (
            <div className="space-y-5">
              {error && (
                <div className="flex items-center gap-3 rounded-xl bg-red-50 border border-red-200 p-4">
                  <div className="w-8 h-8 rounded-full bg-red-500 flex items-center justify-center shrink-0">
                    <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </div>
                  <p className="text-sm text-red-700 font-medium">{error}</p>
                </div>
              )}
              <div className="space-y-2">
                <label className="block text-sm font-semibold text-slate-700">User ID</label>
                <input type="text" value={username}
                  onChange={e => { setUsername(e.target.value); setError(''); }}
                  onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
                  placeholder="Enter your User ID" autoFocus autoComplete="username"
                  className="w-full bg-slate-50/50 border-2 border-slate-200 rounded-xl px-4 py-4 text-base text-slate-800 placeholder:text-slate-400 focus:outline-none focus:border-blue-400 transition-all" />
              </div>
              <div className="rounded-xl bg-amber-50 border border-amber-200 p-4 text-sm text-amber-800">
                <p className="font-semibold">How it works</p>
                <ol className="mt-1 ml-4 list-decimal text-amber-700 space-y-0.5">
                  <li>Submit your User ID</li>
                  <li>Admin receives a notification</li>
                  <li>Contact admin for a temporary password</li>
                  <li>Sign in and set a new password</li>
                </ol>
              </div>
              <div className="space-y-3">
                <button onClick={handleSubmit} disabled={submitting || !username.trim()}
                  className="w-full py-4 text-white rounded-xl font-bold text-base disabled:opacity-40"
                  style={{ background: `linear-gradient(to right, ${branding.primaryColor}, ${branding.secondaryColor})` }}>
                  {submitting ? 'Submitting…' : 'Submit Request'}
                </button>
                <button onClick={() => navigate('/m/login', { replace: true })}
                  className="w-full text-sm font-semibold py-2"
                  style={{ color: branding.secondaryColor }}>
                  Back to Login
                </button>
              </div>
            </div>
          )}

          <div className="pt-4 border-t border-slate-200 text-center">
            <p className="text-base font-bold text-slate-700">{branding.companyName}</p>
            <p className="text-sm text-slate-500 mt-1 font-semibold">Version {branding.version}</p>
          </div>
        </div>
      </div>
    </div>
  );
}
