// 오프라인에서도 앱 화면이 열리도록 앱 파일을 저장해 둔다.
// 경로는 상대 경로라 GitHub Pages 하위 경로(/jbcal/)에서도 같다.
// 구글 API·로그인 요청은 건드리지 않는다(항상 네트워크).
// 판을 올릴 때는 VERSION 과 version.json·js/version.js 를 같이 바꾼다. VERSION 이 바뀌어야 새 파일을 한 벌로 다시 받는다.
const VERSION = 'jbs-calendar-v16';
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest', 'css/styles.css',
  'js/app.js', 'js/time.js', 'js/nlp.js', 'js/gcal.js', 'js/demo.js', 'js/tasks.js', 'js/recur.js', 'js/extras.js', 'js/travel.js', 'js/version.js',
  'icons/icon-v14.svg', 'icons/icon-small-v14.svg', 'icons/favicon-v14.ico', 'icons/icon-16-v14.png', 'icons/icon-32-v14.png',
  'icons/icon-192-v14.png', 'icons/icon-512-v14.png', 'icons/apple-touch-icon-v14.png', 'icons/icon-maskable-192-v14.png', 'icons/icon-maskable-512-v14.png',
];

// 설치: 앱 파일 한 벌을 브라우저 HTTP 캐시를 거치지 않고(cache: 'reload') 새로 받는다.
// (GitHub Pages 는 max-age=600 이라 그냥 받으면 10분 안의 옛 파일이 섞일 수 있다)
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION)
    .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
    .then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('message', (e) => {
  if (e.data?.type === 'skipWaiting') self.skipWaiting();
  if (e.data?.type === 'version') e.ports[0]?.postMessage(VERSION);
});
// 앱 파일(SHELL): 이 판의 저장본만 준다 → 화면·코드가 늘 같은 판 한 벌(옛 판과 섞이지 않음).
// 새 판은 sw.js(VERSION)가 바뀌면 통째로 새로 받고, 앱이 version.json 을 보고 「새 버전 적용」으로 다시 연다.
// version.json 은 늘 네트워크(저장하지 않음). 그 밖의 같은 출처 파일(안내 페이지 등)은 네트워크 먼저, 안 되면 저장본.
const SHELL_PATHS = new Set(SHELL.map((u) => new URL(u, self.registration.scope).pathname));
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.endsWith('/version.json')) return;
  e.respondWith(caches.open(VERSION).then(async (cache) => {
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit && SHELL_PATHS.has(url.pathname)) return hit;
    try {
      const res = await fetch(e.request);
      if (res.ok) cache.put(e.request, res.clone());
      return res;
    } catch (err) {
      if (hit) return hit;
      throw err;
    }
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
