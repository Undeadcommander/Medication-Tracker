import { describe, expect, it } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { stampEdit } from './supply';
import {
  diffAppData,
  logDocId,
  logMonth,
  logShard,
  plain,
  reconcile,
  remoteToAppData,
  resolveRefs,
  toRefs,
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
    expect(refs).toEqual([{ kind: 'med', id: 'a' }]);
    // An older copy can't win: whatever order the edits were queued in, the latest local copy is sent.
    expect(resolveRefs(refs, data([v2]))).toEqual([{ kind: 'setMed', med: v2 }]);
  });

  it('resolve to deletions for items no longer stored locally', () => {
    const refs = toRefs([{ kind: 'setMed', med: med('a') }, { kind: 'setLog', log: log('1') }]);
    expect(resolveRefs(refs, data([]))).toEqual([
      { kind: 'deleteMed', id: 'a' },
      { kind: 'deleteLog', id: '1', doc: logDocId(log('1')) },
    ]);
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
      { kind: 'log', id: '1', doc: '2026-02' },
    ]);
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
    expect(r.uploads).toEqual([{ kind: 'med', id: 'a' }]); // the cloud lacks this device's change
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
    expect(r.uploads).toEqual([{ kind: 'med', id: 'a' }]);
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
