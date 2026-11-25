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
import { SyncEncryptionDialog } from './components/SyncEncryptionDialog';
import { TodayPanel } from './components/TodayPanel';
import { wipeAfterAccountDeleted } from './lib/account';
import { clearSession, completeRedirectSignIn, loadSession, saveSession, signOut, watchAuth, type User } from './lib/auth';
import {
  claimPendingTakes,
  getPushState,
  onPendingTakesChange,
  onServiceWorkerMessage,
  queuePendingTake,
  registerServiceWorker,
  syncReminders,
} from './lib/push';
import { loadPrefs, savePrefs, useAppData } from './lib/store';
import { clearSyncCache } from './lib/sync';
import { mergeAppData } from './lib/vault';

type Dialog =
  | { kind: 'add' }
  | { kind: 'edit'; id: string }
  | { kind: 'detail'; id: string }
  | { kind: 'notifications' }
  | { kind: 'vault' }
  | { kind: 'encryption' }
  | { kind: 'delete' }
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

export default function App() {
  const [user, setUser] = useState<User | null>(() => loadSession());
  const [authError, setAuthError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const handleSignIn = useCallback((u: User) => {
    setNotice(null);
    saveSession(u);
    setUser(u);
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
    completeRedirectSignIn().catch((e: Error) => setAuthError(e.message));
    return watchAuth((fbUser) => {
      setUser((current) => {
        if (fbUser) {
          if (current?.provider === 'guest') return current; // guest chose not to sign in on this device
          saveSession(fbUser);
          return fbUser;
        }
        if (current?.provider === 'google') {
          clearSession();
          return null;
        }
        return current;
      });
    });
  }, []);

  if (!user) return <SignInScreen onSignIn={handleSignIn} initialError={authError} notice={notice} />;
  return (
    <Tracker
      key={user.id}
      user={user}
      onSignOut={async () => {
        try {
          await signOut(user);
          await clearSyncCache();
        } finally {
          setUser(null);
        }
      }}
      onAccountDeleted={(message) => {
        setNotice(message);
        setUser(null);
      }}
    />
  );
}

function Tracker({
  user,
  onSignOut,
  onAccountDeleted,
}: {
  user: User;
  onSignOut: () => void;
  /** The account (or a guest's data) was deleted, here or on another device. */
  onAccountDeleted: (message: string) => void;
}) {
  // Google accounts sync through Firestore; the Firebase uid follows the "firebase:" prefix.
  const syncUid = user.provider === 'google' && user.id.startsWith('firebase:') ? user.id.slice('firebase:'.length) : undefined;
  const { data, loaded, saveError, syncStatus, syncControls, saveMedication, deleteMedication, logDose, undoDose, replaceData } = useAppData(
    user.id,
    syncUid,
    // Deleted on another device: remove this device's copy too.
    () => {
      void wipeAfterAccountDeleted(user).finally(() =>
        onAccountDeleted('This account was deleted, so its data was removed from this device too.'),
      );
    },
  );
  const [dialog, setDialog] = useState<Dialog>(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [lastSync, setLastSync] = useState<{ count: number; mode: 'push' | 'local' | 'off' } | null>(null);
  const [needsNotifSetup, setNeedsNotifSetup] = useState(false);
  const [syncTick, setSyncTick] = useState(0);
  const now = useNow();
  const lock = syncStatus?.lock;
  const encryptionPrompted = useRef(false);
  const logDoseRef = useRef(logDose);
  logDoseRef.current = logDose;
  const undoDoseRef = useRef(undoDose);
  undoDoseRef.current = undoDose;

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

  // Keep scheduled reminders in sync with medications, logs and preferences.
  // Not before the data has loaded: an empty list would clear this device's reminders.
  useEffect(() => {
    if (!loaded) return;
    const t = setTimeout(() => {
      syncReminders(data.medications, data.doseLogs, { discreet: prefs.discreetNotifications })
        .then(setLastSync)
        .catch(() => setLastSync(null));
    }, 800);
    return () => clearTimeout(t);
  }, [loaded, data.medications, data.doseLogs, prefs.discreetNotifications, syncTick]);

  // Signed out or switched account: stop this account's reminders (here and on the push server),
  // so its medication names don't keep appearing in notifications.
  useEffect(() => () => void syncReminders([], []).catch(() => {}), []);

  // Encrypted sync needs setting up or unlocking on this device: ask once per session.
  useEffect(() => {
    if ((lock === 'needs-setup' || lock === 'locked') && !encryptionPrompted.current) {
      encryptionPrompted.current = true;
      setDialog((d) => d ?? { kind: 'encryption' });
    }
  }, [lock]);

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

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <img src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" width={32} height={32} />
          <span>Amendra</span>
        </div>
        <div className="topbar-actions">
          <button type="button" className="btn btn-primary" aria-label="Add medication" onClick={() => setDialog({ kind: 'add' })}>
            <span aria-hidden>＋</span>
            <span className="hide-sm" aria-hidden>
              Add medication
            </span>
          </button>
          <AccountMenu
            syncStatus={syncStatus}
            user={user}
            onNotifications={() => setDialog({ kind: 'notifications' })}
            onExportImport={() => setDialog({ kind: 'vault' })}
            onEncryption={syncUid ? () => setDialog({ kind: 'encryption' }) : undefined}
            onSignOut={() => {
              syncControls?.stop(); // before sign-out clears this device's sync data
              onSignOut();
            }}
            onDeleteAccount={() => setDialog({ kind: 'delete' })}
          />
        </div>
      </header>

      <main className="content">
        <div className="page-head">
          <h1>{greeting}</h1>
          <p className="muted">
            {now.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' })}
          </p>
        </div>

        {saveError && (
          <div className="alert alert-error" role="alert">
            Couldn't save to this device's storage. Free up space or leave private browsing, and export a backup.
          </div>
        )}

        {(lock === 'needs-setup' || lock === 'locked') && dialog?.kind !== 'encryption' && (
          <div className="banner card">
            <span>
              {lock === 'needs-setup'
                ? '🔒 Turn on end-to-end encrypted sync to back up your data and use it on your other devices.'
                : '🔒 Cloud sync is locked on this device. Changes are saved here and upload once you unlock.'}
            </span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'encryption' })}>
              {lock === 'needs-setup' ? 'Set up' : 'Unlock'}
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

        {!loaded ? (
          <p className="muted" role="status">
            Loading…
          </p>
        ) : meds.length === 0 ? (
          <section className="empty card">
            <div className="empty-icon" aria-hidden>
              💊
            </div>
            <h2>Add your first medication</h2>
            <p className="muted">
              Start typing a name and Amendra will recognize it, fill in its strengths and pull up what it's for.
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
          discreet={prefs.discreetNotifications}
          onDiscreetChange={(v) => {
            const next = { ...prefs, discreetNotifications: v };
            setPrefs(next);
            savePrefs(next);
          }}
          enabledMedCount={notifMeds}
          lastSync={lastSync}
          onStateChange={() => setSyncTick((n) => n + 1)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'encryption' && (
        <SyncEncryptionDialog status={syncStatus} controls={syncControls} onClose={() => setDialog(null)} />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteAccountDialog
          user={user}
          sync={syncControls}
          medicationCount={data.medications.length}
          doseLogCount={data.doseLogs.length}
          onExport={() => setDialog({ kind: 'vault' })}
          onDeleted={() =>
            onAccountDeleted(
              user.provider === 'google'
                ? 'Your account and all of its data have been deleted.'
                : 'All data on this device has been deleted.',
            )
          }
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'vault' && <ExportImportDialog data={data} onImport={onImport} onClose={() => setDialog(null)} />}
    </div>
  );
}
