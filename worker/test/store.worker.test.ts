import { SELF, env, runDurableObjectAlarm, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import worker from '../src/index';
import { storeStub } from '../src/stub';
import {
  BATCH_SIZE,
  DAILY_PUSHES_UNPROVEN,
  HEARTBEAT_MS,
  IP_LIMITS,
  IP_WINDOW_MS,
  MAX_DEVICES,
  PROTECT_MS,
  PUSH_CONCURRENCY,
  RETRY_MS,
  STALE_MS,
  TEST_BUCKET_SIZE,
  TEST_REFILL_MS,
  payloadFor,
  type PushStore,
  type ReminderRow,
} from '../src/store';
import { MAX_PLAINTEXT, b64urlDecode, b64urlEncode } from '../src/webpush';

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

async function apiJson(path: string, body?: unknown, init?: RequestInit & { origin?: string | null }) {
  const res = await api(path, body, init);
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
  await runInDurableObject(stub(), async (instance, state) => {
    state.storage.sql.exec('DELETE FROM devices; DELETE FROM reminders; DELETE FROM sent; DELETE FROM meta;');
    instance.resetRateLimits();
    (instance as unknown as { vapidLoad: unknown }).vapidLoad = null;
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
    expect(Object.keys(h.data).sort()).toEqual(['devices', 'ok', 'push', 'time']);
    expect(h.data).toMatchObject({ ok: true, devices: 0, push: 'ready' });
    expect(typeof h.data.time).toBe('string');
    const k = await apiJson('push/public-key');
    expect(k).toEqual({ status: 200, data: { publicKey: env.VAPID_PUBLIC_KEY } });
  });

  it('reports misconfigured VAPID on health, public-key, push/test, and alarm without dropping devices', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const at = T0 + 60_000;
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('m1', at)] });

    await runInDurableObject(stub(), (instance) => {
      (instance as unknown as { vapidLoad: unknown }).vapidLoad = Promise.resolve({
        ok: false,
        problem: 'VAPID_SUBJECT must be a mailto: address',
      });
    });

    expect(await apiJson('push/public-key')).toEqual({ status: 503, data: { error: 'push not configured' } });
    const h = await apiJson('health');
    expect(h.status).toBe(503);
    expect(h.data).toMatchObject({
      ok: false,
      push: 'misconfigured',
      problem: 'VAPID_SUBJECT must be a mailto: address',
      devices: 1,
    });
    expect(await apiJson('push/test', { deviceId: id })).toEqual({ status: 503, data: { error: 'push not configured' } });

    setNow(at + 1000);
    await fireAlarm();
    expect(sent).toHaveLength(0);
    expect((await apiJson('health')).data.devices).toBe(1);
    expect(await queued(id)).toHaveLength(1);
    expect(await alarmTime()).toBeGreaterThanOrEqual(at + 1000 + 60_000);

    // A request that re-arms while the tick is backing off must not pull the alarm back to now.
    setNow(at + 5000);
    const other = deviceId();
    await subscribe(other, await makeSubscriber());
    await apiJson('push/reminders', { deviceId: other, reminders: [reminder('m2', at + 3_600_000)] });
    expect(await alarmTime()).toBeGreaterThanOrEqual(at + 1000 + 60_000);
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
    // Only the reminder sync gets the 2 MB cap; the other routes take a few KB.
    const smallPad = JSON.stringify({ deviceId: deviceId(), pad: 'x'.repeat(100 * 1024) });
    const bigSubscribe = await api('push/subscribe', smallPad);
    expect(bigSubscribe.status).toBe(413);
    // Without a Content-Length (streamed), the Durable Object enforces the same cap while reading.
    const streamed = await runInDurableObject(stub(), (instance: PushStore) =>
      instance.fetch(
        new Request(`${BASE}/push/test`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: new Blob([smallPad]).stream(),
          duplex: 'half',
        } as RequestInit),
      ),
    );
    expect(streamed.status).toBe(413);
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
  it('validates subscription keys, normalises padded/standard base64, and bumps rev only on change', async () => {
    const id = deviceId();
    let sub = await makeSubscriber();
    // Pick a generated P-256 key whose standard base64 representation includes '+' or '/' and '=' padding.
    while (!/[+/]/.test(sub.json.keys.p256dh.replace(/-/g, '+').replace(/_/g, '/'))) {
      sub = await makeSubscriber();
    }
    const toStd = (b64u: string) => {
      const s = b64u.replace(/-/g, '+').replace(/_/g, '/');
      return s + '='.repeat((4 - (s.length % 4)) % 4);
    };

    for (const badKeys of [
      { p256dh: b64urlEncode(new Uint8Array(64)), auth: sub.json.keys.auth },
      { p256dh: sub.json.keys.p256dh, auth: b64urlEncode(new Uint8Array(8)) },
      { p256dh: b64urlEncode(new Uint8Array([4, ...new Array(64).fill(0)])), auth: sub.json.keys.auth },
    ]) {
      const r = await apiJson('push/subscribe', { deviceId: id, subscription: { ...sub.json, keys: badKeys } });
      expect(r).toEqual({ status: 400, data: { error: 'invalid subscription keys' } });
    }

    const stdSub = {
      ...sub.json,
      keys: { p256dh: toStd(sub.json.keys.p256dh), auth: toStd(sub.json.keys.auth) },
    };
    expect(stdSub.keys.p256dh).toMatch(/[+/]/);
    expect(stdSub.keys.p256dh).toMatch(/=$/);
    expect(await apiJson('push/subscribe', { deviceId: id, subscription: stdSub })).toEqual({
      status: 200,
      data: { ok: true },
    });

    const row1 = await runInDurableObject(stub(), (_i, state) =>
      state.storage.sql.exec<{ p256dh: string; auth: string; rev: number }>('SELECT p256dh, auth, rev FROM devices WHERE device_id = ?', id).one(),
    );
    expect(row1).toEqual({ p256dh: sub.json.keys.p256dh, auth: sub.json.keys.auth, rev: 1 });
    expect(row1.p256dh).not.toMatch(/[+/=]/);
    expect(row1.auth).not.toMatch(/[+/=]/);

    // Identical re-subscribe keeps rev unchanged.
    expect(await apiJson('push/subscribe', { deviceId: id, subscription: sub.json })).toEqual({
      status: 200,
      data: { ok: true },
    });
    const revAfterSame = await runInDurableObject(stub(), (_i, state) =>
      state.storage.sql.exec<{ rev: number }>('SELECT rev FROM devices WHERE device_id = ?', id).one().rev,
    );
    expect(revAfterSame).toBe(1);

    // Changed endpoint bumps rev.
    expect(
      await apiJson('push/subscribe', {
        deviceId: id,
        subscription: { ...sub.json, endpoint: `${sub.endpoint}/v2` },
      }),
    ).toEqual({ status: 200, data: { ok: true } });
    const revAfterEndpointChange = await runInDurableObject(stub(), (_i, state) =>
      state.storage.sql.exec<{ rev: number }>('SELECT rev FROM devices WHERE device_id = ?', id).one().rev,
    );
    expect(revAfterEndpointChange).toBe(2);
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

    // The payload public/sw.js expects: always discreet server-generated text.
    const decrypted = await decryptPush(msg.body, sub);
    expect(decrypted).toEqual({
      title: 'Time for your medication',
      body: 'Open Dosely to review your dose.',
      tag: r.id,
      data: {
        medId: 'med1',
        scheduledFor: new Date(at).toISOString(),
        reminderId: r.id,
        deviceId: id,
        reminder: {
          id: r.id,
          medId: 'med1',
          at,
          title: 'Time for your medication',
          body: 'Open Dosely to review your dose.',
        },
      },
    });
    expect(JSON.stringify(decrypted)).not.toContain('Take Aspirin');
    expect(JSON.stringify(decrypted)).not.toContain('100 mg tablet');
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
    const payload = (await decryptPush(sent[0].body, sub)) as { title: string; body: string; tag: string; data: Record<string, unknown> };
    expect(payload.title).toBe('Time for your medication');
    expect(payload.body).toBe('Open Dosely to review your dose.');
    expect(payload.tag).toBe(orig.id);
    expect(payload.data).toEqual({
      medId: 'med1',
      reminderId: orig.id,
      scheduledFor: new Date(orig.at).toISOString(),
      deviceId: id,
      reminder: {
        id: orig.id,
        medId: 'med1',
        at: orig.at,
        title: 'Time for your medication',
        body: 'Open Dosely to review your dose.',
      },
    });
    expect(JSON.stringify(payload)).not.toContain('Take Aspirin');
    expect(JSON.stringify(payload)).not.toContain('100 mg');
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

  it('keeps device on 401/403/301 and backs off retries on repeated 503s (20s, 40s, 80s)', async () => {
    let now = T0;
    for (const status of [401, 403, 301]) {
      const idCase = deviceId();
      await subscribe(idCase, await makeSubscriber());
      const caseAt = now + 2000;
      const sync = await apiJson('push/reminders', { deviceId: idCase, reminders: [reminder('m', caseAt)] });
      expect(sync).toEqual({ status: 200, data: { ok: true, count: 1 } });
      pushStatus = () => status;
      now = caseAt;
      setNow(now);
      await fireAlarm();
      expect((await apiJson('health')).data.devices).toBe(1);
      const rows = await queued(idCase);
      expect(rows, `status=${status}`).toHaveLength(1);
      expect(rows[0].due_at).toBe(caseAt + RETRY_MS);
      await apiJson('push/unsubscribe', { deviceId: idCase });
    }

    // Repeated 503s double the delay: 20 s, 40 s, 80 s, incrementing tries.
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const at = now + 10_000;
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('m', at)] });
    pushStatus = () => 503;
    now = at;
    for (const [expectedTries, expectedDelta] of [
      [1, RETRY_MS],
      [2, RETRY_MS * 2],
      [3, RETRY_MS * 4],
    ] as const) {
      setNow(now);
      await fireAlarm();
      const row = await runInDurableObject(stub(), (_i, state) =>
        state.storage.sql.exec<{ due_at: number; tries: number }>('SELECT due_at, tries FROM reminders WHERE device_id = ?', id).one(),
      );
      expect(row.tries).toBe(expectedTries);
      expect(row.due_at).toBe(now + expectedDelta);
      now = row.due_at;
    }
    expect((await apiJson('health')).data.devices).toBe(1);
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

  it('unsubscribe removes the device, its queue, and clears the alarm', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('m', T0 + 1000)] });
    expect(await alarmTime()).toBe(T0 + 1000);
    expect((await apiJson('push/unsubscribe', { deviceId: id })).data).toEqual({ ok: true });
    expect(await queued(id)).toEqual([]);
    expect((await apiJson('health')).data.devices).toBe(0);
    expect(await alarmTime()).toBeNull();
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
    expect(await decryptPush(sent[0].body, fresh)).toMatchObject({
      title: 'Time for your medication',
      body: 'Open Dosely to review your dose.',
    });
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

  it('keeps device on 403 and clears device + alarm on 404 when a reminder is queued', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('m', T0 + 60_000)] });
    expect(await alarmTime()).toBe(T0 + 60_000);

    pushStatus = () => 403;
    expect(await apiJson('push/test', { deviceId: id })).toEqual({
      status: 502,
      data: { error: 'push service rejected the message' },
    });
    expect((await apiJson('health')).data.devices).toBe(1);
    expect(await alarmTime()).toBe(T0 + 60_000);

    setNow(T0 + 6_000);
    pushStatus = () => 404;
    expect(await apiJson('push/test', { deviceId: id })).toEqual({
      status: 410,
      data: { error: 'subscription expired' },
    });
    expect((await apiJson('health')).data.devices).toBe(0);
    expect(await alarmTime()).toBeNull();
  });

  it('enforces per-IP limits (IPv4 and IPv6 /64), global test bucket, and persisted per-device cooldown', async () => {
    // 1. Per-IP subscribe limit (10 per window), separate IP allowed, IPv6 /64 shared bucket, window reset.
    const sub = await makeSubscriber();
    for (let i = 0; i < IP_LIMITS.subscribe; i++) {
      const r = await apiJson(
        'push/subscribe',
        { deviceId: deviceId(), subscription: sub.json },
        { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
      );
      expect(r.status).toBe(200);
    }
    expect(
      await apiJson(
        'push/subscribe',
        { deviceId: deviceId(), subscription: sub.json },
        { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
      ),
    ).toEqual({ status: 429, data: { error: 'slow down' } });
    expect(
      await apiJson(
        'push/subscribe',
        { deviceId: deviceId(), subscription: sub.json },
        { headers: { 'CF-Connecting-IP': '203.0.113.8' } },
      ),
    ).toEqual({ status: 200, data: { ok: true } });

    for (let i = 0; i < 6; i++) {
      expect(
        (
          await apiJson(
            'push/subscribe',
            { deviceId: deviceId(), subscription: sub.json },
            { headers: { 'CF-Connecting-IP': '2001:db8:1:2::1' } },
          )
        ).status,
      ).toBe(200);
    }
    for (let i = 0; i < 4; i++) {
      expect(
        (
          await apiJson(
            'push/subscribe',
            { deviceId: deviceId(), subscription: sub.json },
            { headers: { 'CF-Connecting-IP': '2001:db8:1:2:ffff::9' } },
          )
        ).status,
      ).toBe(200);
    }
    expect(
      await apiJson(
        'push/subscribe',
        { deviceId: deviceId(), subscription: sub.json },
        { headers: { 'CF-Connecting-IP': '2001:db8:1:2:ffff::9' } },
      ),
    ).toEqual({ status: 429, data: { error: 'slow down' } });

    setNow(T0 + IP_WINDOW_MS);
    expect(
      (
        await apiJson(
          'push/subscribe',
          { deviceId: deviceId(), subscription: sub.json },
          { headers: { 'CF-Connecting-IP': '203.0.113.7' } },
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await apiJson(
          'push/subscribe',
          { deviceId: deviceId(), subscription: sub.json },
          { headers: { 'CF-Connecting-IP': '2001:db8:1:2::1' } },
        )
      ).status,
    ).toBe(200);

    // 2. Per-IP push/test limit (6 per window) using distinct devices.
    const testDevs: string[] = [];
    for (let i = 0; i < IP_LIMITS.test + 1; i++) {
      const id = deviceId();
      await subscribe(id, sub);
      testDevs.push(id);
    }
    for (let i = 0; i < IP_LIMITS.test; i++) {
      expect(
        await apiJson('push/test', { deviceId: testDevs[i] }, { headers: { 'CF-Connecting-IP': '198.51.100.42' } }),
      ).toEqual({ status: 200, data: { ok: true } });
    }
    expect(
      await apiJson('push/test', { deviceId: testDevs[IP_LIMITS.test] }, { headers: { 'CF-Connecting-IP': '198.51.100.42' } }),
    ).toEqual({ status: 429, data: { error: 'slow down' } });

    // Check persisted last_test column on the tested device.
    const lastTest = await runInDurableObject(stub(), (_i, state) =>
      state.storage.sql.exec<{ last_test: number | null }>('SELECT last_test FROM devices WHERE device_id = ?', testDevs[0]).one().last_test,
    );
    expect(lastTest).toBe(T0 + IP_WINDOW_MS);

    // 3. Global test bucket (TEST_BUCKET_SIZE = 10) without IP header, refilling after TEST_REFILL_MS.
    // Reset test_bucket in meta and subscribe fresh devices for a clean global bucket count.
    await runInDurableObject(stub(), (i, state) => {
      state.storage.sql.exec('DELETE FROM meta;');
      i.resetRateLimits();
    });
    const bucketDevs: string[] = [];
    for (let i = 0; i < TEST_BUCKET_SIZE + 2; i++) {
      const id = deviceId();
      await subscribe(id, sub);
      bucketDevs.push(id);
    }
    for (let i = 0; i < TEST_BUCKET_SIZE; i++) {
      expect(await apiJson('push/test', { deviceId: bucketDevs[i] })).toEqual({ status: 200, data: { ok: true } });
    }
    expect(await apiJson('push/test', { deviceId: bucketDevs[TEST_BUCKET_SIZE] })).toEqual({
      status: 429,
      data: { error: 'slow down' },
    });
    setNow(T0 + IP_WINDOW_MS + TEST_REFILL_MS);
    expect(await apiJson('push/test', { deviceId: bucketDevs[TEST_BUCKET_SIZE + 1] })).toEqual({
      status: 200,
      data: { ok: true },
    });
  });
});

describe('eviction, heartbeat, concurrency, fairness, daily cap', () => {
  async function insertDeviceRows(
    rows: Array<{ id: string; updatedAt: number; lastOk: number | null }>,
    sub: Subscriber,
  ) {
    await runInDurableObject(stub(), (_i, state) => {
      for (const r of rows) {
        state.storage.sql.exec(
          `INSERT INTO devices (device_id, endpoint, p256dh, auth, expiration, rev, updated_at, created_at, last_ok, last_test, day, day_sends)
           VALUES (?, ?, ?, ?, NULL, 1, ?, ?, ?, NULL, 0, 0)`,
          r.id,
          `https://fcm.googleapis.com/fcm/send/${r.id}`,
          sub.json.keys.p256dh,
          sub.json.keys.auth,
          r.updatedAt,
          r.updatedAt,
          r.lastOk,
        );
      }
    });
  }

  async function deviceIds(): Promise<string[]> {
    return runInDurableObject(stub(), (_i, state) =>
      state.storage.sql.exec<{ device_id: string }>('SELECT device_id FROM devices').toArray().map((r) => r.device_id),
    );
  }

  it(`evicts oldest unproven, unproven before proven, refuses full active proven, and evicts inactive > PROTECT_MS at MAX_DEVICES (${MAX_DEVICES})`, async () => {
    const sub = await makeSubscriber();

    // (a) All unproven: oldest updated_at is evicted.
    await insertDeviceRows(
      Array.from({ length: MAX_DEVICES }, (_, i) => ({
        id: `unproven_${String(i).padStart(3, '0')}_xxxxxxxxxx`,
        updatedAt: T0 - (i + 1) * 1000,
        lastOk: null,
      })),
      sub,
    );
    const freshA = deviceId();
    await subscribe(freshA, sub);
    const idsA = await deviceIds();
    expect(idsA).toHaveLength(MAX_DEVICES);
    expect(idsA).not.toContain(`unproven_${String(MAX_DEVICES - 1).padStart(3, '0')}_xxxxxxxxxx`);
    expect(idsA).toContain(freshA);

    // (b) Unproven evicted before proven even if proven is older.
    await runInDurableObject(stub(), (_i, state) => state.storage.sql.exec('DELETE FROM devices;'));
    const provenOldId = 'proven_old_00000000000000';
    const unprovenNewId = 'unproven_new_000000000000';
    await insertDeviceRows(
      [
        { id: provenOldId, updatedAt: T0 - 10_000_000, lastOk: T0 - 10_000_000 },
        { id: unprovenNewId, updatedAt: T0 - 1000, lastOk: null },
        ...Array.from({ length: MAX_DEVICES - 2 }, (_, i) => ({
          id: `proven_${String(i).padStart(3, '0')}_xxxxxxxxxxxx`,
          updatedAt: T0 - 5000,
          lastOk: T0 - 5000,
        })),
      ],
      sub,
    );
    const freshB = deviceId();
    await subscribe(freshB, sub);
    const idsB = await deviceIds();
    expect(idsB).toHaveLength(MAX_DEVICES);
    expect(idsB).not.toContain(unprovenNewId);
    expect(idsB).toContain(provenOldId);
    expect(idsB).toContain(freshB);

    // (c) All 200 proven with recent activity -> 503 server full; existing device re-subscribing succeeds.
    await runInDurableObject(stub(), (_i, state) => state.storage.sql.exec('DELETE FROM devices;'));
    const fullIds = Array.from({ length: MAX_DEVICES }, (_, i) => `active_${String(i).padStart(3, '0')}_xxxxxxxxxxxx`);
    await insertDeviceRows(
      fullIds.map((id, i) => ({ id, updatedAt: T0 - (i + 1) * 1000, lastOk: T0 - (i + 1) * 1000 })),
      sub,
    );
    expect(await apiJson('push/subscribe', { deviceId: deviceId(), subscription: sub.json })).toEqual({
      status: 503,
      data: { error: 'server full' },
    });
    expect(
      await apiJson('push/subscribe', {
        deviceId: fullIds[0],
        subscription: { ...sub.json, endpoint: 'https://web.push.apple.com/reused' },
      }),
    ).toEqual({ status: 200, data: { ok: true } });

    // (d) All proven, one inactive > PROTECT_MS -> that one is evicted.
    const staleId = fullIds[MAX_DEVICES - 1];
    await runInDurableObject(stub(), (_i, state) => {
      state.storage.sql.exec('UPDATE devices SET updated_at = ?, last_ok = ? WHERE device_id = ?', T0 - PROTECT_MS - 1, T0 - PROTECT_MS - 1, staleId);
    });
    const freshD = deviceId();
    await subscribe(freshD, sub);
    const idsD = await deviceIds();
    expect(idsD).toHaveLength(MAX_DEVICES);
    expect(idsD).not.toContain(staleId);
    expect(idsD).toContain(freshD);
  });

  it('refreshes devices.updated_at only after HEARTBEAT_MS on no-op sync, or immediately on change', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const r1 = reminder('m1', T0 + 2 * HEARTBEAT_MS);
    const r2 = reminder('m2', T0 + 3 * HEARTBEAT_MS);
    await apiJson('push/reminders', { deviceId: id, reminders: [r1] });

    const getUpdatedAt = () =>
      runInDurableObject(stub(), (_i, state) =>
        state.storage.sql.exec<{ updated_at: number }>('SELECT updated_at FROM devices WHERE device_id = ?', id).one().updated_at,
      );

    expect(await getUpdatedAt()).toBe(T0);

    setNow(T0 + HEARTBEAT_MS - 1000);
    await apiJson('push/reminders', { deviceId: id, reminders: [r1] });
    expect(await getUpdatedAt()).toBe(T0);

    setNow(T0 + HEARTBEAT_MS);
    await apiJson('push/reminders', { deviceId: id, reminders: [r1] });
    expect(await getUpdatedAt()).toBe(T0 + HEARTBEAT_MS);

    setNow(T0 + HEARTBEAT_MS + 1000);
    await apiJson('push/reminders', { deviceId: id, reminders: [r1, r2] });
    expect(await getUpdatedAt()).toBe(T0 + HEARTBEAT_MS + 1000);
  });

  it(`sends devices concurrently (<= PUSH_CONCURRENCY=${PUSH_CONCURRENCY}), does not block B/C on A, and skips rest on 410`, async () => {
    const subA = await makeSubscriber('https://fcm.googleapis.com/fcm/send/dev-a');
    const subB = await makeSubscriber('https://fcm.googleapis.com/fcm/send/dev-b');
    const subC = await makeSubscriber('https://fcm.googleapis.com/fcm/send/dev-c');
    const idA = deviceId();
    const idB = deviceId();
    const idC = deviceId();
    await subscribe(idA, subA);
    await subscribe(idB, subB);
    await subscribe(idC, subC);
    const due = T0 + 1000;
    await apiJson('push/reminders', { deviceId: idA, reminders: [reminder('m', due)] });
    await apiJson('push/reminders', { deviceId: idB, reminders: [reminder('m', due)] });
    await apiJson('push/reminders', { deviceId: idC, reminders: [reminder('m', due)] });

    let releaseA!: () => void;
    const gateA = new Promise<void>((resolve) => {
      releaseA = resolve;
    });
    const sentUrls: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      sentUrls.push(url);
      if (url === subA.endpoint) await gateA;
      return new Response(null, { status: 201 });
    });

    setNow(due);
    const alarmPromise = fireAlarm();
    await vi.waitFor(() => {
      expect(sentUrls).toContain(subB.endpoint);
      expect(sentUrls).toContain(subC.endpoint);
    });
    releaseA();
    await alarmPromise;
    expect(sentUrls).toContain(subA.endpoint);

    // Clear and test 10 devices due at once: max in-flight <= PUSH_CONCURRENCY (6).
    await runInDurableObject(stub(), async (instance, state) => {
      state.storage.sql.exec('DELETE FROM devices; DELETE FROM reminders; DELETE FROM sent;');
      instance.resetRateLimits();
      await state.storage.deleteAlarm();
    });

    const ten = await Promise.all(
      Array.from({ length: 10 }, async (_, i) => ({
        id: deviceId(),
        sub: await makeSubscriber(`https://fcm.googleapis.com/fcm/send/conc-${i}`),
      })),
    );
    for (const d of ten) {
      await subscribe(d.id, d.sub);
      await apiJson('push/reminders', { deviceId: d.id, reminders: [reminder('m', due + 1000)] });
    }
    let inFlight = 0;
    let maxInFlight = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 15));
      inFlight--;
      return new Response(null, { status: 201 });
    });
    setNow(due + 1000);
    await fireAlarm();
    expect(maxInFlight).toBeGreaterThan(1);
    expect(maxInFlight).toBeLessThanOrEqual(PUSH_CONCURRENCY);

    // 410 on one device skips its remaining reminders in the same run while still sending other devices.
    const goneId = deviceId();
    const okId = deviceId();
    const goneSub = await makeSubscriber('https://fcm.googleapis.com/fcm/send/gone-multi');
    const okSub = await makeSubscriber('https://fcm.googleapis.com/fcm/send/ok-other');
    await subscribe(goneId, goneSub);
    await subscribe(okId, okSub);
    await apiJson('push/reminders', {
      deviceId: goneId,
      reminders: [reminder('m1', due + 2000), reminder('m2', due + 2001)],
    });
    await apiJson('push/reminders', { deviceId: okId, reminders: [reminder('m1', due + 2000)] });

    const seenByUrl: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seenByUrl.push(url);
      return new Response(null, { status: url === goneSub.endpoint ? 410 : 201 });
    });
    setNow(due + 2001);
    await fireAlarm();
    expect(seenByUrl.filter((u) => u === goneSub.endpoint)).toHaveLength(1);
    expect(seenByUrl.filter((u) => u === okSub.endpoint)).toHaveLength(1);
    expect(await queued(goneId)).toEqual([]);
    expect(await queued(okId)).toEqual([]);
  });

  it('fairness: serves device Y in the first alarm run even when device X has 50 earlier reminders', async () => {
    const idX = deviceId();
    const idY = deviceId();
    const subX = await makeSubscriber('https://fcm.googleapis.com/fcm/send/fair-x');
    const subY = await makeSubscriber('https://fcm.googleapis.com/fcm/send/fair-y');
    await subscribe(idX, subX);
    await subscribe(idY, subY);

    const T = T0 + 10_000;
    await apiJson('push/reminders', {
      deviceId: idX,
      reminders: Array.from({ length: 50 }, (_, i) => reminder(`mx${i}`, T)),
    });
    await apiJson('push/reminders', {
      deviceId: idY,
      reminders: [reminder('my', T + 1)],
    });

    setNow(T + 1);
    await fireAlarm();
    expect(sent.map((s) => s.url)).toContain(subY.endpoint);
    expect(sent).toHaveLength(BATCH_SIZE);
  });

  it('fairness: ranks each device first, then prefers proven devices over unproven on equal rank', async () => {
    const idP = 'dev_proven_00000000000000000';
    const subP = await makeSubscriber('https://fcm.googleapis.com/fcm/send/fair-proven');
    await subscribe(idP, subP);

    // Deliver one reminder so idP is proven (last_ok IS NOT NULL).
    const T = T0 + 10_000;
    await apiJson('push/reminders', { deviceId: idP, reminders: [reminder('seed', T)] });
    setNow(T);
    await fireAlarm();
    expect(sent).toHaveLength(1);
    sent = [];

    // Queue 2 due reminders on proven idP (later due_at) and 1 each on BATCH_SIZE unproven devices (earlier due_at).
    const T2 = T + 10_000;
    await apiJson('push/reminders', {
      deviceId: idP,
      reminders: [reminder('p0', T2 + 100), reminder('p1', T2 + 200)],
    });
    const unproven = await Promise.all(
      Array.from({ length: BATCH_SIZE }, async (_, i) => {
        const id = `dev_unproven_${String(i).padStart(2, '0')}_000000000`;
        const sub = await makeSubscriber(`https://fcm.googleapis.com/fcm/send/fair-u-${i}`);
        await subscribe(id, sub);
        await apiJson('push/reminders', { deviceId: id, reminders: [reminder(`u${i}`, T2)] });
        return { id, sub };
      }),
    );

    setNow(T2 + 200);
    await fireAlarm();
    expect(sent).toHaveLength(BATCH_SIZE);
    // Proven idP gets rank 0 ahead of unproven rank 0 (despite later due_at), but not rank 1 ahead of unproven rank 0.
    expect(sent.filter((s) => s.url === subP.endpoint)).toHaveLength(1);
    // All but the last unproven device (tiebroken by device_id) are served in run 1.
    for (const u of unproven.slice(0, BATCH_SIZE - 1)) {
      expect(sent.map((s) => s.url)).toContain(u.sub.endpoint);
    }
    expect(sent.map((s) => s.url)).not.toContain(unproven[BATCH_SIZE - 1].sub.endpoint);
  });

  it(`caps unproven devices at DAILY_PUSHES_UNPROVEN (${DAILY_PUSHES_UNPROVEN}) attempts per UTC day and drops remaining due reminders`, async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const due = T0 + 60_000;
    await apiJson('push/reminders', {
      deviceId: id,
      reminders: Array.from({ length: 25 }, (_, i) => reminder(`m${i}`, due)),
    });

    pushStatus = () => 500;
    let now = due;
    setNow(now);
    let loops = 0;
    while (await fireAlarm()) {
      loops++;
      if (loops > 20) throw new Error('alarm loop did not terminate');
      const next = await alarmTime();
      if (next !== null && next > now) {
        now = next;
        setNow(now);
      }
    }

    expect(sent).toHaveLength(DAILY_PUSHES_UNPROVEN);
    expect(await queued(id)).toEqual([]);
    expect(await alarmTime()).toBeNull();
  });
});

describe('validation, grouping, group snooze, and payload size', () => {
  it('validates medId control chars and reminder doses constraints', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const at = T0 + 60_000;

    expect(
      await apiJson('push/reminders', {
        deviceId: id,
        reminders: [{ ...reminder('m0', at), medId: 'bad\u0007med' }],
      }),
    ).toEqual({ status: 400, data: { error: 'invalid medId' } });

    const twentyOne = Array.from({ length: 21 }, (_, i) => ({ medId: `m${i}`, at: at + i * 1000 }));
    expect(
      await apiJson('push/reminders', {
        deviceId: id,
        reminders: [{ ...reminder('m0', at), doses: twentyOne }],
      }),
    ).toEqual({ status: 400, data: { error: 'invalid reminder doses' } });

    expect(
      await apiJson('push/reminders', {
        deviceId: id,
        reminders: [{ ...reminder('m0', at), doses: [{ medId: 'm0', at }, { medId: 'm0', at }] }],
      }),
    ).toEqual({ status: 400, data: { error: 'invalid reminder doses' } });

    expect(
      await apiJson('push/reminders', {
        deviceId: id,
        reminders: [{ ...reminder('m0', at), doses: [{ medId: 'm0', at: at - 1 }, { medId: 'm1', at }] }],
      }),
    ).toEqual({ status: 400, data: { error: 'invalid reminder doses' } });

    expect(
      await apiJson('push/reminders', {
        deviceId: id,
        reminders: [{ ...reminder('m0', at), doses: [{ medId: 'm0', at }] }],
      }),
    ).toEqual({ status: 200, data: { ok: true, count: 1 } });

    const stored = await runInDurableObject(stub(), (_i, state) =>
      state.storage.sql.exec<{ doses: string | null }>('SELECT doses FROM reminders WHERE device_id = ?', id).one(),
    );
    expect(stored.doses).toBeNull();
  });

  it('sends group reminders, strips already-notified doses from shifted groups, and deduplicates singles', async () => {
    const id = deviceId();
    const sub = await makeSubscriber();
    await subscribe(id, sub);

    const T1 = T0 + 60_000;
    const T2 = T1 + 5 * 60_000;
    const T3 = T1 + 12 * 60_000;
    const group1 = {
      id: `a@${T1}`,
      medId: 'a',
      at: T1,
      title: 'x',
      body: 'y',
      doses: [
        { medId: 'a', at: T1 },
        { medId: 'b', at: T2 },
      ],
    };
    expect(await apiJson('push/reminders', { deviceId: id, reminders: [group1] })).toEqual({
      status: 200,
      data: { ok: true, count: 1 },
    });

    setNow(T1);
    await fireAlarm();
    expect(sent).toHaveLength(1);
    expect(await decryptPush(sent[0].body, sub)).toEqual({
      title: 'Time for your medications',
      body: '2 medications are due. Open Dosely to review them.',
      tag: `a@${T1}`,
      count: 2,
      data: {
        medId: 'a',
        scheduledFor: new Date(T1).toISOString(),
        reminderId: `a@${T1}`,
        deviceId: id,
        count: 2,
        reminder: {
          id: `a@${T1}`,
          medId: 'a',
          at: T1,
          title: 'Time for your medications',
          body: '2 medications are due. Open Dosely to review them.',
          doses: [
            { medId: 'a', at: T1 },
            { medId: 'b', at: T2 },
          ],
        },
      },
    });

    // At T1 + 1 min, client posts shifted group [b@T2, c@T3] -> b stripped, c@T3 queued as single.
    setNow(T1 + 60_000);
    const shifted = await apiJson('push/reminders', {
      deviceId: id,
      reminders: [
        {
          id: `b@${T2}`,
          medId: 'b',
          at: T2,
          title: 'x',
          body: 'y',
          doses: [
            { medId: 'b', at: T2 },
            { medId: 'c', at: T3 },
          ],
        },
      ],
    });
    expect(shifted).toEqual({ status: 200, data: { ok: true, count: 1 } });
    expect((await queued(id)).map((r) => ({ id: r.id, at: r.at }))).toEqual([{ id: `c@${T3}`, at: T3 }]);

    // Re-posting single b@T2 while T2 is still in the future -> stripped by sent table (count 0).
    expect(await apiJson('push/reminders', { deviceId: id, reminders: [reminder('b', T2)] })).toEqual({
      status: 200,
      data: { ok: true, count: 0 },
    });

    // Re-queue c@T3 and let it fire at T3 as single-dose text.
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('c', T3)] });
    setNow(T3);
    await fireAlarm();
    expect(sent).toHaveLength(2);
    expect(await decryptPush(sent[1].body, sub)).toEqual({
      title: 'Time for your medication',
      body: 'Open Dosely to review your dose.',
      tag: `c@${T3}`,
      data: {
        medId: 'c',
        scheduledFor: new Date(T3).toISOString(),
        reminderId: `c@${T3}`,
        deviceId: id,
        reminder: {
          id: `c@${T3}`,
          medId: 'c',
          at: T3,
          title: 'Time for your medication',
          body: 'Open Dosely to review your dose.',
        },
      },
    });
  });

  it('does not re-send a group dose that a sync re-queued while the group push was in flight', async () => {
    const id = deviceId();
    const sub = await makeSubscriber();
    await subscribe(id, sub);
    const T1 = T0 + 60_000;
    const T2 = T1 + 5 * 60_000;
    const group = {
      id: `a@${T1}`,
      medId: 'a',
      at: T1,
      title: 'x',
      body: 'y',
      doses: [
        { medId: 'a', at: T1 },
        { medId: 'b', at: T2 },
      ],
    };
    await apiJson('push/reminders', { deviceId: id, reminders: [group] });

    // The client re-syncs the same group while the push service is still answering.
    let synced: unknown = null;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      sent.push({ url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
      if (!synced) synced = await apiJson('push/reminders', { deviceId: id, reminders: [group] });
      return new Response(null, { status: 201 });
    });
    setNow(T1);
    await fireAlarm();
    expect(sent).toHaveLength(1);
    expect(synced).toEqual({ status: 200, data: { ok: true, count: 1 } }); // it re-queued b@T2 alone
    expect(await queued(id)).toEqual([]); // ...which the delivered group then removed

    setNow(T2);
    await fireAlarm();
    expect(sent).toHaveLength(1);
  });

  /** Runs `during` once, from inside the first push request, before the push service answers. */
  function duringFirstPush(during: () => Promise<unknown>) {
    let ran = false;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const req = new Request(input as RequestInfo, init);
      sent.push({ url: req.url, headers: req.headers, body: new Uint8Array(await req.arrayBuffer()) });
      if (!ran) {
        ran = true;
        await during();
      }
      return new Response(null, { status: 201 });
    });
  }

  it('does not send a reminder that a sync removed while an earlier push was in flight', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const T1 = T0 + 60_000;
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('a', T1), reminder('b', T1 + 1)] });
    // The app logs both doses during the first push: the next sync has neither.
    duringFirstPush(() => apiJson('push/reminders', { deviceId: id, reminders: [] }));
    setNow(T1 + 1);
    await fireAlarm();
    expect(sent).toHaveLength(1);
    expect(await queued(id)).toEqual([]);
  });

  it('keeps a dose a sync added to the in-flight group row', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const T1 = T0 + 60_000;
    const group = (doses: Array<[string, number]>) => ({
      id: `a@${T1}`,
      medId: 'a',
      at: T1,
      title: 'x',
      body: 'y',
      doses: doses.map(([medId, at]) => ({ medId, at })),
    });
    await apiJson('push/reminders', { deviceId: id, reminders: [group([['a', T1], ['b', T1 + 60_000]])] });
    // A new medication's dose joins the same group (same id) while the push is in flight.
    duringFirstPush(() =>
      apiJson('push/reminders', { deviceId: id, reminders: [group([['a', T1], ['b', T1 + 60_000], ['c', T1 + 120_000]])] }),
    );
    setNow(T1);
    await fireAlarm();
    expect(sent).toHaveLength(1);
    expect((await queued(id)).map((r) => r.id)).toEqual([`c@${T1 + 120_000}`]);
  });

  it('a re-subscribe during a push sends the rest, and the in-flight one again, to the new subscription', async () => {
    const id = deviceId();
    const old = await makeSubscriber();
    await subscribe(id, old);
    const T1 = T0 + 60_000;
    await apiJson('push/reminders', { deviceId: id, reminders: [reminder('a', T1), reminder('b', T1 + 1)] });
    const fresh = await makeSubscriber('https://web.push.apple.com/rotated');
    duringFirstPush(() => subscribe(id, fresh));
    setNow(T1 + 1);
    await fireAlarm();
    // Nothing more went to the old endpoint, and the reminder it took is kept for the new one.
    expect(sent.map((s) => s.url)).toEqual([old.endpoint]);
    expect((await queued(id)).map((r) => r.id)).toEqual([`a@${T1}`, `b@${T1 + 1}`]);
    expect(await alarmTime()).toBe(T1 + 1);

    await fireAlarm();
    expect(sent.map((s) => s.url)).toEqual([old.endpoint, fresh.endpoint, fresh.endpoint]);
    expect(await queued(id)).toEqual([]);
    // Delivered to the current subscription: recorded as sent, so a late sync can't re-queue them.
    const sentIds = await runInDurableObject(stub(), (_i, state) =>
      state.storage.sql
        .exec<{ id: string }>('SELECT id FROM sent WHERE device_id = ? ORDER BY id', id)
        .toArray()
        .map((r) => r.id),
    );
    expect(sentIds).toEqual([`a@${T1}`, `b@${T1 + 1}`]);
  });

  it('group snooze: fires as group, shrinks when one dose is dismissed, and drops when both dismissed', async () => {
    const id = deviceId();
    const sub = await makeSubscriber();
    await subscribe(id, sub);

    const T1 = T0 - 60_000;
    const T2 = T1 + 5 * 60_000;
    const orig = {
      id: `a@${T1}`,
      medId: 'a',
      at: T1,
      title: 'x',
      body: 'y',
      doses: [
        { medId: 'a', at: T1 },
        { medId: 'b', at: T2 },
      ],
    };
    const s1 = await apiJson('push/snooze', { deviceId: id, reminder: orig, minutes: 10 });
    expect(s1).toEqual({ status: 200, data: { ok: true, at: T0 + 10 * 60_000 } });

    setNow(T0 + 10 * 60_000);
    await fireAlarm();
    expect(sent).toHaveLength(1);
    expect(await decryptPush(sent[0].body, sub)).toEqual({
      title: 'Time for your medications',
      body: '2 medications are due. Open Dosely to review them.',
      tag: orig.id,
      count: 2,
      data: {
        medId: 'a',
        scheduledFor: new Date(T1).toISOString(),
        reminderId: orig.id,
        deviceId: id,
        count: 2,
        reminder: {
          id: orig.id,
          medId: 'a',
          at: T1,
          title: 'Time for your medications',
          body: '2 medications are due. Open Dosely to review them.',
          doses: orig.doses,
        },
      },
    });

    // Snooze again, then dismiss a@T1 -> shrinks to single-dose text for b.
    await apiJson('push/snooze', { deviceId: id, reminder: orig, minutes: 10 });
    const futureA = reminder('a', T0 + 6 * 3600_000);
    const futureB = reminder('b', T0 + 6 * 3600_000);
    await apiJson('push/reminders', { deviceId: id, reminders: [futureA, futureB], dismissed: [orig.id] });
    const snoozedAfterPartial = (await queued(id)).filter((r) => r.snoozed);
    expect(snoozedAfterPartial).toHaveLength(1);

    setNow(T0 + 20 * 60_000);
    await fireAlarm();
    expect(sent).toHaveLength(2);
    expect(await decryptPush(sent[1].body, sub)).toEqual({
      title: 'Time for your medication',
      body: 'Open Dosely to review your dose.',
      tag: `b@${T2}`,
      data: {
        medId: 'b',
        scheduledFor: new Date(T2).toISOString(),
        reminderId: `b@${T2}`,
        deviceId: id,
        reminder: {
          id: `b@${T2}`,
          medId: 'b',
          at: T2,
          title: 'Time for your medication',
          body: 'Open Dosely to review your dose.',
        },
      },
    });

    // Snooze again, then dismiss both -> pending snooze removed.
    await apiJson('push/snooze', { deviceId: id, reminder: orig, minutes: 10 });
    await apiJson('push/reminders', {
      deviceId: id,
      reminders: [futureA, futureB],
      dismissed: [orig.id, `b@${T2}`],
    });
    expect((await queued(id)).filter((r) => r.snoozed)).toHaveLength(0);
  });

  it('bounds multibyte 20-dose group payload to <= MAX_PLAINTEXT UTF-8 bytes and tests payloadFor directly', async () => {
    const id = deviceId();
    const sub = await makeSubscriber();
    await subscribe(id, sub);

    const T1 = T0 + 60_000;
    const doses = Array.from({ length: 20 }, (_, i) => ({
      medId: `${String(i).padStart(2, '0')}${'日'.repeat(98)}`,
      at: T1 + i * 1000,
    }));
    const bigGroup = {
      id: `${doses[0].medId}@${T1}`,
      medId: doses[0].medId,
      at: T1,
      title: 'ignored',
      body: 'ignored',
      doses,
    };
    expect(await apiJson('push/reminders', { deviceId: id, reminders: [bigGroup] })).toEqual({
      status: 200,
      data: { ok: true, count: 1 },
    });

    setNow(T1);
    await fireAlarm();
    expect(sent).toHaveLength(1);
    const decrypted = (await decryptPush(sent[0].body, sub)) as {
      count: number;
      data: { count: number; reminder: { doses: unknown[] } };
    };
    expect(decrypted.count).toBe(20);
    expect(decrypted.data.count).toBe(20);
    expect(decrypted.data.reminder.doses.length).toBeLessThan(20);
    expect(new TextEncoder().encode(JSON.stringify(decrypted)).length).toBeLessThanOrEqual(MAX_PLAINTEXT);

    // Direct payloadFor checks for a single row and a group row.
    const singleRow: ReminderRow = {
      device_id: id,
      id: `m1@${T1}`,
      med_id: 'm1',
      at: T1,
      doses: null,
      snoozed: 0,
      orig_id: null,
      orig_at: null,
    };
    expect(JSON.parse(payloadFor(id, singleRow))).toEqual({
      title: 'Time for your medication',
      body: 'Open Dosely to review your dose.',
      tag: `m1@${T1}`,
      data: {
        medId: 'm1',
        scheduledFor: new Date(T1).toISOString(),
        reminderId: `m1@${T1}`,
        deviceId: id,
        reminder: {
          id: `m1@${T1}`,
          medId: 'm1',
          at: T1,
          title: 'Time for your medication',
          body: 'Open Dosely to review your dose.',
        },
      },
    });

    const groupRow: ReminderRow = {
      device_id: id,
      id: bigGroup.id,
      med_id: bigGroup.medId,
      at: T1,
      doses: JSON.stringify(doses.map((d) => [d.medId, d.at])),
      snoozed: 0,
      orig_id: null,
      orig_at: null,
    };
    const groupPayload = payloadFor(id, groupRow);
    expect(new TextEncoder().encode(groupPayload).length).toBeLessThanOrEqual(MAX_PLAINTEXT);
    expect(JSON.parse(groupPayload)).toMatchObject({
      title: 'Time for your medications',
      body: '20 medications are due. Open Dosely to review them.',
      tag: bigGroup.id,
      count: 20,
    });
  });
});

describe('snooze race', () => {
  it('a sync landing after a snooze came due (before the alarm ran) keeps it', async () => {
    const id = deviceId();
    const sub = await makeSubscriber();
    await subscribe(id, sub);
    const orig = reminder('med1', T0 - 60_000);
    const future = reminder('med1', T0 + 6 * 3600_000);
    await apiJson('push/snooze', { deviceId: id, reminder: orig, minutes: 10 });
    setNow(T0 + 10 * 60_000 + 500); // due, alarm not yet run
    await apiJson('push/reminders', { deviceId: id, reminders: [future], dismissed: [] });
    expect((await queued(id)).filter((r) => r.snoozed)).toHaveLength(1);
    await fireAlarm();
    expect(sent).toHaveLength(1);
    expect(((await decryptPush(sent[0].body, sub)) as { tag: string }).tag).toBe(orig.id);
  });
});

describe('alarm writes', () => {
  async function spyAlarmWrites() {
    return runInDurableObject(stub(), (_i, state) => ({
      set: vi.spyOn(state.storage, 'setAlarm'),
      del: vi.spyOn(state.storage, 'deleteAlarm'),
    }));
  }

  it('the idle watchdog (nothing queued, no alarm) writes nothing', async () => {
    const spies = await spyAlarmWrites();
    const waitUntil = vi.fn<(p: Promise<unknown>) => void>();
    const ctx = { waitUntil, passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext;
    await worker.scheduled({ cron: '* * * * *', scheduledTime: Date.now(), noRetry: () => {} }, env, ctx);
    await Promise.all(waitUntil.mock.calls.map(([p]) => p));
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.del).not.toHaveBeenCalled();
    expect(await alarmTime()).toBeNull();
  });

  it('a no-op sync does not set the alarm again', async () => {
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    const list = [reminder('m', T0 + 60_000)];
    const spies = await spyAlarmWrites();
    await apiJson('push/reminders', { deviceId: id, reminders: list });
    expect(await alarmTime()).toBe(T0 + 60_000);
    expect(spies.set).toHaveBeenCalledTimes(1); // the spies do see the object's writes
    spies.set.mockClear();
    await apiJson('push/reminders', { deviceId: id, reminders: list });
    expect(spies.set).not.toHaveBeenCalled();
    expect(spies.del).not.toHaveBeenCalled();
  });
});

describe('storage schema', () => {
  it('rebuilds tables left by the first Worker version', async () => {
    const cols = await runInDurableObject(stub(), (instance: PushStore, state) => {
      const sql = state.storage.sql;
      sql.exec('DROP TABLE reminders; DROP TABLE sent; DROP TABLE devices;');
      sql.exec(`CREATE TABLE devices (device_id TEXT PRIMARY KEY, endpoint TEXT NOT NULL, p256dh TEXT NOT NULL,
        auth TEXT NOT NULL, expiration REAL, rev INTEGER NOT NULL, updated_at INTEGER NOT NULL);
        CREATE TABLE reminders (device_id TEXT NOT NULL, id TEXT NOT NULL, med_id TEXT NOT NULL, at INTEGER NOT NULL,
        title TEXT NOT NULL, body TEXT NOT NULL, snoozed INTEGER NOT NULL DEFAULT 0, orig_id TEXT, orig_at INTEGER,
        due_at INTEGER NOT NULL, PRIMARY KEY (device_id, id)) WITHOUT ROWID;
        CREATE TABLE sent (device_id TEXT NOT NULL, id TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (device_id, id)) WITHOUT ROWID;`);
      sql.exec("INSERT INTO devices VALUES ('old', 'https://fcm.googleapis.com/x', 'k', 'a', NULL, 1, 0)");
      instance.ensureSchema();
      return {
        reminders: sql.exec<{ name: string }>("SELECT name FROM pragma_table_info('reminders')").toArray().map((c) => c.name),
        devices: sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM devices').one().n,
      };
    });
    expect(cols.reminders).toContain('doses');
    expect(cols.reminders).not.toContain('title');
    expect(cols.devices).toBe(0);
    const id = deviceId();
    await subscribe(id, await makeSubscriber());
    expect((await apiJson('push/reminders', { deviceId: id, reminders: [reminder('m', T0 + 60_000)] })).data).toEqual({ ok: true, count: 1 });
  });
});
