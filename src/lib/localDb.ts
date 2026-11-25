// This device's copy of each account's medications and dose history, in IndexedDB: one record per
// item, so an edit writes only what changed. (It used to be one localStorage string rewritten on
// every tap, which slowed down as history grew and ran out of room at a few MB.) A medication's
// dose logs are kept together in one record, which loads far faster than one record per log. Also
// holds the cloud sync's cache of decrypted items, so a launch doesn't decrypt everything again.
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { diffById } from './arrayDiff';
import { mergeMed } from './supply';

/** Two versions of one log: the newer action wins (ties: the second). */
const newerLog = (a: DoseLog, b: DoseLog) => (Date.parse(a.loggedAt) > Date.parse(b.loggedAt) ? a : b);

const DB_NAME = 'medtracker-data';
const DB_VERSION = 2;
const MEDS = 'meds';
/** One record per medication: all of its dose logs. */
const LOGS = 'medLogs';
const DECRYPTED = 'decrypted';

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('IndexedDB is not available'));
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of [MEDS, LOGS, DECRYPTED]) if (!db.objectStoreNames.contains(s)) db.createObjectStore(s);
      if (db.objectStoreNames.contains('logs')) db.deleteObjectStore('logs'); // one record per log (pre-release layout)
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer version of the app (another tab) wants to upgrade: let it.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    // onblocked: an older tab still has it open; it closes on `versionchange`, then this succeeds.
  }).catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

const SEP = '\u0000';
const key = (owner: string, id: string) => owner + SEP + id;
const range = (owner: string) => IDBKeyRange.bound(owner + SEP, owner + SEP + '￿');

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('IndexedDB error'));
    tx.onabort = () => reject(tx.error ?? new Error('IndexedDB aborted'));
  });
}

function getAll<T>(store: IDBObjectStore, owner: string): Promise<T[]> {
  return new Promise((resolve, reject) => {
    const req = store.getAll(range(owner));
    req.onsuccess = () => resolve(req.result as T[]);
    req.onerror = () => reject(req.error);
  });
}

/** True if IndexedDB can be used here (it can't in a few private-browsing modes). */
export async function localDbAvailable(): Promise<boolean> {
  try {
    await openDb();
    return true;
  } catch {
    return false;
  }
}

export async function loadAccount(userId: string): Promise<AppData> {
  const db = await openDb();
  const tx = db.transaction([MEDS, LOGS], 'readonly');
  const [medications, perMed] = await Promise.all([
    getAll<Medication>(tx.objectStore(MEDS), userId),
    getAll<DoseLog[]>(tx.objectStore(LOGS), userId),
  ]);
  return { version: 1, medications, doseLogs: perMed.flat() };
}

/** What changed between two versions of an account's data, item by item. */
export interface Changes {
  putMeds: Medication[];
  delMeds: string[];
  putLogs: DoseLog[];
  delLogs: Pick<DoseLog, 'id' | 'medId'>[];
}

export const NO_CHANGES: Changes = { putMeds: [], delMeds: [], putLogs: [], delLogs: [] };

export function hasChanges(c: Changes): boolean {
  return !!(c.putMeds.length || c.delMeds.length || c.putLogs.length || c.delLogs.length);
}

export function changesBetween(prev: AppData, next: AppData): Changes {
  const m = diffById(prev.medications, next.medications);
  const l = diffById(prev.doseLogs, next.doseLogs);
  return {
    putMeds: m.put,
    delMeds: m.del.map((x) => x.id),
    putLogs: l.put,
    delLogs: l.del.map((x) => ({ id: x.id, medId: x.medId })),
  };
}

/**
 * Apply changes from another tab to data, reusing unchanged items. A medication or log both tabs
 * changed is merged (medications field by field, logs by newer action), not replaced.
 */
export function applyChanges(data: AppData, c: Changes): AppData {
  if (!hasChanges(c)) return data;
  const merge = <T extends { id: string }>(items: T[], put: T[], del: string[], combine: (mine: T, theirs: T) => T): T[] => {
    if (!put.length && !del.length) return items;
    const gone = new Set(del);
    const byId = new Map(put.map((x) => [x.id, x]));
    const out: T[] = [];
    for (const x of items) {
      if (gone.has(x.id)) continue;
      const p = byId.get(x.id);
      out.push(p ? combine(x, p) : x);
      if (p) byId.delete(x.id);
    }
    for (const p of byId.values()) out.push(p);
    return out;
  };
  return {
    version: 1,
    medications: merge(data.medications, c.putMeds, c.delMeds, mergeMed),
    doseLogs: merge(data.doseLogs, c.putLogs, c.delLogs.map((l) => l.id), newerLog),
  };
}

export async function writeChanges(userId: string, c: Changes): Promise<void> {
  if (!hasChanges(c)) return;
  const db = await openDb();
  const tx = db.transaction([MEDS, LOGS], 'readwrite');
  const meds = tx.objectStore(MEDS);
  const logs = tx.objectStore(LOGS);
  // Merged with what's stored, in case another tab changed the same item meanwhile.
  for (const m of c.putMeds) {
    const k = key(userId, m.id);
    const req = meds.get(k);
    req.onsuccess = () => meds.put(req.result ? mergeMed(req.result as Medication, m) : m, k);
  }
  for (const id of c.delMeds) meds.delete(key(userId, id));
  // Update each touched medication's log record (read and written in this one transaction, so
  // another tab's write to the same record can't be lost).
  const touched = new Map<string, { put: DoseLog[]; gone: Set<string> }>();
  const entry = (medId: string) => {
    let e = touched.get(medId);
    if (!e) touched.set(medId, (e = { put: [], gone: new Set() }));
    return e;
  };
  for (const l of c.putLogs) entry(l.medId).put.push(l);
  for (const l of c.delLogs) entry(l.medId).gone.add(l.id);
  for (const [medId, { put, gone }] of touched) {
    const k = key(userId, medId);
    const req = logs.get(k);
    req.onsuccess = () => {
      const incoming = new Map(put.map((l) => [l.id, l]));
      const next: DoseLog[] = [];
      for (const l of (req.result as DoseLog[] | undefined) ?? []) {
        if (gone.has(l.id)) continue;
        const p = incoming.get(l.id);
        next.push(p ? newerLog(l, p) : l);
        incoming.delete(l.id);
      }
      next.push(...incoming.values());
      if (next.length) logs.put(next, k);
      else logs.delete(k);
    };
  }
  await done(tx);
}

function groupByMed(logs: DoseLog[]): Map<string, DoseLog[]> {
  const m = new Map<string, DoseLog[]>();
  for (const l of logs) {
    const list = m.get(l.medId);
    if (list) list.push(l);
    else m.set(l.medId, [l]);
  }
  return m;
}

/** Replace all of an account's data. */
export async function replaceAccount(userId: string, data: AppData): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MEDS, LOGS], 'readwrite');
  const meds = tx.objectStore(MEDS);
  const logs = tx.objectStore(LOGS);
  meds.delete(range(userId));
  logs.delete(range(userId));
  for (const m of data.medications) meds.put(m, key(userId, m.id));
  for (const [medId, list] of groupByMed(data.doseLogs)) logs.put(list, key(userId, medId));
  await done(tx);
}

export async function deleteAccount(userId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([MEDS, LOGS], 'readwrite');
  tx.objectStore(MEDS).delete(range(userId));
  tx.objectStore(LOGS).delete(range(userId));
  await done(tx);
}

// ---------- decrypted-item cache for cloud sync ----------

export async function loadDecrypted(uid: string): Promise<Map<string, unknown>> {
  const db = await openDb();
  const tx = db.transaction(DECRYPTED, 'readonly');
  const store = tx.objectStore(DECRYPTED);
  const [keys, values] = await Promise.all([
    new Promise<IDBValidKey[]>((resolve, reject) => {
      const req = store.getAllKeys(range(uid));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }),
    getAll<unknown>(store, uid),
  ]);
  const prefix = uid.length + 1;
  const out = new Map<string, unknown>();
  keys.forEach((k, i) => out.set(String(k).slice(prefix), values[i]));
  return out;
}

export async function saveDecrypted(uid: string, put: [string, unknown][], del: string[]): Promise<void> {
  if (!put.length && !del.length) return;
  const db = await openDb();
  const tx = db.transaction(DECRYPTED, 'readwrite');
  const store = tx.objectStore(DECRYPTED);
  for (const [k, v] of put) store.put(v, key(uid, k));
  for (const k of del) store.delete(key(uid, k));
  await done(tx);
}

/** Forget decrypted items: one account's, or (no uid) everyone's. */
export async function clearDecrypted(uid?: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(DECRYPTED, 'readwrite');
    if (uid) tx.objectStore(DECRYPTED).delete(range(uid));
    else tx.objectStore(DECRYPTED).clear();
    await done(tx);
  } catch {
    /* nothing stored */
  }
}
