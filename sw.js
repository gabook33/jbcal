// 오프라인에서도 앱 화면이 열리도록 앱 파일을 저장해 둔다.
// 경로는 상대 경로라 GitHub Pages 하위 경로(/jbcal/)에서도 같다.
// 구글 API·로그인 요청은 건드리지 않는다(항상 네트워크).
const VERSION = 'jbs-calendar-v15';
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest', 'css/styles.css',
  'js/app.js', 'js/time.js', 'js/nlp.js', 'js/gcal.js', 'js/demo.js', 'js/tasks.js', 'js/recur.js', 'js/extras.js', 'js/travel.js',
  'icons/icon-v14.svg', 'icons/icon-small-v14.svg', 'icons/favicon-v14.ico', 'icons/icon-16-v14.png', 'icons/icon-32-v14.png',
  'icons/icon-192-v14.png', 'icons/icon-512-v14.png', 'icons/apple-touch-icon-v14.png', 'icons/icon-maskable-192-v14.png', 'icons/icon-maskable-512-v14.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
// 같은 출처 파일: 저장본을 먼저 보여 주고 뒤에서 새 버전을 받아 둔다(다음 실행에 반영).
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    const net = fetch(e.request).then((res) => {
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});

// 이 기기 알림(앱이 띄운 알림) 누르기: 「5분 뒤 다시」·「참가」·「열기」
self.addEventListener('notificationclick', (e) => {
  const n = e.notification;
  const data = n.data || {};
  n.close();
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    if (e.action === 'snooze') {
      // 열린 앱이 있으면 앱이 5분 뒤 다시 띄운다. 없으면 여기서 기다렸다 띄운다(브라우저가 서비스 워커를 끄면 못 올 수 있음)
      if (wins.length) { wins[0].postMessage({ type: 'snooze', data }); return; }
      await new Promise((r) => setTimeout(r, 5 * 60e3));
      await self.registration.showNotification(data.title || '일정 알림', { body: data.body || '', data, tag: `${n.tag}-z`, requireInteraction: true });
      return;
    }
    if (e.action === 'join' && data.join) { await self.clients.openWindow(data.join); return; }
    const w = wins[0];
    if (w) { await w.focus(); w.postMessage({ type: 'open', date: data.date }); return; }
    await self.clients.openWindow(new URL(`./${data.date ? `?date=${data.date}` : ''}`, self.registration.scope).href);
  })());
});
