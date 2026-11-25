import { useEffect, useRef, useState } from 'react';
import { initials, type User } from '../lib/auth';

interface Props {
  user: User;
  onNotifications: () => void;
  onExportImport: () => void;
  onSignOut: () => void;
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

export function AccountMenu({ user, onNotifications, onExportImport, onSignOut }: Props) {
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
            </div>
          </div>
          <button type="button" role="menuitem" className="account-item" onClick={choose(onNotifications)}>
            🔔 Notification settings
          </button>
          <button type="button" role="menuitem" className="account-item" onClick={choose(onExportImport)}>
            🔐 Export / import data
          </button>
          <button type="button" role="menuitem" className="account-item" onClick={choose(onSignOut)}>
            {user.provider === 'guest' ? '↪ Sign in with Google' : '↪ Sign out'}
          </button>
        </div>
      )}
    </div>
  );
}
