import { useState } from 'react';
import { getApiBase, setApiBase, normalizeServerUrl } from '@/lib/api-base';

// First-launch (and re-configure) screen where the tablet operator sets the
// server address. Validates with a /api/health ping before saving so a typo or
// an untrusted cert surfaces here instead of a broken login. See spec §3.3.
export default function ServerConfigPage() {
  const [url, setUrl] = useState(getApiBase());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function connect() {
    setError('');
    let norm: string;
    try { norm = normalizeServerUrl(url); }
    catch (e: any) { setError(e.message); return; }
    setBusy(true);
    try {
      const res = await fetch(`${norm}/api/health`, { method: 'GET' });
      if (!res.ok) throw new Error(`status ${res.status}`);
      setApiBase(norm);
      window.location.href = '/m/login';
    } catch {
      setError(
        `Couldn't reach the server at ${norm}. Check the address, that the ` +
        `server is turned on, and that you installed the DigiLog certificate on this tablet.`
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-50 p-6">
      <div className="w-full max-w-sm bg-white rounded-xl border border-slate-200 shadow-sm p-6 space-y-4">
        <h1 className="text-lg font-semibold text-slate-800">Connect to DigiLog server</h1>
        <p className="text-sm text-slate-500">Enter the address shown on the DigiLog PC.</p>
        <input
          type="url"
          inputMode="url"
          autoCapitalize="none"
          className="w-full rounded-lg border border-slate-200 px-3 py-2 text-slate-800"
          placeholder="https://192.168.1.55:3000"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
        />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button
          type="button"
          disabled={busy}
          onClick={connect}
          className="w-full rounded-lg bg-cyan-600 text-white py-2 font-medium disabled:opacity-60"
        >
          {busy ? 'Connecting...' : 'Connect'}
        </button>
      </div>
    </div>
  );
}
