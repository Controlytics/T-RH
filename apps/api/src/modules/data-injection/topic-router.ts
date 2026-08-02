/**
 * Topic routing — PURE. No database, no imports beyond the category list.
 *
 * P1 derives topics as  prefix / hierarchy… / gateway / instrument / category.
 *
 * The gateway is identified by the SUBSCRIPTION, not by parsing. The adapter
 * subscribes per gateway to `<gatewayBaseTopic>/#`, so by the time a message
 * arrives we already know which gateway it came from, and only the tail needs
 * interpreting:
 *
 *   <base>/temp001/telemetry  → topic-addressed   (one instrument)
 *   <base>/telemetry          → payload-addressed (batch, keyed by deviceKey)
 *
 * This matters because matching from the RIGHT cannot work. Hierarchy depth
 * varies per site, so `…/<hierarchy>/<gateway>/<category>` and
 * `…/<gateway>/<instrument>/<category>` are both ≥3 segments and are
 * indistinguishable from the string alone. Anchoring on the subscription
 * removes the ambiguity at its source rather than guessing downstream.
 *
 * Resolution downstream is by SLUG LOOKUP, never by re-deriving the path, so a
 * hierarchy rename cannot orphan messages already in flight.
 */
import { TOPIC_CATEGORIES, type TopicCategory } from '../instruments/topic-resolver.js';

/** What the topic tail alone can tell us, once the gateway base is stripped. */
export interface RoutedTail {
  /** null ⇒ payload-addressed: the batch payload names its own devices. */
  instrumentSlug: string | null;
  category: TopicCategory;
}

/**
 * A fully-addressed message. `gatewaySlug` comes from the SUBSCRIPTION the
 * message arrived on, not from parsing — see the module comment. The caller
 * joins the two halves:
 *
 *   const tail  = tailOf(topic, sub.baseTopic, sep);
 *   const route = { gatewaySlug: sub.gatewaySlug, ...routeTail(tail, sep) };
 */
export interface TopicRoute extends RoutedTail {
  gatewaySlug: string;
}

const CATEGORY_SET = new Set<string>(TOPIC_CATEGORIES);

const segments = (s: string, separator: string): string[] =>
  s.split(separator).filter((p) => p.length > 0);

/**
 * Strip a gateway's base topic, returning the remaining tail.
 * Returns null when `topic` does not sit strictly underneath `baseTopic`.
 *
 * Compared segment-wise, never by string prefix: `startsWith` would happily
 * match base `a/gw-1` against topic `a/gw-10/telemetry` and attribute one
 * gateway's readings to another.
 */
export function tailOf(topic: string, baseTopic: string, separator: string): string | null {
  const topicParts = segments(topic, separator);
  const baseParts = segments(baseTopic, separator);

  if (baseParts.length === 0) return null;
  // Strictly underneath: a topic equal to the base carries no tail.
  if (topicParts.length <= baseParts.length) return null;

  for (let i = 0; i < baseParts.length; i++) {
    if (topicParts[i] !== baseParts[i]) return null;
  }

  return topicParts.slice(baseParts.length).join(separator);
}

/**
 * Interpret the tail left after the gateway base has been stripped.
 *
 * Exactly two shapes are legal. Anything deeper is ambiguous and returns null
 * so the caller can dead-letter it — silently picking an interpretation is how
 * a mis-shaped topic becomes a wrong reading attributed to a real instrument.
 */
export function routeTail(tail: string, separator: string): RoutedTail | null {
  const parts = segments(tail, separator);
  if (parts.length < 1 || parts.length > 2) return null;

  const category = parts[parts.length - 1].toUpperCase();
  if (!CATEGORY_SET.has(category)) return null;

  return {
    instrumentSlug: parts.length === 2 ? parts[0] : null,
    category: category as TopicCategory,
  };
}
