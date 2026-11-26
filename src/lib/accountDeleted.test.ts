// The account was deleted on another device while this one is busy with its local copy: clearing the
// device (store.deleteLocalData) must wait for a load, lock or unlock under way (they hold the load
// lock), so nothing of the account is written back after it. Real IndexedDB (fake-indexeddb), real
// WebCrypto, and a first-come-first-served Web Locks stand-in.
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';

const UID = 'u1';
const USER_ID = `firebase:${UID}`;
const KEY_ID = 'k1';

const med = (id: string): Medication => ({
  id,
  name: `Med ${id}`,
  dosage: '10 mg',
  form: 'Tablet',
  quantityPerDose: 1,
  color: '#0f766e',
  schedule: makeSchedule('daily', '2026-01-01'),
  notificationsEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});
const log = (id: string, medId: string): DoseLog => ({
  id,
  medId,
  scheduledFor: '2026-11-20T08:00:00.000Z',
  status: 'taken',
  loggedAt: '2026-11-20T08:01:00.000Z',
});
const data = (medications: Medication[], doseLogs: DoseLog[] = []): AppData => ({ version: 1, medications, doseLogs });
const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let db: typeof import('./localDb');
let seal: typeof import('./localSeal');
let store: typeof import('./store');

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
  });
  // Exclusive Web Locks, first come first served.
  const queues = new Map<string, Promise<unknown>>();
  vi.stubGlobal('navigator', {
    onLine: true,
    locks: {
      request(name: string, a: unknown, b?: unknown) {
        const fn = (typeof a === 'function' ? a : b) as () => Promise<unknown>;
        const run = (queues.get(name) ?? Promise.resolve()).catch(() => {}).then(() => fn());
        queues.set(name, run.catch(() => {}));
        return run;
      },
    },
  });
  db = await import('./localDb');
  seal = await import('./localSeal');
  store = await import('./store');
});

afterEach(() => {
  vi.doUnmock('./localDb');
  vi.unstubAllGlobals();
});

const DELAYS = [0, 1, 2, 3, 5, 8, 12, 20];

describe('clearing a device whose account was deleted elsewhere (C)', () => {
  it('waits for an unlock under way: nothing readable is written back, and the marker is gone', async () => {
    for (const delay of DELAYS) {
      await db.replaceAccount(USER_ID, data([med('m1'), med('m2')], [log('l1', 'm1')]));
      const key = await newKey();
      await seal.sealLocal(USER_ID, UID, key, KEY_ID);
      const unseal = seal.withLoadLock(USER_ID, () => seal.unsealLocal(USER_ID, UID, key, KEY_ID));
      await sleep(delay);
      await store.deleteLocalData(USER_ID);
      await unseal;
      const after = await db.loadAccount(USER_ID);
      expect(after.medications, `delay ${delay}`).toEqual([]);
      expect(after.doseLogs, `delay ${delay}`).toEqual([]);
      expect(await db.isSealed(USER_ID), `delay ${delay}`).toBe(false);
    }
  });

  it("waits for another tab's lock under way: no encrypted copy or marker is written back", async () => {
    for (const delay of DELAYS) {
      await db.replaceAccount(USER_ID, data([med('m1'), med('m2')], [log('l1', 'm1')]));
      const key = await newKey();
      await seal.sealLocal(USER_ID, UID, key, KEY_ID); // this tab locks the copy
      const second = seal.sealLocal(USER_ID, UID, key, KEY_ID); // another tab reacts to the same lock
      await sleep(delay);
      await store.deleteLocalData(USER_ID);
      await second;
      expect(await db.loadSealed(USER_ID, KEY_ID), `delay ${delay}`).toBeFalsy();
      expect(await db.isSealed(USER_ID), `delay ${delay}`).toBe(false);
      const after = await db.loadAccount(USER_ID);
      expect(after.medications).toEqual([]);
    }
  });
});

describe('deleteLocalData IndexedDB failure and fallback (#1)', () => {
  it('rejects when localDb.deleteAccount rejects while IndexedDB is available', async () => {
    vi.resetModules();
    vi.doMock('./localDb', async () => {
      const actual = await vi.importActual<typeof import('./localDb')>('./localDb');
      return {
        ...actual,
        deleteAccount: vi.fn().mockRejectedValueOnce(new Error('disk full')),
      };
    });
    const freshStore = await import('./store');
    await expect(freshStore.deleteLocalData(USER_ID)).rejects.toThrow('disk full');
  });

  it('resolves and clears legacy localStorage when IndexedDB is unavailable (localDbAvailable is false)', async () => {
    vi.resetModules();
    vi.stubGlobal('indexedDB', undefined);
    localStorage.setItem(`medtracker.data.${USER_ID}`, JSON.stringify(data([med('m1')])));
    const freshStore = await import('./store');
    await expect(freshStore.deleteLocalData(USER_ID)).resolves.toBeUndefined();
    expect(localStorage.getItem(`medtracker.data.${USER_ID}`)).toBeNull();
  });
});
