/**
 * Protocol adapter contract + registry.
 *
 * Adding a protocol is one new file implementing IProtocolAdapter plus flipping
 * Protocol.isEnabled — no change to the ingestion pipeline. That is the whole
 * point of the indirection.
 */

/** A message as it arrived, before any parsing. */
export interface InboundMessage {
  protocolKey: string;
  profileId: string;
  topic: string;
  payload: Buffer;
  receivedAt: Date;
  qos?: number;
  retained?: boolean;
  /**
   * The gateway this message belongs to, taken from the SUBSCRIPTION it arrived
   * on — never parsed out of `topic`.
   *
   * Hierarchy depth varies per site, which makes `…/<hierarchy>/<gateway>/<category>`
   * and `…/<gateway>/<instrument>/<category>` indistinguishable from the topic
   * string alone. The adapter subscribes per gateway, so it already knows the
   * answer; carrying it here keeps that knowledge instead of throwing it away
   * and guessing later. See topic-router.ts.
   */
  gatewaySlug: string;
  /**
   * The gateway's id, also from the subscription.
   *
   * Payload-addressed batches resolve by deviceKey, which is unique per gateway
   * via `@@unique([gatewayId, deviceKey])` — but gateway SLUGS are only unique
   * per hierarchy node (`@@unique([hierarchyNodeId, slug])`), so two gateways can
   * share one. Keying that lookup on the id rather than the slug is what makes
   * it collision-free.
   */
  gatewayId: string;
  /**
   * The subscribed base topic — `prefix/<ancestry>/<gateway>` — so the router can
   * strip it to get the tail, and so topic-addressed lookups can key on it.
   *
   * The base encodes the hierarchy node, and `@@unique([hierarchyNodeId, slug])`
   * makes an instrument slug unique within a node, so `baseTopic|instrumentSlug`
   * is unique BY CONSTRUCTION. `gatewaySlug|instrumentSlug` is not: one gateway
   * can carry instruments in several hierarchy nodes, and P1 derives an
   * instrument's topic from the INSTRUMENT's ancestry, not the gateway's.
   */
  baseTopic: string;
}

export interface AdapterHealth {
  connected: boolean;
  lastMessageAt: Date | null;
  lastErrorAt: Date | null;
  lastError: string | null;
  messagesReceived: number;
  reconnectCount: number;
}

/** Communication profile WITH secrets unmasked — the adapter needs the real password. */
export interface ProfileWithSecrets {
  id: string;
  name: string;
  protocolKey: string;
  config: Record<string, unknown>;
}

export interface IProtocolAdapter {
  readonly protocolKey: string;
  start(
    profile: ProfileWithSecrets,
    onMessage: (m: InboundMessage) => Promise<void>,
  ): Promise<void>;
  stop(): Promise<void>;
  health(): AdapterHealth;
  /** Optional — only adapters that can write implement this. Arrives in P8. */
  publish?(
    topic: string,
    payload: Buffer,
    opts?: { qos?: number; retain?: boolean },
  ): Promise<void>;
}

const adapters = new Map<string, IProtocolAdapter>();

export function registerAdapter(adapter: IProtocolAdapter): void {
  if (adapters.has(adapter.protocolKey)) {
    // Throw rather than replace: a silent overwrite means two adapters fight
    // over the same protocol and which one wins depends on import order.
    throw new Error(`Protocol adapter '${adapter.protocolKey}' is already registered.`);
  }
  adapters.set(adapter.protocolKey, adapter);
}

export function getAdapter(protocolKey: string): IProtocolAdapter | undefined {
  return adapters.get(protocolKey);
}

export function listAdapters(): string[] {
  return [...adapters.keys()];
}

/** Test-only. Never call from application code. */
export function clearAdaptersForTest(): void {
  adapters.clear();
}
