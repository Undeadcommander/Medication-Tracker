import { useEffect, useState } from 'react';
import {
  disablePush,
  enablePush,
  getPlatformInfo,
  getPushState,
  PUSH_SERVER_CONFIGURED,
  sendTestNotification,
  type PushState,
} from '../lib/push';
import { Modal } from './Modal';

interface Props {
  discreet: boolean;
  onDiscreetChange: (v: boolean) => void;
  enabledMedCount: number;
  lastSync: { count: number; mode: 'push' | 'local' | 'off' } | null;
  onStateChange: () => void;
  onClose: () => void;
}

const STATE_TEXT: Record<PushState, string> = {
  unsupported: "This browser doesn't support notifications.",
  'ios-needs-install': 'On iPhone and iPad, add Dosely to your Home Screen to get notifications.',
  denied: 'Notifications are blocked for this site. Allow them in your browser or system settings, then reload.',
  default: 'Notifications are off on this device.',
  granted: "Notifications are allowed, but the reminder server isn't reachable. Reminders only arrive while Dosely is open.",
  subscribed: 'Push notifications are on. Reminders arrive even when Dosely is closed.',
};

export function NotificationSettings({ discreet, onDiscreetChange, enabledMedCount, lastSync, onStateChange, onClose }: Props) {
  const [state, setState] = useState<PushState | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const platform = getPlatformInfo();

  useEffect(() => {
    getPushState().then(setState);
  }, []);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (e) {
      setMessage({ kind: 'error', text: e instanceof Error ? e.message : 'Something went wrong' });
    } finally {
      setBusy(false);
      setState(await getPushState());
      onStateChange();
    }
  };

  const enable = () =>
    run(async () => {
      const s = await enablePush();
      if (s === 'denied') throw new Error('Permission was denied.');
      setMessage({ kind: 'success', text: s === 'subscribed' ? 'Push notifications enabled.' : 'Notifications enabled (local mode).' });
    });

  const disable = () =>
    run(async () => {
      await disablePush();
      setMessage({ kind: 'success', text: 'Push notifications turned off for this device.' });
    });

  const test = () =>
    run(async () => {
      await sendTestNotification();
      setMessage({ kind: 'success', text: 'Test notification sent. It should appear in a few seconds.' });
    });

  const on = state === 'subscribed' || state === 'granted';

  return (
    <Modal title="Notifications" onClose={onClose}>
      <div className="notif">
        <div className={`notif-status ${on ? 'on' : ''}`}>
          <span className="notif-dot" aria-hidden />
          <span>
            {!state
              ? 'Checking…'
              : state === 'granted' && !PUSH_SERVER_CONFIGURED
                ? 'Notifications are on. This site has no reminder server, so reminders only appear while Dosely is open on screen. iPhone pauses it when you switch away. If you reopen it within 2 hours of a missed dose, you get that reminder then.'
                : STATE_TEXT[state]}
          </span>
        </div>

        {state === 'ios-needs-install' && (
          <ol className="ios-steps">
            <li>
              Open this page in <strong>Safari</strong>.
            </li>
            <li>
              Tap the <strong>Share</strong> button (square with an arrow).
            </li>
            <li>
              Choose <strong>Add to Home Screen</strong>, then tap <strong>Add</strong>.
            </li>
            <li>Open Dosely from your Home Screen and come back here to turn on notifications.</li>
            <li className="muted">This needs iOS / iPadOS 16.4 or later.</li>
          </ol>
        )}

        <div className="notif-actions">
          {(state === 'default' || (state === 'granted' && PUSH_SERVER_CONFIGURED)) && (
            <button type="button" className="btn btn-primary" onClick={enable} disabled={busy}>
              {state === 'granted' ? 'Retry push setup' : 'Turn on notifications'}
            </button>
          )}
          {on && (
            <button type="button" className="btn" onClick={test} disabled={busy}>
              Send a test notification
            </button>
          )}
          {state === 'subscribed' && (
            <button type="button" className="btn btn-ghost" onClick={disable} disabled={busy}>
              Turn off on this device
            </button>
          )}
        </div>

        {message && (
          <div className={`alert alert-${message.kind}`} role="status">
            {message.text}
          </div>
        )}

        <label className="switch-row">
          <input type="checkbox" role="switch" checked={discreet} onChange={(e) => onDiscreetChange(e.target.checked)} />
          <span>
            <strong>Discreet notifications</strong>
            <span className="field-hint" style={{ display: 'block' }}>
              Show "Time for your medication" without the medication name. The name is then never sent to the reminder
              server or shown on your lock screen.
            </span>
          </span>
        </label>

        <p className="muted notif-summary">
          {enabledMedCount} medication{enabledMedCount === 1 ? '' : 's'} with reminders on.
          {lastSync && lastSync.mode !== 'off' && ` ${lastSync.count} upcoming reminders scheduled (${lastSync.mode === 'push' ? 'push' : 'while open'}).`}
        </p>
        {!platform.isIOS && (
          <p className="muted notif-summary">
            Desktop tip: your operating system's Focus or Do Not Disturb mode can hide notifications.
          </p>
        )}
      </div>
    </Modal>
  );
}
