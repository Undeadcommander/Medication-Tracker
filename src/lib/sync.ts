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
//    only document read before that is `meta/crypto`, which holds the wrapped keys. Until then the
//    app doesn't load this device's copy either (see store.ts): once an account uses encryption,
//    its data is only shown after it's unlocked, and a locked device keeps its copy encrypted
//    (see localSeal.ts).
//  - Cloud snapshots are decrypted (cached across launches) and combined with the local copy
//    (syncOps.reconcile): medications merge field by field, deleted ones leave a permanent marker,
//    and edits not uploaded yet are kept.
//  - The first time an account syncs on a device, local and cloud data are merged.
//  - Anything still stored in plaintext (from before encryption), or filed in an older document
//    layout, is moved and re-uploaded encrypted.
import type { DocumentData, DocumentSnapshot, Firestore, QuerySnapshot, SnapshotMetadata, WriteBatch } from 'firebase/firestore';
import type { AppData } from '../../shared/types';
import { FIRESTORE_STORAGE_PREFIX, getFirebaseApp } from './auth';
import { forgetAllDeviceKeys, forgetDeviceKey, forgetDeviceKeyIf, loadDeviceKey, saveDeviceKey } from './keyStore';
import { clearDecrypted, loadDecrypted, saveDecrypted } from './localDb';
import { discardReadable, sealLocal } from './localSeal';
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
  flushStep,
  logDocId,
  mergeRef,
  migrationRefs,
  parseQueue,
  plain,
  queueKey,
  reconcile,
  refKey,
  remoteToAppData,
  resolveRefs,
  summarizePending,
  toRefs,
  type FlushBlock,
  type FlushCheck,
  type OpRef,
  type PendingSummary,
  type QueuedOp,
  type SyncOp,
} from './syncOps';
import { estimatePassphraseStrength, mergeAppData } from './vault';

export type SyncState = 'connecting' | 'synced' | 'saving' | 'offline' | 'error' | 'locked' | 'setup';
/** checking: waiting for the account's encryption settings; needs-setup: encryption never set up. */
export type LockState = 'checking' | 'needs-setup' | 'locked' | 'unlocked';
/**
 * Why the account's encryption settings couldn't be read (while `checking`): `settings`, they can't
 * be used by this version (newer, or damaged); `access`, the cloud refused to read them; `connection`,
 * the cloud couldn't be reached. (The latter two can be retried, see SyncHandle.retry.)
 */
export type SyncProblem = 'settings' | 'access' | 'connection';
export interface SyncStatus {
  state: SyncState;
  lock: LockState;
  message?: string;
  /**
   * With state 'error' while checking: what kind of problem it is. Also set while locked or
   * unlocked (with `message`) when the settings stopped being watched ('access' or 'connection'):
   * changes made elsewhere aren't seen until retry() (or coming back online) restarts it.
   */
  problem?: SyncProblem;
  /**
   * With `problem` while locked or unlocked: what's wrong with the settings, which `message` may
   * not say (an upload refused meanwhile takes `message`, so both are shown).
   */
  problemMessage?: string;
  /** Non-fatal problem worth showing (e.g. items that couldn't be decrypted). */
  warning?: string;
  /**
   * The cloud copy has been read and shown on this device since sync started. Until then, a new
   * device may be missing medications that are on the user's other devices.
   */
  cloudLoaded: boolean;
}

/** Why the cloud couldn't be brought up to date (see SyncHandle.flushAll). */
export type FlushProblem = FlushBlock | 'error' | 'timeout' | 'cancelled';
export type FlushResult =
  | { ok: true }
  | { ok: false; reason: FlushProblem; /** Details, e.g. the cloud's error. */ message?: string; pending: PendingSummary };

/** A new key or recovery key that's been created but not saved yet (show it to the user first). */
export interface PreparedKeyChange {
  recoveryKey: string;
  finish(): Promise<void>;
}

/** The account's data key while unlocked. `stored`: it's this device's stored key (see keyStore). */
export interface UnlockedKey {
  key: CryptoKey;
  keyId: string;
  stored: boolean;
}

export interface SyncHandle {
  /**
   * Record a local edit (state before → after) for upload. With `saved`, it's only queued once
   * that resolves true (saved on this device); false drops it (refused: the copy here was locked
   * meanwhile). Until then it counts as queued for what's shown, and for flushAll.
   */
  push(prev: AppData, next: AppData, saved?: Promise<boolean>): void;
  stop(): void;
  /** The encryption settings couldn't be read (see SyncProblem): try again. */
  retry(): void;
  /**
   * This device's copy was locked in another tab (its readable copy is encrypted, see localDb
   * storeSealed), but this tab hadn't heard yet: stop using the key here.
   */
  lockedElsewhere(): void;
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
  /**
   * Remove the data key from this device. Its copy of the data is kept encrypted with the key (see
   * localSeal.ts), so it can't be read here until unlocked again; sync pauses meanwhile.
   */
  forgetKey(): Promise<void>;
  /** The account's data key, while unlocked (and sync is running). */
  dataKey(): UnlockedKey | null;
  /**
   * This device's copy is loaded and shown again (see localHidden), e.g. after encrypting it
   * failed: upload what was queued while it was hidden.
   */
  localShown?(): void;
  /**
   * Account deletion: delete every cloud document of this account and leave a permanent "deleted"
   * marker in place of the encryption settings. Other devices are told first (they pause, then
   * remove their own copies once it's done). Works whether or not this device is unlocked.
   */
  deleteCloudData(): Promise<void>;
  /** The medication is deleted for good in the cloud (as far as this device has seen). */
  deletedInCloud(medId: string): boolean;
  /**
   * Before signing out: upload everything this device has that the cloud doesn't (and wait for
   * other open tabs to upload theirs) until the server has confirmed it. Resolves ok only when that's
   * certain, which it can be offline or locked if nothing is waiting; otherwise says why not and
   * what's missing. Gives up once uploads stop making progress for a while.
   */
  flushAll(opts?: {
    /** Also wait for the cloud copy to be read (it may hold medications this device is missing). */
    needCloud?: boolean;
    signal?: AbortSignal;
    /** Changes still waiting to upload, as they go. */
    onProgress?: (remaining: number) => void;
  }): Promise<FlushResult>;
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
/** flushAll gives up when uploads make no progress for this long. */
const FLUSH_STALL_MS = 15_000;
/** And when Firestore hasn't confirmed its own pending writes in this long. */
const FLUSH_CONFIRM_MS = 10_000;

type FS = typeof import('firebase/firestore');
let dbPromise: Promise<{ db: Firestore; fs: FS }> | null = null;

/** Start loading Firestore ahead of sync (e.g. while this device's own copy is still loading). */
export function preloadSync(): void {
  getDb().catch(() => {
    /* startSync retries and reports it */
  });
}

/**
 * The Firestore client, once no clearing of its offline cache is under way (see clearSyncCache):
 * sync opening it meanwhile would be cut off, or open the half-deleted cache.
 */
function getDb(): Promise<{ db: Firestore; fs: FS }> {
  return clearing ? clearing.then(() => getDb()) : openDb();
}

/** A clearing of the Firestore offline cache under way in this tab (see clearSyncCache). */
let clearing: Promise<void> | null = null;
/** Each sync started in this tab: whether it's still running (see clearSyncCache's unlessSyncing). */
const liveSyncs = new Set<() => boolean>();
function syncRunningHere(): boolean {
  for (const running of [...liveSyncs]) {
    if (running()) return true;
    liveSyncs.delete(running);
  }
  return false;
}

function openDb(): Promise<{ db: Firestore; fs: FS }> {
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
 * the next person on this device can't read anything. One at a time, and sync opening Firestore
 * meanwhile waits until it's done. `unlessSyncing`: not if sync is running in this tab when it
 * would start (it'd be cut off); resolves false then, without doing anything.
 */
export function clearSyncCache(
  opts: {
    openFirst?: boolean;
    unlessSyncing?: boolean;
    /** Only the Firestore offline cache: every account's keys and decrypted items stay. */
    firestoreOnly?: boolean;
  } = {},
): Promise<boolean> {
  const prev = clearing ?? Promise.resolve();
  const run = prev.then(async () => {
    if (opts.unlessSyncing && syncRunningHere()) return false;
    await clearSyncCacheNow(opts);
    return true;
  });
  const settled = run.then(
    () => {},
    () => {},
  );
  clearing = settled;
  void settled.then(() => {
    if (clearing === settled) clearing = null;
  });
  return run;
}

async function clearSyncCacheNow(opts: { openFirst?: boolean; firestoreOnly?: boolean }): Promise<void> {
  if (!opts.firestoreOnly) {
    await forgetAllDeviceKeys();
    await clearDecrypted();
    keyChannel()?.postMessage({ uid: '*' });
  }
  // Not opened in this tab (or it failed earlier): open it to clear it, if asked (signed-in accounts).
  if (!dbPromise && opts.openFirst) await Promise.race([openDb().catch(() => {}), sleep(5000)]);
  let cleared = false;
  if (dbPromise) {
    const opening = dbPromise;
    dbPromise = null;
    try {
      const { db, fs } = await Promise.race([
        opening,
        sleep(5000).then(() => Promise.reject(new Error('Firestore took too long to open'))),
      ]);
      await fs.terminate(db);
      // Other tabs close their copy when it's deleted; one that doesn't (frozen, or an old version
      // of the app) holds the deletion back until it does, which mustn't hold up signing out.
      cleared = await Promise.race([fs.clearIndexedDbPersistence(db).then(() => true), sleep(5000).then(() => false)]);
    } catch {
      /* best effort: see below */
    }
  }
  // It couldn't be opened or cleared (e.g. offline before it was loaded): delete its databases directly.
  if (!cleared && opts.openFirst) await deleteFirestoreDatabases();
  // Firestore also shares state between tabs in localStorage (pending writes, which end with the
  // uid, plus its clients, online state and sequence number). Removed last, once no Firestore is left
  // running here (the other tabs closed theirs before this), so none writes them back. Only this
  // app's: another Firebase app on this origin keeps its own there, pending writes included.
  try {
    const stale: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && isOwnFirestoreKey(k)) stale.push(k);
    }
    stale.forEach((k) => localStorage.removeItem(k));
  } catch {
    /* storage unavailable */
  }
}

/** One of this app's Firestore keys in localStorage: "firestore_<kind>_<prefix>", maybe then "_<id>". */
function isOwnFirestoreKey(key: string): boolean {
  if (!key.startsWith('firestore_')) return false;
  const at = key.indexOf(`_${FIRESTORE_STORAGE_PREFIX}`);
  if (at < 0) return false;
  const end = at + 1 + FIRESTORE_STORAGE_PREFIX.length;
  return /^[a-z0-9_]+$/.test(key.slice('firestore_'.length, at)) && (end === key.length || key[end] === '_');
}

/** Delete this app's Firestore offline cache databases without opening Firestore. */
async function deleteFirestoreDatabases(): Promise<void> {
  try {
    const dbs = (await indexedDB.databases?.()) ?? [];
    const names = dbs.map((d) => d.name).filter((n): n is string => !!n?.startsWith(FIRESTORE_STORAGE_PREFIX));
    const deleteOne = (name: string) =>
      new Promise<void>((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = () => resolve();
      });
    await Promise.race([Promise.all(names.map(deleteOne)), sleep(5000)]); // a tab still using one holds it back
  } catch {
    /* not supported */
  }
}

/**
 * Close this tab's Firestore client without clearing anything: another tab is signing out and
 * deleting the offline cache, which waits for every tab to let go of it. The next sync opens a new one.
 */
export async function releaseSyncClient(): Promise<void> {
  const p = dbPromise;
  dbPromise = null;
  if (!p) return;
  try {
    const { db, fs } = await p;
    await fs.terminate(db);
  } catch {
    /* already closed */
  }
}

// ---------- whether an account uses encryption, as last seen on this device ----------
// Kept so an encrypted account is never treated as unencrypted (its data shown without
// unlocking) just because its settings haven't loaded yet, e.g. offline.

const encryptionKey = (uid: string) => `medtracker.e2ee.${uid}`;

/** 'on': this account uses end-to-end encryption; 'off': the cloud said it doesn't (yet); null: not known here. */
export function encryptionMarker(uid: string): 'on' | 'off' | null {
  try {
    const v = localStorage.getItem(encryptionKey(uid));
    return v === '1' ? 'on' : v === '0' ? 'off' : null;
  } catch {
    return null;
  }
}

function setEncryptionMarker(uid: string, on: boolean): void {
  try {
    // Once on, it stays on: it's only removed with the rest of the account's state (signing out).
    if (on) localStorage.setItem(encryptionKey(uid), '1');
    else if (localStorage.getItem(encryptionKey(uid)) === null) localStorage.setItem(encryptionKey(uid), '0');
  } catch {
    /* storage unavailable: treated as not known */
  }
}

/** Everything this device had for the account is in the cloud: merged once, and nothing waiting to upload. */
function fullySynced(uid: string): boolean {
  try {
    if (localStorage.getItem(`medtracker.synced.${uid}`) !== '1') return false;
    const q = JSON.parse(localStorage.getItem(queueKey(uid)) ?? '[]') as unknown;
    return Array.isArray(q) && q.length === 0;
  } catch {
    return false;
  }
}

/** Accounts whose local copy is being secured in this tab (see secureLocalCopy). */
const securing = new Map<string, Promise<void>>();

/**
 * Resolves once any securing of this account's local copy that's under way in this tab has
 * finished: signing back in (or unlocking) waits for it, so the copy can't be opened with a key
 * that's about to be forgotten.
 */
export function localCopySettled(uid: string): Promise<void> {
  return (securing.get(uid) ?? Promise.resolve()).catch(() => {});
}

/**
 * Make sure a locked encrypted account's data can't be read on this device: encrypted with this
 * device's stored key (which is forgotten first) or, without one, removed if it's all in the cloud.
 * (Otherwise it's kept as it is, and only shown once unlocked.) Also drops the cache of decrypted
 * cloud items. For when the account is signed out outside the app (e.g. the session expired or
 * was revoked): the queued uploads stay, and unlocking again brings it all back.
 */
export function secureLocalCopy(userId: string, uid: string): Promise<void> {
  const run = localCopySettled(uid)
    .then(() => secure(userId, uid))
    .finally(() => {
      if (securing.get(uid) === run) securing.delete(uid);
    });
  securing.set(uid, run);
  return run;
}

async function secure(userId: string, uid: string): Promise<void> {
  if (encryptionMarker(uid) !== 'on') return; // unencrypted (or never synced here): nothing to lock
  const stored = await loadDeviceKey(uid);
  let secured = false;
  if (stored) {
    // Forgotten first, so nothing (another tab, signing back in) can unlock with it meanwhile. If
    // encrypting then fails, the readable copy stays as it is: not shown until unlocked with the
    // passphrase, which loads it again.
    await forgetDeviceKeyIf(uid, stored.keyId);
    secured = await sealLocal(userId, uid, stored.key, stored.keyId).catch(() => false);
    // Then other tabs lock too, encrypting first anything they saved meanwhile (see forgetKey).
    // (Edits they save after this copy was encrypted are refused: see localDb storeSealed.)
    keyChannel()?.postMessage((secured ? { uid, forgot: stored.keyId } : { uid }) satisfies KeyMessage);
  }
  if (!secured) await discardIfSynced(userId, uid);
  await clearDecrypted(uid);
}

/** Locked without a key to encrypt it with: remove the readable copy if the cloud has all of it. */
export async function discardIfSynced(userId: string, uid: string): Promise<boolean> {
  if (encryptionMarker(uid) !== 'on' || !fullySynced(uid)) return false;
  await discardReadable(userId).catch(() => {});
  return true;
}

/** Remove what this device keeps about an account's sync: queued uploads, flags, cache and device key. */
/**
 * Dose logs whose upload the cloud refused: they stay on this device only (the sign-out check says
 * so). Kept per account in this browser, so a reload or another tab doesn't take them for logs
 * removed elsewhere (see reconcile).
 */
const keptKey = (uid: string) => `medtracker.kept.${uid}`;
function readKept(uid: string): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(keptKey(uid)) ?? '[]');
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
  } catch {
    return new Set();
  }
}
function writeKept(uid: string, ids: Iterable<string>): void {
  const list = [...ids];
  try {
    if (list.length) localStorage.setItem(keptKey(uid), JSON.stringify(list));
    else localStorage.removeItem(keptKey(uid));
  } catch {
    /* storage unavailable */
  }
}

export async function forgetSyncState(uid: string): Promise<void> {
  try {
    localStorage.removeItem(queueKey(uid));
    localStorage.removeItem(keptKey(uid));
    localStorage.removeItem(`medtracker.synced.${uid}`);
    localStorage.removeItem(`medtracker.deleting.${uid}`);
    localStorage.removeItem(encryptionKey(uid));
  } catch {
    /* storage unavailable */
  }
  await clearDecrypted(uid);
  await forgetDeviceKey(uid);
  keyChannel()?.postMessage({ uid });
}

/**
 * Tells other open tabs that a device key was stored or forgotten. `forgot`: the key with this
 * keyId was forgotten to lock the account here (its local copy encrypted with it): see forgetKey.
 */
type KeyMessage = { uid: string; forgot?: string };
let channel: BroadcastChannel | null | undefined;
function keyChannel(): BroadcastChannel | null {
  if (channel === undefined) channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('medtracker-keys');
  return channel;
}

const MAX_BATCH = 400; // Firestore allows 500 writes per batch
const MAX_BATCH_BYTES = 8 * 1024 * 1024; // and 10 MiB per request
/** Dose log entries one write may change in a log document (the security rules check each one). */
const LOG_ENTRIES_PER_WRITE = 8;
/** Tidy-ups (moves, duplicate and expired removals) queued per round, to keep the queue small. */
const MAX_TIDY_PER_ROUND = 2000;

/** Errors that mean the cloud couldn't be reached (rather than refused or unreadable). */
function isConnectionError(e: unknown): boolean {
  if (e instanceof SyncCryptoError) return e.code === 'offline';
  const code = (e as { code?: string })?.code;
  return !code || ['unavailable', 'deadline-exceeded', 'cancelled', 'aborted', 'unknown', 'internal'].includes(code);
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
/**
 * A passphrase must be rated before it's accepted: when the strength checker can't be loaded the
 * answer is "can't tell" (an error), never "fine".
 */
async function requireStrongEnough(passphrase: string): Promise<void> {
  let strength;
  try {
    strength = await estimatePassphraseStrength(passphrase);
  } catch {
    throw new SyncCryptoError('strength-unavailable');
  }
  if (strength.score < 1) throw new SyncCryptoError('weak-passphrase');
}

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
/** Resolves after `ms`, or as soon as `signal` aborts. */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', done);
      resolve();
    };
    const t = setTimeout(done, ms);
    signal?.addEventListener('abort', done);
  });

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
  /**
   * The session has ended: signed out, or the account deleted in some tab of this browser, even one
   * that didn't tell this one (see session.ts). Nothing more is queued, kept or uploaded; the caller
   * stops sync.
   */
  isEnded?: () => boolean;
  /**
   * Resolves once this device's copy is loaded (getLocal returns it): cloud data is merged with it
   * only then. Asked again each time, since the copy is unloaded while locked.
   */
  localReady?: () => Promise<void>;
  /** This device's copy isn't loaded (locked): getLocal doesn't show what's on this device. */
  localHidden?: () => boolean;
  /**
   * The key is being forgotten here (or was in another tab, `elsewhere`): stop using this device's
   * copy and encrypt it with the key (see localSeal.ts). Rejects if that failed (the copy is then
   * as it was, and should be shown again). `unless`: checked once no other tab is loading or
   * locking the copy; if it holds, nothing is done (and it rejects).
   */
  sealLocal?: (
    key: CryptoKey,
    keyId: string,
    opts?: { elsewhere?: boolean; unless?: () => Promise<boolean>; onSealed?: () => Promise<void> },
  ) => Promise<void>;
}): SyncHandle {
  const { uid, getLocal, applyRemote, onStatus, onAccountDeleted } = opts;
  const localReady = () => opts.localReady?.() ?? Promise.resolve();
  const localHidden = () => opts.localHidden?.() ?? false;
  const ended = () => opts.isEnded?.() ?? false;
  const QUEUE_KEY = queueKey(uid);
  const SYNCED_KEY = `medtracker.synced.${uid}`;
  const DELETING_KEY = `medtracker.deleting.${uid}`;

  let stopped = false;
  liveSyncs.add(() => !stopped); // (a clearing of the offline cache waits: see clearSyncCache)
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
  /** Changes dropped from the queue this session without reaching the cloud (refused, or unbuildable). */
  let refusedCount = 0;
  let ctx: { db: Firestore; fs: FS } | null = null;
  let initialDone = false;
  // Whether the cloud copy was last read from the server and merged in here. Offline, an upload
  // would replace a medication (or dose log) changed on another device meanwhile, since the whole
  // document is written: uploads wait until the server's copy has been merged again.
  let serverCurrent = false;
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
  /** What kind of problem metaError is. */
  let metaProblem: SyncProblem | undefined;
  /** Stops watching the settings; null while they aren't being watched. */
  let metaUnsub: (() => void) | null = null;
  let dek: CryptoKey | null = null;
  let dekKeyId: string | null = null;
  /** The key is this device's stored key (not only held here: storing it failed). */
  let dekStored = false;
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
  /** The account's settings were last seen unreadable here (made by a newer version, or damaged). */
  let settingsUnreadable: string | undefined;
  let dataWarning: string | undefined;

  const emit = () => {
    if (stopped) return;
    const warning = [keyWarning, dataWarning].filter(Boolean).join(' ') || undefined;
    let s: SyncStatus;
    // The settings aren't being watched any more (the listener failed): retry() starts it again.
    const stalled =
      metaError && !metaUnsub && (metaProblem === 'access' || metaProblem === 'connection') ? metaProblem : undefined;
    if (lock === 'unlocked') {
      // metaError: the key was loaded from this device but the account's settings can't be read.
      // A refused upload is said first; the settings no longer being watched is said either way.
      const error = writeError ?? metaError;
      s = error
        ? { state: 'error', message: error, ...(stalled && { problem: stalled, problemMessage: metaError }), lock, warning, cloudLoaded }
        : { ...dataState, lock, warning, cloudLoaded };
    } else if (lock === 'needs-setup') s = { state: 'setup', lock, warning, cloudLoaded };
    else if (lock === 'locked') {
      s = stalled
        ? { state: 'locked', lock, message: metaError, problem: stalled, problemMessage: metaError, warning, cloudLoaded }
        : { state: 'locked', lock, warning, cloudLoaded };
    } else {
      s = metaError
        ? { state: 'error', lock, message: metaError, problem: metaProblem ?? 'connection', warning, cloudLoaded }
        : { state: 'connecting', lock, warning, cloudLoaded };
    }
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
  /**
   * Add refs this tab will upload, skipping items it already has queued (not yet read). A deletion
   * of an item queued as an edit turns that entry into one the local copy decides (see OpRef), so
   * the deletion isn't lost.
   */
  const withMine = (q: QueuedOp[], refs: OpRef[], added?: string[]): QueuedOp[] => {
    const out = [...q];
    let changed = false;
    const mine = new Map<string, number>();
    out.forEach((e, i) => {
      if (e.owner === tabId && !resolved.has(e.id)) mine.set(refKey(e.ref), i);
    });
    for (const ref of refs) {
      const k = refKey(ref);
      const at = mine.get(k);
      if (at !== undefined) {
        const merged = mergeRef(out[at].ref, ref);
        if (merged !== out[at].ref) {
          out[at] = { ...out[at], ref: merged };
          changed = true;
        }
        continue;
      }
      const id = crypto.randomUUID();
      mine.set(k, out.length);
      out.push({ id, ref, owner: tabId });
      added?.push(id);
      changed = true;
    }
    return changed ? out : q;
  };
  const enqueueRefs = (refs: OpRef[]): string[] => {
    const added: string[] = [];
    if (refs.length) {
      updateQueue((q) => withMine(q, refs, added));
      flush();
    }
    return added;
  };
  /** Edits not saved on this device yet: queued once they are (see SyncHandle.push). */
  const unsaved = new Map<number, OpRef[]>();
  let unsavedSeq = 0;
  /** Everything queued (by any tab), and this tab's edits about to be. */
  const queuedRefs = (): OpRef[] => {
    const q = readQueue().map((e) => e.ref);
    return unsaved.size ? [...q, ...[...unsaved.values()].flat()] : q;
  };

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
    if (typeof window !== 'undefined') {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('online', onOnline);
    }
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
    // This device's copy isn't loaded (being locked): queued items would read as deleted.
    if (localHidden()) return;
    // Signed out or deleted (perhaps in a tab that didn't tell this one): nothing more goes up.
    if (ended()) return;
    // Not before the cloud copy has been read and merged in: a queued medication would otherwise
    // overwrite fields changed on another device meanwhile (the merge keeps the newer of each).
    // Waiting costs nothing offline: entries stay queued here, durably.
    if (!initialDone) return;
    // Offline (or the cloud copy not re-read since): entries stay queued until it's merged in.
    if (!serverCurrent || (typeof navigator !== 'undefined' && navigator.onLine === false)) return;
    const { db, fs } = ctx;
    const key = dek;
    const keyId = dekKeyId;
    const pending = readQueue().filter((q) => q.owner === tabId && !inFlight.has(q.id));
    if (!pending.length) return;
    pending.forEach((q) => inFlight.add(q.id));
    writeChain = writeChain.then(async () => {
      let rest = pending;
      while (rest.length) {
        if (stopped || paused || dek !== key || localHidden()) return release(rest.map((q) => q.id)); // stay queued
        // The latest local copy: queued items upload as they are now. Edits from here on need
        // their own entries.
        const local = getLocal();
        rest.forEach((q) => resolved.add(q.id));
        // As stored now: a deletion may have changed an entry since it was picked up (see withMine).
        const stored = new Map(readQueue().map((e) => [e.id, e.ref]));
        rest = rest.map((q) => {
          const ref = stored.get(q.id);
          return ref && ref !== q.ref ? { ...q, ref } : q;
        });
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
        const entries: { id: string; op: SyncOp }[] = [];
        /** Edits of items no longer on this device: nothing to upload (never taken as deletions). */
        const nothing: string[] = [];
        for (const q of picked) {
          const op = resolveRefs([q.ref], local)[0];
          if (op) entries.push({ id: q.id, op });
          else nothing.push(q.id);
        }
        if (nothing.length) {
          dropEntries(nothing);
          release(nothing);
          // Nothing else may follow to show the cloud copy again without them (e.g. tidy-ups
          // waiting for an empty queue): reconcile again.
          scheduleSnapshot();
        }
        const built = await buildWrites(fs, db, key, keyId, entries);
        // Stopped meanwhile (signed out, deleted, or closed): nothing is dropped, kept or sent;
        // they stay queued (the queue goes too if the account was removed from this device).
        if (stopped) return release([...entries.map((q) => q.id), ...rest.map((q) => q.id)]);
        if (built.unbuildable.length) {
          refusedCount += built.unbuildable.length;
          keepRefusedLogs(built.unbuildable);
          dropEntries(built.unbuildable);
          release(built.unbuildable);
          writeError = `${plural(built.unbuildable.length, 'change')} couldn't be prepared for upload and ${built.unbuildable.length === 1 ? 'was' : 'were'} kept on this device only.`;
          emit();
        }
        if (built.done.length) {
          dropEntries(built.done);
          release(built.done);
        }
        if (stopped || paused || dek !== key || localHidden()) {
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

  /**
   * Queue entries dropped without reaching the cloud: their dose logs stay on this device (told
   * apart from logs removed elsewhere, which reconcile drops), until they're in the cloud or gone.
   */
  function keepRefusedLogs(ids: string[]) {
    const dropped = new Set(ids);
    const refused = readQueue()
      .filter((q) => dropped.has(q.id) && q.ref.kind === 'log' && !q.ref.del)
      .map((q) => q.ref.id);
    if (refused.length) writeKept(uid, [...readKept(uid), ...refused]);
  }

  function commitBatch(batch: WriteBatch, ids: string[]) {
    let retry = false;
    // Resolves when the server acknowledges (offline, it waits; Firestore keeps it queued).
    batch
      .commit()
      .then(() => {
        if (stopped) return; // (still queued: sent again next time, the same)
        dropEntries(ids);
        ids.forEach((id) => solo.delete(id));
        if (writeError) {
          writeError = undefined;
          emit();
        }
      })
      .catch((e) => {
        // Stopped meanwhile (e.g. refused because the account was deleted): nothing is kept here.
        if (stopped) return;
        const code = (e as { code?: string })?.code;
        if (code === 'resource-exhausted') {
          // Quota: keep them queued; the next change or launch tries again.
        } else if (ids.length > 1) {
          // Rejected (e.g. one document too large): find the bad entry by sending them one at a time.
          ids.forEach((id) => solo.add(id));
          retry = true;
          return;
        } else {
          refusedCount += ids.length;
          keepRefusedLogs(ids);
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

  /** Not gone offline since this snapshot was read (a later cached one would say so). */
  const stillFromServer = () => Boolean(medsMeta && logsMeta && !medsMeta.fromCache && !logsMeta.fromCache);

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
    // Not merged with this device's copy before that's loaded.
    Promise.all([cacheReady, localReady()])
      .then(() => decodeRemote(key, uid, meds, logs, decryptCache, { keyId, memo: decodeMemo }))
      .then((decoded) => {
        if (seq !== readSeq || stopped || dek !== key || localHidden() || ended()) return;
        void saveDecrypted(uid, decoded.cacheAdded.map(([k, v]) => [`${keyId}|${k}`, v]), decoded.cacheRemoved.map((k) => `${keyId}|${k}`)).catch(() => {});
        applySnapshot(decoded, fromServer, pendingWrites);
      })
      .catch(() => setData({ state: 'error', message: "Couldn't read the cloud copy." }));
  }

  function applySnapshot(decoded: DecodedRemote, fromServer: boolean, pendingWrites: boolean) {
    // Deleted (or signed out) in a tab that didn't tell this one: nothing is queued, kept or
    // uploaded for it, even when nothing here would change (so applyRemote wouldn't notice).
    if (stopped || ended()) return;
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
        // Items removed here but still queued for removal aren't taken back from the cloud. (Only
        // deletions: a queued edit of an item missing here never deletes it, see OpRef.)
        const removals = queuedRefs().filter((r) => !r.upsert);
        const localMeds = new Set(local.medications.map((m) => m.id));
        const localLogs = new Set(local.doseLogs.map((l) => l.id));
        const removedMeds = new Set(removals.filter((r) => r.kind === 'med' && !localMeds.has(r.id)).map((r) => r.id));
        const removedLogs = new Set(removals.filter((r) => r.kind === 'log' && !localLogs.has(r.id)).map((r) => r.id));
        const remoteKept: AppData = {
          version: 1,
          medications: remote.data.medications.filter((m) => !removedMeds.has(m.id)),
          doseLogs: remote.data.doseLogs.filter((l) => !removedLogs.has(l.id) && !removedMeds.has(l.medId)),
        };
        const merged = mergeAppData(remoteKept, localKept);
        applyRemote(merged); // first: queued uploads read their contents from the local copy
        if (stopped) return; // signed out or deleted meanwhile (see store.ts): nothing to queue
        markCloudLoaded();
        const refs = [...migrationRefs(remote, decoded.plaintext), ...toRefs(diffAppData(remote.data, merged))];
        enqueueRefs(refs);
        // Done once this tab's entries are uploaded: these, and ones queued before the cloud copy
        // was read (e.g. edits made offline), which some of these may have been merged into.
        firstSyncEntries = new Set(readQueue().filter((e) => e.owner === tabId).map((e) => e.id));
        markUploaded([]); // nothing to upload: done already
        serverCurrent = stillFromServer();
        flush(); // (those queued before, too: they waited for this)
        return;
      }
    }

    // Offline with nothing pending: the cache may be stale, so keep showing local data.
    if (!fromServer && !pendingWrites) return;

    const queued = queuedRefs();
    const firstRound = !uploadedSinceStart;
    uploadedSinceStart = true;
    const kept = readKept(uid);
    const { shown, uploads, removals } = reconcile({ remote, local, queued, failed: decoded.failedIds, cutoff, kept });
    if (shown.medications !== local.medications || shown.doseLogs !== local.doseLogs) applyRemote(shown);
    if (!fromServer || stopped) return;
    if (kept.size) {
      // Only until it's in the cloud, or gone from here.
      const here = new Set(shown.doseLogs.map((l) => l.id));
      const still = [...kept].filter((id) => here.has(id) && !remote.logLocations.has(id));
      if (still.length !== kept.size) writeKept(uid, still);
    }
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
    // What was queued before the cloud copy was read, or while offline (now merged): upload.
    const caughtUp = !serverCurrent;
    serverCurrent = stillFromServer();
    if (firstRound || caughtUp) flush();

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
        if (s.metadata.fromCache) serverCurrent = false;
        scheduleSnapshot();
      }, onErr),
      fs.onSnapshot(fs.collection(db, 'users', uid, 'logs'), { includeMetadataChanges: true }, (s) => {
        track(cloudLogDocs, s);
        logsMeta = s.metadata;
        if (s.metadata.fromCache) serverCurrent = false;
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
    serverCurrent = false;
    uploadedSinceStart = false;
    readSeq++;
  }

  function setKey(key: CryptoKey, keyId: string, stored = true) {
    if (stopped) return;
    dek = key;
    dekKeyId = keyId;
    dekStored = stored;
    lock = 'unlocked';
    setEncryptionMarker(uid, true);
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
    dekStored = false;
    decryptCache.clear();
    decodeMemo = newDecodeMemo();
    // Decrypted cloud items saved on this device: being locked means they can't be read here.
    void clearDecrypted(uid);
    dataWarning = undefined;
    if (settingsUnreadable) {
      // The settings became unreadable while the key was held (see onMeta): the ones seen before
      // are no longer the account's, so this can't go by them: not locked as if they were still
      // good (that would allow an unlock by them), but closed on the problem, as at a start.
      meta = undefined;
      confirmedKeyId = null;
      lock = 'checking';
      metaError = settingsUnreadable;
      metaProblem = 'settings';
    } else lock = meta ? 'locked' : meta === null ? 'needs-setup' : 'checking';
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

  /**
   * A snapshot of the settings is being applied: a problem reading them earlier no longer holds.
   * Not while the listener has stopped (a snapshot seen before is being looked at again): only
   * retry() (or coming back online) clears that.
   */
  function metaRead() {
    if (metaUnsub) metaError = metaProblem = undefined;
  }

  function onMeta(snap: DocumentSnapshot) {
    if (stopped) return;
    lastMetaSnap = snap;
    const raw = snap.exists() ? (snap.data() as Record<string, unknown>) : undefined;
    const deletingHere = deletionInThisBrowser();
    if (raw?.deleted === true) {
      // Confirm with the server before acting (another tab's write shows up early as pending).
      if (snap.metadata.fromCache || snap.metadata.hasPendingWrites) return;
      metaRead();
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
      metaRead();
      meta = null;
      settingsUnreadable = undefined;
      confirmedKeyId = null;
      setEncryptionMarker(uid, false);
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
      // There are encryption settings, so the account uses encryption, even if this version can't
      // read them (made by a newer version, or damaged): it stays closed here until it can. (A
      // device already unlocked keeps its key, with a warning.) The settings seen before are no
      // longer the account's: nothing (unlocking, setting up) may go by them.
      metaRead();
      setEncryptionMarker(uid, true);
      settingsUnreadable = describeError(e); // (remembered for dropKey)
      if (dek) keyWarning = settingsUnreadable;
      else {
        meta = undefined;
        confirmedKeyId = null;
        lock = 'checking';
        metaError = describeError(e);
        metaProblem = 'settings';
      }
      emit();
      return;
    }
    metaRead();
    meta = parsed;
    settingsUnreadable = undefined;
    setEncryptionMarker(uid, true);
    keyWarning = undefined;
    const resetting = raw.resetting === true && typeof raw.resetAt === 'number' && Date.now() - raw.resetAt < STALL_MS;
    if (!snap.metadata.fromCache) {
      confirmedKeyId = resetting ? null : parsed.keyId;
      startData(); // if this device's key is the confirmed one and it was waiting
    }
    if (resetting && dek && !snap.metadata.fromCache) {
      // Another device is resetting the encryption: stop before its deletions arrive (they'd
      // look like everything was deleted). The new key replaces this one shortly.
      // First: this device's copy must be merged into the new cloud copy, never taken as synced.
      forgetMerged();
      const staleKeyId = dekKeyId ?? '';
      dropKey();
      keyWarning = 'The encryption for this account is being reset on another device. Unlock again once it has finished.';
      // The stored key is stale too: a reload (or a new tab) mustn't open the data with it. This
      // device's copy stays readable but unshown, to be merged into the new cloud copy once unlocked
      // with the new key. (If this browser made the new key, it's kept: only the stale one goes.)
      void forgetDeviceKeyIf(uid, staleKeyId).then(() => keyChannel()?.postMessage({ uid } satisfies KeyMessage));
    } else if (dek && dekKeyId !== parsed.keyId) {
      if (snap.metadata.fromCache) return; // confirm with the server before acting
      // The account key was replaced (e.g. reset elsewhere): this device's key is stale.
      const staleKeyId = dekKeyId ?? '';
      forgetMerged(); // first, as above
      dropKey();
      keyWarning = 'The encryption key for this account was replaced on another device. Unlock again to keep syncing.';
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
      else {
        // A new key may already be stored here (made by another tab of this browser, e.g. a reset,
        // whose message this tab ignored while it still had the old settings): use it.
        void localCopySettled(uid)
          .then(() => loadDeviceKey(uid))
          .then((stored) => {
            if (stopped || dek || !stored || stored.keyId !== meta?.keyId) return;
            keyWarning = undefined;
            setKey(stored.key, stored.keyId);
          })
          .catch(() => {});
      }
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
    const msg = e.data as KeyMessage | undefined;
    const target = msg?.uid;
    if (stopped || (target !== uid && target !== '*')) return;
    void localCopySettled(uid)
      .then(() => loadDeviceKey(uid))
      .then(async (stored) => {
        if (stopped) return;
        if (stored && !dek && (!meta || meta.keyId === stored.keyId)) return setKey(stored.key, stored.keyId);
        if (stored || !dek) return;
        // Forgotten in another tab, which encrypted this device's copy first. Edits this tab saved
        // since then would be left readable: encrypt them too (merged in) before locking. Not if
        // it's been unlocked again meanwhile (the key stored again): it's in use, readable, by then.
        if (msg?.forgot && msg.forgot === dekKeyId && opts.sealLocal) {
          const key = dek;
          const keyId = dekKeyId;
          const unlockedAgain = async () => (await loadDeviceKey(uid))?.keyId === keyId;
          const sealed = await opts.sealLocal(key, msg.forgot, { elsewhere: true, unless: unlockedAgain }).then(
            () => true,
            () => false,
          );
          if (stopped || dek !== key) return;
          if (!sealed && (await unlockedAgain().catch(() => false))) return; // stays unlocked
          if (stopped || dek !== key) return;
        }
        dropKey();
      });
  };
  keyChannel()?.addEventListener('message', onChannel);

  /** Store the key on this device; false if that failed (see adoptKey). */
  async function remember(key: CryptoKey, keyId: string): Promise<boolean> {
    try {
      await saveDeviceKey(uid, { key, keyId });
      keyChannel()?.postMessage({ uid });
      return true;
    } catch {
      return false;
    }
  }

  /**
   * remember(), for a key just set up here: if sync stopped meanwhile (signed out or deleted, this
   * device perhaps cleared already), it's forgotten again and this rejects.
   */
  async function rememberUnlessStopped(key: CryptoKey, keyId: string): Promise<boolean> {
    if (stopped) throw new SyncCryptoError('not-ready');
    const stored = await remember(key, keyId);
    if (stopped) {
      // Other tabs that took it up drop it too (see onChannel).
      if (stored) {
        await forgetDeviceKeyIf(uid, keyId);
        keyChannel()?.postMessage({ uid } satisfies KeyMessage);
      }
      throw new SyncCryptoError('not-ready');
    }
    return stored;
  }

  /** Unlocked with a key just made or entered: `stored`, whether remember() stored it. */
  function adoptKey(key: CryptoKey, keyId: string, stored: boolean) {
    if (!stored) keyWarning = "This browser couldn't remember the key, so you'll be asked to unlock again next time.";
    setKey(key, keyId, stored);
  }

  function watchMeta() {
    if (!ctx || stopped || metaUnsub) return;
    const { db, fs } = ctx;
    const unsub = fs.onSnapshot(fs.doc(db, 'users', uid, 'meta', 'crypto'), { includeMetadataChanges: true }, onMeta, (e) => {
      // The listener has stopped for good: retry() (or coming back online) starts a new one.
      if (metaUnsub === unsub) metaUnsub = null;
      unsub();
      const code = (e as { code?: string }).code;
      if (code === 'permission-denied' || code === 'unauthenticated') {
        metaError = "Cloud sync can't read this account's encryption settings. The Firestore security rules may need updating.";
        metaProblem = 'access';
      } else {
        metaError = describeError(e);
        metaProblem = isConnectionError(e) ? 'connection' : 'access';
      }
      emit();
    });
    metaUnsub = unsub;
  }

  /** Open Firestore and watch the settings (again, after a failure). */
  let connecting = false;
  function connect() {
    if (stopped || connecting) return;
    connecting = true;
    // The settings are watched once the stored key is known, so they don't report "locked" first.
    Promise.all([getDb(), keyLoaded])
      .then(([c]) => {
        if (stopped) return;
        ctx = c;
        watchMeta();
      })
      .catch((e) => {
        metaError = describeError(e);
        metaProblem = isConnectionError(e) ? 'connection' : 'access';
        emit();
      })
      .finally(() => {
        connecting = false;
      });
  }
  /** Just set up (or reset) the account's settings: watch them again if that had failed. */
  function resumeMeta() {
    if (stopped || (!metaError && metaUnsub)) return;
    metaError = metaProblem = undefined;
    if (ctx) watchMeta();
    emit();
  }

  /** The settings aren't being watched because that failed: try again. */
  function retryMeta() {
    if (stopped || (ctx && metaUnsub)) return;
    metaError = undefined;
    metaProblem = undefined;
    emit();
    if (ctx) watchMeta();
    else connect();
  }
  const onOnline = () => {
    if (metaError) retryMeta();
    flush(); // held while the browser was offline (if the cloud copy is still current)
  };
  if (typeof window !== 'undefined') window.addEventListener('online', onOnline);

  // ---------- start ----------
  emit();
  watchOrphans();
  // This device's stored key unlocks it right away (offline too), without waiting for Firestore.
  // (Not while this tab is still securing the local copy after a sign-out elsewhere: see secureLocalCopy.)
  const keyLoaded = localCopySettled(uid).then(() => loadDeviceKey(uid)).then((stored) => {
    if (stored && !stopped && !dek) setKey(stored.key, stored.keyId);
  });
  connect();

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
    push(prev, next, saved) {
      if (stopped) return;
      const refs = toRefs(diffAppData(prev, next));
      if (!refs.length) return;
      if (!saved) return void enqueueRefs(refs);
      const id = ++unsavedSeq;
      unsaved.set(id, refs);
      const settle = (ok: boolean) => {
        unsaved.delete(id);
        if (!ok || cloudDeleted) return;
        // Saved here: queued even if this tab has stopped meanwhile (e.g. signed out in another tab,
        // which waits for it, then uploads what this tab queued): another tab or launch takes it over.
        if (stopped) updateQueue((q) => withMine(q, refs));
        else enqueueRefs(refs);
      };
      saved.then(settle, () => settle(true));
    },
    retry: () => retryMeta(),
    lockedElsewhere() {
      if (stopped || !dek) return;
      dropKey();
    },
    deletedInCloud: (medId) => remoteTombstones.has(medId),
    dataKey: () => (!stopped && dek && dekKeyId && lock === 'unlocked' ? { key: dek, keyId: dekKeyId, stored: dekStored } : null),

    localShown() {
      flush();
      // A cloud copy that arrived while this device's copy was hidden was set aside (see
      // onSnapshots): merge it in now.
      if (medsMeta && logsMeta) scheduleSnapshot();
    },

    async flushAll({ needCloud = false, signal, onProgress } = {}) {
      const check = (): FlushCheck => {
        const local = getLocal();
        let merged = initialDone; // the first snapshot merged this device's data in (or it was already)
        try {
          merged ||= localStorage.getItem(SYNCED_KEY) === '1';
        } catch {
          /* unknown: not merged */
        }
        return {
          queued: queuedRefs(),
          merged,
          // Locked: this device's copy isn't loaded, so it can't be known to be empty.
          localEmpty: !localHidden() && !local.medications.length && !local.doseLogs.length,
          refused: Math.max(refusedCount, readKept(uid).size), // (the logs kept also after a reload)
          needCloud,
          cloudLoaded,
          online: typeof navigator === 'undefined' || navigator.onLine !== false,
          lock,
          deleting: paused,
        };
      };
      const fail = (reason: FlushProblem, message?: string): FlushResult => ({
        ok: false,
        reason,
        message,
        pending: summarizePending(check(), getLocal(), { hidden: localHidden() }),
      });
      const problemText = () =>
        writeError ?? metaError ?? keyWarning ?? (dataState.state === 'error' ? dataState.message : undefined);
      let lastProgress = Date.now();
      let fewest = Infinity;
      let sawCloud = cloudLoaded;
      for (;;) {
        if (signal?.aborted) return fail('cancelled');
        if (stopped) {
          return fail('error', cloudDeleted ? 'This account has been deleted.' : 'Cloud sync has stopped. Reload Amendra and try again.');
        }
        // Other open tabs upload what they queued themselves (and closed tabs' entries are taken
        // over as usual, see watchOrphans). Taking a live tab's entries could read an item from
        // this tab's copy before that tab's edit has reached it, and upload it as deleted.
        const c = check();
        const step = flushStep(c);
        if (step.kind === 'blocked') return fail(step.reason, step.reason === 'refused' ? writeError : undefined);
        // Queued changes leave the queue only once the server has them. Firestore may still hold
        // other writes of this account (it keeps them across launches, e.g. ones whose queue entry
        // couldn't be stored): those must be confirmed too, so it has to be open to ask. With none
        // waiting it answers at once, offline too.
        if (step.kind === 'done' && !ctx && metaError) {
          return fail(c.online ? 'error' : 'offline', `Cloud sync couldn't start on this device. ${metaError}`);
        }
        if (step.kind === 'done' && ctx) {
          const { db, fs } = ctx;
          const confirmed = await Promise.race([
            fs.waitForPendingWrites(db).then(
              () => true,
              () => false,
            ),
            sleep(c.online ? FLUSH_CONFIRM_MS : 2000, signal).then(() => false),
          ]);
          if (signal?.aborted) return fail('cancelled');
          if (confirmed) return { ok: true };
          return fail(!c.online || dataState.state === 'offline' ? 'offline' : 'timeout', problemText());
        }
        flush();
        onProgress?.(c.queued.length);
        if (c.queued.length < fewest || (cloudLoaded && !sawCloud)) {
          fewest = c.queued.length;
          sawCloud = cloudLoaded;
          lastProgress = Date.now();
        }
        if (Date.now() - lastProgress > FLUSH_STALL_MS) {
          const message = problemText();
          // Firestore only had its cached copy, or never got as far as reading the cloud.
          const unreachable = dataState.state === 'offline' || !initialDone;
          return fail(message ? 'error' : unreachable ? 'offline' : 'timeout', message);
        }
        await sleep(250, signal);
      }
    },

    stop() {
      stopped = true;
      stopData();
      metaUnsub?.();
      metaUnsub = null;
      cleanup();
      // Stopped for good (signed out, deleted, or another account): the key and what was decrypted
      // with it don't stay in memory. (Nothing stored is touched: the key stays on this device.)
      dek = null;
      dekKeyId = null;
      decryptCache.clear();
      decodeMemo = newDecodeMemo();
    },

    async prepareSetup(passphrase) {
      need();
      if (meta) throw new SyncCryptoError('already-set-up');
      await requireStrongEnough(passphrase);
      // The strength check can take a while (it's loaded on first use): look again afterwards.
      const { db, fs } = need();
      if (meta) throw new SyncCryptoError('already-set-up');
      const bundle = await createKeyBundle(uid, passphrase);
      return {
        recoveryKey: bundle.recoveryKey,
        finish: async () => {
          needOnline();
          if (stopped) throw new SyncCryptoError('not-ready');
          const ref = fs.doc(db, 'users', uid, 'meta', 'crypto');
          await fs.runTransaction(db, async (tx) => {
            if ((await tx.get(ref)).exists()) throw new SyncCryptoError('already-set-up');
            tx.set(ref, bundle.meta);
          });
          // Stopped meanwhile (signed out or deleted, and this device perhaps cleared): the key
          // isn't stored here.
          if (stopped) throw new SyncCryptoError('not-ready');
          meta = bundle.meta;
          confirmedKeyId = bundle.meta.keyId; // just written to the server
          resumeMeta();
          adoptKey(bundle.dek, bundle.meta.keyId, await rememberUnlessStopped(bundle.dek, bundle.meta.keyId));
        },
      };
    },

    async unlock(secret, kind) {
      need();
      if (!meta) throw new SyncCryptoError('not-ready');
      const m = meta;
      const key = kind === 'recovery' ? await unlockWithRecoveryKey(m, uid, secret) : await unlockWithPassphrase(m, uid, secret);
      // The settings changed meanwhile (replaced, or no longer readable), or the account is being
      // deleted or sync stopped: not with these.
      const stillValid = () => {
        if (stopped || paused || !meta) throw new SyncCryptoError('not-ready');
        if (meta.keyId !== m.keyId) throw new SyncCryptoError('changed-elsewhere');
      };
      stillValid();
      const stored = await remember(key, m.keyId);
      try {
        stillValid();
      } catch (e) {
        // Stored meanwhile: forgotten again (other tabs that took it up drop it, see onChannel).
        if (stored) {
          await forgetDeviceKeyIf(uid, m.keyId);
          keyChannel()?.postMessage({ uid } satisfies KeyMessage);
        }
        throw e;
      }
      adoptKey(key, m.keyId, stored);
    },

    async changePassphrase(newPassphrase) {
      needUnlocked();
      await requireStrongEnough(newPassphrase);
      const { m, key } = needUnlocked();
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
      need();
      await requireStrongEnough(passphrase);
      const { db, fs } = need();
      const bundle = await createKeyBundle(uid, passphrase);
      return {
        recoveryKey: bundle.recoveryKey,
        finish: async () => {
          needOnline();
          // Stopped (signed out or deleted, and this device perhaps cleared): nothing is changed.
          if (stopped) throw new SyncCryptoError('not-ready');
          const metaRef = fs.doc(db, 'users', uid, 'meta', 'crypto');
          // Tell other devices first, so they stop syncing before the deletions below reach them
          // (they'd look like everything was deleted). The old keys stay, so an interrupted reset
          // leaves things working and can simply be run again.
          const resetAt = Date.now();
          await fs.runTransaction(db, async (tx) => {
            const cur = await tx.get(metaRef);
            const data = cur.data();
            if (!cur.exists() || !data || data.deleted === true) throw new SyncCryptoError('changed-elsewhere');
            tx.set(metaRef, { ...data, resetting: true, resetAt });
          });
          /** Stopped meanwhile: the old settings are put back (best effort), and nothing more is deleted. */
          const unlessStopped = async () => {
            if (!stopped) return;
            const undo = fs.runTransaction(db, async (tx) => {
              const cur = await tx.get(metaRef);
              const data = cur.data();
              if (!cur.exists() || !data || data.deleted === true || data.resetting !== true || data.resetAt !== resetAt) return;
              const { resetting: _r, resetAt: _a, ...rest } = data;
              tx.set(metaRef, rest);
            });
            await Promise.race([undo, sleep(5000)]).catch(() => {
              /* stale after a while anyway (see onMeta) */
            });
            throw new SyncCryptoError('not-ready');
          };
          await sleep(2000);
          await unlessStopped();
          const snaps = await Promise.all(
            (['meds', 'logs'] as const).map((c) => fs.getDocsFromServer(fs.collection(db, 'users', uid, c))),
          );
          const refs = snaps.flatMap((s) => s.docs.map((d) => d.ref));
          for (let i = 0; i < refs.length; i += MAX_BATCH) {
            await unlessStopped();
            const batch = fs.writeBatch(db);
            refs.slice(i, i + MAX_BATCH).forEach((r) => batch.delete(r));
            await batch.commit();
          }
          await unlessStopped();
          // The old key is let go of before the new settings are written, so this tab's own
          // settings listener doesn't take them for a replacement made elsewhere.
          const oldKey = dek;
          const oldKeyId = dekKeyId;
          if (dek) stopData();
          dek = null;
          dekKeyId = null;
          // Only over this reset's own marker: if the account started being deleted meanwhile, the
          // new key must not replace that (the security rules refuse it too).
          try {
            await fs.runTransaction(db, async (tx) => {
              const cur = await tx.get(metaRef);
              const data = cur.data();
              if (!cur.exists() || !data || data.deleted === true || data.resetting !== true || data.resetAt !== resetAt) {
                throw new SyncCryptoError('changed-elsewhere');
              }
              tx.set(metaRef, bundle.meta);
            });
          } catch (e) {
            // Not saved: the settings are still the old ones. Still unlocked here (nothing dropped
            // the key meanwhile, see onMeta): keep the old key, so the lock state matches it and
            // locking later encrypts this device's copy with it. (Data stays stopped until the
            // reset marker is gone, see startData.)
            if (!stopped && !dek && oldKey && oldKeyId && lock === 'unlocked') {
              dek = oldKey;
              dekKeyId = oldKeyId;
              emit();
            }
            throw e;
          }
          // Only once it's saved (if that failed, the settings are still the old ones: unlocking goes
          // by them). Our own meta listener may have seen the new ones first: the same then.
          meta = bundle.meta;
          confirmedKeyId = bundle.meta.keyId;
          if (stopped) throw new SyncCryptoError('not-ready'); // (as in prepareSetup)
          attempted.clear();
          forgetMerged(); // merge this device's data into the now-empty cloud
          resumeMeta();
          adoptKey(bundle.dek, bundle.meta.keyId, await rememberUnlessStopped(bundle.dek, bundle.meta.keyId));
        },
      };
    },

    async forgetKey() {
      // This device's copy is encrypted with the key first (the readable one removed), so locked
      // means it can't be read here. If that fails, nothing changes: the key stays and the device
      // stays unlocked (rather than claiming a lock its readable copy doesn't have).
      const keyId = dekKeyId;
      if (dek && keyId && opts.sealLocal) {
        try {
          // Forgotten as soon as the copy is encrypted, before another tab may load it: a load
          // waiting meanwhile then knows it was locked, and doesn't put it back (see store.ts).
          await opts.sealLocal(dek, keyId, { onSealed: () => forgetDeviceKeyIf(uid, keyId) });
        } catch {
          throw new SyncCryptoError('lock-failed');
        }
      }
      await forgetDeviceKey(uid);
      // Other tabs encrypt anything they saved meanwhile, then lock too.
      keyChannel()?.postMessage({ uid, ...(keyId ? { forgot: keyId } : {}) } satisfies KeyMessage);
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
      let marker: DeletionMarker | null = null;
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
        marker = deletingMarker();
        await fs.setDoc(metaRef, marker);
        marked = true;
        await eraseCloud(fs, db);
      } catch (e) {
        // Put the encryption settings back so this and other devices keep working, then resume.
        if (marked) {
          // If the connection dropped, this waits for it to come back; don't hold the dialog that long.
          // `undo` names this deletion's marker: the security rules let only that replace it.
          const restore = previousMeta?.exists()
            ? fs.setDoc(metaRef, { ...previousMeta.data(), undo: marker?.at })
            : fs.deleteDoc(metaRef);
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
        localStorage.removeItem(keptKey(uid));
        localStorage.removeItem(SYNCED_KEY);
      } catch {
        /* ignore */
      }
      cleanup();
    },
  };
}
