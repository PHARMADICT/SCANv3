const CACHE = 'tracker-made-easy-v1';
const ASSETS = ['./','./index.html','./app.js','./manifest.json'];
self.addEventListener('install',e=>e.waitUntil(caches.open(CACHE).then(c=>c.addAll(ASSETS)).then(()=>self.skipWaiting())));
self.addEventListener('activate',e=>e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',e=>{
  e.respondWith(caches.match(e.request).then(r=>r||fetch(e.request).then(res=>{ if(res.status===200){ const c=res.clone(); caches.open(CACHE).then(cache=>cache.put(e.request,c)); } return res; }).catch(()=>e.request.mode==='navigate'?caches.match('./index.html'):null)));
});
