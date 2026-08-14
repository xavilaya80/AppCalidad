const CACHE_NAME = 'calidad-proceso-v11106';
const ASSETS = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js'
];

// Instalación: Cachear recursos críticos
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Cacheando archivos estáticos');
      return cache.addAll(ASSETS);
    })
  );
  self.skipWaiting();
});

// Activación: Limpiar caches antiguos
self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Borrando cache antiguo:', key);
            return caches.delete(key);
          }
        })
      );
    })
  );
  self.clients.claim();
});

// Estrategia: Cache First para Assets, Network First para API
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Si es una petición a la API de Google Scripts, ir siempre a la red
  if (url.hostname === 'script.google.com') {
    e.respondWith(
      fetch(e.request).catch(() => {
        // Si falla la red para la API, el app.js ya maneja la cola offline
        return new Response(JSON.stringify({ error: 'Offline' }), {
          headers: { 'Content-Type': 'application/json' }
        });
      })
    );
    return;
  }

  // Para el resto (HTML, CSS, JS, Librerías), intentar Cache primero
  e.respondWith(
    caches.match(e.request).then((res) => {
      return res || fetch(e.request).then((networkRes) => {
        // Opcional: Cachear dinámicamente nuevos recursos
        return caches.open(CACHE_NAME).then((cache) => {
          if (e.request.method === 'GET' && !url.protocol.startsWith('chrome-extension')) {
            cache.put(e.request, networkRes.clone());
          }
          return networkRes;
        });
      });
    })
  );
});
