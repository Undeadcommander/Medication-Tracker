// Pure helpers for cloud sync: turning local edits into operations, and cloud documents back
// into AppData. Kept free of Firebase so they can be unit-tested.
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { validateAppData } from './vault';

/**
 * One change to push. Ops are derived from what this device changed (previous state → next
 * state), never from a full-state comparison with the cloud, so an old device can't resurrect
 * medications that were deleted elsewhere.
 */
export type SyncOp =
  | { kind: 'setMed'; med: Medication }
  | { kind: 'deleteMed'; id: string }
  | { kind: 'setLog'; log: DoseLog }
  | { kind: 'deleteLog'; log: Pick<DoseLog, 'id' | 'scheduledFor'>; /** Month document, if not the one scheduledFor maps to. */ month?: string };

/** Dose logs are grouped into one cloud document per month of the scheduled time (UTC). */
export function logMonth(scheduledFor: string): string {
  const d = new Date(scheduledFor);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().slice(0, 7);
}

/** Firestore rejects `undefined`; JSON round-tripping drops those keys. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function diffAppData(prev: AppData, next: AppData): SyncOp[] {
  const ops: SyncOp[] = [];
  const prevMeds = new Map(prev.medications.map((m) => [m.id, m]));
  const nextMeds = new Map(next.medications.map((m) => [m.id, m]));
  for (const [id, med] of nextMeds) {
    const before = prevMeds.get(id);
    if (!before || !same(before, med)) ops.push({ kind: 'setMed', med });
  }
  for (const id of prevMeds.keys()) if (!nextMeds.has(id)) ops.push({ kind: 'deleteMed', id });

  const prevLogs = new Map(prev.doseLogs.map((l) => [l.id, l]));
  const nextLogs = new Map(next.doseLogs.map((l) => [l.id, l]));
  for (const [id, log] of nextLogs) {
    const before = prevLogs.get(id);
    if (!before || !same(before, log)) {
      // Moving a log to another month (shouldn't happen, but be safe) = delete + set.
      if (before && logMonth(before.scheduledFor) !== logMonth(log.scheduledFor)) {
        ops.push({ kind: 'deleteLog', log: { id, scheduledFor: before.scheduledFor } });
      }
      ops.push({ kind: 'setLog', log });
    }
  }
  for (const [id, log] of prevLogs) {
    if (!nextLogs.has(id)) ops.push({ kind: 'deleteLog', log: { id, scheduledFor: log.scheduledFor } });
  }
  return ops;
}

/** Cloud document shapes. */
export interface MedDoc {
  med: Medication;
}
export interface LogMonthDoc {
  logs?: Record<string, DoseLog>;
}

export interface RemoteState {
  data: AppData;
  /** Extra logs for an already-logged dose (logged separately on two devices); delete them. */
  duplicateLogs: DoseLog[];
  /** Documents that failed validation and were ignored. */
  rejected: number;
}

/**
 * Build AppData from cloud documents. Each item is validated like an import, bad items are
 * skipped, and duplicate logs for the same dose are collapsed (newest action wins).
 */
export function remoteToAppData(medDocs: unknown[], logDocs: unknown[]): RemoteState {
  let rejected = 0;
  const medications: Medication[] = [];
  for (const doc of medDocs) {
    try {
      const med = (doc as MedDoc)?.med;
      medications.push(validateAppData({ version: 1, medications: [med], doseLogs: [] }).medications[0]);
    } catch {
      rejected++;
    }
  }

  const medIds = new Set(medications.map((m) => m.id));
  const byDose = new Map<string, DoseLog>();
  const duplicateLogs: DoseLog[] = [];
  for (const doc of logDocs) {
    const logs = (doc as LogMonthDoc)?.logs;
    if (!logs || typeof logs !== 'object') continue;
    for (const raw of Object.values(logs)) {
      let log: DoseLog;
      try {
        log = validateAppData({ version: 1, medications: [], doseLogs: [raw] }).doseLogs[0];
      } catch {
        rejected++;
        continue;
      }
      if (!medIds.has(log.medId)) continue; // medication deleted; its logs are cleaned up separately
      const key = `${log.medId}|${new Date(log.scheduledFor).toISOString()}`;
      const prev = byDose.get(key);
      if (!prev) {
        byDose.set(key, log);
      } else if (Date.parse(log.loggedAt) > Date.parse(prev.loggedAt)) {
        duplicateLogs.push(prev);
        byDose.set(key, log);
      } else {
        duplicateLogs.push(log);
      }
    }
  }
  return { data: { version: 1, medications, doseLogs: [...byDose.values()] }, duplicateLogs, rejected };
}

/** Logs whose medication no longer exists (deleted on another device). */
export function orphanLogs(logDocs: unknown[], medIds: Set<string>): Pick<DoseLog, 'id' | 'scheduledFor'>[] {
  const out: Pick<DoseLog, 'id' | 'scheduledFor'>[] = [];
  for (const doc of logDocs) {
    const logs = (doc as LogMonthDoc)?.logs;
    if (!logs || typeof logs !== 'object') continue;
    for (const raw of Object.values(logs)) {
      const l = raw as Partial<DoseLog>;
      if (typeof l?.id === 'string' && typeof l.scheduledFor === 'string' && typeof l.medId === 'string' && !medIds.has(l.medId)) {
        out.push({ id: l.id, scheduledFor: l.scheduledFor });
      }
    }
  }
  return out;
}

/**
 * Cloud data to show, keeping this device's copy of anything whose cloud document couldn't be
 * decrypted, so a damaged or tampered document never silently deletes local data.
 */
export function keepLocalForFailed(remote: AppData, local: AppData, failed: { meds: string[]; logs: string[] }): AppData {
  if (!failed.meds.length && !failed.logs.length) return remote;
  const medIds = new Set(remote.medications.map((m) => m.id));
  const logIds = new Set(remote.doseLogs.map((l) => l.id));
  const failedMeds = new Set(failed.meds);
  const failedLogs = new Set(failed.logs);
  const medications = [...remote.medications, ...local.medications.filter((m) => failedMeds.has(m.id) && !medIds.has(m.id))];
  const keptMedIds = new Set(medications.map((m) => m.id));
  const doseLogs = [
    ...remote.doseLogs,
    ...local.doseLogs.filter((l) => (failedLogs.has(l.id) || failedMeds.has(l.medId)) && !logIds.has(l.id) && keptMedIds.has(l.medId)),
  ];
  return { ...remote, medications, doseLogs };
}

/**
 * Encryption migration: items still stored in plaintext (written before end-to-end encryption,
 * or by an outdated app) are re-uploaded through the normal ops, which encrypt them and overwrite
 * the plaintext in place. Plaintext that's invalid, a duplicate, an orphan, or filed under the
 * wrong month is deleted instead. Pure, so it can run again after an interruption: whatever is
 * still plaintext on the next snapshot is simply picked up again.
 */
export function migrationOps(
  remote: RemoteState,
  plaintext: { medIds: string[]; logs: { month: string; id: string }[] },
): SyncOp[] {
  const ops: SyncOp[] = [];
  const meds = new Map(remote.data.medications.map((m) => [m.id, m]));
  for (const id of plaintext.medIds) {
    const med = meds.get(id);
    ops.push(med ? { kind: 'setMed', med } : { kind: 'deleteMed', id });
  }
  const logs = new Map(remote.data.doseLogs.map((l) => [l.id, l]));
  for (const ref of plaintext.logs) {
    const log = logs.get(ref.id);
    if (log && logMonth(log.scheduledFor) === ref.month) {
      ops.push({ kind: 'setLog', log });
    } else {
      // Kept copies (if any) are written to their correct month by the normal ops.
      ops.push({ kind: 'deleteLog', log: { id: ref.id, scheduledFor: log?.scheduledFor ?? '' }, month: ref.month });
      if (log) ops.push({ kind: 'setLog', log });
    }
  }
  return ops;
}
