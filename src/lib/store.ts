// Local, per-account persistence of medications and dose history (IndexedDB, see localDb.ts),
// shared live between this device's open tabs.
//
// An account with end-to-end encrypted sync is only loaded once it's unlocked on this device:
// until then (and while it's being checked whether it uses encryption) nothing of its data is
// read, shown, edited or used for reminders. See dataAccess().
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppData, DoseLog, DoseStatus, Medication } from '../../shared/types';
import {
  applyChanges,
  changesBetween,
  deleteAccount,
  hasChanges,
  isSealed,
  loadAccount,
  LocalCopyLockedError,
  localDbAvailable,
  replaceAccount,
  writeChanges,
  type Changes,
} from './localDb';
import { logsByMed, stampEdit, supplyOnHand, unitsPerDose } from './supply';
import { accountDeletedSince, checkDeletedElsewhere, deletionMark, holdSession, isAccountDeleted } from './session';
import { loadDeviceKey } from './keyStore';
import { legacyDataKey, sealLocal, unsealLocal, withLoadLock } from './localSeal';
import {
  discardIfSynced,
  encryptionMarker,
  localCopySettled,
  preloadSync,
  releaseSyncClient,
  startSync,
  type SyncHandle,
  type UnlockedKey,
  type SyncStatus,
} from './sync';
import { SyncCryptoError } from './syncCrypto';
import { LOG_RETENTION_MS } from './syncOps';
import { mergeAppData } from './vault';

export const EMPTY_DATA: AppData = { version: 1, medications: [], doseLogs: [] };

export const MED_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#16a34a', '#475569'];

export function newId(): string {
  return crypto.randomUUID();
}

// ---------- legacy localStorage copy (read once to migrate; also the fallback without IndexedDB) ----------

const legacyKey = legacyDataKey;

function parseData(raw: string | null): AppData | null {
  try {
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AppData;
    if (parsed?.version !== 1 || !Array.isArray(parsed.medications) || !Array.isArray(parsed.doseLogs)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function readLegacy(userId: string): AppData | null {
  try {
    return parseData(localStorage.getItem(legacyKey(userId)));
  } catch {
    return null;
  }
}

function writeLegacy(userId: string, data: AppData): boolean {
  try {
    localStorage.setItem(legacyKey(userId), JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

function removeLegacy(userId: string): void {
  try {
    localStorage.removeItem(legacyKey(userId));
  } catch {
    /* ignore */
  }
}

// ---------- cross-tab updates ----------

type TabMessage = { userId: string; from: string; changes: Changes } | { userId: string; from: string; cleared: true };

const tabId = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random());
let channel: BroadcastChannel | null | undefined;
function dataChannel(): BroadcastChannel | null {
  if (channel === undefined) channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel('medtracker-data');
  return channel;
}

/** Remove an account's medications and dose history from this device (and its other tabs). */
export async function deleteLocalData(userId: string): Promise<void> {
  // Under the load lock: a load, lock or unlock of this device's copy that's under way in any tab
  // (they hold it) finishes first, so it can't write plaintext or an encrypted copy back afterwards.
  // Rejects if it couldn't be removed (it mustn't count as removed: it would come back), unless
  // IndexedDB can't be used here at all (nothing was stored there; see loadForUser).
  await withLoadLock(userId, async () => {
    removeLegacy(userId);
    try {
      await deleteAccount(userId);
    } catch (e) {
      if (await localDbAvailable()) throw e;
    }
  });
  dataChannel()?.postMessage({ userId, from: tabId, cleared: true } satisfies TabMessage);
}

function isOld(l: DoseLog, cutoff: number) {
  return Date.parse(l.scheduledFor) < cutoff;
}

/** A load that's no longer wanted (closed, or sync stopped, meanwhile): nothing was loaded. */
class LoadAbandonedError extends Error {}

/**
 * Load an account's data: from IndexedDB, migrating the old localStorage copy the first time, and
 * taking over guest data when a signed-in account has none yet. Old dose history is dropped.
 * `unlocked`: the account is unlocked: `key()` is its key now (null once it isn't), to put back the
 * copy encrypted while it was locked; `wanted()`: this load is still wanted.
 *
 * Another tab may lock the copy (encrypt it, forgetting the key) before this load gets its turn.
 * Then it's not put back: this rejects with LocalCopyLockedError (or LoadAbandonedError, if it's no
 * longer wanted anyway) and loads nothing.
 */
async function loadForUser(
  userId: string,
  unlocked?: { uid: string; key: () => UnlockedKey | null; wanted: () => boolean },
  /** Still wanted (not signed out or deleted meanwhile): checked once it's this load's turn. */
  wanted: () => boolean = () => true,
): Promise<{ data: AppData; persistent: boolean }> {
  // Without a stored key to go by: whether the copy was already locked when this load began.
  const sealedBefore = unlocked && !unlocked.key()?.stored ? isSealed(userId).catch(() => true) : null;
  // Not while this account's copy is still being locked after a sign-out elsewhere.
  if (unlocked) await localCopySettled(unlocked.uid);
  if (!(await localDbAvailable())) return { data: readLegacy(userId) ?? EMPTY_DATA, persistent: false };
  // One tab at a time per account, so two tabs opening together can't both migrate or adopt.
  return withLoadLock(userId, async () => {
    // Deleted (or signed out) while this waited: it's been cleared, nothing is written back (e.g.
    // a guest's data taken over into the deleted account).
    if (!wanted()) throw new LoadAbandonedError();
    if (unlocked) {
      // Locked in another tab while this waited its turn (it forgets the stored key, see
      // sync.ts secure and forgetKey; without one, the copy is newly marked encrypted), or no
      // longer wanted: then the copy stays encrypted.
      const k = unlocked.key();
      if (!k || !unlocked.wanted()) throw new LoadAbandonedError();
      const lockedSince = k.stored
        ? (await loadDeviceKey(unlocked.uid))?.keyId !== k.keyId
        : !(await sealedBefore) && (await isSealed(userId).catch(() => true));
      if (!unlocked.wanted() || unlocked.key()?.key !== k.key) throw new LoadAbandonedError();
      if (lockedSince) throw new LocalCopyLockedError();
      // First, so a guest's data is only taken over if the account really has none.
      await unsealLocal(userId, unlocked.uid, k.key, k.keyId).catch(() => {});
    }
    return { data: await loadAndTidy(userId, wanted), persistent: true };
  });
}

/**
 * Whether an account's data may be loaded and shown on this device. Without cloud sync (a guest)
 * it always may. A synced account may once it's unlocked, or once the cloud has said it doesn't
 * use encryption (remembered, so that also works offline). An account seen to use encryption is
 * `locked` until unlocked; one whose settings haven't been seen yet is `checking`.
 */
export type DataAccess = 'open' | 'checking' | 'locked';

export function dataAccess(syncUid: string | undefined, status: SyncStatus | null): DataAccess {
  if (!syncUid) return 'open';
  const lock = status?.lock ?? 'checking';
  if (lock === 'unlocked') return 'open';
  if (lock === 'locked') return 'locked';
  const marker = encryptionMarker(syncUid);
  // Encryption was on but its settings are gone from the cloud: set it up again first.
  if (lock === 'needs-setup') return marker === 'on' ? 'locked' : 'open';
  return marker === 'off' ? 'open' : 'checking';
}

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
  done: boolean;
}
function deferred(): Deferred {
  let resolve!: () => void;
  const d: Deferred = { promise: new Promise<void>((r) => (resolve = r)), resolve: () => {}, done: false };
  d.resolve = () => {
    d.done = true;
    resolve();
  };
  return d;
}

/** A recount at least this often keeps every dose since the count within the kept history. */
const RECOUNT_AFTER_MS = 330 * 86_400_000;

/**
 * This device has changes the cloud copy hasn't seen that aren't queued for upload: the next sync
 * merges this device's data in, instead of treating the cloud as up to date (signing out waits for that).
 */
function unmerge(userId: string): void {
  if (userId === 'guest') return;
  try {
    localStorage.removeItem(`medtracker.synced.${userId.replace(/^firebase:/, '')}`);
  } catch {
    /* ignore */
  }
}

async function loadAndTidy(userId: string, wanted: () => boolean = () => true): Promise<AppData> {
  let data = await loadAccount(userId);
  const empty = (d: AppData) => !d.medications.length && !d.doseLogs.length;
  // A localStorage copy: from an older version, or saved here while IndexedDB couldn't be used.
  const legacy = readLegacy(userId);
  if (legacy && !empty(legacy)) {
    data = empty(data) ? legacy : mergeAppData(data, legacy);
    await replaceAccount(userId, data);
    unmerge(userId);
  }
  removeLegacy(userId);
  // (Not a guest's data that was deleted: what's left of it is being removed, see account.ts.)
  if (userId !== 'guest' && !data.medications.length && wanted() && !isAccountDeleted('guest')) {
    // Signed in on a device that was used as a guest: the guest data becomes this account's.
    const guest = await loadAccount('guest');
    const guestData = guest.medications.length ? guest : readLegacy('guest');
    if (guestData?.medications.length) {
      await replaceAccount(userId, guestData);
      await deleteAccount('guest');
      removeLegacy('guest');
      data = guestData;
      unmerge(userId); // the cloud copy doesn't have it (and a merge keeps the guest's dose history)
    }
  }
  const nowMs = Date.now();
  // Dropping old dose history must not change supply on hand (it's the count minus doses taken
  // since): recount medications whose count is nearly as old as the history kept.
  const medications = data.medications.map((m) =>
    typeof m.supplyRemaining === 'number' && m.supplyCountedAt && Date.parse(m.supplyCountedAt) < nowMs - RECOUNT_AFTER_MS
      ? stampEdit(m, { ...m, supplyRemaining: supplyOnHand(m, data.doseLogs) ?? 0, supplyCountedAt: new Date(nowMs).toISOString() })
      : m,
  );
  if (medications.some((m, i) => m !== data.medications[i])) unmerge(userId); // recounted
  const cutoff = nowMs - LOG_RETENTION_MS;
  const doseLogs = data.doseLogs.some((l) => isOld(l, cutoff)) ? data.doseLogs.filter((l) => !isOld(l, cutoff)) : data.doseLogs;
  const next = { version: 1 as const, medications, doseLogs };
  // (Cloud copies of dropped logs are removed by sync; recounts sync as edits, see reconcile.)
  await writeChanges(userId, changesBetween(data, next));
  return next;
}

// ---------- edits ----------

/** Record (or change) the status of one scheduled dose. */
export function applyLogDose(d: AppData, medId: string, scheduledFor: string, status: DoseStatus): AppData {
  const med = d.medications.find((m) => m.id === medId);
  if (!med) return d;
  const existing = logsByMed(d.doseLogs).get(medId)?.find((l) => l.scheduledFor === scheduledFor);
  if (existing?.status === status) return d;
  const nowMs = Date.now();
  const tracks = typeof med.supplyRemaining === 'number';
  const log: DoseLog = {
    id: existing?.id ?? newId(),
    medId,
    scheduledFor,
    status,
    loggedAt: new Date(nowMs).toISOString(),
    // What it takes from supply is fixed now, so changing the dose size later doesn't rewrite history.
    ...(status === 'taken' && tracks ? { supplyDeducted: unitsPerDose(med) } : {}),
  };
  const doseLogs = existing ? d.doseLogs.map((l) => (l.id === existing.id ? log : l)) : [...d.doseLogs, log];
  return { ...d, medications: countedFromNow(d.medications, med, existing, nowMs), doseLogs };
}

/** Remove a dose's log (what it took from supply comes back). */
export function applyUndoDose(d: AppData, medId: string, scheduledFor: string): AppData {
  const existing = logsByMed(d.doseLogs).get(medId)?.find((l) => l.scheduledFor === scheduledFor);
  if (!existing) return d;
  const med = d.medications.find((m) => m.id === medId);
  return {
    ...d,
    doseLogs: d.doseLogs.filter((l) => l.id !== existing.id),
    medications: med ? countedFromNow(d.medications, med, existing, Date.now()) : d.medications,
  };
}

/**
 * A medication whose supply was counted by an older version (deducting doses from the count
 * itself) starts being tracked from its logs: the count as of just before now, with what the dose
 * being changed had deducted put back first.
 */
function countedFromNow(meds: Medication[], med: Medication, changed: DoseLog | undefined, nowMs: number): Medication[] {
  if (typeof med.supplyRemaining !== 'number' || med.supplyCountedAt) return meds;
  const restore = changed?.status === 'taken' ? (changed.supplyDeducted ?? 0) : 0;
  const counted = stampEdit(med, {
    ...med,
    // (An older version's count could be below zero; what was shown was none on hand.)
    supplyRemaining: Math.max(0, med.supplyRemaining) + restore,
    supplyCountedAt: new Date(nowMs - 1).toISOString(),
  });
  return meds.map((m) => (m.id === med.id ? counted : m));
}

/**
 * Save a medication. From the form, `supplyRemaining` is what the user sees as on hand and
 * `supplyShownAs` what the form showed when it opened: if the user changed it, it's a new count as
 * of now. Without `supplyShownAs` (other edits), the stored count passes through unchanged.
 */
export function applySaveMedication(d: AppData, med: Medication, supplyShownAs?: number): AppData {
  const prev = d.medications.find((m) => m.id === med.id);
  const nowMs = Date.now();
  const now = new Date(nowMs).toISOString();
  // Counted just before now, so a dose logged in the same millisecond still counts.
  const countedAt = new Date(nowMs - 1).toISOString();
  let next: Medication = { ...med };
  if (typeof med.supplyRemaining !== 'number') {
    delete next.supplyCountedAt;
  } else if (prev && typeof prev.supplyRemaining === 'number') {
    const unchanged =
      supplyShownAs !== undefined
        ? med.supplyRemaining === supplyShownAs
        : med.supplyRemaining === prev.supplyRemaining && med.supplyCountedAt === prev.supplyCountedAt;
    next = unchanged
      ? { ...next, supplyRemaining: prev.supplyRemaining, supplyCountedAt: prev.supplyCountedAt }
      : { ...next, supplyCountedAt: countedAt };
    if (!next.supplyCountedAt) delete next.supplyCountedAt;
  } else {
    next.supplyCountedAt = countedAt;
  }
  next = stampEdit(prev, next, now);
  return {
    ...d,
    medications: prev ? d.medications.map((m) => (m.id === med.id ? next : m)) : [...d.medications, next],
  };
}

/**
 * Data to import (a restored backup, or a merge with one): what differs from the current copy
 * counts as changed now, so it wins over older edits when synced; a medication deleted for good in
 * the cloud comes back under a new id (the old one stays deleted everywhere).
 */
export function prepareImport(current: AppData, incoming: AppData, deletedInCloud: (id: string) => boolean): AppData {
  const now = new Date().toISOString();
  const byId = new Map(current.medications.map((m) => [m.id, m]));
  const renamed = new Map<string, string>();
  const medications = incoming.medications.map((m) => {
    if (deletedInCloud(m.id)) {
      const id = newId();
      renamed.set(m.id, id);
      return stampEdit(undefined, { ...m, id }, now);
    }
    const prev = byId.get(m.id);
    if (prev && (prev === m || JSON.stringify(prev) === JSON.stringify(m))) return prev;
    return stampEdit(prev, m, now);
  });
  const doseLogs = renamed.size
    ? incoming.doseLogs.map((l) => (renamed.has(l.medId) ? { ...l, medId: renamed.get(l.medId)! } : l))
    : incoming.doseLogs;
  return { version: 1, medications, doseLogs };
}

/**
 * The signed-in account's data. Edits are saved to this device right away and shown in its other
 * tabs; when `syncUid` is given (a Google account) they're also synced to the cloud, and edits
 * from other devices arrive. Nothing is loaded (or can be edited) while `access` isn't open.
 * `mark`: the account's deletion mark when the app took it up (default: now); the session ends if
 * it's deleted since (see session.ts).
 */
export function useAppData(userId: string, syncUid?: string, onAccountDeleted?: () => void, mark?: string | null) {
  const [data, setDataState] = useState<AppData>(EMPTY_DATA);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  /** The key is being forgotten here: closed while this device's copy is encrypted. */
  const [sealing, setSealing] = useState(false);
  /**
   * Forgetting the key here failed (this device's copy couldn't be encrypted), or another tab locked
   * it before this one heard: what happened, for the user (until dismissed).
   */
  const [lockError, setLockError] = useState<string | null>(null);
  /** Bumped to load this device's copy again (encrypting it failed, so it's shown again). */
  const [reloads, setReloads] = useState(0);
  const access: DataAccess = sealing ? 'locked' : dataAccess(syncUid, syncStatus);
  const open = access === 'open';
  /** Resolves once this device's copy is loaded (and while it stays loaded); sync waits for it. */
  const readyRef = useRef<Deferred>(deferred());
  // The latest state, updated synchronously so each edit is diffed against what preceded it.
  const dataRef = useRef(data);
  const loadedRef = useRef(false);
  const persistentRef = useRef(true);
  /** A save failed: the next one writes everything, so nothing it missed is lost. */
  const dirtyRef = useRef(false);
  const syncRef = useRef<SyncHandle | null>(null);
  const [syncControls, setSyncControls] = useState<SyncHandle | null>(null);
  const onAccountDeletedRef = useRef(onAccountDeleted);
  onAccountDeletedRef.current = onAccountDeleted;
  /** Signed out (here or in another tab): nothing more is saved or synced, so the wipe stays wiped. */
  const endedRef = useRef(false);
  /** The account's deletion mark when this session started: a new one means it was deleted since. */
  // (The app's, when given: a deletion between its check and this one isn't taken as the start.)
  const [sessionMark] = useState(() => (mark !== undefined ? mark : deletionMark(userId)));
  /**
   * Signed out, or the account deleted since this session started (in any tab, told or not: a tab
   * that slept through it finds out here, before it saves anything). Ends the session if so.
   */
  const ended = useCallback(() => {
    if (endedRef.current) return true;
    if (!accountDeletedSince(userId, sessionMark)) return false;
    endedRef.current = true;
    // Stopped at once, not after the session's end below has waited for saves: whatever sync is in
    // the middle of (e.g. merging a snapshot) mustn't queue or keep anything for the deleted account.
    loadedRef.current = false;
    syncRef.current?.stop();
    checkDeletedElsewhere(); // ends this tab's session of it and tells the app
    return true;
  }, [userId, sessionMark]);
  const endedFnRef = useRef(ended);
  endedFnRef.current = ended;
  /** Settles once edits being saved now are saved and handed to sync (or refused). */
  const savingRef = useRef<Promise<unknown>>(Promise.resolve());

  /**
   * This device's copy was locked in another tab before this one heard (a save was refused, see
   * localDb storeSealed): stop using it here and say so. Nothing refused is queued for upload.
   */
  const lockedOutRef = useRef(false);
  const lockedOut = useCallback((edit: boolean) => {
    loadedRef.current = false;
    lockedOutRef.current = true; // (said until unlocked again)
    setLockError(
      edit
        ? "Dosely was locked in another tab, so your last change wasn't saved. Unlock to keep going."
        : 'Dosely was locked in another tab.',
    );
    syncRef.current?.lockedElsewhere();
  }, []);

  const show = useCallback((next: AppData) => {
    dataRef.current = next;
    setDataState(next);
  }, []);

  /**
   * Save to this device and tell its other tabs. Resolves false if it was refused because this
   * device's copy was locked in another tab meanwhile (nothing was saved; see lockedOut), else true
   * (saved, or failing to save is shown, and the next save writes everything).
   */
  const persist = useCallback(
    (prev: AppData, next: AppData, edit: boolean): Promise<boolean> => {
      if (ended()) return Promise.resolve(false);
      if (!persistentRef.current) {
        setSaveError(!writeLegacy(userId, next));
        return Promise.resolve(true);
      }
      const changes = changesBetween(prev, next);
      if (!hasChanges(changes)) return Promise.resolve(true);
      const full = dirtyRef.current;
      dirtyRef.current = false;
      const tell = () => dataChannel()?.postMessage({ userId, from: tabId, changes } satisfies TabMessage);
      return (full ? replaceAccount(userId, next) : writeChanges(userId, changes)).then(
        () => {
          setSaveError(false);
          tell();
          return true;
        },
        (e) => {
          if (e instanceof LocalCopyLockedError) {
            lockedOut(edit);
            return false;
          }
          dirtyRef.current = true;
          setSaveError(true);
          tell();
          return true;
        },
      );
    },
    [userId, lockedOut, ended],
  );

  /** Data from the cloud: show it and save it here. */
  const applyRemote = useCallback(
    (next: AppData) => {
      if (!loadedRef.current || ended()) return; // locked meanwhile (or signed out)
      const prev = dataRef.current;
      if (next === prev) return;
      show(next);
      void persist(prev, next, false);
    },
    [show, persist, ended],
  );

  /** A local edit: save it, show it, and hand the change to cloud sync. */
  const commit = useCallback(
    (fn: (d: AppData) => AppData) => {
      // Nothing to edit yet (loading, or locked), or signed out (or deleted, even if not told yet).
      if (!loadedRef.current || ended()) return;
      const prev = dataRef.current;
      const next = fn(prev);
      if (next === prev) return;
      show(next);
      // Queued for upload only once it's saved here (not at all if that's refused).
      const saved = persist(prev, next, true);
      syncRef.current?.push(prev, next, saved);
      const handedOver = saved.then(() => {}); // (after sync has it, see push)
      savingRef.current = Promise.all([savingRef.current, handedOver]);
    },
    [show, persist, ended],
  );

  // Cloud sync. Started straight away: it tells whether the account is locked. Cloud data is only
  // merged in once this device's copy has loaded (localReady), so the first merge sees it.
  useEffect(() => {
    if (endedRef.current) return;
    if (!syncUid) {
      setSyncStatus(null);
      setSyncControls(null);
      return;
    }
    const handle = startSync({
      uid: syncUid,
      getLocal: () => dataRef.current,
      applyRemote,
      onStatus: setSyncStatus,
      onAccountDeleted: () => onAccountDeletedRef.current?.(),
      // Signed out, or deleted in any tab (told or not): nothing more is queued, kept or uploaded.
      isEnded: () => endedFnRef.current(),
      localReady: () => readyRef.current.promise,
      localHidden: () => !loadedRef.current,
      sealLocal: async (key, keyId, { elsewhere = false, unless, onSealed } = {}) => {
        // Stop showing and saving the data first, so nothing readable is written back afterwards.
        loadedRef.current = false;
        setSealing(true);
        setLockError(null);
        lockedOutRef.current = false;
        try {
          // Without IndexedDB it can't be kept encrypted here: then only if the cloud has all of it
          // (it's removed, and comes back once unlocked).
          const sealed = await sealLocal(userId, syncUid, key, keyId, { unless, sealed: onSealed });
          if (!sealed && !(await discardIfSynced(userId, syncUid))) throw new Error("This device's copy can't be encrypted here.");
        } catch (e) {
          // Nothing was changed: it stays unlocked (see forgetKey), so show the data again.
          setSealing(false);
          setReloads((n) => n + 1);
          if (!elsewhere) setLockError(new SyncCryptoError('lock-failed').message);
          throw e;
        }
      },
    });
    syncRef.current = handle;
    setSyncControls(handle);
    return () => {
      handle.stop();
      if (syncRef.current === handle) syncRef.current = null;
      setSyncControls((h) => (h === handle ? null : h));
    };
  }, [userId, syncUid, applyRemote]);

  // Done encrypting this device's copy: the lock (no longer unlocked) keeps it closed from here.
  const lock = syncStatus?.lock;
  useEffect(() => {
    if (lock !== 'unlocked') setSealing(false);
    else if (lockedOutRef.current) {
      // Unlocked again: "locked in another tab" no longer applies.
      lockedOutRef.current = false;
      setLockError(null);
    }
  }, [lock]);

  // Locked with a readable copy here and no key to encrypt it with (e.g. from before this was
  // done): remove it if the cloud has all of it. Unlocking brings it back.
  useEffect(() => {
    if (lock === 'locked' && syncUid && !endedRef.current) void discardIfSynced(userId, syncUid);
  }, [lock, userId, syncUid]);

  // Load once open, and follow edits made in this device's other tabs. Closed (locked): the data
  // is dropped from memory.
  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    setLoaded(false);
    show(EMPTY_DATA);
    if (!open) {
      if (readyRef.current.done) readyRef.current = deferred();
      return;
    }
    if (ended()) return;
    const handle = syncUid ? syncRef.current : null;
    /** Still unlocked, and this load still wanted (see loadForUser). */
    const wanted = () => !cancelled && !ended() && syncRef.current === handle;
    /** Messages from other tabs that arrive while loading: applied once loaded. */
    let early: TabMessage[] | null = [];
    const onMessage = (e: MessageEvent<TabMessage>) => {
      const msg = e.data;
      if (!msg || msg.userId !== userId || msg.from === tabId) return;
      if (early) return void early.push(msg);
      show('cleared' in msg ? EMPTY_DATA : applyChanges(dataRef.current, msg.changes));
    };
    const ch = dataChannel();
    ch?.addEventListener('message', onMessage);
    // Without IndexedDB, other tabs' edits arrive as localStorage events instead.
    const onStorage = (e: StorageEvent) => {
      if (!persistentRef.current && loadedRef.current && (e.key === null || e.key === legacyKey(userId))) {
        show(readLegacy(userId) ?? EMPTY_DATA);
      }
    };
    window.addEventListener('storage', onStorage);

    loadForUser(
      userId,
      handle?.dataKey() && syncUid ? { uid: syncUid, key: () => handle.dataKey(), wanted } : undefined,
      () => !cancelled && !ended(),
    )
      // Locked in another tab meanwhile: not kept readable elsewhere instead.
      .catch((e) =>
        e instanceof LoadAbandonedError
          ? undefined
          : e instanceof LocalCopyLockedError
            ? null
            : { data: readLegacy(userId) ?? EMPTY_DATA, persistent: false },
      )
      .then((result) => {
        if (cancelled || ended()) return;
        if (result === undefined) {
          // Given up because the key changed while it waited (still open): load again with this one.
          if (!endedRef.current && syncRef.current === handle && handle?.dataKey()) setReloads((n) => n + 1);
          return;
        }
        if (!result) return lockedOut(false);
        const { data: loadedData, persistent } = result;
        persistentRef.current = persistent;
        let d = loadedData;
        for (const msg of early ?? []) d = 'cleared' in msg ? EMPTY_DATA : applyChanges(d, msg.changes);
        early = null;
        show(d);
        loadedRef.current = true;
        setLoaded(true);
        readyRef.current.resolve();
        // Shown again (e.g. encrypting it failed): edits queued while it was hidden go up now.
        syncRef.current?.localShown?.();
      });
    return () => {
      cancelled = true;
      loadedRef.current = false;
      ch?.removeEventListener('message', onMessage);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId, syncUid, open, show, reloads, lockedOut, ended]);

  // Fetch the sync code and open Firestore's cache while this device's copy is still loading.
  useEffect(() => {
    if (syncUid) preloadSync();
  }, [syncUid]);

  // Signing out or deleting the account (in this tab or another) clears this device: stop saving
  // and syncing first, and let a load already under way finish, so nothing is written back
  // afterwards. Another tab is also deleting Firestore's offline cache, which waits for this tab's
  // copy to close. (Guests too: deleting a guest's data in another tab ends it here.)
  useEffect(() => {
    return holdSession(
      userId,
      async (elsewhere) => {
        endedRef.current = true;
        // Sync stops first: a snapshot it's in the middle of mustn't queue, keep or upload anything
        // while the saves below finish. (Edits being saved still reach the upload queue, see push.)
        syncRef.current?.stop();
        await savingRef.current.catch(() => {});
        await navigator.locks?.request(`medtracker-load-${userId}`, () => {}).catch(() => {});
        if (elsewhere) {
          // Nothing of it stays in memory here (this tab's own sign-out keeps it on screen till done).
          loadedRef.current = false;
          show(EMPTY_DATA);
          if (syncUid) await releaseSyncClient();
        }
      },
      { mark: sessionMark },
    );
  }, [userId, syncUid, sessionMark, show]);


  const saveMedication = useCallback(
    (med: Medication, supplyShownAs?: number) => commit((d) => applySaveMedication(d, med, supplyShownAs)),
    [commit],
  );

  const deleteMedication = useCallback(
    (id: string) =>
      commit((d) => ({
        ...d,
        medications: d.medications.filter((m) => m.id !== id),
        doseLogs: d.doseLogs.filter((l) => l.medId !== id),
      })),
    [commit],
  );

  const logDose = useCallback(
    (medId: string, scheduledFor: string, status: DoseStatus) =>
      commit((d) => applyLogDose(d, medId, scheduledFor, status)),
    [commit],
  );

  const undoDose = useCallback(
    (medId: string, scheduledFor: string) => commit((d) => applyUndoDose(d, medId, scheduledFor)),
    [commit],
  );

  /** Imports count as local edits, so they sync too. */
  const replaceData = useCallback(
    (next: AppData) => commit((d) => prepareImport(d, next, (id) => syncRef.current?.deletedInCloud(id) ?? false)),
    [commit],
  );

  /** The latest data, including what arrived since the last render. */
  const getData = useCallback(() => dataRef.current, []);
  const dismissLockError = useCallback(() => setLockError(null), []);

  return {
    data,
    loaded,
    access,
    /** Being locked (the key forgotten here): this device's copy is being encrypted. */
    locking: sealing,
    lockError,
    dismissLockError,
    saveError,
    syncStatus,
    syncControls,
    saveMedication,
    deleteMedication,
    logDose,
    undoDose,
    replaceData,
    getData,
  };
}
