// Service Worker: pwa/sw.js
const CACHE_NAME = 'pavi-pwa-v2';
const STATIC_ASSETS = [
  '/mobile',
  '/pwa/manifest.json',
  '/pwa/icon-192.png',
  '/pwa/icon-512.png',
  '/pwa/badge-72.png',
  'https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap'
];

// ── Install: Pre-cache static assets ────────────────────────────────────────
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate: Purge old caches ───────────────────────────────────────────────
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// ── Fetch: Network-first for API, cache-first for static ────────────────────
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);
  
  if (url.pathname.startsWith('/api/') || url.pathname.includes('/socket.io/')) {
    // Network-first for dynamic API calls
    event.respondWith(
      fetch(event.request).catch(() => caches.match(event.request))
    );
    return;
  }
  
  // Cache-first for static assets
  event.respondWith(
    caches.match(event.request).then(cached => cached || fetch(event.request).then(response => {
      const clone = response.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
      return response;
    }))
  );
});

// ── Background Sync: Retry queued offline actions ────────────────────────────
self.addEventListener('sync', event => {
  if (event.tag === 'pavi-sync-notes') {
    event.waitUntil(syncOfflineNotes());
  }
});

async function openIDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('PaviOfflineDB', 1);
    request.onupgradeneeded = (event) => {
      event.target.result.createObjectStore('offline-notes', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function syncOfflineNotes() {
  try {
    const db = await openIDB();
    const tx = db.transaction('offline-notes', 'readwrite');
    const store = tx.objectStore('offline-notes');
    const getAllReq = store.getAll();

    getAllReq.onsuccess = async () => {
      const pendingNotes = getAllReq.result;
      for (const note of pendingNotes) {
        try {
          await fetch('/api/session/note', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ note: note.text })
          });
          // Delete after successful sync
          const deleteTx = db.transaction('offline-notes', 'readwrite');
          deleteTx.objectStore('offline-notes').delete(note.id);
        } catch (e) { /* will retry on next sync */ }
      }
    };
  } catch(e) {
    console.error('Error syncing offline notes', e);
  }
}


// ── Push Notifications ───────────────────────────────────────────────────────
self.addEventListener('push', event => {
  let data = {};
  try {
    data = event.data?.json() ?? {};
  } catch (e) {
    data = { title: 'Pavi Swarm Update', body: event.data?.text() || 'Check active swarm logs.' };
  }
  
  const title = data.title || 'Pavi Update';
  const options = {
    body: data.body || 'Pavi has an update for you.',
    icon: '/pwa/icon-192.png',
    badge: '/pwa/badge-72.png',
    tag: data.tag || 'pavi-notification',
    data: { url: data.url || '/mobile' },
    actions: data.actions || [],
    vibrate: [200, 100, 200]
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  const targetUrl = event.notification.data?.url || '/mobile';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      for (const client of clientList) {
        if (client.url.includes('/mobile') && 'focus' in client) return client.focus();
      }
      if (clients.openWindow) return clients.openWindow(targetUrl);
    })
  );
});
