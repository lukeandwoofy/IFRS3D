// service-worker.js — basic offline caching for WebFS2025
// Purpose:
//  - Cache essential app shell files for offline startup
//  - Serve resources from cache, fall back to network, update cache in background
//  - Keep cache versioning simple so updates replace old caches
//
// Notes:
//  - Keep this file simple and safe for static hosting.
//  - Adjust ASSETS list to include any additional files your app needs.

const CACHE_VERSION = 'v1';
const CACHE_NAME = `webfs2025-shell-${CACHE_VERSION}`;

const ASSETS = [
  '/', // may be required by some servers; keep for SPA start
  '/index.html',
  '/style.css',
  '/main.js',
  '/physics.js',
  '/controls.js',
  '/camera.js',
  '/ui.js',
  '/autopilot.js',
  '/atc.js',
  '/weather.js',
  '/passenger.js',
  '/persistence.js',
  '/multiplayer.js',
  '/manifest.json',
  // Cesium is loaded from CDN in index.html; caching remote CDN assets is optional
  // Icons
  '/icons/webfs2025-192.png',
  '/icons/webfs2025-512.png'
];

// On install, pre-cache application shell
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // Filter undefined assets (in case some files are missing)
      const toCache = ASSETS.filter(Boolean);
      return cache.addAll(toCache).catch((err) => {
        // If some resources fail to cache, still allow install to complete.
        console.warn('SW: cache.addAll failed', err);
        return Promise.resolve();
      });
    })
  );
});

// On activate, remove old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch strategy: network-first for HTML (so index.html updates), cache-first for other assets
self.addEventListener('fetch', (event) => {
  const req = event.request;

  // Only handle GET requests
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Always bypass cross-origin requests (e.g., Cesium CDN, APIs) to avoid CORS/cache issues
  if (url.origin !== self.origin) return;

  // Network-first for navigation requests (HTML)
  if (req.mode === 'navigate' || req.headers.get('accept')?.includes('text/html')) {
    event.respondWith(
      fetch(req)
        .then((res) => {
          // Put a copy in the cache for offline use
          const copy = res.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((cached) => cached || caches.match('/index.html')))
    );
    return;
  }

  // For other app shell assets, use cache-first with network fallback and update in background
  event.respondWith(
    caches.match(req).then((cached) => {
      if (cached) {
        // Kick off a background update but return cached immediately
        fetch(req).then((res) => {
          if (res && res.ok) {
            caches.open(CACHE_NAME).then((cache) => cache.put(req, res.clone()));
          }
        }).catch(() => {});
        return cached;
      }
      // Not in cache: try network then cache
      return fetch(req).then((res) => {
        if (!res || !res.ok) return res;
        const copy = res.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => {
        // final fallback: try index.html for navigation or nothing
        return caches.match('/index.html');
      });
    })
  );
});

// Optional: message handler to trigger skipWaiting or manual cache refresh
self.addEventListener('message', (event) => {
  const msg = event.data || {};
  if (msg === 'skipWaiting') {
    self.skipWaiting();
  }
  if (msg && msg.type === 'refreshCache') {
    // Re-cache current ASSETS list
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS.filter(Boolean)).catch(()=>{}));
  }
});
