import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRESTORE_STORAGE_PREFIX as P } from './auth';

const calls: string[] = [];
const channelMessages: unknown[] = [];

const fsMock = vi.hoisted(() => ({
  initializeFirestore: vi.fn(() => {
    calls.push('initializeFirestore');
    return {};
  }),
  getFirestore: vi.fn(() => ({})),
  persistentLocalCache: vi.fn(() => ({})),
  persistentMultipleTabManager: vi.fn(() => ({})),
  terminate: vi.fn(),
  clearIndexedDbPersistence: vi.fn(),
  doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
  collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
  onSnapshot: vi.fn(() => () => {}),
}));
const getFirebaseApp = vi.hoisted(() => vi.fn(async () => ({ app: {} })));
const forgetAllDeviceKeys = vi.hoisted(() => vi.fn(async () => void calls.push('forgetAllDeviceKeys')));
const clearDecrypted = vi.hoisted(() => vi.fn(async () => void calls.push('clearDecrypted')));

vi.mock('firebase/firestore', () => fsMock);
vi.mock('./auth', async (real) => ({ ...(await real<typeof import('./auth')>()), getFirebaseApp }));
vi.mock('./keyStore', () => ({
  forgetAllDeviceKeys,
  forgetDeviceKey: vi.fn(async () => {}),
  forgetDeviceKeyIf: vi.fn(async () => {}),
  loadDeviceKey: vi.fn(async () => null),
  saveDeviceKey: vi.fn(async () => {}),
}));
vi.mock('./localDb', () => ({
  clearDecrypted,
  loadDecrypted: vi.fn(async () => new Map()),
  saveDecrypted: vi.fn(async () => {}),
}));

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

class FakeBroadcastChannel {
  name: string;
  constructor(name: string) {
    this.name = name;
  }
  postMessage(msg: unknown) {
    channelMessages.push({ channel: this.name, msg });
  }
  addEventListener() {}
  removeEventListener() {}
  close() {}
}

const store = new Map<string, string>();
const OWN_KEY = `firestore_clients_${P}_abc123`;
const KEEP_KEY = 'medtracker.lastSignIn';

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  calls.length = 0;
  channelMessages.length = 0;
  store.clear();
  store.set(OWN_KEY, '{}');
  store.set(KEEP_KEY, '{"at":1}');

  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel);
  vi.stubGlobal('localStorage', {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => {
      if (store.delete(k)) calls.push(`remove ${k}`);
    },
  });
  vi.stubGlobal('indexedDB', {
    databases: async () => [{ name: `${P}main` }],
    deleteDatabase: () => {
      const req: { onsuccess?: () => void; onerror?: () => void } = {};
      setTimeout(() => req.onsuccess?.());
      return req;
    },
  });
  fsMock.initializeFirestore.mockImplementation(() => {
    calls.push('initializeFirestore');
    return {};
  });
  fsMock.terminate.mockImplementation(async () => void calls.push('terminate'));
  fsMock.clearIndexedDbPersistence.mockImplementation(async () => void calls.push('clearIndexedDbPersistence'));
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Issue #8: clearSyncCache serialization, unlessSyncing, and firestoreOnly', () => {
  it('(a) delays getDb() for startSync and preloadSync until an in-flight clearSyncCache finishes', async () => {
    const clearGate = deferredVoid();
    let clearEntered = false;
    fsMock.clearIndexedDbPersistence.mockImplementationOnce(async () => {
      clearEntered = true;
      calls.push('clearIndexedDbPersistence:start');
      await clearGate.promise;
      calls.push('clearIndexedDbPersistence:end');
    });

    const { clearSyncCache, preloadSync, startSync } = await import('./sync');
    const clearPromise = clearSyncCache({ openFirst: true });

    await vi.waitFor(() => {
      expect(clearEntered).toBe(true);
    });
    expect(fsMock.initializeFirestore).toHaveBeenCalledTimes(1);

    preloadSync();
    const handle = startSync({
      uid: 'u1',
      getLocal: () => ({ version: 1, medications: [], doseLogs: [] }),
      applyRemote: () => {},
      onStatus: () => {},
    });

    try {
      // Let microtasks and a macrotask tick run while clearSyncCache is still blocked.
      await new Promise((r) => setTimeout(r, 20));
      expect(fsMock.initializeFirestore).toHaveBeenCalledTimes(1);

      clearGate.resolve();
      await expect(clearPromise).resolves.toBe(true);

      await vi.waitFor(() => {
        expect(fsMock.initializeFirestore).toHaveBeenCalledTimes(2);
      });
      const clearEndIdx = calls.indexOf('clearIndexedDbPersistence:end');
      const secondInitIdx = calls.lastIndexOf('initializeFirestore');
      expect(clearEndIdx).toBeGreaterThan(-1);
      expect(secondInitIdx).toBeGreaterThan(clearEndIdx);
    } finally {
      handle.stop();
    }
  });

  it('(b) unlessSyncing resolves false without clearing while startSync is running, then clears after stop()', async () => {
    const { clearSyncCache, startSync } = await import('./sync');
    const handle = startSync({
      uid: 'u1',
      getLocal: () => ({ version: 1, medications: [], doseLogs: [] }),
      applyRemote: () => {},
      onStatus: () => {},
    });

    await vi.waitFor(() => {
      expect(fsMock.initializeFirestore).toHaveBeenCalledTimes(1);
    });

    const whileRunning = await clearSyncCache({ openFirst: true, unlessSyncing: true });
    expect(whileRunning).toBe(false);
    expect(fsMock.terminate).not.toHaveBeenCalled();
    expect(fsMock.clearIndexedDbPersistence).not.toHaveBeenCalled();
    expect(forgetAllDeviceKeys).not.toHaveBeenCalled();
    expect(clearDecrypted).not.toHaveBeenCalled();
    expect(channelMessages).toEqual([]);
    expect(store.has(OWN_KEY)).toBe(true);

    handle.stop();

    const afterStop = await clearSyncCache({ openFirst: true, unlessSyncing: true });
    expect(afterStop).toBe(true);
    expect(fsMock.terminate).toHaveBeenCalledTimes(1);
    expect(fsMock.clearIndexedDbPersistence).toHaveBeenCalledTimes(1);
    expect(forgetAllDeviceKeys).toHaveBeenCalledTimes(1);
    expect(clearDecrypted).toHaveBeenCalledTimes(1);
    expect(store.has(OWN_KEY)).toBe(false);
    expect(store.has(KEEP_KEY)).toBe(true);
  });

  it('(c) firestoreOnly clears Firestore cache without touching device keys, decrypted items, or medtracker-keys channel', async () => {
    const { clearSyncCache } = await import('./sync');

    const ran = await clearSyncCache({ openFirst: true, firestoreOnly: true });
    expect(ran).toBe(true);
    expect(fsMock.terminate).toHaveBeenCalledTimes(1);
    expect(fsMock.clearIndexedDbPersistence).toHaveBeenCalledTimes(1);
    expect(store.has(OWN_KEY)).toBe(false);
    expect(store.has(KEEP_KEY)).toBe(true);

    expect(forgetAllDeviceKeys).not.toHaveBeenCalled();
    expect(clearDecrypted).not.toHaveBeenCalled();
    expect(channelMessages).toEqual([]);
  });
});
