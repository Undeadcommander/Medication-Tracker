// Signing out across this browser's open tabs. They share the sign-in and the local data, so when
// one tab signs out and clears the device, the others must stop using the account first: a tab
// still editing or syncing could otherwise add changes after the last upload (lost in the wipe),
// write the cloud copy back into this device's storage, or upload a stale copy.
//
// Every tab showing a Google account holds a shared Web Lock for it. The tab signing out tells
// the others (they stop saving and syncing, close Firestore and let go of the lock) and waits for
// them before its last upload and the wipe. A marker in localStorage keeps tabs opened meanwhile,
// and Firebase's own cross-tab sign-in, from bringing the account back. If the sign-out stops
// there (the last upload failed), the other tabs are told to come back.
//
// Deleting an account goes the same way, and then leaves a lasting mark in localStorage (see
// markAccountDeleted): a tab that missed the message (asleep, frozen, or restored from the
// back/forward cache) sees it when localStorage changes, when it's shown again, and before it saves
// anything, and stops using the account. Each session notes the mark when it starts, so a new
// session of the same account (a guest starting over, or signing in again) isn't taken for the
// deleted one.
//
// Only one sign-out or deletion of an account runs at a time in this browser: each claims it first
// (claimSignOut, an exclusive Web Lock held until it has finished or stopped). Otherwise two tabs
// doing it at once would each stop the other, and neither would finish.

const CHANNEL = 'medtracker-session';
/**
 * Prefix of each account's sign-out marker ("medtracker.signingOut.<userId>"); on its own, the single
 * marker older versions of the app use (still written and read, for tabs running one).
 */
const MARKER_KEY = 'medtracker.signingOut';
const markerKey = (userId: string) => `${MARKER_KEY}.${userId}`;
/** Without Web Locks: how long a claim waits after writing its marker before checking it's still its own. */
const CLAIM_SETTLE_MS = 60;
/** A sign-out that hasn't finished in this long was interrupted (its tab closed). */
const MARKER_TTL_MS = 60_000;
/** How long to wait for other tabs to let go (a frozen background tab never answers). */
const RELEASE_WAIT_MS = 4000;

const DELETED_KEY = 'medtracker.deletedAccounts';

export type SessionEvent = 'signing-out' | 'cancelled';
/** Why the account is leaving: signed out (the default), or being deleted. */
export type SessionReason = 'signing-out' | 'deleting';
type SessionMessage = { type: SessionEvent; userId: string; reason?: SessionReason };

let channel: BroadcastChannel | null | undefined;
function sessionChannel(): BroadcastChannel | null {
  if (channel === undefined) channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL);
  return channel;
}

const lockName = (userId: string) => `medtracker-session-${userId}`;
/** Held by the tab signing the account out or deleting it, for as long as that runs. */
const claimName = (userId: string) => `medtracker-leaving-${userId}`;
const TAB_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
const webLocks = () => (typeof navigator !== 'undefined' ? navigator.locks : undefined);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

interface Holder {
  userId: string;
  /** The account's deletion mark when this session started (see deletionMark). */
  mark: string | null;
  /** Stop using the account (resolves once done) and let go of the lock. */
  end(elsewhere: boolean): Promise<void>;
  /** Let go of the lock but keep going (this tab is the one signing out), or take it again. */
  setLock(held: boolean): void;
}
/** This tab's holders, told directly (a BroadcastChannel doesn't deliver to itself). */
const holders = new Set<Holder>();

/**
 * Hold the account's session in this tab. `onEnd` runs once when it's signed out or deleted, here
 * or in another tab (`elsewhere`); the lock is let go once it has finished. `mark`: the account's
 * deletion mark when the session started (default: now). Returns a release function.
 */
export function holdSession(
  userId: string,
  onEnd: (elsewhere: boolean) => void | Promise<void>,
  opts: { mark?: string | null } = {},
): () => void {
  const locks = webLocks();
  type HeldLock = { abort?: AbortController; release?: () => void; dropped: boolean };
  let lock: HeldLock | null = null;
  const setLock = (held: boolean) => {
    if (!held) {
      if (lock) {
        lock.dropped = true;
        lock.abort?.abort();
        lock.release?.();
      }
      lock = null;
      return;
    }
    if (lock || !locks) return;
    const l: HeldLock = {
      abort: typeof AbortController !== 'undefined' ? new AbortController() : undefined,
      dropped: false,
    };
    lock = l;
    locks
      .request(lockName(userId), { mode: 'shared', signal: l.abort?.signal }, () =>
        new Promise<void>((resolve) => {
          l.release = resolve;
          if (l.dropped) resolve();
        }),
      )
      .catch(() => {});
  };

  let released = false;
  let ending: Promise<void> | null = null;
  const release = () => {
    if (released) return;
    released = true;
    holders.delete(holder);
    sessionChannel()?.removeEventListener('message', onMessage);
    setLock(false);
  };
  const holder: Holder = {
    userId,
    mark: opts.mark !== undefined ? opts.mark : deletionMark(userId),
    end(elsewhere) {
      if (released) return Promise.resolve();
      ending ??= Promise.resolve()
        .then(() => onEnd(elsewhere))
        .catch(() => {})
        .finally(release);
      return ending;
    },
    setLock: (held) => !released && !ending && setLock(held),
  };
  const onMessage = (e: MessageEvent<SessionMessage>) => {
    // (Not while this tab is the one signing it out: only one can, see claimSignOut.)
    if (e.data?.type === 'signing-out' && e.data.userId === userId && !claims.has(userId)) void holder.end(true);
  };
  setLock(true);
  holders.add(holder);
  sessionChannel()?.addEventListener('message', onMessage);
  watchDeletions();
  // Deleted already, after the session started but before it got here.
  if (accountDeletedSince(userId, holder.mark)) void holder.end(true);
  // Signing out unmounts the tracker: an `onEnd` under way still lets go only once it's finished,
  // so the signing-out tab doesn't go on while this one is still saving or closing.
  return () => {
    if (!ending) release();
  };
}

/**
 * Another tab started signing this account out (or deleting it: `reason`), or stopped before
 * clearing anything (`cancelled`).
 */
export function onSignOutElsewhere(
  cb: (userId: string, event: SessionEvent, reason: SessionReason) => void,
): () => void {
  const ch = sessionChannel();
  if (!ch) return () => {};
  const onMessage = (e: MessageEvent<SessionMessage>) => {
    const { type, userId, reason } = e.data ?? {};
    if ((type === 'signing-out' || type === 'cancelled') && typeof userId === 'string') {
      cb(userId, type, reason === 'deleting' ? 'deleting' : 'signing-out');
    }
  };
  ch.addEventListener('message', onMessage);
  return () => ch.removeEventListener('message', onMessage);
}

type Marker = { userId: string; at: number; tab?: string };
function readKey(key: string): Marker | null {
  try {
    const m = JSON.parse(localStorage.getItem(key) ?? 'null') as Partial<Marker> | null;
    return m && typeof m.userId === 'string' && typeof m.at === 'number' ? (m as Marker) : null;
  } catch {
    return null;
  }
}
const fresh = (m: Marker | null): m is Marker => m !== null && Date.now() - m.at < MARKER_TTL_MS;
const isMarkerKey = (key: string) => key === MARKER_KEY || key.startsWith(`${MARKER_KEY}.`);

/**
 * The account's sign-out marker: its own (one per account, so signing out two accounts at once in
 * different tabs doesn't overwrite either's), or the single one older versions of the app write
 * (tabs still running one). The fresh one if either is.
 */
function readMarker(userId: string): Marker | null {
  const own = readKey(markerKey(userId));
  const legacy = readKey(MARKER_KEY);
  const candidates = [own, legacy].filter((m): m is Marker => m?.userId === userId);
  return candidates.find(fresh) ?? candidates[0] ?? null;
}

/**
 * Mark the account as being signed out by this tab (kept fresh by its heartbeat). Also in the single
 * marker older versions read, unless another tab's sign-out holds that now. False if localStorage
 * can't be written.
 */
function writeMarker(userId: string): boolean {
  const value = JSON.stringify({ userId, at: Date.now(), tab: TAB_ID } satisfies Marker);
  try {
    localStorage.setItem(markerKey(userId), value);
  } catch {
    return false;
  }
  try {
    const legacy = readKey(MARKER_KEY);
    if (!fresh(legacy) || legacy.tab === TAB_ID) localStorage.setItem(MARKER_KEY, value);
  } catch {
    /* storage unavailable */
  }
  return true;
}

/** Remove this tab's marker for the account (not one another tab is signing it out with). */
function removeOwnMarker(userId: string): void {
  try {
    const own = readKey(markerKey(userId));
    if (own && (own.tab === undefined || own.tab === TAB_ID)) localStorage.removeItem(markerKey(userId));
    const legacy = readKey(MARKER_KEY);
    if (legacy?.userId === userId && (legacy.tab === undefined || legacy.tab === TAB_ID)) localStorage.removeItem(MARKER_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** The account is being signed out in some tab of this browser (don't bring it back meanwhile). */
export function isSigningOut(userId: string): boolean {
  return fresh(readMarker(userId));
}

/** Accounts this tab has claimed signing out or deleting (see claimSignOut): letting go of each. */
const claims = new Map<string, () => void>();

/**
 * Claim signing out or deleting the account: resolves false if that's already under way, in this
 * tab or another (only one can run at a time: two at once would each stop the other). Let go of by
 * finishSignOut, cancelSignOut or releaseSignOutClaim.
 */
export async function claimSignOut(userId: string): Promise<boolean> {
  if (claims.has(userId)) return false;
  const locks = webLocks();
  if (!locks) {
    // Without Web Locks: the marker is all there is to go by. This tab writes its own, then checks
    // a moment later that it's still its own: of two tabs claiming at once, the later writer wins.
    const m = readMarker(userId);
    if (fresh(m) && m.tab !== TAB_ID) return false;
    const release = () => removeOwnMarker(userId);
    claims.set(userId, release); // (this tab's other claims of it wait meanwhile)
    if (!writeMarker(userId)) return true; // localStorage unusable: nothing to go by
    await sleep(CLAIM_SETTLE_MS);
    const mine = readKey(markerKey(userId));
    // A tab running an older version writes only the single marker: one it wrote for this account
    // meanwhile is a claim too (a newer tab that lost the per-account race removes its own copy
    // there when it finds out, see below).
    const legacy = readKey(MARKER_KEY);
    const olderTab = fresh(legacy) && legacy.userId === userId && legacy.tab !== TAB_ID;
    if (claims.get(userId) === release && mine?.tab === TAB_ID && !olderTab) return true;
    if (claims.get(userId) === release) claims.delete(userId);
    // Another tab's claim: its markers stay, but not this tab's own (in either key).
    removeOwnMarker(userId);
    return false;
  }
  return new Promise<boolean>((resolve) => {
    locks
      .request(claimName(userId), { ifAvailable: true }, (lock) => {
        if (!lock || claims.has(userId)) return void resolve(false);
        return new Promise<void>((release) => {
          claims.set(userId, release);
          resolve(true);
        });
      })
      .catch(() => resolve(false));
  });
}

/** This tab is signing the account out or deleting it (it has the claim). */
export function isLeavingHere(userId: string): boolean {
  return claims.has(userId);
}

/** Let go of this tab's claim on signing the account out (see claimSignOut). */
export function releaseSignOutClaim(userId: string): void {
  const release = claims.get(userId);
  claims.delete(userId);
  release?.();
}

/**
 * Run `fn` while no tab of this browser is signing the account out or deleting it (and none can
 * start meanwhile). If one is under way, waits up to `waitMs` for it to finish; resolves false
 * without running `fn` if it doesn't. A sign-out whose tab closed doesn't hold this up.
 */
export async function whileNotSigningOut(
  userId: string,
  fn: () => Promise<void>,
  opts: { waitMs?: number } = {},
): Promise<boolean> {
  const waitMs = opts.waitMs ?? 0;
  const locks = webLocks();
  if (!locks || typeof AbortController === 'undefined') {
    // Without Web Locks: wait for the marker to go (a closed tab's goes stale).
    const until = Date.now() + waitMs;
    while (isSigningOut(userId) || claims.has(userId)) {
      if (Date.now() >= until) return false;
      await sleep(Math.min(1000, until - Date.now()));
    }
    await fn();
    return true;
  }
  let ran = false;
  const run = async () => {
    ran = true;
    await fn();
  };
  if (!waitMs) {
    await locks.request(claimName(userId), { ifAvailable: true }, (lock) => (lock ? run() : undefined));
    return ran;
  }
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), waitMs);
  try {
    await locks.request(claimName(userId), { signal: abort.signal }, () => {
      clearTimeout(timer);
      return run();
    });
    return true;
  } catch (e) {
    if (!ran) return false; // waited long enough
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Tell `cb` (once) when the account is no longer being signed out in another tab: it finished, it
 * stopped, or its tab closed meanwhile (its marker goes stale). Right away if it isn't now.
 */
export function whenSignOutEnds(userId: string, cb: () => void): () => void {
  let done = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hasWindow = typeof window !== 'undefined' && typeof window.addEventListener === 'function';
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || isMarkerKey(e.key)) check();
  };
  const stop = () => {
    done = true;
    clearTimeout(timer);
    if (hasWindow) window.removeEventListener('storage', onStorage);
  };
  const check = () => {
    if (done) return;
    clearTimeout(timer);
    if (!isSigningOut(userId)) {
      stop();
      cb();
      return;
    }
    // Looked at again once it would go stale (the signing-out tab keeps it fresh while it runs).
    const at = readMarker(userId)?.at ?? Date.now();
    timer = setTimeout(check, Math.max(250, at + MARKER_TTL_MS - Date.now() + 50));
  };
  if (hasWindow) window.addEventListener('storage', onStorage);
  check();
  return stop;
}

const mine = (userId: string) => [...holders].filter((h) => h.userId === userId);

/**
 * The accounts open in some tab of this browser now (each holds its session lock, see holdSession),
 * or null if that can't be told (no Web Locks).
 */
export async function accountsInUse(): Promise<string[] | null> {
  const here = [...holders].map((h) => h.userId);
  const locks = webLocks();
  if (!locks || typeof locks.query !== 'function') return null;
  try {
    const { held = [], pending = [] } = await locks.query();
    const prefix = lockName('');
    const elsewhere = [...held, ...pending]
      .map((l) => l.name)
      .filter((n): n is string => typeof n === 'string' && n.startsWith(prefix))
      .map((n) => n.slice(prefix.length));
    return [...new Set([...here, ...elsewhere])];
  } catch {
    return null;
  }
}

/**
 * Signing out: the account's other tabs stop editing, saving and syncing. This tab carries on
 * (for its last upload). Resolves once they all have, or after a few seconds if one doesn't answer.
 */
export async function endSessionInOtherTabs(
  userId: string,
  signal?: AbortSignal,
  reason: SessionReason = 'signing-out',
): Promise<void> {
  const mark = () => void writeMarker(userId);
  mark();
  // Kept fresh while this runs (a slow last upload or wipe mustn't outlast it).
  clearInterval(heartbeats.get(userId));
  heartbeats.set(userId, setInterval(mark, MARKER_TTL_MS / 4));
  for (const h of mine(userId)) h.setLock(false); // so the wait below is only for the others
  sessionChannel()?.postMessage({ type: 'signing-out', userId, reason } satisfies SessionMessage);
  const locks = webLocks();
  if (!locks || typeof AbortController === 'undefined') return void (await sleep(500));
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), RELEASE_WAIT_MS);
  const onAbort = () => abort.abort();
  signal?.addEventListener('abort', onAbort);
  try {
    // Granted once no other tab holds the account's shared lock.
    await locks.request(lockName(userId), { signal: abort.signal }, () => {});
  } catch {
    /* timed out (or cancelled): go ahead */
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}

/** Keeping each account's marker fresh while this tab signs it out. */
const heartbeats = new Map<string, ReturnType<typeof setInterval>>();

/** This tab stops using the account too (resolves once it has), just before the wipe. */
export async function endSessionHere(userId: string): Promise<void> {
  await Promise.all(mine(userId).map((h) => h.end(false)));
}

/** The sign-out stopped before clearing anything: the other tabs can come back. */
export function cancelSignOut(userId: string): void {
  finishSignOut(userId);
  for (const h of mine(userId)) h.setLock(true);
  sessionChannel()?.postMessage({ type: 'cancelled', userId } satisfies SessionMessage);
}

/**
 * Signing out has finished (or stopped): tabs may follow the sign-in again. Lets go of this tab's
 * claim on it (`userId`; all of them if not given). Only this tab's markers are removed.
 */
export function finishSignOut(userId?: string): void {
  const ids = new Set(userId === undefined ? [...claims.keys(), ...heartbeats.keys()] : [userId]);
  if (userId === undefined) {
    // Also markers this tab left without a claim or heartbeat to show for them.
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        const m = k && isMarkerKey(k) ? readKey(k) : null;
        if (m && (m.tab === TAB_ID || m.tab === undefined)) ids.add(m.userId);
      }
    } catch {
      /* storage unavailable */
    }
  }
  for (const id of ids) {
    releaseSignOutClaim(id);
    clearInterval(heartbeats.get(id));
    heartbeats.delete(id);
    removeOwnMarker(id);
  }
}

// ---------- deleted accounts ----------

type DeletedEntry = {
  /** New each time the account is deleted here (sessions compare it with the one they started with). */
  mark: string;
  at: number;
  /** This device's copy has been removed. */
  wiped?: true;
  /** Signed in to again since, on purpose (a guest starting over, or finishing a deletion). */
  resumed?: true;
};
/** How many deleted accounts are remembered (a session older than all of them is long gone). */
const MAX_DELETED = 20;

function readDeleted(): Record<string, DeletedEntry> {
  try {
    const raw = JSON.parse(localStorage.getItem(DELETED_KEY) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out: Record<string, DeletedEntry> = {};
    for (const [id, e] of Object.entries(raw as Record<string, unknown>)) {
      const entry = e as Partial<DeletedEntry> | null;
      if (entry && typeof entry.mark === 'string' && typeof entry.at === 'number') out[id] = entry as DeletedEntry;
    }
    return out;
  } catch {
    return {};
  }
}

function writeDeleted(all: Record<string, DeletedEntry>): void {
  const kept = Object.entries(all)
    .sort((a, b) => b[1].at - a[1].at)
    .slice(0, MAX_DELETED);
  try {
    localStorage.setItem(DELETED_KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* storage unavailable */
  }
}

/** The account's latest deletion on this device (null: never deleted here). Noted when a session starts. */
export function deletionMark(userId: string): string | null {
  return readDeleted()[userId]?.mark ?? null;
}

/** The account was deleted (in any tab) since a session that started with `mark`. */
export function accountDeletedSince(userId: string, mark: string | null): boolean {
  return deletionMark(userId) !== mark;
}

/**
 * The account was deleted and isn't to be used again from what this device remembers of it (its
 * cached sign-in, or Firebase's), until someone signs in to it again on purpose (resumeAccount).
 */
export function isAccountDeleted(userId: string): boolean {
  const e = readDeleted()[userId];
  return Boolean(e && !e.resumed);
}

/**
 * Deletions whose removal of this device's copy didn't finish (its tab closed meanwhile). Not those
 * still being signed out (by the marker), unless `evenIfSigningOut` (see whileNotSigningOut).
 */
export function unfinishedDeletions(opts: { evenIfSigningOut?: boolean } = {}): string[] {
  return Object.entries(readDeleted())
    .filter(([id, e]) => !e.wiped && !e.resumed && (opts.evenIfSigningOut || !isSigningOut(id)))
    .map(([id]) => id);
}

/**
 * The account has been deleted (its cloud copy, if any, is gone): every tab's session of it ends
 * for good, including tabs that missed being told, and tabs opened later don't bring it back.
 * This tab's own sessions are left to end with endSessionHere.
 */
export function markAccountDeleted(userId: string): void {
  const all = readDeleted();
  const mark =
    typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
  all[userId] = { mark, at: Date.now() };
  writeDeleted(all);
  known.set(userId, mark); // (this tab knows: not news to it)
}

/** This device's copy of a deleted account has been removed. */
export function markDeviceWiped(userId: string): void {
  const all = readDeleted();
  const e = all[userId];
  if (!e || e.wiped) return;
  all[userId] = { ...e, wiped: true };
  writeDeleted(all);
}

/** Signed in to the account again on purpose: it may be used again (older sessions of it stay ended). */
export function resumeAccount(userId: string): void {
  const all = readDeleted();
  const e = all[userId];
  if (!e) return;
  known.set(userId, e.mark); // (not news to this tab: it's being used again here)
  if (e.resumed) return;
  all[userId] = { ...e, resumed: true };
  writeDeleted(all);
}

// ---------- sign-outs that didn't finish clearing this device ----------

const UNWIPED_KEY = 'medtracker.unwipedAccounts';

function readUnwiped(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(UNWIPED_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Signing the account out ended its session and started clearing this device (`on`), or finished
 * that (`!on`). While it's noted, what's left of the account here is removed before it's used here
 * again, and when Amendra next starts (see account.finishInterruptedDeletions).
 */
export function noteWipePending(userId: string, on: boolean): void {
  const list = readUnwiped().filter((id) => id !== userId);
  if (on) list.push(userId);
  try {
    if (list.length) localStorage.setItem(UNWIPED_KEY, JSON.stringify(list.slice(-MAX_DELETED)));
    else localStorage.removeItem(UNWIPED_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Accounts signed out here whose data couldn't all be removed from this device yet (see noteWipePending). */
export function pendingWipes(): string[] {
  return readUnwiped();
}

/** Each account's mark as this tab last saw it (to tell when another tab deletes one). */
const known = new Map<string, string>();
const deletedListeners = new Set<(userId: string) => void>();

/**
 * Look for accounts deleted in another tab since this tab last looked: their sessions here end (as
 * signed out elsewhere) and listeners are told. Runs by itself when localStorage changes and when
 * the tab is shown again; also call it before using an account's data (see store.ts).
 */
export function checkDeletedElsewhere(): void {
  const all = readDeleted();
  for (const h of [...holders]) {
    if ((all[h.userId]?.mark ?? null) !== h.mark) void h.end(true);
  }
  for (const [id, e] of Object.entries(all)) {
    if (known.get(id) === e.mark) continue;
    known.set(id, e.mark);
    for (const cb of [...deletedListeners]) cb(id);
  }
}

/** An account was deleted in another tab of this browser (told once per deletion). */
export function onDeletedElsewhere(cb: (userId: string) => void): () => void {
  watchDeletions();
  deletedListeners.add(cb);
  return () => deletedListeners.delete(cb);
}

let watching = false;
function watchDeletions(): void {
  if (watching) return;
  watching = true;
  // What was deleted before this tab started watching isn't news.
  for (const [id, e] of Object.entries(readDeleted())) if (!known.has(id)) known.set(id, e.mark);
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('storage', (e: StorageEvent) => {
    if (e.key === DELETED_KEY || e.key === null) checkDeletedElsewhere();
  });
  // A tab that was asleep, frozen or in the back/forward cache may have missed both the message and
  // the storage event.
  window.addEventListener('pageshow', checkDeletedElsewhere);
  window.addEventListener('focus', checkDeletedElsewhere);
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState !== 'hidden') checkDeletedElsewhere();
    });
  }
}
