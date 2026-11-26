import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker, { storeStub } from '../src/index';
import { BATCH_SIZE, RETRY_MS, STALE_MS, type PushStore } from '../src/store';
import { b64urlDecode, b64urlEncode } from '../src/webpush';

const ORIGIN = 'https://undeadcommander.github.io';
const BASE = 'https://dosely-push.example.workers.dev/api';
// In the future: workerd clamps alarms set in the (real) past to now, and real alarm timers never fire mid-test.
const T0 = Date.parse('2027-03-01T08:00:00Z');

// ---------- helpers ----------

interface Subscriber {
  endpoint: string;
  priv: CryptoKey;
  pub: Uint8Array<ArrayBuffer>;
  auth: Uint8Array<ArrayBuffer>;
  json: { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
}

async function makeSubscriber(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`): Promise<Subscriber> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair;
  const pub = new Uint8Array((await crypto.subtle.exportKey('raw', pair.publicKey)) as ArrayBuffer);
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    endpoint,
    priv: pair.privateKey,
    pub,
    auth,
    json: { endpoint, expirationTime: null, keys: { p256dh: b64urlEncode(pub), auth: b64urlEncode(auth) } },
  };
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: string | Uint8Array<ArrayBuffer>, n: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const i = typeof info === 'string' ? new Uint8Array(new TextEncoder().encode(info)) : info;
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: i }, key, n * 8));
}

/** Subscriber-side aes128gcm decryption (the Node tests cross-check against http_ece). */
async function decryptPush(body: Uint8Array<ArrayBuffer>, sub: Subscriber): Promise<unknown> {
  const salt = body.slice(0, 16);
  const idlen = body[20];
  const keyid = body.slice(21, 21 + idlen);
  const ct = body.slice(21 + idlen);
  const asKey = await crypto.subtle.importKey('raw', keyid, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const secret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm, sub.priv, 256),
  );
  const info = new Uint8Array([...new TextEncoder().encode('WebPush: info\0'), ...sub.pub, ...keyid]);
  const ikm = await hkdf(sub.auth, secret, info, 32);
  const cek = await hkdf(salt, ikm, 'Content-Encoding: aes128gcm\0', 16);
  const nonce = await hkdf(salt, ikm, 'Content-Encoding: nonce\0', 12);
  const key = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const pt = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ct));
  let end = pt.length - 1;
  while (end >= 0 && pt[end] === 0) end--;
  expect(pt[end]).toBe(2); // last-record delimiter
  return JSON.parse(new TextDecoder().decode(pt.slice(0, end)));
}

interface Sent {
  url: string;
  headers: Headers;
  body: Uint8Array<ArrayBuffer>;
}

let sent: Sent[] = [];
let pushStatus: (req: Request) => number = () => 201;

function api(path: string, body?: unknown, init: RequestInit & { origin?: string | null } = {}) {
  const headers = new Headers(init.headers);
  if (init.origin !== null) headers.set('Origin', init.origin ?? ORIGIN);
  if (body !== undefined && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
  return SELF.fetch(`${BASE}/${path}`, {
    method: init.method ?? (body === undefined ? 'GET' : 'POST'),
    headers,
    body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
  });
}

async function apiJson(path: string, body?: unknown) {
  const res = await api(path, body);
  return { status: res.status, data: (await res.json()) as Record<string, unknown> };
}

const stub = () => storeStub(env);
const deviceId = () => `dev_${crypto.randomUUID().replace(/-/g, '')}`;

function reminder(medId: string, at: number, title = 'Take Aspirin', body = '100 mg') {
  return { id: `${medId}@${at}`, medId, at, title, body };
}

async function subscribe(id: string, sub: Subscriber) {
  const r = await apiJson('push/subscribe', { deviceId: id, subscription: sub.json });
  expect(r).toEqual({ status: 200, data: { ok: true } });
}

/** Moves the clock (Date only: Miniflare's real alarm timer never fires on its own here). */
function setNow(t: number) {
  vi.setSystemTime(t);
}

async function fireAlarm(): Promise<boolean> {
  return runDurableObjectAlarm(stub());
}

async function alarmTime(): Promise<number | null> {
  return runInDurableObject(stub(), (_i, state) => state.storage.getAlarm());
}

async function queued(id: string): Promise<Array<{ id: string; at: number; due_at: number; snoozed: number; orig_id: string | null }>> {
  return runInDurableObject(stub(), (_i: PushStore, state) =>
    state.storage.sql
      .exec<{ id: string; at: number; due_at: number; snoozed: number; orig_id: string | null }>(
        'SELECT id, at, due_at, snoozed, orig_id FROM reminders WHERE device_id = ? ORDER BY at',
        id,
      )
      .toArray(),
  );
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  setNow(T0);
  sent = [];
  pushStatus = () => 201;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = new Request(input as RequestInfo, init);
    sent.push({ url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
    return new Response(null, { status: pushStatus(req) });
  });
  await runInDurableObject(stub(), async (_i, state) => {
    state.storage.sql.exec('DELETE FROM devices; DELETE FROM reminders; DELETE FROM sent;');
    await state.storage.deleteAlarm();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------- tests ----------

describe('HTTP API', () => {
  it('serves health and the VAPID public key', async () => {
    const h = await apiJson('health');
    expect(h.status).toBe(200);
    expect(h.data).toMatchObject({ ok: true, devices: 0 });
    const k = await apiJson('push/public-key');
    expect(k).toEqual({ status: 200, data: { publicKey: env.VAPID_PUBLIC_KEY } });
  });

  it('sets CORS headers only for allowed origins, and security headers always', async () => {
    const ok = await api('health');
    expect(ok.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN);
    expect(ok.headers.get('Vary')).toBe('Origin');
    expect(ok.headers.get('Cache-Control')).toBe('no-store');
    expect(ok.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(ok.headers.get('Referrer-Policy')).toBe('no-referrer');
    const local = await api('health', undefined, { origin: 'http://localhost:5173' });
    expect(local.headers.get('Access-Control-Allow-Origin')).toBe('http://localhost:5173');
    const evil = await api('health', undefined, { origin: 'https://evil.example' });
    expect(evil.headers.get('Access-Control-Allow-Origin')).toBeNull();

    const pre = await api('push/subscribe', undefined, {
      method: 'OPTIONS',
      headers: { 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('Access-Control-Allow-Methods')).toBe('GET, POST, OPTIONS');
    expect(pre.headers.get('Access-Control-Allow-Headers')).toBe('Content-Type');
    const preBad = await api('push/subscribe', undefined, { method: 'OPTIONS', origin: 'https://evil.example' });
    expect(preBad.status).toBe(403);
  });

  it('returns JSON 404s for unknown routes and wrong methods', async () => {
    for (const [path, method] of [
      ['nope', 'GET'],
      ['push/subscribe', 'GET'],
      ['health', 'POST'],
    ] as const) {
      const res = await api(path, method === 'POST' ? {} : undefined, { method });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: 'not found' });
    }
    const outside = await SELF.fetch('https://dosely-push.example.workers.dev/');
    expect(outside.status).toBe(404);
  });

  it('validates bodies like server/index.ts', async () => {
    expect((await apiJson('push/subscribe', { deviceId: 'short' })).data).toEqual({ error: 'invalid deviceId' });
    const notJson = await api('push/subscribe', 'deviceId=x', { headers: { 'Content-Type': 'text/plain' } });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: 'body must be an object' });
    const broken = await api('push/subscribe', '{"deviceId":', {});
    expect(broken.status).toBe(400);
    expect(await broken.json()).toEqual({ error: 'bad request' });
    const big = await api('push/reminders', JSON.stringify({ pad: 'x'.repeat(2 * 1024 * 1024) }));
    expect(big.status).toBe(413);
    expect(await big.json()).toEqual({ error: 'payload too large' });
    const id = deviceId();
    expect((await apiJson('push/reminders', { deviceId: id, reminders: [] })).status).toBe(404);
    // Unknown device wins over a bad item, so the client re-subscribes (same order as server/index.ts).
    expect((await apiJson('push/reminders', { deviceId: id, reminders: [{ id: 'x' }] })).status).toBe(404);
    expect((await apiJson('push/reminders', { deviceId: id, reminders: 'x' })).data).toEqual({
      error: 'reminders must be an array',
    });
    expect((await apiJson('push/reminders', { deviceId: id, reminders: new Array(3001).fill(0) })).data).toEqual({
      error: 'at most 3000 reminders',
    });
    const sub = await makeSubscriber();
    await subscribe(id, sub);
    expect(
      (await apiJson('push/reminders', { deviceId: id, reminders: [{ ...reminder('m1', T0 + 1000), title: ' ' }] })).data,
    ).toEqual({ error: 'invalid reminder title' });
    expect(
      (await apiJson('push/snooze', { deviceId: id, reminder: reminder('m1', T0), minutes: 121 })).data,
    ).toEqual({ error: 'minutes must be between 1 and 120' });
  });

  it('accepts only known push services as subscription endpoints', async () => {
    const id = deviceId();
    const ok = [
      'https://web.push.apple.com/QGuQ',
      'https://fcm.googleapis.com/fcm/send/abc:def',
      'https://updates.push.services.mozilla.com/wpush/v2/gAAA',
      'https://wns2-par02p.notify.windows.com/w/?token=BQYAAA',
    ];
    for (const endpoint of ok) {
      const sub = await makeSubscriber(endpoint);
      expect((await apiJson('push/subscribe', { deviceId: id, subscription: sub.json })).status).toBe(200);
    }
    const badEndpoints: Array<[string, string]> = [
      ['http://fcm.googleapis.com/fcm/send/x', 'subscription endpoint must be https'],
      ['https://evil.example/push', 'unsupported push service'],
      ['https://fcm.googleapis.com.evil.example/x', 'unsupported push service'],
      ['https://169.254.169.254/latest', 'unsupported push service'],
      ['https://fcm.googleapis.com:8443/x', 'unsupported push service'],
      ['https://user:pw@web.push.apple.com/x', 'unsupported push service'],
      ['not a url', 'invalid subscription endpoint'],
      [`https://fcm.googleapis.com/${'x'.repeat(2048)}`, 'invalid subscription endpoint'],
    ];
    for (const [endpoint, error] of badEndpoints) {
      const sub = await makeSubscriber();
      const r = await apiJson('push/subscribe', { deviceId: id, subscription: { ...sub.json, endpoint } });
      expect(r, endpoint).toEqual({ status: 400, data: { error } });
    }
  });
});

describe('scheduling and delivery', () => {
  it('subscribe → reminders → alarm → encrypted push with VAPID headers', async () => {
    const id = deviceId();
    const sub = await makeSubscriber();
    await subscribe(id, sub);
    const at = T0 + 30 * 60_000;
    const r = reminder('med1', at, 'Take Aspirin', '100 mg tablet');
    const post = await apiJson('push/reminders', { deviceId: id, reminders: [r, r, reminder('med1', T0 - 1)], dismissed: [] });
    expect(post).toEqual({ status: 200, data: { ok: true, count: 1 } }); // duplicate and past ones dropped
    expect(await alarmTime()).toBe(at);

    setNow(at + 2_000);
    expect(await fireAlarm()).toBe(true);
    expect(sent).toHaveLength(1);
    const [msg] = sent;
    expect(msg.url).toBe(sub.endpoint);
    expect(msg.headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(msg.headers.get('TTL')).toBe('3600');
    expect(msg.headers.get('Urgency')).toBe('high');
    expect(msg.headers.get('Authorization')).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${env.VAPID_PUBLIC_KEY}$`));
    const claims = JSON.parse(
      new TextDecoder().decode(b64urlDecode(msg.headers.get('Authorization')!.split('.')[1])),
    ) as Record<string, unknown>;
    expect(claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'mailto:test@example.org' });

    // The payload public/sw.js expects (same as server/index.ts payloadFor).
    expect(await decryptPush(msg.body, sub)).toEqual({
      title: 'Take Aspirin',
      body: '100 mg tablet',
      tag: r.id,
      data: { medId: 'med1', scheduledFor: new Date(at).toISOString(), reminderId: r.id, deviceId: id, reminder: r },
    });
    expect(await queued(id)).toEqual([]);
    expect(await alarmTime()).toBeNull();

    // A late sync from the client can't re-queue a reminder that was just delivered.
    setNow(at - 60_000); // client clock slightly behind
    const again = await apiJson('push/reminders', { deviceId: id, reminders: [r] });
    expect(again.data).toEqual({ ok: true, count: 0 });
  });

  it('drops reminders more than 15 minutes late without sending them', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const at = T0 + 60_000;
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('m', at), reminder('m', at + STALE_MS + 10 * 60_000)] });
    setNow(at + STALE_MS + 1);
    await fireAlarm();
    expect(sent).toHaveLength(0);
    expect((await queued(id)).map((r) => r.at)).toEqual([at + STALE_MS + 10 * 60_000]);
  });

  it('replaces the queue on each sync, writing only changed rows', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const a = reminder('m', T0 + 60_000);
    const b = reminder('m', T0 + 120_000);
    const c = reminder('m', T0 + 180_000);
    await apiJson('push/reminders', { deviceId: id, reminders: [a, b] });
    const res = await apiJson('push/reminders', { deviceId: id, reminders: [b, { ...c, title: 'Changed' }] });
    expect(res.data).toEqual({ ok: true, count: 2 });
    expect((await queued(id)).map((r) => r.id)).toEqual([b.id, c.id]);
    expect(await alarmTime()).toBe(b.at);
    const empty = await apiJson('push/reminders', { deviceId: id, reminders: [] });
    expect(empty.data).toEqual({ ok: true, count: 0 });
    expect(await alarmTime()).toBeNull();
  });

  it('snooze: fires later with the original identity; one pending snooze per reminder', async () => {
    const id = deviceId();
    const sub = await makeSubscriber();
    await subscribe(id, sub);
    const orig = reminder('med1', T0 - 60_000); // the notification that was just shown
    const s1 = await apiJson('push/snooze', { deviceId: id, reminder: orig, minutes: 10 });
    expect(s1).toEqual({ status: 200, data: { ok: true, at: T0 + 10 * 60_000 } });
    setNow(T0 + 1000);
    const s2 = await apiJson('push/snooze', { deviceId: id, reminder: orig, minutes: 10 });
    expect(s2.data.at).toBe(T0 + 1000 + 10 * 60_000);
    const q = await queued(id);
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ id: `med1~snooze@${T0 + 1000 + 10 * 60_000}`, snoozed: 1, orig_id: orig.id });

    setNow(T0 + 1000 + 10 * 60_000);
    await fireAlarm();
    expect(sent).toHaveLength(1);
    const payload = (await decryptPush(sent[0].body, sub)) as { tag: string; data: Record<string, unknown> };
    expect(payload.tag).toBe(orig.id);
    expect(payload.data).toMatchObject({ reminderId: orig.id, scheduledFor: new Date(orig.at).toISOString(), reminder: orig });
    expect((await apiJson('push/snooze', { deviceId: deviceId(), reminder: orig, minutes: 10 })).status).toBe(404);
  });

  it('a sync keeps a pending snooze, unless the dose was handled (dismissed) or the med has no reminders', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const orig = reminder('med1', T0 - 60_000);
    const future = reminder('med1', T0 + 6 * 3600_000);
    await apiJson('push/snooze', { deviceId: id, reminder: orig, minutes: 10 });

    await apiJson('push/reminders', { deviceId: id, reminders: [future], dismissed: [] });
    expect((await queued(id)).filter((r) => r.snoozed)).toHaveLength(1);

    await apiJson('push/reminders', { deviceId: id, reminders: [future], dismissed: [orig.id] });
    expect((await queued(id)).filter((r) => r.snoozed)).toHaveLength(0);

    await apiJson('push/snooze', { deviceId: id, reminder: orig, minutes: 10 });
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('other', T0 + 3600_000)] });
    expect((await queued(id)).filter((r) => r.snoozed)).toHaveLength(0); // med1 no longer has reminders
  });

  it('a 410 from the push service removes the device', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('m', T0 + 1000), reminder('m', T0 + 2000)] });
    pushStatus = () => 410;
    setNow(T0 + 5000);
    await fireAlarm();
    expect(sent).toHaveLength(1); // the second one isn't tried
    expect((await apiJson('health')).data.devices).toBe(0);
    expect(await queued(id)).toEqual([]);
    expect((await apiJson('push/reminders', { deviceId: id, reminders: [] })).status).toBe(404);
    expect(await alarmTime()).toBeNull();
  });

  it('a 5xx keeps the reminder and retries it about 20 s later', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const r = reminder('m', T0 + 1000);
    await apiJson('push/reminders', { deviceId: id, reminders: [r] });
    pushStatus = () => 503;
    setNow(T0 + 1000);
    await fireAlarm();
    expect(sent).toHaveLength(1);
    expect((await queued(id))[0].due_at).toBe(T0 + 1000 + RETRY_MS);
    expect(await alarmTime()).toBe(T0 + 1000 + RETRY_MS);
    pushStatus = () => 201;
    setNow(T0 + 1000 + RETRY_MS);
    await fireAlarm();
    expect(sent).toHaveLength(2);
    expect(await queued(id)).toEqual([]);
  });

  it('a sync drops an overdue reminder waiting for a retry (as server/index.ts does)', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const r = reminder('m', T0 + 1000);
    const later = reminder('m', T0 + 3600_000);
    await apiJson('push/reminders', { deviceId: id, reminders: [r, later] });
    pushStatus = () => 503;
    setNow(T0 + 1000);
    await fireAlarm();
    await apiJson('push/reminders', { deviceId: id, reminders: [r, later] });
    expect((await queued(id)).map((q) => q.id)).toEqual([later.id]);
  });

  it(`sends at most ${BATCH_SIZE} per alarm run and re-arms right away for the rest`, async () => {
    const devices = await Promise.all([0, 1, 2].map(async () => ({ id: deviceId(), sub: await makeSubscriber() })));
    for (const d of devices) {
      await subscribe(d.id, d.sub);
      const list = Array.from({ length: 40 }, (_, i) => reminder(`m${i % 4}`, T0 + 60_000 + i * 1000));
      expect((await apiJson('push/reminders', { deviceId: d.id, reminders: list })).data.count).toBe(40);
    }
    setNow(T0 + 10 * 60_000);
    let runs = 0;
    while (await fireAlarm()) {
      runs++;
      expect(sent.length).toBeLessThanOrEqual(runs * BATCH_SIZE);
      if (runs > 50) throw new Error('alarm never settled');
    }
    expect(runs).toBe(Math.ceil(120 / BATCH_SIZE));
    expect(sent).toHaveLength(120);
    for (const d of devices) {
      expect(sent.filter((s) => s.url === d.sub.endpoint)).toHaveLength(40);
      expect(await queued(d.id)).toEqual([]);
    }
  });

  it('unsubscribe removes the device and its queue', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('m', T0 + 1000)] });
    expect((await apiJson('push/unsubscribe', { deviceId: id })).data).toEqual({ ok: true });
    expect(await queued(id)).toEqual([]);
    expect((await apiJson('health')).data.devices).toBe(0);
  });

  it('re-subscribing keeps the queue and sends to the new endpoint', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('m', T0 + 1000)] });
    const fresh = await makeSubscriber('https://web.push.apple.com/fresh');
    await subscribe(id, fresh);
    setNow(T0 + 1000);
    await fireAlarm();
    expect(sent.map((s) => s.url)).toEqual(['https://web.push.apple.com/fresh']);
    expect(await decryptPush(sent[0].body, fresh)).toMatchObject({ title: 'Take Aspirin' });
  });

  it('the cron watchdog re-arms a lost alarm', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const r = reminder('m', T0 + 5 * 60_000);
    await apiJson('push/reminders', { deviceId: id, reminders: [r] });
    await runInDurableObject(stub(), (_i, state) => state.storage.deleteAlarm());
    expect(await alarmTime()).toBeNull();
    const waitUntil = vi.fn<(p: Promise<unknown>) => void>();
    const ctx = { waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now(), noRetry: () => {} }, env, ctx);
    await Promise.all(waitUntil.mock.calls.map(([p]) => p));
    expect(await alarmTime()).toBe(r.at);
  });
});

describe('/push/test', () => {
  it('sends a test notification, rate-limits, and maps push errors', async () => {
    const id = deviceId();
    const sub = await makeSubscriber();
    await subscribe(id, sub);
    expect(await apiJson('push/test', { deviceId: id })).toEqual({ status: 200, data: { ok: true } });
    expect(await decryptPush(sent[0].body, sub)).toEqual({
      title: 'Dosely test',
      body: 'Notifications are working on this device.',
      tag: 'medtracker-test',
      data: { test: true, deviceId: id },
    });
    expect(await apiJson('push/test', { deviceId: id })).toEqual({ status: 429, data: { error: 'slow down' } });

    setNow(T0 + 6000);
    pushStatus = () => 500;
    expect(await apiJson('push/test', { deviceId: id })).toEqual({
      status: 502,
      data: { error: 'push service rejected the message' },
    });
    setNow(T0 + 12_000);
    pushStatus = () => 404;
    expect(await apiJson('push/test', { deviceId: id })).toEqual({ status: 410, data: { error: 'subscription expired' } });
    expect((await apiJson('health')).data.devices).toBe(0);
    expect((await apiJson('push/test', { deviceId: id })).status).toBe(404);
  });
});
