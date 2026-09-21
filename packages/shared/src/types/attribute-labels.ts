/**
 * Display names for instrument attribute KEYS (2026-09-16, operator: "key is
 * one thing and that key display name should be configurable").
 *
 * An attribute key is the stored identity — it is what a device writes over
 * MQTT, what the CSV importer reads, what an audit row names, and what the
 * alarm-limits alias lists match on. None of that moves. What moves is the word
 * a PERSON reads beside the value: `Enable_Temp_NMT` may be shown as "High
 * temperature alarm enabled" on the registration form, the Attributes panel, the
 * Settings widget and the Attribute Access picker, while the stored key stays
 * exactly `Enable_Temp_NMT`.
 *
 * ONE global map, administered on Configuration → Attribute Display Names and
 * stored as the `attribute-labels` system_config row (`{labels: {key: name}}`).
 * Global rather than per profile, by the operator's choice: a key means the same
 * thing wherever it appears, and a key typed freely on an instrument — one no
 * profile lists — still gets its name.
 *
 * Two rules every consumer shares, and the reason they live here rather than in
 * a component:
 *
 *  - **Blank falls back to the KEY, never to an empty heading** — the same rule
 *    as `alarmTypeName()` and the trend widget texts. A label can be unset; a
 *    row without a name cannot be matched to its audit entry.
 *  - **Lookup folds case**, exactly as `parseInstrumentAttributeKeys` and the
 *    Attributes panel already do. Postgres stores `Room` and `room` as two rows,
 *    but every human-facing surface here treats them as one attribute, and a
 *    label map that did not would name one of them and not the other.
 */
export const ATTRIBUTE_LABELS_CONFIG_KEY = 'attribute-labels';

/** A display name sits in a form label, a table cell and a tile heading. */
export const ATTRIBUTE_LABEL_MAX = 80;

/** Keys are capped where they are administered (64 on the profile editor). */
export const ATTRIBUTE_LABEL_KEY_MAX = 64;

/** The stored shape of the `attribute-labels` config row. */
export interface AttributeLabelsConfig {
  labels: Record<string, string>;
  /** Absent on a row written before 2026-09-21 — which reads as nothing hidden. */
  settingsHidden?: SettingsHidden;
}

/**
 * Which fields the SETTINGS page does NOT show (2026-09-21, operator: "in
 * that configuration page any attribute or any field hide, then that field
 * should not show in the settings page … give hid/un hide options").
 *
 * Stored as the HIDDEN set rather than the shown set, on purpose: a key added
 * to a profile tomorrow shows until someone switches it off, so nobody can
 * lose a field by forgetting to list it. Hiding is the deliberate act.
 *
 * This is presentation over ONE page. A hidden attribute is still stored,
 * still served by the API, still on the instrument detail page, the New
 * Instrument form and the bulk template, and still governed by Attribute
 * Access. The Instrument ID has its own flag because it is not an attribute.
 */
export interface SettingsHidden {
  instrumentId: boolean;
  keys: string[];
}

export const SETTINGS_HIDDEN_NONE: SettingsHidden = Object.freeze({ instrumentId: false, keys: [] }) as SettingsHidden;

/**
 * The ONE reader of the hidden set on the stored row. Anything but the exact
 * shape reads as nothing hidden — a row from before the field existed must
 * not blank the Settings page.
 */
export function coerceSettingsHidden(value: unknown): SettingsHidden {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { ...SETTINGS_HIDDEN_NONE };
  const raw = (value as Record<string, unknown>).settingsHidden;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ...SETTINGS_HIDDEN_NONE };
  const { instrumentId, keys } = raw as Record<string, unknown>;
  if (typeof instrumentId !== 'boolean' || !Array.isArray(keys)) return { ...SETTINGS_HIDDEN_NONE };
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of keys) {
    if (typeof k !== 'string') continue;
    const key = k.trim().slice(0, ATTRIBUTE_LABEL_KEY_MAX);
    if (!key) continue;
    const fold = key.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    out.push(key);
  }
  return { instrumentId, keys: out };
}

/** Is this attribute key hidden on the Settings page? Case-folded; false until the set has loaded. */
export function isHiddenInSettings(hidden: SettingsHidden | undefined, key: string): boolean {
  if (!hidden) return false;
  const fold = key.trim().toLowerCase();
  return hidden.keys.some((k) => k.trim().toLowerCase() === fold);
}

/** key → display name, already trimmed, blanks dropped, case-folded duplicates removed. */
export type AttributeLabels = Record<string, string>;

/**
 * The ONE reader of the stored row. Tolerates anything: an absent row, a row
 * written by an older build, a hand-edited value. Whatever survives is a clean
 * map a screen can trust.
 */
export function coerceAttributeLabels(value: unknown): AttributeLabels {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = (value as Record<string, unknown>).labels;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: AttributeLabels = {};
  const seen = new Set<string>();
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v !== 'string') continue;
    const key = k.trim().slice(0, ATTRIBUTE_LABEL_KEY_MAX);
    const name = v.trim().slice(0, ATTRIBUTE_LABEL_MAX);
    if (!key || !name) continue;
    const fold = key.toLowerCase();
    if (seen.has(fold)) continue;
    seen.add(fold);
    out[key] = name;
  }
  return out;
}

/**
 * What to PRINT for a key. The key itself when nothing is configured, the map
 * has not loaded yet, or the configured name is blank.
 */
export function attributeLabel(labels: AttributeLabels | undefined, key: string): string {
  if (!labels) return key;
  const direct = labels[key];
  if (direct && direct.trim()) return direct;
  const fold = key.trim().toLowerCase();
  for (const [k, v] of Object.entries(labels)) {
    if (k.trim().toLowerCase() === fold && v.trim()) return v;
  }
  return key;
}
