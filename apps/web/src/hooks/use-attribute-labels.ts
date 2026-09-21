import { useCallback, useMemo } from 'react';
import useSWR from 'swr';
import {
  attributeLabel, coerceAttributeLabels, coerceSettingsHidden, isHiddenInSettings as hiddenInSettings,
  type AttributeLabels, type SettingsHidden,
} from '@digilog/shared';

/**
 * What an instrument attribute KEY is called on screen, from Configuration →
 * Attribute Display Names (2026-09-16).
 *
 * ONE hook rather than a fetch per surface, because the same key is printed on
 * the New Instrument form, the Attributes panel (detail page and the Settings
 * dialog), the Settings widget and the Attribute Access picker — and those must
 * never call one attribute two different things.
 *
 * `labelFor(key)` is the only thing a screen should call. It returns the
 * configured name, or the KEY when none is configured or the map has not
 * arrived yet — the same blank-falls-back rule as `alarmTypeName()`. **No
 * component may default a label to a literal**; the fallback is the key, which
 * is also what the audit trail names, so an inspector can always match a row.
 *
 * The response is passed through `coerceAttributeLabels` here as well as on the
 * server, so a stale server (or a proxy that hands back something else) cannot
 * white-screen a form over a label.
 *
 * The same row carries which fields the SETTINGS page hides (2026-09-21):
 * `settingsHidden` and `isHiddenInSettings(key)`. One hook for both, because
 * the Settings widget labels a key and decides whether to show it from the
 * same response — two fetches could answer from two versions of the row.
 * Nothing is hidden until the set arrives; a server that predates the field
 * hides nothing.
 */
export const ATTRIBUTE_LABELS_URL = '/api/config/attribute-labels/current';

export function useAttributeLabels(): {
  labels: AttributeLabels;
  labelFor: (key: string) => string;
  settingsHidden: SettingsHidden;
  isHiddenInSettings: (key: string) => boolean;
} {
  const { data } = useSWR<{ labels: AttributeLabels; settingsHidden?: SettingsHidden }>(ATTRIBUTE_LABELS_URL, {
    // Changes about once in the life of an installation; re-fetching on every
    // window focus would put a request behind every tab switch on pages that
    // already poll telemetry.
    revalidateOnFocus: false,
    dedupingInterval: 5 * 60_000,
  });
  const labels = useMemo(() => coerceAttributeLabels(data), [data]);
  const labelFor = useCallback((key: string) => attributeLabel(labels, key), [labels]);
  const settingsHidden = useMemo(() => coerceSettingsHidden(data), [data]);
  const isHiddenInSettings = useCallback((key: string) => hiddenInSettings(settingsHidden, key), [settingsHidden]);
  return { labels, labelFor, settingsHidden, isHiddenInSettings };
}
