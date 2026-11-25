// Schedule engine. Everything runs in the device's local time zone.
import type { FrequencyPreset, Schedule } from './types';

export const DEFAULT_TIMES: Record<FrequencyPreset, string[]> = {
  daily: ['09:00'],
  twice_daily: ['09:00', '21:00'],
  every_other_day: ['09:00'],
  custom: ['09:00'],
};

export const PRESET_LABELS: Record<FrequencyPreset, string> = {
  daily: 'Every day',
  twice_daily: 'Twice a day',
  every_other_day: 'Every other day',
  custom: 'Custom',
};

export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DAY_MS = 86_400_000;

/** Local "YYYY-MM-DD" for a date. */
export function toDateKey(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Parse local "YYYY-MM-DD" to a Date at local midnight. */
export function fromDateKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

/** Whole calendar days between two local dates (DST-safe). */
export function daysBetween(a: Date, b: Date): number {
  const ua = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate());
  const ub = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate());
  return Math.round((ub - ua) / DAY_MS);
}

export function normalizeTimes(times: string[]): string[] {
  const valid = times.filter((t) => /^([01]\d|2[0-3]):[0-5]\d$/.test(t));
  return [...new Set(valid)].sort();
}

/** Times actually used for dosing (defaults unless the user picked specific ones). */
export function effectiveTimes(s: Schedule): string[] {
  const times = s.useSpecificTimes ? normalizeTimes(s.times) : DEFAULT_TIMES[s.preset];
  return times.length ? times : DEFAULT_TIMES[s.preset];
}

export function makeSchedule(preset: FrequencyPreset, startDate = toDateKey(new Date())): Schedule {
  return {
    preset,
    useSpecificTimes: false,
    times: [...DEFAULT_TIMES[preset]],
    interval: preset === 'custom' ? 1 : undefined,
    unit: preset === 'custom' ? 'week' : undefined,
    weekdays: preset === 'custom' ? [1, 2, 3, 4, 5] : undefined,
    startDate,
  };
}

/** Does this schedule have doses on the given local day? */
export function isDueOn(s: Schedule, day: Date): boolean {
  const start = fromDateKey(s.startDate);
  const offset = daysBetween(start, day);
  if (offset < 0) return false;
  if (s.endDate && daysBetween(day, fromDateKey(s.endDate)) < 0) return false;

  switch (s.preset) {
    case 'daily':
    case 'twice_daily':
      return true;
    case 'every_other_day':
      return offset % 2 === 0;
    case 'custom': {
      const interval = Math.max(1, Math.floor(s.interval ?? 1));
      if ((s.unit ?? 'day') === 'day') return offset % interval === 0;
      const weekdays = s.weekdays?.length ? s.weekdays : [start.getDay()];
      if (!weekdays.includes(day.getDay())) return false;
      // Week index counted from the Sunday-starting week that contains startDate.
      const startWeekSunday = new Date(start.getFullYear(), start.getMonth(), start.getDate() - start.getDay());
      const weekIndex = Math.floor(daysBetween(startWeekSunday, day) / 7);
      return weekIndex % interval === 0;
    }
  }
}

function atTime(day: Date, hhmm: string): Date {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m, 0, 0);
}

/** A due day's dose instants, ascending and unique. */
function dayOccurrences(day: Date, times: string[]): Date[] {
  const occs = times.map((t) => atTime(day, t));
  // On a DST spring-forward day a skipped time (e.g. 02:30) rolls forward (to 03:30), which can
  // put it after a later time (03:00) or onto one (03:30): re-sort and never emit an instant twice.
  occs.sort((a, b) => a.getTime() - b.getTime());
  return occs.filter((o, i) => i === 0 || o.getTime() !== occs[i - 1].getTime());
}

/** All dose occurrences with from <= t < to, ascending. */
export function occurrencesBetween(s: Schedule, from: Date, to: Date): Date[] {
  const out: Date[] = [];
  const times = effectiveTimes(s);
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  // Guard against runaway loops on huge ranges.
  for (let i = 0; day < to && i < 3700; i++) {
    if (isDueOn(s, day)) {
      for (const occ of dayOccurrences(day, times)) if (occ >= from && occ < to) out.push(occ);
    }
    day.setDate(day.getDate() + 1);
  }
  return out;
}

/** Occurrences on a single local day. */
export function occurrencesOn(s: Schedule, day: Date): Date[] {
  const start = new Date(day.getFullYear(), day.getMonth(), day.getDate());
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return occurrencesBetween(s, start, end);
}

/** Next occurrence strictly after `after`, searching up to ~1 year ahead. */
export function nextOccurrence(s: Schedule, after: Date = new Date()): Date | null {
  const from = new Date(after.getTime() + 1);
  if (s.endDate && daysBetween(from, fromDateKey(s.endDate)) < 0) return null; // already ended
  const times = effectiveTimes(s);
  // Walk day by day and stop at the first hit, instead of building a year of occurrences
  // (this runs for every medication tile on every 30s tick, up to 64 times per tile).
  const day = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  for (let i = 0; i <= 370; i++) {
    if (isDueOn(s, day)) {
      const hit = dayOccurrences(day, times).find((occ) => occ >= from);
      if (hit) return hit;
    }
    day.setDate(day.getDate() + 1);
  }
  return null;
}

export function formatTime12(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${suffix}`;
}

/** Human-readable description, e.g. "Every 2 weeks on Mon, Wed at 9:00 AM". */
export function describeSchedule(s: Schedule): string {
  const times = effectiveTimes(s).map(formatTime12).join(', ');
  let base: string;
  switch (s.preset) {
    case 'daily':
      base = 'Every day';
      break;
    case 'twice_daily':
      base = 'Twice a day';
      break;
    case 'every_other_day':
      base = 'Every other day';
      break;
    case 'custom': {
      const n = Math.max(1, Math.floor(s.interval ?? 1));
      if ((s.unit ?? 'day') === 'day') {
        base = n === 1 ? 'Every day' : `Every ${n} days`;
      } else {
        const days = (s.weekdays?.length ? [...s.weekdays].sort() : [fromDateKey(s.startDate).getDay()])
          .map((d) => WEEKDAY_SHORT[d])
          .join(', ');
        const every = n === 1 ? 'Every week' : `Every ${n} weeks`;
        base = days.split(', ').length === 7 && n === 1 ? 'Every day' : `${every} on ${days}`;
      }
      break;
    }
  }
  return `${base} at ${times}`;
}
