import { describe, expect, it } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { supplyDaysLeft } from './doses';
import { applyLogDose, applyUndoDose } from './store';
import { supplyOnHand } from './supply';

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
const at = '2026-01-02T14:00:00.000Z';
const takenLog = (over: Partial<DoseLog> = {}): DoseLog => ({
  id: 'l1',
  medId: 'a',
  scheduledFor: at,
  status: 'taken',
  loggedAt: '2026-01-02T14:05:00.000Z',
  ...over,
});
const supplyOf = (d: AppData) => supplyOnHand(d.medications[0]!, d.doseLogs);

describe('supplyOnHand with an older version’s count', () => {
  it('shows none on hand for a negative or NaN count, and the count when positive', () => {
    expect(supplyOnHand(med({ supplyRemaining: -4 }), [])).toBe(0);
    expect(supplyOnHand(med({ supplyRemaining: 0 }), [])).toBe(0);
    expect(supplyOnHand(med({ supplyRemaining: Number.NaN }), [])).toBe(0);
    expect(supplyOnHand(med({ supplyRemaining: 7 }), [])).toBe(7);
  });
});

describe('countedFromNow (through applyUndoDose / applyLogDose)', () => {
  const negative = (): AppData => ({
    version: 1,
    medications: [med({ supplyRemaining: -3, quantityPerDose: 2 })],
    doseLogs: [takenLog({ supplyDeducted: 2 })],
  });

  it('undoing a take on a negative old count restores just what that dose deducted', () => {
    const undone = applyUndoDose(negative(), 'a', at);
    expect(undone.doseLogs).toHaveLength(0);
    expect(undone.medications[0]!.supplyRemaining).toBe(2);
    expect(undone.medications[0]!.supplyCountedAt).toBeTruthy();
    expect(supplyOf(undone)).toBe(2);
  });

  it('a new take on a negative old count starts from zero and stays at zero', () => {
    const d: AppData = { version: 1, medications: [med({ supplyRemaining: -3 })], doseLogs: [] };
    const taken = applyLogDose(d, 'a', at, 'taken');
    expect(taken.medications[0]!.supplyRemaining).toBe(0);
    expect(supplyOf(taken)).toBe(0);
  });

  it('a positive old count is unchanged by the clamp', () => {
    const d: AppData = {
      version: 1,
      medications: [med({ supplyRemaining: 5, quantityPerDose: 2 })],
      doseLogs: [takenLog({ supplyDeducted: 2 })],
    };
    expect(supplyOf(applyUndoDose(d, 'a', at))).toBe(7);
  });
});

describe('supplyDaysLeft', () => {
  const now = new Date('2026-03-01T08:00:00');
  it('is null for non-finite on hand or undefined', () => {
    expect(supplyDaysLeft(med(), Number.NaN, now)).toBeNull();
    expect(supplyDaysLeft(med(), Infinity, now)).toBeNull();
    expect(supplyDaysLeft(med(), undefined, now)).toBeNull();
  });
  it('is 0 when nothing (or a negative amount) is on hand', () => {
    expect(supplyDaysLeft(med(), 0, now)).toBe(0);
    expect(supplyDaysLeft(med(), -5, now)).toBe(0);
  });
  it('is null for a zero or negative dose size, never a negative or infinite day count', () => {
    expect(supplyDaysLeft(med({ quantityPerDose: 0 }), 10, now)).toBeNull();
    expect(supplyDaysLeft(med({ quantityPerDose: -1 }), 10, now)).toBeNull();
    expect(supplyDaysLeft(med({ quantityPerDose: -1 }), 0, now)).toBeNull();
  });
  it('counts whole days at the schedule rate', () => {
    expect(supplyDaysLeft(med(), 10, now)).toBe(10);
    expect(supplyDaysLeft(med({ quantityPerDose: 2 }), 10, now)).toBe(5);
  });
});
