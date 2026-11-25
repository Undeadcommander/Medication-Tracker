// Pure helpers for cloud sync: turning local edits into operations, cloud documents back into
// AppData, and combining the cloud copy with this device's. Kept free of Firebase so they can be
// unit-tested.
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { diffById } from './arrayDiff';
import { mergeMed } from './supply';
import { validateDoseLog, validateMedication } from './vault';

/** One change to push. */
export type SyncOp =
  | { kind: 'setMed'; med: Medication }
  /** Leaves a permanent "deleted" marker, so a device that was offline can't bring it back. */
  | { kind: 'deleteMed'; id: string }
  | { kind: 'setLog'; log: DoseLog }
  | { kind: 'deleteLog'; id: string; /** Cloud document it's in. */ doc: string };

/** Dose history is kept for a year (older logs are dropped here and removed from the cloud). */
export const LOG_RETENTION_MS = 366 * 86_400_000;

/** Month (UTC) of a scheduled time. */
export function logMonth(scheduledFor: string): string {
  const d = new Date(scheduledFor);
  return Number.isNaN(d.getTime()) ? 'unknown' : d.toISOString().slice(0, 7);
}

/** Dose logs are split by month and by medication into this many documents (Firestore caps a document at 1 MiB). */
const LOG_SHARDS = 32;

export function logShard(medId: string): string {
  let h = 0x811c9dc5; // FNV-1a
  for (let i = 0; i < medId.length; i++) {
    h ^= medId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return ((h >>> 0) % LOG_SHARDS).toString(36);
}

/** The cloud document a dose log belongs in, e.g. `2026-02~1f`. */
export function logDocId(log: Pick<DoseLog, 'medId' | 'scheduledFor'>): string {
  return `${logMonth(log.scheduledFor)}~${logShard(log.medId)}`;
}

/** Firestore rejects `undefined`; JSON round-tripping drops those keys. */
export function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

// Edits copy only what they change, so untouched items are the same objects: skip comparing them.
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

/** Ops for what changed between two local states (previous → next). */
export function diffAppData(prev: AppData, next: AppData): SyncOp[] {
  const ops: SyncOp[] = [];
  const meds = diffById(prev.medications, next.medications);
  for (const med of meds.put) ops.push({ kind: 'setMed', med });
  for (const med of meds.del) ops.push({ kind: 'deleteMed', id: med.id });
  const logs = diffById(prev.doseLogs, next.doseLogs);
  for (const log of logs.put) {
    // A log that moved to another document (shouldn't happen, but be safe) = delete + set.
    const b = logs.prior.get(log.id);
    if (b && logDocId(b) !== logDocId(log)) ops.push({ kind: 'deleteLog', id: log.id, doc: logDocId(b) });
    ops.push({ kind: 'setLog', log });
  }
  for (const log of logs.del) ops.push({ kind: 'deleteLog', id: log.id, doc: logDocId(log) });
  return ops;
}

// ---------------------------------------------------------------------------------------------
// Queued uploads
// ---------------------------------------------------------------------------------------------

/**
 * What a queued upload refers to: an item, not its contents. The contents are read from the local
 * copy when the upload is built, so a queued upload always sends the latest version (an old copy
 * can't overwrite a newer edit, whatever order tabs flush in), repeated edits of one item share one
 * entry, and the queue stays small even when everything is queued on a first sync. For a log, it's
 * the log in one particular cloud document: written there if the local log belongs there,
 * otherwise removed from there.
 */
export type OpRef = { kind: 'med'; id: string } | { kind: 'log'; id: string; doc: string };

export function refKey(r: OpRef): string {
  return r.kind === 'med' ? `m|${r.id}` : `l|${r.id}|${r.doc}`;
}

/** Also reads ops queued by older versions (`month` instead of `doc`, `log` on deletes). */
export function toRefs(ops: SyncOp[]): OpRef[] {
  const out = new Map<string, OpRef>();
  for (const raw of ops) {
    const op = raw as SyncOp & { log?: { id?: string; medId?: string; scheduledFor?: string }; month?: string; doc?: string };
    let r: OpRef | undefined;
    if (op.kind === 'setMed' && op.med?.id) r = { kind: 'med', id: op.med.id };
    else if (op.kind === 'deleteMed' && typeof op.id === 'string') r = { kind: 'med', id: op.id };
    else if (op.kind === 'setLog' && op.log?.id) r = { kind: 'log', id: op.log.id, doc: logDocId(op.log as DoseLog) };
    else if (op.kind === 'deleteLog') {
      const id = op.id ?? op.log?.id;
      const doc = op.doc ?? op.month ?? (op.log?.scheduledFor ? logMonth(op.log.scheduledFor) : undefined);
      if (typeof id === 'string' && typeof doc === 'string') r = { kind: 'log', id, doc };
    }
    if (r) out.set(refKey(r), r);
  }
  return [...out.values()];
}

/** The writes that make the cloud match the local copy for these items. */
export function resolveRefs(refs: OpRef[], local: AppData): SyncOp[] {
  const meds = new Map(local.medications.map((m) => [m.id, m]));
  const logs = new Map(local.doseLogs.map((l) => [l.id, l]));
  const out: SyncOp[] = [];
  const done = new Set<string>();
  for (const r of refs) {
    const key = refKey(r);
    if (done.has(key)) continue;
    done.add(key);
    if (r.kind === 'med') {
      const med = meds.get(r.id);
      out.push(med ? { kind: 'setMed', med } : { kind: 'deleteMed', id: r.id });
      continue;
    }
    const log = logs.get(r.id);
    if (log && logDocId(log) === r.doc) out.push({ kind: 'setLog', log });
    else out.push({ kind: 'deleteLog', id: r.id, doc: r.doc });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Cloud documents → AppData
// ---------------------------------------------------------------------------------------------

/** Decrypted cloud documents (see syncCrypto.decodeRemote). */
export interface RemoteDocs {
  meds: { id: string; med: unknown }[];
  /** Medications deleted for good. */
  tombstones: string[];
  logDocs: { id: string; logs: Record<string, unknown> }[];
}

export interface RemoteState {
  /** Live medications, and their logs (one per dose). */
  data: AppData;
  tombstones: Set<string>;
  /** Medication documents that failed validation (a newer version's format?): treat as unreadable. */
  invalidMedIds: Set<string>;
  /** Every place each log was found (normally one document). */
  logLocations: Map<string, string[]>;
  /** Logs in a document other than the one they belong in (e.g. written by an older version). */
  misfiled: { id: string; doc: string }[];
  /** Extra logs for an already-logged dose (logged separately on two devices): delete them. */
  duplicateLogs: { id: string; doc: string }[];
  /** Logs of medications that aren't live, by medication. */
  orphanLogs: { id: string; doc: string; medId: string }[];
  /** Items that failed validation and were ignored. */
  rejected: number;
}

const medMemo = new WeakMap<object, Medication | null>();
const logMemo = new WeakMap<object, DoseLog | null>();

/** Validation is memoized per decrypted object (they're reused from the decryption cache). */
function validMed(raw: unknown): Medication | null {
  if (!raw || typeof raw !== 'object') return null;
  let v = medMemo.get(raw);
  if (v === undefined) {
    try {
      v = validateMedication(raw, 'med');
    } catch {
      v = null;
    }
    medMemo.set(raw, v);
  }
  return v;
}

function validLog(raw: unknown): DoseLog | null {
  if (!raw || typeof raw !== 'object') return null;
  let v = logMemo.get(raw);
  if (v === undefined) {
    try {
      v = validateDoseLog(raw, 'log');
    } catch {
      v = null;
    }
    logMemo.set(raw, v);
  }
  return v;
}

export const doseKey = (l: Pick<DoseLog, 'medId' | 'scheduledFor'>) => {
  const t = Date.parse(l.scheduledFor);
  return `${l.medId}|${Number.isNaN(t) ? l.scheduledFor : new Date(t).toISOString()}`;
};

/** Newer action wins; ties go to the larger id, so every device keeps the same one. */
const newerLog = (a: DoseLog, b: DoseLog) => {
  const ta = Date.parse(a.loggedAt);
  const tb = Date.parse(b.loggedAt);
  return ta !== tb ? (ta > tb ? a : b) : a.id >= b.id ? a : b;
};

export function remoteToAppData(docs: RemoteDocs): RemoteState {
  let rejected = 0;
  const tombstones = new Set(docs.tombstones);
  const invalidMedIds = new Set<string>();
  const medications: Medication[] = [];
  for (const { id, med: raw } of docs.meds) {
    if (tombstones.has(id)) continue;
    const med = validMed(raw);
    if (med && med.id === id) medications.push(med);
    else {
      rejected++;
      invalidMedIds.add(id);
    }
  }

  const live = new Set(medications.map((m) => m.id));
  const logLocations = new Map<string, string[]>();
  const misfiled: RemoteState['misfiled'] = [];
  const orphanLogs: RemoteState['orphanLogs'] = [];
  const byId = new Map<string, DoseLog>();
  for (const { id: doc, logs } of docs.logDocs) {
    for (const [logId, raw] of Object.entries(logs)) {
      const log = validLog(raw);
      if (!log || log.id !== logId) {
        rejected++;
        continue;
      }
      const at = logLocations.get(logId);
      if (at) at.push(doc);
      else logLocations.set(logId, [doc]);
      if (logDocId(log) !== doc) misfiled.push({ id: logId, doc });
      if (!live.has(log.medId)) {
        orphanLogs.push({ id: logId, doc, medId: log.medId });
        continue;
      }
      const prev = byId.get(logId);
      byId.set(logId, prev ? newerLog(prev, log) : log);
    }
  }
  const byDose = new Map<string, DoseLog>();
  const duplicateLogs: RemoteState['duplicateLogs'] = [];
  for (const log of byId.values()) {
    const k = doseKey(log);
    const prev = byDose.get(k);
    if (!prev) {
      byDose.set(k, log);
      continue;
    }
    const keep = newerLog(prev, log);
    const drop = keep === prev ? log : prev;
    byDose.set(k, keep);
    for (const doc of logLocations.get(drop.id) ?? []) duplicateLogs.push({ id: drop.id, doc });
  }
  return {
    data: { version: 1, medications, doseLogs: [...byDose.values()] },
    tombstones,
    invalidMedIds,
    logLocations,
    misfiled,
    duplicateLogs,
    orphanLogs,
    rejected,
  };
}

// ---------------------------------------------------------------------------------------------
// Combining the cloud copy with this device's
// ---------------------------------------------------------------------------------------------

export interface ReconcileInput {
  remote: RemoteState;
  local: AppData;
  /** Items with uploads queued (in any tab): their local version is the one to keep. */
  queued: OpRef[];
  /** Cloud items that couldn't be decrypted: keep the local copies. */
  failed: { meds: string[]; logs: string[] };
  /** Logs scheduled before this (epoch ms) are dropped here and deleted from the cloud. */
  cutoff: number;
}

export interface ReconcileResult {
  /** What this device should now show and store (unchanged items are the local objects). */
  shown: AppData;
  /** Items the cloud should get this device's version of (safe to queue any time). */
  uploads: OpRef[];
  /** Cloud copies to remove: duplicates, orphans, expired and misfiled logs (queue when settled). */
  removals: OpRef[];
}

/**
 * The cloud copy and this device's copy, combined:
 * - Medications merge field by field (newer change wins). One only here is kept and uploaded (a
 *   deletion elsewhere would have left a marker); a deleted one goes.
 * - Dose logs follow the cloud unless an upload of them is queued (they're added or changed
 *   here); a log on both sides with different content keeps the newer action.
 * - One log per dose, none for medications that are gone, none older than `cutoff`.
 */
export function reconcile({ remote, local, queued, failed, cutoff }: ReconcileInput): ReconcileResult {
  const queuedMeds = new Set<string>();
  const queuedLogs = new Set<string>();
  for (const r of queued) (r.kind === 'med' ? queuedMeds : queuedLogs).add(r.id);
  const failedMeds = new Set([...failed.meds, ...remote.invalidMedIds]);
  const failedLogs = new Set(failed.logs);
  const uploads: OpRef[] = [];
  const removals: OpRef[] = [];

  // Medications.
  const remoteMeds = new Map(remote.data.medications.map((m) => [m.id, m]));
  const medications: Medication[] = [];
  for (const l of local.medications) {
    if (remote.tombstones.has(l.id)) continue; // deleted on another device
    const r = remoteMeds.get(l.id);
    remoteMeds.delete(l.id);
    if (r) {
      // Equal content comes back as the cloud object: the local copy takes it on, so later
      // snapshots compare by identity.
      const m = mergeMed(l, r);
      medications.push(m);
      if (m !== r && !queuedMeds.has(l.id)) uploads.push({ kind: 'med', id: l.id });
    } else {
      medications.push(l);
      // Here only: new, or the cloud copy is unreadable here, or it went without a marker (removed
      // by an older version or a key reset). Upload unless it's just unreadable.
      if (!queuedMeds.has(l.id) && !failedMeds.has(l.id)) uploads.push({ kind: 'med', id: l.id });
    }
  }
  for (const r of remoteMeds.values()) {
    if (queuedMeds.has(r.id)) continue; // deleted here; the marker is on its way
    medications.push(r);
  }
  const live = new Set(medications.map((m) => m.id));

  // Dose logs.
  const localLogs = new Map(local.doseLogs.map((l) => [l.id, l]));
  const byId = new Map<string, DoseLog>();
  const old = (l: DoseLog) => Date.parse(l.scheduledFor) < cutoff;
  const removeEverywhere = (id: string) => {
    for (const doc of remote.logLocations.get(id) ?? []) removals.push({ kind: 'log', id, doc });
  };
  for (const r of remote.data.doseLogs) {
    if (old(r)) {
      removeEverywhere(r.id);
      continue;
    }
    if (!live.has(r.medId)) continue; // its medication is gone (or deleted here)
    const l = localLogs.get(r.id);
    if (!l) {
      if (!queuedLogs.has(r.id)) byId.set(r.id, r); // else: removed here, removal on its way
      continue;
    }
    if (same(l, r)) byId.set(r.id, r); // (the cloud object, as for medications)
    else if (queuedLogs.has(r.id)) byId.set(r.id, l);
    else {
      const keep = newerLog(l, r);
      byId.set(r.id, keep);
      if (keep === l) uploads.push({ kind: 'log', id: l.id, doc: logDocId(l) });
    }
  }
  for (const l of local.doseLogs) {
    if (byId.has(l.id) || old(l) || !live.has(l.medId)) continue;
    // The cloud copy (or its medication's) can't be read here: keep this one.
    if (failedLogs.has(l.id) || failedMeds.has(l.medId)) {
      byId.set(l.id, l);
      continue;
    }
    if (remote.logLocations.has(l.id) && !queuedLogs.has(l.id)) continue; // dropped above (orphan/duplicate)
    // Not in the cloud: keep if its upload is queued (added here).
    if (queuedLogs.has(l.id)) byId.set(l.id, l);
  }

  // One log per dose.
  const byDose = new Map<string, DoseLog>();
  for (const l of byId.values()) {
    const k = doseKey(l);
    const prev = byDose.get(k);
    if (!prev) byDose.set(k, l);
    else {
      const keep = newerLog(prev, l);
      byDose.set(k, keep);
      removeEverywhere((keep === prev ? l : prev).id);
    }
  }
  const doseLogs = [...byDose.values()];

  // Tidy-ups in the cloud.
  for (const d of remote.duplicateLogs) removals.push({ kind: 'log', id: d.id, doc: d.doc });
  for (const o of remote.orphanLogs) {
    // Not for a medication that's unreadable here: its logs only look orphaned.
    if (!failedMeds.has(o.medId) && !live.has(o.medId)) removals.push({ kind: 'log', id: o.id, doc: o.doc });
  }
  for (const m of remote.misfiled) {
    removals.push({ kind: 'log', id: m.id, doc: m.doc });
    const log = byId.get(m.id);
    if (log) uploads.push({ kind: 'log', id: log.id, doc: logDocId(log) });
  }

  const unchanged = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  return {
    shown: {
      version: 1,
      medications: unchanged(medications, local.medications) ? local.medications : medications,
      doseLogs: unchanged(doseLogs, local.doseLogs) ? local.doseLogs : doseLogs,
    },
    uploads: dedupeRefs(uploads),
    removals: dedupeRefs(removals),
  };
}

function dedupeRefs(refs: OpRef[]): OpRef[] {
  const m = new Map<string, OpRef>();
  for (const r of refs) m.set(refKey(r), r);
  return [...m.values()];
}

/**
 * Encryption migration: items still stored in plaintext (written before end-to-end encryption)
 * are re-uploaded through the normal path, which encrypts them, and removed from where they were.
 */
export function migrationRefs(remote: RemoteState, plaintext: { medIds: string[]; logs: { doc: string; id: string }[] }): OpRef[] {
  const refs: OpRef[] = plaintext.medIds.filter((id) => !remote.tombstones.has(id)).map((id) => ({ kind: 'med', id }));
  const logs = new Map(remote.data.doseLogs.map((l) => [l.id, l]));
  for (const p of plaintext.logs) {
    refs.push({ kind: 'log', id: p.id, doc: p.doc });
    const log = logs.get(p.id);
    if (log && logDocId(log) !== p.doc) refs.push({ kind: 'log', id: p.id, doc: logDocId(log) });
  }
  return dedupeRefs(refs);
}
