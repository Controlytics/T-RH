import { useState, useEffect } from 'react';
import { useBranding } from '@/hooks/use-branding';
import { apiUrl } from '@/lib/url-utils';
import { AuthShell } from './auth-shell';
import { Button } from '@/components/ui/button';

// ENABLE_ACCOUNT is not offered (operator, 2026-09-25: "in contact admin page
// remove enable user account feature"); the public route refuses it too. The
// admin page still labels and processes a request stored before the removal.
const REQUEST_TYPES = [
  { value: 'CREATE_USER', label: 'Create User Account' },
  { value: 'MODIFY_USER', label: 'Modify User Account' },
  { value: 'UNLOCK', label: 'Unlock Account' },
  { value: 'FORGOT_PASSWORD', label: 'Forgot Password' },
  { value: 'DISABLE_ACCOUNT', label: 'Disable Account' },
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
  /**
   * What `GET /admin-requests/user-lookup` ACTUALLY returns, and nothing more.
   *
   * It used to declare fullName / email / department / role / roleDisplayName /
   * status; the endpoint returns none of them (2026-05-20 H1 and 2026-08-29 M1
   * dropped them as an enumeration oracle), so every one was permanently `''`.
   * Declaring a field the API does not send is how a form ends up rendering five
   * blanks under a confident heading, and how a guard reading one silently never
   * fires — both happened here.
   */
  type LookupUser = { username: string };
  const [lookupUser, setLookupUser] = useState<LookupUser | null>(null);
  const [lookupError, setLookupError] = useState('');
  const [lookingUp, setLookingUp] = useState(false);

  /**
   * The requester's Employee ID is typed, not looked up (operator, 2026-09-25:
   * "there i dont need verification"). Until then a Verify button checked it
   * against `GET /admin-requests/user-lookup` and hid the rest of the form
   * until it matched a login. The server never checked it on submit and still
   * does not — `admin-request.service.ts` records it as an unverified
   * identity; the admin's approval signature is the verified one. What the
   * removal costs: a mistyped ID is no longer caught before the request waits
   * for an admin. The TARGET account lookup below is unchanged — a request has
   * to name a real account to act on.
   */

  // Every type EXCEPT create acts on an existing account, so all of them need the
  // target-user field. Omitting one here hides the field and the form silently
  // cannot be completed for that type.
  const needsLookup = requestType === 'MODIFY_USER' || requestType === 'UNLOCK'
    || requestType === 'FORGOT_PASSWORD'
    || requestType === 'DISABLE_ACCOUNT';

  // Reset dependent state when request type changes
  useEffect(() => {
    setUsername('');
    setLookupUser(null);
    setLookupError('');
    setModifyField('');
    setNewValue('');
    setNewUserId('');
  }, [requestType]);

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
      const data = await res.json() as { exists: boolean; username: string };
      if (!data.exists) {
        setLookupError('Employee ID does not exist in the application');
        return;
      }
      // fullName is no longer returned (audit M1 — PII to an anonymous caller).
      setLookupUser({ username: data.username });
    } catch (err: any) {
      setLookupError(err.message ?? 'Lookup failed');
    } finally {
      setLookingUp(false);
    }
  };

  /**
   * REMOVED: `currentFieldValue()`.
   *
   * It read `lookupUser.fullName` / `.email` / `.department` / `.roleDisplayName`
   * to enforce "the new value must differ from the current one" — and the lookup
   * returns none of those, so it compared every entry against `''`. The rule could
   * never fire, and the "New Value (must differ from current)" message it produced
   * could never appear. Comparing against the live value would need those fields
   * back on an unauthenticated endpoint, which is the enumeration oracle two audits
   * removed. A no-op modification is harmless and the admin sees both values when
   * approving.
   */

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
      case 'DISABLE_ACCOUNT':
        return { username: lookupUser?.username ?? username };
      default:
        return {};
    }
  };

  /**
   * There is deliberately NO "is it already in that state?" check here.
   *
   * There used to be — `requestType === 'UNLOCK' && lookupUser?.status === 'ENABLED'`
   * — and it could never fire: `GET /admin-requests/user-lookup` returns only
   * `{exists, username}`. `status`, `role`, `email` and `department` were dropped
   * by the 2026-05-20 delta audit (H1) because a response that varies with the
   * account is an unauthenticated enumeration oracle for the staff directory. So
   * `lookupUser.status` was always `''` and the control was decoration — which is
   * how an unlock was requested for an account that was never locked, and approved
   * as though it had been (operator, 2026-09-02).
   *
   * **Do not restore it by putting `status` back on that endpoint.** The check now
   * lives at APPROVAL, where the caller is authenticated and entitled to see the
   * account: `admin-requests/account-state.ts`. That is also the only place it can
   * be correct — an account's state can change between submission and approval, so
   * submission-time state is not the state being acted on.
   */

  const getMissingFields = (): string[] => {
    const missing: string[] = [];
    if (!requesterName.trim()) missing.push('Your Name');
    if (!requesterEmployeeId.trim()) missing.push('Your Employee ID');
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
    }
    if (requestType === 'UNLOCK' || requestType === 'DISABLE_ACCOUNT') {
      if (!lookupUser) missing.push('Employee ID (target user)');
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
        /**
         * DEFECT FIXED 2026-09-02: this read
         * `(requesterUser?.fullName ?? requesterName).trim()`. `fullName` is `''`
         * on every verified lookup — the endpoint stopped returning it in the
         * 2026-08-29 PII audit — and `??` falls back only on null/undefined, NOT
         * on an empty string. So a verified requester sent `requesterName: ""`,
         * which the route rejects with `minLength: 1`: the form 400'd on EVERY
         * submission once the requester's ID was verified.
         *
         * The typed values are the source now, which is what the lookup comment
         * already said should happen. `??` after a field that can be `''` is the
         * shape to distrust.
         */
        requesterName: requesterName.trim(),
        requesterEmployeeId: requesterEmployeeId.trim(),
        requesterEmail: requesterEmail.trim() || undefined,
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
      <AuthShell>
        <div className="p-8 text-center">
          <div className="w-16 h-16 rounded-full bg-emerald-100 flex items-center justify-center mx-auto mb-4">
            <svg className="w-8 h-8 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <h2 className="text-[1.1875rem] font-semibold leading-tight text-slate-800 mb-2">Request Submitted</h2>
          <p className="text-sm text-slate-500 mb-6">Your request has been sent to the administrator. You will be notified once it's processed.</p>
          <a href="/login" className="inline-block px-6 py-2 rounded-lg text-sm font-medium text-white bg-cyan-600 hover:bg-cyan-700 transition-colors">
            Back to Login
          </a>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell width="lg">
        {/* Header */}
        <div className="px-8 py-6 border-b border-slate-200">
          <div className="flex items-center gap-3 mb-1">
            <a href="/login" className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
              </svg>
            </a>
            <h1 className="text-[1.625rem] font-semibold leading-tight tracking-[-0.01em] text-slate-900">Contact Admin</h1>
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
              <label className="block text-sm font-medium text-slate-600 mb-1">Your Name <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={requesterName}
                onChange={e => setRequesterName(e.target.value)}
                placeholder="Your name"
                aria-label="Your Name"
                className="ctl w-full"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">Your Employee ID <span className="text-red-500">*</span></label>
              <input
                type="text"
                value={requesterEmployeeId}
                onChange={e => setRequesterEmployeeId(e.target.value)}
                placeholder="EMP-001"
                aria-label="Your Employee ID"
                className="ctl w-full"
              />
            </div>
          </div>

          {/* Request Type */}
          <div className="pt-2 space-y-3">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Request Details</h3>
            <div>
              <label className="block text-sm font-medium text-slate-600 mb-1">Request Type <span className="text-red-500">*</span></label>
              <select value={requestType} onChange={e => setRequestType(e.target.value)}
                aria-label="Request Type"
                className="ctl w-full">
                <option value="">Select request type...</option>
                {REQUEST_TYPES.map(rt => <option key={rt.value} value={rt.value}>{rt.label}</option>)}
              </select>
            </div>
          </div>

          {/* Dynamic Fields Based on Request Type */}
          {requestType === 'CREATE_USER' && (
            <div className="space-y-3 p-4 rounded-lg bg-blue-50 border border-blue-200">
              <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider">New User Details</p>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">User ID <span className="text-red-500">*</span></label>
                <input type="text" value={newUserId} onChange={e => setNewUserId(e.target.value)}
                  placeholder="e.g. jdoe01" autoComplete="off"
                  className="ctl w-full" />
                <p className="mt-1 text-xs text-slate-500">Login ID for the new account (minimum 6 characters).</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Full Name <span className="text-red-500">*</span></label>
                <input type="text" value={fullName} onChange={e => setFullName(e.target.value)}
                  placeholder="John Doe" className="ctl w-full" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">Department</label>
                  <input type="text" value={department} onChange={e => setDepartment(e.target.value)}
                    placeholder="Engineering" className="ctl w-full" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-600 mb-1">Email <span className="text-xs font-normal text-slate-400">(optional)</span></label>
                  <input type="email" value={email} onChange={e => setEmail(e.target.value)}
                    placeholder="user@company.com (optional)" className="ctl w-full" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-600 mb-1">Requested Role <span className="text-red-500">*</span></label>
                <select value={requestedRole} onChange={e => setRequestedRole(e.target.value)}
                  className="ctl w-full">
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
                    className="ctl flex-1"
                  />
                  <Button 
                    type="button"
                    onClick={performLookup}
                    disabled={!username.trim() || lookingUp}
                  >
                    {lookingUp ? 'Looking up...' : 'Lookup'}
                  </Button>
                </div>
                {lookupError && (
                  <p className="mt-2 text-sm text-red-600">{lookupError}</p>
                )}
              </div>

              {/* Step 2: Show fetched user details */}
              {lookupUser && (
                <div className="rounded-lg bg-white border border-slate-200 p-3">
                  {/*
                    A "Current User Details" panel of Full Name / Email / Department
                    / Role / Status stood here and rendered FIVE BLANK VALUES.

                    `GET /admin-requests/user-lookup` returns `{exists, username}`
                    and nothing else: email, department, role and status were dropped
                    by the 2026-05-20 delta audit (H1) and `fullName` by the
                    2026-08-29 audit (M1), because an unauthenticated response that
                    varies with the account is an enumeration oracle for the staff
                    directory — 20 guesses per IP per 15 minutes, which distributed
                    is not a brake.

                    So the panel could never have shown anything, and the "Your
                    account is already enabled" banner beside it could never appear.
                    That is why an unlock could be requested for an account that was
                    never locked (operator, 2026-09-02): nothing on this form knew,
                    and nothing could. The check is at APPROVAL now — see
                    `admin-requests/account-state.ts`. Confirming the ID exists is
                    all this step can honestly do.
                  */}
                  <p className="text-[0.6875rem] font-bold text-slate-400 uppercase tracking-wider mb-1">User Confirmed</p>
                  <p className="text-sm font-medium text-slate-800">{lookupUser.username}</p>
                  <p className="text-[0.6875rem] text-slate-500 mt-1">
                    An administrator will check the account and act on your request.
                  </p>
                </div>
              )}

              {/* Step 3 (MODIFY_USER only): choose field + enter new value */}
              {lookupUser && requestType === 'MODIFY_USER' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-slate-600 mb-1">What to Modify <span className="text-red-500">*</span></label>
                    <select value={modifyField} onChange={e => { setModifyField(e.target.value); setNewValue(''); }}
                      className="ctl w-full">
                      <option value="">Select field...</option>
                      <option value="fullName">Full Name</option>
                      <option value="email">Email</option>
                      <option value="department">Department</option>
                      <option value="role">Role</option>
                    </select>
                  </div>
                  {modifyField && (
                    <div className="grid grid-cols-1 gap-3">
                      {/* A disabled "Current Value" box stood here and was ALWAYS
                          EMPTY: the lookup returns no field values (2026-05-20 H1 /
                          2026-08-29 M1 — an unauthenticated response that varies with
                          the account is a directory enumeration oracle). An empty box
                          labelled "Current Value" states that the field is currently
                          blank, which is a claim, not a gap. */}
                      <div>
                        <label className="block text-sm font-medium text-slate-600 mb-1">New Value <span className="text-red-500">*</span></label>
                        {modifyField === 'role' ? (
                          <select value={newValue} onChange={e => setNewValue(e.target.value)}
                            className="ctl w-full">
                            <option value="">Select new role...</option>
                            {/* Was `.filter(r => r.name !== lookupUser.role)` — `role`
                                is not returned, so it excluded nothing. */}
                            {roles.map(r => (
                              <option key={r.name} value={r.name}>{r.displayName}</option>
                            ))}
                          </select>
                        ) : (
                          <input
                            type={modifyField === 'email' ? 'email' : 'text'}
                            value={newValue}
                            onChange={e => setNewValue(e.target.value)}
                            placeholder={`Enter new ${modifyField === 'fullName' ? 'full name' : modifyField}`}
                            className="ctl w-full"
                          />
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
                rows={3} className="ctl w-full resize-none" />
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="px-8 py-4 border-t border-slate-200 bg-slate-50 flex items-center gap-3">
          <a href="/login" className="flex-1 px-4 py-2.5 border border-slate-300 rounded-lg text-sm font-medium text-slate-600 hover:bg-slate-100 transition-colors text-center">
            Cancel
          </a>
          <Button className="flex-1"
            onClick={handleSubmit}
            disabled={submitting}
          >
            {submitting ? 'Submitting...' : 'Submit Request'}
          </Button>
        </div>
    </AuthShell>
  );
}
