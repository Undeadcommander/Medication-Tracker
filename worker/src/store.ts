// The reminder store and scheduler: one SQLite-backed Durable Object holds every device's push
// subscription and reminder queue, and its alarm fires at the next due reminder.
import { DurableObject } from 'cloudflare:workers';
import { doseId, reminderText } from '../../shared/reminderText';
import type { PushDose } from '../../shared/types';
import {
  HttpError,
  MAX_DISMISSED,
  MAX_REMINDERS,
  asObject,
  bad,
  bodyLimitFor,
  parseDeviceId,
  parseOriginList,
  parseReminder,
  parseSubscription,
  readJson,
} from './validate';
import {
  MAX_PLAINTEXT,
  loadVapid,
  normaliseSubscriptionKeys,
  sendPush,
  type PushTarget,
  type SendResult,
  type VapidLoad,
  type VapidSigner,
} from './webpush';

export interface Env {
  PUSH_STORE: DurableObjectNamespace<PushStore>;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  VAPID_SUBJECT?: string;
  ALLOWED_ORIGINS?: string;
  /** Dev/test only: exact origins accepted as push endpoints besides the real push services. */
  EXTRA_PUSH_ORIGINS?: string;
}

/** Same as server/index.ts: a reminder more than 15 minutes late is dropped, not sent. */
export const STALE_MS = 15 * 60_000;
/** First retry after a failed send (push service 4xx/5xx/network), like the old 20 s tick... */
export const RETRY_MS = 20_000;
/** ...then doubling up to this, so a failing endpoint costs a handful of tries before going stale. */
export const MAX_RETRY_MS = 5 * 60_000;
/** "Recently sent" dose ids are remembered for an hour so a late client sync can't re-queue them. */
export const SENT_TTL_MS = 3_600_000;
/** Per device, persisted (survives the object being evicted from memory). */
export const TEST_COOLDOWN_MS = 5_000;
/** All test pushes share a token bucket: a burst of this many, then one per TEST_REFILL_MS. */
export const TEST_BUCKET_SIZE = 10;
export const TEST_REFILL_MS = 60_000;
/**
 * Pushes per alarm run. Each is one subrequest (the free plan allows 50 per invocation) and
 * roughly 0.3-0.5 ms of CPU for the ECDH + HKDF + AES-GCM work (VAPID tokens are cached).
 * Leftovers re-arm the alarm immediately.
 */
export const BATCH_SIZE = 10;
/** Pushes in flight at once (Workers allow 6 simultaneous outbound connections). */
export const PUSH_CONCURRENCY = 6;
/** Bounds storage for this single-user deployment. When full, a new device evicts a stale one. */
export const MAX_DEVICES = 200;
/** A device with a successful delivery and activity within this long is never evicted. */
export const PROTECT_MS = 7 * 86_400_000;
/** No-op syncs refresh a device's "last seen" time at most this often (saves a row write). */
export const HEARTBEAT_MS = 3_600_000;
/** Push attempts per device per UTC day: devices that have received a push, and ones that haven't yet. */
export const DAILY_PUSHES = 120;
export const DAILY_PUSHES_UNPROVEN = 20;
/** Requests per client IP (IPv6: per /64) per window, by route kind. */
export const IP_WINDOW_MS = 10 * 60_000;
export const IP_LIMITS = { subscribe: 10, test: 6, write: 120 } as const;
const MAX_IP_KEYS = 5_000;
/** The cron watchdog re-arms an alarm that is missing or this overdue. */
export const ALARM_OVERDUE_MS = 2 * 60_000;
/** Alarm delay after an error, or while push is misconfigured. */
const BACKOFF_MS = 60_000;
const DAY_MS = 86_400_000;

type IpClass = keyof typeof IP_LIMITS;

export interface ReminderRow {
  device_id: string;
  id: string;
  med_id: string;
  at: number;
  /** Grouped reminder: JSON [[medId, at], ...] (2+ doses, earliest first); null for one dose. */
  doses: string | null;
  snoozed: number;
  orig_id: string | null;
  orig_at: number | null;
  [key: string]: SqlStorageValue;
}

interface DueRow extends ReminderRow {
  due_at: number;
  tries: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  rev: number;
  last_ok: number | null;
  day: number;
  day_sends: number;
}

interface DeviceRow {
  rev: number;
  endpoint: string;
  p256dh: string;
  auth: string;
  expiration: number | null;
  updated_at: number;
  last_ok: number | null;
  last_test: number | null;
  [key: string]: SqlStorageValue;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

const encodeDoses = (doses: PushDose[]): string => JSON.stringify(doses.map((d) => [d.medId, d.at]));

function decodeDoses(raw: string | null): PushDose[] | null {
  if (!raw) return null;
  try {
    const list = (JSON.parse(raw) as [string, number][]).map(([medId, at]) => ({ medId, at }));
    return list.length ? list : null;
  } catch {
    return null;
  }
}

/** The doses a queued reminder notifies about, with their ids (what "sent" and "dismissed" track). */
function membersOf(r: ReminderRow): Array<PushDose & { id: string }> {
  const doses = decodeDoses(r.doses);
  if (doses) return doses.map((d) => ({ ...d, id: doseId(d.medId, d.at) }));
  return [{ medId: r.med_id, at: r.orig_at ?? r.at, id: r.orig_id ?? r.id }];
}

const byteLength = (s: string) => new TextEncoder().encode(s).length;

/**
 * The push payload public/sw.js expects. Text is always the discreet wording for the number of
 * doses; whatever title/body the client sent is never stored or forwarded.
 */
export function payloadFor(deviceId: string, r: ReminderRow): string {
  const tag = r.orig_id ?? r.id;
  const doses = decodeDoses(r.doses);
  if (!doses) {
    const text = reminderText(1);
    const at = r.orig_at ?? r.at;
    const reminder = { id: tag, medId: r.med_id, at, ...text };
    return JSON.stringify({
      ...text,
      tag,
      data: { medId: r.med_id, scheduledFor: new Date(at).toISOString(), reminderId: tag, deviceId, reminder },
    });
  }
  const count = doses.length;
  const text = reminderText(count);
  const anchor = doses[0];
  const build = (list: PushDose[]) =>
    JSON.stringify({
      ...text,
      tag,
      count,
      data: {
        medId: anchor.medId,
        scheduledFor: new Date(anchor.at).toISOString(),
        reminderId: tag,
        deviceId,
        count,
        reminder: { id: tag, medId: anchor.medId, at: anchor.at, ...text, doses: list },
      },
    });
  // Validation bounds a group (20 doses, ids of at most 100 characters) to fit; if it somehow
  // doesn't, keep the count and send fewer doses for "Snooze" to carry (UTF-8 bytes, not UTF-16).
  let list = doses;
  let out = build(list);
  while (byteLength(out) > MAX_PLAINTEXT && list.length > 1) {
    list = list.slice(0, -1);
    out = build(list);
  }
  return out;
}

/** Rate-limit key for a client address: IPv4 as is, IPv6 by its /64 (one subscriber's block). */
export function ipKey(ip: string): string {
  const raw = ip.trim().toLowerCase();
  if (!raw.includes(':')) return raw;
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(raw);
  if (mapped) return mapped[1];
  const [head, tail] = raw.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail !== '' ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...new Array(Math.max(0, 8 - h.length - t.length)).fill('0'), ...t];
  return `${groups
    .slice(0, 4)
    .map((g) => g.replace(/^0+(?=.)/, ''))
    .join(':')}::/64`;
}

/** Runs `fn` over `items` with at most `limit` in flight. `fn` must not throw. */
async function runPool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const lanes = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.allSettled(lanes);
}

const retryDelay = (tries: number) => Math.min(RETRY_MS * 2 ** Math.min(tries, 10), MAX_RETRY_MS);

const ROUTE_CLASS: Record<string, IpClass> = {
  '/api/push/subscribe': 'subscribe',
  '/api/push/test': 'test',
  '/api/push/unsubscribe': 'write',
  '/api/push/reminders': 'write',
  '/api/push/snooze': 'write',
};

const DUE_COLUMNS = `r.device_id, r.id, r.med_id, r.at, r.doses, r.snoozed, r.orig_id, r.orig_at, r.due_at, r.tries,
  d.endpoint, d.p256dh, d.auth, d.rev, d.last_ok, d.day, d.day_sends`;

export class PushStore extends DurableObject<Env> {
  private sql: SqlStorage;
  private vapidLoad: Promise<VapidLoad> | null = null;
  private ticking = false;
  /** Set by a failing tick so requests that re-arm don't cut its backoff short (in memory only). */
  private backoffUntil = 0;
  private extraOrigins: Set<string>;
  /** Per-IP request counts. In memory: a flood keeps the object alive, and losing it only resets limits. */
  private ipHits = new Map<string, { n: number; start: number }>();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.extraOrigins = parseOriginList(env.EXTRA_PUSH_ORIGINS);
    this.ensureSchema();
  }

  /**
   * Creates the tables. Tables from the first version of this Worker (no `doses` / `created_at`
   * columns) are rebuilt: their devices simply re-register (the client re-subscribes on a 404).
   */
  ensureSchema(): void {
    const columns = (table: string) =>
      new Set(this.sql.exec<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`).toArray().map((c) => c.name));
    const reminderCols = columns('reminders');
    const deviceCols = columns('devices');
    if ((reminderCols.size && !reminderCols.has('doses')) || (deviceCols.size && !deviceCols.has('created_at'))) {
      console.warn('[push] old storage schema found; rebuilding (devices will re-register).');
      this.sql.exec('DROP TABLE IF EXISTS reminders; DROP TABLE IF EXISTS sent; DROP TABLE IF EXISTS devices;');
    }
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        expiration REAL,
        rev INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        last_ok INTEGER,
        last_test INTEGER,
        day INTEGER NOT NULL DEFAULT 0,
        day_sends INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS reminders (
        device_id TEXT NOT NULL,
        id TEXT NOT NULL,
        med_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        doses TEXT,
        snoozed INTEGER NOT NULL DEFAULT 0,
        orig_id TEXT,
        orig_at INTEGER,
        due_at INTEGER NOT NULL,
        tries INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (device_id, id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders (due_at);
      CREATE INDEX IF NOT EXISTS reminders_device_due ON reminders (device_id, due_at);
      CREATE TABLE IF NOT EXISTS sent (
        device_id TEXT NOT NULL,
        id TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (device_id, id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS sent_at ON sent (at);
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        num REAL NOT NULL,
        at INTEGER NOT NULL
      ) WITHOUT ROWID;
    `);
  }

  // ---------- HTTP (called by the Worker for /api/* after CORS) ----------

  async fetch(request: Request): Promise<Response> {
    try {
      return await this.route(request);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error('[push] unhandled error:', err);
      return json({ error: 'internal error' }, 500);
    }
  }

  private async route(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    const method = request.method;
    if (method === 'GET' && path === '/api/health') {
      const devices = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM devices').one().n;
      const v = await this.vapid();
      const time = new Date().toISOString();
      return v.ok
        ? json({ ok: true, devices, push: 'ready', time })
        : json({ ok: false, devices, push: 'misconfigured', problem: v.problem, time }, 503);
    }
    if (method === 'GET' && path === '/api/push/public-key') {
      const v = await this.vapid();
      if (!v.ok) throw new HttpError(503, 'push not configured');
      return json({ publicKey: v.signer.config.publicKey });
    }
    if (method === 'POST' && path in ROUTE_CLASS) {
      // Cloudflare sets CF-Connecting-IP on every request it receives (clients can't forge it).
      const ip = request.headers.get('CF-Connecting-IP');
      if (ip && !this.allowIp(ROUTE_CLASS[path], ip)) throw new HttpError(429, 'slow down');
      const body = await readJson(request, bodyLimitFor(path));
      switch (path) {
        case '/api/push/subscribe':
          return json(await this.subscribe(body));
        case '/api/push/unsubscribe':
          return json(await this.unsubscribe(body));
        case '/api/push/reminders':
          return json(await this.setReminders(body));
        case '/api/push/snooze':
          return json(await this.snooze(body));
        case '/api/push/test':
          return json(await this.test(body));
      }
    }
    return json({ error: 'not found' }, 404);
  }

  /** Fixed-window counter per (route kind, client IP). */
  private allowIp(kind: IpClass, ip: string, now = Date.now()): boolean {
    const key = `${kind}|${ipKey(ip)}`;
    let entry = this.ipHits.get(key);
    if (!entry || now - entry.start >= IP_WINDOW_MS) {
      if (this.ipHits.size >= MAX_IP_KEYS) {
        for (const [k, e] of this.ipHits) if (now - e.start >= IP_WINDOW_MS) this.ipHits.delete(k);
        // Still full: forget the oldest windows (Maps iterate in insertion order).
        for (const k of this.ipHits.keys()) {
          if (this.ipHits.size < MAX_IP_KEYS) break;
          this.ipHits.delete(k);
        }
      }
      entry = { n: 0, start: now };
      this.ipHits.delete(key);
      this.ipHits.set(key, entry);
    }
    entry.n++;
    return entry.n <= IP_LIMITS[kind];
  }

  /** Test hook: forget per-IP counts. */
  resetRateLimits(): void {
    this.ipHits.clear();
  }

  /**
   * VAPID settings, validated once per object lifetime (a secret change restarts the object).
   * Misconfigured: no public key (503), health says so, nothing is sent and no device is dropped.
   */
  private vapid(): Promise<VapidLoad> {
    this.vapidLoad ??= loadVapid({
      publicKey: this.env.VAPID_PUBLIC_KEY,
      privateKey: this.env.VAPID_PRIVATE_KEY,
      subject: this.env.VAPID_SUBJECT,
    }).then((v) => {
      if (!v.ok) console.error(`[push] push is not configured, no reminders will be sent: ${v.problem}`);
      return v;
    });
    return this.vapidLoad;
  }

  private device(deviceId: string): DeviceRow | null {
    return (
      this.sql
        .exec<DeviceRow>(
          'SELECT rev, endpoint, p256dh, auth, expiration, updated_at, last_ok, last_test FROM devices WHERE device_id = ?',
          deviceId,
        )
        .toArray()[0] ?? null
    );
  }

  private deviceRev(deviceId: string): number | null {
    const row = this.sql.exec<{ rev: number }>('SELECT rev FROM devices WHERE device_id = ?', deviceId).toArray()[0];
    return row ? row.rev : null;
  }

  private requireDevice(deviceId: string): DeviceRow {
    const d = this.device(deviceId);
    if (!d) throw new HttpError(404, 'device not subscribed');
    return d;
  }

  private dropDevice(deviceId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM devices WHERE device_id = ?', deviceId);
      this.sql.exec('DELETE FROM reminders WHERE device_id = ?', deviceId);
      this.sql.exec('DELETE FROM sent WHERE device_id = ?', deviceId);
    });
  }

  /**
   * Makes room for a new device. /subscribe is unauthenticated, so a flood of fake devices must
   * not lock out real ones: evict a device that has never received a push (least recently seen
   * first), else one that has been inactive for PROTECT_MS. Devices that receive pushes and keep
   * syncing are never evicted; if every slot holds one, the new device is refused.
   */
  private evictForNewDevice(now: number): void {
    const victim = this.sql
      .exec<{ device_id: string; last_ok: number | null; seen: number }>(
        `SELECT device_id, last_ok, MAX(updated_at, COALESCE(last_ok, 0)) AS seen FROM devices
         ORDER BY (last_ok IS NOT NULL), seen LIMIT 1`,
      )
      .toArray()[0];
    if (!victim || (victim.last_ok !== null && now - victim.seen < PROTECT_MS)) throw new HttpError(503, 'server full');
    console.warn(`[push] device limit reached; evicting ${victim.device_id.slice(0, 6)}… (${victim.last_ok === null ? 'never delivered' : 'inactive'}).`);
    this.dropDevice(victim.device_id);
  }

  async subscribe(raw: unknown) {
    const body = asObject(raw);
    const deviceId = parseDeviceId(body.deviceId);
    const sub = parseSubscription(body.subscription, this.extraOrigins);
    // Keys that can't encrypt would fail every send: refuse them now, stored normalised.
    const keys = (await normaliseSubscriptionKeys(sub.keys)) ?? bad('invalid subscription keys');
    const now = Date.now();
    const existing = this.device(deviceId);
    if (
      existing &&
      existing.endpoint === sub.endpoint &&
      existing.p256dh === keys.p256dh &&
      existing.auth === keys.auth &&
      existing.expiration === sub.expirationTime
    ) {
      // Same subscription again: nothing to write but a heartbeat.
      if (now - existing.updated_at >= HEARTBEAT_MS) {
        this.sql.exec('UPDATE devices SET updated_at = ? WHERE device_id = ?', now, deviceId);
      }
      return { ok: true };
    }
    let evicted = false;
    if (!existing) {
      const n = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM devices').one().n;
      if (n >= MAX_DEVICES) {
        this.evictForNewDevice(now);
        evicted = true;
      }
    }
    // Existing reminders are kept (same as server/index.ts); `rev` changes so an in-flight send
    // to the old subscription can't remove the new one.
    this.sql.exec(
      `INSERT INTO devices (device_id, endpoint, p256dh, auth, expiration, rev, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh,
         auth = excluded.auth, expiration = excluded.expiration, rev = excluded.rev, updated_at = excluded.updated_at`,
      deviceId,
      sub.endpoint,
      keys.p256dh,
      keys.auth,
      sub.expirationTime,
      (existing?.rev ?? 0) + 1,
      now,
      now,
    );
    if (evicted) await this.rearm();
    return { ok: true };
  }

  async unsubscribe(raw: unknown) {
    const deviceId = parseDeviceId(asObject(raw).deviceId);
    this.dropDevice(deviceId);
    await this.rearm();
    return { ok: true };
  }

  async setReminders(raw: unknown) {
    const body = asObject(raw);
    const deviceId = parseDeviceId(body.deviceId);
    if (!Array.isArray(body.reminders)) return bad('reminders must be an array');
    if (body.reminders.length > MAX_REMINDERS) return bad(`at most ${MAX_REMINDERS} reminders`);
    const dismissed = new Set<string>(
      Array.isArray(body.dismissed)
        ? body.dismissed.filter((x): x is string => typeof x === 'string').slice(0, MAX_DISMISSED)
        : [],
    );
    // Same order as server/index.ts: an unknown device is a 404 (the client re-subscribes on it)
    // before any item is validated; a bad item then rejects the whole request untouched.
    const device = this.requireDevice(deviceId);
    const parsed = body.reminders.map(parseReminder);
    const now = Date.now();
    const sent = new Set(
      this.sql
        .exec<{ id: string }>('SELECT id FROM sent WHERE device_id = ? AND at >= ?', deviceId, now - SENT_TTL_MS)
        .toArray()
        .map((r) => r.id),
    );
    const existing = new Map(
      this.sql
        .exec<ReminderRow>(
          'SELECT device_id, id, med_id, at, doses, snoozed, orig_id, orig_at FROM reminders WHERE device_id = ?',
          deviceId,
        )
        .toArray()
        .map((r) => [r.id, r]),
    );

    const row = (medId: string, at: number, id: string, doses: PushDose[] | null): ReminderRow => ({
      device_id: deviceId,
      id,
      med_id: medId,
      at,
      doses: doses && doses.length >= 2 ? encodeDoses(doses) : null,
      snoozed: 0,
      orig_id: null,
      orig_at: null,
    });
    const seen = new Set<string>();
    const next: ReminderRow[] = [];
    for (const r of parsed) {
      let out: ReminderRow | null;
      if (!r.doses) {
        out = r.at <= now || sent.has(r.id) ? null : row(r.medId, r.at, r.id, null);
      } else {
        // A group never re-notifies a dose already delivered (e.g. in an earlier, larger group):
        // those doses leave it, and what is left fires at its earliest remaining dose.
        const left = r.doses.filter((d) => d.at > now && !sent.has(doseId(d.medId, d.at)));
        const first = left[0];
        if (!first) out = null;
        else if (left.length === r.doses.length && r.at > now) out = row(r.medId, r.at, r.id, left);
        else out = row(first.medId, first.at, doseId(first.medId, first.at), left);
      }
      if (!out || seen.has(out.id)) continue;
      seen.add(out.id);
      next.push(out);
    }
    // Snoozed copies are server-side only. Keep each dose in one unless it was handled in the app
    // (dismissed) or its medication no longer has reminders (deleted, or notifications turned off).
    const activeMeds = new Set<string>();
    for (const r of next) for (const m of membersOf(r)) activeMeds.add(m.medId);
    for (const s of existing.values()) {
      // A snooze that came due but hasn't been sent yet (the alarm is about to run) is kept too.
      if (!s.snoozed || s.at < now - STALE_MS || seen.has(s.id)) continue;
      const members = membersOf(s);
      const keep = members.filter((m) => activeMeds.has(m.medId) && !dismissed.has(m.id));
      if (!keep.length) continue;
      if (keep.length === members.length) next.push(s);
      else {
        const group = keep.length >= 2;
        next.push({
          ...s,
          med_id: keep[0].medId,
          doses: group ? encodeDoses(keep) : null,
          orig_id: group ? s.orig_id : keep[0].id,
          orig_at: keep[0].at,
        });
      }
    }
    next.sort((a, b) => a.at - b.at);
    const final = next.slice(0, MAX_REMINDERS);

    // Write only the difference: a typical sync changes a handful of rows, not all of them.
    const keepIds = new Set(final.map((r) => r.id));
    let changed = false;
    this.ctx.storage.transactionSync(() => {
      for (const id of existing.keys()) {
        if (keepIds.has(id)) continue;
        this.sql.exec('DELETE FROM reminders WHERE device_id = ? AND id = ?', deviceId, id);
        changed = true;
      }
      for (const r of final) {
        const old = existing.get(r.id);
        const same =
          old &&
          old.med_id === r.med_id &&
          old.at === r.at &&
          old.doses === r.doses &&
          old.snoozed === r.snoozed &&
          old.orig_id === r.orig_id &&
          old.orig_at === r.orig_at;
        if (same) continue; // keeps its due_at and tries (e.g. a pending retry)
        changed = true;
        this.sql.exec(
          `INSERT OR REPLACE INTO reminders (device_id, id, med_id, at, doses, snoozed, orig_id, orig_at, due_at, tries)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
          deviceId,
          r.id,
          r.med_id,
          r.at,
          r.doses,
          r.snoozed,
          r.orig_id,
          r.orig_at,
          r.at,
        );
      }
      // "Last seen" (used to pick eviction victims): on a change, else at most once per HEARTBEAT_MS.
      if (changed || now - device.updated_at >= HEARTBEAT_MS) {
        this.sql.exec('UPDATE devices SET updated_at = ? WHERE device_id = ?', now, deviceId);
      }
    });
    if (changed) await this.rearm();
    return { ok: true, count: final.length };
  }

  async snooze(raw: unknown) {
    const body = asObject(raw);
    const deviceId = parseDeviceId(body.deviceId);
    const reminder = parseReminder(body.reminder);
    const minutes = Number(body.minutes);
    if (!Number.isFinite(minutes) || minutes < 1 || minutes > 120) return bad('minutes must be between 1 and 120');
    this.requireDevice(deviceId);
    const now = Date.now();
    const at = now + Math.round(minutes * 60_000);
    this.ctx.storage.transactionSync(() => {
      // One pending snooze per original reminder (for a group: the whole group).
      this.sql.exec('DELETE FROM reminders WHERE device_id = ? AND snoozed = 1 AND orig_id = ?', deviceId, reminder.id);
      const n = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM reminders WHERE device_id = ?', deviceId).one().n;
      if (n >= MAX_REMINDERS) bad('too many reminders');
      this.sql.exec(
        `INSERT OR REPLACE INTO reminders (device_id, id, med_id, at, doses, snoozed, orig_id, orig_at, due_at, tries)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 0)`,
        deviceId,
        `${reminder.medId.slice(0, 40)}~snooze@${at}`,
        reminder.medId,
        at,
        reminder.doses ? encodeDoses(reminder.doses) : null,
        reminder.id,
        reminder.at,
        at,
      );
      this.sql.exec('UPDATE devices SET updated_at = ? WHERE device_id = ?', now, deviceId);
    });
    await this.rearm();
    return { ok: true, at };
  }

  async test(raw: unknown) {
    const deviceId = parseDeviceId(asObject(raw).deviceId);
    const device = this.requireDevice(deviceId);
    const v = await this.vapid();
    if (!v.ok) throw new HttpError(503, 'push not configured');
    const now = Date.now();
    if (device.last_test !== null && now - device.last_test < TEST_COOLDOWN_MS) throw new HttpError(429, 'slow down');
    if (!this.takeTestToken(now)) throw new HttpError(429, 'slow down');
    this.sql.exec('UPDATE devices SET last_test = ? WHERE device_id = ?', now, deviceId);
    const result = await this.push(
      v.signer,
      deviceId,
      { endpoint: device.endpoint, keys: { p256dh: device.p256dh, auth: device.auth } },
      JSON.stringify({
        title: 'Dosely test',
        body: 'Notifications are working on this device.',
        tag: 'medtracker-test',
        data: { test: true, deviceId },
      }),
    );
    const sameDevice = this.deviceRev(deviceId) === device.rev;
    if (result === 'ok') {
      if (sameDevice) this.sql.exec('UPDATE devices SET last_ok = ? WHERE device_id = ?', Date.now(), deviceId);
      return { ok: true };
    }
    if (result === 'gone') {
      if (sameDevice) {
        this.dropDevice(deviceId);
        await this.rearm();
      }
      throw new HttpError(410, 'subscription expired');
    }
    throw new HttpError(502, 'push service rejected the message');
  }

  /** Global token bucket for test pushes (persisted), so rotating device ids can't spam pushes. */
  private takeTestToken(now: number): boolean {
    const row = this.sql.exec<{ num: number; at: number }>("SELECT num, at FROM meta WHERE key = 'test_bucket'").toArray()[0];
    const tokens = Math.min(TEST_BUCKET_SIZE, row ? row.num + Math.max(0, now - row.at) / TEST_REFILL_MS : TEST_BUCKET_SIZE);
    if (tokens < 1) return false;
    this.sql.exec("INSERT OR REPLACE INTO meta (key, num, at) VALUES ('test_bucket', ?, ?)", tokens - 1, now);
    return true;
  }

  private async push(signer: VapidSigner, deviceId: string, target: PushTarget, payload: string): Promise<SendResult> {
    const { result, status, detail } = await sendPush(signer, target, payload, { ttl: 3600, urgency: 'high' });
    const who = `${deviceId.slice(0, 6)}…`;
    const why = `${status || 'no response'}${detail ? `: ${detail}` : ''}`;
    if (result === 'gone') console.warn(`[push] ${who} subscription no longer valid (${why}); removing device.`);
    else if (result === 'drop') console.warn(`[push] ${who} message can't be sent (${why}); dropping it.`);
    else if (result === 'error') console.warn(`[push] send failed for ${who} (${why}); will retry.`);
    return result;
  }

  // ---------- scheduling ----------

  /**
   * Points the alarm at the earliest queued reminder, or clears it, writing only when that
   * changes (each setAlarm is a billed row write). `notBefore` keeps a failing tick from
   * re-firing in a tight loop; `force` re-sets an alarm that looks stuck.
   */
  async rearm(notBefore = Date.now(), force = false): Promise<void> {
    notBefore = Math.max(notBefore, this.backoffUntil);
    const next = this.sql.exec<{ t: number | null }>('SELECT MIN(due_at) AS t FROM reminders').one().t;
    const current = await this.ctx.storage.getAlarm();
    if (next === null) {
      if (current !== null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const want = Math.max(next, notBefore);
    if (current === want && !force) return;
    await this.ctx.storage.setAlarm(want);
  }

  /** Called by the per-minute cron. Re-arms a lost or stuck alarm; normally reads one value. */
  async watchdog(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    const now = Date.now();
    if (alarm !== null && alarm >= now - ALARM_OVERDUE_MS) return;
    await this.rearm(now, true); // nothing queued and no alarm: reads one index row, writes nothing
  }

  async alarm(): Promise<void> {
    await this.tick();
  }

  /**
   * Due reminders for one run (at most BATCH_SIZE). Normally just the earliest ones. With a
   * backlog, devices take turns (each one's earliest first, devices that have received pushes
   * before new ones), so one device with thousands of due reminders can't starve the others.
   */
  private selectDue(now: number): DueRow[] {
    const head = this.sql
      .exec<DueRow>(
        `SELECT ${DUE_COLUMNS} FROM reminders r JOIN devices d ON d.device_id = r.device_id
         WHERE r.due_at <= ? ORDER BY r.due_at, r.device_id LIMIT ?`,
        now,
        BATCH_SIZE + 1,
      )
      .toArray();
    if (head.length <= BATCH_SIZE) return head;
    const ranked: Array<{ row: DueRow; rank: number }> = [];
    for (const { device_id } of this.sql.exec<{ device_id: string }>('SELECT device_id FROM devices').toArray()) {
      const rows = this.sql
        .exec<DueRow>(
          `SELECT ${DUE_COLUMNS} FROM reminders r JOIN devices d ON d.device_id = r.device_id
           WHERE r.device_id = ? AND r.due_at <= ? ORDER BY r.due_at LIMIT ?`,
          device_id,
          now,
          BATCH_SIZE,
        )
        .toArray();
      rows.forEach((row, rank) => ranked.push({ row, rank }));
    }
    ranked.sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(b.row.last_ok !== null) - Number(a.row.last_ok !== null) ||
        a.row.due_at - b.row.due_at,
    );
    return ranked.slice(0, BATCH_SIZE).map((x) => x.row);
  }

  /**
   * Removes just-delivered doses from this device's other queued (non-snoozed) reminders: a row
   * left with no doses is deleted, a shrunken one fires at its earliest remaining dose. Call inside
   * a transaction. A row holding a dose is anchored at or before it, so only rows up to the latest
   * delivered dose are read.
   */
  private stripDelivered(deviceId: string, delivered: Array<PushDose & { id: string }>): void {
    const done = new Set(delivered.map((m) => m.id));
    const hi = Math.max(...delivered.map((m) => m.at));
    const rows = this.sql
      .exec<ReminderRow>('SELECT * FROM reminders WHERE device_id = ? AND snoozed = 0 AND at <= ?', deviceId, hi)
      .toArray();
    for (const row of rows) {
      const members = membersOf(row);
      const left = members.filter((m) => !done.has(m.id));
      if (left.length === members.length) continue;
      this.sql.exec('DELETE FROM reminders WHERE device_id = ? AND id = ?', deviceId, row.id);
      const first = left[0];
      if (!first) continue;
      this.sql.exec(
        `INSERT OR REPLACE INTO reminders (device_id, id, med_id, at, doses, snoozed, orig_id, orig_at, due_at, tries)
         VALUES (?, ?, ?, ?, ?, 0, NULL, NULL, ?, 0)`,
        deviceId,
        first.id,
        first.medId,
        first.at,
        left.length >= 2 ? encodeDoses(left) : null,
        first.at,
      );
    }
  }

  /** Sends one device's share of a run, in order, stopping if the subscription is gone. Returns attempts. */
  private async sendForDevice(signer: VapidSigner, rows: DueRow[], now: number): Promise<number> {
    const d = rows[0];
    const deviceId = d.device_id;
    const today = Math.floor(now / DAY_MS);
    const used = d.day === today ? d.day_sends : 0;
    const cap = d.last_ok !== null ? DAILY_PUSHES : DAILY_PUSHES_UNPROVEN;
    if (used >= cap) {
      // Bounds what one device (e.g. a fake one with thousands of reminders) can cost per day.
      console.warn(`[push] ${deviceId.slice(0, 6)}… reached its daily limit of ${cap} pushes; dropping its due reminders.`);
      this.sql.exec('DELETE FROM reminders WHERE device_id = ? AND due_at <= ?', deviceId, now);
      return 0;
    }
    let attempts = 0;
    let lastOk: number | null = null;
    for (const r of rows) {
      if (used + attempts >= cap) break; // the rest stay due; the next run drops them
      attempts++;
      const target = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
      const result = await this.push(signer, deviceId, target, payloadFor(deviceId, r));
      // The device may have re-subscribed or unsubscribed while we awaited the push service.
      const sameDevice = this.deviceRev(deviceId) === r.rev;
      if (result === 'ok') {
        lastOk = Date.now();
        this.ctx.storage.transactionSync(() => {
          this.sql.exec('DELETE FROM reminders WHERE device_id = ? AND id = ?', deviceId, r.id);
          if (!sameDevice) return;
          const delivered = membersOf(r);
          for (const m of delivered) {
            this.sql.exec('INSERT OR REPLACE INTO sent (device_id, id, at) VALUES (?, ?, ?)', deviceId, m.id, lastOk);
          }
          // A sync that ran while the push was in flight couldn't see these doses as sent yet, so it
          // may have re-queued them in a regrouped row (e.g. the group's later dose on its own).
          this.stripDelivered(deviceId, delivered);
        });
      } else if (result === 'gone') {
        if (sameDevice) this.dropDevice(deviceId);
        return attempts; // skip the device's other reminders
      } else if (result === 'drop') {
        this.sql.exec('DELETE FROM reminders WHERE device_id = ? AND id = ?', deviceId, r.id);
      } else if (sameDevice) {
        // Kept and retried with backoff until it goes stale (server/index.ts retried every 20 s).
        this.sql.exec(
          'UPDATE reminders SET due_at = ?, tries = tries + 1 WHERE device_id = ? AND id = ? AND due_at <= ?',
          Date.now() + retryDelay(r.tries),
          deviceId,
          r.id,
          now,
        );
      }
    }
    this.sql.exec(
      'UPDATE devices SET day = ?, day_sends = ?, last_ok = COALESCE(?, last_ok) WHERE device_id = ? AND rev = ?',
      today,
      used + attempts,
      lastOk,
      deviceId,
      d.rev,
    );
    return attempts;
  }

  /** Sends up to BATCH_SIZE due reminders, then re-arms for the rest. Returns how many were attempted. */
  async tick(): Promise<number> {
    // A tick already in flight re-arms when it ends.
    if (this.ticking) return 0;
    this.ticking = true;
    let attempted = 0;
    let backoff = 0;
    try {
      const now = Date.now();
      this.sql.exec('DELETE FROM sent WHERE at < ?', now - SENT_TTL_MS);
      // Stale reminders are dropped, not sent (due_at >= at, so this range stays on the index).
      this.sql.exec('DELETE FROM reminders WHERE due_at <= ? AND at < ?', now, now - STALE_MS);
      const v = await this.vapid();
      if (!v.ok) {
        // Misconfigured (logged once): send nothing, drop nothing, check again later.
        backoff = BACKOFF_MS;
        return 0;
      }
      const due = this.selectDue(now);
      const byDevice = new Map<string, DueRow[]>();
      for (const r of due) {
        const list = byDevice.get(r.device_id);
        if (list) list.push(r);
        else byDevice.set(r.device_id, [r]);
      }
      // Devices in parallel (bounded), each device's own reminders in order.
      await runPool([...byDevice.values()], PUSH_CONCURRENCY, async (rows) => {
        try {
          attempted += await this.sendForDevice(v.signer, rows, now);
        } catch (err) {
          console.error('[push] send error:', err);
          backoff = BACKOFF_MS;
        }
      });
      // Due rows without a device can't be sent (shouldn't exist: devices are dropped with their rows).
      if (due.length < BATCH_SIZE) {
        this.sql.exec('DELETE FROM reminders WHERE due_at <= ? AND device_id NOT IN (SELECT device_id FROM devices)', now);
      }
    } catch (err) {
      console.error('[push] scheduler error:', err);
      backoff = BACKOFF_MS;
    } finally {
      this.ticking = false;
      this.backoffUntil = backoff ? Date.now() + backoff : 0;
      try {
        // Leftovers from a full batch are due now, so the alarm fires again right away.
        await this.rearm();
      } catch (err) {
        console.error('[push] could not re-arm alarm:', err);
      }
    }
    return attempted;
  }
}
