import { nextOccurrence, occurrencesBetween, occurrencesOn } from '../../shared/schedule';
import type { DoseLog, DoseStatus, Medication } from '../../shared/types';
import { logsByMed } from './supply';

export interface Dose {
  med: Medication;
  at: Date;
  /** ISO key matching DoseLog.scheduledFor. */
  key: string;
  status: DoseStatus | 'due' | 'upcoming' | 'missed';
}

/** A dose is "missed" once it is this far past due without a log. */
const MISSED_AFTER_MS = 4 * 3_600_000;
/** It shows as "due" from this long before its time. */
const DUE_WINDOW_MS = 30 * 60_000;

// Indexes are per medication and built once per array of its logs. Arrays of medications whose
// logs didn't change are reused (see logsByMed), so a tap re-indexes one medication, not all.
const indexCache = new WeakMap<DoseLog[], Map<string, DoseLog>>();
const NO_LOGS: DoseLog[] = [];

/** One medication's logs by scheduled time. */
function medIndex(medLogs: DoseLog[]): Map<string, DoseLog> {
  const cached = indexCache.get(medLogs);
  if (cached) return cached;
  const m = new Map<string, DoseLog>();
  for (const l of medLogs) m.set(l.scheduledFor, l);
  indexCache.set(medLogs, m);
  return m;
}

/** `med`'s logs by scheduled time; `logs` may be everyone's or just this medication's. */
function indexFor(med: Medication, logs: DoseLog[]): Map<string, DoseLog> {
  return medIndex(logsByMed(logs).get(med.id) ?? NO_LOGS);
}

function classify(at: Date, log: DoseLog | undefined, now: Date): Dose['status'] {
  if (log) return log.status;
  const diff = now.getTime() - at.getTime();
  if (diff > MISSED_AFTER_MS) return 'missed';
  if (diff >= -DUE_WINDOW_MS) return 'due';
  return 'upcoming';
}

const byName = new Intl.Collator(undefined, { sensitivity: 'base' });

export function dosesForDay(meds: Medication[], logs: DoseLog[], day: Date, now = new Date()): Dose[] {
  const out: Dose[] = [];
  for (const med of meds) {
    const idx = indexFor(med, logs);
    for (const at of occurrencesOn(med.schedule, day)) {
      const key = at.toISOString();
      out.push({ med, at, key, status: classify(at, idx.get(key), now) });
    }
  }
  return out.sort((a, b) => a.at.getTime() - b.at.getTime() || byName.compare(a.med.name, b.med.name));
}

export function dosesInRange(med: Medication, logs: DoseLog[], from: Date, to: Date, now = new Date()): Dose[] {
  const idx = indexFor(med, logs);
  return occurrencesBetween(med.schedule, from, to).map((at) => {
    const key = at.toISOString();
    return { med, at, key, status: classify(at, idx.get(key), now) };
  });
}

/** The next dose still needing action: an unlogged due dose today, else the next upcoming one. */
export function nextDoseFor(med: Medication, logs: DoseLog[], now = new Date()): Dose | null {
  const today = dosesForDay([med], logs, now, now);
  const pending = today.find((d) => d.status === 'due');
  if (pending) return pending;
  // Skip future doses that were already taken or skipped early.
  const idx = indexFor(med, logs);
  let after = now;
  for (let i = 0; i < 64; i++) {
    const next = nextOccurrence(med.schedule, after);
    if (!next) return null;
    const key = next.toISOString();
    if (!idx.has(key)) return { med, at: next, key, status: classify(next, undefined, now) };
    after = next;
  }
  return null;
}

export interface Adherence {
  taken: number;
  total: number;
  pct: number | null;
}

/** Adherence over the last `days` days (only doses whose time has passed). */
export function adherence(med: Medication, logs: DoseLog[], days = 30, now = new Date()): Adherence {
  const from = new Date(now);
  from.setDate(from.getDate() - days);
  const past = dosesInRange(med, logs, from, now, now).filter((d) => d.status !== 'due' && d.status !== 'upcoming');
  const taken = past.filter((d) => d.status === 'taken').length;
  return { taken, total: past.length, pct: past.length ? Math.round((taken / past.length) * 100) : null };
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const dayFmt = new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' });

export function formatClock(d: Date): string {
  return timeFmt.format(d);
}

export function formatDay(d: Date): string {
  return dayFmt.format(d);
}

/** "in 2 hours", "tomorrow at 9:00 AM", "Mon, Mar 3 at 9:00 AM". */
export function formatWhen(d: Date, now = new Date()): string {
  const diffMin = Math.round((d.getTime() - now.getTime()) / 60_000);
  if (Math.abs(diffMin) < 1) return 'now';
  if (Math.abs(diffMin) < 60) return rtf.format(diffMin, 'minute');
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return `today at ${formatClock(d)}`;
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (d.toDateString() === tomorrow.toDateString()) return `tomorrow at ${formatClock(d)}`;
  return `${formatDay(d)} at ${formatClock(d)}`;
}

/** Days that `onHand` units last at the current schedule rate, or null if unknown. */
export function supplyDaysLeft(med: Medication, onHand: number | undefined, now = new Date()): number | null {
  if (typeof onHand !== 'number') return null;
  const end = new Date(now);
  end.setDate(end.getDate() + 28);
  const per28 = occurrencesBetween(med.schedule, now, end).length * (med.quantityPerDose ?? 1);
  if (!per28) return null;
  return Math.floor(onHand / (per28 / 28));
}
