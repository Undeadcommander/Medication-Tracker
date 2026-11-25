// Push-notification server: stores per-device subscriptions + reminder queues and
// delivers due reminders via Web Push. Also serves the built front end in production.
import express, { type NextFunction, type Request, type Response } from 'express';
import * as webpush from 'web-push';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PushReminder } from '../shared/types';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA_DIR = path.join(ROOT, 'server', 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const VAPID_FILE = path.join(DATA_DIR, 'vapid.json');
const DIST_DIR = path.join(ROOT, 'dist');

// ---------- env (.env without dotenv) ----------
function loadDotEnv(file: string): void {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    return;
  }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim().replace(/^export\s+/, '');
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    } else {
      const hash = value.search(/\s#/);
      if (hash >= 0) value = value.slice(0, hash).trim();
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
loadDotEnv(path.join(ROOT, '.env'));

const PORT = Number(process.env.PORT) || 8787;
let VAPID_SUBJECT = process.env.VAPID_SUBJECT?.trim() || 'mailto:admin@example.com';
if (!/^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/.test(VAPID_SUBJECT)) {
  console.warn(`[push] VAPID_SUBJECT "${VAPID_SUBJECT}" is not a mailto: or https: URL; using default.`);
  VAPID_SUBJECT = 'mailto:admin@example.com';
}

// ---------- limits ----------
const MAX_REMINDERS = 3000;
const MAX_TITLE = 120;
const MAX_BODY = 300;
const MAX_ENDPOINT = 2048;
const STALE_MS = 15 * 60_000;
const TICK_MS = 20_000;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{22,128}$/;
const REMINDER_ID_RE = /^[^\s\u0000-\u001f]{1,120}@\d{1,16}$/;
const TEST_COOLDOWN_MS = 5_000;

// ---------- types ----------
interface StoredSubscription {
  endpoint: string;
  expirationTime?: number | null;
  keys: { p256dh: string; auth: string };
}

/** A queued reminder. Snoozed copies fire at `at` but keep the original identity in `orig*`. */
interface StoredReminder extends PushReminder {
  snoozed?: true;
  origId?: string;
  origAt?: number;
}

interface DeviceRecord {
  subscription: StoredSubscription;
  reminders: StoredReminder[];
  updatedAt: number;
}

// ---------- VAPID ----------
interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

function loadOrCreateVapid(): VapidKeys {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(fs.readFileSync(VAPID_FILE, 'utf8')) as Partial<VapidKeys>;
    if (typeof parsed.publicKey === 'string' && typeof parsed.privateKey === 'string') {
      return { publicKey: parsed.publicKey, privateKey: parsed.privateKey };
    }
  } catch {
    /* generate below */
  }
  const keys = webpush.generateVAPIDKeys();
  fs.writeFileSync(VAPID_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log('[push] Generated new VAPID keys (server/data/vapid.json).');
  return keys;
}

const vapid = loadOrCreateVapid();
webpush.setVapidDetails(VAPID_SUBJECT, vapid.publicKey, vapid.privateKey);

// ---------- persistence ----------
const devices = new Map<string, DeviceRecord>();
/** In-memory only: ids recently delivered, so a late client sync can't re-queue them. */
const recentlySent = new Map<string, Map<string, number>>();

function loadDb(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')) as Record<string, DeviceRecord>;
    for (const [id, rec] of Object.entries(raw)) {
      if (!DEVICE_ID_RE.test(id) || !rec || !rec.subscription?.endpoint) continue;
      devices.set(id, {
        subscription: rec.subscription,
        reminders: Array.isArray(rec.reminders) ? rec.reminders : [],
        updatedAt: Number(rec.updatedAt) || Date.now(),
      });
    }
    console.log(`[push] Loaded ${devices.size} device(s).`);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') console.warn('[push] Could not read db.json:', err);
  }
}

let writeTimer: NodeJS.Timeout | null = null;
let writing: Promise<void> = Promise.resolve();

function snapshot(): string {
  return JSON.stringify(Object.fromEntries(devices));
}

async function writeDbNow(): Promise<void> {
  const data = snapshot();
  const tmp = `${DB_FILE}.${process.pid}.tmp`;
  try {
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.writeFile(tmp, data, { mode: 0o600 });
    await fs.promises.rename(tmp, DB_FILE);
  } catch (err) {
    console.error('[push] Failed to persist db.json:', err);
    fs.promises.rm(tmp, { force: true }).catch(() => {});
  }
}

function scheduleSave(): void {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    writing = writing.then(writeDbNow);
  }, 750);
}

function flushSync(): void {
  if (writeTimer) {
    clearTimeout(writeTimer);
    writeTimer = null;
  }
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = `${DB_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, snapshot(), { mode: 0o600 });
    fs.renameSync(tmp, DB_FILE);
  } catch (err) {
    console.error('[push] Final flush failed:', err);
  }
}

// ---------- validation ----------
class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const bad = (msg: string): never => {
  throw new HttpError(400, msg);
};

function asObject(v: unknown, what = 'body'): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return bad(`${what} must be an object`);
  return v as Record<string, unknown>;
}

function parseDeviceId(v: unknown): string {
  if (typeof v !== 'string' || !DEVICE_ID_RE.test(v)) return bad('invalid deviceId');
  return v;
}

function parseSubscription(v: unknown): StoredSubscription {
  const o = asObject(v, 'subscription');
  const endpoint = o.endpoint;
  if (typeof endpoint !== 'string' || endpoint.length > MAX_ENDPOINT) return bad('invalid subscription endpoint');
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return bad('invalid subscription endpoint');
  }
  if (url.protocol !== 'https:') return bad('subscription endpoint must be https');
  const keys = asObject(o.keys, 'subscription.keys');
  const { p256dh, auth } = keys;
  const b64 = /^[A-Za-z0-9_\-+/=]{8,256}$/;
  if (typeof p256dh !== 'string' || !b64.test(p256dh) || typeof auth !== 'string' || !b64.test(auth)) {
    return bad('invalid subscription keys');
  }
  const exp = o.expirationTime;
  return {
    endpoint,
    expirationTime: typeof exp === 'number' && Number.isFinite(exp) ? exp : null,
    keys: { p256dh, auth },
  };
}

function parseReminder(v: unknown): PushReminder {
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

function getDevice(deviceId: string): DeviceRecord {
  const rec = devices.get(deviceId);
  if (!rec) throw new HttpError(404, 'device not subscribed');
  return rec;
}

// ---------- delivery ----------
function payloadFor(deviceId: string, r: StoredReminder) {
  const origId = r.origId ?? r.id;
  const origAt = r.origAt ?? r.at;
  const reminder: PushReminder = { id: origId, medId: r.medId, at: origAt, title: r.title, body: r.body };
  return {
    title: r.title,
    body: r.body,
    tag: origId,
    data: { medId: r.medId, scheduledFor: new Date(origAt).toISOString(), reminderId: origId, deviceId, reminder },
  };
}

type SendResult = 'ok' | 'gone' | 'error';

async function pushTo(deviceId: string, rec: DeviceRecord, payload: unknown): Promise<SendResult> {
  try {
    await webpush.sendNotification(rec.subscription, JSON.stringify(payload), { TTL: 3600, urgency: 'high' });
    return 'ok';
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    // 404/410: subscription expired. 401/403: it was created for a different VAPID key.
    if (status === 404 || status === 410 || status === 401 || status === 403) {
      console.warn(`[push] ${deviceId.slice(0, 6)}… subscription no longer valid (${status}); removing device.`);
      return 'gone';
    }
    console.warn(
      `[push] send failed for ${deviceId.slice(0, 6)}… (${status ?? 'network'}):`,
      (err as Error).message ?? err,
    );
    return 'error';
  }
}

function markSent(deviceId: string, id: string): void {
  let m = recentlySent.get(deviceId);
  if (!m) recentlySent.set(deviceId, (m = new Map()));
  m.set(id, Date.now());
}

let ticking = false;
async function tick(): Promise<void> {
  if (ticking) return;
  ticking = true;
  try {
    const now = Date.now();
    // Forget old "recently sent" markers.
    for (const [dev, m] of recentlySent) {
      for (const [id, t] of m) if (now - t > 3_600_000) m.delete(id);
      if (!m.size) recentlySent.delete(dev);
    }
    for (const [dev, t] of lastTest) if (now - t > TEST_COOLDOWN_MS) lastTest.delete(dev);

    for (const [deviceId, rec] of [...devices]) {
      const due = rec.reminders.filter((r) => r.at <= now).sort((a, b) => a.at - b.at);
      if (!due.length) continue;

      const fresh = due.filter((r) => now - r.at <= STALE_MS);
      const finished = new Set<string>(due.filter((r) => now - r.at > STALE_MS).map((r) => r.id)); // stale: drop
      let gone = false;

      for (const r of fresh) {
        const result = await pushTo(deviceId, rec, payloadFor(deviceId, r));
        if (result === 'ok') {
          finished.add(r.id);
          // The device may have unsubscribed while we were awaiting the push service.
          if (devices.get(deviceId) === rec) markSent(deviceId, r.origId ?? r.id);
        } else if (result === 'gone') {
          gone = true;
          break;
        }
        // 'error': keep it queued; it is retried next tick until it goes stale.
      }

      if (gone) {
        // Only remove the record we tried; it may have re-subscribed meanwhile.
        if (devices.get(deviceId) === rec) {
          devices.delete(deviceId);
          recentlySent.delete(deviceId);
        }
      } else if (finished.size) {
        const current = devices.get(deviceId);
        if (current) current.reminders = current.reminders.filter((r) => !finished.has(r.id));
      }
      scheduleSave();
    }
  } catch (err) {
    console.error('[push] scheduler error:', err);
  } finally {
    ticking = false;
  }
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  next();
});
app.use('/api', (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

// CORS for a front end hosted elsewhere (e.g. GitHub Pages). ALLOWED_ORIGINS is a comma-separated
// list of exact origins such as "https://undeadcommander.github.io". Same-origin use needs none.
const allowedOrigins = new Set(
  (process.env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean),
);
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') {
    res.sendStatus(origin && allowedOrigins.has(origin) ? 204 : 403);
    return;
  }
  next();
});
// 3000 reminders x ~500 bytes worst case is about 1.5 MB.
app.use('/api', express.json({ limit: '2mb' }));

type Handler = (req: Request, res: Response) => void | Promise<void>;
const route =
  (fn: Handler) =>
  (req: Request, res: Response, next: NextFunction): void => {
    Promise.resolve(fn(req, res)).catch(next);
  };

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, devices: devices.size, time: new Date().toISOString() });
});

app.get('/api/push/public-key', (_req, res) => {
  res.json({ publicKey: vapid.publicKey });
});

app.post(
  '/api/push/subscribe',
  route((req, res) => {
    const body = asObject(req.body);
    const deviceId = parseDeviceId(body.deviceId);
    const subscription = parseSubscription(body.subscription);
    const existing = devices.get(deviceId);
    devices.set(deviceId, {
      subscription,
      reminders: existing?.reminders ?? [],
      updatedAt: Date.now(),
    });
    scheduleSave();
    res.json({ ok: true });
  }),
);

app.post(
  '/api/push/unsubscribe',
  route((req, res) => {
    const deviceId = parseDeviceId(asObject(req.body).deviceId);
    devices.delete(deviceId);
    recentlySent.delete(deviceId);
    scheduleSave();
    res.json({ ok: true });
  }),
);

app.post(
  '/api/push/reminders',
  route((req, res) => {
    const body = asObject(req.body);
    const deviceId = parseDeviceId(body.deviceId);
    if (!Array.isArray(body.reminders)) return bad('reminders must be an array');
    if (body.reminders.length > MAX_REMINDERS) return bad(`at most ${MAX_REMINDERS} reminders`);
    const dismissedRaw = body.dismissed;
    const dismissed = new Set<string>(
      Array.isArray(dismissedRaw)
        ? dismissedRaw.filter((x): x is string => typeof x === 'string').slice(0, 500)
        : [],
    );
    const rec = getDevice(deviceId);
    const now = Date.now();
    const sent = recentlySent.get(deviceId);

    const seen = new Set<string>();
    const next: StoredReminder[] = [];
    for (const item of body.reminders) {
      const r = parseReminder(item);
      if (r.at <= now || seen.has(r.id) || sent?.has(r.id)) continue;
      seen.add(r.id);
      next.push(r);
    }
    // Snoozed copies are server-side only. Keep them unless the dose was handled in the app,
    // or the medication no longer has reminders (deleted, or notifications turned off).
    const activeMeds = new Set(next.map((r) => r.medId));
    for (const s of rec.reminders) {
      const keep = s.snoozed && s.at > now && activeMeds.has(s.medId) && !dismissed.has(s.origId ?? '') && !seen.has(s.id);
      if (keep) next.push(s);
    }
    next.sort((a, b) => a.at - b.at);
    rec.reminders = next.slice(0, MAX_REMINDERS);
    rec.updatedAt = now;
    scheduleSave();
    res.json({ ok: true, count: rec.reminders.length });
  }),
);

app.post(
  '/api/push/snooze',
  route((req, res) => {
    const body = asObject(req.body);
    const deviceId = parseDeviceId(body.deviceId);
    const reminder = parseReminder(body.reminder);
    const minutes = Number(body.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) return bad('minutes must be between 1 and 120');
    const rec = getDevice(deviceId);
    const at = Date.now() + Math.round(minutes * 60_000);
    // One pending snooze per original reminder.
    rec.reminders = rec.reminders.filter((r) => (r.origId ?? r.id) !== reminder.id || !r.snoozed);
    if (rec.reminders.length >= MAX_REMINDERS) return bad('too many reminders');
    rec.reminders.push({
      ...reminder,
      id: `${reminder.medId.slice(0, 40)}~snooze@${at}`,
      at,
      snoozed: true,
      origId: reminder.id,
      origAt: reminder.at,
    });
    rec.reminders.sort((a, b) => a.at - b.at);
    rec.updatedAt = Date.now();
    scheduleSave();
    res.json({ ok: true, at });
  }),
);

const lastTest = new Map<string, number>();
app.post(
  '/api/push/test',
  route(async (req, res) => {
    const deviceId = parseDeviceId(asObject(req.body).deviceId);
    const rec = getDevice(deviceId);
    const now = Date.now();
    if (now - (lastTest.get(deviceId) ?? 0) < TEST_COOLDOWN_MS) throw new HttpError(429, 'slow down');
    lastTest.set(deviceId, now);
    const result = await pushTo(deviceId, rec, {
      title: 'MedTracker test',
      body: 'Notifications are working on this device.',
      tag: 'medtracker-test',
      data: { test: true, deviceId },
    });
    if (result === 'gone') {
      devices.delete(deviceId);
      scheduleSave();
      throw new HttpError(410, 'subscription expired');
    }
    if (result === 'error') throw new HttpError(502, 'push service rejected the message');
    res.json({ ok: true });
  }),
);

app.use('/api', (_req, res) => {
  res.status(404).json({ error: 'not found' });
});

// Static front end (production build).
if (fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
  app.use(
    express.static(DIST_DIR, {
      index: false,
      // Serve /__/auth/handler and /__/auth/iframe (self-hosted Firebase sign-in helpers) from *.html.
      extensions: ['html'],
      setHeaders(res, filePath) {
        const base = path.basename(filePath);
        if (base === 'sw.js' || base === 'manifest.webmanifest') res.setHeader('Cache-Control', 'no-cache');
        else if (filePath.includes(`${path.sep}assets${path.sep}`)) {
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
        }
      },
    }),
  );
  app.use((req, res, next) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(DIST_DIR, 'index.html'));
  });
  console.log('[push] Serving static files from dist/.');
}

// Error handler (JSON parse errors, size limits, validation).
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  const e = err as { status?: number; statusCode?: number; type?: string };
  const status = e.status ?? e.statusCode;
  if (e.type === 'entity.too.large') {
    res.status(413).json({ error: 'payload too large' });
    return;
  }
  if (status && status >= 400 && status < 500) {
    res.status(status).json({ error: 'bad request' });
    return;
  }
  console.error('[push] unhandled error:', err);
  res.status(500).json({ error: 'internal error' });
});

// ---------- start ----------
loadDb();
const timer = setInterval(() => void tick(), TICK_MS);
const server = app.listen(PORT, () => {
  console.log(`[push] Listening on http://localhost:${PORT}`);
});
server.on('error', (err) => {
  console.error('[push] Server error:', err);
  process.exit(1);
});
void tick();

function shutdown(): void {
  clearInterval(timer);
  flushSync();
  server.close();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
