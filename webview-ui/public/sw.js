/*
 * Bitteul Desk service worker: phone alerts only. Nothing is cached, so the office always
 * loads fresh from the PC. The page leaves the server token in Cache Storage when it turns
 * alerts on; the token never rides inside a push message.
 */
const TOKEN_CACHE = 'bitteul-push';
const TOKEN_KEY = './push-token';

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let alert = {
    title: '빛뜰 데스크',
    body: '확인할 일이 생겼어요.',
    sessionId: null,
    tag: 'bitteul',
  };
  try {
    alert = { ...alert, ...event.data.json() };
  } catch (err) {
    console.warn('[Webview] push payload unreadable', err);
  }
  // iOS revokes the subscription of a worker that receives a push and shows nothing.
  event.waitUntil(
    self.registration.showNotification(alert.title, {
      body: alert.body,
      tag: alert.tag,
      renotify: true,
      icon: './scene/app-icon.png',
      data: { sessionId: alert.sessionId },
    }),
  );
});

async function openTarget(sessionId) {
  const cache = await caches.open(TOKEN_CACHE);
  const saved = await cache.match(TOKEN_KEY);
  const token = saved ? await saved.text() : '';
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  let page = './scene.html';
  if (token && sessionId) {
    params.set('session', sessionId);
    page = './chat.html';
  }
  const url = new URL(`${page}?${params.toString()}`, self.registration.scope).href;
  const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  const already = sessionId && windows.find((w) => w.url.includes(`session=${sessionId}`));
  if (already) {
    await already.focus();
    return;
  }
  await self.clients.openWindow(url);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(openTarget(event.notification.data?.sessionId ?? null));
});
