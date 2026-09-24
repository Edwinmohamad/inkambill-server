// Service worker: hanya meng-cache aset statis (CSS/JS/gambar/font). Semua request lain — JSON API
// seperti /wa-gateway/messages.json & status.json, halaman, dsb. — SELALU ke jaringan.
// Versi sebelumnya (v130) meng-cache SEMUA GET non-dokumen secara cache-first tanpa pernah diperbarui,
// sehingga polling JSON selalu mendapat respons lama (mis. log WA baru "hilang" setelah muncul).
// Naikkan CACHE setiap kali aset inti berubah; versi lama dihapus otomatis saat activate.
const CACHE='inkamnet-shell-v131';
const CORE=['/css/app.css','/js/app.js','/js/nms.js','/js/performance.js','/img/inkamnet-wordmark-hq.png'];
const STATIC_DEST=new Set(['style','script','image','font']);
const STATIC_PATH=/^\/(css|js|img|fonts?|vendor)\//;
self.addEventListener('install',event=>{self.skipWaiting();event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(CORE)).catch(()=>{}));});
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const req=event.request;
  if(req.method!=='GET')return;
  const url=new URL(req.url);
  if(url.origin!==self.location.origin)return;
  if(!STATIC_DEST.has(req.destination)&&!STATIC_PATH.test(url.pathname))return;
  // Stale-while-revalidate: tampilkan dari cache bila ada, sambil memperbarui cache di latar belakang.
  event.respondWith(caches.open(CACHE).then(cache=>cache.match(req).then(hit=>{
    const network=fetch(req).then(res=>{if(res&&res.ok)cache.put(req,res.clone()).catch(()=>{});return res;}).catch(()=>hit);
    if(hit){event.waitUntil(network.catch(()=>{}));return hit;}
    return network;
  })));
});
