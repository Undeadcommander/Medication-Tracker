// Edits replace, append or remove a few items and keep every other item (the same object, in the
// same order). So two versions of a list can be compared by skipping the identical start and end,
// leaving just the part that changed: with a year of dose history, this keeps a tap from walking
// hundreds of thousands of items through maps and JSON.

/** The part of `b` that differs from `a` (by identity), after skipping their common start and end. */
export function changedMiddle<T>(a: readonly T[], b: readonly T[]): { removed: T[]; added: T[] } {
  if (a === b) return { removed: [], added: [] };
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  let ea = a.length - 1;
  let eb = b.length - 1;
  while (ea >= i && eb >= i && a[ea] === b[eb]) {
    ea--;
    eb--;
  }
  return { removed: a.slice(i, ea + 1), added: b.slice(i, eb + 1) };
}

/**
 * Items of `next` that are new or changed compared with `prev`, and ids that are gone. Items are
 * compared by identity first, then by content.
 */
export function diffById<T extends { id: string }>(
  prev: readonly T[],
  next: readonly T[],
): { put: T[]; del: T[]; /** Previous versions of changed and removed items. */ prior: Map<string, T> } {
  const { removed, added } = changedMiddle(prev, next);
  const prior = new Map(removed.map((x) => [x.id, x]));
  if (!removed.length && !added.length) return { put: [], del: [], prior };
  const before = new Map(prior);
  const put: T[] = [];
  for (const x of added) {
    const b = before.get(x.id);
    before.delete(x.id);
    if (b !== x && (!b || JSON.stringify(b) !== JSON.stringify(x))) put.push(x);
  }
  return { put, del: [...before.values()], prior };
}
