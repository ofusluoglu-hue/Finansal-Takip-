// Finansal Takip — service worker (telefona "uygulama olarak yükle" için).
// Sayfa her açılışta ağdan taze çekilir (önce ağ); ağ yoksa son kopya açılır.
// Worker API'si ve dış servisler (başka adresler) hiç ellenmez: veri senkronu aynen sürer.
const ONBELLEK = 'ft-kabuk-v1';
const KABUK = ['./piyasa-paneli.html', './manifest.webmanifest', './icons/icon-192.png', './icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(ONBELLEK).then(c => c.addAll(KABUK)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ad => Promise.all(ad.filter(a => a !== ONBELLEK).map(a => caches.delete(a)))));
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;           // API ve dış kaynaklar: doğrudan ağ
  if (!url.pathname.startsWith(new URL('./', self.location).pathname)) return;
  e.respondWith(
    fetch(req.url, { cache: 'no-cache' })                     // her seferinde sunucuya sor: yeni sürüm hemen gelir (navigate isteği init ile kopyalanamaz, adresle çekilir)
      .then(cevap => {
        if (cevap.ok) { const kopya = cevap.clone(); caches.open(ONBELLEK).then(c => c.put(req, kopya)); }
        return cevap;
      })
      .catch(() => caches.match(req, { ignoreSearch: true })
        .then(c => c || (req.mode === 'navigate' ? caches.match('./piyasa-paneli.html') : undefined))
        .then(c => c || Response.error()))
  );
});

// ---------- Uygulama gibi bildirim (Web Push): panel kapalıyken de ----------
// Sunucu (Worker) şifreli mesaj gönderir: { id, baslik, metin, hedef }. Dokununca panel o sayfada açılır (açıksa öne gelir).
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (_) { d = { metin: e.data ? e.data.text() : '' }; }
  e.waitUntil(self.registration.showNotification(d.baslik || 'Finansal Takip', {
    body: d.metin || '', icon: 'icons/icon-192.png', badge: 'icons/icon-192.png', lang: 'tr',
    tag: d.id || undefined, data: { hedef: d.hedef || '' },
  }));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const hedef = (e.notification.data || {}).hedef || '';
  const adres = new URL('./piyasa-paneli.html' + (hedef ? '?sekme=' + encodeURIComponent(hedef) : ''), self.location).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(l => {
    const acik = l.find(c => c.url.includes('piyasa-paneli.html'));
    if (acik) { acik.postMessage({ sekme: hedef }); return acik.focus(); }
    return self.clients.openWindow(adres);
  }));
});
