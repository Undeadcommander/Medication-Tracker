// Cloud sync through Firestore (Firebase project sign-in-for-med), for signed-in Google accounts.
//
// Model:
//  - The device's local copy (localStorage) is what the UI shows, so the app works offline.
//  - Every local edit becomes operations (see syncOps.ts) that are written to Firestore. They're
//    queued in localStorage until the server acknowledges them, so edits made offline, or just
//    before the app closed, still reach the cloud on a later launch.
//  - Firestore snapshots from the server (plus this device's own pending writes) replace the local
//    copy, which is how edits from other devices arrive.
//  - The first time an account syncs on a device, local and cloud data are merged.
import type { Firestore, QuerySnapshot } from 'firebase/firestore';
import type { AppData } from '../../shared/types';
import { getFirebaseApp } from './auth';
import { diffAppData, logMonth, orphanLogs, plain, remoteToAppData, type SyncOp } from './syncOps';
import { mergeAppData } from './vault';

export type SyncState = 'connecting' | 'synced' | 'saving' | 'offline' | 'error';
export interface SyncStatus {
  state: SyncState;
  message?: string;
}

export interface SyncHandle {
  /** Record a local edit (state before → after) for upload. */
  push(prev: AppData, next: AppData): void;
  stop(): void;
}

type FS = typeof import('firebase/firestore');
let dbPromise: Promise<{ db: Firestore; fs: FS }> | null = null;

function getDb(): Promise<{ db: Firestore; fs: FS }> {
  dbPromise ??= (async () => {
    const [{ app }, fs] = await Promise.all([getFirebaseApp(), import('firebase/firestore')]);
    let db: Firestore;
    try {
      // Offline cache in IndexedDB, shared by open tabs; pending writes survive restarts.
      db = fs.initializeFirestore(app, {
        localCache: fs.persistentLocalCache({ tabManager: fs.persistentMultipleTabManager() }),
      });
    } catch {
      db = fs.getFirestore(app); // already initialized (e.g. dev hot reload)
    }
    return { db, fs };
  })().catch((e) => {
    dbPromise = null;
    throw e;
  });
  return dbPromise;
}

/** Sign-out: drop the Firestore offline cache so the next person on this device can't read it. */
export async function clearSyncCache(): Promise<void> {
  if (!dbPromise) return;
  try {
    const { db, fs } = await dbPromise;
    await fs.terminate(db);
    await fs.clearIndexedDbPersistence(db);
  } catch {
    /* best effort */
  } finally {
    dbPromise = null;
  }
}

interface QueuedOp {
  id: string;
  op: SyncOp;
}

const MAX_BATCH = 400; // Firestore allows 500 writes per batch

function canonical(d: AppData): string {
  const byId = <T extends { id: string }>(a: T[]) => [...a].sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
  return JSON.stringify({ m: byId(d.medications), l: byId(d.doseLogs) });
}

function describeError(e: unknown): string {
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'permission-denied') return "Cloud sync was refused for this account. Try signing out and back in.";
  if (code === 'unavailable') return "Can't reach the cloud right now. Changes are saved on this device.";
  if (code === 'resource-exhausted') return 'Cloud sync quota reached for today. Changes are saved on this device.';
  return e instanceof Error ? e.message : 'Cloud sync failed.';
}

export function startSync(opts: {
  /** Firebase Auth uid. */
  uid: string;
  getLocal: () => AppData;
  applyRemote: (data: AppData) => void;
  onStatus: (s: SyncStatus) => void;
}): SyncHandle {
  const { uid, getLocal, applyRemote, onStatus } = opts;
  const QUEUE_KEY = `medtracker.syncq.${uid}`;
  const SYNCED_KEY = `medtracker.synced.${uid}`;

  let stopped = false;
  let ctx: { db: Firestore; fs: FS } | null = null;
  let initialDone = false;
  let medsSnap: QuerySnapshot | null = null;
  let logsSnap: QuerySnapshot | null = null;
  const unsubs: (() => void)[] = [];
  const inFlight = new Set<string>();
  let lastStatus = '';

  const status = (s: SyncStatus) => {
    const key = `${s.state}|${s.message ?? ''}`;
    if (key !== lastStatus && !stopped) {
      lastStatus = key;
      onStatus(s);
    }
  };

  // ---------- durable queue ----------
  let queue: QueuedOp[] = (() => {
    try {
      const q = JSON.parse(localStorage.getItem(QUEUE_KEY) ?? '[]');
      return Array.isArray(q) ? q : [];
    } catch {
      return [];
    }
  })();
  const saveQueue = () => {
    try {
      if (queue.length) localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
      else localStorage.removeItem(QUEUE_KEY);
    } catch {
      /* storage full: Firestore's own offline queue still has flushed ops */
    }
  };
  const enqueue = (ops: SyncOp[]) => {
    if (!ops.length) return;
    for (const op of ops) queue.push({ id: crypto.randomUUID(), op });
    saveQueue();
    flush();
  };

  // ---------- writing ----------
  function flush() {
    if (!ctx || stopped) return;
    const { db, fs } = ctx;
    const pending = queue.filter((q) => !inFlight.has(q.id));
    for (let i = 0; i < pending.length; i += MAX_BATCH) {
      const chunk = pending.slice(i, i + MAX_BATCH);
      const batch = fs.writeBatch(db);
      for (const { op } of chunk) {
        if (op.kind === 'setMed') {
          batch.set(fs.doc(db, 'users', uid, 'meds', op.med.id), { med: plain(op.med), updatedAt: op.med.updatedAt });
        } else if (op.kind === 'deleteMed') {
          batch.delete(fs.doc(db, 'users', uid, 'meds', op.id));
        } else if (op.kind === 'setLog') {
          batch.set(
            fs.doc(db, 'users', uid, 'logs', logMonth(op.log.scheduledFor)),
            { logs: { [op.log.id]: plain(op.log) } },
            { merge: true },
          );
        } else {
          batch.set(
            fs.doc(db, 'users', uid, 'logs', logMonth(op.log.scheduledFor)),
            { logs: { [op.log.id]: fs.deleteField() } },
            { merge: true },
          );
        }
      }
      const ids = new Set(chunk.map((q) => q.id));
      ids.forEach((id) => inFlight.add(id));
      // Resolves when the server acknowledges (offline, it waits; Firestore keeps it queued).
      batch
        .commit()
        .then(() => {
          queue = queue.filter((q) => !ids.has(q.id));
          saveQueue();
        })
        .catch((e) => {
          // Rejected by the server (e.g. rules): retrying won't help, so drop these ops.
          queue = queue.filter((q) => !ids.has(q.id));
          saveQueue();
          status({ state: 'error', message: describeError(e) });
        })
        .finally(() => ids.forEach((id) => inFlight.delete(id)));
    }
  }

  // ---------- reading ----------
  function onSnapshots() {
    if (stopped || !medsSnap || !logsSnap) return;
    const fromServer = !medsSnap.metadata.fromCache && !logsSnap.metadata.fromCache;
    const pendingWrites = medsSnap.metadata.hasPendingWrites || logsSnap.metadata.hasPendingWrites;
    status({ state: pendingWrites ? 'saving' : fromServer ? 'synced' : 'offline' });

    const medDocs = medsSnap.docs.map((d) => d.data());
    const logDocs = logsSnap.docs.map((d) => d.data());

    if (!initialDone) {
      if (!fromServer) return; // wait for the server's copy before trusting the cloud
      initialDone = true;
      const remote = remoteToAppData(medDocs, logDocs);
      let firstTime = false;
      try {
        firstTime = localStorage.getItem(SYNCED_KEY) !== '1';
      } catch {
        firstTime = true;
      }
      if (firstTime) {
        // First sync of this account on this device: combine both sides (mergeAppData also
        // collapses duplicate dose logs), then upload what the cloud is missing.
        const merged = mergeAppData(remote.data, getLocal());
        queue = []; // the merge already includes any edits queued before this point
        saveQueue();
        enqueue(diffAppData(remote.data, merged));
        try {
          localStorage.setItem(SYNCED_KEY, '1');
        } catch {
          /* ignore */
        }
        applyRemote(merged);
        return;
      }
    }

    // Offline with nothing pending: the cache may be stale, so keep showing local data.
    if (!fromServer && !pendingWrites) return;

    const remote = remoteToAppData(medDocs, logDocs);
    if (fromServer) {
      // Tidy up after races between devices.
      const cleanup: SyncOp[] = remote.duplicateLogs.map((l) => ({ kind: 'deleteLog', log: l }));
      for (const l of orphanLogs(logDocs, new Set(remote.data.medications.map((m) => m.id)))) {
        cleanup.push({ kind: 'deleteLog', log: l });
      }
      if (cleanup.length && !pendingWrites) enqueue(cleanup);
    }
    if (canonical(remote.data) !== canonical(getLocal())) applyRemote(remote.data);
  }

  // ---------- start ----------
  status({ state: 'connecting' });
  getDb()
    .then((c) => {
      if (stopped) return;
      ctx = c;
      const { db, fs } = c;
      flush(); // edits made before Firestore loaded, or left over from a previous session
      const onErr = (e: unknown) => status({ state: 'error', message: describeError(e) });
      unsubs.push(
        fs.onSnapshot(fs.collection(db, 'users', uid, 'meds'), { includeMetadataChanges: true }, (s) => {
          medsSnap = s;
          onSnapshots();
        }, onErr),
        fs.onSnapshot(fs.collection(db, 'users', uid, 'logs'), { includeMetadataChanges: true }, (s) => {
          logsSnap = s;
          onSnapshots();
        }, onErr),
      );
    })
    .catch((e) => status({ state: 'error', message: describeError(e) }));

  return {
    push(prev, next) {
      if (!stopped) enqueue(diffAppData(prev, next));
    },
    stop() {
      stopped = true;
      unsubs.forEach((u) => u());
    },
  };
}
