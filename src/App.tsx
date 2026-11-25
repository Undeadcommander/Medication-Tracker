import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { AppData, Medication } from '../shared/types';
import { AccountMenu } from './components/AccountMenu';
import { ExportImportDialog } from './components/ExportImportDialog';
import { MedDetail } from './components/MedDetail';
import { MedForm } from './components/MedForm';
import { MedTile } from './components/MedTile';
import { NotificationSettings } from './components/NotificationSettings';
import { SignInScreen } from './components/SignInScreen';
import { TodayPanel } from './components/TodayPanel';
import { clearSession, completeRedirectSignIn, loadSession, saveSession, signOut, watchAuth, type User } from './lib/auth';
import { getPushState, onServiceWorkerMessage, registerServiceWorker, syncReminders } from './lib/push';
import { adoptGuestData, loadPrefs, savePrefs, useAppData } from './lib/store';
import { mergeAppData } from './lib/vault';

type Dialog =
  | { kind: 'add' }
  | { kind: 'edit'; id: string }
  | { kind: 'detail'; id: string }
  | { kind: 'notifications' }
  | { kind: 'vault' }
  | null;

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

  const handleSignIn = useCallback((u: User) => {
    if (u.provider === 'google') adoptGuestData(u.id);
    saveSession(u);
    setUser(u);
  }, []);

  // Firebase is the source of truth for Google sessions: it picks up redirect sign-ins,
  // refreshes the profile (name/photo), and ends the session if it was revoked or signed out elsewhere.
  useEffect(() => {
    completeRedirectSignIn().catch((e: Error) => setAuthError(e.message));
    return watchAuth((fbUser) => {
      setUser((current) => {
        if (fbUser) {
          if (current?.provider === 'guest') return current; // guest chose not to sign in on this device
          if (current?.id !== fbUser.id) adoptGuestData(fbUser.id);
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

  if (!user) return <SignInScreen onSignIn={handleSignIn} initialError={authError} />;
  return (
    <Tracker
      key={user.id}
      user={user}
      onSignOut={async () => {
        try {
          await signOut(user);
        } finally {
          setUser(null);
        }
      }}
    />
  );
}

function Tracker({ user, onSignOut }: { user: User; onSignOut: () => void }) {
  const { data, saveError, saveMedication, deleteMedication, logDose, undoDose, replaceData } = useAppData(user.id);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [prefs, setPrefs] = useState(loadPrefs);
  const [lastSync, setLastSync] = useState<{ count: number; mode: 'push' | 'local' | 'off' } | null>(null);
  const [needsNotifSetup, setNeedsNotifSetup] = useState(false);
  const [syncTick, setSyncTick] = useState(0);
  const now = useNow();
  const logDoseRef = useRef(logDose);
  logDoseRef.current = logDose;

  const meds = useMemo(
    () => [...data.medications].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })),
    [data.medications],
  );
  const notifMeds = meds.filter((m) => m.notificationsEnabled).length;

  // Service worker + "Mark as taken" from notifications.
  useEffect(() => {
    registerServiceWorker();
    const off = onServiceWorkerMessage((msg) => {
      if (msg.type === 'dose-taken') logDoseRef.current(msg.medId, msg.scheduledFor, 'taken');
    });
    const params = new URLSearchParams(location.search);
    const take = params.get('take');
    const at = params.get('at');
    if (take && at) {
      logDoseRef.current(take, at, 'taken');
      history.replaceState(null, '', location.pathname);
    }
    return off;
  }, []);

  // Keep scheduled reminders in sync with medications, logs and preferences.
  useEffect(() => {
    const t = setTimeout(() => {
      syncReminders(data.medications, data.doseLogs, { discreet: prefs.discreetNotifications })
        .then(setLastSync)
        .catch(() => setLastSync(null));
    }, 800);
    return () => clearTimeout(t);
  }, [data.medications, data.doseLogs, prefs.discreetNotifications, syncTick]);

  // Nudge to set up notifications when meds want reminders but the device isn't set up.
  useEffect(() => {
    if (!notifMeds) return setNeedsNotifSetup(false);
    getPushState().then((s) => setNeedsNotifSetup(s === 'default' || s === 'ios-needs-install'));
  }, [notifMeds, syncTick]);

  const onSave = (med: Medication) => {
    saveMedication(med);
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
          <span>MedTracker</span>
        </div>
        <div className="topbar-actions">
          <button type="button" className="btn btn-primary" aria-label="Add medication" onClick={() => setDialog({ kind: 'add' })}>
            <span aria-hidden>＋</span>
            <span className="hide-sm" aria-hidden>
              Add medication
            </span>
          </button>
          <AccountMenu
            user={user}
            onNotifications={() => setDialog({ kind: 'notifications' })}
            onExportImport={() => setDialog({ kind: 'vault' })}
            onSignOut={onSignOut}
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

        {needsNotifSetup && (
          <div className="banner card">
            <span>🔔 Get reminders on this device when it's time for a dose.</span>
            <button type="button" className="btn btn-sm btn-primary" onClick={() => setDialog({ kind: 'notifications' })}>
              Set up notifications
            </button>
          </div>
        )}

        {meds.length === 0 ? (
          <section className="empty card">
            <div className="empty-icon" aria-hidden>
              💊
            </div>
            <h2>Add your first medication</h2>
            <p className="muted">
              Start typing a name and MedTracker will recognize it, fill in its strengths and pull up what it's for.
            </p>
            <button type="button" className="btn btn-primary" onClick={() => setDialog({ kind: 'add' })}>
              Add medication
            </button>
          </section>
        ) : (
          <>
            <TodayPanel
              meds={meds}
              logs={data.doseLogs}
              now={now}
              onLog={logDose}
              onUndo={undoDose}
              onOpenMed={(id) => setDialog({ kind: 'detail', id })}
            />
            <section aria-labelledby="meds-title">
              <h2 id="meds-title" className="section-title">
                Your medications <span className="muted">({meds.length})</span>
              </h2>
              <div className="tiles">
                {meds.map((m) => (
                  <MedTile key={m.id} med={m} logs={data.doseLogs} now={now} onOpen={() => setDialog({ kind: 'detail', id: m.id })} />
                ))}
              </div>
            </section>
          </>
        )}
      </main>

      {dialog?.kind === 'add' && (
        <MedForm existingCount={data.medications.length} onSave={onSave} onClose={() => setDialog(null)} />
      )}
      {editMed && (
        <MedForm
          initial={editMed}
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
      {dialog?.kind === 'vault' && <ExportImportDialog data={data} onImport={onImport} onClose={() => setDialog(null)} />}
    </div>
  );
}
