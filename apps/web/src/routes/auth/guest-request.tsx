import { useState } from 'react';
import { useBranding } from '@/hooks/use-branding';
import { getApiBase } from '@/lib/api-base';

// Public (unauthenticated) page reached from the login "Guest" button. Collects a
// filter cleaning request and posts it to the public /api/guest/cleaning-request,
// which drops a GUEST_CLEANING_REQUEST notification to the configured roles.
const FIELDS = [
  { key: 'name', label: 'Name', placeholder: 'Your full name' },
  { key: 'employeeId', label: 'Employee ID', placeholder: 'e.g. EMP-001' },
  { key: 'block', label: 'Block', placeholder: 'Block' },
  { key: 'area', label: 'Area', placeholder: 'Area' },
  { key: 'ahu', label: 'AHU', placeholder: 'AHU' },
  { key: 'filter', label: 'Filter', placeholder: 'Filter' },
] as const;

type FieldKey = (typeof FIELDS)[number]['key'];

export function GuestRequestPage() {
  const { branding } = useBranding();
  const [form, setForm] = useState<Record<FieldKey, string>>({ name: '', employeeId: '', block: '', area: '', ahu: '', filter: '' });
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');

  const allFilled = FIELDS.every((f) => form[f.key].trim().length > 0);
  const set = (k: FieldKey, v: string) => setForm((p) => ({ ...p, [k]: v }));

  const base = getApiBase();

  const submit = async () => {
    if (!allFilled || submitting) return;
    setSubmitting(true); setError('');
    try {
      const payload = Object.fromEntries(FIELDS.map((f) => [f.key, form[f.key].trim()]));
      const res = await fetch(`${base}/api/guest/cleaning-request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.message || `Request failed (HTTP ${res.status})`);
      }
      setDone(true);
    } catch (e: any) {
      setError(e?.message || 'Could not submit your request. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-2xl shadow-xl overflow-hidden">
        <div className="px-6 py-5" style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}>
          <h1 className="text-lg font-bold text-white">Filter Cleaning Request</h1>
          <p className="text-white/70 text-sm">{branding.appName} — guest request</p>
        </div>

        {done ? (
          <div className="p-8 text-center space-y-3">
            <div className="w-14 h-14 mx-auto rounded-full bg-emerald-50 flex items-center justify-center">
              <svg className="w-7 h-7 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" /></svg>
            </div>
            <p className="text-slate-700 font-semibold">Request submitted</p>
            <p className="text-sm text-slate-500">Your filter cleaning request has been sent. Thank you.</p>
            <a href="/login" className="inline-block mt-2 text-sm font-medium text-cyan-600 hover:underline">Back to login</a>
          </div>
        ) : (
          <div className="p-6 space-y-4">
            <p className="text-sm text-slate-500">Fill in all fields, then submit your request.</p>
            {error && <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>}
            {FIELDS.map((f) => (
              <label key={f.key} className="block">
                <span className="block text-sm font-medium text-slate-700 mb-1">{f.label} <span className="text-red-500">*</span></span>
                <input
                  type="text"
                  value={form[f.key]}
                  onChange={(e) => set(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  maxLength={f.key === 'employeeId' ? 60 : 120}
                  className="w-full bg-white border border-slate-200 rounded-xl px-3 py-2.5 text-sm text-slate-700 placeholder:text-slate-400 focus:border-cyan-400 focus:ring-2 focus:ring-cyan-100 outline-none transition-all"
                />
              </label>
            ))}
            <button
              onClick={submit}
              disabled={!allFilled || submitting}
              className="w-full py-2.5 rounded-xl text-white text-sm font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-all"
              style={{ background: 'linear-gradient(to right, var(--theme-gradient-from), var(--theme-gradient-to))' }}
            >
              {submitting ? 'Submitting…' : 'Submit Request'}
            </button>
            <div className="text-center">
              <a href="/login" className="text-sm font-medium text-slate-500 hover:text-slate-700 hover:underline">Back to login</a>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
