import { describe, expect, it } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { diffAppData, logMonth, orphanLogs, plain, remoteToAppData } from './syncOps';
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

describe('diffAppData', () => {
  it('emits only what changed', () => {
    const prev = data([med('a'), med('b')], [log('1')]);
    const next = data([med('a', { dosage: '20 mg' }), med('c')], [log('1'), log('2', { scheduledFor: '2026-03-01T14:00:00.000Z' })]);
    const ops = diffAppData(prev, next);
    expect(ops.map((o) => o.kind + ':' + ('med' in o ? o.med.id : 'id' in o ? o.id : o.log.id)).sort()).toEqual(
      ['deleteMed:b', 'setLog:2', 'setMed:a', 'setMed:c'].sort(),
    );
  });

  it('deleting a medication deletes its logs', () => {
    const prev = data([med('a')], [log('1'), log('2', { scheduledFor: '2026-03-05T14:00:00.000Z' })]);
    const next = data([], []);
    const ops = diffAppData(prev, next);
    expect(ops.filter((o) => o.kind === 'deleteLog')).toHaveLength(2);
    expect(ops.some((o) => o.kind === 'deleteMed')).toBe(true);
  });

  it('no ops for identical data', () => {
    const d = data([med('a')], [log('1')]);
    expect(diffAppData(d, JSON.parse(JSON.stringify(d)))).toEqual([]);
  });
});

describe('remoteToAppData', () => {
  it('validates documents and skips bad ones', () => {
    const r = remoteToAppData([{ med: med('a') }, { med: { id: 1 } }, {}], [{ logs: { x: log('x'), bad: { nope: true } } }]);
    expect(r.data.medications.map((m) => m.id)).toEqual(['a']);
    expect(r.data.doseLogs.map((l) => l.id)).toEqual(['x']);
    expect(r.rejected).toBe(3);
  });

  it('collapses two logs for the same dose, newest wins', () => {
    const r = remoteToAppData(
      [{ med: med('a') }],
      [{ logs: { p: log('p', { status: 'taken' }), q: log('q', { status: 'skipped', loggedAt: '2026-02-10T15:00:00.000Z' }) } }],
    );
    expect(r.data.doseLogs.map((l) => l.status)).toEqual(['skipped']);
    expect(r.duplicateLogs.map((l) => l.id)).toEqual(['p']);
  });

  it('drops logs for deleted medications and reports them as orphans', () => {
    const logDocs = [{ logs: { x: log('x', { medId: 'gone' }) } }];
    const r = remoteToAppData([{ med: med('a') }], logDocs);
    expect(r.data.doseLogs).toEqual([]);
    expect(orphanLogs(logDocs, new Set(['a']))).toEqual([{ id: 'x', scheduledFor: '2026-02-10T14:00:00.000Z' }]);
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

describe('helpers', () => {
  it('groups logs by UTC month', () => {
    expect(logMonth('2026-02-28T23:30:00.000Z')).toBe('2026-02');
    expect(logMonth('nonsense')).toBe('unknown');
  });

  it('plain() strips undefined for Firestore', () => {
    expect(plain({ a: 1, b: undefined, c: { d: undefined } })).toEqual({ a: 1, c: {} });
  });
});
