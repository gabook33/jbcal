// 오프라인에서도 앱 화면이 열리도록 앱 파일을 저장해 둔다.
// 경로는 상대 경로라 GitHub Pages 하위 경로(/jbcal/)에서도 같다.
// 구글 API·로그인 요청은 건드리지 않는다(항상 네트워크).
const VERSION = 'jbs-calendar-v4';
const SHELL = [
  './', 'index.html', 'config.js', 'manifest.webmanifest', 'css/styles.css',
  'js/app.js', 'js/time.js', 'js/nlp.js', 'js/gcal.js', 'js/demo.js',
  'icons/icon.svg', 'icons/icon-32.png', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
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
