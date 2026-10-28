/**
 * Live ATTRIBUTE subscribers on the connections that stay open — WebSocket and
 * raw TCP (2026-10-28, operator: "add for all protocals"). MQTT has its broker
 * for this; these two have only the socket the device opened, so a device that
 * sent `{"subscribe":"attributes"}` is registered here and every committed
 * attribute change is pushed to it by `publishAttributeDownlink`.
 *
 * Keyed by INSTRUMENT ID, never by code: a code can be changed, and a registry
 * keyed on the old one would silently stop delivering. The key is the slot
 * rule MQTT follows — a child's attributes go to its GATEWAY's connection
 * (`gatewayId ?? instrumentId`), naming the child in `device`.
 *
 * No I/O here: the subscriber decides — under its own re-authorisation and
 * certificate checks — whether a frame may be written to its socket.
 */

/** One instrument's attribute state, as a device receives it on WS / TCP / HTTP. */
export interface AttributeFrame {
  /** The instrument these attributes belong to (a gateway's child, or itself). */
  device: string;
  /** The COMPLETE set after the change, sensor offsets excluded. */
  attributes: Record<string, string>;
  /** What moved: `null` = removed. Empty on a snapshot. */
  changed: Record<string, string | null>;
  ts: string;
}

/** Called with the frame and the id of the instrument it describes. Must not throw. */
export type AttributeSubscriber = (frame: AttributeFrame, instrumentId: string) => void;

const subscribers = new Map<string, Set<AttributeSubscriber>>();

/** Register a connection for its instrument's (and, for a gateway, its children's) changes. */
export function subscribeAttributes(targetId: string, subscriber: AttributeSubscriber): () => void {
  let set = subscribers.get(targetId);
  if (!set) { set = new Set(); subscribers.set(targetId, set); }
  set.add(subscriber);
  return () => {
    const s = subscribers.get(targetId);
    if (!s) return;
    s.delete(subscriber);
    if (s.size === 0) subscribers.delete(targetId);
  };
}

/** Hand a committed change to every subscriber of `targetId`. NEVER THROWS. */
export function pushAttributeFrame(targetId: string, instrumentId: string, frame: AttributeFrame): void {
  const set = subscribers.get(targetId);
  if (!set) return;
  for (const s of [...set]) {
    try { s(frame, instrumentId); } catch { /* one dead socket must not stop the others */ }
  }
}

/** For tests: how many connections are subscribed for this instrument. */
export function attributeSubscriberCount(targetId: string): number {
  return subscribers.get(targetId)?.size ?? 0;
}
