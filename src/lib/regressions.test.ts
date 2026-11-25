// Regression tests for issues found in QA.
import { describe, expect, it, vi } from 'vitest';
import { makeSchedule, occurrencesOn } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { nextDoseFor } from './doses';
import { mapRxTermsResponse } from './drugLookup';
import { applyLogDose, applySaveMedication, applyUndoDose } from './store';
import { supplyOnHand } from './supply';
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
  const supplyOf = (d: AppData) => supplyOnHand(d.medications[0]!, d.doseLogs);

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

  it('logging a dose changes only the dose log (once the count is tracked from logs)', () => {
    const first = applyLogDose(data(10), 'm1', at, 'taken'); // an older count gets a time once
    const counted = first.medications[0]!;
    expect(counted.supplyCountedAt).toBeTruthy();
    const second = applyLogDose(first, 'm1', '2026-01-03T14:00:00.000Z', 'taken');
    expect(second.medications[0]).toBe(counted);
    expect(supplyOf(second)).toBe(8);
  });

  it('doses logged on two devices at once both count', () => {
    const base = applyLogDose(data(30), 'm1', at, 'taken'); // 29
    const phone = applyLogDose(base, 'm1', '2026-01-03T08:00:00.000Z', 'taken');
    const laptop = applyLogDose(base, 'm1', '2026-01-03T20:00:00.000Z', 'taken');
    // What both devices end up with after syncing: the medication unchanged, both logs.
    const synced = mergeAppData(phone, laptop);
    expect(synced.doseLogs).toHaveLength(3);
    expect(supplyOf(synced)).toBe(27);
  });

  it('entering a new count in the form starts counting from it; keeping it shown leaves it alone', () => {
    // Each step a few seconds after the last (they'd otherwise all happen in one millisecond).
    let clock = Date.parse('2026-01-03T09:00:00.000Z');
    vi.useFakeTimers();
    const tick = () => vi.setSystemTime((clock += 5000));
    tick();
    let d = applyLogDose(data(10), 'm1', at, 'taken'); // 9 on hand
    tick();
    const m = d.medications[0]!;
    const same = applySaveMedication(d, { ...m, supplyRemaining: 9, notes: 'x' }, 9);
    expect(same.medications[0]!.supplyRemaining).toBe(m.supplyRemaining);
    expect(supplyOf(same)).toBe(9);
    d = applySaveMedication(d, { ...m, supplyRemaining: 60 }, 9); // refilled
    expect(supplyOf(d)).toBe(60);
    tick();
    d = applyLogDose(d, 'm1', '2026-01-03T14:00:00.000Z', 'taken');
    expect(supplyOf(d)).toBe(59);
    // Toggling something else passes the stored count through unchanged.
    const toggled = applySaveMedication(d, { ...d.medications[0]!, notificationsEnabled: false });
    expect(supplyOf(toggled)).toBe(59);
    vi.useRealTimers();
  });

  it('a refill to the same count as last time counts (the form shows what is on hand, not the old count)', () => {
    let clock = Date.parse('2026-02-01T09:00:00.000Z');
    vi.useFakeTimers();
    const tick = () => vi.setSystemTime((clock += 5000));
    tick();
    let d = applySaveMedication(data(30), { ...data(30).medications[0]!, supplyRemaining: 30 }, 12); // counted 30
    for (let i = 0; i < 5; i++) {
      tick();
      d = applyLogDose(d, 'm1', `2026-02-0${i + 2}T14:00:00.000Z`, 'taken');
    }
    expect(supplyOf(d)).toBe(25);
    tick();
    const shown = supplyOf(d)!; // what the form opens with
    d = applySaveMedication(d, { ...d.medications[0]!, supplyRemaining: 30 }, shown); // refilled to 30
    expect(supplyOf(d)).toBe(30);
    vi.useRealTimers();
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
