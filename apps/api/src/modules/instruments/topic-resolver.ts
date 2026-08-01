/**
 * UNS topic derivation — a pure function, no database access.
 *
 * Topics are DERIVED, not stored (spec D5): renaming a hierarchy node
 * re-derives every descendant's topics with no backfill. Only explicit
 * customisations are persisted, in instrument_topics.
 */

export const TOPIC_CATEGORIES = [
  'TELEMETRY', 'ATTRIBUTES', 'ALARM', 'COMMAND', 'RPC', 'HEARTBEAT', 'EVENT',
  'STATUS', 'CONFIG', 'RESPONSE', 'SETTINGS', 'PUBLISH', 'SUBSCRIBE',
] as const;

export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

export interface UnsSettings {
  prefix: string;
  separator: string;
  includeGateway: boolean;
}

export interface ResolveTopicsInput {
  settings: UnsSettings;
  /** Root→leaf hierarchy slugs, from getAncestryPath(). */
  ancestry: string[];
  /** Gateway slug, or null when the instrument communicates independently. */
  gatewaySlug: string | null;
  instrumentSlug: string;
  /** Persisted per-category overrides. */
  overrides: Partial<Record<TopicCategory, string>>;
}

export function resolveTopics(input: ResolveTopicsInput): Record<TopicCategory, string> {
  const { settings, ancestry, gatewaySlug, instrumentSlug, overrides } = input;

  const segments = [
    settings.prefix,
    ...ancestry,
    settings.includeGateway ? gatewaySlug : null,
    instrumentSlug,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);

  const base = segments.join(settings.separator);

  const out = {} as Record<TopicCategory, string>;
  for (const category of TOPIC_CATEGORIES) {
    out[category] = overrides[category] ?? `${base}${settings.separator}${category.toLowerCase()}`;
  }
  return out;
}
