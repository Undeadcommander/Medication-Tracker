import { useEffect, useRef, useState } from 'react';
import { initials, type User } from '../lib/auth';
import type { SyncStatus } from '../lib/sync';

interface Props {
  user: User;
  syncStatus?: SyncStatus | null;
  onNotifications: () => void;
  onExportImport: () => void;
  /** Cloud encryption settings (signed-in accounts only). */
  onEncryption?: () => void;
  onSignOut: () => void;
  onDeleteAccount: () => void;
}

export function Avatar({ user, size = 36 }: { user: User; size?: number }) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [user.picture]);
  if (user.picture && !broken) {
    return (
      <img
        className="avatar"
        src={user.picture}
        alt=""
        width={size}
        height={size}
        referrerPolicy="no-referrer"
        onError={() => setBroken(true)}
      />
    );
  }
  return (
    <span className="avatar avatar-fallback" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {user.provider === 'guest' ? '👤' : initials(user.name)}
    </span>
  );
}

const SYNC_TEXT: Record<SyncStatus['state'], string> = {
  connecting: 'Connecting to cloud sync…',
  synced: 'Synced across your devices',
  saving: 'Saving to the cloud…',
  offline: 'Offline. Changes will sync when you reconnect.',
  error: 'Cloud sync problem',
  locked: 'Locked. Unlock this device to sync.',
  setup: 'Set up encrypted sync to back up your data',
};

export function AccountMenu({ user, syncStatus, onNotifications, onExportImport, onEncryption, onSignOut, onDeleteAccount }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const choose = (fn: () => void) => () => {
    setOpen(false);
    fn();
  };

  return (
    <div className="account" ref={ref}>
      <button
        type="button"
        className="account-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Account: ${user.name}`}
        onClick={() => setOpen((o) => !o)}
      >
        <Avatar user={user} />
      </button>
      {open && (
        <div className="account-menu card" role="menu">
          <div className="account-identity">
            <Avatar user={user} size={44} />
            <div>
              <div className="account-name">{user.name}</div>
              <div className="muted account-email">
                {user.provider === 'guest' ? 'Not signed in' : user.email ?? 'Google account'}
              </div>
              {syncStatus ? (
                <div className={`account-sync sync-${syncStatus.state}`} role="status" title={syncStatus.message}>
                  <span className="account-sync-dot" aria-hidden />
                  {syncStatus.lock === 'unlocked' && <span aria-label="End-to-end encrypted">🔒 </span>}
                  {syncStatus.state === 'error' && syncStatus.message ? syncStatus.message : SYNC_TEXT[syncStatus.state]}
                </div>
              ) : (
                user.provider === 'guest' && (
                  <div className="account-sync muted">Sign in with Google to sync across devices</div>
                )
              )}
            </div>
          </div>
          <button type="button" role="menuitem" className="account-item" onClick={choose(onNotifications)}>
            🔔 Notification settings
          </button>
          {syncStatus?.warning && (
            <div className="account-sync-warning" role="status">
              ⚠ {syncStatus.warning}
            </div>
          )}
          {onEncryption && (
            <button type="button" role="menuitem" className="account-item" onClick={choose(onEncryption)}>
              {syncStatus?.lock === 'locked' ? '🔑 Unlock cloud sync' : syncStatus?.lock === 'needs-setup' ? '🔑 Set up encrypted sync' : '🔑 Cloud encryption'}
            </button>
          )}
          <button type="button" role="menuitem" className="account-item" onClick={choose(onExportImport)}>
            🔐 Export / import data
          </button>
          <button type="button" role="menuitem" className="account-item" onClick={choose(onSignOut)}>
            {user.provider === 'guest' ? '↪ Sign in with Google' : '↪ Sign out'}
          </button>
          <button type="button" role="menuitem" className="account-item account-item-danger" onClick={choose(onDeleteAccount)}>
            {user.provider === 'guest' ? '🗑 Delete all data' : '🗑 Delete account'}
          </button>
        </div>
      )}
    </div>
  );
}
