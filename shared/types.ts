// Shared data contracts for the client and (where noted) the push server.

export type FrequencyPreset = 'daily' | 'twice_daily' | 'every_other_day' | 'custom';

/** Unit for a custom repeat rule. */
export type RepeatUnit = 'day' | 'week';

export interface Schedule {
  preset: FrequencyPreset;
  /**
   * When false, the preset's default times are used (see DEFAULT_TIMES).
   * When true, `times` holds the user's chosen times.
   */
  useSpecificTimes: boolean;
  /** Dose times in 24h local "HH:MM", sorted ascending. Always populated. */
  times: string[];
  /** Custom only: repeat every `interval` units (>= 1). */
  interval?: number;
  /** Custom only. */
  unit?: RepeatUnit;
  /** Custom + unit 'week' only: weekdays 0 (Sun) .. 6 (Sat). */
  weekdays?: number[];
  /** First day of the schedule, local "YYYY-MM-DD". Anchors every-N-day/week rules. */
  startDate: string;
  /** Optional last day (inclusive), local "YYYY-MM-DD". */
  endDate?: string;
}

export interface Medication {
  id: string;
  name: string;
  /** Dose strength, e.g. "10 mg". */
  dosage: string;
  /** Dosage form, e.g. "Tablet", "Capsule". */
  form?: string;
  /** Units taken per dose, e.g. 1 tablet. */
  quantityPerDose?: number;
  /** e.g. "Take with food". */
  instructions?: string;
  prescriber?: string;
  pharmacy?: string;
  /** Local "YYYY-MM-DD". */
  refillDate?: string;
  /**
   * Units on hand when last counted (at `supplyCountedAt`). What's on hand now is this minus what
   * doses marked taken since then deducted: see supplyOnHand() in src/lib/supply.ts. Without
   * `supplyCountedAt` (older versions) it's already the current count.
   */
  supplyRemaining?: number;
  /** ISO timestamp `supplyRemaining` was counted at. */
  supplyCountedAt?: string;
  notes?: string;
  /** Accent colour for the tile (hex). */
  color: string;
  schedule: Schedule;
  notificationsEnabled: boolean;
  /** Info auto-filled from public drug databases (RxNorm / openFDA). */
  drugInfo?: DrugInfo;
  createdAt: string;
  updatedAt: string;
  /** When each field (group) last changed, so edits on different devices merge per field. */
  fieldTimes?: Partial<Record<string, string>>;
}

export interface DrugInfo {
  rxcui?: string;
  genericName?: string;
  brandNames: string[];
  drugClasses: string[];
  /** Short plain-language purpose, e.g. "Treats high blood pressure". */
  purpose?: string;
  indications?: string;
  dosageAndAdministration?: string;
  warnings?: string;
  boxedWarning?: string;
  sideEffects?: string;
  interactions?: string;
  /** Links to source pages for the user to read more. */
  sources: { label: string; url: string }[];
  fetchedAt: string;
}

export type DoseStatus = 'taken' | 'skipped';

export interface DoseLog {
  id: string;
  medId: string;
  /** ISO timestamp of the scheduled occurrence this log refers to. */
  scheduledFor: string;
  status: DoseStatus;
  /** ISO timestamp the user acted on it. */
  loggedAt: string;
  /** Units this dose removes from supply while it's marked taken. */
  supplyDeducted?: number;
}

export interface AppData {
  version: 1;
  medications: Medication[];
  doseLogs: DoseLog[];
}

/** A reminder the client asks the push server to deliver. Shared with server. */
export interface PushReminder {
  /** Stable id: `${medId}@${epochMs}`. */
  id: string;
  medId: string;
  /** Epoch ms (UTC) when the notification should be shown. */
  at: number;
  title: string;
  body: string;
}
