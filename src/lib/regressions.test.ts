// Regression tests for issues found in QA.
import { describe, expect, it } from 'vitest';
import { makeSchedule, occurrencesOn } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { nextDoseFor } from './doses';
import { mapRxTermsResponse } from './drugLookup';
import { applyLogDose, applyUndoDose } from './store';
import { encryptVault, mergeAppData, VaultError } from './vault';

const med = (over: Partial<Medication> = {}): Medication => ({
  id: 'm1',
  name: 'Lisinopril',
  dosage: '10 mg',
  color: '#0f766e',
  schedule: makeSchedule('daily', '2026-01-01'),
  notificationsEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const log = (over: Partial<DoseLog>): DoseLog => ({
  id: 'l1',
  medId: 'm1',
  scheduledFor: '2026-01-02T14:00:00.000Z',
  status: 'taken',
  loggedAt: '2026-01-02T14:05:00.000Z',
  ...over,
});

describe('mergeAppData dose de-duplication', () => {
  it('keeps one log per scheduled dose, newest action wins', () => {
    const a: AppData = { version: 1, medications: [med()], doseLogs: [log({ id: 'a', status: 'taken', loggedAt: '2026-01-02T14:05:00.000Z' })] };
    const b: AppData = { version: 1, medications: [med()], doseLogs: [log({ id: 'b', status: 'skipped', loggedAt: '2026-01-02T15:00:00.000Z' })] };
    const merged = mergeAppData(a, b);
    expect(merged.doseLogs).toHaveLength(1);
    expect(merged.doseLogs[0].status).toBe('skipped');
    // Older incoming action doesn't override a newer local one.
    expect(mergeAppData(b, a).doseLogs.map((l) => l.status)).toEqual(['skipped']);
  });

  it('keeps distinct doses and unique ids', () => {
    const a: AppData = { version: 1, medications: [med()], doseLogs: [log({ id: 'x' })] };
    const b: AppData = { version: 1, medications: [med()], doseLogs: [log({ id: 'x', scheduledFor: '2026-01-03T14:00:00.000Z' })] };
    const merged = mergeAppData(a, b);
    expect(merged.doseLogs).toHaveLength(2);
    expect(new Set(merged.doseLogs.map((l) => l.id)).size).toBe(2);
  });
});

describe('export validates before encrypting', () => {
  it('rejects data that import would reject', async () => {
    const data: AppData = { version: 1, medications: [med({ notes: 'x'.repeat(5001) })], doseLogs: [] };
    await expect(encryptVault(data, 'correct-horse-battery-staple')).rejects.toBeInstanceOf(VaultError);
  });
});

describe('supply on hand', () => {
  const data = (supply: number, qty = 1): AppData => ({
    version: 1,
    medications: [med({ supplyRemaining: supply, quantityPerDose: qty })],
    doseLogs: [],
  });
  const at = '2026-01-02T14:00:00.000Z';
  const supplyOf = (d: AppData) => d.medications[0].supplyRemaining;

  it('undo after taking with zero supply does not inflate it', () => {
    const taken = applyLogDose(data(0), 'm1', at, 'taken');
    expect(supplyOf(taken)).toBe(0);
    expect(supplyOf(applyUndoDose(taken, 'm1', at))).toBe(0);
    expect(supplyOf(applyLogDose(taken, 'm1', at, 'skipped'))).toBe(0);
  });

  it('restores only what was deducted when supply was short', () => {
    const taken = applyLogDose(data(1, 2), 'm1', at, 'taken');
    expect(supplyOf(taken)).toBe(0);
    expect(supplyOf(applyUndoDose(taken, 'm1', at))).toBe(1);
  });

  it('take, skip, take round-trips', () => {
    let d = applyLogDose(data(10, 2), 'm1', at, 'taken');
    expect(supplyOf(d)).toBe(8);
    d = applyLogDose(d, 'm1', at, 'skipped');
    expect(supplyOf(d)).toBe(10);
    d = applyLogDose(d, 'm1', at, 'taken');
    expect(supplyOf(d)).toBe(8);
    expect(d.doseLogs).toHaveLength(1);
  });
});

describe('next dose skips logged doses', () => {
  it('advances past a dose taken early', () => {
    const m = med({ schedule: makeSchedule('daily', '2026-01-01') });
    const now = new Date(2026, 0, 5, 8, 0); // 1h before today's 9:00 dose ("upcoming")
    const todays = new Date(2026, 0, 5, 9, 0);
    expect(nextDoseFor(m, [], now)?.at.getTime()).toBe(todays.getTime());
    const logs = [log({ scheduledFor: todays.toISOString() })];
    expect(nextDoseFor(m, logs, now)?.at.getDate()).toBe(6);
  });
});

describe('DST spring-forward', () => {
  it('never emits the same instant twice', () => {
    const s = { ...makeSchedule('daily', '2026-01-01'), useSpecificTimes: true, times: ['02:30', '03:30'] };
    // Covers the US spring-forward day; in zones without DST this is just two normal doses.
    const occ = occurrencesOn(s, new Date(2026, 2, 8)).map((d) => d.getTime());
    expect(new Set(occ).size).toBe(occ.length);
  });
});

describe('mapRxTermsResponse alignment', () => {
  it('pairs names and strengths by original index even with junk entries', () => {
    const out = mapRxTermsResponse([
      2,
      [null, 'Aspirin (Oral Pill)'],
      { STRENGTHS_AND_FORMS: [[], ['325 mg Tab']], RXCUIS: [[], ['315431']] },
      [],
    ]);
    expect(out).toEqual([{ name: 'Aspirin', route: 'Oral Pill', strengths: [{ label: '325 mg Tab', rxcui: '315431' }] }]);
  });
});
