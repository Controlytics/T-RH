import { useState } from 'react';
import { apiClient } from '@/lib/api-client';
import { useAuth } from '@/hooks/use-auth';
import { useToast } from '@/hooks/use-toast';
import type { useReauth } from '@/hooks/use-reauth';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';

/**
 * Deleting a functional location (2026-10-03, operator: "add delete option for
 * functional locations for super admin"). ONE flow for the list page's cards
 * and the detail page's button: a confirm that states what goes, then the
 * audited, re-authenticated `DELETE /api/functional-locations/:id`.
 *
 * What the confirm says depends on who is asking and what the location holds
 * (`deletePlan`, pure):
 *   - an EMPTY location: "Delete X?" — any role holding the delete permission;
 *   - one that holds areas or instruments, asked by a SUPER_ADMIN: the delete
 *     takes the areas with it and UNLINKS every instrument in them — they stay
 *     registered, in no location — and the confirm says so with the counts.
 *     Sent as `?cascade=true`, which the API refuses to any other role;
 *   - the same, asked by any other role: no confirm — the API's own refusal,
 *     naming what to move first.
 * The instrument counts come from the tree the page already has (`ownCount`,
 * `totalCount`); the API counts again before it acts.
 */
export interface DeletableLocation {
  id: string;
  name: string;
  type: 'BLOCK' | 'AREA';
  ownCount: number;
  totalCount: number;
  /** A Block's Areas; absent or empty for an Area. */
  children?: { id: string }[];
}

export interface DeletePlan {
  /** False when this role cannot delete the location as it stands; `message` then says why. */
  allowed: boolean;
  cascade: boolean;
  title: string;
  message: string;
  warning?: string;
}

const n = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;

export function deletePlan(loc: DeletableLocation, isSuperAdmin: boolean): DeletePlan {
  const areas = loc.type === 'BLOCK' ? (loc.children?.length ?? 0) : 0;
  const instruments = loc.totalCount;
  const kind = loc.type === 'BLOCK' ? 'block' : 'area';
  const title = `Delete ${kind}`;
  if (areas === 0 && instruments === 0) {
    return { allowed: true, cascade: false, title, message: `Delete the ${kind} "${loc.name}"? It holds nothing.` };
  }
  const holds = [instruments > 0 ? n(instruments, 'instrument') : null, areas > 0 ? n(areas, 'area') : null].filter(Boolean).join(' and ');
  if (!isSuperAdmin) {
    return { allowed: false, cascade: false, title, message: `"${loc.name}" still holds ${holds}. Move or unlink them before deleting it.` };
  }
  return {
    allowed: true, cascade: true, title,
    message: areas > 0
      ? `Delete the block "${loc.name}" with its ${n(areas, 'area')}?`
      : `Delete the ${kind} "${loc.name}"?`,
    warning: `${n(instruments, 'instrument')} become unassigned — they stay registered, with their readings and alarms, in no location. A role or user scoped to this location sees nothing from it until re-scoped. This cannot be undone.`,
  };
}

/**
 * The hook: `request(loc)` opens the confirm (or toasts the refusal); the
 * returned `dialog` goes in the page; `onDeleted` runs after a 204 (refresh
 * the tree, leave the page). Takes the page's own `useReauth()` so one
 * ReauthDialog serves every write on the page.
 */
export function useDeleteLocation(reauth: ReturnType<typeof useReauth>, onDeleted: (loc: DeletableLocation) => void | Promise<void>) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [pending, setPending] = useState<{ loc: DeletableLocation; plan: DeletePlan } | null>(null);
  const [busy, setBusy] = useState(false);
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  const request = (loc: DeletableLocation) => {
    const plan = deletePlan(loc, isSuperAdmin);
    if (!plan.allowed) { toast.error('Cannot delete', plan.message); return; }
    setPending({ loc, plan });
  };

  const confirm = () => {
    if (!pending) return;
    const { loc, plan } = pending;
    const url = `/api/functional-locations/${loc.id}${plan.cascade ? '?cascade=true' : ''}`;
    setBusy(true);
    void reauth.execute('DELETE_FUNCTIONAL_LOCATION', async (password?: string) => {
      if (password) await apiClient.deleteWithReauth(url, password);
      else await apiClient.delete(url);
    }, {
      onSuccess: async () => {
        setBusy(false);
        setPending(null);
        toast.success('Location deleted', plan.cascade
          ? `"${loc.name}" is gone; ${n(loc.totalCount, 'instrument')} unassigned.`
          : `"${loc.name}" removed.`);
        await onDeleted(loc);
      },
      onError: (e: unknown) => {
        setBusy(false);
        setPending(null);
        // The API's 409 / 403 name what to do next ("still holds 3
        // instrument(s)"); "delete failed" does not.
        toast.error('Could not delete', (e as { message?: string })?.message ?? 'Please try again.');
      },
      onCancel: () => setBusy(false),
    });
  };

  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      title={pending?.plan.title ?? 'Delete'}
      message={pending?.plan.message ?? ''}
      warning={pending?.plan.warning}
      confirmLabel={pending?.plan.cascade ? 'Delete with everything in it' : 'Delete'}
      busyLabel="Deleting…"
      busy={busy}
      onConfirm={confirm}
      onClose={() => { if (!busy) setPending(null); }}
    />
  );

  return { request, dialog, busy };
}
