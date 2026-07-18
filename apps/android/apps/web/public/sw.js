/* DigiLog Service Worker — offline queue background sync.
 *
 * Purpose: when the page is backgrounded (tab hidden, browser closed) and the
 * device comes back online, the browser fires a `sync` event here. We use that
 * to ping the page (if any client is open) so the in-page sync engine drains
 * the IndexedDB queue. If no client is open, the SW message is a no-op — the
 * next time the user opens the app, sync runs immediately on mount.
 *
 * We deliberately do NOT replicate the queue-replay logic inside the SW —
 * that would mean two implementations of the same protocol. The SW just
 * triggers the in-page engine when conditions are right.
 */
const SYNC_TAG = 'digilog-offline-sync';

self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('sync', (event) => {
  if (event.tag !== SYNC_TAG) return;
  event.waitUntil(triggerClientSync());
});

self.addEventListener('message', (event) => {
  if (event.data?.type === 'register-sync') {
    if ('sync' in self.registration) {
      self.registration.sync.register(SYNC_TAG).catch(() => { /* unsupported */ });
    }
  }
});

async function triggerClientSync() {
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  for (const c of clients) {
    c.postMessage({ type: 'sync-queue' });
  }
  // If no clients are open, the queue stays in IndexedDB until next page load.
  // The next /current-state fetch on app open will trigger a sync immediately.
}
