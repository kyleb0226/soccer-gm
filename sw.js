const CACHE = 'soccer-gm-v3';
const ASSETS = [
  '/soccer-gm/',
  '/soccer-gm/index.html',
  '/soccer-gm/vendor/react.production.min.js',
  '/soccer-gm/vendor/react-dom.production.min.js',
  '/soccer-gm/vendor/babel.min.js',
  '/soccer-gm/vendor/tailwind.js',
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  // Network-first for HTML so updates always get through
  if (e.request.mode === 'navigate' || e.request.url.endsWith('index.html')) {
    e.respondWith(
      fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      }).catch(() => caches.match(e.request))
    );
    return;
  }
  // Cache-first for vendor assets
  e.respondWith(
    caches.match(e.request).then(cached => cached || fetch(e.request))
  );
});
