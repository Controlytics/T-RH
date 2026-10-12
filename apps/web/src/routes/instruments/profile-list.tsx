import { useState } from 'react';
import { Link } from 'react-router-dom';
import useSWR from 'swr';
import { apiClient } from '@/lib/api-client';
import { useCan } from '@/hooks/use-can';
import { useToast } from '@/hooks/use-toast';
import { useReauth } from '@/hooks/use-reauth';
import { ReauthDialog } from '@/components/reauth-dialog';
import { themeGradient, themeGradientBr } from '@/lib/theme-styles';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { PageHeader } from '@/components/ui/page-header';

/**
 * The Instruments landing page: profiles first, instruments inside them.
 *
 * A profile is a named container and nothing more — no settings, nothing
 * inherited. What earns this page its place is the pair of counts on each card:
 * how many instruments a group holds, and how many of those are enabled. That
 * is answerable here without drilling into every group in turn.
 *
 * Deliberately NOT shown here: whether instruments are reporting. That is a
 * per-instrument judgement against each one's expected interval (see `./list`),
 * and rolling it into a profile-level number would invite reading "12 active"
 * as "12 healthy" when it means "12 not switched off".
 *
 * Colour discipline matches the instrument list: the brand gradient appears
 * exactly twice (header mark and primary action); the only other colour is the
 * active count, which is coloured because it is a STATE.
 */

interface Profile {
  id: string;
  name: string;
  description: string | null;
  isActive: boolean;
  instrumentCount: number;
  activeCount: number;
}

export function InstrumentProfileListPage() {
  const { data, mutate, isLoading } = useSWR<{ data: Profile[] }>('/api/instrument-profiles');
  const { toast } = useToast();
  // `DELETE_INSTRUMENT_PROFILE` is an admin-configurable re-auth action
  // (audit 2026-10-03, SEC-7); the server checks it first on DELETE.
  const reauth = useReauth();
  const can = useCan();
  const canCreate = can('instruments.create');
  const canDelete = can('instruments.delete');

  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);

  const profiles = data?.data ?? [];

  const create = async () => {
    setSaving(true);
    try {
      await apiClient.post('/api/instrument-profiles', {
        name: name.trim(),
        ...(description.trim() ? { description: description.trim() } : {}),
      });
      setName('');
      setDescription('');
      setCreating(false);
      mutate();
      toast.success('Profile created', `"${name.trim()}" is ready for instruments.`);
    } catch (e) {
      toast.error('Could not create profile', (e as Error)?.message ?? 'Unknown error');
    }
    setSaving(false);
  };

  const remove = async (p: Profile) => {
    // Idempotent: the hook replays the callback with the password after a 401.
    let done = false;
    await reauth.execute('DELETE_INSTRUMENT_PROFILE', async (password?: string) => {
      if (done) return;
      if (password) await apiClient.deleteWithReauth(`/api/instrument-profiles/${p.id}`, password);
      else await apiClient.delete(`/api/instrument-profiles/${p.id}`);
      done = true;
    }, {
      onSuccess: () => {
        mutate();
        toast.success('Profile deleted', `"${p.name}" was removed.`);
      },
      // The backend refuses a populated profile with the COUNT and a next step.
      // Surfacing its message verbatim beats inventing a vaguer one here.
      // A cancelled password is not an error: nothing was sent.
      onCancel: () => {},
      onError: (e: unknown) => toast.error('Could not delete profile', (e as Error)?.message ?? 'Unknown error'),
    });
  };

  return (
    <div className="p-6 space-y-6 animate-fade-in">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <PageHeader
          title='Instrument Profiles'
          description='Group instruments by area, system or purpose. Open a profile to see and add its instruments.'
          crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Instruments', to: '/instruments' }, { label: 'Instrument Profiles' }]}
          icon={
            <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
            </svg>
          }
        />
        {canCreate && (
          <Button onClick={() => setCreating((c) => !c)} style={creating ? undefined : themeGradient}>
            {creating ? 'Cancel' : '+ New Profile'}
          </Button>
        )}
      </div>

      {/* Create form */}
      {creating && (
        <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-[var(--elev-1)] p-6 space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">Profile Name</span>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Cleanroom-A"
                autoFocus
              />
            </label>
            <label className="block space-y-1">
              <span className="text-sm font-medium text-slate-700">
                Description <span className="text-slate-400 font-normal">(optional)</span>
              </span>
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Grade B cleanroom, Block 2"
              />
            </label>
          </div>
          <div className="flex justify-end">
            <Button onClick={create} disabled={!name.trim() || saving} style={themeGradient}>
              {saving ? 'Creating…' : 'Create Profile'}
            </Button>
          </div>
        </div>
      )}

      {/* Profiles */}
      {isLoading ? (
        <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 p-12 text-center text-slate-400">
          Loading profiles…
        </div>
      ) : profiles.length === 0 ? (
        <div className="bg-white rounded-[var(--radius-card)] border border-slate-200/60 p-12 text-center">
          <p className="text-slate-500">No profiles yet.</p>
          <p className="text-sm text-slate-400 mt-1">
            Create one to start registering instruments — every instrument belongs to a profile.
          </p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {profiles.map((p) => (
            <div
              key={p.id}
              className="group relative bg-white rounded-[var(--radius-card)] border border-slate-200/60 shadow-[var(--elev-1)] hover:shadow-[var(--elev-1)] hover:-translate-y-0.5 transition-all duration-200"
            >
              <Link to={`/instruments/profiles/${p.id}`} className="block p-5">
                <h3 className="font-semibold text-slate-800 pr-8 truncate" title={p.name}>{p.name}</h3>
                {p.description && (
                  <p className="text-sm text-slate-500 mt-1 line-clamp-2">{p.description}</p>
                )}
                <div className="flex items-baseline gap-6 mt-4">
                  <div>
                    <p className="text-2xl font-bold text-slate-800">{p.instrumentCount}</p>
                    <p className="text-xs text-slate-400">
                      instrument{p.instrumentCount === 1 ? '' : 's'}
                    </p>
                  </div>
                  <div>
                    <p className="text-2xl font-bold text-emerald-600">{p.activeCount}</p>
                    {/* ENABLED, not "reporting". The instruments page keeps
                        those two facts apart on purpose — enabled is the admin
                        flag, reporting is whether telemetry is arriving — and
                        conflating them here would tell an operator a silent
                        instrument is healthy. */}
                    <p className="text-xs text-slate-400">enabled</p>
                  </div>
                </div>
              </Link>

              {canDelete && (
                <button
                  onClick={() => remove(p)}
                  title={
                    p.instrumentCount > 0
                      ? `Contains ${p.instrumentCount} instrument${p.instrumentCount === 1 ? '' : 's'} — move or delete them first`
                      : 'Delete this profile'
                  }
                  aria-label={`Delete profile ${p.name}`}
                  className="absolute top-4 right-4 opacity-0 group-hover:opacity-100 focus-visible:opacity-100 transition-opacity p-1.5 rounded-lg text-slate-300 hover:text-red-600 hover:bg-red-50"
                >
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                  </svg>
                </button>
              )}
            </div>
          ))}
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
        actionLabel="Delete Instrument Profile"
      />
    </div>
  );
}
