const CACHE = 'ma-ngal-lay-v13';

const ASSETS = [
  './',
  './index.html',
  './shop.html',
  './styles.css',
  './shop.css',
  './app.js',
  './public.js',
  './image.png',
  './vendor/qrcode.min.js',
  './vendor/html5-qrcode.min.js',
  './firebase-config.js',
  './manifest.json',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './fonts/fonts.css',
  './fonts/noto-sans-myanmar-my.woff2',
  './fonts/noto-sans-myanmar-latin.woff2'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(ASSETS))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

function cachePut(request, response) {
  if (!response || !response.ok) return response;
  const copy = response.clone();
  caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
  return response;
}

self.addEventListener('fetch', (e) => {
  const request = e.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== location.origin) return; // let Firebase/CDN requests go straight to the network

  // Config changes must take effect on the next reload, not one reload later.
  if (url.pathname.endsWith('/firebase-config.js')) {
    e.respondWith(
      fetch(request)
        .then((response) => cachePut(request, response))
        .catch(() => caches.match(request))
    );
    return;
  }

  if (request.mode === 'navigate') {
    const isPublicPage = /\/shop\.html$/i.test(url.pathname);
    e.respondWith(
      fetch(request)
        .then((response) => cachePut(request, response))
        .catch(() => caches.match(request).then((cached) => cached || caches.match(isPublicPage ? './shop.html' : './index.html')))
    );
    return;
  }

  e.respondWith(
    caches.match(request).then((cached) => {
      const network = fetch(request)
        .then((response) => cachePut(request, response))
        .catch(() => cached || new Response('', { status: 504, statusText: 'Offline' }));
      return cached || network;
    })
  );
});
