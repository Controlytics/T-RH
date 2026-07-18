/**
 * rfid-bridge.ts — React-side wrapper for the native RfidPlugin (Capacitor).
 *
 * Why: when the RFID reader is in SDK / answer mode (not UKB keyboard mode),
 * the OS does not inject keystrokes into the focused app, so document-level
 * keydown listeners see nothing. The native side (RfidPlugin.java) opens the
 * USB device via Reader_Usb.jar and emits a "tag" event for each scan. This
 * file subscribes to that event and exposes a single `subscribeRfidTags()`
 * function the React UI can use.
 *
 * On non-Capacitor platforms (web browser) this is a no-op so the same code
 * runs in dev.
 */

export interface RfidTagEvent {
  epc: string;
  tid?: string;
  user?: string;
  rssi?: string;
  ts: number;
}

let pluginPromise: Promise<any> | null = null;
let started = false;

function isNativePlatform(): boolean {
  const cap: any = (typeof window !== 'undefined') ? (window as any).Capacitor : null;
  return !!cap?.isNativePlatform?.();
}

async function getPlugin(): Promise<any | null> {
  if (!isNativePlatform()) return null;
  if (!pluginPromise) {
    pluginPromise = (async () => {
      try {
        const core = await import('@capacitor/core');
        return core.registerPlugin('Rfid');
      } catch (e) {
        // Capacitor or plugin not available — fall through silently
        return null;
      }
    })();
  }
  return pluginPromise;
}

/**
 * Subscribe to RFID tag scans. Returns an unsubscribe function.
 * Idempotent: lazily connects the reader and starts inventory the first time
 * it's called, then reuses the same native connection for all subscribers.
 *
 * Errors during connect/start are surfaced to the optional `onError` callback
 * but never thrown — UKB-mode users (or web browser users) shouldn't see
 * errors when the SDK pathway isn't available; they fall back to keyboard
 * input automatically.
 */
export async function subscribeRfidTags(
  onTag: (tag: RfidTagEvent) => void,
  onError?: (msg: string) => void,
): Promise<() => void> {
  const plugin = await getPlugin();
  if (!plugin) {
    // Web browser or plugin missing — consumer should still listen for keydown
    // bursts on the input. Return a no-op unsubscribe.
    return () => {};
  }

  // Add listener BEFORE starting inventory so we don't miss the first tag.
  // Capacitor returns a handle whose .remove() unsubscribes.
  let removeHandle: { remove: () => Promise<void> } | null = null;
  try {
    const handle = await plugin.addListener('tag', (e: RfidTagEvent) => {
      try { onTag(e); } catch { /* swallow consumer errors */ }
    });
    removeHandle = handle;
  } catch (e: any) {
    onError?.(`addListener failed: ${e?.message ?? e}`);
    return () => {};
  }

  // First subscriber kicks off connect + startInventory. Subsequent subscribers
  // are no-ops (already started).
  if (!started) {
    try {
      await plugin.connect();
      await plugin.startInventory();
      started = true;
    } catch (e: any) {
      onError?.(e?.message ?? String(e));
      // Don't tear down the listener — the user might re-plug the device or
      // grant permission and we want to be ready when that happens.
    }
  }

  return () => {
    try { removeHandle?.remove(); } catch { /* ignore */ }
  };
}

/**
 * Force a reconnect — useful for a "Reconnect RFID" button if the operator
 * unplugs and re-plugs the reader, or if the first connect failed because
 * USB permission was denied and the operator wants to retry.
 */
export async function reconnectRfid(): Promise<{ ok: boolean; error?: string }> {
  const plugin = await getPlugin();
  if (!plugin) return { ok: false, error: 'RFID plugin not available on this platform' };
  try {
    try { await plugin.disconnect(); } catch { /* ignore */ }
    await plugin.connect();
    await plugin.startInventory();
    started = true;
    return { ok: true };
  } catch (e: any) {
    started = false;
    return { ok: false, error: e?.message ?? String(e) };
  }
}
