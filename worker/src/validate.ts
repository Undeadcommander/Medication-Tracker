// Request validation, ported from server/index.ts (same limits and error messages).
import { MAX_GROUP_DOSES, doseId } from '../../shared/reminderText';
import type { PushDose, PushReminder } from '../../shared/types';

export const MAX_REMINDERS = 3000;
export const MAX_TITLE = 120;
export const MAX_BODY = 300;
export const MAX_ENDPOINT = 2048;
export const MAX_DISMISSED = 500;
/** server/index.ts accepts 2 MB of JSON (3000 reminders x ~500 bytes is about 1.5 MB). */
export const MAX_BODY_BYTES = 2 * 1024 * 1024;
/** Every other POST (subscribe, unsubscribe, snooze, test) is a few KB at most. */
export const MAX_SMALL_BODY_BYTES = 64 * 1024;
/** Body cap for a POST route: only the full reminder sync needs the large one. */
export const bodyLimitFor = (path: string) => (path === '/api/push/reminders' ? MAX_BODY_BYTES : MAX_SMALL_BODY_BYTES);
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22,128}$/;
const REMINDER_ID_RE = /^[^\s\u0000-\u001f\u007f]{1,120}@\d{1,16}$/;
/** base64 or base64url (padded or not); the decoded key lengths are checked at subscribe. */
const KEY_RE = /^[A-Za-z0-9_\-+/]+={0,2}$/;
const MAX_KEY_CHARS = 128;
/** Unpaired UTF-16 surrogates (not valid text; JSON.stringify escapes them to 6 bytes each). */
const LONE_SURROGATE_RE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
/** Shared by every clipText call (replace() resets a global regex's lastIndex itself). */
const LONE_SURROGATES_G = new RegExp(LONE_SURROGATE_RE.source, 'g');
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

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
  const keyOk = (k: unknown): k is string => typeof k === 'string' && k.length <= MAX_KEY_CHARS && KEY_RE.test(k);
  if (!keyOk(p256dh) || !keyOk(auth)) {
    return bad('invalid subscription keys');
  }
  const exp = o.expirationTime;
  return {
    endpoint,
    expirationTime: typeof exp === 'number' && Number.isFinite(exp) ? exp : null,
    keys: { p256dh, auth },
  };
}

/**
 * Cuts `s` to at most `max` UTF-16 units without splitting a surrogate pair, after replacing
 * unpaired surrogates (so the result is always well-formed text).
 */
export function clipText(s: string, max: number): string {
  const clean = s.replace(LONE_SURROGATES_G, '\uFFFD');
  if (clean.length <= max) return clean;
  const code = clean.charCodeAt(max - 1);
  return clean.slice(0, code >= 0xd800 && code <= 0xdbff ? max - 1 : max);
}

function parseMedId(v: unknown): string {
  if (typeof v !== 'string' || v.length < 1 || v.length > 100 || CONTROL_RE.test(v) || LONE_SURROGATE_RE.test(v)) {
    return bad('invalid medId');
  }
  return v;
}

function parseTime(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 8.64e15) return bad('invalid reminder time');
  return Math.round(v);
}

/** A group's doses: 2..MAX_GROUP_DOSES distinct doses, sorted, none before the reminder's time. */
function parseDoses(v: unknown, at: number): PushDose[] | undefined {
  if (v === undefined || v === null) return undefined;
  if (!Array.isArray(v) || v.length < 1 || v.length > MAX_GROUP_DOSES) return bad('invalid reminder doses');
  const seen = new Set<string>();
  const doses = v.map((d): PushDose => {
    const o = asObject(d, 'dose');
    const dose = { medId: parseMedId(o.medId), at: parseTime(o.at) };
    const id = doseId(dose.medId, dose.at);
    if (dose.at < at || seen.has(id)) bad('invalid reminder doses');
    seen.add(id);
    return dose;
  });
  doses.sort((a, b) => a.at - b.at || (a.medId < b.medId ? -1 : a.medId > b.medId ? 1 : 0));
  // A one-dose "group" is just that dose.
  return doses.length >= 2 ? doses : undefined;
}

export function parseReminder(v: unknown): PushReminder {
  const o = asObject(v, 'reminder');
  const { id, medId, title, body } = o;
  if (typeof id !== 'string' || !REMINDER_ID_RE.test(id) || LONE_SURROGATE_RE.test(id)) return bad('invalid reminder id');
  const med = parseMedId(medId);
  const at = parseTime(o.at);
  if (typeof title !== 'string' || !title.trim()) return bad('invalid reminder title');
  if (typeof body !== 'string') return bad('invalid reminder body');
  const doses = parseDoses(o.doses, at);
  // Title and body are checked for compatibility but never stored or sent: notifications use the
  // server's own discreet wording (shared/reminderText.ts).
  const r: PushReminder = { id, medId: med, at, title: clipText(title, MAX_TITLE), body: clipText(body, MAX_BODY) };
  if (doses) r.doses = doses;
  return r;
}

export function parseOriginList(raw: string | undefined, name = 'ALLOWED_ORIGINS'): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((o) => {
        // Browsers send Origin lowercased and without a path, so compare canonical origins.
        const entry = o.trim();
        if (!entry) return '';
        try {
          const origin = new URL(entry).origin;
          if (origin !== 'null') return origin;
        } catch {
          /* fall through */
        }
        console.warn(`[push] ignoring invalid ${name} entry: ${entry}`);
        return '';
      })
      .filter(Boolean),
  );
}

/** True when the request declares a JSON body (express.json() ignores any other type). */
export const isJsonRequest = (req: Request) =>
  (req.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase() === 'application/json';

/** Reads a JSON body with the same 2 MB cap as express.json({ limit: '2mb' }). */
export async function readJson(req: Request, limit = MAX_BODY_BYTES): Promise<unknown> {
  const declared = Number(req.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > limit) throw new HttpError(413, 'payload too large');
  // express.json() leaves non-JSON bodies unparsed, which then fails "body must be an object".
  if (!isJsonRequest(req)) return undefined;
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
