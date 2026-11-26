import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppData, DoseStatus, Medication } from '../shared/types';
import { AccountMenu } from './components/AccountMenu';
import { DeleteAccountDialog } from './components/DeleteAccountDialog';
import { ExportImportDialog } from './components/ExportImportDialog';
import { MedDetail } from './components/MedDetail';
import { MedForm } from './components/MedForm';
import { MedGrid } from './components/MedTile';
import { NotificationSettings } from './components/NotificationSettings';
import { SignInScreen } from './components/SignInScreen';
import { SignOutDialog } from './components/SignOutDialog';
import { SyncEncryptionDialog } from './components/SyncEncryptionDialog';
import { TodayPanel } from './components/TodayPanel';
import {
  finishDeletionBeforeReuse,
  finishInterruptedDeletions,
  lockAfterSignedOutElsewhere,
  needsCleanupBeforeReuse,
  releaseGuestSync,
  stopAccountReminders,
  wipeAfterAccountDeleted,
} from './lib/account';
import { clearSession, completeRedirectSignIn, loadSession, saveSession, signOut, watchAuth, type User } from './lib/auth';
import {
  claimPendingTakes,
  getPushState,
  onPendingTakesChange,
  onServiceWorkerMessage,
  pendingTakeCount,
  queuePendingTake,
  registerServiceWorker,
  stopLocalReminders,
  syncReminders,
} from './lib/push';
import {
  accountDeletedSince,
  checkDeletedElsewhere,
  deletionMark,
  isAccountDeleted,
  isLeavingHere,
  isSigningOut,
  onDeletedElsewhere,
  onSignOutElsewhere,
  pendingWipes,
  resumeAccount,
  whenSignOutEnds,
} from './lib/session';
import { useAppData } from './lib/store';
import { encryptionMarker } from './lib/sync';
import { mergeAppData } from './lib/vault';

type Dialog =
  | { kind: 'add' }
  | { kind: 'edit'; id: string }
  | { kind: 'detail'; id: string }
  | { kind: 'notifications' }
  | { kind: 'vault' }
  | { kind: 'encryption'; view?: 'recovered' | 'setup-done' }
  | { kind: 'delete' }
  | { kind: 'signout' }
  | null;

const NAME_ORDER = new Intl.Collator(undefined, { sensitivity: 'base' });

/** Re-render every 30s so "due"/"next dose" labels stay current. */
function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    const onVisible = () => document.visibilityState === 'visible' && setNow(new Date());
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [intervalMs]);
  return now;
}

/** Whether the browser thinks it's online. */
function useOnline(): boolean {
  const [online, setOnline] = useState(() => typeof navigator === 'undefined' || navigator.onLine !== false);
  useEffect(() => {
    const update = () => setOnline(navigator.onLine !== false);
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);
  return online;
}

/** `value`, but only once it has stayed true for `ms` (so a quick blip doesn't flash on screen). */
function useSettled(value: boolean, ms: number): boolean {
  const [settled, setSettled] = useState(false);
  useEffect(() => {
    if (!value) return setSettled(false);
    const t = setTimeout(() => setSettled(true), ms);
    return () => clearTimeout(t);
  }, [value, ms]);
  return value && settled;
}

const DELETED_NOTICE = 'This account was deleted, so it was signed out in this tab too.';

/** The account shown, and its deletion mark when this tab took it up (see session.deletionMark). */
type Shown = { user: User; mark: string | null };

export default function App() {
  const [shown, setShown] = useState<Shown | null>(() => {
    const saved = loadSession();
    if (!saved) return null;
    // (Read first: if it's deleted after this, the session started with the older mark sees it.)
    const mark = deletionMark(saved.id);
    // Another tab is signing it out, or it was deleted (a sign-in cached from before then), or
    // signed out with some of its data left to remove (see account.signOutAndClear).
    return !isSigningOut(saved.id) && !isAccountDeleted(saved.id) && !pendingWipes().includes(saved.id)
      ? { user: saved, mark }
      : null;
  });
  const user = shown?.user ?? null;
  // (A new object each time: the same message given again is shown again, see SignInScreen.)
  const [authError, setAuthError] = useState<{ message: string } | null>(null);
  /** Bumped by each sign-in choice (and by giving up on one): only the latest may take effect. */
  const signInSeq = useRef(0);
  /** The account chosen, while its old data is still being removed from this device (see handleSignIn). */
  const [waiting, setWaiting] = useState<User | null>(null);
  const waitingRef = useRef<User | null>(null);
  const wait = (u: User | null) => {
    waitingRef.current = u;
    setWaiting(u);
  };
  const [notice, setNotice] = useState<string | null>(null);
  const userRef = useRef(user);
  userRef.current = user;
  const shownRef = useRef(shown);
  shownRef.current = shown;
  /** The account this tab left (or didn't take up) because another tab is signing it out. */
  const leftFor = useRef<string | null>(null);
  const stopWaiting = useRef<(() => void) | null>(null);
  /** Not coming back to the account left (see leaveFor) any more. */
  const disarmLeftFor = () => {
    leftFor.current = null;
    stopWaiting.current?.();
    stopWaiting.current = null;
  };

  /**
   * Another tab is signing the account out (or deleting it): come back if that ends without
   * having done so (it stopped, or its tab closed part-way; see session.whenSignOutEnds).
   */
  const leaveFor = useCallback((userId: string) => {
    leftFor.current = userId;
    stopWaiting.current?.();
    stopWaiting.current = whenSignOutEnds(userId, () => {
      // (A deletion whose tab closed part-way leaves the rest to be removed here.)
      void finishInterruptedDeletions();
      // (May be called back straight away, before this tab has stopped showing the account: only
      // another account shown here since means it's moved on.)
      if (leftFor.current !== userId || (userRef.current && userRef.current.id !== userId)) return;
      if (waitingRef.current) return; // a sign-in choice made since takes precedence
      // Still signed in on this device, and not deleted: it didn't happen.
      if (loadSession()?.id === userId && !isAccountDeleted(userId)) location.reload();
    });
  }, []);

  // Signing out in another tab: this tab stops first, then that one saves and clears the device
  // (see session.ts). If it stopped before clearing anything, come back.
  useEffect(
    () =>
      onSignOutElsewhere((userId, event, reason) => {
        if (event === 'cancelled') {
          // (Not over a sign-in choice made since: see handleSignIn.)
          if (leftFor.current === userId && !userRef.current && !waitingRef.current) location.reload();
          return;
        }
        // (Not while this tab is the one signing it out.)
        if (userRef.current?.id !== userId || isLeavingHere(userId)) return;
        leaveFor(userId);
        stopLocalReminders(); // they name its medications
        setNotice(reason === 'deleting' ? 'This account is being deleted in another tab.' : 'You signed out in another tab.');
        setShown(null);
      }),
    [leaveFor],
  );

  // Deleted in another tab (told or not: this tab may have been asleep). Nothing here may use it
  // again; its session here has ended (see session.ts).
  useEffect(() => {
    /** The account shown was deleted since this tab took it up (not by this tab, which says so itself). */
    const checkShown = () => {
      const s = shownRef.current;
      if (!s || isLeavingHere(s.user.id) || !accountDeletedSince(s.user.id, s.mark)) return false;
      leftFor.current = null; // (it isn't coming back)
      stopLocalReminders();
      setNotice(DELETED_NOTICE);
      setShown(null);
      return true;
    };
    const off = onDeletedElsewhere((userId) => {
      if (checkShown()) return;
      if (leftFor.current === userId && !userRef.current && isAccountDeleted(userId)) {
        leftFor.current = null;
        setNotice(DELETED_NOTICE);
      }
    });
    checkDeletedElsewhere(); // deleted while this tab was starting
    // Also by the mark this tab took the account up with: the news may have reached the tracker
    // before this was listening (its effects run first).
    checkShown();
    // Not shown because another tab is signing it out: come back if that stops.
    const saved = loadSession();
    if (!shownRef.current && saved && isSigningOut(saved.id)) leaveFor(saved.id);
    // A deletion whose tab closed before this device's copy was removed: remove the rest.
    void finishInterruptedDeletions();
    return () => {
      off();
      stopWaiting.current?.();
    };
  }, [leaveFor]);

  // A session is shown: messages from before it (a sign-in error, why the last one ended) are old
  // news by the time it ends, so they don't come back on the sign-in screen then.
  // (Only when one is taken up: not the session restored at startup, which may end straight away
  // with a notice saying why, see the effect above.)
  const isShown = Boolean(shown);
  const wasShown = useRef(isShown);
  useEffect(() => {
    const taken = isShown && !wasShown.current;
    wasShown.current = isShown;
    if (!taken) return;
    setAuthError(null);
    setNotice(null);
  }, [isShown]);

  const handleSignIn = useCallback(async (u: User) => {
    const seq = ++signInSeq.current;
    setAuthError(null);
    wait(null);
    // A new choice: the account this tab left for another tab's sign-out isn't coming back by
    // itself any more (that would reload over this choice, see leaveFor).
    disarmLeftFor();
    // Signed in on purpose: an account deleted on this device before may be used again (a guest
    // starting over, or signing back in to finish a deletion; sync then sees it's deleted). What's
    // left of it here goes first, so its old data doesn't come back. That may wait for a deletion
    // still under way in another tab: meanwhile the sign-in screen says so, and another choice (or
    // giving up) replaces this one.
    if (needsCleanupBeforeReuse(u.id)) {
      wait(u);
      const done = await finishDeletionBeforeReuse(u.id);
      if (seq !== signInSeq.current) return;
      wait(null);
      if (!done) {
        setAuthError({
          message: "Dosely couldn't finish removing this account's old data from this device. Reload the page and try again.",
        });
        return;
      }
    }
    resumeAccount(u.id);
    disarmLeftFor();
    setNotice(null);
    saveSession(u);
    setShown({ user: u, mark: deletionMark(u.id) });
  }, []);

  /** Give up on the sign-in waiting for a deleted account's old data to be removed. */
  const cancelWaiting = useCallback(() => {
    signInSeq.current++;
    wait(null);
  }, []);

  // Service worker + "Mark as taken" from notifications. Takes are queued here, at the top, so they
  // aren't lost on the sign-in screen or while data is still loading; the Tracker applies them.
  useEffect(() => {
    registerServiceWorker();
    const off = onServiceWorkerMessage((msg) => void queuePendingTake(msg.medId, msg.scheduledFor));
    const params = new URLSearchParams(location.search);
    const take = params.get('take');
    const at = params.get('at');
    if (take && at) {
      void queuePendingTake(take, at);
      history.replaceState(null, '', location.pathname);
    }
    return off;
  }, []);

  // Firebase is the source of truth for Google sessions: it picks up redirect sign-ins,
  // refreshes the profile (name/photo), and ends the session if it was revoked or signed out elsewhere.
  useEffect(() => {
    // Not if the user has chosen something else on the sign-in screen meanwhile.
    const seq = signInSeq.current;
    completeRedirectSignIn()
      .then((u) => {
        if (!u || seq !== signInSeq.current || shownRef.current?.user.provider === 'guest') return;
        // Signed in on purpose, like the pop-up (see handleSignIn): even to an account deleted here
        // before, waiting if it's still being deleted in another tab. (Others are taken up below.)
        if (needsCleanupBeforeReuse(u.id)) void handleSignIn(u);
      })
      .catch((e: Error) => {
        if (seq === signInSeq.current) setAuthError({ message: e.message });
      });
    return watchAuth((fbUser) => {
      // Signed out outside the app (not by signing out here): lock its data on this device.
      const current = userRef.current;
      if (!fbUser && current?.provider === 'google' && !isSigningOut(current.id)) {
        // Deleted in another tab (this one wasn't told): nothing to lock, it's gone.
        if (isAccountDeleted(current.id)) checkDeletedElsewhere();
        else void lockAfterSignedOutElsewhere(current);
      }
      if (fbUser && current?.provider !== 'guest') {
        if (isSigningOut(fbUser.id)) {
          // Not taken up while another tab signs it out: come back if that stops.
          if (!current && !isLeavingHere(fbUser.id)) leaveFor(fbUser.id);
        } else if (current?.id === fbUser.id && isAccountDeleted(fbUser.id)) {
          // Deleted in another tab, and this one hadn't heard: it's signed out below, and says why.
          leftFor.current = null;
          stopLocalReminders();
          setNotice(DELETED_NOTICE);
        }
      }
      // (Read before it's checked below, like at startup.)
      const mark = fbUser ? deletionMark(fbUser.id) : null;
      setShown((cur) => {
        if (fbUser) {
          if (cur?.user.provider === 'guest') return cur; // guest chose not to sign in on this device
          // Another choice is waiting to take effect (see handleSignIn): not replaced from here.
          if (waitingRef.current && waitingRef.current.id !== fbUser.id) return cur;
          if (isSigningOut(fbUser.id)) return cur; // Firebase hasn't caught up with the sign-out yet
          // Deleted here, but Firebase still has the sign-in (removing it failed): not brought back
          // from that. Signing in again on purpose does (see handleSignIn).
          if (isAccountDeleted(fbUser.id)) return cur?.user.id === fbUser.id ? null : cur;
          // Signed out with some of its data left on this device: that's removed first (handleSignIn).
          if (pendingWipes().includes(fbUser.id) && cur?.user.id !== fbUser.id) return cur;
          saveSession(fbUser);
          // (The same account: the session it started keeps its mark.)
          return { user: fbUser, mark: cur?.user.id === fbUser.id ? cur.mark : mark };
        }
        if (cur?.user.provider === 'google') {
          // Signing out here: the dialog leaves once this device is clear (it signs out last).
          if (isSigningOut(cur.user.id)) return cur;
          clearSession();
          return null;
        }
        return cur;
      });
    });
  }, [handleSignIn, leaveFor]);

  if (!shown || !user) {
    return (
      <SignInScreen
        onSignIn={handleSignIn}
        initialError={authError}
        notice={notice}
        waiting={waiting}
        onCancelWaiting={cancelWaiting}
      />
    );
  }
  /**
   * No other session than `s` is shown (an old one finishing late, e.g. its deletion or wipe, mustn't
   * end a newer one). (`s` itself may have just left the screen as it ended.)
   */
  const current = (s: Shown) => {
    const cur = shownRef.current;
    return !cur || (cur.user.id === s.user.id && cur.mark === s.mark);
  };
  const session = shown;
  return (
    <Tracker
      key={user.id}
      user={user}
      mark={shown.mark}
      onSignOutLocal={async () => {
        // A guest's data stays on this device (it becomes the account's if that has none yet).
        // Nothing of a Google account's sync state is touched (see releaseGuestSync).
        try {
          await signOut(user);
          await releaseGuestSync();
        } finally {
          setShown(null);
        }
      }}
      onEnded={(message) => {
        if (!current(session)) return;
        setAuthError(null);
        setNotice(message);
        setShown(null);
      }}
    />
  );
}

function Tracker({
  user,
  mark,
  onSignOutLocal,
  onEnded,
}: {
  user: User;
  /** The account's deletion mark when this tab took it up (its session ends if that changes). */
  mark: string | null;
  /** Not synced (a guest choosing "Sign in with Google"): back to the sign-in screen, keeping the data. */
  onSignOutLocal: () => void;
  /** Signed out, or the account (or a guest's data) was deleted, here or on another device. */
  onEnded: (message: string) => void;
}) {
  // Google accounts sync through Firestore; the Firebase uid follows the "firebase:" prefix.
  const syncUid = user.provider === 'google' && user.id.startsWith('firebase:') ? user.id.slice('firebase:'.length) : undefined;
  const {
    data,
    loaded,
    access,
    locking,
    lockError,
    dismissLockError,
    saveError,
    syncStatus,
    syncControls,
    saveMedication,
    deleteMedication,
    logDose,
    undoDose,
    replaceData,
    getData,
  } = useAppData(
    user.id,
    syncUid,
    // Deleted on another device: remove this device's copy too.
    () => {
      void wipeAfterAccountDeleted(user).then(
        (r) => onEnded(r.problem ?? 'This account was deleted, so its data was removed from this device too.'),
        () =>
          onEnded(
            "This account was deleted. Some of its data couldn't be removed from this device yet. Dosely removes the rest the next time it starts.",
          ),
      );
    },
    mark,
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  // What the inline unlock asked to show next (see onUnlocked below), until it can be shown.
  const [afterUnlock, setAfterUnlock] = useState<{ next: 'recovered' | 'setup-done' | null } | null>(null);
  // Signing out or deleting the account is under way in its dialog: an unlock finishing meanwhile
  // mustn't close it (unmounting it would also stop what it's doing), so what the unlock wanted to
  // show waits until that dialog is closed.
  const busyDialog = dialog?.kind === 'signout' || dialog?.kind === 'delete';
  useEffect(() => {
    if (!afterUnlock || busyDialog) return;
    setAfterUnlock(null);
    setDialog(afterUnlock.next ? { kind: 'encryption', view: afterUnlock.next } : null);
  }, [afterUnlock, busyDialog]);
  const [lastSync, setLastSync] = useState<{ count: number; mode: 'push' | 'local' | 'off' } | null>(null);
  const [needsNotifSetup, setNeedsNotifSetup] = useState(false);
  const [syncTick, setSyncTick] = useState(0);
  const now = useNow();
  const online = useOnline();
  const lock = syncStatus?.lock;
  // The cloud copy hasn't been read yet: medications from the user's other devices may still be on
  // their way (on a new device, everything is). Not while locked: the unlock prompt covers that.
  const cloudWaiting =
    Boolean(syncUid) && loaded && !syncStatus?.cloudLoaded && (!lock || lock === 'checking' || lock === 'unlocked');
  // Firestore reports its cached copy first, which looks "offline" until the server answers.
  const cacheOnly = useSettled(cloudWaiting && syncStatus?.state === 'offline', 5000);
  const cloudOffline = cloudWaiting && (!online || cacheOnly);
  const cloudError = cloudWaiting && syncStatus?.state === 'error' ? syncStatus.message ?? "Couldn't reach cloud sync." : null;
  const cloudSyncing = cloudWaiting && !cloudOffline && !cloudError;
  const showSyncNote = useSettled(cloudSyncing, 400);
  const encryptionPrompted = useRef(false);
  const logDoseRef = useRef(logDose);
  logDoseRef.current = logDose;
  const undoDoseRef = useRef(undoDose);
  undoDoseRef.current = undoDose;

  /** Before signing out: record "Mark as taken" taps still waiting, so they're uploaded too. */
  const applyPendingTakes = useCallback(async () => {
    const ids = new Set(getData().medications.map((m) => m.id));
    const claimed = await claimPendingTakes((t) => ids.has(t.medId));
    for (const t of claimed) logDoseRef.current(t.medId, t.scheduledFor, 'taken');
    return { applied: claimed.length, waiting: pendingTakeCount() };
  }, [getData]);

  // Stable callbacks, so memoised children (tiles, today rows) aren't re-rendered by unrelated state.
  const onLog = useCallback((medId: string, key: string, status: DoseStatus) => logDoseRef.current(medId, key, status), []);
  const onUndo = useCallback((medId: string, key: string) => undoDoseRef.current(medId, key), []);
  const onOpenMed = useCallback((id: string) => setDialog({ kind: 'detail', id }), []);

  const meds = useMemo(
    () => [...data.medications].sort((a, b) => NAME_ORDER.compare(a.name, b.name)),
    [data.medications],
  );
  const notifMeds = useMemo(() => meds.filter((m) => m.notificationsEnabled).length, [meds]);

  // Apply "Mark as taken" taps from notifications once this tracker has loaded and has the
  // medication (cloud data may still be arriving). Claiming removes a take from the list shared by
  // all tabs, so only one tab applies it.
  useEffect(() => {
    if (!loaded) return;
    const ids = new Set(data.medications.map((m) => m.id));
    const drain = () => {
      void claimPendingTakes((t) => ids.has(t.medId)).then((claimed) => {
        for (const t of claimed) logDoseRef.current(t.medId, t.scheduledFor, 'taken');
      });
    };
    drain();
    return onPendingTakesChange(drain);
  }, [loaded, data.medications]);

  // Keep scheduled reminders in sync with medications and logs.
  // Not before the data has loaded: an empty list would clear this device's reminders.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      syncReminders(data.medications, data.doseLogs)
        .then(setLastSync)
        .catch(() => setLastSync(null));
    }, 800);
    return () => clearTimeout(t);
  }, [loaded, data.medications, data.doseLogs, syncTick]);

  // Signed out or switched account: stop this account's reminders (here and on the push server),
  // so its doses don't keep prompting notifications.
  useEffect(() => () => void syncReminders([], []).catch(() => {}), []);

  // Encrypted sync was never set up for this account: suggest it once per session. (A locked
  // account shows the unlock screen instead.)
  useEffect(() => {
    if (lock === 'needs-setup' && access === 'open' && !encryptionPrompted.current) {
      encryptionPrompted.current = true;
      setDialog((d) => d ?? { kind: 'encryption' });
    }
  }, [lock, access]);

  // Closed (locked here, in another tab or on another device, or being checked again): nothing of
  // the data stays in use. Its reminders stop (here and on the push server), notifications on
  // screen close, drug lookups cached here go, and so do dialogs showing it. Everything comes back
  // once it's open again. Still being checked at launch (never opened): nothing was armed here, so
  // only what's on this device is cleared, not the push server's reminders.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (access === 'open') {
      wasOpen.current = true;
      return;
    }
    const leaving = wasOpen.current;
    wasOpen.current = false;
    setLastSync(null);
    // (The encryption settings too: they'd come back by themselves if another tab unlocks. Forgetting
    // the key from them closes them; if that fails, lockError says so, see below.)
    setDialog((d) => (d?.kind === 'signout' || d?.kind === 'delete' ? d : null));
    void stopAccountReminders({ localOnly: access === 'checking' && !leaving });
  }, [access]);

  // Nudge to set up notifications when meds want reminders but the device isn't set up.
  useEffect(() => {
    if (!notifMeds) return setNeedsNotifSetup(false);
    getPushState().then((s) => setNeedsNotifSetup(s === 'default' || s === 'ios-needs-install'));
  }, [notifMeds, syncTick]);

  const onSave = (med: Medication, supplyShownAs?: number) => {
    saveMedication(med, supplyShownAs);
    setDialog({ kind: 'detail', id: med.id });
  };

  const onImport = (incoming: AppData, mode: 'merge' | 'replace') => {
    replaceData(mode === 'replace' ? incoming : mergeAppData(data, incoming));
  };

  const findMed = (id: string) => data.medications.find((m) => m.id === id);
  const detailMed = dialog?.kind === 'detail' ? findMed(dialog.id) : undefined;
  const editMed = dialog?.kind === 'edit' ? findMed(dialog.id) : undefined;

  const greeting = (() => {
    const h = now.getHours();
    const first = user.provider === 'google' ? user.name.split(' ')[0] : '';
    const part = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
    return first ? `${part}, ${first}` : part;
  })();

  const signOutDialog = dialog?.kind === 'signout' && (
    <SignOutDialog
      user={user}
      sync={syncControls}
      applyPendingTakes={applyPendingTakes}
      locked={access !== 'open'}
      // Locked: the unlock form is already on screen.
      onUnlock={() => setDialog(access === 'open' ? { kind: 'encryption' } : null)}
      onExport={access === 'open' ? () => setDialog({ kind: 'vault' }) : undefined}
      onSignedOut={onEnded}
      onClose={() => {
        setDialog(null);
        setSyncTick((n) => n + 1); // other tabs that left meanwhile cleared the reminders: send them again
      }}
    />
  );
  const deleteDialog = dialog?.kind === 'delete' && (
    <DeleteAccountDialog
      user={user}
      sync={syncControls}
      // Locked: not even how much there is is shown.
      medicationCount={access === 'open' ? data.medications.length : 0}
      doseLogCount={access === 'open' ? data.doseLogs.length : 0}
      onExport={() => setDialog(access === 'open' ? { kind: 'vault' } : null)}
      onDeleted={(problem) =>
        onEnded(
          problem ??
            (user.provider === 'google'
              ? 'Your account and all of its data have been deleted.'
              : 'All data on this device has been deleted.'),
        )
      }
      onClose={() => setDialog(null)}
    />
  );
  // Synced accounts save to the cloud first, then clear this device (see SignOutDialog).
  const onSignOutChosen = syncUid ? () => setDialog((d) => (d?.kind === 'signout' ? d : { kind: 'signout' })) : onSignOutLocal;

  const isOpen = access === 'open';
  // Forgetting the key failed, or another tab locked the account first: shown open or locked, until dismissed.
  const lockAlert = lockError && (
    <div className="alert alert-error alert-dismissible" role="alert">
      <span>{lockError}</span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={dismissLockError}>
        Dismiss
      </button>
    </div>
  );
  // The account's encryption settings stopped being watched (connection lost, or the cloud refused
  // them) after they'd been read: shown locked or open, with a way to try again.
  // Also for an account known not to use encryption (opened without waiting for its settings): its
  // lock is still 'checking', and without this the only sign would be the plain banner, with no Retry.
  const settingsProblem =
    (lock === 'locked' || lock === 'unlocked' || (lock === 'checking' && access === 'open')) &&
    !locking &&
    (syncStatus?.problem === 'connection' || syncStatus?.problem === 'access')
      ? syncStatus.problem
      : null;
  const settingsAlert = settingsProblem && (
    <div className="alert alert-error alert-dismissible" role="alert">
      <span>
        <strong>{settingsProblem === 'connection' ? "Can't reach cloud sync." : "Cloud sync can't check this account's encryption settings."}</strong>{' '}
        {settingsProblem === 'access' && syncStatus?.problemMessage ? `${syncStatus.problemMessage} ` : ''}
        {lock === 'locked'
          ? "Dosely uses these settings to unlock your data. You can still try your passphrase, but if it was changed on another device, unlocking won't work until Dosely reconnects."
          : lock === 'checking'
            ? "Until Dosely reconnects, syncing with your other devices may be paused, and turning on encryption on one of them won't be noticed here. Your data on this device is safe."
            : "Until Dosely reconnects, syncing with your other devices may be paused, and encryption changes made on them (like a new passphrase) won't be noticed here. Your data on this device is safe."}{' '}
        {settingsProblem === 'connection' ? "Dosely tries again when you're back online, or you can retry now." : 'You can retry now.'}
      </span>
      <button type="button" className="btn btn-sm btn-ghost" onClick={() => syncControls?.retry()} disabled={!syncControls}>
        Retry
      </button>
    </div>
  );

  // Encrypted sync that isn't unlocked on this device (or not known yet not to be encrypted): none
  // of the account's data is loaded, so there's only unlocking it, or signing out.
  const lockedContent = (() => {
    if (isOpen) return null;
    const offlineNote = 'Dosely needs to reach the cloud once to check whether this account is end-to-end encrypted before opening it.';
    const stays = encryptionMarker(syncUid!) === 'on' ? 'Your data stays locked on this device until then.' : offlineNote;
    // The account's encryption settings couldn't be read (still checking), and why.
    const problem = access === 'checking' && syncStatus?.state === 'error' && syncStatus.message ? (syncStatus.problem ?? 'connection') : null;
    const retry = (
      <button type="button" className="btn btn-primary" onClick={() => syncControls?.retry()} disabled={!syncControls}>
        Retry
      </button>
    );
    if (locking) {
      return (
        // (Not the encryption settings: they'd still say it's unlocked.)
        <section className="empty card" role="status">
          <span className="spinner" aria-hidden />
          <h2>Locking…</h2>
          <p className="muted">Encrypting your data on this device.</p>
        </section>
      );
    }
    if (problem === 'connection') {
      return (
        <section className="empty card" role="alert">
          <h2>Can't reach cloud sync</h2>
          <p className="muted">Check your connection and try again. {stays}</p>
          {retry}
        </section>
      );
    }
    if (problem) {
      // Encrypted, but its settings can't be read here (e.g. made by a newer version), or the
      // cloud refused to read them.
      return (
        <section className="empty card" role="alert">
          <h2>Cloud sync can't be opened</h2>
          <p className="muted">
            {syncStatus!.message} {stays}
            {!online ? " You're offline." : ''}
          </p>
          {problem === 'access' && retry}
        </section>
      );
    }
    if (access === 'checking') {
      return (
        <section className="empty card" role="status">
          <span className="spinner" aria-hidden />
          <h2>Checking cloud sync…</h2>
          <p className="muted">
            {!online ? `You're offline. ${offlineNote}` : 'Checking whether your data is end-to-end encrypted before opening it.'}
          </p>
        </section>
      );
    }
    return (
      <SyncEncryptionDialog
        inline
        status={syncStatus}
        controls={syncControls}
        onClose={() => {}}
        // Unlocked with the recovery key, or set up again: the next step shows as a dialog.
        onUnlocked={(next) => setAfterUnlock({ next })}
      />
    );
  })();

  // One tree whether open or not, so the sign-out and deletion dialogs (in the same place in both)
  // stay mounted, with whatever they're doing, when the account locks or opens.
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" width={32} height={32} />
          <span>Dosely</span>
        </div>
        <div className="topbar-actions">
          {isOpen && (
            <button type="button" className="btn btn-primary" aria-label="Add medication" onClick={() => setDialog({ kind: 'add' })}>
              <span aria-hidden>＋</span>
              <span className="hide-sm" aria-hidden>
                Add medication
              </span>
            </button>
          )}
          <AccountMenu
            syncStatus={syncStatus}
            user={user}
            onNotifications={isOpen ? () => setDialog({ kind: 'notifications' }) : undefined}
            onExportImport={isOpen ? () => setDialog({ kind: 'vault' }) : undefined}
            onEncryption={isOpen && syncUid ? () => setDialog({ kind: 'encryption' }) : undefined}
            onSignOut={onSignOutChosen}
            onDeleteAccount={() => setDialog({ kind: 'delete' })}
          />
        </div>
      </header>

      {!isOpen ? (
        <main className="content" key="locked">
          <h1 className="visually-hidden">Dosely</h1>
          {lockAlert}
          {settingsAlert}
          {lockedContent}
          <div className="lock-footer">
            <button type="button" className="btn btn-ghost" onClick={onSignOutChosen}>
              ↪ Sign out
            </button>
          </div>
        </main>
      ) : (
        <main className="content" key="open">
          <div className="page-head">
            <h1>{greeting}</h1>
            <p className="muted">
              {now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
            </p>
            {meds.length > 0 && (showSyncNote || cloudOffline) && (
              <p className="sync-note" role="status">
                {cloudOffline ? (
                  "Offline: showing what's saved on this device."
                ) : (
                  <>
                    <span className="spinner" aria-hidden />
                    Syncing with your other devices…
                  </>
                )}
              </p>
            )}
          </div>

          {lockAlert}
          {settingsAlert}

          {saveError && (
            <div className="alert alert-error" role="alert">
              Couldn't save to this device's storage. Free up space or leave private browsing, and export a backup.
            </div>
          )}

          {lock === 'needs-setup' && dialog?.kind !== 'encryption' && (
            <div className="banner card">
              <span>🔒 Turn on end-to-end encrypted sync to back up your data and use it on your other devices.</span>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'encryption' })}>
                Set up
              </button>
            </div>
          )}

          {needsNotifSetup && (
            <div className="banner card">
              <span>🔔 Get reminders on this device when it's time for a dose.</span>
              <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'notifications' })}>
                Set up notifications
              </button>
            </div>
          )}

          {cloudError && !settingsAlert && (
            <div className="alert alert-error" role="alert">
              {cloudError} Your medications from your other devices will appear once sync reconnects.
            </div>
          )}

          {!loaded ? (
            <p className="sync-note" role="status">
              <span className="spinner" aria-hidden />
              Loading…
            </p>
          ) : meds.length === 0 && cloudSyncing ? (
            <section className="empty card" role="status">
              <span className="spinner" aria-hidden />
              <h2>Syncing your medications…</h2>
              <p className="muted">
                Getting your medications and dose history from your other devices. This can take a few seconds the first
                time.
              </p>
            </section>
          ) : meds.length === 0 && cloudOffline ? (
            <section className="empty card" role="status">
              <div className="empty-icon" aria-hidden>
                📡
              </div>
              <h2>Waiting for a connection</h2>
              <p className="muted">
                Your medications from your other devices will appear here once you're back online. Anything you add now
                is saved on this device and syncs later.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'add' })}>
                Add medication
              </button>
            </section>
          ) : meds.length === 0 ? (
            <section className="empty card">
              <div className="empty-icon" aria-hidden>
                💊
              </div>
              <h2>Add your first medication</h2>
              <p className="muted">
                Start typing a name and Dosely will recognize it, fill in its strengths and pull up what it's for.
              </p>
              <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'add' })}>
                Add medication
              </button>
            </section>
          ) : (
            <>
              <TodayPanel meds={meds} logs={data.doseLogs} now={now} onLog={onLog} onUndo={onUndo} onOpenMed={onOpenMed} />
              <section aria-labelledby="meds-title">
                <h2 id="meds-title" className="section-title">
                  Your medications <span className="muted">({meds.length})</span>
                </h2>
                <MedGrid meds={meds} logs={data.doseLogs} now={now} onOpen={onOpenMed} />
              </section>
            </>
          )}
        </main>
      )}

      {isOpen && (
        <>
          {dialog?.kind === 'add' && (
            <MedForm logs={data.doseLogs} existingCount={data.medications.length} onSave={onSave} onClose={() => setDialog(null)} />
          )}
          {editMed && (
            <MedForm
              initial={editMed}
              logs={data.doseLogs}
              existingCount={data.medications.length}
              onSave={onSave}
              onClose={() => setDialog({ kind: 'detail', id: editMed.id })}
            />
          )}
          {detailMed && (
            <MedDetail
              med={detailMed}
              logs={data.doseLogs}
              now={now}
              onClose={() => setDialog(null)}
              onEdit={() => setDialog({ kind: 'edit', id: detailMed.id })}
              onDelete={() => {
                deleteMedication(detailMed.id);
                setDialog(null);
              }}
              onToggleNotifications={(on) => saveMedication({ ...detailMed, notificationsEnabled: on })}
              onLog={(key, status) => logDose(detailMed.id, key, status)}
              onUndo={(key) => undoDose(detailMed.id, key)}
            />
          )}
          {dialog?.kind === 'notifications' && (
            <NotificationSettings
              enabledMedCount={notifMeds}
              lastSync={lastSync}
              onStateChange={() => setSyncTick((n) => n + 1)}
              onClose={() => setDialog(null)}
            />
          )}
          {dialog?.kind === 'encryption' && (
            <SyncEncryptionDialog
              status={syncStatus}
              controls={syncControls}
              initialView={dialog.view}
              onClose={() => setDialog(null)}
            />
          )}
          {dialog?.kind === 'vault' && <ExportImportDialog data={data} onImport={onImport} onClose={() => setDialog(null)} />}
        </>
      )}
      {deleteDialog}
      {signOutDialog}
    </div>
  );
}
