/**
 * Connection lifecycle: one adapter instance per ACTIVE profile whose protocol
 * is ENABLED.
 *
 * Every failure here is isolated and non-fatal. A broker being down must leave
 * the configuration UI usable — otherwise an outage locks you out of the very
 * settings needed to fix it.
 */
import { prisma } from '../../lib/prisma.js';
import {
  getAdapter, type AdapterHealth, type IProtocolAdapter, type InboundMessage,
} from './adapters/protocol-adapter.js';
import { buildSubscriptions } from './subscriptions.js';

interface Live {
  adapter: IProtocolAdapter;
  profileName: string;
  protocolKey: string;
  startError: string | null;
  subscriptionCount: number;
}

const live = new Map<string, Live>();

export async function startConnections(
  onMessage: (m: InboundMessage) => Promise<void>,
): Promise<void> {
  const profiles = await prisma.communicationProfile.findMany({
    where: { isActive: true, protocol: { isEnabled: true } },
  });

  for (const p of profiles) {
    const adapter = getAdapter(p.protocolKey);
    if (!adapter) continue;                       // protocol enabled but no adapter shipped yet
    const entry: Live = {
      adapter, profileName: p.name, protocolKey: p.protocolKey,
      startError: null, subscriptionCount: 0,
    };
    live.set(p.id, entry);
    try {
      // Subscriptions are DERIVED, not stored. The profile's config says how to
      // reach the broker; what to listen to comes from the hierarchy, and one
      // gateway can span several base topics — see subscriptions.ts.
      const subscriptions = await buildSubscriptions(p.id);
      entry.subscriptionCount = subscriptions.length;
      await adapter.start(
        {
          id: p.id, name: p.name, protocolKey: p.protocolKey,
          config: { ...(p.config as Record<string, unknown>), subscriptions },
        },
        onMessage,
      );
    } catch (e) {
      // Isolated on purpose: one unreachable broker must not stop the others.
      entry.startError = (e as Error).message;
    }
  }
}

export async function stopConnections(): Promise<void> {
  for (const entry of live.values()) {
    try { await entry.adapter.stop(); } catch { /* shutting down; nothing useful to do */ }
  }
  live.clear();
}

export type ConnectionHealth = AdapterHealth & {
  profileName: string;
  protocolKey: string;
  startError: string | null;
  subscriptionCount: number;
};

export function getConnectionHealth(): Record<string, ConnectionHealth> {
  const out: Record<string, ConnectionHealth> = {};
  for (const [id, e] of live) {
    out[id] = {
      ...e.adapter.health(),
      profileName: e.profileName,
      protocolKey: e.protocolKey,
      startError: e.startError,
      subscriptionCount: e.subscriptionCount,
    };
  }
  return out;
}
