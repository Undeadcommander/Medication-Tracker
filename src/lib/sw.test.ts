import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

interface FakePushManager {
  getSubscription: ReturnType<typeof vi.fn>;
  subscribe: ReturnType<typeof vi.fn>;
}

interface SwHarness {
  listeners: Record<string, (event: unknown) => void>;
  showNotification: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
  clientFocus: ReturnType<typeof vi.fn>;
  clientPostMessage: ReturnType<typeof vi.fn>;
  clients: { url: string; focus: () => Promise<void>; postMessage: (msg: unknown) => void }[];
  fetch: ReturnType<typeof vi.fn>;
  pushManager?: FakePushManager;
}

function makeFakeIndexedDb(initial?: Record<string, Record<string, unknown>>) {
  const stores = new Map<string, Map<string, unknown>>();
  if (initial) {
    for (const [storeName, entries] of Object.entries(initial)) {
      stores.set(storeName, new Map(Object.entries(entries)));
    }
  }
  return {
    open: (_name: string, _version?: number) => {
      const req: {
        result?: unknown;
        onsuccess?: () => void;
        onerror?: () => void;
        onupgradeneeded?: () => void;
      } = {};
      const db = {
        objectStoreNames: {
          contains: (name: string) => stores.has(name),
        },
        createObjectStore: (name: string) => {
          if (!stores.has(name)) stores.set(name, new Map());
        },
        transaction: (storeName: string) => ({
          objectStore: (name: string) => {
            const target = stores.get(name ?? storeName);
            return {
              get: (key: string) => {
                const getReq: { result?: unknown; onsuccess?: () => void; onerror?: () => void } = {};
                queueMicrotask(() => {
                  if (!target) {
                    getReq.onerror?.();
                    return;
                  }
                  getReq.result = target.get(key);
                  getReq.onsuccess?.();
                });
                return getReq;
              },
            };
          },
        }),
        close: () => {},
      };
      req.result = db;
      queueMicrotask(() => {
        if (!stores.has('kv')) {
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return req;
    },
  };
}

function loadSw(opts?: {
  hasClients?: boolean;
  api?: string;
  indexedDB?: unknown;
  pushManager?: FakePushManager;
  fetch?: ReturnType<typeof vi.fn>;
}): SwHarness {
  const listeners: Record<string, (event: unknown) => void> = {};
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);
  const clientFocus = vi.fn(async () => {});
  const clientPostMessage = vi.fn();
  const fetchMock = opts?.fetch ?? vi.fn();
  const scope = 'https://app.example/';
  const href = opts?.api ? `${scope}sw.js?api=${encodeURIComponent(opts.api)}` : `${scope}sw.js`;
  const clients =
    opts?.hasClients === false
      ? []
      : [{ url: `${scope}index.html`, focus: clientFocus, postMessage: clientPostMessage }];

  const selfMock = {
    location: { href },
    registration: {
      scope,
      showNotification,
      ...(opts?.pushManager ? { pushManager: opts.pushManager } : {}),
    },
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn(async () => clients),
      openWindow,
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
    ...(opts?.indexedDB !== undefined ? { indexedDB: opts.indexedDB } : {}),
  };

  const swSource = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');
  runInNewContext(swSource, {
    self: selfMock,
    fetch: fetchMock,
    URL,
    Promise,
    indexedDB: opts?.indexedDB,
    console,
  });

  return {
    listeners,
    showNotification,
    openWindow,
    clientFocus,
    clientPostMessage,
    clients,
    fetch: fetchMock,
    pushManager: opts?.pushManager,
  };
}

async function fireWaitUntil(handler: (event: unknown) => void, event: Record<string, unknown>) {
  let pending: Promise<unknown> | undefined;
  handler({
    ...event,
    waitUntil: (p: Promise<unknown>) => {
      pending = p;
    },
  });
  await pending;
}

describe('public/sw.js grouped notification handling', () => {
  it('gives group push payloads only the snooze action and single payloads [take, snooze]', async () => {
    const sw = loadSw();

    await fireWaitUntil(sw.listeners.push, {
      data: {
        json: () => ({
          title: 'Time for your medications',
          body: '2 medications are due. Open Dosely to review them.',
          tag: 'a@1000',
          data: {
            medId: 'a',
            scheduledFor: '2026-06-10T09:30:00.000Z',
            reminder: {
              id: 'a@1000',
              medId: 'a',
              at: 1000,
              doses: [
                { medId: 'a', at: 1000 },
                { medId: 'b', at: 2000 },
              ],
            },
          },
        }),
      },
    });

    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [, groupOpts] = sw.showNotification.mock.calls[0] as [string, { actions: unknown[] }];
    expect(groupOpts.actions).toEqual([{ action: 'snooze', title: 'Snooze 10 min' }]);

    await fireWaitUntil(sw.listeners.push, {
      data: {
        json: () => ({
          title: 'Time for your medication',
          body: 'Open Dosely to review your dose.',
          tag: 'c@3000',
          data: {
            medId: 'c',
            scheduledFor: '2026-06-10T10:00:00.000Z',
            reminder: { id: 'c@3000', medId: 'c', at: 3000 },
          },
        }),
      },
    });

    expect(sw.showNotification).toHaveBeenCalledTimes(2);
    const [, singleOpts] = sw.showNotification.mock.calls[1] as [string, { actions: unknown[] }];
    expect(singleOpts.actions).toEqual([
      { action: 'take', title: 'Mark as taken' },
      { action: 'snooze', title: 'Snooze 10 min' },
    ]);
  });

  it('opens/focuses the app instead of posting dose-taken when take is clicked on a group', async () => {
    const sw = loadSw({ hasClients: true });
    await fireWaitUntil(sw.listeners.notificationclick, {
      action: 'take',
      notification: {
        close: vi.fn(),
        data: {
          medId: 'a',
          scheduledFor: '2026-06-10T09:30:00.000Z',
          reminder: {
            id: 'a@1000',
            medId: 'a',
            at: 1000,
            doses: [
              { medId: 'a', at: 1000 },
              { medId: 'b', at: 2000 },
            ],
          },
        },
      },
    });

    expect(sw.clientPostMessage).not.toHaveBeenCalled();
    expect(sw.clientFocus).toHaveBeenCalledTimes(1);
  });

  it('posts dose-taken for a single-dose take click and snooze-local for a group snooze click', async () => {
    const sw = loadSw({ hasClients: true });

    await fireWaitUntil(sw.listeners.notificationclick, {
      action: 'take',
      notification: {
        close: vi.fn(),
        data: {
          medId: 'c',
          scheduledFor: '2026-06-10T10:00:00.000Z',
          reminder: { id: 'c@3000', medId: 'c', at: 3000 },
        },
      },
    });
    expect(sw.clientPostMessage).toHaveBeenCalledWith({
      type: 'dose-taken',
      medId: 'c',
      scheduledFor: '2026-06-10T10:00:00.000Z',
    });

    const groupReminder = {
      id: 'a@1000',
      medId: 'a',
      at: 1000,
      doses: [
        { medId: 'a', at: 1000 },
        { medId: 'b', at: 2000 },
      ],
    };
    await fireWaitUntil(sw.listeners.notificationclick, {
      action: 'snooze',
      notification: {
        close: vi.fn(),
        data: { reminder: groupReminder },
      },
    });
    expect(sw.clientPostMessage).toHaveBeenLastCalledWith({
      type: 'snooze-local',
      reminder: groupReminder,
      minutes: 10,
    });
  });
});

describe('public/sw.js pushsubscriptionchange', () => {
  const api = 'https://srv.example/api';

  it('POSTs the newSubscription when present and deviceId is stored', async () => {
    const subJson = { endpoint: 'https://push.example/new', keys: { p256dh: 'k1', auth: 'a1' } };
    const fetchMock = vi.fn(async () => ({ ok: true }));
    const pushManager: FakePushManager = {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(),
    };
    const sw = loadSw({
      api,
      indexedDB: makeFakeIndexedDb({ kv: { deviceId: 'dev-123' } }),
      pushManager,
      fetch: fetchMock,
    });

    await fireWaitUntil(sw.listeners.pushsubscriptionchange, {
      newSubscription: { toJSON: () => subJson },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(`${api}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-123', subscription: subJson }),
    });
    expect(pushManager.subscribe).not.toHaveBeenCalled();
  });

  it('fetches public key, subscribes, and POSTs when newSubscription and current subscription are absent', async () => {
    const subJson = { endpoint: 'https://push.example/resub', keys: { p256dh: 'k2', auth: 'a2' } };
    const fetchMock = vi.fn(async (url: string) => {
      if (url === `${api}/push/public-key`) {
        return { ok: true, json: async () => ({ publicKey: 'vapid-key-b64url' }) };
      }
      return { ok: true };
    });
    const pushManager: FakePushManager = {
      getSubscription: vi.fn(async () => null),
      subscribe: vi.fn(async () => ({ toJSON: () => subJson })),
    };
    const sw = loadSw({
      api,
      indexedDB: makeFakeIndexedDb({ kv: { deviceId: 'dev-456' } }),
      pushManager,
      fetch: fetchMock,
    });

    await fireWaitUntil(sw.listeners.pushsubscriptionchange, { newSubscription: null });

    expect(pushManager.getSubscription).toHaveBeenCalledTimes(1);
    expect(pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: 'vapid-key-b64url',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(1, `${api}/push/public-key`);
    expect(fetchMock).toHaveBeenNthCalledWith(2, `${api}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId: 'dev-456', subscription: subJson }),
    });
  });

  it('does not fetch when no deviceId is stored', async () => {
    const fetchMock = vi.fn();
    const sw = loadSw({
      api,
      indexedDB: makeFakeIndexedDb({}),
      pushManager: { getSubscription: vi.fn(), subscribe: vi.fn() },
      fetch: fetchMock,
    });

    await fireWaitUntil(sw.listeners.pushsubscriptionchange, {
      newSubscription: { toJSON: () => ({ endpoint: 'https://push.example/x' }) },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not fetch when ?api= is absent', async () => {
    const fetchMock = vi.fn();
    const sw = loadSw({
      indexedDB: makeFakeIndexedDb({ kv: { deviceId: 'dev-789' } }),
      pushManager: { getSubscription: vi.fn(), subscribe: vi.fn() },
      fetch: fetchMock,
    });

    await fireWaitUntil(sw.listeners.pushsubscriptionchange, {
      newSubscription: { toJSON: () => ({ endpoint: 'https://push.example/y' }) },
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });
});
