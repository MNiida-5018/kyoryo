/* オフライン用：アプリ一式をiPadに保存し、圏外でも開けるようにする */
const VERSION = 'v1-20261116';
const FILES = [
  './', 'index.html', 'local-caps.js', 'parser.js', 'dxf.js', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png',
  'lib/exceljs.min.js', 'lib/jspdf.umd.min.js', 'lib/pdf.min.js', 'lib/pdf.worker.min.js',
  'lib/tess/tesseract.min.js', 'lib/tess/worker.min.js', 'lib/tess/tesseract-core-lstm.wasm.js', 'lib/tess/tesseract-core-simd-lstm.wasm.js',
  'lib/tess/fast/jpn.traineddata.b64.txt', 'lib/tess/fast/eng.traineddata.b64.txt'
];
self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== VERSION).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});

function idbBlob(id){
  return new Promise((res, rej) => {
    const r = indexedDB.open('kyoryo-viewer', 1);
    r.onupgradeneeded = () => { const d = r.result; if(!d.objectStoreNames.contains('docs')) d.createObjectStore('docs'); if(!d.objectStoreNames.contains('blobs')) d.createObjectStore('blobs'); };
    r.onerror = () => rej(r.error);
    r.onsuccess = () => { const d = r.result, g = d.transaction('blobs').objectStore('blobs').get(id); g.onsuccess = () => { res(g.result || null); d.close(); }; g.onerror = () => rej(g.error); };
  });
}

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if(url.origin !== location.origin || e.request.method !== 'GET') return;
  const m = url.pathname.match(/\/_blob\/([A-Za-z0-9_-]+)$/);
  if(m){
    e.respondWith(idbBlob(m[1]).then(v => v ? new Response(v.blob, {headers: {'Content-Type': v.type || 'application/octet-stream'}}) : new Response('not found', {status: 404})));
    return;
  }
  // アプリ一式はiPadに保存した分を使う（更新は sw.js の VERSION を変えると入れ替わる）
  if(e.request.mode === 'navigate'){
    e.respondWith(caches.match('index.html').then(hit => hit || fetch(e.request)));
    return;
  }
  e.respondWith(caches.match(e.request, {ignoreSearch: true}).then(hit => hit || fetch(e.request).then(r => {
    if(r.ok){ const c = r.clone(); caches.open(VERSION).then(ca => ca.put(e.request, c)); }
    return r;
  })));
});
