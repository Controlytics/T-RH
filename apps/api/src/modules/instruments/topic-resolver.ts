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

  // Fail loud on malformed settings rather than silently publishing a wrong topic.
  // `prefix` may legitimately be '' (empty prefix is a documented, cleanly-omitted
  // case) — only `separator` must be a non-empty string, since `Array.join(undefined)`
  // silently falls back to ',' and produces plausible-looking garbage.
  if (typeof settings.prefix !== 'string') {
    throw new Error(`resolveTopics: settings.prefix must be a string, got ${typeof settings.prefix}`);
  }
  if (typeof settings.separator !== 'string' || settings.separator.length === 0) {
    throw new Error(`resolveTopics: settings.separator must be a non-empty string, got ${JSON.stringify(settings.separator)}`);
  }
  if (typeof settings.includeGateway !== 'boolean') {
    throw new Error(`resolveTopics: settings.includeGateway must be a boolean, got ${typeof settings.includeGateway}`);
  }

  const segments = [
    settings.prefix,
    ...ancestry,
    settings.includeGateway ? gatewaySlug : null,
    instrumentSlug,
  ].filter((s): s is string => typeof s === 'string' && s.length > 0);

  const base = segments.join(settings.separator);

  const out = {} as Record<TopicCategory, string>;
  for (const category of TOPIC_CATEGORIES) {
    // A blank/whitespace-only override means "stop customising", not "publish to
    // nothing" — treat it as absent and fall through to the derived topic.
    const override = overrides[category];
    out[category] = override && override.trim().length > 0
      ? override
      : `${base}${settings.separator}${category.toLowerCase()}`;
  }
  return out;
}
