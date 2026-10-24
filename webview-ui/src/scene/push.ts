/**
 * Phone alerts (Web Push) from the page side: register the worker, ask for permission,
 * hand the subscription to the PC, and tell the PC while a page is on screen so it holds
 * alerts back.
 */

import { fetchJson, postJson } from './api.js';
import {
  PUSH_ACTIVE_WINDOW_MS,
  PUSH_SEEN_INTERVAL_MS,
  PUSH_SW_URL,
  PUSH_TOKEN_CACHE,
  PUSH_TOKEN_KEY,
} from './constants.js';

/** ready: can turn on now. install: iPhone/iPad Safari, works once added to the home screen. */
export type PushSupport = 'ready' | 'install' | 'unsupported';

export function pushSupport(): PushSupport {
  if ('serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window) {
    return 'ready';
  }
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  return ios && window.isSecureContext ? 'install' : 'unsupported';
}

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + '='.repeat((4 - (base64url.length % 4)) % 4))
    .replace(/-/g, '+')
    .replace(/_/g, '/');
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

async function registration(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register(PUSH_SW_URL);
  return navigator.serviceWorker.ready;
}

export async function pushIsOn(): Promise<boolean> {
  if (pushSupport() !== 'ready' || Notification.permission !== 'granted') return false;
  const reg = await navigator.serviceWorker.getRegistration(PUSH_SW_URL);
  return !!(await reg?.pushManager.getSubscription());
}

/**
 * Call straight from a tap: iOS only shows the permission prompt inside a user gesture,
 * so the prompt comes before anything that waits on the network.
 */
export async function turnPushOn(token: string): Promise<'on' | 'denied'> {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const [reg, key] = await Promise.all([
    registration(),
    fetchJson<{ publicKey: string }>('./api/push/key', token),
  ]);
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: keyBytes(key.publicKey),
    }));
  // The worker opens chats from an alert tap and needs the token to do it.
  const cache = await caches.open(PUSH_TOKEN_CACHE);
  await cache.put(PUSH_TOKEN_KEY, new Response(token));
  await postJson('./api/push/subscribe', token, sub.toJSON());
  return 'on';
}

export async function turnPushOff(token: string): Promise<void> {
  const reg = await navigator.serviceWorker.getRegistration(PUSH_SW_URL);
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return;
  await postJson('./api/push/unsubscribe', token, { endpoint: sub.endpoint });
  await sub.unsubscribe();
}

/**
 * While the user is actually on this chat (front tab, touched or typed in the last minute),
 * that session's alerts stay in the page. A screen left open on an empty desk, a tab in the
 * background and other members' chats don't hold anything back.
 */
export function reportSeen(token: string, session: () => string | null): void {
  let lastInput = Date.now();
  const ping = (): void => {
    const sessionId = session();
    if (!sessionId || document.visibilityState !== 'visible') return;
    if (Date.now() - lastInput > PUSH_ACTIVE_WINDOW_MS) return;
    postJson('./api/push/seen', token, { sessionId }).catch((err: unknown) => {
      console.warn('[Webview] push seen ping failed', err);
    });
  };
  const touched = (): void => {
    lastInput = Date.now();
  };
  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart', 'scroll'] as const) {
    window.addEventListener(type, touched, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') touched();
    ping();
  });
  ping();
  setInterval(ping, PUSH_SEEN_INTERVAL_MS);
}
