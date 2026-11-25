// This device's copy of each account's sync data key: a non-extractable CryptoKey kept in its own
// IndexedDB database (Firestore's offline cache can't store CryptoKey objects). Being
// non-extractable, the key can be used for encryption here but its bytes can't be read back out,
// even by the app's own code.

const DB_NAME = 'medtracker-keys';
const STORE = 'keys';

export interface StoredKey {
  key: CryptoKey;
  /** CryptoMeta.keyId of the account key this is. */
  keyId: string;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    req.onblocked = () => reject(new Error('IndexedDB is blocked by another tab'));
  });
}

async function run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
  const db = await openDb();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      let result: T | undefined;
      if (req) req.onsuccess = () => (result = req.result);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error ?? new Error('IndexedDB error'));
      tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted'));
    });
  } finally {
    db.close();
  }
}

export async function loadDeviceKey(uid: string): Promise<StoredKey | null> {
  try {
    const v = (await run<unknown>('readonly', (s) => s.get(uid))) as Partial<StoredKey> | undefined;
    return v && v.key instanceof CryptoKey && typeof v.keyId === 'string' ? { key: v.key, keyId: v.keyId } : null;
  } catch {
    return null;
  }
}

export async function saveDeviceKey(uid: string, value: StoredKey): Promise<void> {
  if (value.key.extractable) throw new Error('Only non-extractable keys are stored');
  await run('readwrite', (s) => s.put(value, uid));
}

export async function forgetDeviceKey(uid: string): Promise<void> {
  try {
    await run('readwrite', (s) => s.delete(uid));
  } catch {
    /* nothing stored */
  }
}

/** Sign-out: forget every account's key on this device. */
export async function forgetAllDeviceKeys(): Promise<void> {
  try {
    await run('readwrite', (s) => s.clear());
  } catch {
    /* nothing stored */
  }
}

/** Forget the stored key only if it's the one with this keyId (one transaction, so a newer key saved meanwhile is kept). */
export async function forgetDeviceKeyIf(uid: string, keyId: string): Promise<void> {
  try {
    await run('readwrite', (s) => {
      const req = s.get(uid);
      req.onsuccess = () => {
        if ((req.result as Partial<StoredKey> | undefined)?.keyId === keyId) s.delete(uid);
      };
    });
  } catch {
    /* nothing stored */
  }
}
