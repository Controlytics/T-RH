import { useMemo, useState } from 'react';
import useSWR from 'swr';
import { ATTRIBUTE_ACCESS_MODES, type AttributeAccessMode } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { useToast } from '@/hooks/use-toast';
import { useAttributeLabels } from '@/hooks/use-attribute-labels';
import { Button } from '@/components/ui/button';
import { SearchableSelect } from '@/components/ui/searchable-select';
import { MODE_LABEL } from './attribute-access-tab';

interface Rule { mode: AttributeAccessMode | null; keys: string[]; requireReauth: boolean }
interface UserRow extends Rule {
  userId: string;
  username: string;
  fullName: string | null;
  role: string;
  /** The rule that applies — computed by the SERVER, never re-derived here. */
  effective: Rule;
  /** Without Edit Instruments the user can change no attribute, whatever is set. */
  roleHasUpdate: boolean;
}
interface RoleRow extends Rule { role: string }

const describeRule = (r: Rule) => (r.mode === null
  ? 'Not configured (Edit Instruments decides)'
  : r.mode === 'SELECTED' ? `${MODE_LABEL.SELECTED}: ${r.keys.join(', ') || 'none'}` : MODE_LABEL[r.mode]);

/**
 * One USER's own attribute rule (2026-10-24, operator: "configurable role
 * wise or user wise"). It is COMBINED with their role's: the user may change
 * an attribute if EITHER rule allows it — so a user rule only ever adds
 * editing. Shown beside it: the role's rule and the COMBINED result, both the
 * server's answer (`GET /api/roles/attribute-access/users`), and a warning when
 * the role lacks Edit Instruments, when the rule cannot take effect.
 *
 * Saved one user at a time, re-authenticated as UPDATE_ROLE_CONFIG, with the
 * admin's reason — the server refuses a save without one.
 */
export function UserAttributeAccess() {
  const { toast } = useToast();
  const { labelFor } = useAttributeLabels();
  const reauth = useReauth();
  const { data, mutate } = useSWR<{ users: UserRow[] }>('/api/roles/attribute-access/users');
  const { data: rolesData } = useSWR<{ roles: RoleRow[]; availableKeys: string[] }>('/api/roles/attribute-access');
  const [userId, setUserId] = useState('');
  /** Un-saved edit of the chosen user's rule. null = showing what is stored. */
  const [draft, setDraft] = useState<Rule | null>(null);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  const users = data?.users ?? [];
  const user = users.find((u) => u.userId === userId) ?? null;
  const roleRule = rolesData?.roles.find((r) => r.role === user?.role) ?? null;
  const availableKeys = rolesData?.availableKeys ?? [];
  const now: Rule | null = user ? (draft ?? { mode: user.mode, keys: user.keys, requireReauth: user.requireReauth }) : null;
  const options = useMemo(
    () => users.map((u) => ({ value: u.userId, label: `${u.username}${u.fullName ? ` — ${u.fullName}` : ''} (${u.role})` })),
    [users],
  );

  const pick = (id: string) => { setUserId(id); setDraft(null); setReason(''); };
  const edit = (patch: Partial<Rule>) => { if (now) setDraft({ ...now, ...patch }); };
  const toggleKey = (key: string) => {
    if (!now) return;
    const fold = key.trim().toLowerCase();
    const has = now.keys.some((k) => k.trim().toLowerCase() === fold);
    edit({ keys: has ? now.keys.filter((k) => k.trim().toLowerCase() !== fold) : [...now.keys, key] });
  };

  // `saving` is cleared only by the three outcomes; `execute` returns while the
  // re-auth dialog is still open.
  const save = () => {
    if (!user || !now) return;
    const why = reason.trim();
    if (!why) {
      toast.error('Reason required', "State why this user's attribute access is changing — it is recorded in the audit trail.");
      return;
    }
    const url = `/api/roles/attribute-access/user/${encodeURIComponent(user.userId)}`;
    const body = { mode: now.mode, keys: now.mode === 'SELECTED' ? now.keys : [], requireReauth: now.requireReauth, reason: why };
    setSaving(true);
    void reauth.execute('UPDATE_ROLE_CONFIG', async (password?: string) => {
      if (password) await apiClient.putWithReauth(url, body, password);
      else await apiClient.put(url, body);
    }, {
      onSuccess: async () => {
        setDraft(null);
        setReason('');
        setSaving(false);
        await mutate();
        toast.success('Attribute access saved', `"${user.username}" updated.`);
      },
      onError: (e) => {
        toast.error('Could not save', (e as Error)?.message ?? 'The change was not saved.');
        setSaving(false);
      },
      onCancel: () => setSaving(false),
    });
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-slate-600">
        A user&apos;s own rule is combined with their role&apos;s: they may change an attribute if either allows it.
      </p>
      <SearchableSelect value={userId} onChange={pick} options={options} placeholder="Select a user" className="max-w-md" />

      {user && now && (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <dl className="grid gap-2 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">Their role ({user.role})</dt>
              <dd data-testid="user-role-rule" className="text-slate-800">
                {describeRule(roleRule ?? { mode: null, keys: [], requireReauth: false })}
              </dd>
            </div>
            <div>
              <dt className="text-xs font-semibold uppercase tracking-wider text-slate-500">What applies</dt>
              <dd data-testid="user-effective-rule" className="font-semibold text-slate-800">{describeRule(user.effective)}</dd>
            </div>
          </dl>
          {!user.roleHasUpdate && (
            <p data-testid="user-rule-no-update" className="text-xs text-amber-700">
              Their role has no Edit Instruments permission, so this user can change no attribute whatever is set here.
            </p>
          )}

          <div className="flex flex-wrap gap-4">
            {([null, ...ATTRIBUTE_ACCESS_MODES] as (AttributeAccessMode | null)[]).map((m) => (
              <label key={String(m)} className="flex items-center gap-2 text-sm text-slate-700">
                <input type="radio" name="user-attr-mode" className="ctl-radio" checked={now.mode === m} onChange={() => edit({ mode: m })} />
                {m === null ? 'No rule of their own' : MODE_LABEL[m]}
              </label>
            ))}
          </div>

          {now.mode === 'SELECTED' && (
            <div className="grid gap-1 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-2 lg:grid-cols-3">
              {availableKeys.map((k) => (
                <label key={k} className="flex items-center gap-2 text-sm text-slate-700">
                  <input
                    type="checkbox" className="ctl-check"
                    checked={now.keys.some((s) => s.trim().toLowerCase() === k.trim().toLowerCase())}
                    onChange={() => toggleKey(k)}
                  />
                  <span className="truncate" title={k}>{labelFor(k)}</span>
                </label>
              ))}
            </div>
          )}

          <label className="flex items-center gap-2 text-sm text-slate-700">
            <input
              type="checkbox" className="ctl-check"
              checked={now.requireReauth}
              disabled={now.mode === null || now.mode === 'ALL_VIEW'}
              onChange={(e) => edit({ requireReauth: e.target.checked })}
            />
            Ask for this user&apos;s password on every attribute change
          </label>

          {draft && (
            <div>
              <label htmlFor="user-attr-reason" className="mb-1 block text-xs font-medium text-slate-600">Reason for change</label>
              <input
                id="user-attr-reason" className="ctl w-full" maxLength={500}
                value={reason} onChange={(e) => setReason(e.target.value)}
                placeholder="Why is this changing? Recorded in the audit trail."
              />
            </div>
          )}

          <Button type="button" size="sm" disabled={!draft || saving} onClick={save}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </div>
      )}

      <ReauthDialog
        open={reauth.isOpen}
        password={reauth.password}
        error={reauth.error}
        isVerifying={reauth.isVerifying}
        onPasswordChange={reauth.setPassword}
        onConfirm={reauth.confirm}
        onCancel={reauth.cancel}
      />
    </div>
  );
}
