// The push server must hear about every subscription the browser hands out, including a rotated
// one (new endpoint/keys under the same VAPID key), and a build without a server stays local.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const NOW = new Date(2026, 5, 10, 9, 0, 0).getTime();
const VAPID = new Uint8Array([1, 2, 3]); // "AQID"

interface FakeSub {
  options: { applicationServerKey: ArrayBuffer };
  toJSON: () => { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } };
  unsubscribe: () => Promise<boolean>;
}

function fakeSub(endpoint: string, p256dh = 'p1'): FakeSub {
  return {
    options: { applicationServerKey: VAPID.buffer },
    toJSON: () => ({ endpoint, expirationTime: null, keys: { p256dh, auth: 'a1' } }),
    unsubscribe: async () => true,
  };
}

let current: FakeSub | null;
let showNotification: ReturnType<typeof vi.fn<(...a: unknown[]) => Promise<void>>>;
let subscribes: Array<{ endpoint: string }>;
let fetchMock: ReturnType<typeof vi.fn>;

function stubBrowser(apiBase: string) {
  const store = new Map<string, string>();
  const reg = {
    active: {},
    showNotification: (...a: unknown[]) => showNotification(...a),
    pushManager: { getSubscription: async () => current },
  };
  vi.stubEnv('VITE_API_BASE', apiBase);
  vi.stubGlobal('location', { href: 'https://app.example/' });
  vi.stubGlobal('window', {
    Notification: {},
    PushManager: {},
    addEventListener: () => {},
    matchMedia: () => ({ matches: true }),
    dispatchEvent: () => true,
  });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {} });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('Notification', { permission: 'granted' });
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    platform: 'x',
    serviceWorker: { register: async () => reg, ready: new Promise(() => {}), addEventListener: () => {} },
  });
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.endsWith('/push/public-key')) return { ok: true, status: 200, json: async () => ({ publicKey: 'AQID' }) };
    if (url.endsWith('/push/subscribe') && init?.method === 'POST') {
      subscribes.push((JSON.parse(init.body ?? '{}') as { subscription: { endpoint: string } }).subscription);
      return { ok: true, status: 200, json: async () => ({ ok: true }) };
    }
    if (url.endsWith('/push/reminders')) return { ok: true, status: 200, json: async () => ({ ok: true, count: 0 }) };
    return { ok: false, status: 404, json: async () => ({}) };
  });
  vi.stubGlobal('fetch', fetchMock);
}

async function load() {
  vi.resetModules();
  return import('./push');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  current = null;
  subscribes = [];
  showNotification = vi.fn(async (..._a: unknown[]) => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('subscription registration', () => {
  it('re-registers a subscription the browser rotated under the same VAPID key, once', async () => {
    stubBrowser('https://srv.example/api');
    current = fakeSub('https://push.example/one');
    const { syncReminders } = await load();

    // Registered by an older app version (nothing recorded yet): sent once, then remembered.
    expect((await syncReminders([], [])).mode).toBe('push');
    expect(subscribes.map((s) => s.endpoint)).toEqual(['https://push.example/one']);
    await syncReminders([], []);
    expect(subscribes).toHaveLength(1);

    current = fakeSub('https://push.example/two', 'p2');
    expect((await syncReminders([], [])).mode).toBe('push');
    expect(subscribes.map((s) => s.endpoint)).toEqual(['https://push.example/one', 'https://push.example/two']);
    await syncReminders([], []);
    expect(subscribes).toHaveLength(2);
  });

  it('a build without a reminder server shows the test notification locally, even with a leftover subscription', async () => {
    stubBrowser('none');
    current = fakeSub('https://push.example/left-over');
    const { sendTestNotification } = await load();
    await sendTestNotification();
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
