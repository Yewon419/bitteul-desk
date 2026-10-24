/**
 * Phone alerts over Web Push. The server signs with its own VAPID key and talks to the
 * browser's push service directly, so no relay server sits in between and the payload
 * stays encrypted end to end. Keys and subscriptions live in ~/.pixel-agents.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as webpush from 'web-push';

import {
  LAYOUT_FILE_DIR,
  PUSH_DEDUPE_MS,
  PUSH_KEYS_FILE,
  PUSH_RETRY_DELAY_MS,
  PUSH_SEEN_WINDOW_MS,
  PUSH_SUBSCRIPTIONS_FILE,
  PUSH_TTL_SECONDS,
  PUSH_VAPID_SUBJECT,
} from './constants.js';

export interface PushAlert {
  title: string;
  body: string;
  /** The chat a tap opens; null opens the office. */
  sessionId: string | null;
  /** Alerts sharing a tag replace each other on the phone and are deduped here. */
  tag: string;
}

interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

type Log = (msg: string, extra?: Record<string, unknown>) => void;

function stateDir(): string {
  return path.join(os.homedir(), LAYOUT_FILE_DIR);
}

function writePrivate(file: string, data: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { encoding: 'utf-8', mode: 0o600 });
  fs.renameSync(tmp, file);
}

function isSubscription(value: unknown): value is webpush.PushSubscription {
  if (typeof value !== 'object' || value === null) return false;
  const { endpoint, keys } = value as Record<string, unknown>;
  if (typeof endpoint !== 'string' || !endpoint.startsWith('https://')) return false;
  if (typeof keys !== 'object' || keys === null) return false;
  const { p256dh, auth } = keys as Record<string, unknown>;
  return typeof p256dh === 'string' && typeof auth === 'string';
}

export class PushNotifier {
  private readonly keys: VapidKeys;
  private subscriptions: webpush.PushSubscription[];
  /** When a chat page last reported the user active on it, per session. */
  private readonly lastSeen = new Map<string, number>();
  private readonly lastSent = new Map<string, number>();

  constructor(
    private readonly log: Log,
    private readonly dir: string = stateDir(),
  ) {
    this.keys = this.loadKeys();
    this.subscriptions = this.loadSubscriptions();
  }

  private loadKeys(): VapidKeys {
    const file = path.join(this.dir, PUSH_KEYS_FILE);
    if (fs.existsSync(file)) {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<VapidKeys>;
      if (typeof parsed.publicKey !== 'string' || typeof parsed.privateKey !== 'string') {
        throw new Error(`push keys file is malformed: ${file}`);
      }
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    }
    const created = webpush.generateVAPIDKeys();
    writePrivate(file, created);
    this.log('push keys created', { file });
    return created;
  }

  private loadSubscriptions(): webpush.PushSubscription[] {
    const file = path.join(this.dir, PUSH_SUBSCRIPTIONS_FILE);
    if (!fs.existsSync(file)) return [];
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!Array.isArray(parsed)) throw new Error(`push subscriptions file is malformed: ${file}`);
    return parsed.filter(isSubscription);
  }

  private saveSubscriptions(): void {
    writePrivate(path.join(this.dir, PUSH_SUBSCRIPTIONS_FILE), this.subscriptions);
  }

  get publicKey(): string {
    return this.keys.publicKey;
  }

  get subscriptionCount(): number {
    return this.subscriptions.length;
  }

  /** Returns false when the body is not a browser PushSubscription. */
  subscribe(value: unknown): boolean {
    if (!isSubscription(value)) return false;
    const sub: webpush.PushSubscription = {
      endpoint: value.endpoint,
      keys: { p256dh: value.keys.p256dh, auth: value.keys.auth },
    };
    this.subscriptions = [...this.subscriptions.filter((s) => s.endpoint !== sub.endpoint), sub];
    this.saveSubscriptions();
    this.log('push subscription added', { host: new URL(sub.endpoint).host });
    return true;
  }

  unsubscribe(endpoint: string): void {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.subscriptions.length !== before) {
      this.saveSubscriptions();
      this.log('push subscription removed', { host: new URL(endpoint).host });
    }
  }

  /** A chat page the user is actively on checks in; its session's alerts stay in the page. */
  markSeen(sessionId: string): void {
    this.lastSeen.set(sessionId, Date.now());
  }

  /**
   * Fire and forget: failures are logged with the push service's answer. `shownIn` lists the
   * chat sessions that display this alert; if the user is active on any of them, it is skipped.
   */
  notify(alert: PushAlert, shownIn: readonly string[]): void {
    const now = Date.now();
    if (this.subscriptions.length === 0) return;
    const watching = shownIn.find((id) => now - (this.lastSeen.get(id) ?? 0) < PUSH_SEEN_WINDOW_MS);
    if (watching !== undefined) {
      this.log('push skipped: chat on screen', { tag: alert.tag, session: watching });
      return;
    }
    const last = this.lastSent.get(alert.tag);
    if (last !== undefined && now - last < PUSH_DEDUPE_MS) return;
    this.lastSent.set(alert.tag, now);
    const payload = JSON.stringify(alert);
    for (const sub of this.subscriptions) {
      void this.send(sub, payload, alert.tag);
    }
  }

  private async send(sub: webpush.PushSubscription, payload: string, tag: string): Promise<void> {
    const host = new URL(sub.endpoint).host;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await webpush.sendNotification(sub, payload, {
          TTL: PUSH_TTL_SECONDS,
          urgency: 'high',
          vapidDetails: {
            subject: PUSH_VAPID_SUBJECT,
            publicKey: this.keys.publicKey,
            privateKey: this.keys.privateKey,
          },
        });
        this.log('push sent', { host, tag });
        return;
      } catch (err) {
        const status = err instanceof webpush.WebPushError ? err.statusCode : null;
        const body = err instanceof webpush.WebPushError ? err.body : String(err);
        // The browser dropped this subscription (app removed, permission revoked).
        if (status === 404 || status === 410) {
          this.log('push subscription expired', { host, status });
          this.unsubscribe(sub.endpoint);
          return;
        }
        const retryable = status === null || status >= 500;
        this.log('push failed', { host, tag, status, body, attempt });
        if (!retryable || attempt === 2) return;
        await new Promise((r) => setTimeout(r, PUSH_RETRY_DELAY_MS));
      }
    }
  }
}
