import { useState, useEffect } from 'react';
import { useBranding } from '@/hooks/use-branding';
import { apiUrl } from '@/lib/url-utils';

const REQUEST_TYPES = [
  { value: 'CREATE_USER', label: 'Create User Account' },
  { value: 'MODIFY_USER', label: 'Modify User Account' },
  { value: 'UNLOCK', label: 'Unlock Account' },
  { value: 'FORGOT_PASSWORD', label: 'Forgot Password' },
];

export function ContactAdminPage() {
  const { branding } = useBranding();
  const [requestType, setRequestType] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [requesterEmployeeId, setRequesterEmployeeId] = useState('');
  const [requesterEmail, setRequesterEmail] = useState('');
  const [remarks, setRemarks] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [error, setError] = useState('');

  // Type-specific fields
  const [newUserId, setNewUserId] = useState(''); // CREATE_USER: requested login ID for the new account
  const [fullName, setFullName] = useState('');
  const [department, setDepartment] = useState('');
  const [email, setEmail] = useState('');
  const [requestedRole, setRequestedRole] = useState('');
  const [username, setUsername] = useState('');
  const [modifyField, setModifyField] = useState('');
  const [newValue, setNewValue] = useState('');

  // User lookup (for MODIFY_USER / UNLOCK / FORGOT_PASSWORD target user)
  type LookupUser = { username: string; fullName: string; email: string; department: string | null; role: string; roleDisplayName: string; status: string };
  const [lookupUser, setLookupUser] = useState<LookupUser | null>(null);
  const [lookupError, setLookupError] = useState('');
  const [lookingUp, setLookingUp] = useState(false);

  // Requester lookup (by Employee ID) — required for audit trail traceability
  const [requesterUser, setRequesterUser] = useState<LookupUser | null>(null);
  const [requesterLookupError, setRequesterLookupError] = useState('');
  const [requesterLookingUp, setRequesterLookingUp] = useState(false);

  const performRequesterLookup = async () => {
    const trimmed = requesterEmployeeId.trim();
    if (!trimmed) return;
    setRequesterLookingUp(true);
    setRequesterLookupError('');
    setRequesterUser(null);
    try {
      const res = await fetch(apiUrl(`/api/admin-requests/user-lookup?username=${encodeURIComponent(trimmed)}`));
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRequesterLookupError(data.message ?? `Lookup failed (${res.status})`);
        return;
      }
      // Delta-audit (May 16 H1) — endpoint now returns minimal info to prevent
      // unauthenticated org enumeration. Email + role + department dropped;
      // operator must type them in the form below.
      const data = await res.json() as { exists: boolean; username: string; fullName: string | null };
      if (!data.exists) {
        setRequesterLookupError('Employee ID does not exist in the application');
        return;
      }
      setRequesterUser({ username: data.username, fullName: data.fullName ?? '', email: '', department: null, role: '', roleDisplayName: '', status: '' });
      setRequesterName(data.fullName ?? '');
    } catch (err: any) {
      setRequesterLookupError(err.message ?? 'Lookup failed');
    } finally {
      setRequesterLookingUp(false);
    }
  };

  const needsLookup = requestType === 'MODIFY_USER' || requestType === 'UNLOCK' || requestType === 'FORGOT_PASSWORD';

  // Reset dependent state when request type changes
  useEffect(() => {
    setUsername('');
    setLookupUser(null);
    setLookupError('');
    setModifyField('');
    setNewValue('');
    setNewUserId('');
  }, [requestType]);

  // When requester identity is cleared (Employee ID changed after verify), reset the form below
  useEffect(() => {
    if (!requesterUser) {
      setRequestType('');
      setNewUserId('');
      setFullName('');
      setDepartment('');
      setEmail('');
      setRequestedRole('');
      setRemarks('');
    }
  }, [requesterUser]);

  // Reset modify selection when user lookup changes
  useEffect(() => {
    setModifyField('');
    setNewValue('');
  }, [lookupUser]);

  const performLookup = async () => {
    const trimmed = username.trim();
    if (!trimmed) return;
    setLookingUp(true);
    setLookupError('');
    setLookupUser(null);
    try {
      const res = await fetch(apiUrl(`/api/admin-requests/user-lookup?username=${encodeURIComponent(trimmed)}`));
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setLookupError(data.message ?? `Lookup failed (${res.status})`);
        return;
      }
      const data = await res.json() as { exists: boolean; username: string; fullName: string | null };
      if (!data.exists) {
        setLookupError('Employee ID does not exist in the application');
        return;
      }
      setLookupUser({ username: data.username, fullName: data.fullName ?? '', email: '', department: null, role: '', roleDisplayName: '', status: '' });
    } catch (err: any) {
      setLookupError(err.message ?? 'Lookup failed');
    } finally {
      setLookingUp(false);
    }
  };

  const currentFieldValue = (field: string): string => {
    if (!lookupUser) return '';
    switch (field) {
      case 'fullName': return lookupUser.fullName;
      case 'email': return lookupUser.email;
      case 'department': return lookupUser.department ?? '';
      case 'role': return lookupUser.roleDisplayName;
      default: return '';
    }
  };

  // Fetch available roles for Create User
  const [roles, setRoles] = useState<{ name: string; displayName: string }[]>([]);
  useEffect(() => {
    fetch(apiUrl('/api/roles/active'))
      .then(r => r.json())
      .then(d => {
        const list = Array.isArray(d) ? d : d.data ?? [];
        setRoles(list.filter((r: { name: string }) => r.name !== 'SUPER_ADMIN'));
      })
      .catch(() => {});
  }, []);

  const buildRequestData = () => {
    switch (requestType) {
      case 'CREATE_USER':
        return { username: newUserId.trim(), fullName, department, email, requestedRole };
      case 'MODIFY_USER':
        return { username: lookupUser?.username ?? username, modifyField, newValue };
      case 'UNLOCK':
        return { username: lookupUser?.username ?? username };
      case 'FORGOT_PASSWORD':
        return { username: lookupUser?.username ?? username };
      default:
        return {};
    }
  };

  const isAlreadyEnabled = requestType === 'UNLOCK' && lookupUser?.status === 'ENABLED';

  const canSubmit = () => {
    if (!requestType || !requesterName.trim() || !remarks.trim()) return false;
    if (!requesterUser) return false;
    switch (requestType) {
      case 'CREATE_USER':
        return newUserId.trim().length >= 6 && fullName.trim() && requestedRole;
      case 'MODIFY_USER':
        return !!lookupUser && !!modifyField && newValue.trim() !== '' && newValue !== currentFieldValue(modifyField);
      case 'UNLOCK':
        return !!lookupUser && !isAlreadyEnabled;
      case 'FORGOT_PASSWORD':
        return !!lookupUser;
      default:
        return false;
    }
  };

  const getMissingFields = (): string[] => {
    const missing: string[] = [];
    if (!requesterUser) missing.push('Your Employee ID (verify required)');
    if (!requestType) missing.push('Request Type');
    if (requestType === 'CREATE_USER') {
      if (!newUserId.trim()) missing.push('User ID');
      else if (newUserId.trim().length < 6) missing.push('User ID (min 6 characters)');
      if (!fullName.trim()) missing.push('Full Name');
      if (!requestedRole) missing.push('Requested Role');
    }
    if (requestType === 'MODIFY_USER') {
      if (!lookupUser) missing.push('Employee ID (target user)');
      if (lookupUser && !modifyField) missing.push('What to Modify');
      if (lookupUser && modifyField && !newValue.trim()) missing.push('New Value');
      if (lookupUser && modifyField && newValue && newValue === currentFieldValue(modifyField)) {
        missing.push('New Value (must differ from current)');
      }
    }
    if (requestType === 'UNLOCK') {
      if (!lookupUser) missing.push('Employee ID (target user)');
      if (lookupUser && isAlreadyEnabled) missing.push('Account is already enabled — no unlock needed');
    }
    if (requestType === 'FORGOT_PASSWORD') {
      if (!lookupUser) missing.push('Employee ID (target user)');
    }
    if (requestType && !remarks.trim()) missing.push('Reason / Remarks');
    return missing;
  };

  const handleSubmit = async () => {
    const missing = getMissingFields();
    if (missing.length > 0) {
      setError(`Please fill in the required details: ${missing.join(', ')}.`);
      return;
    }
    setSubmitting(true);
    setError('');

    try {
      const payload = {
        requestType,
        requesterName: (requesterUser?.fullName ?? requesterName).trim(),
        requesterEmployeeId: (requesterUser?.username ?? requesterEmployeeId).trim(),
        requesterEmail: (requesterUser?.email ?? requesterEmail).trim() || undefined,
        requestData: buildRequestData(),
        remarks: remarks.trim(),
      };
      const res = await fetch(apiUrl('/api/admin-requests'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.message ?? `Server error (${res.status})`);
      }
      setSubmitted(true);
    } catch (err: any) {
      setError(err.message ?? 'Something went wrong. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="min-h-screen flex items-center justify-center p-4" style={{ background: `linear-gradient(135deg, ${branding.loginBgStart ?? '#0f172a'}, ${branding.loginBgEnd ?? '#1e293b'})` }}>
        <div className="bg-white rounded-2xl shadow-xl p-8 w-full max-w-md text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-xl font-bold text-slate-800 mb-2">Request Submitted</h2>
          <p className="text-sm text-slate-500 mb-6">Your request has been sent to the administrator. You will be notified once it's processed.</p>
          <a href="/login" className="inline-block px-6 py-2 rounded-lg text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-700 transition-colors">
            Back to Login
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4" style={{ background: `linear-gradient(135deg, ${branding.loginBgStart ?? '#0f172a'}, ${branding.loginBgEnd ?? '#1e293b'})` }}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg overflow-hidden">
        {/* Header */}
        <div className="px-8 py-6 border-b border-slate-200">
          <div className="flex items-center gap-3 mb-1">
            <a href="/login" className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </a>
            <h1 className="text-xl font-bold text-slate-800">Contact Admin</h1>
          </div>
          <p className="text-sm text-slate-500 ml-9">Submit a request to the system administrator</p>
        </div>

        {/* Form */}
        <div className="px-8 py-6 space-y-4 max-h-[70vh] overflow-y-auto">
          {error && (
            <div className="rounded-lg bg-red-50 border border-red-200 p-3 text-sm text-red-700">{error}</div>
          )}

          {/* Your Information */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Your Information</h3>
            <p className="text-xs text-slate-500">Enter the Employee ID of the account you're submitting this request from. It will be recorded in the audit trail.</p>
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">Your Employee ID <span className="text-red-500">*</span></label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={requesterEmployeeId}
                  onChange={e => {
                    setRequesterEmployeeId(e.target.value);
                    setRequesterUser(null);
                    setRequesterLookupError('');
                  }}
                  onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); performRequesterLookup(); } }}
                  placeholder="EMP-001"
                  className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                />
                <button
                  type="button"
                  onClick={performRequesterLookup}
                  disabled={!requesterEmployeeId.trim() || requesterLookingUp}
                  className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 transition-colors"
                >
                  {requesterLookingUp ? 'Verifying...' : 'Verify'}
                </button>
              </div>
              {requesterLookupError && (
                <p className="mt-2 text-sm text-red-600">{requesterLookupError}</p>
              )}
              {requesterUser && (
                <div className="mt-2 rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm">
                  <div className="flex items-start gap-2">
                    <svg className="w-4 h-4 text-emerald-600 mt-0.5 shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                    </svg>
                    <div>
                      <div className="font-semibold text-emerald-800">{requesterUser.fullName}</div>
                      <div className="text-[12px] text-emerald-700">{requesterUser.roleDisplayName} · {requesterUser.email}</div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Request Type — only after Employee ID is verified */}
          {!requesterUser ? (
            <div className="pt-2">
              <div className="rounded-lg bg-slate-50 border border-slate-200 p-4 text-sm text-slate-500 text-center">
                Verify your Employee ID to continue.
              </div>
            </div>
          ) : (
            <div className="pt-2 space-y-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Request Details</h3>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Request Type <span className="text-red-500">*</span></label>
                <select value={requestType} onChange={e => setRequestType(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500">
                  <option value="">Select request type...</option>
                  {REQUEST_TYPES.map(rt => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
                </select>
              </div>
            </div>
          )}

          {/* Dynamic Fields Based on Request Type */}
          {requestType === 'CREATE_USER' && (
            <div className="space-y-3 p-4 rounded-lg bg-blue-50 border border-blue-200">
              <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider">New User Details</p>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">User ID <span className="text-red-500">*</span></label>
                <input type="text" value={newUserId} onChange={e => setNewUserId(e.target.value)}
                  placeholder="e.g. jdoe01" autoComplete="off"
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                <p className="mt-1 text-xs text-slate-500">Login ID for the new account (minimum 6 characters).</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Full Name <span className="text-red-500">*</span></label>
                <input type="text" value={fullName} onChange={e => setFullName(e.target.value)}
                  placeholder="John Doe" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">Department</label>
                  <input type="text" value={department} onChange={e => setDepartment(e.target.value)}
                    placeholder="Engineering" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">Email <span className="text-xs font-normal text-slate-400">(optional)</span></label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="user@company.com (optional)" className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Requested Role <span className="text-red-500">*</span></label>
                <select value={requestedRole} onChange={e => setRequestedRole(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500">
                  <option value="">Select role...</option>
                  {roles.map(r => <option key={r.name} value={r.name}>{r.displayName}</option>)}
                </select>
              </div>
            </div>
          )}

          {needsLookup && (
            <div className={`space-y-3 p-4 rounded-lg border ${
              requestType === 'MODIFY_USER' ? 'bg-amber-50 border-amber-200' :
              requestType === 'UNLOCK' ? 'bg-red-50 border-red-200' :
              'bg-purple-50 border-purple-200'
            }`}>
              <p className={`text-xs font-semibold uppercase tracking-wider ${
                requestType === 'MODIFY_USER' ? 'text-amber-700' :
                requestType === 'UNLOCK' ? 'text-red-700' :
                'text-purple-700'
              }`}>
                {requestType === 'MODIFY_USER' ? 'Modification Details' : requestType === 'UNLOCK' ? 'Unlock Details' : 'Password Reset Details'}
              </p>

              {/* Step 1: Employee ID lookup */}
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Employee ID <span className="text-red-500">*</span></label>
                <div className="flex gap-2">
                  <input
                    type="text"
                    value={username}
                    onChange={e => { setUsername(e.target.value); setLookupUser(null); setLookupError(''); }}
                    onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); performLookup(); } }}
                    placeholder="Enter employee ID"
                    className="flex-1 px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                  />
                  <button
                    type="button"
                    onClick={performLookup}
                    disabled={!username.trim() || lookingUp}
                    className="px-4 py-2 rounded-lg text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-700 disabled:opacity-50 transition-colors"
                  >
                    {lookingUp ? 'Looking up...' : 'Lookup'}
                  </button>
                </div>
                {lookupError && (
                  <p className="mt-2 text-sm text-red-600">{lookupError}</p>
                )}
              </div>

              {/* Step 2: Show fetched user details */}
              {lookupUser && (
                <div className="rounded-lg bg-white border border-slate-200 p-3">
                  <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-2">Current User Details</p>
                  <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div>
                      <div className="text-[11px] text-slate-400">Full Name</div>
                      <div className="font-medium text-slate-800">{lookupUser.fullName}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">Email</div>
                      <div className="font-medium text-slate-800 break-all">{lookupUser.email}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">Department</div>
                      <div className="font-medium text-slate-800">{lookupUser.department || '—'}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">Role</div>
                      <div className="font-medium text-slate-800">{lookupUser.roleDisplayName}</div>
                    </div>
                    <div>
                      <div className="text-[11px] text-slate-400">Status</div>
                      <div className="font-medium text-slate-800">{lookupUser.status}</div>
                    </div>
                  </div>
                </div>
              )}

              {/* UNLOCK: refuse if already enabled */}
              {lookupUser && requestType === 'UNLOCK' && lookupUser.status === 'ENABLED' && (
                <div className="rounded-lg bg-emerald-50 border border-emerald-200 p-3 text-sm text-emerald-800">
                  <strong>Your account is already enabled.</strong> No unlock request is needed — please try logging in again.
                </div>
              )}

              {/* Step 3 (MODIFY_USER only): choose field + enter new value */}
              {lookupUser && requestType === 'MODIFY_USER' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">What to Modify <span className="text-red-500">*</span></label>
                    <select value={modifyField} onChange={e => { setModifyField(e.target.value); setNewValue(''); }}
                      className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500">
                      <option value="">Select field...</option>
                      <option value="fullName">Full Name</option>
                      <option value="email">Email</option>
                      <option value="department">Department</option>
                      <option value="role">Role</option>
                    </select>
                  </div>
                  {modifyField && (
                    <div className="grid grid-cols-1 gap-3">
                      <div>
                        <label className="block text-sm font-medium text-slate-600 mb-1">Current Value</label>
                        <input type="text" value={currentFieldValue(modifyField)} disabled
                          className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-slate-100 text-slate-500" />
                      </div>
                      <div>
                        <label className="block text-sm font-medium text-slate-600 mb-1">New Value <span className="text-red-500">*</span></label>
                        {modifyField === 'role' ? (
                          <select value={newValue} onChange={e => setNewValue(e.target.value)}
                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500">
                            <option value="">Select new role...</option>
                            {roles.filter(r => r.name !== lookupUser.role).map(r => (
                              <option key={r.name} value={r.name}>{r.displayName}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={modifyField === 'email' ? 'email' : 'text'}
                            value={newValue}
                            onChange={e => setNewValue(e.target.value)}
                            placeholder={`Enter new ${modifyField === 'fullName' ? 'full name' : modifyField}`}
                            className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm bg-white focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500"
                          />
                        )}
                        {newValue && newValue === currentFieldValue(modifyField) && (
                          <p className="mt-1 text-xs text-amber-600">New value is the same as current value.</p>
                        )}
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          )}

          {/* Remarks */}
          {requestType && (
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">Reason / Remarks <span className="text-red-500">*</span></label>
              <textarea value={remarks} onChange={e => setRemarks(e.target.value)}
                placeholder="Explain why you need this request..."
                rows={3} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm resize-none focus:ring-2 focus:ring-cyan-500 focus:border-cyan-500" />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-8 py-4 border-t border-slate-200 bg-slate-50 flex items-center gap-3">
          <a href="/login" className="flex-1 px-4 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors text-center">
            Cancel
          </a>
          <button
            onClick={handleSubmit}
            disabled={submitting}
            className="flex-1 px-4 py-2.5 rounded-lg text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? 'Submitting...' : 'Submit Request'}
          </button>
        </div>
      </div>
    </div>
  );
}
