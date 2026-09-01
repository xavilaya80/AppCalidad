const CACHE_NAME = 'calidad-proceso-v2026-fix-12';

// Nunca se interceptan: la app necesita que un fallo de red SEA un fallo de red.
const HOSTS_API = ['script.google.com', 'script.googleusercontent.com'];

// Archivos propios: deben cachearse si o si para que la app abra sin senal.
const ASSETS_LOCALES = [
  './',
  'index.html',
  'styles.css',
  'app.js',
  'manifest.json',
  // Sin estos, al abrir la app instalada sin red el icono y el splash quedaban en blanco.
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-192.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
  'icons/favicon-32.png'
];

// Librerias externas: si el CDN falla, NO debe caerse toda la instalacion.
const ASSETS_CDN = [
  'https://unpkg.com/html5-qrcode',
  'https://cdn.jsdelivr.net/npm/chart.js'
];

const TIMEOUT_RED_MS = 3500;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(ASSETS_LOCALES);

    // addAll es todo-o-nada: una sola URL de CDN caida dejaba el Service Worker
    // sin instalar y la app sin ningun soporte offline. Se cachean una por una.
    await Promise.all(ASSETS_CDN.map(url =>
      cache.add(url).catch(err => console.warn('[SW] No se pudo cachear', url, err))
    ));
  })());
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map(k => (k === CACHE_NAME ? null : caches.delete(k))));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  /*
   * REGLA 1 - La API jamas se intercepta.
   *
   * Antes, cuando no habia red, el Service Worker respondia con un JSON inventado
   * ({error:'Offline'}) y HTTP 200. Para la app eso era una respuesta valida: el
   * fetch resolvia, no se veia ningun error y se mostraba "guardado con exito"
   * mientras el registro se perdia. Al no llamar a respondWith(), el navegador
   * hace la peticion directo y un corte de red rechaza el fetch, que es
   * exactamente lo que la app necesita para avisar (y lo que la cola offline de
   * A6 va a usar para reintentar).
   */
  if (HOSTS_API.indexOf(url.hostname) !== -1) return;

  // REGLA 2 - Solo se cachean GET. Un POST nunca debe salir de cache.
  if (e.request.method !== 'GET') return;

  // REGLA 3 - Librerias externas: cache primero (no cambian y ahorran datos).
  if (url.origin !== self.location.origin) {
    e.respondWith(
      caches.match(e.request).then(hit => hit || fetch(e.request).then(res => {
        if (res && res.ok) {
          const copia = res.clone();
          caches.open(CACHE_NAME).then(c => c.put(e.request, copia));
        }
        return res;
      }))
    );
    return;
  }

  /*
   * REGLA 4 - Archivos propios: red primero, cache como respaldo.
   *
   * Antes era cache primero, asi que despues de publicar una correccion los
   * telefonos seguian ejecutando la version vieja hasta cambiar CACHE_NAME a mano.
   * El timeout evita que una senal de planta lenta deje la app colgada.
   */
  e.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    try {
      const res = await Promise.race([
        fetch(e.request),
        new Promise((_, rechazar) => setTimeout(() => rechazar(new Error('timeout')), TIMEOUT_RED_MS))
      ]);
      if (res && res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      const hit = await cache.match(e.request);
      if (hit) return hit;
      // Sin red y sin cache: para la navegacion, al menos servir el index.
      if (e.request.mode === 'navigate') {
        const index = await cache.match('index.html');
        if (index) return index;
      }
      throw err;
    }
  })());
});
