// This device's copy of a locked account (localSeal.ts) and its storage (localDb.ts), against a real
// IndexedDB implementation (fake-indexeddb) and real WebCrypto.
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';

const UID = 'u1';
const USER_ID = `firebase:${UID}`;
const KEY_ID = 'k1';

const med = (id: string, over: Partial<Medication> = {}): Medication => ({
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
  ...over,
});
const log = (id: string, medId: string): DoseLog => ({
  id,
  medId,
  scheduledFor: '2026-11-20T08:00:00.000Z',
  status: 'taken',
  loggedAt: '2026-11-20T08:01:00.000Z',
});
const data = (medications: Medication[], doseLogs: DoseLog[] = []): AppData => ({ version: 1, medications, doseLogs });
const ids = (d: AppData) => ({ meds: d.medications.map((m) => m.id).sort(), logs: d.doseLogs.map((l) => l.id).sort() });

const newKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);

let storage: Map<string, string>;
let db: typeof import('./localDb');
let seal: typeof import('./localSeal');

beforeEach(async () => {
  vi.resetModules();
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  storage = new Map();
  vi.stubGlobal('localStorage', {
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
  });
  db = await import('./localDb');
  seal = await import('./localSeal');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Open the raw database at `version` with `setup` (the layout of an older version of the app). */
function openRaw(version: number, setup?: (d: IDBDatabase) => void): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('medtracker-data', version);
    req.onupgradeneeded = () => setup?.(req.result);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
function put(d: IDBDatabase, store: string, value: unknown, key: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = d.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

/** A readable write by an older version of the app (in another tab), which doesn't check the sealed mark. */
async function oldTabWrite(medications: Medication[], doseLogs: DoseLog[] = []): Promise<void> {
  const d = await openRaw(3);
  for (const m of medications) await put(d, 'meds', m, `${USER_ID}\u0000${m.id}`);
  for (const l of doseLogs) await put(d, 'medLogs', [l], `${USER_ID}\u0000${l.medId}`);
  d.close();
}
const k = (owner: string, id: string) => `${owner}\u0000${id}`;

describe('localDb upgrades to v3', () => {
  it('from v1 (pre-release: one record per log): keeps medications, adds the new stores, drops the old one', async () => {
    const raw = await openRaw(1, (d) => {
      d.createObjectStore('meds');
      d.createObjectStore('logs');
    });
    await put(raw, 'meds', med('a'), k(USER_ID, 'a'));
    await put(raw, 'logs', log('1', 'a'), k(USER_ID, '1'));
    raw.close();

    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['a'], logs: [] });
    const after = await openRaw(3);
    expect([...after.objectStoreNames].sort()).toEqual(['decrypted', 'medLogs', 'meds', 'sealed']);
    expect(after.version).toBe(3);
    after.close();
  });

  it('from v2: keeps medications, logs and the decrypted cache, and adds the sealed store', async () => {
    const raw = await openRaw(2, (d) => {
      for (const s of ['meds', 'medLogs', 'decrypted']) d.createObjectStore(s);
    });
    await put(raw, 'meds', med('a'), k(USER_ID, 'a'));
    await put(raw, 'medLogs', [log('1', 'a')], k(USER_ID, 'a'));
    await put(raw, 'decrypted', { x: 1 }, k(UID, 'k1|m|a'));
    raw.close();

    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['a'], logs: ['1'] });
    expect([...(await db.loadDecrypted(UID)).keys()]).toEqual(['k1|m|a']);
    await db.storeSealed(USER_ID, KEY_ID, { v: 1, test: true }, await db.loadAccount(USER_ID));
    expect(await db.loadSealed(USER_ID, KEY_ID)).toEqual({ v: 1, test: true });
  });
});

describe('localDb encrypted copies', () => {
  it('storeSealed replaces the readable copy only if it is still what was encrypted', async () => {
    await db.replaceAccount(USER_ID, data([med('a')], [log('1', 'a')]));
    const snapshot = await db.loadAccount(USER_ID);
    await db.writeChanges(USER_ID, { ...db.NO_CHANGES, putMeds: [med('b')] }); // another tab, meanwhile
    expect(await db.storeSealed(USER_ID, KEY_ID, { v: 1 }, snapshot)).toBe(false);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['a', 'b'], logs: ['1'] });
    expect(await db.loadSealed(USER_ID, KEY_ID)).toBeUndefined();

    expect(await db.storeSealed(USER_ID, KEY_ID, { v: 1 }, await db.loadAccount(USER_ID))).toBe(true);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: [], logs: [] });
    expect(await db.loadSealed(USER_ID, KEY_ID)).toEqual({ v: 1 });
  });

  it("only touches its own account's records", async () => {
    await db.replaceAccount(USER_ID, data([med('a')]));
    await db.replaceAccount('guest', data([med('g')]));
    await db.storeSealed(USER_ID, KEY_ID, { v: 1 }, await db.loadAccount(USER_ID));
    expect(ids(await db.loadAccount('guest'))).toEqual({ meds: ['g'], logs: [] });
  });

  it('restoreSealed puts the readable copy back and removes the encrypted one', async () => {
    await db.storeSealed(USER_ID, KEY_ID, { v: 1 }, data([]));
    await db.restoreSealed(USER_ID, KEY_ID, data([med('a')], [log('1', 'a')]));
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['a'], logs: ['1'] });
    expect(await db.loadSealed(USER_ID, KEY_ID)).toBeUndefined();
  });

  it('deleteAccount keeps the encrypted copy only when asked to', async () => {
    await db.storeSealed(USER_ID, KEY_ID, { v: 1 }, data([]));
    await oldTabWrite([med('a')]);
    await db.deleteAccount(USER_ID, { keepSealed: true });
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: [], logs: [] });
    expect(await db.loadSealed(USER_ID, KEY_ID)).toEqual({ v: 1 });
    await db.deleteAccount(USER_ID);
    expect(await db.loadSealed(USER_ID, KEY_ID)).toBeUndefined();
  });

  it('deleteAccount removes the sealed mark unless keepSealed is set', async () => {
    await db.storeSealed(USER_ID, KEY_ID, { v: 1 }, data([]));
    expect(await db.isSealed(USER_ID)).toBe(true);
    await db.deleteAccount(USER_ID, { keepSealed: true });
    expect(await db.isSealed(USER_ID)).toBe(true);
    await db.deleteAccount(USER_ID);
    expect(await db.isSealed(USER_ID)).toBe(false);
  });
});

describe('sealLocal / unsealLocal', () => {
  it('round trip: nothing readable is left, and the same key brings it all back', async () => {
    const key = await newKey();
    await db.replaceAccount(USER_ID, data([med('a', { name: 'Lisinopril' })], [log('1', 'a')]));
    expect(await seal.sealLocal(USER_ID, UID, key, KEY_ID)).toBe(true);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: [], logs: [] });
    const sealed = await db.loadSealed<{ ct: ArrayBuffer }>(USER_ID, KEY_ID);
    expect(sealed?.ct).toBeInstanceOf(ArrayBuffer);
    expect(new TextDecoder().decode(sealed!.ct)).not.toContain('Lisinopril');

    await seal.unsealLocal(USER_ID, UID, key, KEY_ID);
    const back = await db.loadAccount(USER_ID);
    expect(ids(back)).toEqual({ meds: ['a'], logs: ['1'] });
    expect(back.medications[0]!.name).toBe('Lisinopril');
    expect(await db.loadSealed(USER_ID, KEY_ID)).toBeUndefined();
  });

  it('merges into an encrypted copy already there (and keeps what was readable as the newer)', async () => {
    const key = await newKey();
    await db.replaceAccount(USER_ID, data([med('a')]));
    await seal.sealLocal(USER_ID, UID, key, KEY_ID);
    // Written readable later (by a tab of an older version, which hadn't locked yet).
    await oldTabWrite([med('b')], [log('2', 'b')]);
    await seal.sealLocal(USER_ID, UID, key, KEY_ID);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: [], logs: [] });
    await seal.unsealLocal(USER_ID, UID, key, KEY_ID);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['a', 'b'], logs: ['2'] });
  });

  it('includes (and removes) the old localStorage copy', async () => {
    const key = await newKey();
    storage.set(seal.legacyDataKey(USER_ID), JSON.stringify(data([med('old')])));
    await db.replaceAccount(USER_ID, data([med('a')]));
    await seal.sealLocal(USER_ID, UID, key, KEY_ID);
    expect(storage.has(seal.legacyDataKey(USER_ID))).toBe(false);
    await seal.unsealLocal(USER_ID, UID, key, KEY_ID);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['a', 'old'], logs: [] });
  });

  it('a wrong key (or a damaged copy) leaves the encrypted copy as it is', async () => {
    const key = await newKey();
    await db.replaceAccount(USER_ID, data([med('a')]));
    await seal.sealLocal(USER_ID, UID, key, KEY_ID);
    const before = await db.loadSealed<{ ct: ArrayBuffer; iv: Uint8Array }>(USER_ID, KEY_ID);

    await seal.unsealLocal(USER_ID, UID, await newKey(), KEY_ID);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: [], logs: [] });
    expect(await db.loadSealed(USER_ID, KEY_ID)).toEqual(before);

    const tampered = new Uint8Array(before!.ct.slice(0));
    tampered[0] ^= 1;
    await db.storeSealed(USER_ID, KEY_ID, { ...before, ct: tampered.buffer }, data([]));
    await seal.unsealLocal(USER_ID, UID, key, KEY_ID);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: [], logs: [] });
    expect((await db.loadSealed<{ ct: ArrayBuffer }>(USER_ID, KEY_ID))?.ct.byteLength).toBe(tampered.byteLength);
  });

  it('discardReadable removes only the readable copy', async () => {
    const key = await newKey();
    await db.replaceAccount(USER_ID, data([med('a')]));
    await seal.sealLocal(USER_ID, UID, key, KEY_ID);
    await oldTabWrite([med('b')]);
    storage.set(seal.legacyDataKey(USER_ID), JSON.stringify(data([med('c')])));
    await seal.discardReadable(USER_ID);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: [], logs: [] });
    expect(storage.has(seal.legacyDataKey(USER_ID))).toBe(false);
    await seal.unsealLocal(USER_ID, UID, key, KEY_ID);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['a'], logs: [] });
  });

  // Finding 1: another tab saving an edit while this one encrypts must not lose it.
  it("keeps an edit another tab saves while it's being encrypted", async () => {
    const key = await newKey();
    await db.replaceAccount(USER_ID, data([med('med-1')]));
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let injected = false;
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      if (!injected) {
        injected = true;
        await db.writeChanges(USER_ID, { ...db.NO_CHANGES, putMeds: [med('med-2')], putLogs: [log('l2', 'med-2')] });
      }
      return encrypt(...args);
    });
    expect(await seal.sealLocal(USER_ID, UID, key, KEY_ID)).toBe(true);
    expect(injected).toBe(true);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: [], logs: [] });
    await seal.unsealLocal(USER_ID, UID, key, KEY_ID);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['med-1', 'med-2'], logs: ['l2'] });
  });

  it('gives up (throws, changing nothing) if edits keep arriving', async () => {
    const key = await newKey();
    await db.replaceAccount(USER_ID, data([med('a')]));
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let n = 0;
    vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      await db.writeChanges(USER_ID, { ...db.NO_CHANGES, putMeds: [med(`x${n++}`)] });
      return encrypt(...args);
    });
    await expect(seal.sealLocal(USER_ID, UID, key, KEY_ID)).rejects.toThrow();
    expect((await db.loadAccount(USER_ID)).medications.length).toBeGreaterThan(1);
    expect(await db.loadSealed(USER_ID, KEY_ID)).toBeUndefined();
  });

  it('locks the readable copy against writes until unsealed', async () => {
    const key = await newKey();
    await db.replaceAccount(USER_ID, data([med('a')], [log('1', 'a')]));
    await seal.sealLocal(USER_ID, UID, key, KEY_ID);
    expect(await db.isSealed(USER_ID)).toBe(true);
    const sealedBefore = await db.loadSealed(USER_ID, KEY_ID);

    await expect(db.writeChanges(USER_ID, { ...db.NO_CHANGES, putMeds: [med('b')] })).rejects.toBeInstanceOf(db.LocalCopyLockedError);
    await expect(db.replaceAccount(USER_ID, data([med('b')]))).rejects.toBeInstanceOf(db.LocalCopyLockedError);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: [], logs: [] });
    expect(await db.loadSealed(USER_ID, KEY_ID)).toEqual(sealedBefore);

    await seal.unsealLocal(USER_ID, UID, key, KEY_ID);
    expect(await db.isSealed(USER_ID)).toBe(false);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['a'], logs: ['1'] });

    await db.writeChanges(USER_ID, { ...db.NO_CHANGES, putMeds: [med('b')] });
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['a', 'b'], logs: ['1'] });
    await db.replaceAccount(USER_ID, data([med('c')]));
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['c'], logs: [] });
  });

  it('sets the sealed mark even when there is nothing to seal, and unsealLocal with no sealed copy clears it', async () => {
    const key = await newKey();
    expect(await seal.sealLocal(USER_ID, UID, key, KEY_ID)).toBe(true);
    expect(await db.loadSealed(USER_ID, KEY_ID)).toBeUndefined();
    expect(await db.isSealed(USER_ID)).toBe(true);
    await expect(db.writeChanges(USER_ID, { ...db.NO_CHANGES, putMeds: [med('a')] })).rejects.toBeInstanceOf(db.LocalCopyLockedError);

    await seal.unsealLocal(USER_ID, UID, key, KEY_ID);
    expect(await db.isSealed(USER_ID)).toBe(false);
    await db.writeChanges(USER_ID, { ...db.NO_CHANGES, putMeds: [med('a')] });
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['a'], logs: [] });
  });

  it('aborts when unless returns true, leaving readable data and no sealed copy or mark', async () => {
    const key = await newKey();
    await db.replaceAccount(USER_ID, data([med('a')], [log('1', 'a')]));
    await expect(seal.sealLocal(USER_ID, UID, key, KEY_ID, { unless: async () => true })).rejects.toThrow();
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['a'], logs: ['1'] });
    expect(await db.loadSealed(USER_ID, KEY_ID)).toBeUndefined();
    expect(await db.isSealed(USER_ID)).toBe(false);
  });

  it('applies queued deletions (and ignores tidy refs) when unsealing', async () => {
    const key = await newKey();
    await db.replaceAccount(USER_ID, data([med('a'), med('b')], [log('1', 'a'), log('2', 'b')]));
    await seal.sealLocal(USER_ID, UID, key, KEY_ID);
    storage.set(
      `medtracker.syncq.${UID}`,
      JSON.stringify([
        { id: 'q1', ref: { kind: 'med', id: 'a', del: true } },
        { id: 'q2', ref: { kind: 'med', id: 'b' } },
      ]),
    );

    await seal.unsealLocal(USER_ID, UID, key, KEY_ID);
    expect(ids(await db.loadAccount(USER_ID))).toEqual({ meds: ['b'], logs: ['2'] });
  });
});
