// Local, per-account persistence of medications and dose history.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AppData, DoseLog, DoseStatus, Medication } from '../../shared/types';
import { startSync, type SyncHandle, type SyncStatus } from './sync';

const PREFIX = 'medtracker.data.';

export const EMPTY_DATA: AppData = { version: 1, medications: [], doseLogs: [] };

export const MED_COLORS = ['#0f766e', '#2563eb', '#7c3aed', '#db2777', '#ea580c', '#ca8a04', '#16a34a', '#475569'];

export function newId(): string {
  return crypto.randomUUID();
}

function storageKey(userId: string) {
  return PREFIX + userId;
}

export function readData(userId: string): AppData {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return EMPTY_DATA;
    const parsed = JSON.parse(raw) as AppData;
    if (parsed?.version !== 1 || !Array.isArray(parsed.medications) || !Array.isArray(parsed.doseLogs)) return EMPTY_DATA;
    return parsed;
  } catch {
    return EMPTY_DATA;
  }
}

function writeData(userId: string, data: AppData): boolean {
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(data));
    return true;
  } catch {
    return false;
  }
}

/** Move guest data into a newly signed-in account if that account has none yet. */
export function adoptGuestData(userId: string): boolean {
  if (userId === 'guest') return false;
  const guest = readData('guest');
  const target = readData(userId);
  if (!guest.medications.length || target.medications.length) return false;
  if (!writeData(userId, guest)) return false;
  try {
    localStorage.removeItem(storageKey('guest'));
  } catch {
    /* ignore */
  }
  return true;
}

/** Keep logs for one year to bound storage. */
function pruneLogs(logs: DoseLog[]): DoseLog[] {
  const cutoff = Date.now() - 366 * 86_400_000;
  return logs.filter((l) => Date.parse(l.scheduledFor) >= cutoff);
}

/** Record (or change) the status of one scheduled dose. Adjusts supply on hand. */
export function applyLogDose(d: AppData, medId: string, scheduledFor: string, status: DoseStatus): AppData {
  const med = d.medications.find((m) => m.id === medId);
  if (!med) return d;
  const existing = d.doseLogs.find((l) => l.medId === medId && l.scheduledFor === scheduledFor);
  if (existing?.status === status) return d;
  const hasSupply = typeof med.supplyRemaining === 'number';
  // Supply only moves by what a "taken" log actually deducted (never below 0), so
  // undo or skip restores exactly that amount.
  const restored = existing?.status === 'taken' ? (existing.supplyDeducted ?? 0) : 0;
  let supply = (med.supplyRemaining ?? 0) + restored;
  let deducted = 0;
  if (status === 'taken' && hasSupply) {
    deducted = Math.min(med.quantityPerDose ?? 1, supply);
    supply -= deducted;
  }
  const log: DoseLog = {
    id: existing?.id ?? newId(),
    medId,
    scheduledFor,
    status,
    loggedAt: new Date().toISOString(),
    ...(deducted > 0 ? { supplyDeducted: deducted } : {}),
  };
  const doseLogs = existing ? d.doseLogs.map((l) => (l.id === existing.id ? log : l)) : [...d.doseLogs, log];
  const medications =
    hasSupply && supply !== med.supplyRemaining
      ? d.medications.map((m) => (m.id === medId ? { ...m, supplyRemaining: supply } : m))
      : d.medications;
  return { ...d, medications, doseLogs: pruneLogs(doseLogs) };
}

/** Remove a dose's log, restoring exactly the supply it deducted. */
export function applyUndoDose(d: AppData, medId: string, scheduledFor: string): AppData {
  const existing = d.doseLogs.find((l) => l.medId === medId && l.scheduledFor === scheduledFor);
  if (!existing) return d;
  const restore = existing.status === 'taken' ? (existing.supplyDeducted ?? 0) : 0;
  return {
    ...d,
    doseLogs: d.doseLogs.filter((l) => l.id !== existing.id),
    medications: restore
      ? d.medications.map((m) =>
          m.id === medId && typeof m.supplyRemaining === 'number'
            ? { ...m, supplyRemaining: m.supplyRemaining + restore }
            : m,
        )
      : d.medications,
  };
}

/**
 * The signed-in account's data. Edits are saved to this device immediately; when `syncUid` is
 * given (a Google account), they're also synced to the cloud and edits from other devices arrive.
 */
export function useAppData(userId: string, syncUid?: string) {
  const [data, setDataState] = useState<AppData>(() => readData(userId));
  const [saveError, setSaveError] = useState(false);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const loadedFor = useRef(userId);
  // The latest state, updated synchronously so each edit is diffed against what preceded it.
  const dataRef = useRef(data);
  const syncRef = useRef<SyncHandle | null>(null);

  /** Data that didn't come from a local edit (cloud, another tab, account switch). */
  const applyExternal = useCallback((next: AppData) => {
    dataRef.current = next;
    setDataState(next);
  }, []);

  /** A local edit: update state and hand the change to cloud sync. */
  const commit = useCallback((fn: (d: AppData) => AppData) => {
    const prev = dataRef.current;
    const next = fn(prev);
    if (next === prev) return;
    dataRef.current = next;
    setDataState(next);
    syncRef.current?.push(prev, next);
  }, []);

  // Reload when the account changes.
  useEffect(() => {
    if (loadedFor.current !== userId) {
      loadedFor.current = userId;
      applyExternal(readData(userId));
    }
  }, [userId, applyExternal]);

  // Persist on change.
  useEffect(() => {
    if (loadedFor.current === userId) setSaveError(!writeData(userId, data));
  }, [data, userId]);

  // Sync across tabs.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === storageKey(userId)) applyExternal(readData(userId));
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [userId, applyExternal]);

  // Cloud sync.
  useEffect(() => {
    if (!syncUid) {
      setSyncStatus(null);
      return;
    }
    const handle = startSync({
      uid: syncUid,
      getLocal: () => dataRef.current,
      applyRemote: applyExternal,
      onStatus: setSyncStatus,
    });
    syncRef.current = handle;
    return () => {
      handle.stop();
      if (syncRef.current === handle) syncRef.current = null;
    };
  }, [syncUid, applyExternal]);

  const saveMedication = useCallback(
    (med: Medication) =>
      commit((d) => {
        const exists = d.medications.some((m) => m.id === med.id);
        const next = { ...med, updatedAt: new Date().toISOString() };
        return {
          ...d,
          medications: exists ? d.medications.map((m) => (m.id === med.id ? next : m)) : [...d.medications, next],
        };
      }),
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
  const replaceData = useCallback((next: AppData) => commit(() => next), [commit]);

  return { data, saveError, syncStatus, saveMedication, deleteMedication, logDose, undoDose, replaceData };
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
