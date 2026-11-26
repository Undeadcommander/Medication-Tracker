// A locked account's data on this device. When an end-to-end encrypted account is locked here (its
// key forgotten, or the session ended outside the app), its local copy is encrypted with the
// account key and the readable copy removed, so nothing on this device can read it without the
// passphrase (or this device's stored key). Edits not uploaded yet stay in it, and it's put back
// once the account is unlocked again with the same key.
import type { AppData } from '../../shared/types';
import { clearSealedMark, deleteAccount, loadAccount, loadSealed, localDbAvailable, restoreSealed, storeSealed } from './localDb';
import { openLocalCopy, sealLocalCopy, type SealedLocalCopy } from './syncCrypto';
import { applyQueuedDeletions, parseQueue, queueKey, type OpRef } from './syncOps';
import { mergeAppData } from './vault';

/** Where older versions kept an account's data (and the fallback without IndexedDB), as one localStorage string. */
export const legacyDataKey = (userId: string) => `medtracker.data.${userId}`;

const isEmpty = (d: AppData) => !d.medications.length && !d.doseLogs.length;

function isAppData(x: unknown): x is AppData {
  const d = x as AppData | null;
  return d?.version === 1 && Array.isArray(d.medications) && Array.isArray(d.doseLogs);
}

function readLegacy(userId: string): AppData | null {
  try {
    const parsed = JSON.parse(localStorage.getItem(legacyDataKey(userId)) ?? 'null');
    return isAppData(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function removeLegacy(userId: string): void {
  try {
    localStorage.removeItem(legacyDataKey(userId));
  } catch {
    /* ignore */
  }
}

/** One tab at a time loads, seals or unseals an account's local copy (see store.ts). */
export function withLoadLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  return locks ? locks.request(`medtracker-load-${userId}`, fn) : fn();
}

/** Attempts at sealing while other tabs keep saving edits, before giving up. */
const SEAL_ATTEMPTS = 5;

/**
 * Encrypt the account's local copy with its key and remove the readable one (merged into an
 * encrypted copy already there from earlier). Returns false if it couldn't be done (no IndexedDB);
 * throws if it failed (storage error, or edits kept arriving from other tabs), leaving the readable
 * copy as it was.
 *
 * Other tabs may still be saving edits while this runs (they only stop once told the key is
 * forgotten, after this). The readable copy is only removed if it's still what was encrypted;
 * otherwise it's read and encrypted again, so an edit saved meanwhile is never lost. Once it's
 * removed, other tabs' edits are refused (see localDb storeSealed).
 *
 * `unless`: checked once no other tab is loading, locking or unlocking the copy (e.g. "it was
 * unlocked again meanwhile"), again just before the encrypted copy is stored, and once more after;
 * if it holds, nothing is done (or the copy is put back, readable) and this throws.
 *
 * `sealed`: run once the copy is encrypted, before any other tab may load it (e.g. forgetting the
 * key it was encrypted with, so a tab loading it next can tell it was locked: see store.ts).
 */
export async function sealLocal(
  userId: string,
  uid: string,
  key: CryptoKey,
  keyId: string,
  opts: { unless?: () => Promise<boolean>; sealed?: () => Promise<void> } = {},
): Promise<boolean> {
  if (!(await localDbAvailable())) return false;
  const unlockedAgain = async () => !!opts.unless && (await opts.unless());
  const notLocked = () => new Error('Unlocked again meanwhile: not locked.');
  return withLoadLock(userId, async () => {
    if (await unlockedAgain()) throw notLocked();
    for (let attempt = 0; attempt < SEAL_ATTEMPTS; attempt++) {
      const readable = await loadAccount(userId);
      let data = readable;
      const legacy = readLegacy(userId);
      if (legacy && !isEmpty(legacy)) data = mergeAppData(legacy, data);
      const existing = await loadSealed<SealedLocalCopy>(userId, keyId);
      if (existing) {
        try {
          const earlier = await openLocalCopy(key, uid, existing);
          if (isAppData(earlier)) data = mergeAppData(earlier, data); // what's readable is newer
        } catch {
          /* damaged: replaced below */
        }
      }
      // Nothing at all to keep: just remove the (empty) readable copy, if it's still empty.
      const sealed = isEmpty(data) ? null : await sealLocalCopy(key, uid, keyId, data);
      if (await unlockedAgain()) throw notLocked();
      if (await storeSealed(userId, keyId, sealed, readable)) {
        removeLegacy(userId);
        // Unlocked again while it was being encrypted: it's in use, so it's put back (still
        // holding the lock, so no other tab finds it encrypted meanwhile).
        if (await unlockedAgain()) {
          await unsealLocal(userId, uid, key, keyId);
          throw notLocked();
        }
        await opts.sealed?.();
        return true;
      }
    }
    throw new Error("This device's copy kept changing while it was being encrypted.");
  });
}

/** The account's queued uploads (see sync.ts), as stored. */
function queuedRefs(uid: string): OpRef[] {
  try {
    return parseQueue(localStorage.getItem(queueKey(uid))).map((e) => e.ref);
  } catch {
    return [];
  }
}

/**
 * Unlocked with `key`: decrypt the account's encrypted copy made with it (if any) back into the
 * readable local copy, which may then be written again. Call inside withLoadLock. One that can't
 * be opened is left as it is. Items whose deletion is queued for upload stay deleted (see
 * applyQueuedDeletions).
 */
export async function unsealLocal(userId: string, uid: string, key: CryptoKey, keyId: string): Promise<void> {
  const sealed = await loadSealed<SealedLocalCopy>(userId, keyId);
  let data: unknown;
  if (sealed) {
    try {
      data = await openLocalCopy(key, uid, sealed);
    } catch {
      /* left as it is */
    }
  }
  if (!isAppData(data)) return clearSealedMark(userId); // nothing to put back
  const current = await loadAccount(userId);
  const restored = isEmpty(current) ? data : mergeAppData(data, current);
  await restoreSealed(userId, keyId, applyQueuedDeletions(restored, queuedRefs(uid)));
}

/** Remove the account's readable local copy (its encrypted copies stay). */
export async function discardReadable(userId: string): Promise<void> {
  await withLoadLock(userId, async () => {
    if (await localDbAvailable()) await deleteAccount(userId, { keepSealed: true });
    removeLegacy(userId);
  });
}
