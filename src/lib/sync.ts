// Cloud sync through Firestore (Firebase project sign-in-for-med), for signed-in Google accounts,
// end-to-end encrypted (see syncCrypto.ts).
//
// Model:
//  - The device's local copy (localStorage) is what the UI shows, so the app works offline.
//  - Every local edit becomes operations (see syncOps.ts) that are encrypted and written to
//    Firestore. They're queued in localStorage until the server acknowledges them, so edits made
//    offline, before the device was unlocked, or just before the app closed, still reach the cloud
//    on a later launch.
//  - Nothing is read or written until this device holds the account's data key (unlocked). The
//    only document read before that is `meta/crypto`, which holds the wrapped keys.
//  - Firestore snapshots from the server (plus this device's own pending writes) are decrypted in
//    order and replace the local copy, which is how edits from other devices arrive.
//  - The first time an account syncs on a device, local and cloud data are merged.
//  - Anything still stored in plaintext (from before encryption) is re-uploaded encrypted.
import type { DocumentSnapshot, Firestore, QuerySnapshot, WriteBatch } from 'firebase/firestore';
import type { AppData } from '../../shared/types';
import { getFirebaseApp } from './auth';
import { forgetAllDeviceKeys, forgetDeviceKey, loadDeviceKey, saveDeviceKey } from './keyStore';
import {
  SyncCryptoError,
  changePassphrase as rewrapPassphrase,
  createKeyBundle,
  decodeRemote,
  encryptLog,
  encryptMed,
  parseCryptoMeta,
  readRecoveryKey,
  regenerateRecoveryKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  type CryptoMeta,
  type DecodedRemote,
  type DecryptCache,
} from './syncCrypto';
import { diffAppData, keepLocalForFailed, logMonth, migrationOps, orphanLogs, plain, remoteToAppData, type SyncOp } from './syncOps';
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

/**
 * Sign-out: forget the sync keys stored on this device and drop the Firestore offline cache, so
 * the next person on this device can't read anything.
 */
export async function clearSyncCache(): Promise<void> {
  await forgetAllDeviceKeys();
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

/** Tells other open tabs that a device key was stored or forgotten. */
let channel: BroadcastChannel | null | undefined;
function keyChannel(): BroadcastChannel | null {
  if (channel === undefined) channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('medtracker-keys');
  return channel;
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

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function opKey(op: SyncOp): string {
  switch (op.kind) {
    case 'setMed':
      return `sm|${op.med.id}|${op.med.updatedAt}`;
    case 'deleteMed':
      return `dm|${op.id}`;
    case 'setLog':
      return `sl|${op.log.id}|${op.log.loggedAt}|${op.log.scheduledFor}`;
    case 'deleteLog':
      return `dl|${op.log.id}|${op.month ?? logMonth(op.log.scheduledFor)}`;
  }
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
  let dataUnsubs: (() => void)[] = [];
  let metaUnsub: (() => void) | null = null;
  const inFlight = new Set<string>();
  let lastStatus = '';

  // ---------- keys ----------
  /** undefined: not known yet; null: the server confirmed there's none (never set up). */
  let meta: CryptoMeta | null | undefined;
  let metaError: string | undefined;
  let dek: CryptoKey | null = null;
  let dekKeyId: string | null = null;
  let lock: LockState = 'checking';
  const decryptCache: DecryptCache = new Map();
  /** Migration/cleanup ops already sent this session, so a rejected one isn't retried in a loop. */
  const attempted = new Set<string>();

  // ---------- status ----------
  let dataState: { state: SyncState; message?: string } = { state: 'connecting' };
  /** Last write the server rejected; shown until a later write succeeds. */
  let writeError: string | undefined;
  let keyWarning: string | undefined;
  let dataWarning: string | undefined;

  const emit = () => {
    if (stopped) return;
    const warning = [keyWarning, dataWarning].filter(Boolean).join(' ') || undefined;
    let s: SyncStatus;
    if (lock === 'unlocked') s = writeError ? { state: 'error', message: writeError, lock, warning } : { ...dataState, lock, warning };
    else if (lock === 'needs-setup') s = { state: 'setup', lock, warning };
    else if (lock === 'locked') s = { state: 'locked', lock, warning };
    else s = metaError ? { state: 'error', lock, message: metaError, warning } : { state: 'connecting', lock, warning };
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
  async function addToBatch(batch: WriteBatch, fs: FS, db: Firestore, key: CryptoKey, op: SyncOp) {
    if (op.kind === 'setMed') {
      batch.set(fs.doc(db, 'users', uid, 'meds', op.med.id), await encryptMed(key, uid, plain(op.med)));
    } else if (op.kind === 'deleteMed') {
      batch.delete(fs.doc(db, 'users', uid, 'meds', op.id));
    } else if (op.kind === 'setLog') {
      const month = logMonth(op.log.scheduledFor);
      const env = await encryptLog(key, uid, month, plain(op.log));
      // mergeFields replaces this one log entry as a whole (merge: true would deep-merge it into
      // whatever was there, e.g. leave plaintext fields next to the ciphertext).
      batch.set(
        fs.doc(db, 'users', uid, 'logs', month),
        { logs: { [op.log.id]: env } },
        { mergeFields: [new fs.FieldPath('logs', op.log.id)] },
      );
    } else {
      batch.set(
        fs.doc(db, 'users', uid, 'logs', op.month ?? logMonth(op.log.scheduledFor)),
        { logs: { [op.log.id]: fs.deleteField() } },
        { merge: true },
      );
    }
  }

  // Batches are built (encrypted) one after another so they're committed in queue order.
  let writeChain: Promise<void> = Promise.resolve();

  function flush() {
    if (!ctx || stopped || !dek) return;
    const { db, fs } = ctx;
    const key = dek;
    const pending = queue.filter((q) => !inFlight.has(q.id));
    if (!pending.length) return;
    pending.forEach((q) => inFlight.add(q.id));
    writeChain = writeChain.then(async () => {
      for (let i = 0; i < pending.length; i += MAX_BATCH) {
        const chunk = pending.slice(i, i + MAX_BATCH);
        const ids = new Set(chunk.map((q) => q.id));
        const release = () => ids.forEach((id) => inFlight.delete(id));
        if (stopped || dek !== key) {
          release(); // locked meanwhile: they stay queued for the next unlock
          continue;
        }
        const batch = fs.writeBatch(db);
        try {
          for (const { op } of chunk) await addToBatch(batch, fs, db, key, op);
        } catch {
          release();
          setData({ state: 'error', message: "Couldn't encrypt changes for upload. They're saved on this device." });
          continue;
        }
        // Resolves when the server acknowledges (offline, it waits; Firestore keeps it queued).
        batch
          .commit()
          .then(() => {
            queue = queue.filter((q) => !ids.has(q.id));
            saveQueue();
            if (writeError) {
              writeError = undefined;
              emit();
            }
          })
          .catch((e) => {
            // Rejected by the server (e.g. rules): retrying won't help, so drop these ops.
            queue = queue.filter((q) => !ids.has(q.id));
            saveQueue();
            writeError = describeError(e);
            emit();
          })
          .finally(() => {
            release();
            // Migration and cleanup wait for an empty queue; give them a chance now.
            if (!queue.length) onSnapshots();
          });
      }
    });
  }

  // ---------- reading ----------
  let readSeq = 0;

  function onSnapshots() {
    if (stopped || !medsSnap || !logsSnap || !dek) return;
    const seq = ++readSeq;
    const key = dek;
    const fromServer = !medsSnap.metadata.fromCache && !logsSnap.metadata.fromCache;
    const pendingWrites = medsSnap.metadata.hasPendingWrites || logsSnap.metadata.hasPendingWrites;
    setData({ state: pendingWrites ? 'saving' : fromServer ? 'synced' : 'offline' });
    const medDocs = medsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
    const logDocs = logsSnap.docs.map((d) => ({ id: d.id, data: d.data() }));
    // Decryption is async: snapshots are processed in order and a stale result is dropped.
    decodeRemote(key, uid, medDocs, logDocs, decryptCache)
      .then((decoded) => {
        if (seq === readSeq && !stopped && dek === key) applySnapshot(decoded, fromServer, pendingWrites);
      })
      .catch(() => setData({ state: 'error', message: "Couldn't read the cloud copy." }));
  }

  function applySnapshot(decoded: DecodedRemote, fromServer: boolean, pendingWrites: boolean) {
    const remote = remoteToAppData(decoded.medDocs, decoded.logDocs);
    const skipped = decoded.undecryptable;
    const shown = keepLocalForFailed(remote.data, getLocal(), decoded.failedIds);
    dataWarning = skipped
      ? `${plural(skipped, 'cloud item')} couldn't be decrypted (damaged, changed, or encrypted with another key) and ${skipped === 1 ? 'was' : 'were'} skipped.`
      : undefined;
    emit();

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
        // First sync of this account on this device: combine both sides (mergeAppData also
        // collapses duplicate dose logs), then upload what the cloud is missing.
        const merged = mergeAppData(remote.data, getLocal());
        queue = []; // the merge already includes any edits queued before this point
        saveQueue();
        const migration = migrationOps(remote, decoded.plaintext);
        migration.forEach((op) => attempted.add(opKey(op)));
        enqueue([...migration, ...diffAppData(remote.data, merged)]);
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

    if (fromServer && !pendingWrites && !queue.length) {
      // Encrypt plaintext left from before encryption, and tidy up after races between devices.
      const ops: SyncOp[] = migrationOps(remote, decoded.plaintext);
      for (const l of remote.duplicateLogs) ops.push({ kind: 'deleteLog', log: l });
      for (const l of orphanLogs(decoded.logDocs, new Set(remote.data.medications.map((m) => m.id)))) {
        ops.push({ kind: 'deleteLog', log: l });
      }
      const fresh = ops.filter((op) => !attempted.has(opKey(op)));
      fresh.forEach((op) => attempted.add(opKey(op)));
      enqueue(fresh);
    }
    if (canonical(shown) !== canonical(getLocal())) applyRemote(shown);
  }

  function startData() {
    if (!ctx || stopped || dataUnsubs.length) return;
    const { db, fs } = ctx;
    const onErr = (e: unknown) => setData({ state: 'error', message: describeError(e) });
    dataUnsubs = [
      fs.onSnapshot(fs.collection(db, 'users', uid, 'meds'), { includeMetadataChanges: true }, (s) => {
        medsSnap = s;
        onSnapshots();
      }, onErr),
      fs.onSnapshot(fs.collection(db, 'users', uid, 'logs'), { includeMetadataChanges: true }, (s) => {
        logsSnap = s;
        onSnapshots();
      }, onErr),
    ];
  }

  function stopData() {
    dataUnsubs.forEach((u) => u());
    dataUnsubs = [];
    medsSnap = logsSnap = null;
    initialDone = false;
    readSeq++;
  }

  function setKey(key: CryptoKey, keyId: string) {
    if (stopped) return;
    dek = key;
    dekKeyId = keyId;
    lock = 'unlocked';
    decryptCache.clear();
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
    dataWarning = undefined;
    lock = meta ? 'locked' : meta === null ? 'needs-setup' : 'checking';
    emit();
  }

  function onMeta(snap: DocumentSnapshot) {
    if (stopped) return;
    metaError = undefined;
    if (!snap.exists()) {
      if (snap.metadata.fromCache) return; // not known until the server answers
      meta = null;
      if (dek) {
        keyWarning =
          "This account's encryption settings are missing from the cloud, so other devices can't unlock it. This device keeps syncing.";
      } else {
        keyWarning = undefined;
        lock = 'needs-setup';
      }
      emit();
      return;
    }
    let parsed: CryptoMeta;
    try {
      parsed = parseCryptoMeta(snap.data());
    } catch (e) {
      if (dek) keyWarning = describeError(e);
      else metaError = describeError(e);
      emit();
      return;
    }
    meta = parsed;
    keyWarning = undefined;
    if (dek && dekKeyId !== parsed.keyId) {
      if (snap.metadata.fromCache) return; // confirm with the server before acting
      // The account key was replaced (e.g. set up again elsewhere): this device's key is stale.
      void forgetDeviceKey(uid);
      dropKey();
      keyWarning = 'The encryption key for this account was replaced on another device. Unlock again to keep syncing.';
    } else if (!dek) {
      lock = 'locked';
    }
    emit();
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

  // ---------- start ----------
  emit();
  Promise.all([getDb(), loadDeviceKey(uid)])
    .then(([c, stored]) => {
      if (stopped) return;
      ctx = c;
      const { db, fs } = c;
      if (stored) setKey(stored.key, stored.keyId);
      metaUnsub = fs.onSnapshot(fs.doc(db, 'users', uid, 'meta', 'crypto'), { includeMetadataChanges: true }, onMeta, (e) => {
        if ((e as { code?: string }).code === 'permission-denied') {
          metaError = "Cloud sync can't read this account's encryption settings. The Firestore security rules may need updating.";
        } else {
          metaError = describeError(e);
        }
        emit();
      });
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
    stop() {
      stopped = true;
      stopData();
      metaUnsub?.();
      keyChannel()?.removeEventListener('message', onChannel);
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
          // Delete the old documents first: if this is interrupted, the old keys still apply and
          // the reset can simply be run again.
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
          await fs.setDoc(fs.doc(db, 'users', uid, 'meta', 'crypto'), bundle.meta);
          attempted.clear();
          try {
            localStorage.removeItem(SYNCED_KEY); // merge this device's data into the now-empty cloud
          } catch {
            /* ignore */
          }
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
  };
}
