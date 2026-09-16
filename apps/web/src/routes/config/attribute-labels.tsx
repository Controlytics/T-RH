import { useEffect, useMemo, useState } from 'react';
import useSWR, { mutate as mutateGlobal } from 'swr';
import { ATTRIBUTE_LABEL_MAX, ATTRIBUTE_LABEL_KEY_MAX, coerceAttributeLabels } from '@digilog/shared';
import { apiClient } from '@/lib/api-client';
import { useToast } from '@/hooks/use-toast';
import { ATTRIBUTE_LABELS_URL } from '@/hooks/use-attribute-labels';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { SkeletonCard } from '@/components/ui/skeleton';

/**
 * Configuration → Attribute Display Names (2026-09-16, operator: "key is one
 * thing and that key display name should be configurable").
 *
 * One row per attribute KEY, a Display name beside it, one Save. The key is the
 * stored identity — what a device writes, what the CSV reads, what the audit
 * trail names — and it never changes here. The display name is what a person
 * reads on the New Instrument form, the Attributes panel, the Settings widget
 * and the Attribute Access picker. Blank = the key is shown as itself.
 *
 * The page opens PRE-FILLED with every key the server knows — the union the
 * Attribute Access picker already computes (`GET /api/roles/attribute-access`:
 * every profile's list plus every key recorded on an instrument) — so an admin
 * types names, not keys. A key can still be added by hand for one the server
 * has not seen yet.
 *
 * STORAGE is the `attribute-labels` system_config row, `{labels: {key: name}}`,
 * through the generic `/api/config/dynamic/attribute-labels` PUT — which
 * validates, enforces SUPER_ADMIN and writes the CONFIG_CHANGED audit row. That
 * PUT REPLACES the row, so the page always sends the WHOLE map; a partial body
 * would silently erase every other name.
 *
 * Rows are keyed by a STABLE id, not by array index and not by the key text —
 * the same reasoning as the profile-keys page beside this one.
 */

interface Row { id: number; key: string; name: string; /** true = the key box is editable (added here) */ added: boolean }

let nextId = 1;

/** The map a save would send: trimmed, blank names dropped. */
function toLabels(rows: Row[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) {
    const key = r.key.trim();
    const name = r.name.trim();
    if (key && name) out[key] = name;
  }
  return out;
}

export function AttributeLabelsConfigPage() {
  const { toast } = useToast();
  const { data: stored, mutate: mutateStored } = useSWR<{ labels?: unknown }>('/api/config/dynamic/attribute-labels');
  const { data: access } = useSWR<{ availableKeys: string[] }>('/api/roles/attribute-access');

  const [rows, setRows] = useState<Row[] | null>(null);
  const [saving, setSaving] = useState(false);
  /** The map as the server holds it, in the same normalised form a save sends. */
  const [saved, setSaved] = useState<string | null>(null);

  // Seed once, when both answers are in, then leave the operator's edits alone —
  // a revalidation mid-edit must not overwrite what they are typing.
  useEffect(() => {
    if (rows !== null || !stored || !access) return;
    const labels = coerceAttributeLabels(stored);
    const fold = (k: string) => k.trim().toLowerCase();
    const seen = new Set<string>();
    const seeded: Row[] = [];
    for (const key of access.availableKeys ?? []) {
      if (seen.has(fold(key))) continue;
      seen.add(fold(key));
      const hit = Object.keys(labels).find((k) => fold(k) === fold(key));
      seeded.push({ id: nextId++, key, name: hit ? labels[hit] : '', added: false });
    }
    // A stored key that nothing carries any more still shows — an admin must be
    // able to see and clear a name for a key that has gone.
    for (const [key, name] of Object.entries(labels)) {
      if (seen.has(fold(key))) continue;
      seen.add(fold(key));
      seeded.push({ id: nextId++, key, name, added: false });
    }
    setRows(seeded);
    setSaved(JSON.stringify(toLabels(seeded)));
  }, [rows, stored, access]);

  const normalised = useMemo(() => (rows ? JSON.stringify(toLabels(rows)) : null), [rows]);
  const dirty = normalised !== null && saved !== null && normalised !== saved;

  // Duplicate keys are refused case-insensitively — the same rule every
  // attribute surface applies — and reported on the row, not at the top.
  const dupIds = useMemo(() => {
    const out = new Set<number>();
    const seen = new Map<string, number>();
    for (const r of rows ?? []) {
      const fold = r.key.trim().toLowerCase();
      if (!fold) continue;
      if (seen.has(fold)) out.add(r.id);
      else seen.set(fold, r.id);
    }
    return out;
  }, [rows]);
  const blocked = dupIds.size > 0;
  const named = rows ? Object.keys(toLabels(rows)).length : 0;

  const setName = (id: number, name: string) =>
    setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, name } : r)));
  const setKey = (id: number, key: string) =>
    setRows((rs) => (rs ?? []).map((r) => (r.id === id ? { ...r, key } : r)));
  const remove = (id: number) => setRows((rs) => (rs ?? []).filter((r) => r.id !== id));
  const add = () => setRows((rs) => [...(rs ?? []), { id: nextId++, key: '', name: '', added: true }]);

  const save = async () => {
    if (!rows || blocked || !dirty) return;
    setSaving(true);
    try {
      const labels = toLabels(rows);
      await apiClient.put('/api/config/dynamic/attribute-labels', { labels });
      setSaved(JSON.stringify(labels));
      await mutateStored();
      // Every screen reads the narrow-slice route, not the editor's; without
      // this the Attributes panel keeps the old name until its cache expires.
      await mutateGlobal(ATTRIBUTE_LABELS_URL);
      toast.success('Display names saved', `${named} attribute${named === 1 ? '' : 's'} named.`);
    } catch (err: unknown) {
      toast.error('Could not save', (err as { message?: string })?.message ?? 'The display names were not changed.');
    } finally {
      setSaving(false);
    }
  };

  if (rows === null) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }, (_, i) => <SkeletonCard key={i} lines={1} />)}
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <PageHeader
        title="Attribute Display Names"
        description="What each attribute key is called on screen. The key itself never changes; a blank name shows the key."
        crumbs={[{ label: 'Home', to: '/' }, { label: 'Configuration', to: '/config' }, { label: 'Attribute Display Names' }]}
        icon={
          <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.75} d="M4 7h16M4 12h10M4 17h7" />
          </svg>
        }
      />

      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2">
          <CardTitle>Display names</CardTitle>
          <span className="text-xs text-slate-500">{named} of {rows.length} named</span>
        </CardHeader>
        <CardContent className="space-y-3">
          {rows.length === 0 && (
            <p className="rounded-lg border border-dashed border-slate-300 px-3 py-6 text-center text-sm text-slate-500">
              No attribute keys exist yet. Add one below, or add keys to a profile first.
            </p>
          )}

          {rows.length > 0 && (
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2">
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Key</span>
              <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">Display name</span>
              <span />
              {rows.map((row) => (
                <div key={row.id} className="contents">
                  {row.added ? (
                    <Input
                      value={row.key}
                      autoComplete="off"
                      maxLength={ATTRIBUTE_LABEL_KEY_MAX}
                      aria-label="New attribute key"
                      onChange={(e) => setKey(row.id, e.target.value)}
                      className={dupIds.has(row.id) ? 'border-red-400' : ''}
                    />
                  ) : (
                    <span className="truncate text-sm font-medium text-slate-800" title={row.key}>{row.key}</span>
                  )}
                  <Input
                    value={row.name}
                    autoComplete="off"
                    maxLength={ATTRIBUTE_LABEL_MAX}
                    aria-label={`Display name for ${row.key.trim() || 'new key'}`}
                    onChange={(e) => setName(row.id, e.target.value)}
                  />
                  {row.added ? (
                    <Button variant="ghost" size="icon" type="button"
                      aria-label={`Remove ${row.key || 'new key'}`} onClick={() => remove(row.id)}
                    >
                      <svg className="h-4 w-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                      </svg>
                    </Button>
                  ) : <span />}
                  {dupIds.has(row.id) && (
                    <p className="col-span-3 -mt-1 text-xs text-red-600">
                      &ldquo;{row.key.trim()}&rdquo; is already listed. Keys are matched without regard to case.
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex items-center justify-between pt-2">
            <Button type="button" variant="secondary" onClick={add}>Add key</Button>
            <Button type="button" disabled={!dirty || blocked || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save changes'}
            </Button>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
