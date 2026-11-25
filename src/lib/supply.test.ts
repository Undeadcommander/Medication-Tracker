import { describe, expect, it } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { DoseLog, Medication } from '../../shared/types';
import { mergeMed, stampEdit, supplyOnHand } from './supply';

const med = (over: Partial<Medication> = {}): Medication => ({
  id: 'a',
  name: 'Med',
  dosage: '10 mg',
  color: '#0f766e',
  schedule: makeSchedule('daily', '2026-01-01'),
  notificationsEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});
const log = (id: string, loggedAt: string, over: Partial<DoseLog> = {}): DoseLog => ({
  id,
  medId: 'a',
  scheduledFor: loggedAt,
  status: 'taken',
  loggedAt,
  ...over,
});

describe('supplyOnHand', () => {
  it('is the count minus doses taken since it was counted', () => {
    const m = med({ supplyRemaining: 30, supplyCountedAt: '2026-02-01T00:00:00.000Z', quantityPerDose: 2 });
    const logs = [
      log('before', '2026-01-31T08:00:00.000Z'), // already reflected in the count
      log('1', '2026-02-01T08:00:00.000Z'),
      log('2', '2026-02-02T08:00:00.000Z', { supplyDeducted: 1 }), // dose size at the time
      log('s', '2026-02-03T08:00:00.000Z', { status: 'skipped' }),
      log('other', '2026-02-03T08:00:00.000Z', { medId: 'b' }),
    ];
    expect(supplyOnHand(m, logs)).toBe(27);
  });

  it('never goes below zero, and is undefined when not tracked', () => {
    const m = med({ supplyRemaining: 1, supplyCountedAt: '2026-02-01T00:00:00.000Z' });
    expect(supplyOnHand(m, [log('1', '2026-02-02T00:00:00.000Z'), log('2', '2026-02-03T00:00:00.000Z')])).toBe(0);
    expect(supplyOnHand(med(), [])).toBeUndefined();
  });

  it('uses an older version’s running count as is', () => {
    expect(supplyOnHand(med({ supplyRemaining: 12 }), [log('1', '2026-02-02T00:00:00.000Z')])).toBe(12);
  });
});

describe('mergeMed', () => {
  const base = stampEdit(undefined, med(), '2026-01-01T00:00:00.000Z');

  it('takes the newer change of each field', () => {
    const a = stampEdit(base, { ...base, name: 'Renamed' }, '2026-03-01T00:00:00.000Z');
    const b = stampEdit(base, { ...base, dosage: '20 mg', supplyRemaining: 5, supplyCountedAt: '2026-03-02T00:00:00.000Z' }, '2026-03-02T00:00:00.000Z');
    const m = mergeMed(a, b);
    expect(m).toMatchObject({ name: 'Renamed', dosage: '20 mg', supplyRemaining: 5, updatedAt: '2026-03-02T00:00:00.000Z' });
    expect(mergeMed(b, a)).toEqual(m); // same result whichever side merges
  });

  it('the same field changed on both: the newer wins', () => {
    const a = stampEdit(base, { ...base, name: 'Old idea' }, '2026-03-01T00:00:00.000Z');
    const b = stampEdit(base, { ...base, name: 'New idea' }, '2026-03-05T00:00:00.000Z');
    expect(mergeMed(a, b).name).toBe('New idea');
    expect(mergeMed(b, a).name).toBe('New idea');
  });

  it('returns one of its inputs when nothing differs (the second when both match)', () => {
    const a = stampEdit(base, { ...base, name: 'X' }, '2026-03-01T00:00:00.000Z');
    const copy = JSON.parse(JSON.stringify(a));
    expect(mergeMed(a, copy)).toBe(copy);
    const older = base;
    expect(mergeMed(a, older)).toBe(a);
  });

  it('stampEdit only moves the times of fields that changed', () => {
    const a = stampEdit(base, { ...base, notes: 'n' }, '2026-04-01T00:00:00.000Z');
    expect(a.fieldTimes?.notes).toBe('2026-04-01T00:00:00.000Z');
    expect(a.fieldTimes?.name).toBe('2026-01-01T00:00:00.000Z');
  });
});
