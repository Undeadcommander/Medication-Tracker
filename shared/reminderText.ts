// Notification wording and grouping rules shared by the app, the service worker's servers
// (server/index.ts, worker/) and their tests. Reminder text is always discreet: it never names a
// medication, its dose or its instructions.

/** Doses due within this long after the earliest one share a single notification. */
export const GROUP_WINDOW_MS = 10 * 60_000;
/** A group holds at most this many doses (bounds the push payload); more start another group. */
export const MAX_GROUP_DOSES = 20;

/** The id of one scheduled dose (also a single-dose reminder's id). */
export const doseId = (medId: string, at: number): string => `${medId}@${at}`;

/** Discreet notification text for `count` doses. */
export function reminderText(count: number): { title: string; body: string } {
  if (count <= 1) return { title: 'Time for your medication', body: 'Open Dosely to review your dose.' };
  return { title: 'Time for your medications', body: `${count} medications are due. Open Dosely to review them.` };
}
