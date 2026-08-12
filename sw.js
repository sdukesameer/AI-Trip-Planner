// ============================================================
//  sw.js — Offline app shell for AI Trip Planner
//  Bump CACHE_VERSION whenever the shell files change.
// ============================================================

const CACHE_VERSION = 'atp-v4';
const SHELL = [
    '/',
    '/index.html',
    '/css/style.css',
    '/css/components.css',
    '/js/app.js',
    '/js/api.js',
    '/js/maps.js',
    '/js/util.js',
    '/js/planner.js',
    '/js/routing.js',
    '/js/budget.js',
    '/js/app-config.js',
    '/js/download.js',
    '/manifest.json',
    '/icons/favicon-32x32.png',
    '/icons/apple-touch-icon.png',
];

self.addEventListener('install', event => {
    event.waitUntil(
        caches.open(CACHE_VERSION)
            // addAll rejects wholesale if any single file 404s — add them
            // individually so one missing icon can't break installation.
            .then(cache => Promise.all(SHELL.map(url => cache.add(url).catch(() => { }))))
            .then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', event => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', event => {
    const { request } = event;
    if (request.method !== 'GET') return;

    const url = new URL(request.url);

    // Never cache API traffic — responses are per-trip and often authenticated.
    if (url.pathname.startsWith('/.netlify/functions/')) return;

    // Navigations: network first so a new deploy is picked up immediately,
    // falling back to the cached shell when offline.
    if (request.mode === 'navigate') {
        event.respondWith(
            fetch(request)
                .then(res => {
                    const copy = res.clone();
                    caches.open(CACHE_VERSION).then(c => c.put('/index.html', copy)).catch(() => { });
                    return res;
                })
                .catch(() => caches.match('/index.html').then(r => r || Response.error()))
        );
        return;
    }

    // Same-origin static assets: serve from cache, refresh in the background.
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(request).then(cached => {
                const network = fetch(request)
                    .then(res => {
                        if (res.ok) {
                            const copy = res.clone();
                            caches.open(CACHE_VERSION).then(c => c.put(request, copy)).catch(() => { });
                        }
                        return res;
                    })
                    .catch(() => cached);
                return cached || network;
            })
        );
        return;
    }

    // Cross-origin (tiles, photos, CDN libs): cache opaque responses so a saved
    // trip still renders its thumbnails offline.
    event.respondWith(
        caches.match(request).then(cached => cached || fetch(request).then(res => {
            if (res.ok || res.type === 'opaque') {
                const copy = res.clone();
                caches.open(CACHE_VERSION).then(c => c.put(request, copy)).catch(() => { });
            }
            return res;
        }).catch(() => cached || Response.error()))
    );
});
