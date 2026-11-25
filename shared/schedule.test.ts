import { describe, expect, it } from 'vitest';
import {
  describeSchedule,
  effectiveTimes,
  isDueOn,
  makeSchedule,
  nextOccurrence,
  occurrencesBetween,
  occurrencesOn,
} from './schedule';
import type { Schedule } from './types';

const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min);

describe('presets', () => {
  it('daily has one default dose each day', () => {
    const s = makeSchedule('daily', '2026-01-01');
    const occ = occurrencesBetween(s, d(2026, 1, 1), d(2026, 1, 4));
    expect(occ.map((o) => o.getDate())).toEqual([1, 2, 3]);
    expect(occ[0].getHours()).toBe(9);
  });

  it('twice daily has two doses per day', () => {
    const s = makeSchedule('twice_daily', '2026-01-01');
    expect(occurrencesOn(s, d(2026, 1, 5)).map((o) => o.getHours())).toEqual([9, 21]);
  });

  it('every other day alternates from the start date', () => {
    const s = makeSchedule('every_other_day', '2026-01-01');
    const days = occurrencesBetween(s, d(2026, 1, 1), d(2026, 1, 8)).map((o) => o.getDate());
    expect(days).toEqual([1, 3, 5, 7]);
  });

  it('every other day survives month boundaries', () => {
    const s = makeSchedule('every_other_day', '2026-01-30');
    const days = occurrencesBetween(s, d(2026, 1, 30), d(2026, 2, 5)).map((o) => `${o.getMonth() + 1}/${o.getDate()}`);
    expect(days).toEqual(['1/30', '2/1', '2/3']);
  });
});

describe('custom', () => {
  it('every 3 days', () => {
    const s: Schedule = { ...makeSchedule('custom', '2026-03-01'), unit: 'day', interval: 3 };
    const days = occurrencesBetween(s, d(2026, 3, 1), d(2026, 3, 11)).map((o) => o.getDate());
    expect(days).toEqual([1, 4, 7, 10]);
  });

  it('weekly on Mon/Wed/Fri', () => {
    // 2026-03-02 is a Monday
    const s: Schedule = { ...makeSchedule('custom', '2026-03-02'), unit: 'week', interval: 1, weekdays: [1, 3, 5] };
    const days = occurrencesBetween(s, d(2026, 3, 2), d(2026, 3, 9)).map((o) => o.getDate());
    expect(days).toEqual([2, 4, 6]);
  });

  it('every 2 weeks on Tuesday', () => {
    const s: Schedule = { ...makeSchedule('custom', '2026-03-02'), unit: 'week', interval: 2, weekdays: [2] };
    const days = occurrencesBetween(s, d(2026, 3, 1), d(2026, 4, 1)).map((o) => o.getDate());
    expect(days).toEqual([3, 17, 31]);
  });

  it('respects specific times and end date', () => {
    const s: Schedule = {
      ...makeSchedule('custom', '2026-03-01'),
      unit: 'day',
      interval: 1,
      useSpecificTimes: true,
      times: ['22:15', '07:30', '07:30', 'bad'],
      endDate: '2026-03-02',
    };
    expect(effectiveTimes(s)).toEqual(['07:30', '22:15']);
    expect(occurrencesBetween(s, d(2026, 3, 1), d(2026, 3, 10))).toHaveLength(4);
    expect(isDueOn(s, d(2026, 3, 3))).toBe(false);
  });

  it('nothing before start date', () => {
    const s = makeSchedule('daily', '2026-05-10');
    expect(isDueOn(s, d(2026, 5, 9))).toBe(false);
    expect(nextOccurrence(s, d(2026, 5, 1))?.getDate()).toBe(10);
  });
});

describe('nextOccurrence and describe', () => {
  it('next occurrence is strictly after', () => {
    const s = makeSchedule('twice_daily', '2026-01-01');
    expect(nextOccurrence(s, d(2026, 1, 2, 9, 0))?.getHours()).toBe(21);
    expect(nextOccurrence(s, d(2026, 1, 2, 22, 0))?.getDate()).toBe(3);
  });

  it('describes schedules', () => {
    expect(describeSchedule(makeSchedule('twice_daily'))).toBe('Twice a day at 9:00 AM, 9:00 PM');
    const s: Schedule = { ...makeSchedule('custom', '2026-03-02'), unit: 'week', interval: 2, weekdays: [3, 1] };
    expect(describeSchedule(s)).toBe('Every 2 weeks on Mon, Wed at 9:00 AM');
  });
});

describe('DST spring-forward', () => {
  // Run with TZ=America/New_York to exercise the gap; elsewhere these still hold trivially.
  it('keeps every dose, in order, when a time falls in the skipped hour', () => {
    const s: Schedule = { ...makeSchedule('daily', '2026-03-01'), useSpecificTimes: true, times: ['02:30', '03:00'] };
    const occ = occurrencesOn(s, d(2026, 3, 8)).map((o) => o.getTime());
    expect(occ.length).toBeGreaterThanOrEqual(1);
    expect([...occ].sort((a, b) => a - b)).toEqual(occ);
    expect(new Set(occ).size).toBe(occ.length);
    if (new Date(2026, 2, 8, 2, 30).getHours() !== 2) {
      // 02:30 doesn't exist: it rolls forward to 03:30, after the 03:00 dose, which must not be dropped.
      expect(occ).toHaveLength(2);
      expect(new Date(occ[0]).getHours()).toBe(3);
      expect(new Date(occ[0]).getMinutes()).toBe(0);
    }
  });

  it('nextOccurrence matches the first occurrence and stops at the end date', () => {
    const s: Schedule = { ...makeSchedule('twice_daily', '2026-01-01'), endDate: '2026-01-10' };
    const after = d(2026, 1, 3, 12);
    expect(nextOccurrence(s, after)?.getTime()).toBe(occurrencesBetween(s, new Date(after.getTime() + 1), d(2026, 2, 1))[0].getTime());
    expect(nextOccurrence(s, d(2026, 1, 10, 22))).toBeNull();
  });
});
