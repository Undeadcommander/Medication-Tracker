// Deleting an account and everything stored for it: the cloud copy (Firestore), the Google sign-in
// account in Firebase Authentication, and this device's copy (local data, sync keys, the
// Firestore offline cache and reminders).
import { clearSession, deleteFirebaseUser, reauthenticateForDeletion, signOut, type User } from './auth';
import { disablePush } from './push';
import { deleteLocalData } from './store';
import { clearSyncCache, forgetSyncState, type SyncHandle } from './sync';

export type DeleteStep = 'confirming' | 'cloud' | 'account' | 'device';

function firebaseUid(user: User): string | undefined {
  return user.provider === 'google' && user.id.startsWith('firebase:') ? user.id.slice('firebase:'.length) : undefined;
}

/** Notifications already on screen can name medications. */
async function closeShownNotifications(): Promise<void> {
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
  // Reminders mention the medications (unless discreet), so cancel them here and on the push server.
  await disablePush().catch(() => {});
  await closeShownNotifications();
  await deleteLocalData(user.id);
  const uid = firebaseUid(user);
  if (uid) await forgetSyncState(uid);
  await clearSyncCache();
  clearSession();
  if (!opts.keepFirebaseSignIn) await signOut(user).catch(() => {});
}

/**
 * The account was deleted (seen by sync, on another device or by an earlier session that didn't
 * get as far as removing the sign-in account). Clear this device, finish removing the Google sign-in
 * account if it's still there, and sign out.
 */
export async function wipeAfterAccountDeleted(user: User): Promise<void> {
  await wipeDevice(user, { keepFirebaseSignIn: true });
  // Its data is gone for good; signing in again would only find the "deleted" marker. Works when
  // the sign-in was recent (it just was, if that's how we got here); otherwise it's already gone or
  // goes when its device finishes.
  if (user.provider === 'google') await deleteFirebaseUser().catch(() => {});
  await signOut(user).catch(() => {});
}

/**
 * Delete the account and all of its data. For Google accounts this asks Google to confirm the
 * account first (call it straight from a tap, so that pop-up isn't blocked). Resolves false if the
 * user cancelled that confirmation, in which case nothing was deleted.
 */
export async function deleteAccount(
  user: User,
  sync: SyncHandle | null,
  onStep?: (step: DeleteStep) => void,
): Promise<boolean> {
  if (user.provider === 'google') {
    onStep?.('confirming');
    if (!(await reauthenticateForDeletion(user))) return false;
    if (!sync) throw new Error('Cloud sync is still starting. Wait a moment and try again.');
    onStep?.('cloud');
    await sync.deleteCloudData();
    // This device is cleared before the sign-in account goes, because deleting it signs the app out.
    onStep?.('device');
    await wipeDevice(user, { keepFirebaseSignIn: true });
    onStep?.('account');
    try {
      await deleteFirebaseUser();
    } catch (e) {
      const reason = e instanceof Error ? ` ${e.message}` : '';
      throw new Error(`Your data was deleted, but your sign-in account couldn't be removed yet.${reason}`);
    }
    return true;
  }
  onStep?.('device');
  await wipeDevice(user);
  return true;
}
