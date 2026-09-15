/*
  Сервис-воркер кэширует оболочку и каталог станций.

  Каталог — это файл на 950 КБ, и он же источник списка. Если его не кэшировать,
  приложение без сети не откроется. Звук и логотипы намеренно НЕ кэшируются:
  это живые потоки, и попытка их сохранить только мешает.
*/

const VERSION = 'prosto-radio-v2.12-ui14';
const SHELL = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.webmanifest',
  'stations.json',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/apple-touch-icon.png',
  'favicon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION)
      // addAll падает целиком, если хоть один файл недоступен, поэтому кладём по одному
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Чужие домены — это станции и их логотипы. Их не трогаем вообще.
  if (url.origin !== self.location.origin) return;

  // Свои файлы: сначала кэш, потом сеть. Так приложение открывается мгновенно
  // и работает в самолётном режиме.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    })
  );
});
