/**
 * GUARDIAN Service Worker — Offline Cache
 * Caches app shell and essential assets for offline use
 */

const CACHE_NAME = 'guardian-v2';
const OFFLINE_URL = 'index.html';

const CACHE_ASSETS = [
  'index.html',
  'app.js',
  'manifest.json',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
];

// Install: cache all assets
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(CACHE_ASSETS.map(url => {
        // Use no-cors for CDN assets to avoid CORS issues
        if (url.startsWith('https://')) {
          return new Request(url, { mode: 'no-cors' });
        }
        return url;
      })).catch(() => {
        // Partial cache is ok
              return cache.addAll(['index.html', 'app.js']);
      });
    })
  );
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

// Fetch: serve from cache if offline, update cache if online
self.addEventListener('fetch', event => {
  // Skip non-GET and cross-origin POST requests
  if (event.request.method !== 'GET') return;

  // For API calls (weather etc), try network first with timeout fallback
  if (event.request.url.includes('api.open-meteo.com') ||
      event.request.url.includes('api.openweathermap.org')) {
    event.respondWith(
      fetch(event.request, { signal: AbortSignal.timeout(8000) })
        .then(res => {
          const clone = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(event.request, clone));
          return res;
        })
        .catch(() => caches.match(event.request))
    );
    return;
  }

  // For map tiles (OpenStreetMap), cache-first
  if (event.request.url.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.match(event.request).then(cached => {
        if (cached) return cached;
        return fetch(event.request).then(res => {
          caches.open(CACHE_NAME + '-tiles').then(c => c.put(event.request, res.clone()));
          return res;
        }).catch(() => new Response('', { status: 503 }));
      })
    );
    return;
  }

  // App shell: cache-first, fallback to network
  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(res => {
        if (res.ok) {
          caches.open(CACHE_NAME).then(c => c.put(event.request, res.clone()));
        }
        return res;
      }).catch(() => {
        if (event.request.destination === 'document') {
          return caches.match(OFFLINE_URL);
        }
        return new Response('Offline', { status: 503 });
      });
    })
  );
});

// Push notification handler (for SOS alerts from server in future)
self.addEventListener('push', event => {
  const data = event.data?.json() || { title: 'GUARDIAN ALERT', body: 'Emergency notification' };
  event.waitUntil(
    self.registration.showNotification(data.title || 'GUARDIAN', {
        body: data.body || 'Alert received',
      icon: 'icon.png',
      badge: 'badge.png',
      tag: 'guardian-alert',
      requireInteraction: true,
      vibrate: [300, 100, 300, 100, 300],
      data: { url: data.url || '/' }
    })
  );
});

self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data?.url || '/'));
});
