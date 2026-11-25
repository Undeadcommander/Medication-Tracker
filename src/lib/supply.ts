// Supply on hand and per-field medication history.
//
// Supply isn't a running counter stored on the medication (two devices logging doses at once would
// overwrite each other's count). The medication keeps the last count the user entered
// (`supplyRemaining`, as of `supplyCountedAt`); what's on hand now is that count minus what the
// doses marked taken since then deducted. Logging or undoing a dose only changes the dose log.
//
// Medication edits record when each field last changed (`fieldTimes`), so edits of different
// fields on two devices merge instead of one overwriting the other.
import type { DoseLog, Medication } from '../../shared/types';
import { changedMiddle } from './arrayDiff';

const byMedCache = new WeakMap<DoseLog[], Map<string, DoseLog[]>>();
/** The last grouping built, to derive the next one from (an edit changes a few logs). */
let lastGrouping: { logs: DoseLog[]; byMed: Map<string, DoseLog[]> } | null = null;

function groupAll(logs: DoseLog[]): Map<string, DoseLog[]> {
  const m = new Map<string, DoseLog[]>();
  for (const l of logs) {
    const list = m.get(l.medId);
    if (list) list.push(l);
    else m.set(l.medId, [l]);
  }
  return m;
}

/**
 * The previous grouping with just the changed logs updated. Medications whose logs didn't change
 * keep the same array, so everything memoized per medication (tiles, indexes, supply) stays valid.
 */
function regroup(prev: { logs: DoseLog[]; byMed: Map<string, DoseLog[]> }, logs: DoseLog[]): Map<string, DoseLog[]> | null {
  const { removed, added } = changedMiddle(prev.logs, logs);
  if (removed.length + added.length > 5000) return null;
  const gone = new Set(removed);
  const addedBy = new Map<string, DoseLog[]>();
  for (const l of added) {
    const list = addedBy.get(l.medId);
    if (list) list.push(l);
    else addedBy.set(l.medId, [l]);
  }
  const touched = new Set([...removed.map((l) => l.medId), ...addedBy.keys()]);
  const m = new Map(prev.byMed);
  for (const medId of touched) {
    const kept = (prev.byMed.get(medId) ?? []).filter((l) => !gone.has(l));
    const next = kept.concat(addedBy.get(medId) ?? []);
    if (next.length) m.set(medId, next);
    else m.delete(medId);
  }
  return m;
}

/** Dose logs grouped by medication (once per log array, derived from the previous one when it can be). */
export function logsByMed(logs: DoseLog[]): Map<string, DoseLog[]> {
  let m = byMedCache.get(logs);
  if (!m) {
    m = (lastGrouping && regroup(lastGrouping, logs)) || groupAll(logs);
    byMedCache.set(logs, m);
    // Only everyone's logs are a base for the next grouping (not one medication's, also grouped
    // here when a caller passes just those).
    if (m.size > 1) lastGrouping = { logs, byMed: m };
  }
  return m;
}

/** Units one "taken" dose removes from supply. */
export function unitsPerDose(med: Medication): number {
  return med.quantityPerDose ?? 1;
}

const onHandMemo = new WeakMap<Medication, { logs: DoseLog[]; value: number }>();
const NO_LOGS: DoseLog[] = [];

/** Units on hand now, or undefined if supply isn't tracked for this medication. */
export function supplyOnHand(med: Medication, logs: DoseLog[]): number | undefined {
  if (typeof med.supplyRemaining !== 'number') return undefined;
  // Counted by an older version, which deducted doses from the count itself.
  if (!med.supplyCountedAt) return med.supplyRemaining;
  const own = logsByMed(logs).get(med.id) ?? NO_LOGS;
  const memo = onHandMemo.get(med);
  if (memo && memo.logs === own) return memo.value;
  const value = countOnHand(med, own, med.supplyRemaining, med.supplyCountedAt);
  onHandMemo.set(med, { logs: own, value });
  return value;
}

function countOnHand(med: Medication, own: DoseLog[], counted: number, countedAt: string): number {
  const since = Date.parse(countedAt);
  let used = 0;
  for (const l of own) {
    if (l.status === 'taken' && Date.parse(l.loggedAt) > since) used += l.supplyDeducted ?? unitsPerDose(med);
  }
  const left = counted - used;
  return left > 0 ? Math.round(left * 1000) / 1000 : 0;
}

// ---------------------------------------------------------------------------------------------
// Per-field history
// ---------------------------------------------------------------------------------------------

/** Fields merged independently. `supply` covers supplyRemaining + supplyCountedAt together. */
export const MED_FIELD_GROUPS = {
  name: ['name'],
  dosage: ['dosage'],
  form: ['form'],
  quantityPerDose: ['quantityPerDose'],
  instructions: ['instructions'],
  prescriber: ['prescriber'],
  pharmacy: ['pharmacy'],
  refillDate: ['refillDate'],
  supply: ['supplyRemaining', 'supplyCountedAt'],
  notes: ['notes'],
  color: ['color'],
  schedule: ['schedule'],
  notificationsEnabled: ['notificationsEnabled'],
  drugInfo: ['drugInfo'],
} as const satisfies Record<string, readonly (keyof Medication)[]>;

export type MedFieldGroup = keyof typeof MED_FIELD_GROUPS;
const GROUPS = Object.keys(MED_FIELD_GROUPS) as MedFieldGroup[];

const groupValue = (m: Medication, g: MedFieldGroup) => JSON.stringify(MED_FIELD_GROUPS[g].map((k) => m[k] ?? null));

/** When a field group last changed (medications from older versions only have `updatedAt`). */
export function fieldTime(m: Medication, g: MedFieldGroup): string {
  return m.fieldTimes?.[g] ?? m.updatedAt;
}

/**
 * A medication as edited at `now`: fields that differ from `prev` get `now` as their time.
 * `prev` is undefined for a new medication.
 */
export function stampEdit(prev: Medication | undefined, next: Medication, now = new Date().toISOString()): Medication {
  const fieldTimes: Partial<Record<MedFieldGroup, string>> = {};
  for (const g of GROUPS) {
    fieldTimes[g] = !prev || groupValue(prev, g) !== groupValue(next, g) ? now : fieldTime(prev, g);
  }
  return { ...next, updatedAt: now, fieldTimes };
}

const later = (a: string, b: string) => (Date.parse(a) >= Date.parse(b) ? a : b);

/**
 * Two versions of one medication combined field by field: the more recent change of each field
 * wins (ties go to the larger value, so every device picks the same). Returns `b` or `a` itself
 * when the result equals it.
 */
export function mergeMed(a: Medication, b: Medication): Medication {
  if (a === b) return a;
  const out: Record<string, unknown> = { id: a.id, createdAt: Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a.createdAt : b.createdAt };
  const fieldTimes: Partial<Record<MedFieldGroup, string>> = {};
  let fromA = true;
  let fromB = true;
  for (const g of GROUPS) {
    const ta = fieldTime(a, g);
    const tb = fieldTime(b, g);
    const pa = Date.parse(ta);
    const pb = Date.parse(tb);
    let pick: Medication;
    if (pa !== pb) pick = pa > pb ? a : b;
    else pick = groupValue(a, g) >= groupValue(b, g) ? a : b;
    if (groupValue(pick, g) !== groupValue(a, g)) fromA = false;
    if (groupValue(pick, g) !== groupValue(b, g)) fromB = false;
    for (const k of MED_FIELD_GROUPS[g]) if (pick[k] !== undefined) out[k] = pick[k];
    fieldTimes[g] = pa === pb ? ta : pick === a ? ta : tb;
  }
  out.updatedAt = later(a.updatedAt, b.updatedAt);
  out.fieldTimes = fieldTimes;
  const merged = out as unknown as Medication;
  // (A medication without fieldTimes has every field at its updatedAt.)
  const sameMeta = (m: Medication) =>
    m.updatedAt === merged.updatedAt && m.createdAt === merged.createdAt && GROUPS.every((g) => fieldTime(m, g) === fieldTimes[g]);
  // Equal to both: return `b` (the cloud copy, when merging local with cloud), so the local copy
  // takes on its identity and later comparisons are a quick identity check.
  if (fromB && sameMeta(b)) return b;
  if (fromA && sameMeta(a)) return a;
  return merged;
}
