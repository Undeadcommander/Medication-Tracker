// Local, per-account persistence of medications and dose history (IndexedDB, see localDb.ts),
// shared live between this device's open tabs.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppData, DoseLog, DoseStatus, Medication } from '../../shared/types';
import {
  applyChanges,
  changesBetween,
  deleteAccount,
  hasChanges,
  loadAccount,
  localDbAvailable,
  replaceAccount,
  writeChanges,
  type Changes,
} from './localDb';
import { logsByMed, stampEdit, supplyOnHand, unitsPerDose } from './supply';
import { preloadSync, startSync, type SyncHandle, type SyncStatus } from './sync';
import { LOG_RETENTION_MS } from './syncOps';
import { mergeAppData } from './vault';

/** Where older versions kept everything, as one localStorage string per account. */
const LEGACY_PREFIX = 'medtracker.data.';

export const EMPTY_DATA: AppData = { version: 1, medications: [], doseLogs: [] };

export const MED_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#16a34a', '#475569'];

export function newId(): string {
  return crypto.randomUUID();
}

// ---------- legacy localStorage copy (read once to migrate; also the fallback without IndexedDB) ----------

function legacyKey(userId: string) {
  return LEGACY_PREFIX + userId;
}

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
  removeLegacy(userId);
  try {
    await deleteAccount(userId);
  } catch {
    /* storage unavailable */
  }
  dataChannel()?.postMessage({ userId, from: tabId, cleared: true } satisfies TabMessage);
}

function isOld(l: DoseLog, cutoff: number) {
  return Date.parse(l.scheduledFor) < cutoff;
}

/**
 * Load an account's data: from IndexedDB, migrating the old localStorage copy the first time, and
 * taking over guest data when a signed-in account has none yet. Old dose history is dropped.
 */
async function loadForUser(userId: string): Promise<{ data: AppData; persistent: boolean }> {
  if (!(await localDbAvailable())) return { data: readLegacy(userId) ?? EMPTY_DATA, persistent: false };
  // One tab at a time per account, so two tabs opening together can't both migrate or adopt.
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  const run = () => loadAndTidy(userId).then((data) => ({ data, persistent: true }));
  return locks ? locks.request(`medtracker-load-${userId}`, run) : run();
}

/** A recount at least this often keeps every dose since the count within the kept history. */
const RECOUNT_AFTER_MS = 330 * 86_400_000;

async function loadAndTidy(userId: string): Promise<AppData> {
  let data = await loadAccount(userId);
  const empty = (d: AppData) => !d.medications.length && !d.doseLogs.length;
  // A localStorage copy: from an older version, or saved here while IndexedDB couldn't be used.
  const legacy = readLegacy(userId);
  if (legacy && !empty(legacy)) {
    data = empty(data) ? legacy : mergeAppData(data, legacy);
    await replaceAccount(userId, data);
  }
  removeLegacy(userId);
  if (userId !== 'guest' && !data.medications.length) {
    // Signed in on a device that was used as a guest: the guest data becomes this account's.
    const guest = await loadAccount('guest');
    const guestData = guest.medications.length ? guest : readLegacy('guest');
    if (guestData?.medications.length) {
      await replaceAccount(userId, guestData);
      await deleteAccount('guest');
      removeLegacy('guest');
      data = guestData;
      // The cloud copy doesn't have it: the next sync merges this device's data in, instead of
      // treating the cloud as up to date (which would drop the guest's dose history).
      try {
        localStorage.removeItem(`medtracker.synced.${userId.replace(/^firebase:/, '')}`);
      } catch {
        /* ignore */
      }
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
    supplyRemaining: med.supplyRemaining + restore,
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
 * from other devices arrive.
 */
export function useAppData(userId: string, syncUid?: string, onAccountDeleted?: () => void) {
  const [data, setDataState] = useState<AppData>(EMPTY_DATA);
  const [loaded, setLoaded] = useState(false);
  const [saveError, setSaveError] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
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

  const show = useCallback((next: AppData) => {
    dataRef.current = next;
    setDataState(next);
  }, []);

  /** Save to this device and tell its other tabs. */
  const persist = useCallback(
    (prev: AppData, next: AppData) => {
      if (!persistentRef.current) {
        setSaveError(!writeLegacy(userId, next));
        return;
      }
      const changes = changesBetween(prev, next);
      if (!hasChanges(changes)) return;
      const full = dirtyRef.current;
      dirtyRef.current = false;
      (full ? replaceAccount(userId, next) : writeChanges(userId, changes)).then(
        () => setSaveError(false),
        () => {
          dirtyRef.current = true;
          setSaveError(true);
        },
      );
      dataChannel()?.postMessage({ userId, from: tabId, changes } satisfies TabMessage);
    },
    [userId],
  );

  /** Data from the cloud: show it and save it here. */
  const applyRemote = useCallback(
    (next: AppData) => {
      const prev = dataRef.current;
      if (next === prev) return;
      show(next);
      persist(prev, next);
    },
    [show, persist],
  );

  /** A local edit: save it, show it, and hand the change to cloud sync. */
  const commit = useCallback(
    (fn: (d: AppData) => AppData) => {
      if (!loadedRef.current) return; // nothing to edit yet
      const prev = dataRef.current;
      const next = fn(prev);
      if (next === prev) return;
      show(next);
      persist(prev, next);
      syncRef.current?.push(prev, next);
    },
    [show, persist],
  );

  // Load, and follow edits made in this device's other tabs.
  useEffect(() => {
    let cancelled = false;
    loadedRef.current = false;
    setLoaded(false);
    show(EMPTY_DATA);
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

    loadForUser(userId)
      .catch(() => ({ data: readLegacy(userId) ?? EMPTY_DATA, persistent: false }))
      .then(({ data: loadedData, persistent }) => {
        if (cancelled) return;
        persistentRef.current = persistent;
        let d = loadedData;
        for (const msg of early ?? []) d = 'cleared' in msg ? EMPTY_DATA : applyChanges(d, msg.changes);
        early = null;
        show(d);
        loadedRef.current = true;
        setLoaded(true);
      });
    return () => {
      cancelled = true;
      ch?.removeEventListener('message', onMessage);
      window.removeEventListener('storage', onStorage);
    };
  }, [userId, show]);

  // Fetch the sync code and open Firestore's cache while this device's copy is still loading.
  useEffect(() => {
    if (syncUid) preloadSync();
  }, [syncUid]);

  // Cloud sync (once this device's copy is loaded, so the first merge sees it).
  useEffect(() => {
    if (!syncUid || !loaded) {
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
    });
    syncRef.current = handle;
    setSyncControls(handle);
    return () => {
      handle.stop();
      if (syncRef.current === handle) syncRef.current = null;
      setSyncControls((h) => (h === handle ? null : h));
    };
  }, [syncUid, loaded, applyRemote]);

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

  return { data, loaded, saveError, syncStatus, syncControls, saveMedication, deleteMedication, logDose, undoDose, replaceData };
}

/** Per-device preferences that aren't part of the exported data. */
export interface Prefs {
  discreetNotifications: boolean;
}

const PREFS_KEY = 'medtracker.prefs';

export function loadPrefs(): Prefs {
  try {
    const p = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}');
    return { discreetNotifications: p.discreetNotifications === true };
  } catch {
    return { discreetNotifications: false };
  }
}

export function savePrefs(p: Prefs) {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* ignore */
  }
}
