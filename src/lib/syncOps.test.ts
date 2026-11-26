import { describe, expect, it } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { stampEdit } from './supply';
import {
  applyQueuedDeletions,
  diffAppData,
  flushStep,
  logDocId,
  logMonth,
  logShard,
  mergeRef,
  plain,
  reconcile,
  remoteToAppData,
  resolveRefs,
  summarizePending,
  toRefs,
  type FlushCheck,
  type OpRef,
  type RemoteDocs,
} from './syncOps';
import { mergeAppData } from './vault';

const med = (id: string, over: Partial<Medication> = {}): Medication => ({
  id,
  name: `Med ${id}`,
  dosage: '10 mg',
  color: '#0f766e',
  schedule: makeSchedule('daily', '2026-01-01'),
  notificationsEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const log = (id: string, over: Partial<DoseLog> = {}): DoseLog => ({
  id,
  medId: 'a',
  scheduledFor: '2026-02-10T14:00:00.000Z',
  status: 'taken',
  loggedAt: '2026-02-10T14:01:00.000Z',
  ...over,
});

const data = (medications: Medication[], doseLogs: DoseLog[] = []): AppData => ({ version: 1, medications, doseLogs });

/** Cloud documents as sync.ts would have written `d` (logs in their shard documents). */
const docs = (d: AppData, tombstones: string[] = []): RemoteDocs => {
  const logDocs = new Map<string, Record<string, unknown>>();
  for (const l of d.doseLogs) {
    const id = logDocId(l);
    logDocs.set(id, { ...(logDocs.get(id) ?? {}), [l.id]: l });
  }
  return {
    meds: d.medications.map((m) => ({ id: m.id, med: m })),
    tombstones,
    logDocs: [...logDocs].map(([id, logs]) => ({ id, logs })),
  };
};

const sync = (remote: RemoteDocs, local: AppData, queued: OpRef[] = [], failed = { meds: [] as string[], logs: [] as string[] }) =>
  reconcile({ remote: remoteToAppData(remote), local, queued, failed, cutoff: Date.parse('2025-06-01T00:00:00Z') });

const ids = (xs: { id: string }[]) => xs.map((x) => x.id).sort();

describe('diffAppData', () => {
  it('emits only what changed', () => {
    const prev = data([med('a'), med('b')], [log('1')]);
    const next = data([med('a', { dosage: '20 mg' }), med('c')], [log('1'), log('2', { scheduledFor: '2026-03-01T14:00:00.000Z' })]);
    const ops = diffAppData(prev, next);
    expect(ops.map((o) => o.kind + ':' + ('med' in o ? o.med.id : 'log' in o ? o.log.id : o.id)).sort()).toEqual(
      ['deleteMed:b', 'setLog:2', 'setMed:a', 'setMed:c'].sort(),
    );
  });

  it('deleting a medication deletes its logs, each from its own document', () => {
    const prev = data([med('a')], [log('1'), log('2', { scheduledFor: '2026-03-05T14:00:00.000Z' })]);
    const ops = diffAppData(prev, data([], []));
    expect(ops.filter((o) => o.kind === 'deleteLog')).toEqual([
      { kind: 'deleteLog', id: '1', doc: logDocId(log('1')) },
      { kind: 'deleteLog', id: '2', doc: logDocId(log('2', { scheduledFor: '2026-03-05T14:00:00.000Z' })) },
    ]);
    expect(ops.some((o) => o.kind === 'deleteMed')).toBe(true);
  });

  it('no ops for identical data', () => {
    const d = data([med('a')], [log('1')]);
    expect(diffAppData(d, JSON.parse(JSON.stringify(d)))).toEqual([]);
  });
});

describe('remoteToAppData', () => {
  it('validates documents and skips bad ones', () => {
    const r = remoteToAppData({
      meds: [{ id: 'a', med: med('a') }, { id: 'b', med: { id: 1 } }, { id: 'c', med: undefined }],
      tombstones: [],
      logDocs: [{ id: logDocId(log('x')), logs: { x: log('x'), bad: { nope: true } } }],
    });
    expect(ids(r.data.medications)).toEqual(['a']);
    expect(ids(r.data.doseLogs)).toEqual(['x']);
    expect(r.rejected).toBe(3);
    expect([...r.invalidMedIds].sort()).toEqual(['b', 'c']);
  });

  it('collapses two logs for the same dose, newest wins', () => {
    const p = log('p', { status: 'taken' });
    const q = log('q', { status: 'skipped', loggedAt: '2026-02-10T15:00:00.000Z' });
    const r = remoteToAppData(docs(data([med('a')], [p, q])));
    expect(r.data.doseLogs.map((l) => l.status)).toEqual(['skipped']);
    expect(r.duplicateLogs).toEqual([{ id: 'p', doc: logDocId(p) }]);
  });

  it('reports orphans, misfiled logs and tombstones', () => {
    const r = remoteToAppData({
      meds: [{ id: 'a', med: med('a') }, { id: 'z', med: med('z') }],
      tombstones: ['z'],
      logDocs: [{ id: '2026-02', logs: { x: log('x'), y: log('y', { medId: 'gone' }) } }],
    });
    expect(ids(r.data.medications)).toEqual(['a']);
    expect(r.orphanLogs).toEqual([{ id: 'y', doc: '2026-02', medId: 'gone' }]);
    expect(r.misfiled.map((m) => m.id).sort()).toEqual(['x', 'y']);
  });
});

describe('log documents', () => {
  it('are per month and shard, and stable', () => {
    expect(logMonth('2026-02-28T23:30:00.000Z')).toBe('2026-02');
    expect(logMonth('nonsense')).toBe('unknown');
    expect(logDocId(log('1'))).toBe(`2026-02~${logShard('a')}`);
    expect(logShard('a')).toBe(logShard('a'));
    // Spread across shards.
    const shards = new Set(Array.from({ length: 200 }, (_, i) => logShard(`med-${i}`)));
    expect(shards.size).toBeGreaterThan(20);
  });

  it('plain() strips undefined for Firestore', () => {
    expect(plain({ a: 1, b: undefined, c: { d: undefined } })).toEqual({ a: 1, c: {} });
  });
});

describe('queued refs', () => {
  it('collapse repeated edits of one item and resolve to its current local version', () => {
    const v1 = med('a', { dosage: '10 mg' });
    const v2 = med('a', { dosage: '20 mg' });
    const refs = toRefs([{ kind: 'setMed', med: v1 }, { kind: 'setMed', med: v2 }]);
    expect(refs).toEqual([{ kind: 'med', id: 'a', upsert: true }]);
    // An older copy can't win: whatever order the edits were queued in, the latest local copy is sent.
    expect(resolveRefs(refs, data([v2]))).toEqual([{ kind: 'setMed', med: v2 }]);
  });

  it('resolve to deletions for items deleted locally (and for entries of older versions)', () => {
    const refs = toRefs([{ kind: 'deleteMed', id: 'a' }, { kind: 'deleteLog', id: '1', doc: logDocId(log('1')) }]);
    expect(resolveRefs(refs, data([]))).toEqual([
      { kind: 'deleteMed', id: 'a' },
      { kind: 'deleteLog', id: '1', doc: logDocId(log('1')) },
    ]);
    // Older versions queued plain refs: the local copy decides, as before.
    expect(resolveRefs([{ kind: 'med', id: 'b' }], data([]))).toEqual([{ kind: 'deleteMed', id: 'b' }]);
  });

  it('never turn an edit of an item missing locally into a deletion (e.g. the copy was being locked)', () => {
    const refs = toRefs([{ kind: 'setMed', med: med('a') }, { kind: 'setLog', log: log('1') }]);
    expect(resolveRefs(refs, data([]))).toEqual([]);
    // Still present: uploaded as usual.
    expect(resolveRefs(refs, data([med('a')], [log('1')]))).toEqual([
      { kind: 'setMed', med: med('a') },
      { kind: 'setLog', log: log('1') },
    ]);
  });

  it('keep a deletion that follows an edit of the same item', () => {
    const refs = toRefs([{ kind: 'setMed', med: med('a') }, { kind: 'deleteMed', id: 'a' }, { kind: 'setMed', med: med('a') }]);
    expect(refs).toEqual([{ kind: 'med', id: 'a' }]);
    expect(resolveRefs(refs, data([]))).toEqual([{ kind: 'deleteMed', id: 'a' }]);
  });

  it('remove a log from a document it no longer belongs in', () => {
    const moved = log('1', { scheduledFor: '2026-03-01T14:00:00.000Z' });
    const ops = diffAppData(data([med('a')], [log('1')]), data([med('a')], [moved]));
    expect(resolveRefs(toRefs(ops), data([med('a')], [moved]))).toEqual([
      { kind: 'deleteLog', id: '1', doc: logDocId(log('1')) },
      { kind: 'setLog', log: moved },
    ]);
  });

  it('read entries queued by older versions', () => {
    expect(toRefs([{ kind: 'deleteLog', log: { id: '1', scheduledFor: '2026-02-10T14:00:00.000Z' }, month: '2026-02' } as never])).toEqual([
      { kind: 'log', id: '1', doc: '2026-02', del: true },
    ]);
  });

  it('marks deletions with del and preserves del on edit-then-delete', () => {
    const doc = logDocId(log('1'));
    expect(toRefs([{ kind: 'deleteMed', id: 'a' }, { kind: 'deleteLog', id: '1', doc }])).toEqual([
      { kind: 'med', id: 'a', del: true },
      { kind: 'log', id: '1', doc, del: true },
    ]);
    expect(
      toRefs([
        { kind: 'setMed', med: med('a') },
        { kind: 'deleteMed', id: 'a' },
        { kind: 'setLog', log: log('1') },
        { kind: 'deleteLog', id: '1', doc },
      ]),
    ).toEqual([
      { kind: 'med', id: 'a', del: true },
      { kind: 'log', id: '1', doc, del: true },
    ]);
  });
});

describe('mergeRef', () => {
  it('merges queued refs without losing deletions', () => {
    const upsert: OpRef = { kind: 'med', id: 'a', upsert: true };
    const del: OpRef = { kind: 'med', id: 'a', del: true };
    const plainRef: OpRef = { kind: 'med', id: 'a' };

    expect(mergeRef(upsert, del)).toEqual(del);
    expect(mergeRef(del, upsert)).toEqual(plainRef);
    expect(mergeRef(upsert, plainRef)).toEqual(plainRef);
    expect(mergeRef(del, plainRef)).toBe(del);
    expect(mergeRef(upsert, { kind: 'med', id: 'a', upsert: true })).toBe(upsert);
  });
});

describe('applyQueuedDeletions', () => {
  it('removes a deleted med and its dose logs, and a deleted log matching its doc', () => {
    const d = data([med('a'), med('b')], [log('1', { medId: 'a' }), log('2', { medId: 'b' }), log('3', { medId: 'b', scheduledFor: '2026-03-10T14:00:00.000Z' })]);
    const out = applyQueuedDeletions(d, [
      { kind: 'med', id: 'a', del: true },
      { kind: 'log', id: '2', doc: logDocId(log('2', { medId: 'b' })), del: true },
    ]);
    expect(ids(out.medications)).toEqual(['b']);
    expect(ids(out.doseLogs)).toEqual(['3']);
  });

  it('returns data by identity when nothing is removed', () => {
    const d = data([med('a')], [log('1')]);
    expect(applyQueuedDeletions(d, [])).toBe(d);
    expect(applyQueuedDeletions(d, [{ kind: 'med', id: 'missing', del: true }])).toBe(d);
  });

  it('uses the last ref per item and keeps a moved log', () => {
    const oldLog = log('1', { scheduledFor: '2026-02-10T14:00:00.000Z' });
    const movedLog = log('1', { scheduledFor: '2026-03-10T14:00:00.000Z' });
    const d = data([med('a')], [movedLog]);
    const out = applyQueuedDeletions(d, [
      { kind: 'med', id: 'a', del: true },
      { kind: 'med', id: 'a', upsert: true },
      { kind: 'log', id: '1', doc: logDocId(oldLog), del: true },
      { kind: 'log', id: '1', doc: logDocId(movedLog), upsert: true },
    ]);
    expect(out).toBe(d);

    // Even if only the old-doc deletion is queued for a log that moved to a new doc, it stays.
    expect(applyQueuedDeletions(d, [{ kind: 'log', id: '1', doc: logDocId(oldLog), del: true }])).toBe(d);
  });

  it('never deletes for a tidy ref without del', () => {
    const d = data([med('a')], [log('1')]);
    expect(
      applyQueuedDeletions(d, [
        { kind: 'med', id: 'a' },
        { kind: 'log', id: '1', doc: logDocId(log('1')) },
      ]),
    ).toBe(d);
  });
});

describe('reconcile (cloud + this device)', () => {
  it('keeps queued edits when a snapshot predates them', () => {
    const cloud = data([med('a'), med('b')], [log('1')]);
    const renamed = med('a', { name: 'Renamed', updatedAt: '2026-03-01T00:00:00.000Z' });
    const local = data([renamed], [log('1'), log('2', { scheduledFor: '2026-02-11T14:00:00.000Z' })]);
    const r = sync(docs(cloud), local, [
      { kind: 'med', id: 'a' },
      { kind: 'med', id: 'b' },
      { kind: 'log', id: '2', doc: logDocId(log('2', { scheduledFor: '2026-02-11T14:00:00.000Z' })) },
    ]);
    expect(r.shown.medications.map((m) => m.name)).toEqual(['Renamed']); // b: deleted here, pending
    expect(ids(r.shown.doseLogs)).toEqual(['1', '2']);
  });

  it('merges edits of different fields made on two devices', () => {
    const base = stampEdit(undefined, med('a'), '2026-01-01T00:00:00.000Z');
    const here = stampEdit(base, { ...base, dosage: '20 mg' }, '2026-03-01T00:00:00.000Z');
    const there = stampEdit(base, { ...base, notes: 'with food' }, '2026-03-02T00:00:00.000Z');
    const r = sync(docs(data([there])), data([here]));
    expect(r.shown.medications[0]).toMatchObject({ dosage: '20 mg', notes: 'with food' });
    expect(r.uploads).toEqual([{ kind: 'med', id: 'a', upsert: true }]); // the cloud lacks this device's change
    // Both devices end up with the same version.
    const back = sync(docs(data([r.shown.medications[0]!])), data([there]));
    expect(back.shown.medications[0]).toEqual(r.shown.medications[0]);
  });

  it('a medication deleted elsewhere stays deleted, even if edited here offline', () => {
    const edited = med('a', { name: 'Edited offline', updatedAt: '2026-05-01T00:00:00.000Z' });
    const r = sync(docs(data([]), ['a']), data([edited], [log('1')]), [{ kind: 'med', id: 'a' }]);
    expect(r.shown.medications).toEqual([]);
    expect(r.shown.doseLogs).toEqual([]);
    expect(r.uploads).toEqual([]);
  });

  it('a medication only here is kept and uploaded (nothing marked it deleted)', () => {
    const r = sync(docs(data([])), data([med('a')]));
    expect(ids(r.shown.medications)).toEqual(['a']);
    expect(r.uploads).toEqual([{ kind: 'med', id: 'a', upsert: true }]);
  });

  it("an edit queued for a medication missing here doesn't hide the cloud's copy (only a deletion does)", () => {
    const r = sync(docs(data([med('a')])), data([]), [{ kind: 'med', id: 'a', upsert: true }]);
    expect(ids(r.shown.medications)).toEqual(['a']);
    const d = sync(docs(data([med('a')])), data([]), [{ kind: 'med', id: 'a' }]);
    expect(d.shown.medications).toEqual([]);
  });

  it("an edit queued for a dose log missing here doesn't hide the cloud's copy (only a deletion does)", () => {
    const cloud = data([med('a')], [log('1')]);
    const doc = logDocId(log('1'));
    const r = sync(docs(cloud), data([med('a')]), [{ kind: 'log', id: '1', doc, upsert: true }]);
    expect(ids(r.shown.doseLogs)).toEqual(['1']);
    const d = sync(docs(cloud), data([med('a')]), [{ kind: 'log', id: '1', doc, del: true }]);
    expect(d.shown.doseLogs).toEqual([]);
  });

  it('a dose undone on another device goes here too', () => {
    const r = sync(docs(data([med('a')])), data([med('a')], [log('1')]));
    expect(r.shown.doseLogs).toEqual([]);
  });

  it('two devices logging different doses at the same time keep both', () => {
    const mine = log('m', { scheduledFor: '2026-02-10T08:00:00.000Z' });
    const theirs = log('t', { scheduledFor: '2026-02-10T20:00:00.000Z' });
    const r = sync(docs(data([med('a')], [theirs])), data([med('a')], [mine]), [{ kind: 'log', id: 'm', doc: logDocId(mine) }]);
    expect(ids(r.shown.doseLogs)).toEqual(['m', 't']);
  });

  it('the same dose logged on two devices keeps the newer action and removes the other', () => {
    const mine = log('m', { status: 'taken', loggedAt: '2026-02-10T14:05:00.000Z' });
    const theirs = log('t', { status: 'skipped', loggedAt: '2026-02-10T14:02:00.000Z' });
    const r = sync(docs(data([med('a')], [theirs])), data([med('a')], [mine]), [{ kind: 'log', id: 'm', doc: logDocId(mine) }]);
    expect(ids(r.shown.doseLogs)).toEqual(['m']);
    expect(r.removals).toContainEqual({ kind: 'log', id: 't', doc: logDocId(theirs) });
  });

  it("keeps this device's copy of items the cloud has but can't be read here, and doesn't treat their logs as orphans", () => {
    const local = data([med('a'), med('b')], [log('1'), log('2', { medId: 'b' })]);
    const cloud = docs(data([med('a')], [log('1'), log('2', { medId: 'b' })]));
    const r = sync(cloud, local, [], { meds: ['b'], logs: [] });
    expect(ids(r.shown.medications)).toEqual(['a', 'b']);
    expect(ids(r.shown.doseLogs)).toEqual(['1', '2']);
    expect(r.removals).toEqual([]);
    expect(r.uploads).toEqual([]);
  });

  it('drops expired logs and removes them from the cloud', () => {
    const old = log('old', { scheduledFor: '2025-01-01T08:00:00.000Z', loggedAt: '2025-01-01T08:01:00.000Z' });
    const r = sync(docs(data([med('a')], [old, log('1')])), data([med('a')], [log('1')]));
    expect(ids(r.shown.doseLogs)).toEqual(['1']);
    expect(r.removals).toEqual([{ kind: 'log', id: 'old', doc: logDocId(old) }]);
  });

  it('changes nothing when both sides agree (and returns the local arrays)', () => {
    const cloud = data([med('a')], [log('1')]);
    const first = sync(docs(cloud), JSON.parse(JSON.stringify(cloud)));
    const again = sync(docs(cloud), first.shown);
    expect(again.shown.medications).toBe(first.shown.medications);
    expect(again.shown.doseLogs).toBe(first.shown.doseLogs);
    expect(again.uploads).toEqual([]);
    expect(again.removals).toEqual([]);
  });
});

describe('first-time device merge', () => {
  it('uploads only what the cloud is missing', () => {
    const cloud = data([med('a')], [log('1')]);
    const local = data([med('a'), med('b')], [log('1'), log('2', { medId: 'b' })]);
    const merged = mergeAppData(cloud, local);
    const ops = diffAppData(cloud, merged);
    expect(ops.map((o) => o.kind).sort()).toEqual(['setLog', 'setMed']);
  });
});

describe('sign-out flush', () => {
  const check = (over: Partial<FlushCheck> = {}): FlushCheck => ({
    queued: [],
    merged: true,
    localEmpty: false,
    refused: 0,
    needCloud: false,
    cloudLoaded: true,
    online: true,
    lock: 'unlocked',
    deleting: false,
    ...over,
  });
  const queued: OpRef[] = [{ kind: 'med', id: 'a' }];

  it('is done when nothing is queued and the device was merged, even offline or locked', () => {
    expect(flushStep(check())).toEqual({ kind: 'done' });
    expect(flushStep(check({ online: false, lock: 'locked', cloudLoaded: false }))).toEqual({ kind: 'done' });
  });

  it('waits while uploads can go', () => {
    expect(flushStep(check({ queued }))).toEqual({ kind: 'wait' });
    expect(flushStep(check({ lock: 'checking', queued }))).toEqual({ kind: 'wait' });
  });

  it('is blocked when changes are waiting but cannot be uploaded', () => {
    expect(flushStep(check({ queued, online: false }))).toEqual({ kind: 'blocked', reason: 'offline' });
    expect(flushStep(check({ queued, lock: 'locked' }))).toEqual({ kind: 'blocked', reason: 'locked' });
    expect(flushStep(check({ queued, lock: 'needs-setup' }))).toEqual({ kind: 'blocked', reason: 'setup' });
    expect(flushStep(check({ queued, deleting: true }))).toEqual({ kind: 'blocked', reason: 'deleting' });
  });

  it("doesn't count an unmerged device as up to date, unless it has no data", () => {
    expect(flushStep(check({ merged: false, online: false }))).toEqual({ kind: 'blocked', reason: 'offline' });
    expect(flushStep(check({ merged: false, lock: 'needs-setup' }))).toEqual({ kind: 'blocked', reason: 'setup' });
    expect(flushStep(check({ merged: false }))).toEqual({ kind: 'wait' });
    expect(flushStep(check({ merged: false, localEmpty: true, online: false }))).toEqual({ kind: 'done' });
  });

  it('reports changes the cloud refused instead of finishing', () => {
    expect(flushStep(check({ refused: 2 }))).toEqual({ kind: 'blocked', reason: 'refused' });
    expect(flushStep(check({ refused: 2, queued }))).toEqual({ kind: 'wait' }); // the rest goes first
  });

  it('waits for the cloud copy when asked', () => {
    expect(flushStep(check({ needCloud: true, cloudLoaded: false }))).toEqual({ kind: 'wait' });
    expect(flushStep(check({ needCloud: true, cloudLoaded: false, online: false }))).toEqual({ kind: 'blocked', reason: 'offline' });
  });

  it('summarizes what is not in the cloud', () => {
    const local = data([med('a', { name: 'Lisinopril' }), med('b', { name: 'Metformin' })], [log('1'), log('2')]);
    const refs: OpRef[] = [
      { kind: 'med', id: 'b' },
      { kind: 'med', id: 'a' },
      { kind: 'med', id: 'a' },
      { kind: 'med', id: 'gone' },
      { kind: 'log', id: '1', doc: 'x' },
      { kind: 'log', id: '1', doc: 'y' },
      { kind: 'log', id: '3', doc: 'x' },
    ];
    expect(summarizePending({ queued: refs, merged: true, refused: 1 }, local)).toEqual({
      medications: ['Lisinopril', 'Metformin'],
      deletedMedications: 1,
      doseLogs: 2,
      unmerged: undefined,
      refused: 1,
    });
    expect(summarizePending({ queued: [], merged: false, refused: 0 }, local).unmerged).toEqual({ medications: 2, doseLogs: 2 });
    expect(summarizePending({ queued: [], merged: false, refused: 0 }, data([])).unmerged).toBeUndefined();
  });

  it('names nothing while locked (the local copy is not loaded then), only how much is waiting', () => {
    const refs: OpRef[] = [
      { kind: 'med', id: 'a' },
      { kind: 'med', id: 'a' },
      { kind: 'log', id: '1', doc: 'x' },
    ];
    expect(summarizePending({ queued: refs, merged: true, refused: 0 }, data([]), { hidden: true })).toEqual({
      medications: [],
      deletedMedications: 0,
      doseLogs: 0,
      refused: 0,
      hidden: { changes: 2, unmerged: false },
    });
    expect(summarizePending({ queued: [], merged: false, refused: 0 }, data([]), { hidden: true }).hidden).toEqual({
      changes: 0,
      unmerged: true,
    });
    // Locked with nothing queued and never merged: not known to be up to date.
    expect(flushStep(check({ merged: false, localEmpty: false, lock: 'locked' }))).toEqual({ kind: 'blocked', reason: 'locked' });
  });
});

describe('reconcile: dose logs of medications not in the cloud yet, and log uploads (round 4)', () => {
  it("keeps a log of a medication that's here but not in the cloud yet, though the cloud has the log (C1)", () => {
    // The log reached the cloud, its medication's upload hasn't (yet): in the cloud it looks orphaned.
    const cloud = docs(data([], [log('1')]));
    const r = sync(cloud, data([med('a')], [log('1')]));
    expect(ids(r.shown.doseLogs)).toEqual(['1']);
    expect(ids(r.shown.medications)).toEqual(['a']);
    expect(r.uploads).toContainEqual({ kind: 'med', id: 'a', upsert: true });
    // Not removed from the cloud as an orphan either.
    expect(r.removals).toEqual([]);
  });

  it('still drops a log whose medication is gone everywhere, or that duplicates another dose (C1)', () => {
    // Medication deleted elsewhere (tombstone): its logs go.
    const gone = sync(docs(data([], [log('1')]), ['a']), data([med('a')], [log('1')]));
    expect(gone.shown.doseLogs).toEqual([]);
    // A duplicate of a dose the cloud has a newer log for: only one kept.
    const older = log('1', { loggedAt: '2026-02-10T14:01:00.000Z' });
    const newer = log('2', { loggedAt: '2026-02-10T15:00:00.000Z' });
    const dup = sync(docs(data([med('a')], [older, newer])), data([med('a')], [older]));
    expect(ids(dup.shown.doseLogs)).toEqual(['2']);
  });

  it('log uploads are upserts, so a log missing locally later is never taken as deleted (C3)', () => {
    // This device's newer version of a log.
    const there = log('1', { status: 'skipped', loggedAt: '2026-02-10T14:01:00.000Z' });
    const here = log('1', { status: 'taken', loggedAt: '2026-02-10T16:00:00.000Z' });
    const r = sync(docs(data([med('a')], [there])), data([med('a')], [here]));
    expect(r.uploads).toEqual([{ kind: 'log', id: '1', doc: logDocId(here), upsert: true }]);
    // A misfiled log (in the wrong document): moved, the new entry an upsert.
    const l = log('1');
    const misfiled: RemoteDocs = { meds: [{ id: 'a', med: med('a') }], tombstones: [], logDocs: [{ id: 'elsewhere', logs: { '1': l } }] };
    const m = sync(misfiled, data([med('a')], [l]));
    expect(m.uploads).toEqual([{ kind: 'log', id: '1', doc: logDocId(l), upsert: true }]);
    expect(m.removals).toEqual([{ kind: 'log', id: '1', doc: 'elsewhere' }]);
    // Every upload reconcile makes is an upsert.
    for (const u of [...r.uploads, ...m.uploads, ...sync(docs(data([])), data([med('a')])).uploads]) expect(u.upsert).toBe(true);
  });
});
