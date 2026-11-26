// The reminder store and scheduler: one SQLite-backed Durable Object holds every device's push
// subscription and reminder queue, and its alarm fires at the next due reminder.
import { DurableObject } from 'cloudflare:workers';
import type { PushReminder } from '../../shared/types';
import {
  HttpError,
  MAX_DISMISSED,
  MAX_REMINDERS,
  asObject,
  bad,
  parseDeviceId,
  parseOriginList,
  parseReminder,
  parseSubscription,
  readJson,
} from './validate';
import { MAX_PLAINTEXT, VapidSigner, normaliseSubject, sendPush, type PushTarget, type SendResult } from './webpush';

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
/** A failed send (push service 5xx/429/network) is retried after this, like the old 20 s tick. */
export const RETRY_MS = 20_000;
/** "Recently sent" ids are remembered for an hour so a late client sync can't re-queue them. */
export const SENT_TTL_MS = 3_600_000;
export const TEST_COOLDOWN_MS = 5_000;
/**
 * Pushes per alarm run. Each is one subrequest (the free plan allows 50 per invocation) and
 * roughly 0.3-0.5 ms of CPU for the ECDH + HKDF + AES-GCM work (VAPID tokens are cached), so 10
 * keeps a run well inside the 10 ms CPU budget. Leftovers re-arm the alarm immediately.
 */
export const BATCH_SIZE = 10;
/** Bounds storage for this single-user deployment; new devices beyond it get 503. */
export const MAX_DEVICES = 200;
/** The cron watchdog re-arms an alarm that is missing or this overdue. */
export const ALARM_OVERDUE_MS = 2 * 60_000;

interface ReminderRow {
  device_id: string;
  id: string;
  med_id: string;
  at: number;
  title: string;
  body: string;
  snoozed: number;
  orig_id: string | null;
  orig_at: number | null;
  [key: string]: SqlStorageValue;
}

interface DueRow extends ReminderRow {
  endpoint: string;
  p256dh: string;
  auth: string;
  rev: number;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json; charset=utf-8' } });

export function payloadFor(deviceId: string, r: ReminderRow): string {
  const origId = r.orig_id ?? r.id;
  const origAt = r.orig_at ?? r.at;
  const build = (title: string, body: string) => {
    const reminder: PushReminder = { id: origId, medId: r.med_id, at: origAt, title, body };
    return JSON.stringify({
      title,
      body,
      tag: origId,
      data: { medId: r.med_id, scheduledFor: new Date(origAt).toISOString(), reminderId: origId, deviceId, reminder },
    });
  };
  const full = build(r.title, r.body);
  // Text is capped at 120 + 300 characters, which fits unless it is mostly escaped control
  // characters or 4-byte symbols. Shorten rather than never deliver it.
  if (new TextEncoder().encode(full).length <= MAX_PLAINTEXT) return full;
  return build(r.title.slice(0, 60), r.body.slice(0, 100));
}

export class PushStore extends DurableObject<Env> {
  private sql: SqlStorage;
  private signer: VapidSigner | null = null;
  private ticking = false;
  private lastTest = new Map<string, number>();
  private extraOrigins: Set<string>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.extraOrigins = parseOriginList(env.EXTRA_PUSH_ORIGINS);
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS devices (
        device_id TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        expiration REAL,
        rev INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS reminders (
        device_id TEXT NOT NULL,
        id TEXT NOT NULL,
        med_id TEXT NOT NULL,
        at INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        snoozed INTEGER NOT NULL DEFAULT 0,
        orig_id TEXT,
        orig_at INTEGER,
        due_at INTEGER NOT NULL,
        PRIMARY KEY (device_id, id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS reminders_due ON reminders (due_at);
      CREATE TABLE IF NOT EXISTS sent (
        device_id TEXT NOT NULL,
        id TEXT NOT NULL,
        at INTEGER NOT NULL,
        PRIMARY KEY (device_id, id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS sent_at ON sent (at);
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
      return json({ ok: true, devices, time: new Date().toISOString() });
    }
    if (method === 'GET' && path === '/api/push/public-key') {
      return json({ publicKey: this.vapidSigner().config.publicKey });
    }
    if (method === 'POST') {
      switch (path) {
        case '/api/push/subscribe':
          return json(this.subscribe(await readJson(request)));
        case '/api/push/unsubscribe':
          return json(this.unsubscribe(await readJson(request)));
        case '/api/push/reminders':
          return json(await this.setReminders(await readJson(request)));
        case '/api/push/snooze':
          return json(await this.snooze(await readJson(request)));
        case '/api/push/test':
          return json(await this.test(await readJson(request)));
      }
    }
    return json({ error: 'not found' }, 404);
  }

  private vapidSigner(): VapidSigner {
    if (!this.signer) {
      const publicKey = this.env.VAPID_PUBLIC_KEY?.trim();
      const privateKey = this.env.VAPID_PRIVATE_KEY?.trim();
      if (!publicKey || !privateKey) throw new HttpError(503, 'push not configured');
      this.signer = new VapidSigner({ publicKey, privateKey, subject: normaliseSubject(this.env.VAPID_SUBJECT) });
    }
    return this.signer;
  }

  private deviceRev(deviceId: string): number | null {
    const row = this.sql.exec<{ rev: number }>('SELECT rev FROM devices WHERE device_id = ?', deviceId).toArray()[0];
    return row ? row.rev : null;
  }

  private requireDevice(deviceId: string): number {
    const rev = this.deviceRev(deviceId);
    if (rev === null) throw new HttpError(404, 'device not subscribed');
    return rev;
  }

  private dropDevice(deviceId: string): void {
    this.ctx.storage.transactionSync(() => {
      this.sql.exec('DELETE FROM devices WHERE device_id = ?', deviceId);
      this.sql.exec('DELETE FROM reminders WHERE device_id = ?', deviceId);
      this.sql.exec('DELETE FROM sent WHERE device_id = ?', deviceId);
    });
  }

  subscribe(raw: unknown) {
    const body = asObject(raw);
    const deviceId = parseDeviceId(body.deviceId);
    const sub = parseSubscription(body.subscription, this.extraOrigins);
    const rev = this.deviceRev(deviceId);
    if (rev === null) {
      const n = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM devices').one().n;
      if (n >= MAX_DEVICES) throw new HttpError(503, 'server full');
    }
    // Existing reminders are kept (same as server/index.ts); `rev` changes so an in-flight send
    // to the old subscription can't remove the new one.
    this.sql.exec(
      `INSERT INTO devices (device_id, endpoint, p256dh, auth, expiration, rev, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (device_id) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh,
         auth = excluded.auth, expiration = excluded.expiration, rev = excluded.rev, updated_at = excluded.updated_at`,
      deviceId,
      sub.endpoint,
      sub.keys.p256dh,
      sub.keys.auth,
      sub.expirationTime,
      (rev ?? 0) + 1,
      Date.now(),
    );
    return { ok: true };
  }

  unsubscribe(raw: unknown) {
    const deviceId = parseDeviceId(asObject(raw).deviceId);
    this.dropDevice(deviceId);
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
    this.requireDevice(deviceId);
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
          'SELECT device_id, id, med_id, at, title, body, snoozed, orig_id, orig_at FROM reminders WHERE device_id = ?',
          deviceId,
        )
        .toArray()
        .map((r) => [r.id, r]),
    );

    const seen = new Set<string>();
    const next: ReminderRow[] = [];
    for (const r of parsed) {
      if (r.at <= now || seen.has(r.id) || sent.has(r.id)) continue;
      seen.add(r.id);
      next.push({
        device_id: deviceId,
        id: r.id,
        med_id: r.medId,
        at: r.at,
        title: r.title,
        body: r.body,
        snoozed: 0,
        orig_id: null,
        orig_at: null,
      });
    }
    // Snoozed copies are server-side only. Keep them unless the dose was handled in the app,
    // or the medication no longer has reminders (deleted, or notifications turned off).
    const activeMeds = new Set(next.map((r) => r.med_id));
    for (const s of existing.values()) {
      const keep =
        s.snoozed && s.at > now && activeMeds.has(s.med_id) && !dismissed.has(s.orig_id ?? '') && !seen.has(s.id);
      if (keep) next.push(s);
    }
    next.sort((a, b) => a.at - b.at);
    const final = next.slice(0, MAX_REMINDERS);

    // Write only the difference: a typical sync changes a handful of rows, not all of them.
    const keepIds = new Set(final.map((r) => r.id));
    this.ctx.storage.transactionSync(() => {
      for (const id of existing.keys()) {
        if (!keepIds.has(id)) this.sql.exec('DELETE FROM reminders WHERE device_id = ? AND id = ?', deviceId, id);
      }
      for (const r of final) {
        const old = existing.get(r.id);
        const same =
          old &&
          old.med_id === r.med_id &&
          old.at === r.at &&
          old.title === r.title &&
          old.body === r.body &&
          old.snoozed === r.snoozed &&
          old.orig_id === r.orig_id &&
          old.orig_at === r.orig_at;
        if (same) continue; // keeps its due_at (e.g. a pending retry)
        this.sql.exec(
          `INSERT OR REPLACE INTO reminders (device_id, id, med_id, at, title, body, snoozed, orig_id, orig_at, due_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          deviceId,
          r.id,
          r.med_id,
          r.at,
          r.title,
          r.body,
          r.snoozed,
          r.orig_id,
          r.orig_at,
          r.at,
        );
      }
      this.sql.exec('UPDATE devices SET updated_at = ? WHERE device_id = ?', now, deviceId);
    });
    await this.rearm();
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
      // One pending snooze per original reminder.
      this.sql.exec('DELETE FROM reminders WHERE device_id = ? AND snoozed = 1 AND orig_id = ?', deviceId, reminder.id);
      const n = this.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM reminders WHERE device_id = ?', deviceId).one().n;
      if (n >= MAX_REMINDERS) bad('too many reminders');
      this.sql.exec(
        `INSERT OR REPLACE INTO reminders (device_id, id, med_id, at, title, body, snoozed, orig_id, orig_at, due_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        deviceId,
        `${reminder.medId.slice(0, 40)}~snooze@${at}`,
        reminder.medId,
        at,
        reminder.title,
        reminder.body,
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
    const rev = this.requireDevice(deviceId);
    const now = Date.now();
    for (const [dev, t] of this.lastTest) if (now - t > TEST_COOLDOWN_MS) this.lastTest.delete(dev);
    if (now - (this.lastTest.get(deviceId) ?? 0) < TEST_COOLDOWN_MS) throw new HttpError(429, 'slow down');
    this.lastTest.set(deviceId, now);
    const target = this.target(deviceId)!;
    const result = await this.push(
      deviceId,
      target,
      JSON.stringify({
        title: 'Dosely test',
        body: 'Notifications are working on this device.',
        tag: 'medtracker-test',
        data: { test: true, deviceId },
      }),
    );
    if (result === 'gone') {
      if (this.deviceRev(deviceId) === rev) this.dropDevice(deviceId);
      throw new HttpError(410, 'subscription expired');
    }
    if (result === 'error') throw new HttpError(502, 'push service rejected the message');
    return { ok: true };
  }

  private target(deviceId: string): PushTarget | null {
    const d = this.sql
      .exec<{ endpoint: string; p256dh: string; auth: string }>(
        'SELECT endpoint, p256dh, auth FROM devices WHERE device_id = ?',
        deviceId,
      )
      .toArray()[0];
    return d ? { endpoint: d.endpoint, keys: { p256dh: d.p256dh, auth: d.auth } } : null;
  }

  private async push(deviceId: string, target: PushTarget, payload: string): Promise<SendResult> {
    const { result, status } = await sendPush(this.vapidSigner(), target, payload, { ttl: 3600, urgency: 'high' });
    if (result === 'gone') {
      console.warn(`[push] ${deviceId.slice(0, 6)}… subscription no longer valid (${status}); removing device.`);
    } else if (result === 'error') {
      console.warn(`[push] send failed for ${deviceId.slice(0, 6)}… (${status || 'network'})`);
    }
    return result;
  }

  // ---------- scheduling ----------

  /**
   * Points the alarm at the earliest queued reminder, or clears it. Cheap: MIN over an index
   * reads one row. `notBefore` keeps a failing tick from re-firing in a tight loop.
   */
  async rearm(notBefore = Date.now()): Promise<void> {
    const next = this.sql.exec<{ t: number | null }>('SELECT MIN(due_at) AS t FROM reminders').one().t;
    if (next === null) await this.ctx.storage.deleteAlarm();
    else await this.ctx.storage.setAlarm(Math.max(next, notBefore));
  }

  /** Called by the per-minute cron. Re-arms a lost or stuck alarm; normally reads one value. */
  async watchdog(): Promise<void> {
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm < Date.now() - ALARM_OVERDUE_MS) await this.rearm();
  }

  async alarm(): Promise<void> {
    await this.tick();
  }

  /** Sends up to BATCH_SIZE due reminders, then re-arms for the rest. Returns how many were attempted. */
  async tick(): Promise<number> {
    // A tick already in flight (e.g. an alarm while /test awaits) re-arms when it ends.
    if (this.ticking) return 0;
    this.ticking = true;
    let attempted = 0;
    let healthy = true;
    try {
      const now = Date.now();
      this.sql.exec('DELETE FROM sent WHERE at < ?', now - SENT_TTL_MS);
      // Stale reminders are dropped, not sent (due_at >= at, so this range stays on the index).
      this.sql.exec('DELETE FROM reminders WHERE due_at <= ? AND at < ?', now, now - STALE_MS);
      try {
        this.vapidSigner();
      } catch {
        console.error('[push] VAPID keys are not configured; reminders are not being sent.');
        healthy = false;
        return 0;
      }
      const due = this.sql
        .exec<DueRow>(
          `SELECT r.device_id, r.id, r.med_id, r.at, r.title, r.body, r.snoozed, r.orig_id, r.orig_at,
                  d.endpoint, d.p256dh, d.auth, d.rev
           FROM reminders r JOIN devices d ON d.device_id = r.device_id
           WHERE r.due_at <= ? ORDER BY r.due_at, r.device_id LIMIT ?`,
          now,
          BATCH_SIZE,
        )
        .toArray();
      const gone = new Set<string>();
      for (const r of due) {
        if (gone.has(r.device_id)) continue;
        attempted++;
        const target = { endpoint: r.endpoint, keys: { p256dh: r.p256dh, auth: r.auth } };
        const result = await this.push(r.device_id, target, payloadFor(r.device_id, r));
        // The device may have re-subscribed or unsubscribed while we awaited the push service.
        const sameDevice = this.deviceRev(r.device_id) === r.rev;
        if (result === 'ok') {
          this.ctx.storage.transactionSync(() => {
            this.sql.exec('DELETE FROM reminders WHERE device_id = ? AND id = ?', r.device_id, r.id);
            if (sameDevice) {
              this.sql.exec(
                'INSERT OR REPLACE INTO sent (device_id, id, at) VALUES (?, ?, ?)',
                r.device_id,
                r.orig_id ?? r.id,
                Date.now(),
              );
            }
          });
        } else if (result === 'gone') {
          gone.add(r.device_id);
          if (sameDevice) this.dropDevice(r.device_id);
        } else if (sameDevice) {
          // Kept and retried shortly, until it goes stale (server/index.ts retried every 20 s tick).
          this.sql.exec(
            'UPDATE reminders SET due_at = ? WHERE device_id = ? AND id = ? AND due_at <= ?',
            Date.now() + RETRY_MS,
            r.device_id,
            r.id,
            now,
          );
        }
      }
      // Due rows without a device can't be sent (shouldn't exist: devices are dropped with their rows).
      if (due.length < BATCH_SIZE) {
        this.sql.exec('DELETE FROM reminders WHERE due_at <= ? AND device_id NOT IN (SELECT device_id FROM devices)', now);
      }
    } catch (err) {
      console.error('[push] scheduler error:', err);
      healthy = false;
    } finally {
      this.ticking = false;
      try {
        // Leftovers from a full batch are due now, so the alarm fires again right away.
        await this.rearm(healthy ? Date.now() : Date.now() + 60_000);
      } catch (err) {
        console.error('[push] could not re-arm alarm:', err);
      }
    }
    return attempted;
  }
}
