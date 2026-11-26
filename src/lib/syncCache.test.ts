// Signing out leaves none of this app's Firestore storage behind (removed once Firestore is closed),
// and none of another Firebase app's on the same origin is touched.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FIRESTORE_STORAGE_PREFIX as P } from './auth';

const calls: string[] = [];
const fsMock = vi.hoisted(() => ({
  initializeFirestore: vi.fn(() => ({})),
  getFirestore: vi.fn(() => ({})),
  persistentLocalCache: vi.fn(() => ({})),
  persistentMultipleTabManager: vi.fn(() => ({})),
  terminate: vi.fn(),
  clearIndexedDbPersistence: vi.fn(),
}));
const getFirebaseApp = vi.hoisted(() => vi.fn());
vi.mock('firebase/firestore', () => fsMock);
vi.mock('./auth', async (real) => ({ ...(await real<typeof import('./auth')>()), getFirebaseApp }));
vi.mock('./keyStore', () => ({
  forgetAllDeviceKeys: async () => {},
  forgetDeviceKey: async () => {},
  forgetDeviceKeyIf: async () => {},
  loadDeviceKey: async () => null,
  saveDeviceKey: async () => {},
}));
vi.mock('./localDb', () => ({ clearDecrypted: async () => {}, loadDecrypted: async () => null, saveDecrypted: async () => {} }));

const store = new Map<string, string>();
const PROJECT = P.split('/')[2];
// Every key format the SDK writes for this app (see WebStorageSharedClientState and IndexedDbPersistence).
const FIRESTORE_KEYS = [
  `firestore_clients_${P}_abc123`,
  `firestore_sequence_number_${P}`,
  `firestore_online_state_${P}`,
  `firestore_mutations_${P}_1`,
  `firestore_mutations_${P}_2_uid_with_underscores`,
  `firestore_targets_${P}_4`,
  `firestore_bundle_loaded_v2_${P}`,
  `firestore_zombie_${P}_abc123`,
];
/** Another Firebase app's, on the same origin (another project, a look-alike name, another app name). */
const FOREIGN_KEYS = [
  'firestore_mutations_firestore/[DEFAULT]/other-project/1',
  'firestore_clients_firestore/[DEFAULT]/other-project/_xyz',
  'firestore_sequence_number_firestore/[DEFAULT]/other-project/',
  `firestore_mutations_firestore/[DEFAULT]/${PROJECT}-staging/_1_uid1`,
  `firestore_online_state_firestore/haven/${PROJECT}/`,
];
const OWN_DB = `${P}main`;
const FOREIGN_DB = 'firestore/[DEFAULT]/other-project/main';
const KEPT = ['medtracker.lastSignIn', ...FOREIGN_KEYS].sort();

beforeEach(() => {
  vi.resetModules(); // a fresh sync.ts, with no Firestore opened yet
  vi.clearAllMocks();
  calls.length = 0;
  store.clear();
  for (const k of [...FIRESTORE_KEYS, ...FOREIGN_KEYS]) store.set(k, '{}');
  store.set('medtracker.lastSignIn', '{"at":1}');
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
    databases: async () => [{ name: OWN_DB }, { name: FOREIGN_DB }, { name: 'medtracker' }],
    deleteDatabase: (name: string) => {
      calls.push(`deleteDatabase ${name}`);
      const req: { onsuccess?: () => void; onerror?: () => void } = {};
      setTimeout(() => req.onsuccess?.());
      return req;
    },
  });
  fsMock.terminate.mockImplementation(async () => void calls.push('terminate'));
  fsMock.clearIndexedDbPersistence.mockImplementation(async () => void calls.push('clearIndexedDbPersistence'));
});
afterEach(() => vi.unstubAllGlobals());

const removedKeys = () => calls.filter((c) => c.startsWith('remove '));

describe('clearSyncCache', () => {
  it('uses the prefix Firestore derives from the app name and project id', () => {
    expect(P).toMatch(/^firestore\/\[DEFAULT\]\/[a-z0-9-]+\/$/);
  });

  it("removes this app's Firestore keys after Firestore is terminated and cleared, and nothing else", async () => {
    getFirebaseApp.mockResolvedValue({ app: {} });
    const { clearSyncCache } = await import('./sync');
    await clearSyncCache({ openFirst: true });
    expect([...store.keys()].sort()).toEqual(KEPT);
    const firstRemove = calls.findIndex((c) => c.startsWith('remove '));
    expect(firstRemove).toBeGreaterThan(calls.indexOf('terminate'));
    expect(firstRemove).toBeGreaterThan(calls.indexOf('clearIndexedDbPersistence'));
    expect(removedKeys()).toHaveLength(FIRESTORE_KEYS.length);
  });

  it("also removes them when Firestore can't be opened, after deleting only its own database", async () => {
    getFirebaseApp.mockRejectedValue(new Error('offline'));
    const { clearSyncCache } = await import('./sync');
    await clearSyncCache({ openFirst: true });
    expect(fsMock.terminate).not.toHaveBeenCalled();
    expect([...store.keys()].sort()).toEqual(KEPT);
    expect(calls.filter((c) => c.startsWith('deleteDatabase '))).toEqual([`deleteDatabase ${OWN_DB}`]);
    const deleted = calls.indexOf(`deleteDatabase ${OWN_DB}`);
    expect(calls.findIndex((c) => c.startsWith('remove '))).toBeGreaterThan(deleted);
  });
});


describe('Issue #8: clearSyncCache firestoreOnly and unlessSyncing', () => {
  it('firestoreOnly leaves medtracker-keys BroadcastChannel untouched while clearing Firestore storage, whereas default posts { uid: "*" }', async () => {
    const posted: unknown[] = [];
    vi.stubGlobal(
      'BroadcastChannel',
      class {
        postMessage(msg: unknown) {
          posted.push(msg);
        }
        addEventListener() {}
        removeEventListener() {}
        close() {}
      },
    );
    getFirebaseApp.mockResolvedValue({ app: {} });
    const { clearSyncCache } = await import('./sync');

    await expect(clearSyncCache({ openFirst: true, firestoreOnly: true })).resolves.toBe(true);
    expect([...store.keys()].sort()).toEqual(KEPT);
    expect(posted).toEqual([]);

    for (const k of FIRESTORE_KEYS) store.set(k, '{}');
    await expect(clearSyncCache({ openFirst: true })).resolves.toBe(true);
    expect([...store.keys()].sort()).toEqual(KEPT);
    expect(posted).toEqual([{ uid: '*' }]);
  });
});
