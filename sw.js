// Fa funzionare Salvadanaio anche senza connessione.
// Le app sullo stesso sito (gelu92.github.io) condividono la "Cache Storage" e alcune
// la svuotano tutta quando si aggiornano. Per questo teniamo una seconda copia dei file
// in un database IndexedDB tutto nostro, che le altre app non toccano.
const CACHE = 'salvadanaio-v9';
const DB = 'salvadanaio-offline';
const FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png', './icon-maskable-512.png', './apple-touch-icon.png'];
const FONT_HOSTS = ['fonts.googleapis.com', 'fonts.gstatic.com'];

/* ---------- piccolo archivio IndexedDB ---------- */
function db() {
  return new Promise((ok, ko) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore('files');
    r.onsuccess = () => { const d = r.result; d.onversionchange = () => d.close(); ok(d); };
    r.onerror = () => ko(r.error);
    r.onblocked = () => ko(new Error('bloccato'));
  });
}
async function dbPut(key, val) {
  const d = await db();
  return new Promise((ok, ko) => { const t = d.transaction('files', 'readwrite'); t.objectStore('files').put(val, key); t.oncomplete = () => { d.close(); ok(); }; t.onerror = () => ko(t.error); });
}
async function dbGet(key) {
  const d = await db();
  return new Promise((ok, ko) => { const r = d.transaction('files').objectStore('files').get(key); r.onsuccess = () => { d.close(); ok(r.result); }; r.onerror = () => ko(r.error); });
}

/* stesso file = stessa chiave, con o senza ?v=… e con o senza index.html */
function keyOf(url) {
  const u = new URL(url, self.registration.scope);
  if (u.origin !== location.origin) return u.href;
  let p = u.pathname;
  if (p.endsWith('/')) p += 'index.html';
  return u.origin + p;
}
const scopeIndex = () => keyOf(self.registration.scope);

async function store(req, res) {
  if (!res || !res.ok || res.type === 'opaque') return;
  try {
    const body = await res.clone().blob();
    await dbPut(keyOf(req.url || req), { body, type: res.headers.get('content-type') || '' });
  } catch (e) {}
  try { const c = await caches.open(CACHE); await c.put(req, res.clone()); } catch (e) {}
}

async function fromStore(req) {
  // 1) Cache Storage (se nessuno l'ha svuotata)
  try { const r = await caches.match(req, { ignoreSearch: true }); if (r) return r; } catch (e) {}
  // 2) la nostra copia in IndexedDB
  try {
    const hit = await dbGet(keyOf(req.url));
    if (hit) return new Response(hit.body, { headers: { 'Content-Type': hit.type } });
  } catch (e) {}
  return null;
}

async function fillAll() {
  await Promise.all(FILES.map(async f => {
    try { const req = new Request(f, { cache: 'reload' }); await store(req, await fetch(req)); } catch (e) {}
  }));
}

self.addEventListener('install', e => { e.waitUntil(fillAll().then(() => self.skipWaiting())); });

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      // cancella solo le vecchie versioni di QUESTA app: le altre tue app restano intatte
      .then(keys => Promise.all(keys.filter(k => k.startsWith('salvadanaio-') && k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// la pagina, quando è online, chiede di rinfrescare la copia offline
self.addEventListener('message', e => { if (e.data === 'refill') e.waitUntil(fillAll()); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const mine = url.origin === location.origin;
  if (!mine && !FONT_HOSTS.includes(url.hostname)) return;

  e.respondWith((async () => {
    // Prima la rete (così vedi sempre l'ultima versione) e intanto aggiorna la copia
    try {
      const res = await fetch(req);
      if (res.ok) e.waitUntil(store(req, res.clone()));
      return res;
    } catch (err) {
      const hit = await fromStore(req);
      if (hit) return hit;
      if (req.mode === 'navigate') {
        const idx = await fromStore(new Request(scopeIndex()));
        if (idx) return idx;
        return new Response(
          '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
          '<title>Salvadanaio</title><body style="font-family:system-ui;padding:32px 20px;background:#eef2f6;color:#15212e">' +
          '<h2>Serve internet una volta</h2><p>Apri Salvadanaio con la connessione attiva: si salva nel telefono e poi funziona anche in modalità aereo. I tuoi conteggi non sono andati persi.</p>',
          { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
      }
      return new Response('', { status: 504 });
    }
  })());
});
