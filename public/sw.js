// Service worker mínimo: cache del shell estático, red para la API.
// Subir la versión cada vez que se agrega o renombra un archivo del shell, o el
// celular sigue sirviendo la copia vieja y parece que los cambios no se aplicaron.
const CACHE = 'presupuestos-v16';
const SHELL = [
    '/',
    '/css/app.css',
    '/js/format.js',
    '/js/medidas.js',
    '/js/theme.js',
    '/js/api.js',
    '/js/nav.js',
    '/js/chat.js',
    '/js/voice.js',
    '/js/pdf.js',
    '/js/app.js',
    '/manifest.webmanifest',
];

self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
    e.waitUntil(
        caches.keys()
            .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
            .then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (e) => {
    const url = new URL(e.request.url);
    // La API y los CDNs siempre van a la red
    if (url.pathname.startsWith('/api/') || url.origin !== location.origin) return;
    // Estáticos: red primero (para no servir versiones viejas), cache de respaldo
    e.respondWith(
        fetch(e.request)
            .then(res => {
                const copy = res.clone();
                caches.open(CACHE).then(c => c.put(e.request, copy));
                return res;
            })
            .catch(() => caches.match(e.request))
    );
});
