// Cloud sync through Firestore (Firebase project sign-in-for-med), for signed-in Google accounts,
// end-to-end encrypted (see syncCrypto.ts).
//
// Model:
//  - The device's local copy (IndexedDB, see store.ts) is what the UI shows, so the app works
//    offline.
//  - Every local edit queues the items it changed (see syncOps.ts) in a localStorage queue shared
//    by this device's tabs. When an upload is built, the item's current local version is encrypted
//    and written. Entries stay queued until the server acknowledges them, so edits made offline,
//    before the device was unlocked, or just before the app closed still reach the cloud later.
//  - Nothing is read or written until this device holds the account's data key (unlocked). The
//    only document read before that is `meta/crypto`, which holds the wrapped keys.
//  - Cloud snapshots are decrypted (cached across launches) and combined with the local copy
//    (syncOps.reconcile): medications merge field by field, deleted ones leave a permanent marker,
//    and edits not uploaded yet are kept.
//  - The first time an account syncs on a device, local and cloud data are merged.
//  - Anything still stored in plaintext (from before encryption), or filed in an older document
//    layout, is moved and re-uploaded encrypted.
import type { DocumentData, DocumentSnapshot, Firestore, QuerySnapshot, SnapshotMetadata, WriteBatch } from 'firebase/firestore';
import type { AppData } from '../../shared/types';
import { getFirebaseApp } from './auth';
import { forgetAllDeviceKeys, forgetDeviceKey, forgetDeviceKeyIf, loadDeviceKey, saveDeviceKey } from './keyStore';
import { clearDecrypted, loadDecrypted, saveDecrypted } from './localDb';
import {
  SyncCryptoError,
  changePassphrase as rewrapPassphrase,
  createKeyBundle,
  decodeRemote,
  encryptLog,
  encryptMed,
  newDecodeMemo,
  parseCryptoMeta,
  readRecoveryKey,
  regenerateRecoveryKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  type CryptoMeta,
  type DecodeMemo,
  type DecodedRemote,
  type DecryptCache,
} from './syncCrypto';
import {
  LOG_RETENTION_MS,
  diffAppData,
  logDocId,
  migrationRefs,
  plain,
  reconcile,
  refKey,
  remoteToAppData,
  resolveRefs,
  toRefs,
  type OpRef,
  type SyncOp,
} from './syncOps';
import { estimatePassphraseStrength, mergeAppData } from './vault';

export type SyncState = 'connecting' | 'synced' | 'saving' | 'offline' | 'error' | 'locked' | 'setup';
/** checking: waiting for the account's encryption settings; needs-setup: encryption never set up. */
export type LockState = 'checking' | 'needs-setup' | 'locked' | 'unlocked';
export interface SyncStatus {
  state: SyncState;
  lock: LockState;
  message?: string;
  /** Non-fatal problem worth showing (e.g. items that couldn't be decrypted). */
  warning?: string;
  /**
   * The cloud copy has been read and shown on this device since sync started. Until then, a new
   * device may be missing medications that are on the user's other devices.
   */
  cloudLoaded: boolean;
}

/** A new key or recovery key that's been created but not saved yet (show it to the user first). */
export interface PreparedKeyChange {
  recoveryKey: string;
  finish(): Promise<void>;
}

export interface SyncHandle {
  /** Record a local edit (state before → after) for upload. */
  push(prev: AppData, next: AppData): void;
  stop(): void;
  /** First-time setup. Nothing is saved until `finish()`. */
  prepareSetup(passphrase: string): Promise<PreparedKeyChange>;
  unlock(secret: string, kind: 'passphrase' | 'recovery'): Promise<void>;
  changePassphrase(newPassphrase: string): Promise<void>;
  getRecoveryKey(): Promise<string>;
  /** A new recovery key (the old one stops working on `finish()`). */
  prepareNewRecoveryKey(): Promise<PreparedKeyChange>;
  /**
   * Lost both secrets: delete the (unreadable) cloud copy and start over with new keys, uploading
   * this device's data. Nothing is changed until `finish()`.
   */
  prepareReset(passphrase: string): Promise<PreparedKeyChange>;
  /** Remove the data key from this device. Local data stays; sync pauses until unlocked again. */
  forgetKey(): Promise<void>;
  /**
   * Account deletion: delete every cloud document of this account and leave a permanent "deleted"
   * marker in place of the encryption settings. Other devices are told first (they pause, then
   * remove their own copies once it's done). Works whether or not this device is unlocked.
   */
  deleteCloudData(): Promise<void>;
  /** The medication is deleted for good in the cloud (as far as this device has seen). */
  deletedInCloud(medId: string): boolean;
}

/**
 * `meta/crypto` while an account is being deleted (other devices pause; the security rules refuse
 * new data), and for good once it's done. `at` lets other devices finish a deletion that stalled.
 */
type DeletionMarker = { v: 1; deleted: true; phase?: 'deleting' | 'done'; done?: true; at?: number };
const deletingMarker = (): DeletionMarker => ({ v: 1, deleted: true, phase: 'deleting', at: Date.now() });
const doneMarker = (): DeletionMarker => ({ v: 1, deleted: true, phase: 'done', done: true, at: Date.now() });
/** A deletion (or key reset) that hasn't finished after this long has stalled. */
const STALL_MS = 15 * 60_000;

type FS = typeof import('firebase/firestore');
let dbPromise: Promise<{ db: Firestore; fs: FS }> | null = null;

/** Start loading Firestore ahead of sync (e.g. while this device's own copy is still loading). */
export function preloadSync(): void {
  getDb().catch(() => {
    /* startSync retries and reports it */
  });
}

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

/**
 * Sign-out: forget the sync keys stored on this device and drop the Firestore offline cache, so
 * the next person on this device can't read anything.
 */
export async function clearSyncCache(): Promise<void> {
  await forgetAllDeviceKeys();
  await clearDecrypted();
  keyChannel()?.postMessage({ uid: '*' });
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

/** Remove what this device keeps about an account's sync: queued uploads, flags, cache and device key. */
export async function forgetSyncState(uid: string): Promise<void> {
  try {
    localStorage.removeItem(`medtracker.syncq.${uid}`);
    localStorage.removeItem(`medtracker.synced.${uid}`);
    localStorage.removeItem(`medtracker.deleting.${uid}`);
  } catch {
    /* storage unavailable */
  }
  await clearDecrypted(uid);
  await forgetDeviceKey(uid);
  keyChannel()?.postMessage({ uid });
}

/** Tells other open tabs that a device key was stored or forgotten. */
let channel: BroadcastChannel | null | undefined;
function keyChannel(): BroadcastChannel | null {
  if (channel === undefined) channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('medtracker-keys');
  return channel;
}

interface QueuedOp {
  id: string;
  /** The item to upload; its contents are read from the local copy when the upload is built. */
  ref: OpRef;
  /** The tab that queued it (the only one that uploads it); missing in queues from older versions. */
  owner?: string;
}

/** Queue entries, including ones stored by older versions (which held whole ops, or monthly log documents). */
function parseQueue(raw: string | null): QueuedOp[] {
  let q: unknown;
  try {
    q = JSON.parse(raw ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(q)) return [];
  const out: QueuedOp[] = [];
  for (const e of q as Partial<QueuedOp & { op: SyncOp; ref: { month?: string } }>[]) {
    if (!e || typeof e.id !== 'string') continue;
    let ref: OpRef | undefined = e.ref;
    if (ref?.kind === 'log' && typeof ref.doc !== 'string') {
      const month = (e.ref as { month?: unknown }).month;
      ref = typeof month === 'string' ? { kind: 'log', id: ref.id, doc: month } : undefined;
    }
    ref ??= e.op ? toRefs([e.op])[0] : undefined;
    if (ref && typeof ref.id === 'string') out.push({ id: e.id, ref, owner: typeof e.owner === 'string' ? e.owner : undefined });
  }
  return out;
}

const MAX_BATCH = 400; // Firestore allows 500 writes per batch
const MAX_BATCH_BYTES = 8 * 1024 * 1024; // and 10 MiB per request
/** Dose log entries one write may change in a log document (the security rules check each one). */
const LOG_ENTRIES_PER_WRITE = 8;
/** Tidy-ups (moves, duplicate and expired removals) queued per round, to keep the queue small. */
const MAX_TIDY_PER_ROUND = 2000;

function describeError(e: unknown): string {
  if (e instanceof SyncCryptoError) return e.message;
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'permission-denied') return "Cloud sync was refused for this account. Try signing out and back in.";
  if (code === 'unavailable') return "Can't reach the cloud right now. Changes are saved on this device.";
  if (code === 'resource-exhausted') return 'Cloud sync quota reached for today. Changes are saved on this device.';
  return e instanceof Error ? e.message : 'Cloud sync failed.';
}

/** User-facing message for an error from one of the key actions (setup, unlock, …). */
export function describeKeyError(e: unknown): string {
  if (e instanceof SyncCryptoError) return e.message;
  const code = (e as { code?: string })?.code ?? '';
  if (code === 'unavailable' || code === 'deadline-exceeded') return new SyncCryptoError('offline').message;
  if (code === 'permission-denied') {
    return "The cloud refused to save the encryption settings. The Firestore security rules may need updating (see the README).";
  }
  return 'Something went wrong. Please try again.';
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export function startSync(opts: {
  /** Firebase Auth uid. */
  uid: string;
  getLocal: () => AppData;
  applyRemote: (data: AppData) => void;
  onStatus: (s: SyncStatus) => void;
  /**
   * The account was deleted (on another device, or earlier). Sync has stopped; remove this
   * device's copy and end the session.
   */
  onAccountDeleted?: () => void;
}): SyncHandle {
  const { uid, getLocal, applyRemote, onStatus, onAccountDeleted } = opts;
  const QUEUE_KEY = `medtracker.syncq.${uid}`;
  const SYNCED_KEY = `medtracker.synced.${uid}`;
  const DELETING_KEY = `medtracker.deleting.${uid}`;

  let stopped = false;
  /** Uploads held back while the account is being deleted (here or on another device). */
  let paused = false;
  /** Paused because another device or tab is deleting the account. */
  let pausedForDeletion = false;
  /** Another tab of this browser is deleting this account (flag set within the stall time). */
  const deletionInThisBrowser = () => {
    try {
      const t = Number(localStorage.getItem(DELETING_KEY));
      return t > 0 && Date.now() - t < STALL_MS;
    } catch {
      return false;
    }
  };
  /** deleteCloudData() finished (a retry of the account deletion skips it). */
  let cloudDeleted = false;
  let ctx: { db: Firestore; fs: FS } | null = null;
  let initialDone = false;
  /** keyId the server last confirmed as the account's current key (and not being reset). */
  let confirmedKeyId: string | null = null;
  /** A snapshot has been reconciled since the data listeners (re)started: queued uploads may go. */
  let uploadedSinceStart = false;
  const inFlight = new Set<string>();
  /**
   * In-flight entries whose contents have already been read (their batch has started). A newer
   * edit of the same item needs its own entry; until then, it's covered by the queued one.
   */
  const resolved = new Set<string>();
  let lastStatus = '';

  // ---------- keys ----------
  /** undefined: not known yet; null: the server confirmed there's none (never set up). */
  let meta: CryptoMeta | null | undefined;
  let metaError: string | undefined;
  let dek: CryptoKey | null = null;
  let dekKeyId: string | null = null;
  let lock: LockState = 'checking';
  const decryptCache: DecryptCache = new Map();
  let decodeMemo: DecodeMemo = newDecodeMemo();
  /** The decrypted-item cache saved by earlier launches, loading. */
  let cacheReady: Promise<void> = Promise.resolve();
  /** Tidy-ups already queued this session, so a rejected one isn't retried in a loop. */
  const attempted = new Set<string>();

  // ---------- status ----------
  let dataState: { state: SyncState; message?: string } = { state: 'connecting' };
  /** See SyncStatus.cloudLoaded. */
  let cloudLoaded = false;
  /** Last write the server rejected; shown until a later write succeeds. */
  let writeError: string | undefined;
  let keyWarning: string | undefined;
  let dataWarning: string | undefined;

  const emit = () => {
    if (stopped) return;
    const warning = [keyWarning, dataWarning].filter(Boolean).join(' ') || undefined;
    let s: SyncStatus;
    if (lock === 'unlocked') {
      // metaError: the key was loaded from this device but the account's settings can't be read.
      const error = writeError ?? metaError;
      s = error ? { state: 'error', message: error, lock, warning, cloudLoaded } : { ...dataState, lock, warning, cloudLoaded };
    } else if (lock === 'needs-setup') s = { state: 'setup', lock, warning, cloudLoaded };
    else if (lock === 'locked') s = { state: 'locked', lock, warning, cloudLoaded };
    else s = metaError ? { state: 'error', lock, message: metaError, warning, cloudLoaded } : { state: 'connecting', lock, warning, cloudLoaded };
    const key = JSON.stringify(s);
    if (key !== lastStatus) {
      lastStatus = key;
      onStatus(s);
    }
  };
  const setData = (s: { state: SyncState; message?: string }) => {
    dataState = s;
    emit();
  };

  // ---------- durable queue ----------
  // One localStorage queue per account, shared by every open tab. Each entry records the tab that
  // queued it, and only that tab uploads it, so two tabs never send the same entry. Every change
  // re-reads the stored queue, so tabs don't overwrite each other's entries. A tab holds a Web Lock
  // while it runs; when one closes with entries still queued, another tab (or the next launch)
  // takes them over.
  const tabId = crypto.randomUUID();
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const lockName = (owner: string) => `medtracker-syncq-${uid}-${owner}`;
  const lockAbort = typeof AbortController !== 'undefined' ? new AbortController() : undefined;
  let releaseTabLock: (() => void) | undefined;
  locks
    ?.request(lockName(tabId), { signal: lockAbort?.signal }, () => new Promise<void>((resolve) => (releaseTabLock = resolve)))
    .catch(() => {});

  /** Marks that the stored queue couldn't be written (storage full): the copy in memory is the latest. */
  const UNSAVED = '\u0000unsaved';
  let queueRaw: string | null | undefined;
  let queueCache: QueuedOp[] = [];
  const readQueue = (): QueuedOp[] => {
    if (queueRaw === UNSAVED) return queueCache;
    let raw: string | null;
    try {
      raw = localStorage.getItem(QUEUE_KEY);
    } catch {
      return queueCache;
    }
    if (raw !== queueRaw) {
      queueRaw = raw;
      queueCache = parseQueue(raw);
    }
    return queueCache;
  };
  const writeQueue = (q: QueuedOp[]) => {
    queueCache = q;
    try {
      if (q.length) {
        const raw = JSON.stringify(q);
        localStorage.setItem(QUEUE_KEY, raw);
        queueRaw = raw;
      } else {
        localStorage.removeItem(QUEUE_KEY);
        queueRaw = null;
      }
    } catch {
      queueRaw = UNSAVED; // storage full: kept in memory; Firestore's own offline queue still has flushed writes
    }
  };
  const updateQueue = (fn: (q: QueuedOp[]) => QueuedOp[]) => writeQueue(fn(readQueue()));
  /** Add refs this tab will upload, skipping items it already has queued (not yet read). */
  const withMine = (q: QueuedOp[], refs: OpRef[], added?: string[]): QueuedOp[] => {
    const queued = new Set(q.filter((e) => e.owner === tabId && !resolved.has(e.id)).map((e) => refKey(e.ref)));
    const add: QueuedOp[] = [];
    for (const ref of refs) {
      const k = refKey(ref);
      if (queued.has(k)) continue;
      queued.add(k);
      const id = crypto.randomUUID();
      add.push({ id, ref, owner: tabId });
      added?.push(id);
    }
    return add.length ? [...q, ...add] : q;
  };
  const enqueueRefs = (refs: OpRef[]): string[] => {
    const added: string[] = [];
    if (refs.length) {
      updateQueue((q) => withMine(q, refs, added));
      flush();
    }
    return added;
  };
  const enqueue = (ops: SyncOp[]) => enqueueRefs(toRefs(ops));

  /** Entries of the first sync on this device: once all are uploaded, it's done (see SYNCED_KEY). */
  let firstSyncEntries: Set<string> | null = null;
  const markUploaded = (ids: Iterable<string>) => {
    if (!firstSyncEntries) return;
    for (const id of ids) firstSyncEntries.delete(id);
    if (!firstSyncEntries.size) {
      firstSyncEntries = null;
      try {
        localStorage.setItem(SYNCED_KEY, '1');
      } catch {
        /* ignore */
      }
    }
  };

  /** Take over the queued uploads of closed tabs. */
  function adopt(isOrphan: (owner: string | undefined) => boolean) {
    if (stopped) return;
    const q = readQueue();
    const orphans = q.filter((e) => e.owner !== tabId && isOrphan(e.owner));
    if (!orphans.length) return;
    const ids = new Set(orphans.map((e) => e.id));
    writeQueue(withMine(q.filter((e) => !ids.has(e.id)), orphans.map((e) => e.ref)));
    flush();
  }
  const watchedOwners = new Set<string>();
  /** Watch the tabs that own queued entries, to take over their entries once they close. */
  function watchOrphans() {
    if (stopped) return;
    if (!locks) {
      // No Web Locks (old browsers): take over whatever was queued before this tab started.
      if (!watchedOwners.has('*')) {
        watchedOwners.add('*');
        adopt(() => true);
      }
      return;
    }
    adopt((owner) => !owner); // queued by an older version of the app
    for (const { owner } of readQueue()) {
      if (!owner || owner === tabId || watchedOwners.has(owner)) continue;
      watchedOwners.add(owner);
      // Granted once that tab's lock is free, i.e. it has closed.
      locks
        .request(lockName(owner), { signal: lockAbort?.signal }, () => {
          watchedOwners.delete(owner);
          adopt((o) => o === owner);
        })
        .catch(() => watchedOwners.delete(owner));
    }
  }
  const onStorage = (e: StorageEvent) => {
    if (e.key === QUEUE_KEY || e.key === null) watchOrphans();
  };
  if (typeof window !== 'undefined') window.addEventListener('storage', onStorage);

  /** Release everything this instance holds (listeners, timers, the tab lock and pending lock requests). */
  const cleanup = () => {
    keyChannel()?.removeEventListener('message', onChannel);
    if (typeof window !== 'undefined') window.removeEventListener('storage', onStorage);
    if (snapshotTimer) clearTimeout(snapshotTimer);
    snapshotTimer = null;
    if (deletionTimer) clearTimeout(deletionTimer);
    deletionTimer = null;
    releaseTabLock?.();
    lockAbort?.abort();
  };

  // ---------- writing ----------
  /** Medication tombstones known from the cloud: a deletion there is already done (and final). */
  let remoteTombstones = new Set<string>();

  type Write = { ids: string[]; apply(b: WriteBatch): void; bytes: number };

  /** Encrypt the writes for a batch's entries: one per medication, one per log document. */
  async function buildWrites(fs: FS, db: Firestore, key: CryptoKey, keyId: string, entries: { id: string; op: SyncOp }[]) {
    const writes: Write[] = [];
    const unbuildable: string[] = [];
    const done: string[] = [];
    const logDocs = new Map<string, { ids: string[]; entries: Promise<[string, unknown]>[] }>();
    await Promise.all(
      entries.map(async ({ id, op }) => {
        try {
          if (op.kind === 'setMed') {
            if (remoteTombstones.has(op.med.id)) return void done.push(id); // deleted elsewhere, for good
            const ref = fs.doc(db, 'users', uid, 'meds', op.med.id);
            const env = await encryptMed(key, uid, plain(op.med), keyId);
            writes.push({ ids: [id], apply: (b) => b.set(ref, env), bytes: JSON.stringify(env).length + 200 });
          } else if (op.kind === 'deleteMed') {
            if (remoteTombstones.has(op.id)) return void done.push(id); // already deleted there
            const ref = fs.doc(db, 'users', uid, 'meds', op.id);
            writes.push({ ids: [id], apply: (b) => b.set(ref, { v: 1, deleted: true }), bytes: 200 });
          } else {
            const doc = op.kind === 'setLog' ? logDocId(op.log) : op.doc;
            // Nothing to remove (logged and undone before it was uploaded): a write would create an
            // empty document, which the rules refuse.
            if (op.kind === 'deleteLog' && !cloudLogDocs.has(doc)) return void done.push(id);
            let group = logDocs.get(doc);
            if (!group) logDocs.set(doc, (group = { ids: [], entries: [] }));
            group.ids.push(id);
            group.entries.push(
              op.kind === 'setLog'
                ? encryptLog(key, uid, doc, plain(op.log), keyId).then((env): [string, unknown] => [op.log.id, env])
                : Promise.resolve<[string, unknown]>([op.id, fs.deleteField()]),
            );
          }
        } catch {
          unbuildable.push(id); // e.g. an id Firestore can't use: drop it alone, not its batch
        }
      }),
    );
    for (const [doc, group] of logDocs) {
      try {
        const settled = await Promise.all(group.entries);
        const ref = fs.doc(db, 'users', uid, 'logs', doc);
        const logs = Object.fromEntries(settled);
        // In shard documents, `w` lists the entries this write changes, so the security rules can
        // check each one. (Documents of the older monthly layout are only emptied.)
        const w = settled.map(([logId]) => logId);
        const shard = doc.includes('~');
        const fields = w.map((logId) => new fs.FieldPath('logs', logId));
        if (shard) fields.push(new fs.FieldPath('w'));
        writes.push({
          ids: group.ids,
          // mergeFields replaces each listed entry as a whole (merge: true would deep-merge into
          // whatever was there, e.g. leave plaintext fields next to the ciphertext).
          apply: (b) => b.set(ref, shard ? { logs, w } : { logs }, { mergeFields: fields }),
          bytes: settled.reduce((n, [, v]) => n + (typeof v === 'object' && v && 'ct' in v ? JSON.stringify(v).length : 0) + 80, 200),
        });
      } catch {
        unbuildable.push(...group.ids);
      }
    }
    return { writes, unbuildable, done };
  }

  /** Entries from a batch the server rejected: retried one per batch, so only the bad one is dropped. */
  const solo = new Set<string>();
  const dropEntries = (ids: Iterable<string>) => {
    const drop = new Set(ids);
    if (!drop.size) return;
    updateQueue((q) => q.filter((e) => !drop.has(e.id)));
    markUploaded(drop);
  };
  const release = (ids: Iterable<string>) => {
    for (const id of ids) {
      inFlight.delete(id);
      resolved.delete(id);
    }
  };

  // Batches are built (encrypted) one after another so they're committed in queue order.
  let writeChain: Promise<void> = Promise.resolve();

  function flush() {
    if (!ctx || stopped || paused || !dek || !dekKeyId) return;
    // Not before the cloud copy has been read and merged in: a queued medication would otherwise
    // overwrite fields changed on another device meanwhile (the merge keeps the newer of each).
    // Waiting costs nothing offline: entries stay queued here, durably.
    if (!initialDone) return;
    const { db, fs } = ctx;
    const key = dek;
    const keyId = dekKeyId;
    const pending = readQueue().filter((q) => q.owner === tabId && !inFlight.has(q.id));
    if (!pending.length) return;
    pending.forEach((q) => inFlight.add(q.id));
    writeChain = writeChain.then(async () => {
      let rest = pending;
      while (rest.length) {
        if (stopped || paused || dek !== key) return release(rest.map((q) => q.id)); // stay queued
        // The latest local copy: queued items upload as they are now. Edits from here on need
        // their own entries.
        const local = getLocal();
        rest.forEach((q) => resolved.add(q.id));
        // Pick this batch's entries: at most MAX_BATCH writes, one write per log document with at
        // most LOG_ENTRIES_PER_WRITE entries, and an entry being retried on its own goes alone.
        const picked: QueuedOp[] = [];
        const later: QueuedOp[] = [];
        const perDoc = new Map<string, number>();
        let writes = 0;
        for (const q of rest) {
          const isSolo = solo.has(q.id);
          if (writes >= MAX_BATCH || (isSolo && picked.length) || (picked.length && solo.has(picked[0].id))) {
            later.push(q);
            continue;
          }
          if (q.ref.kind === 'log') {
            const n = perDoc.get(q.ref.doc) ?? 0;
            if (n >= LOG_ENTRIES_PER_WRITE) {
              later.push(q);
              continue;
            }
            perDoc.set(q.ref.doc, n + 1);
            if (!n) writes++;
          } else writes++;
          picked.push(q);
        }
        rest = later;
        const entries = picked.map((q) => ({ id: q.id, op: resolveRefs([q.ref], local)[0] }));
        const built = await buildWrites(fs, db, key, keyId, entries);
        if (built.unbuildable.length) {
          dropEntries(built.unbuildable);
          release(built.unbuildable);
          writeError = `${plural(built.unbuildable.length, 'change')} couldn't be prepared for upload and ${built.unbuildable.length === 1 ? 'was' : 'were'} kept on this device only.`;
          emit();
        }
        if (built.done.length) {
          dropEntries(built.done);
          release(built.done);
        }
        if (stopped || paused || dek !== key) {
          // Stopped, paused or locked while encrypting: don't send; these stay queued.
          release(built.writes.flatMap((w) => w.ids));
          return release(rest.map((q) => q.id));
        }
        // Split by size (10 MiB per request).
        const batches: Write[][] = [[]];
        let bytes = 0;
        for (const w of built.writes) {
          if (batches[batches.length - 1].length && bytes + w.bytes > MAX_BATCH_BYTES) {
            batches.push([]);
            bytes = 0;
          }
          batches[batches.length - 1].push(w);
          bytes += w.bytes;
        }
        for (const ws of batches) {
          if (!ws.length) continue;
          const ids = ws.flatMap((w) => w.ids);
          const batch = fs.writeBatch(db);
          ws.forEach((w) => w.apply(batch));
          commitBatch(batch, ids);
        }
      }
    }).catch(() => {
      release(pending.map((q) => q.id)); // stay queued; the next change or launch tries again
      setData({ state: 'error', message: "Couldn't prepare changes for upload. They're saved on this device." });
    });
  }

  function commitBatch(batch: WriteBatch, ids: string[]) {
    let retry = false;
    // Resolves when the server acknowledges (offline, it waits; Firestore keeps it queued).
    batch
      .commit()
      .then(() => {
        dropEntries(ids);
        ids.forEach((id) => solo.delete(id));
        if (writeError) {
          writeError = undefined;
          emit();
        }
      })
      .catch((e) => {
        const code = (e as { code?: string })?.code;
        if (code === 'resource-exhausted') {
          // Quota: keep them queued; the next change or launch tries again.
        } else if (ids.length > 1) {
          // Rejected (e.g. one document too large): find the bad entry by sending them one at a time.
          ids.forEach((id) => solo.add(id));
          retry = true;
          return;
        } else {
          dropEntries(ids); // rejected on its own: retrying won't help
          ids.forEach((id) => solo.delete(id));
        }
        writeError = describeError(e);
        emit();
      })
      .finally(() => {
        release(ids);
        if (retry) flush();
        // Tidy-ups wait for an empty queue; give them a chance now.
        else if (!readQueue().length) scheduleSnapshot();
      });
  }

  // ---------- reading ----------
  // Documents as Firestore last reported them. A document that didn't change keeps its data
  // object, so decoding (memoized per object) only looks at what changed.
  const cloudMedDocs = new Map<string, DocumentData>();
  const cloudLogDocs = new Map<string, DocumentData>();
  let medsMeta: SnapshotMetadata | null = null;
  let logsMeta: SnapshotMetadata | null = null;
  let dataUnsubs: (() => void)[] = [];
  let readSeq = 0;
  let snapshotTimer: ReturnType<typeof setTimeout> | null = null;

  const track = (docs: Map<string, DocumentData>, s: QuerySnapshot) => {
    for (const ch of s.docChanges()) {
      if (ch.type === 'removed') docs.delete(ch.doc.id);
      else docs.set(ch.doc.id, ch.doc.data());
    }
  };

  /** Snapshots often come in bursts (a write, then its acknowledgement): handle the last one. */
  function scheduleSnapshot() {
    if (snapshotTimer || stopped) return;
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null;
      onSnapshots();
    }, 40);
  }

  function onSnapshots() {
    if (stopped || paused || !medsMeta || !logsMeta || !dek) return;
    const seq = ++readSeq;
    const key = dek;
    const keyId = dekKeyId ?? undefined;
    const fromServer = !medsMeta.fromCache && !logsMeta.fromCache;
    const pendingWrites = medsMeta.hasPendingWrites || logsMeta.hasPendingWrites;
    setData({ state: !fromServer ? 'offline' : pendingWrites ? 'saving' : 'synced' });
    const meds = [...cloudMedDocs].map(([id, data]) => ({ id, data }));
    const logs = [...cloudLogDocs].map(([id, data]) => ({ id, data }));
    // Decryption is async: snapshots are processed in order and a stale result is dropped.
    cacheReady
      .then(() => decodeRemote(key, uid, meds, logs, decryptCache, { keyId, memo: decodeMemo }))
      .then((decoded) => {
        if (seq !== readSeq || stopped || dek !== key) return;
        void saveDecrypted(uid, decoded.cacheAdded.map(([k, v]) => [`${keyId}|${k}`, v]), decoded.cacheRemoved.map((k) => `${keyId}|${k}`)).catch(() => {});
        applySnapshot(decoded, fromServer, pendingWrites);
      })
      .catch(() => setData({ state: 'error', message: "Couldn't read the cloud copy." }));
  }

  function applySnapshot(decoded: DecodedRemote, fromServer: boolean, pendingWrites: boolean) {
    const remote = remoteToAppData(decoded);
    remoteTombstones = remote.tombstones;
    const skipped = decoded.undecryptable - decoded.staleKey.meds.length - decoded.staleKey.logs.length;
    dataWarning =
      skipped > 0
        ? `${plural(skipped, 'cloud item')} couldn't be decrypted (damaged, changed, or encrypted with another key) and ${skipped === 1 ? 'was' : 'were'} skipped.`
        : undefined;
    emit();
    const local = getLocal();
    const cutoff = Date.now() - LOG_RETENTION_MS;

    if (!initialDone) {
      if (!fromServer) return; // wait for the server's copy before trusting the cloud
      initialDone = true;
      let firstTime = false;
      try {
        firstTime = localStorage.getItem(SYNCED_KEY) !== '1';
      } catch {
        firstTime = true;
      }
      if (firstTime) {
        // First sync of this account on this device: combine both sides (one log per dose,
        // medications field by field), then upload what the cloud is missing. Medications deleted
        // elsewhere stay deleted.
        const gone = (id: string) => remote.tombstones.has(id);
        const localKept: AppData = {
          version: 1,
          medications: local.medications.filter((m) => !gone(m.id)),
          doseLogs: local.doseLogs.filter((l) => !gone(l.medId) && Date.parse(l.scheduledFor) >= cutoff),
        };
        // Items removed here but still queued for removal aren't taken back from the cloud.
        const queuedRefs = readQueue().map((e) => e.ref);
        const localMeds = new Set(local.medications.map((m) => m.id));
        const localLogs = new Set(local.doseLogs.map((l) => l.id));
        const removedMeds = new Set(queuedRefs.filter((r) => r.kind === 'med' && !localMeds.has(r.id)).map((r) => r.id));
        const removedLogs = new Set(queuedRefs.filter((r) => r.kind === 'log' && !localLogs.has(r.id)).map((r) => r.id));
        const remoteKept: AppData = {
          version: 1,
          medications: remote.data.medications.filter((m) => !removedMeds.has(m.id)),
          doseLogs: remote.data.doseLogs.filter((l) => !removedLogs.has(l.id) && !removedMeds.has(l.medId)),
        };
        const merged = mergeAppData(remoteKept, localKept);
        applyRemote(merged); // first: queued uploads read their contents from the local copy
        markCloudLoaded();
        const refs = [...migrationRefs(remote, decoded.plaintext), ...toRefs(diffAppData(remote.data, merged))];
        firstSyncEntries = new Set(enqueueRefs(refs));
        markUploaded([]); // nothing to upload: done already
        return;
      }
    }

    // Offline with nothing pending: the cache may be stale, so keep showing local data.
    if (!fromServer && !pendingWrites) return;

    const queued = readQueue().map((e) => e.ref);
    const firstRound = !uploadedSinceStart;
    uploadedSinceStart = true;
    const { shown, uploads, removals } = reconcile({ remote, local, queued, failed: decoded.failedIds, cutoff });
    if (shown.medications !== local.medications || shown.doseLogs !== local.doseLogs) applyRemote(shown);
    if (!fromServer) return;
    markCloudLoaded();

    // This device's newer versions (merged medications, logs changed here): upload. A version is
    // only uploaded once per session, so two devices can't bounce one back and forth.
    const after = getLocal();
    const medsById = new Map(after.medications.map((m) => [m.id, m]));
    const logsById = new Map(after.doseLogs.map((l) => [l.id, l]));
    const version = (r: OpRef) => {
      if (r.kind === 'med') {
        const m = medsById.get(r.id);
        return m ? `${m.updatedAt}|${JSON.stringify(m.fieldTimes ?? null)}` : '-';
      }
      return logsById.get(r.id)?.loggedAt ?? '-';
    };
    const fresh = uploads.filter((r) => {
      const k = `${refKey(r)}|${version(r)}`;
      if (attempted.has(k)) return false;
      attempted.add(k);
      return true;
    });
    enqueueRefs(fresh);
    if (firstRound) flush(); // what was queued before the cloud copy was read (now merged)

    // Tidy-ups only once the cloud copy has settled (nothing pending anywhere).
    if (pendingWrites || readQueue().length) return;
    const localMedIds = new Set(after.medications.map((m) => m.id));
    const tidy: OpRef[] = [
      ...migrationRefs(remote, decoded.plaintext),
      ...removals,
      // Left from before a key reset (encrypted with an older key): re-upload or remove.
      // (Medications this device doesn't have are left alone: their device re-uploads them after
      // unlocking with the new key; a deletion marker here would delete them for good.)
      ...decoded.staleKey.meds.filter((id) => localMedIds.has(id)).map((id): OpRef => ({ kind: 'med', id })),
      ...decoded.staleKey.logs.map((l): OpRef => ({ kind: 'log', id: l.id, doc: l.doc })),
    ].filter((r) => !attempted.has(refKey(r)));
    const round = tidy.slice(0, MAX_TIDY_PER_ROUND);
    round.forEach((r) => attempted.add(refKey(r)));
    enqueueRefs(round);
  }

  function markCloudLoaded() {
    if (cloudLoaded) return;
    cloudLoaded = true;
    emit();
  }

  function startData() {
    // Only once the server has confirmed this device's key is the account's current key: a key
    // kept from before a reset elsewhere must not upload, or treat the reset cloud as the truth.
    if (!ctx || stopped || paused || dataUnsubs.length || !dek || dekKeyId !== confirmedKeyId) return;
    const { db, fs } = ctx;
    const onErr = (e: unknown) => setData({ state: 'error', message: describeError(e) });
    dataUnsubs = [
      fs.onSnapshot(fs.collection(db, 'users', uid, 'meds'), { includeMetadataChanges: true }, (s) => {
        track(cloudMedDocs, s);
        medsMeta = s.metadata;
        scheduleSnapshot();
      }, onErr),
      fs.onSnapshot(fs.collection(db, 'users', uid, 'logs'), { includeMetadataChanges: true }, (s) => {
        track(cloudLogDocs, s);
        logsMeta = s.metadata;
        scheduleSnapshot();
      }, onErr),
    ];
  }

  function stopData() {
    dataUnsubs.forEach((u) => u());
    dataUnsubs = [];
    cloudMedDocs.clear();
    cloudLogDocs.clear();
    medsMeta = logsMeta = null;
    initialDone = false;
    uploadedSinceStart = false;
    readSeq++;
  }

  function setKey(key: CryptoKey, keyId: string) {
    if (stopped) return;
    dek = key;
    dekKeyId = keyId;
    lock = 'unlocked';
    decryptCache.clear();
    decodeMemo = newDecodeMemo();
    // Items decrypted on earlier launches (with this key) don't need decrypting again.
    cacheReady = loadDecrypted(uid)
      .then((saved) => {
        if (dek !== key) return;
        const prefix = `${keyId}|`;
        const stale: string[] = [];
        for (const [k, v] of saved) {
          if (k.startsWith(prefix)) decryptCache.set(k.slice(prefix.length), v);
          else stale.push(k);
        }
        if (stale.length) void saveDecrypted(uid, [], stale).catch(() => {});
      })
      .catch(() => {});
    dataState = { state: 'connecting' };
    emit();
    flush(); // edits made while locked, or left over from a previous session
    startData();
  }

  function dropKey() {
    stopData();
    dek = null;
    dekKeyId = null;
    decryptCache.clear();
    decodeMemo = newDecodeMemo();
    dataWarning = undefined;
    lock = meta ? 'locked' : meta === null ? 'needs-setup' : 'checking';
    emit();
  }

  /** Delete what's left of the account in the cloud and leave the final marker. */
  async function eraseCloud(fs: FS, db: Firestore) {
    const snaps = await Promise.all(
      (['meds', 'logs'] as const).map((c) => fs.getDocsFromServer(fs.collection(db, 'users', uid, c))),
    );
    const refs = snaps.flatMap((s) => s.docs.map((d) => d.ref));
    for (let i = 0; i < refs.length; i += MAX_BATCH) {
      const batch = fs.writeBatch(db);
      refs.slice(i, i + MAX_BATCH).forEach((r) => batch.delete(r));
      await batch.commit();
    }
    await fs.setDoc(fs.doc(db, 'users', uid, 'meta', 'crypto'), doneMarker());
  }

  /** The account is gone: stop for good and let the app clear this device. */
  function accountGone() {
    stopped = true;
    stopData();
    metaUnsub?.();
    metaUnsub = null;
    cleanup();
    onAccountDeleted?.();
  }

  let deletionTimer: ReturnType<typeof setTimeout> | null = null;
  let lastMetaSnap: DocumentSnapshot | null = null;
  function pauseForDeletion(at?: number) {
    if (!pausedForDeletion) {
      pausedForDeletion = paused = true;
      stopData();
    }
    // Look again once it would count as stalled (the marker may not change again to tell us).
    if (typeof at === 'number' && !deletionTimer) {
      deletionTimer = setTimeout(() => {
        deletionTimer = null;
        if (lastMetaSnap) onMeta(lastMetaSnap);
      }, Math.max(0, at + STALL_MS - Date.now()) + 1000);
    }
  }

  let finishing = false;

  function onMeta(snap: DocumentSnapshot) {
    if (stopped) return;
    lastMetaSnap = snap;
    metaError = undefined;
    const raw = snap.exists() ? (snap.data() as Record<string, unknown>) : undefined;
    const deletingHere = deletionInThisBrowser();
    if (raw?.deleted === true) {
      // Confirm with the server before acting (another tab's write shows up early as pending).
      if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
      const marker = raw as DeletionMarker;
      if (deletingHere) {
        // Another tab of this browser is deleting the account. Pause, and leave the sign-out and
        // the wipe to it (signing out here would cut off its deletion halfway).
        return pauseForDeletion();
      }
      if (marker.phase === 'deleting') {
        if (typeof marker.at === 'number' && Date.now() - marker.at < STALL_MS) return pauseForDeletion(marker.at);
        // That deletion stalled (the device doing it went away): finish it.
        pauseForDeletion();
        if (!finishing && ctx) {
          finishing = true;
          const { fs, db } = ctx;
          void eraseCloud(fs, db).then(accountGone, () => {
            finishing = false;
          });
        }
        return;
      }
      // Done (or marked by an older version, which doesn't say): this device's copy goes too.
      return accountGone();
    }
    if (pausedForDeletion) {
      // Gone (whoever deleted it wipes this device's tabs and signs out) or still being deleted.
      if (!raw || deletingHere || snap.metadata.fromCache) return;
      // That deletion failed and the account's settings are back: resume, merging this device's
      // data back in (the deletion may have erased some of the cloud copy before it failed).
      pausedForDeletion = paused = false;
      if (deletionTimer) clearTimeout(deletionTimer);
      forgetMerged();
      if (dek) {
        startData();
        flush();
      }
    }
    if (!raw) {
      if (snap.metadata.fromCache) return; // not known until the server answers
      meta = null;
      confirmedKeyId = null;
      if (dek) {
        stopData();
        keyWarning =
          "This account's encryption settings are missing from the cloud, so other devices can't unlock it. Sync is paused on this device.";
      } else {
        keyWarning = undefined;
        lock = 'needs-setup';
      }
      emit();
      return;
    }
    let parsed: CryptoMeta;
    try {
      parsed = parseCryptoMeta(raw);
    } catch (e) {
      if (dek) keyWarning = describeError(e);
      else metaError = describeError(e);
      emit();
      return;
    }
    meta = parsed;
    keyWarning = undefined;
    const resetting = raw.resetting === true && typeof raw.resetAt === 'number' && Date.now() - raw.resetAt < STALL_MS;
    if (!snap.metadata.fromCache) {
      confirmedKeyId = resetting ? null : parsed.keyId;
      startData(); // if this device's key is the confirmed one and it was waiting
    }
    if (resetting && dek && !snap.metadata.fromCache) {
      // Another device is resetting the encryption: stop before its deletions arrive (they'd
      // look like everything was deleted). The new key replaces this one shortly.
      dropKey();
      forgetMerged();
      keyWarning = 'The encryption for this account is being reset on another device. Unlock again once it has finished.';
    } else if (dek && dekKeyId !== parsed.keyId) {
      if (snap.metadata.fromCache) return; // confirm with the server before acting
      // The account key was replaced (e.g. reset elsewhere): this device's key is stale.
      const staleKeyId = dekKeyId ?? '';
      dropKey();
      keyWarning = 'The encryption key for this account was replaced on another device. Unlock again to keep syncing.';
      forgetMerged();
      // If another tab of this browser made the new key it's already stored: keep and use it, and
      // forget the stored key only if it's the stale one.
      void forgetDeviceKeyIf(uid, staleKeyId)
        .then(() => loadDeviceKey(uid))
        .then((stored) => {
          if (stopped || dek || !stored || stored.keyId !== meta?.keyId) return;
          keyWarning = undefined;
          setKey(stored.key, stored.keyId);
        });
    } else if (!dek) {
      lock = 'locked';
      if (resetting) keyWarning = 'The encryption for this account is being reset on another device.';
    }
    emit();
  }

  /** After a key change elsewhere, the next unlock merges this device's data into the cloud again. */
  function forgetMerged() {
    try {
      localStorage.removeItem(SYNCED_KEY);
    } catch {
      /* ignore */
    }
  }

  // Another tab unlocked or forgot the key.
  const onChannel = (e: MessageEvent) => {
    const target = (e.data as { uid?: string })?.uid;
    if (stopped || (target !== uid && target !== '*')) return;
    void loadDeviceKey(uid).then((stored) => {
      if (stopped) return;
      if (stored && !dek && (!meta || meta.keyId === stored.keyId)) setKey(stored.key, stored.keyId);
      else if (!stored && dek) dropKey();
    });
  };
  keyChannel()?.addEventListener('message', onChannel);

  async function remember(key: CryptoKey, keyId: string) {
    try {
      await saveDeviceKey(uid, { key, keyId });
      keyChannel()?.postMessage({ uid });
    } catch {
      keyWarning = "This browser couldn't remember the key, so you'll be asked to unlock again next time.";
    }
  }

  let metaUnsub: (() => void) | null = null;
  function watchMeta() {
    if (!ctx || stopped || metaUnsub) return;
    const { db, fs } = ctx;
    metaUnsub = fs.onSnapshot(fs.doc(db, 'users', uid, 'meta', 'crypto'), { includeMetadataChanges: true }, onMeta, (e) => {
      if ((e as { code?: string }).code === 'permission-denied') {
        metaError = "Cloud sync can't read this account's encryption settings. The Firestore security rules may need updating.";
      } else {
        metaError = describeError(e);
      }
      emit();
    });
  }

  // ---------- start ----------
  emit();
  watchOrphans();
  Promise.all([getDb(), loadDeviceKey(uid)])
    .then(([c, stored]) => {
      if (stopped) return;
      ctx = c;
      if (stored) setKey(stored.key, stored.keyId);
      watchMeta();
    })
    .catch((e) => {
      metaError = describeError(e);
      emit();
    });

  // ---------- key actions ----------
  const need = () => {
    if (!ctx) throw new SyncCryptoError('not-ready');
    return ctx;
  };
  const needOnline = () => {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new SyncCryptoError('offline');
  };
  const needUnlocked = (): { m: CryptoMeta; key: CryptoKey } => {
    if (!dek || !meta) throw new SyncCryptoError('not-ready');
    return { m: meta, key: dek };
  };

  /** Write meta only if nobody changed it since `base` was read. */
  async function writeMeta(next: CryptoMeta, base: CryptoMeta) {
    needOnline();
    const { db, fs } = need();
    const ref = fs.doc(db, 'users', uid, 'meta', 'crypto');
    await fs.runTransaction(db, async (tx) => {
      const cur = await tx.get(ref);
      const data = cur.data() as Partial<CryptoMeta> | undefined;
      if (!cur.exists() || data?.keyId !== base.keyId || data?.rev !== base.rev) throw new SyncCryptoError('changed-elsewhere');
      tx.set(ref, next);
    });
    meta = next;
    emit();
  }

  return {
    push(prev, next) {
      if (!stopped) enqueue(diffAppData(prev, next));
    },
    deletedInCloud: (medId) => remoteTombstones.has(medId),
    stop() {
      stopped = true;
      stopData();
      metaUnsub?.();
      metaUnsub = null;
      cleanup();
    },

    async prepareSetup(passphrase) {
      const { db, fs } = need();
      if (meta) throw new SyncCryptoError('already-set-up');
      if (estimatePassphraseStrength(passphrase).score < 1) throw new SyncCryptoError('weak-passphrase');
      const bundle = await createKeyBundle(uid, passphrase);
      return {
        recoveryKey: bundle.recoveryKey,
        finish: async () => {
          needOnline();
          const ref = fs.doc(db, 'users', uid, 'meta', 'crypto');
          await fs.runTransaction(db, async (tx) => {
            if ((await tx.get(ref)).exists()) throw new SyncCryptoError('already-set-up');
            tx.set(ref, bundle.meta);
          });
          meta = bundle.meta;
          confirmedKeyId = bundle.meta.keyId; // just written to the server
          await remember(bundle.dek, bundle.meta.keyId);
          setKey(bundle.dek, bundle.meta.keyId);
        },
      };
    },

    async unlock(secret, kind) {
      need();
      if (!meta) throw new SyncCryptoError('not-ready');
      const m = meta;
      const key = kind === 'recovery' ? await unlockWithRecoveryKey(m, uid, secret) : await unlockWithPassphrase(m, uid, secret);
      await remember(key, m.keyId);
      setKey(key, m.keyId);
    },

    async changePassphrase(newPassphrase) {
      const { m, key } = needUnlocked();
      if (estimatePassphraseStrength(newPassphrase).score < 1) throw new SyncCryptoError('weak-passphrase');
      await writeMeta(await rewrapPassphrase(m, uid, key, newPassphrase), m);
    },

    async getRecoveryKey() {
      const { m, key } = needUnlocked();
      return readRecoveryKey(m, uid, key);
    },

    async prepareNewRecoveryKey() {
      const { m, key } = needUnlocked();
      const next = await regenerateRecoveryKey(m, uid, key);
      return { recoveryKey: next.recoveryKey, finish: () => writeMeta(next.meta, m) };
    },

    async prepareReset(passphrase) {
      const { db, fs } = need();
      if (estimatePassphraseStrength(passphrase).score < 1) throw new SyncCryptoError('weak-passphrase');
      const bundle = await createKeyBundle(uid, passphrase);
      return {
        recoveryKey: bundle.recoveryKey,
        finish: async () => {
          needOnline();
          const metaRef = fs.doc(db, 'users', uid, 'meta', 'crypto');
          // Tell other devices first, so they stop syncing before the deletions below reach them
          // (they'd look like everything was deleted). The old keys stay, so an interrupted reset
          // leaves things working and can simply be run again.
          await fs.runTransaction(db, async (tx) => {
            const cur = await tx.get(metaRef);
            const data = cur.data();
            if (!cur.exists() || !data || data.deleted === true) throw new SyncCryptoError('changed-elsewhere');
            tx.set(metaRef, { ...data, resetting: true, resetAt: Date.now() });
          });
          await sleep(2000);
          const snaps = await Promise.all(
            (['meds', 'logs'] as const).map((c) => fs.getDocsFromServer(fs.collection(db, 'users', uid, c))),
          );
          const refs = snaps.flatMap((s) => s.docs.map((d) => d.ref));
          for (let i = 0; i < refs.length; i += MAX_BATCH) {
            const batch = fs.writeBatch(db);
            refs.slice(i, i + MAX_BATCH).forEach((r) => batch.delete(r));
            await batch.commit();
          }
          if (dek) stopData();
          dek = null;
          dekKeyId = null;
          meta = bundle.meta; // so our own meta listener doesn't treat the new key as foreign
          confirmedKeyId = bundle.meta.keyId;
          await fs.setDoc(metaRef, bundle.meta);
          attempted.clear();
          forgetMerged(); // merge this device's data into the now-empty cloud
          await remember(bundle.dek, bundle.meta.keyId);
          setKey(bundle.dek, bundle.meta.keyId);
        },
      };
    },

    async forgetKey() {
      await forgetDeviceKey(uid);
      keyChannel()?.postMessage({ uid });
      dropKey();
    },

    async deleteCloudData() {
      needOnline();
      if (cloudDeleted) return;
      const { db, fs } = need();
      if (stopped) throw new SyncCryptoError('not-ready');
      // Stop listening (so the deletions below don't wipe the local copy before this finishes)
      // and hold back new uploads.
      paused = true;
      stopData();
      metaUnsub?.();
      metaUnsub = null;
      const metaRef = fs.doc(db, 'users', uid, 'meta', 'crypto');
      let previousMeta: DocumentSnapshot | null = null;
      let marked = false;
      const setDeletingFlag = (on: boolean) => {
        try {
          if (on) localStorage.setItem(DELETING_KEY, String(Date.now()));
          else localStorage.removeItem(DELETING_KEY);
        } catch {
          /* storage unavailable */
        }
      };
      // Other tabs of this browser share the sign-in: they must pause, not sign out (see onMeta).
      setDeletingFlag(true);
      try {
        // Uploads already being prepared are committed first. Firestore applies one client's
        // writes in order, so the deletes below land after them.
        await writeChain;
        previousMeta = await fs.getDocFromServer(metaRef);
        // Tell other devices first: they pause, and the security rules refuse new data from now on.
        await fs.setDoc(metaRef, deletingMarker());
        marked = true;
        await eraseCloud(fs, db);
      } catch (e) {
        // Put the encryption settings back so this and other devices keep working, then resume.
        if (marked) {
          // If the connection dropped, this waits for it to come back; don't hold the dialog that long.
          const restore = previousMeta?.exists() ? fs.setDoc(metaRef, previousMeta.data()) : fs.deleteDoc(metaRef);
          await Promise.race([restore, sleep(10_000)]).catch(() => {
            /* best effort: a stalled marker is finished by the next device that sees it */
          });
        }
        setDeletingFlag(false);
        forgetMerged(); // the deletion may have erased part of the cloud copy: merge this device's back in
        paused = false;
        watchMeta();
        if (dek) {
          startData();
          flush();
        }
        throw e;
      }
      // The flag stays until wipeDevice() clears this device, so other tabs stay paused till then.
      stopped = true;
      cloudDeleted = true;
      writeQueue([]);
      try {
        localStorage.removeItem(SYNCED_KEY);
      } catch {
        /* ignore */
      }
      cleanup();
    },
  };
}
