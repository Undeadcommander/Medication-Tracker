// Request validation, ported from server/index.ts (same limits and error messages).
import type { PushReminder } from '../../shared/types';

export const MAX_REMINDERS = 3000;
export const MAX_TITLE = 120;
export const MAX_BODY = 300;
export const MAX_ENDPOINT = 2048;
export const MAX_DISMISSED = 500;
/** server/index.ts accepts 2 MB of JSON (3000 reminders x ~500 bytes is about 1.5 MB). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22,128}$/;
const REMINDER_ID_RE = /^[^\s\u0000-\u001f]{1,120}@\d{1,16}$/;
const KEY_RE = /^[A-Za-z0-9_\-+/=]{8,256}$/;

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export const bad = (msg: string): never => {
  throw new HttpError(400, msg);
};

export interface StoredSubscription {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
}

export function asObject(v: unknown, what = 'body'): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad(`${what} must be an object`);
  return v as Record<string, unknown>;
}

export function parseDeviceId(v: unknown): string {
  if (typeof v !== 'string' || !DEVICE_ID_RE.test(v)) return bad('invalid deviceId');
  return v;
}

/**
 * Push services the Worker may POST to. Only these hosts are accepted as subscription endpoints,
 * so the Worker can't be used to send requests to arbitrary URLs (SSRF / free-quota abuse).
 *  - Apple (Safari, iPhone/iPad Home Screen apps): web.push.apple.com
 *  - Chrome, Edge-on-Android, Opera, Samsung: fcm.googleapis.com
 *  - Firefox: updates.push.services.mozilla.com (any *.push.services.mozilla.com)
 *  - Edge on Windows: wns2-*.notify.windows.com (any *.notify.windows.com)
 */
export function isAllowedPushHost(host: string): boolean {
  const h = host.toLowerCase();
  return (
    h === 'web.push.apple.com' ||
    h === 'fcm.googleapis.com' ||
    h.endsWith('.push.services.mozilla.com') ||
    h.endsWith('.notify.windows.com')
  );
}

/**
 * `extraOrigins`: exact origins also allowed (http too), from the EXTRA_PUSH_ORIGINS var. Only for
 * local testing against a mock push service; leave it empty in production.
 */
export function parseSubscription(v: unknown, extraOrigins: ReadonlySet<string> = new Set()): StoredSubscription {
  const o = asObject(v, 'subscription');
  const endpoint = o.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) return bad('invalid subscription endpoint');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return bad('invalid subscription endpoint');
  }
  const extra = extraOrigins.has(url.origin);
  if (url.protocol !== 'https:' && !extra) return bad('subscription endpoint must be https');
  if (!extra && (url.port !== '' || url.username || url.password || !isAllowedPushHost(url.hostname))) {
    return bad('unsupported push service');
  }
  const keys = asObject(o.keys, 'subscription.keys');
  const { p256dh, auth } = keys;
  if (typeof p256dh !== 'string' || !KEY_RE.test(p256dh) || typeof auth !== 'string' || !KEY_RE.test(auth)) {
    return bad('invalid subscription keys');
  }
  const exp = o.expirationTime;
  return {
    endpoint,
    expirationTime: typeof exp === 'number' && Number.isFinite(exp) ? exp : null,
    keys: { p256dh, auth },
  };
}

export function parseReminder(v: unknown): PushReminder {
  const o = asObject(v, 'reminder');
  const { id, medId, at, title, body } = o;
  if (typeof id !== 'string' || !REMINDER_ID_RE.test(id)) return bad('invalid reminder id');
  if (typeof medId !== 'string' || medId.length < 1 || medId.length > 100) return bad('invalid medId');
  if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0 || at > 8.64e15) return bad('invalid reminder time');
  if (typeof title !== 'string' || !title.trim()) return bad('invalid reminder title');
  if (typeof body !== 'string') return bad('invalid reminder body');
  return {
    id,
    medId,
    at: Math.round(at),
    title: title.slice(0, MAX_TITLE),
    body: body.slice(0, MAX_BODY),
  };
}

export function parseOriginList(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((o) => o.trim().replace(/\/+$/, ''))
      .filter(Boolean),
  );
}

/** Reads a JSON body with the same 2 MB cap as express.json({ limit: '2mb' }). */
export async function readJson(req: Request, limit = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'payload too large');
  const type = (req.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase();
  // express.json() leaves non-JSON bodies unparsed, which then fails "body must be an object".
  if (type !== 'application/json') return undefined;
  if (!req.body) return undefined;
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw new HttpError(413, 'payload too large');
    }
    chunks.push(value);
  }
  if (!size) return undefined;
  const buf = new Uint8Array(size);
  let o = 0;
  for (const c of chunks) {
    buf.set(c, o);
    o += c.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(buf));
  } catch {
    throw new HttpError(400, 'bad request');
  }
}
