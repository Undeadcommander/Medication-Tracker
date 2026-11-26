// Signing out, and deleting an account and everything stored for it: the cloud copy (Firestore),
// the Google sign-in account in Firebase Authentication, and this device's copy (local data, sync
// keys, the Firestore offline cache and reminders).
import { clearSession, deleteFirebaseUser, loadSession, reauthenticateForDeletion, signOut, type User } from './auth';
import { clearDrugInfoCache } from './drugLookup';
import { disablePush, forgetReminderState, stopLocalReminders, syncReminders } from './push';
import {
  accountsInUse,
  cancelSignOut,
  claimSignOut,
  endSessionHere,
  endSessionInOtherTabs,
  finishSignOut,
  isAccountDeleted,
  markAccountDeleted,
  markDeviceWiped,
  noteWipePending,
  pendingWipes,
  releaseSignOutClaim,
  unfinishedDeletions,
  whileNotSigningOut,
} from './session';
import { deleteLocalData } from './store';
import {
  clearSyncCache,
  forgetSyncState,
  releaseSyncClient,
  secureLocalCopy,
  type FlushProblem,
  type SyncHandle,
} from './sync';
import type { PendingSummary } from './syncOps';

export type DeleteStep = 'confirming' | 'cloud' | 'account' | 'device';

function firebaseUid(user: User): string | undefined {
  return user.provider === 'google' && user.id.startsWith('firebase:') ? user.id.slice('firebase:'.length) : undefined;
}

/** Notifications already on screen can name medications. */
export async function closeShownNotifications(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker?.getRegistration(import.meta.env.BASE_URL);
    (await reg?.getNotifications())?.forEach((n) => n.close());
  } catch {
    /* not supported */
  }
}

/**
 * Remove everything this device holds for the account and end its session. Also used when the
 * account was deleted on another device.
 */
export async function wipeDevice(user: User, opts: { keepFirebaseSignIn?: boolean } = {}): Promise<void> {
  // Reminders no longer name medications, but cancel them here and on the push server anyway.
  await disablePush().catch(() => {});
  forgetReminderState();
  await closeShownNotifications();
  // If removing the local data fails, the rest is still cleared, and then this rejects: the device
  // isn't wiped (see markDeviceWiped), so it's tried again before the account is used here again.
  let failed: unknown = null;
  await deleteLocalData(user.id).catch((e: unknown) => void (failed = e ?? new Error("This device's data couldn't be removed.")));
  const uid = firebaseUid(user);
  if (uid) {
    await forgetSyncState(uid);
    await clearSyncCache({ openFirst: true });
    noteSyncCacheStale(false);
  } else {
    await releaseGuestSync();
  }
  clearDrugInfoCache(); // names of the medications looked up here
  clearSession();
  if (!opts.keepFirebaseSignIn) await signOut(user).catch(() => {});
  if (failed) throw failed;
}

/**
 * A guest leaving (its data deleted, or choosing to sign in with Google instead): a guest has no
 * sync state of its own, so nothing of any Google account's is touched (their keys, decrypted
 * items and the Firestore offline cache stay; one may be open in another tab). Only this tab's
 * Firestore client (opened ahead of a sign-in) is closed, and a deleted account's leftover cache
 * cleared if no synced account is in use (see clearStaleSyncCache).
 */
export async function releaseGuestSync(): Promise<void> {
  await releaseSyncClient();
  await clearStaleSyncCache().catch(() => {});
}

/**
 * Stop showing anything of an account's data that was locked (or signed out) on this device:
 * its reminders here and on the push server, notifications on screen, and the drug lookups cached
 * here. (Its "Mark as taken" taps stay queued until it's unlocked again.)
 */
export async function stopAccountReminders(opts: { localOnly?: boolean } = {}): Promise<void> {
  stopLocalReminders();
  clearDrugInfoCache();
  // (localOnly: nothing of it was in use here, so the push server's reminders stay as they are.)
  if (!opts.localOnly) await syncReminders([], []).catch(() => {});
  await closeShownNotifications();
}

/**
 * A Google account was signed out outside the app (e.g. the session expired or was revoked).
 * Unlike signing out here, nothing could be uploaded
 * first, so its data isn't removed: it's locked instead. With encrypted sync, this device's copy is
 * encrypted with the account key and the key forgotten (see sync.secureLocalCopy), so it opens
 * again only after signing back in and unlocking. Queued uploads and "Mark as taken" taps stay.
 */
export async function lockAfterSignedOutElsewhere(user: User): Promise<void> {
  const uid = firebaseUid(user);
  if (!uid) return;
  // Started first (synchronously), so signing straight back in waits for it (see sync.localCopySettled).
  const securing = secureLocalCopy(user.id, uid).catch(() => {});
  await stopAccountReminders();
  await securing;
}

export type SignOutStep = 'saving' | 'device';

/** Why signing out stopped before removing anything. */
export interface SignOutProblem {
  /** `busy`: it's already being signed out or deleted in another tab. */
  reason: Exclude<FlushProblem, 'cancelled'> | 'not-ready' | 'busy';
  message?: string;
  /** What isn't in the cloud (unknown when sync hadn't started). */
  pending?: PendingSummary;
  /** "Mark as taken" taps from notifications not recorded yet (their medication isn't on this device). */
  waitingTakes: number;
}

export type SignOutResult =
  /**
   * Signed out (this tab's session has ended). `problem`: part of this device's copy couldn't be
   * removed, worded for the user (it's removed before the account is used here again, and when
   * Dosely next starts).
   */
  | { status: 'signed-out'; problem?: string }
  | { status: 'cancelled' }
  | { status: 'blocked'; problem: SignOutProblem };

export const SIGN_OUT_DEVICE_PROBLEM =
  "You signed out, but some of your data couldn't be removed from this device yet. Dosely removes the rest the next time it starts, and before this account is used here again.";

/**
 * Sign out of a Google account: upload everything this device has that the cloud doesn't, wait
 * until the server has confirmed it, then sign out and remove the account's data from this device
 * (and stop its other tabs). If the cloud can't be brought up to date, nothing is removed and the
 * problem is returned, unless `discardUnsynced` (the user agreed to lose what isn't uploaded).
 */
export async function signOutAndClear(
  user: User,
  sync: SyncHandle | null,
  opts: {
    /** Record "Mark as taken" taps from notifications that are still waiting (see push.ts). */
    applyPendingTakes: () => Promise<{ applied: number; waiting: number }>;
    discardUnsynced?: boolean;
    signal?: AbortSignal;
    onStep?: (step: SignOutStep) => void;
    onProgress?: (remaining: number) => void;
  },
): Promise<SignOutResult> {
  const { signal, discardUnsynced } = opts;
  const flushOpts = { signal, onProgress: opts.onProgress };
  let takes = { applied: 0, waiting: 0 };
  /** Upload what's waiting; the problem if that can't be done (null: up to date). */
  const save = async (needCloud: boolean): Promise<SignOutResult | null> => {
    const result = await sync!.flushAll({ ...flushOpts, needCloud });
    if (signal?.aborted || (!result.ok && result.reason === 'cancelled')) return { status: 'cancelled' };
    if (result.ok) return null;
    const reason = result.reason as SignOutProblem['reason'];
    return { status: 'blocked', problem: { reason, message: result.message, pending: result.pending, waitingTakes: takes.waiting } };
  };

  if (!discardUnsynced) {
    opts.onStep?.('saving');
    takes = await opts.applyPendingTakes();
    if (signal?.aborted) return { status: 'cancelled' };
    if (!sync) return { status: 'blocked', problem: { reason: 'not-ready', waitingTakes: takes.waiting } };
    // Most of the uploading happens here, while the other tabs carry on as usual.
    const stopped = await save(takes.waiting > 0);
    if (stopped) return stopped;
  }
  if (signal?.aborted) return { status: 'cancelled' };

  // Then the other tabs stop (so nothing new appears), and whatever they or the notifications
  // added meanwhile goes up too, before anything is removed. Not while another tab is signing it
  // out or deleting it: each would stop the other.
  if (!(await claimSignOut(user.id))) {
    return { status: 'blocked', problem: { reason: 'busy', waitingTakes: takes.waiting } };
  }
  if (signal?.aborted) {
    releaseSignOutClaim(user.id);
    return { status: 'cancelled' };
  }
  /** Stopped here, before anything was removed: the other tabs come back. */
  const stop = (result: SignOutResult) => {
    cancelSignOut(user.id);
    return result;
  };
  try {
    await endSessionInOtherTabs(user.id, signal);
    if (signal?.aborted) return stop({ status: 'cancelled' });
    if (!discardUnsynced) {
      // Taps the tracker records as the cloud copy brings their medications go up in this pass too.
      takes = await opts.applyPendingTakes();
      const stopped = signal?.aborted ? ({ status: 'cancelled' } as const) : await save(false);
      if (stopped) return stop(stopped);
    }
  } catch (e) {
    // (Recording the taps or uploading failed: nothing was removed, so "Try again" can claim it again.)
    stop({ status: 'cancelled' });
    throw e;
  }

  opts.onStep?.('device');
  let wiped = true;
  try {
    await endSessionHere(user.id); // this tab stops saving and syncing too
    // From here the session has ended: this resolves signed out whatever happens. If clearing
    // the device doesn't finish (it fails, or the tab closes), what's left is removed before the
    // account is used here again (see finishDeletionBeforeReuse) and when Dosely next starts.
    noteWipePending(user.id, true);
    try {
      await wipeDevice(user, { keepFirebaseSignIn: true });
      noteWipePending(user.id, false);
    } catch {
      wiped = false;
    }
    // Signed out last, so the app stays on this screen until the device is clear (the marker
    // keeps tabs from following the sign-in back meanwhile).
    await signOut(user).catch(() => {});
  } finally {
    finishSignOut(user.id);
  }
  return wiped ? { status: 'signed-out' } : { status: 'signed-out', problem: SIGN_OUT_DEVICE_PROBLEM };
}

/**
 * The account was deleted (seen by sync, on another device or by an earlier session that didn't
 * get as far as removing the sign-in account). Clear this device, finish removing the Google sign-in
 * account if it's still there, and sign out.
 */
export async function wipeAfterAccountDeleted(user: User): Promise<{ problem?: string }> {
  // Same order as signing out: this tab stops at once (no more edits are taken or saved, and what
  // a load, lock or unlock under way is writing finishes), then the other tabs stop, and only then
  // is anything removed. Otherwise a tap, a load or another tab's lock could write to this device
  // after the wipe (or during it: clearing the sync cache can take seconds).
  await endSessionHere(user.id);
  // Another tab (or this one) is already signing it out or deleting it: that clears the device, and
  // telling the other tabs to stop from here would stop that one too.
  if (!(await claimSignOut(user.id))) return {};
  let deviceProblem: unknown = null;
  let accountProblem: unknown = null;
  try {
    await endSessionInOtherTabs(user.id, undefined, 'deleting');
    // For good: tabs that missed being told stop too, and none brings it back.
    markAccountDeleted(user.id);
    clearSession();
    try {
      await wipeDevice(user, { keepFirebaseSignIn: true });
      markDeviceWiped(user.id);
    } catch (e) {
      // (Removed before the account, or a guest, is used here again: see finishDeletionBeforeReuse.)
      deviceProblem = e;
    }
    // Its data is gone for good; signing in again would only find the "deleted" marker. Works when
    // the sign-in was recent (it just was, if that's how we got here); otherwise it's already gone or
    // goes when its device finishes.
    if (user.provider === 'google') {
      await deleteFirebaseUser().catch((e: unknown) => void (accountProblem = e ?? new Error('')));
    }
    await signOut(user).catch(() => {});
  } finally {
    finishSignOut(user.id); // (the marker kept the tabs from following the sign-in back meanwhile)
  }
  if (deviceProblem && !accountProblem) throw deviceProblem;
  const problem = deletionProblem(accountProblem, Boolean(deviceProblem));
  return problem ? { problem } : {};
}

const DEVICE_PROBLEM = "Some of its data couldn't be removed from this device yet. Dosely removes the rest the next time it starts.";

/** What didn't work once the account's data was gone, for the user (undefined: nothing). */
function deletionProblem(accountError: unknown, deviceFailed: boolean): string | undefined {
  const parts: string[] = [];
  if (accountError) {
    const msg = accountError instanceof Error ? accountError.message : '';
    const reason = msg ? ` (${msg.replace(/\.$/, '')})` : '';
    parts.push(
      `Your data was deleted, but your sign-in account couldn't be removed yet${reason}. To finish, sign in with Google again: it's removed then.`,
    );
  }
  if (deviceFailed) parts.push(DEVICE_PROBLEM);
  return parts.length ? parts.join(' ') : undefined;
}

/** How deleting an account ended (see deleteAccount). */
export type DeleteResult =
  /** The user cancelled Google's confirmation: nothing was deleted. */
  | { deleted: false }
  /**
   * The account's data is gone and this tab's session has ended. `problem`: something after that
   * didn't work (the sign-in account couldn't be removed, or part of this device's copy), worded
   * for the user with what to do.
   */
  | { deleted: true; problem?: string };

export const DELETE_BUSY_MESSAGE =
  'This account is already being signed out or deleted in another tab. Wait for that to finish, then try again if it’s still here.';

/**
 * Delete the account and all of its data. For Google accounts this asks Google to confirm the
 * account first (call it straight from a tap, so that pop-up isn't blocked). Resolves
 * `{ deleted: false }` if the user cancelled that confirmation, in which case nothing was deleted.
 * Rejects only if nothing was deleted (e.g. the cloud copy couldn't be, or another tab is already
 * signing the account out or deleting it). Once the data is gone it always resolves deleted, with
 * what didn't work after that as `problem`: this tab has signed out either way.
 *
 * The account's other tabs stop first (no more edits, saves or syncing there), and once its data
 * is gone it's marked deleted on this device, so a tab that missed being told (asleep, or opened
 * later) can't keep using it either. See session.ts.
 */
export async function deleteAccount(
  user: User,
  sync: SyncHandle | null,
  onStep?: (step: DeleteStep) => void,
): Promise<DeleteResult> {
  const google = user.provider === 'google';
  if (google) {
    onStep?.('confirming');
    if (!(await reauthenticateForDeletion(user))) return { deleted: false };
    if (!sync) throw new Error('Cloud sync is still starting. Wait a moment and try again.');
    onStep?.('cloud');
  } else {
    onStep?.('device');
  }
  // One at a time: two tabs deleting (or one signing out) at once would each stop the other.
  if (!(await claimSignOut(user.id))) throw new Error(DELETE_BUSY_MESSAGE);
  let deviceFailed = false;
  let accountError: unknown = null;
  try {
    // Deleted in another tab while this one was confirming (this tab's session has ended).
    if (isAccountDeleted(user.id)) return { deleted: true };
    // The other tabs stop before anything is deleted: an edit there can't be saved (or uploaded)
    // after the cloud copy is gone. If deleting the cloud copy fails, they come back.
    await endSessionInOtherTabs(user.id, undefined, 'deleting');
    if (google) {
      try {
        await sync!.deleteCloudData();
      } catch (e) {
        cancelSignOut(user.id);
        throw e;
      }
      onStep?.('device');
    }
    await endSessionHere(user.id); // this tab stops saving too
    // From here it's gone: tabs that missed the message stop when they see this, and none (or a tab
    // opened later) signs back in to it from what's cached here. Nothing below may leave this tab
    // signed in to it.
    markAccountDeleted(user.id);
    try {
      clearSession();
      // This device is cleared before the sign-in account goes, because deleting it signs the app out.
      await wipeDevice(user, { keepFirebaseSignIn: google });
      markDeviceWiped(user.id);
    } catch {
      // What's left is removed before the account (or a guest) is used here again, and when Dosely
      // next starts (see finishInterruptedDeletions).
      deviceFailed = true;
    }
    if (google) {
      onStep?.('account');
      await deleteFirebaseUser().catch((e: unknown) => void (accountError = e ?? new Error('')));
    }
    const problem = deletionProblem(accountError, deviceFailed);
    // (Signed out by deleting the sign-in account; or, if that didn't work, here.)
    if (problem) await signOut(user).catch(() => {});
    return problem ? { deleted: true, problem } : { deleted: true };
  } finally {
    // Only now: the marker keeps other tabs from following the sign-in back until it's gone.
    finishSignOut(user.id);
  }
}

/** Remove what's left of an interrupted deletion of the account here (see finishInterruptedDeletions). */
async function removeLeftovers(userId: string): Promise<void> {
  if (!unfinishedDeletions({ evenIfSigningOut: true }).includes(userId)) return; // done meanwhile
  await deleteLocalData(userId); // (rejects if it couldn't be: then it isn't marked wiped)
  const synced = userId.startsWith('firebase:');
  if (synced) await forgetSyncState(userId.slice('firebase:'.length));
  clearDrugInfoCache(); // names of the medications looked up here (only this app's)
  if (synced) {
    // The Firestore offline cache (only this app's) is shared by every account, so it's cleared
    // only once no other synced account is in use; till then, whenever this next runs.
    // (Awaited: an account signed in to next mustn't start syncing while it's being cleared.)
    noteSyncCacheStale(true);
    await clearStaleSyncCache().catch(() => {
      /* the flag stays: tried again next time */
    });
  }
  markDeviceWiped(userId);
}

/**
 * Remove what's left of an account whose sign-out here ended its session but didn't finish clearing
 * this device (see signOutAndClear): its local data and sync state.
 */
async function removeSignOutLeftovers(userId: string): Promise<void> {
  if (!pendingWipes().includes(userId)) return; // done meanwhile
  // In use in some tab (signed in to again by a tab that didn't know): it's the account's data now.
  if ((await accountsInUse())?.includes(userId)) return noteWipePending(userId, false);
  await deleteLocalData(userId); // (rejects if it couldn't be: then it stays noted)
  const synced = userId.startsWith('firebase:');
  if (synced) await forgetSyncState(userId.slice('firebase:'.length));
  clearDrugInfoCache();
  if (synced) {
    // (In case clearing it was what failed; as for a deletion, see removeLeftovers.)
    noteSyncCacheStale(true);
    await clearStaleSyncCache().catch(() => {});
  }
  noteWipePending(userId, false);
}

/** Set while the Firestore offline cache still holds a deleted account's (see removeLeftovers). */
const STALE_SYNC_CACHE_KEY = 'medtracker.syncCacheStale';
function noteSyncCacheStale(on: boolean): void {
  try {
    if (on) localStorage.setItem(STALE_SYNC_CACHE_KEY, '1');
    else localStorage.removeItem(STALE_SYNC_CACHE_KEY);
  } catch {
    /* storage unavailable */
  }
}
function syncCacheStale(): boolean {
  try {
    return localStorage.getItem(STALE_SYNC_CACHE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Clear the Firestore offline cache left by a deleted account, if no synced account is in use now. */
async function clearStaleSyncCache(): Promise<void> {
  if (!syncCacheStale()) return;
  const inUse = await accountsInUse();
  // (Not if it can't be told, or an account may be about to come back from its saved sign-in.)
  if (!inUse || inUse.some((id) => id.startsWith('firebase:') && !isAccountDeleted(id))) return;
  const saved = loadSession();
  if (saved?.provider === 'google' && !isAccountDeleted(saved.id)) return;
  // (Only the Firestore cache: the deleted account's keys went with its sync state, and other
  // accounts' stay. Not while sync runs in this tab: an account signed in to meanwhile.)
  if (await clearSyncCache({ openFirst: true, firestoreOnly: true, unlessSyncing: true })) noteSyncCacheStale(false);
}

/**
 * A deletion (or sign-out) whose tab closed, or failed, before it had removed this device's copy:
 * remove what's left (the account's local data and sync state, and the caches it shared with
 * other accounts once they're not in use; nothing of any other account). Run at startup, and when
 * a sign-out in another tab ends. Those still under way in another tab are left to it.
 */
export async function finishInterruptedDeletions(): Promise<void> {
  for (const userId of unfinishedDeletions({ evenIfSigningOut: true })) {
    try {
      await whileNotSigningOut(userId, () => removeLeftovers(userId));
    } catch {
      /* tried again next time */
    }
  }
  for (const userId of pendingWipes()) {
    try {
      await whileNotSigningOut(userId, () => removeSignOutLeftovers(userId));
    } catch {
      /* tried again next time */
    }
  }
  await clearStaleSyncCache().catch(() => {});
}

/**
 * The account has leftovers on this device to remove before it's used here again: it was deleted
 * here, or signed out without its data all being removed (see finishDeletionBeforeReuse).
 */
export function needsCleanupBeforeReuse(userId: string): boolean {
  return isAccountDeleted(userId) || pendingWipes().includes(userId);
}

/**
 * Before an account deleted on this device (or signed out without its data all being removed) is
 * used here again (signed in to on purpose, or a guest starting over): remove what's left of it,
 * waiting for a deletion or sign-out still under way in another tab. Resolves false if that
 * couldn't be done (it mustn't be used then: its old data would come back).
 */
export async function finishDeletionBeforeReuse(userId: string): Promise<boolean> {
  const leftover = () => unfinishedDeletions({ evenIfSigningOut: true }).includes(userId) || pendingWipes().includes(userId);
  if (!leftover()) return true;
  try {
    await whileNotSigningOut(
      userId,
      async () => {
        await removeLeftovers(userId);
        await removeSignOutLeftovers(userId);
      },
      { waitMs: REUSE_WAIT_MS },
    );
  } catch {
    /* still there: see below */
  }
  return !leftover();
}

/** How long signing in waits for a deletion of the same account under way in another tab. */
const REUSE_WAIT_MS = 65_000;
