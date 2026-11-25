import { useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { describeKeyError, type PreparedKeyChange, type SyncHandle, type SyncStatus } from '../lib/sync';
import { looksLikeRecoveryKey, MIN_SYNC_PASSPHRASE_LENGTH, SyncCryptoError } from '../lib/syncCrypto';
import { estimatePassphraseStrength, generatePassphrase } from '../lib/vault';
import { Modal } from './Modal';
import './ExportImportDialog.css';

interface Props {
  status: SyncStatus | null;
  controls: SyncHandle | null;
  onClose: () => void;
}

// ---------------------------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------------------------

function usePassphrasePair() {
  const [pass, setPass] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const strength = useMemo(() => estimatePassphraseStrength(pass), [pass]);
  const tooShort = pass.length < MIN_SYNC_PASSPHRASE_LENGTH;
  const mismatch = confirm.length > 0 && pass !== confirm;
  let problem: string | null = null;
  if (pass && tooShort) problem = `Use at least ${MIN_SYNC_PASSPHRASE_LENGTH} characters (${MIN_SYNC_PASSPHRASE_LENGTH - pass.length} more).`;
  else if (pass && strength.score < 1) problem = 'That passphrase is too easy to guess. Try a longer one or use the generator.';
  else if (mismatch) problem = 'The two passphrases do not match.';
  const valid = !tooShort && strength.score >= 1 && pass === confirm;
  const clear = () => {
    setPass('');
    setConfirm('');
  };
  return { pass, setPass, confirm, setConfirm, show, setShow, strength, problem, valid, mismatch, clear };
}

function PassphraseFields({ p, label = 'Sync passphrase' }: { p: ReturnType<typeof usePassphrasePair>; label?: string }) {
  const id = useId();
  const [generated, setGenerated] = useState(false);
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  const filled = p.pass ? Math.max(1, p.strength.score) : 0;
  return (
    <>
      <div className="field">
        <label htmlFor={`${id}-p`}>{label}</label>
        <div className="ei-input-row">
          <input
            id={`${id}-p`}
            className="input"
            type={p.show ? 'text' : 'password'}
            value={p.pass}
            onChange={(e) => {
              p.setPass(e.target.value);
              setGenerated(false);
            }}
            autoComplete="new-password"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
          />
          <button type="button" className="btn" onClick={() => p.setShow(!p.show)} aria-pressed={p.show}>
            {p.show ? 'Hide' : 'Show'}
          </button>
        </div>
        <span className="field-hint">At least {MIN_SYNC_PASSPHRASE_LENGTH} characters. Several random words work best.</span>
      </div>
      <div className="field">
        <label htmlFor={`${id}-c`}>Confirm passphrase</label>
        <input
          id={`${id}-c`}
          className="input"
          type={p.show ? 'text' : 'password'}
          value={p.confirm}
          onChange={(e) => p.setConfirm(e.target.value)}
          autoComplete="new-password"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={p.mismatch}
        />
      </div>
      <div className="ei-meter-wrap" aria-live="polite">
        <div className="ei-meter" data-score={p.pass ? p.strength.score : -1} aria-hidden="true">
          {[0, 1, 2, 3].map((i) => (
            <span key={i} className={i < filled ? 'on' : ''} />
          ))}
        </div>
        <span className="ei-meter-label">{p.pass ? `Strength: ${p.strength.label}` : 'Strength: not set'}</span>
      </div>
      {p.problem && (
        <div className="alert alert-warning" role="status">
          {p.problem}
        </div>
      )}
      <div>
        <button
          type="button"
          className="btn"
          onClick={() => {
            const g = generatePassphrase();
            p.setPass(g);
            p.setConfirm(g);
            p.setShow(true);
            setGenerated(true);
            setCopied(null);
          }}
        >
          Generate a strong passphrase
        </button>
      </div>
      {generated && (
        <div className="ei-generated" role="group" aria-label="Generated passphrase">
          <code className="ei-generated-text">{p.pass}</code>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => navigator.clipboard.writeText(p.pass).then(() => setCopied('ok'), () => setCopied('fail'))}
          >
            {copied === 'ok' ? 'Copied' : 'Copy'}
          </button>
          <p className="field-hint ei-generated-note">
            Save it in a password manager or write it down. You'll need it to unlock Amendra on a new device.
            {copied === 'fail' && ' Copying was blocked, so select the text and copy it manually.'}
          </p>
        </div>
      )}
    </>
  );
}

function printRecoveryKey(key: string) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;width:0;height:0;border:0;opacity:0';
  frame.setAttribute('aria-hidden', 'true');
  document.body.appendChild(frame);
  const doc = frame.contentDocument!;
  doc.open();
  doc.write('<!doctype html><title>Amendra recovery key</title>');
  doc.close();
  const h = doc.createElement('h1');
  h.textContent = 'Amendra recovery key';
  const k = doc.createElement('p');
  k.textContent = key;
  k.style.cssText = 'font:600 22px ui-monospace,Menlo,Consolas,monospace;letter-spacing:1px';
  const note = doc.createElement('p');
  note.textContent =
    'This key unlocks your encrypted Amendra cloud sync if you forget your sync passphrase. Keep it somewhere safe and private.';
  doc.body.append(h, k, note);
  frame.contentWindow?.focus();
  frame.contentWindow?.print();
  setTimeout(() => frame.remove(), 60_000);
}

function downloadRecoveryKey(key: string) {
  const text = `Amendra recovery key\n\n${key}\n\nThis key unlocks your encrypted Amendra cloud sync if you forget your sync passphrase.\nKeep it somewhere safe and private.\n`;
  const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'amendra-recovery-key.txt';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function RecoveryKeyCard({ recoveryKey }: { recoveryKey: string }) {
  const [copied, setCopied] = useState<'ok' | 'fail' | null>(null);
  return (
    <div className="enc-recovery" role="group" aria-label="Recovery key">
      <code className="enc-recovery-key">{recoveryKey}</code>
      <div className="enc-actions">
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => navigator.clipboard.writeText(recoveryKey).then(() => setCopied('ok'), () => setCopied('fail'))}
        >
          {copied === 'ok' ? 'Copied' : 'Copy'}
        </button>
        <button type="button" className="btn btn-sm" onClick={() => downloadRecoveryKey(recoveryKey)}>
          Download
        </button>
        <button type="button" className="btn btn-sm" onClick={() => printRecoveryKey(recoveryKey)}>
          Print
        </button>
      </div>
      {copied === 'fail' && <p className="field-hint">Copying was blocked, so write the key down instead.</p>}
    </div>
  );
}

function ErrorAlert({ error }: { error: string | null }) {
  return error ? (
    <div className="alert alert-error" role="alert">
      {error}
    </div>
  ) : null;
}

// ---------------------------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------------------------

type View =
  | { kind: 'main' }
  | { kind: 'setup-key'; prepared: PreparedKeyChange }
  | { kind: 'setup-done' }
  | { kind: 'recovered' }
  | { kind: 'show-key'; recoveryKey: string }
  | { kind: 'new-key'; prepared: PreparedKeyChange }
  | { kind: 'reset' }
  | { kind: 'reset-key'; prepared: PreparedKeyChange };

export function SyncEncryptionDialog({ status, controls, onClose }: Props) {
  const id = useId();
  const [view, setView] = useState<View>({ kind: 'main' });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [secret, setSecret] = useState('');
  const [secretShow, setSecretShow] = useState(false);
  const [useRecovery, setUseRecovery] = useState(false);
  const [confirmForget, setConfirmForget] = useState(false);
  const [resetText, setResetText] = useState('');
  const newPass = usePassphrasePair();

  const lock = status?.lock ?? 'checking';
  const go = (v: View) => {
    setView(v);
    setError(null);
    setSaved(false);
  };

  async function run<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
    if (!controls || busy) return undefined;
    setBusy(label);
    setError(null);
    setNotice(null);
    try {
      return await fn();
    } catch (e) {
      setError(describeKeyError(e));
      return undefined;
    } finally {
      setBusy(null);
    }
  }

  // ---- actions ----
  const onSetup = async (e: FormEvent) => {
    e.preventDefault();
    if (!newPass.valid) return;
    const prepared = await run('Creating your keys…', () => controls!.prepareSetup(newPass.pass));
    if (prepared) {
      newPass.clear();
      go({ kind: 'setup-key', prepared });
    }
  };

  const onFinish = async (prepared: PreparedKeyChange, next: View, message?: string) => {
    if (!saved) return;
    const ok = await run('Saving…', async () => {
      await prepared.finish();
      return true;
    });
    if (ok) {
      go(next);
      if (message) setNotice(message);
    }
  };

  const onUnlock = async (e: FormEvent) => {
    e.preventDefault();
    if (!secret) return;
    const kind = await run('Unlocking…', async (): Promise<'recovery' | 'passphrase'> => {
      if (useRecovery) {
        await controls!.unlock(secret, 'recovery');
        return 'recovery';
      }
      if (looksLikeRecoveryKey(secret)) {
        // Pasted a recovery key into the passphrase field? Try that first, then as a passphrase.
        try {
          await controls!.unlock(secret, 'recovery');
          return 'recovery';
        } catch (err) {
          if (!(err instanceof SyncCryptoError) || !['invalid-recovery-key', 'wrong-recovery-key'].includes(err.code)) throw err;
        }
      }
      await controls!.unlock(secret, 'passphrase');
      return 'passphrase';
    });
    if (kind) {
      setSecret('');
      if (kind === 'recovery') go({ kind: 'recovered' });
      else onClose();
    }
  };

  const onChangePass = async (e: FormEvent) => {
    e.preventDefault();
    if (!newPass.valid) return;
    const ok = await run('Changing passphrase…', async () => {
      await controls!.changePassphrase(newPass.pass);
      return true;
    });
    if (ok) {
      newPass.clear();
      go({ kind: 'main' });
      setNotice('Passphrase changed. Use the new one to unlock other devices. Devices that are already unlocked stay unlocked.');
    }
  };

  const onShowKey = async () => {
    const recoveryKey = await run('Loading…', () => controls!.getRecoveryKey());
    if (recoveryKey) go({ kind: 'show-key', recoveryKey });
  };

  const onNewKey = async () => {
    const prepared = await run('Creating a new recovery key…', () => controls!.prepareNewRecoveryKey());
    if (prepared) go({ kind: 'new-key', prepared });
  };

  const onForget = async () => {
    const ok = await run('Forgetting…', async () => {
      await controls!.forgetKey();
      return true;
    });
    if (ok) {
      setConfirmForget(false);
      onClose();
    }
  };

  const onReset = async (e: FormEvent) => {
    e.preventDefault();
    if (!newPass.valid || resetText.trim().toUpperCase() !== 'RESET') return;
    const prepared = await run('Creating new keys…', () => controls!.prepareReset(newPass.pass));
    if (prepared) {
      newPass.clear();
      setResetText('');
      go({ kind: 'reset-key', prepared });
    }
  };

  // ---- render ----
  const formId = `${id}-form`;
  let title = 'Cloud encryption';
  let body: ReactNode;
  let footer: ReactNode = (
    <button type="button" className="btn" onClick={onClose}>
      Close
    </button>
  );
  const busyNote = busy && (
    <div className="alert" role="status">
      {busy}
    </div>
  );

  const saveConfirm = (
    <label className="enc-check">
      <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
      <span>I've saved my recovery key somewhere safe.</span>
    </label>
  );

  if (view.kind === 'setup-key' || view.kind === 'new-key' || view.kind === 'reset-key') {
    title = view.kind === 'new-key' ? 'Your new recovery key' : 'Save your recovery key';
    body = (
      <div className="ei-panel">
        <p className="ei-lead">
          If you ever forget your sync passphrase, this recovery key is the only other way to unlock your synced data.
          Print it, write it down, or keep it in a password manager, separate from your passphrase.
          {view.kind === 'new-key' && ' Your old recovery key stops working once you save this one.'}
        </p>
        <RecoveryKeyCard recoveryKey={view.prepared.recoveryKey} />
        {saveConfirm}
        {busyNote}
        <ErrorAlert error={error} />
      </div>
    );
    const prepared = view.prepared;
    footer = (
      <>
        <button type="button" className="btn" onClick={() => go({ kind: 'main' })} disabled={!!busy}>
          Cancel
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!saved || !!busy}
          onClick={() =>
            view.kind === 'new-key'
              ? onFinish(prepared, { kind: 'main' }, 'New recovery key saved. The old one no longer works.')
              : onFinish(prepared, { kind: 'setup-done' })
          }
        >
          {view.kind === 'new-key' ? 'Save new recovery key' : 'Turn on encrypted sync'}
        </button>
      </>
    );
  } else if (view.kind === 'setup-done') {
    title = 'Encrypted sync is on';
    body = (
      <div className="ei-panel">
        <div className="alert alert-success" role="status">
          Your medications and dose history are now encrypted on this device before they're uploaded.
        </div>
        <p className="ei-lead">
          On your other devices, sign in with the same Google account and enter your sync passphrase (or recovery key)
          once. Each device remembers its key until you sign out.
        </p>
      </div>
    );
    footer = (
      <button type="button" className="btn btn-primary" onClick={onClose}>
        Done
      </button>
    );
  } else if (view.kind === 'show-key') {
    title = 'Your recovery key';
    body = (
      <div className="ei-panel">
        <p className="ei-lead">Keep this somewhere safe and private. Anyone with it (and your Google account) can read your synced data.</p>
        <RecoveryKeyCard recoveryKey={view.recoveryKey} />
      </div>
    );
    footer = (
      <button type="button" className="btn" onClick={() => go({ kind: 'main' })}>
        Back
      </button>
    );
  } else if (view.kind === 'recovered') {
    title = 'Unlocked with your recovery key';
    body = (
      <div className="ei-panel">
        <div className="alert alert-success" role="status">
          This device is unlocked and syncing.
        </div>
        <p className="ei-lead">If you've forgotten your sync passphrase, set a new one now.</p>
        <form id={formId} className="ei-form" onSubmit={onChangePass} autoComplete="off">
          <PassphraseFields p={newPass} label="New sync passphrase" />
        </form>
        {busyNote}
        <ErrorAlert error={error} />
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={onClose}>
          Not now
        </button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={!newPass.valid || !!busy}>
          Set new passphrase
        </button>
      </>
    );
  } else if (view.kind === 'reset') {
    title = 'Start over with new keys';
    body = (
      <div className="ei-panel">
        <div className="alert alert-warning" role="status">
          This deletes the encrypted copy in the cloud and uploads this device's data with new keys. Anything that exists
          only on another device, or only in the cloud, is lost. Other devices will need the new passphrase.
        </div>
        <form id={formId} className="ei-form" onSubmit={onReset} autoComplete="off">
          <PassphraseFields p={newPass} label="New sync passphrase" />
          <div className="field">
            <label htmlFor={`${id}-reset`}>Type RESET to confirm</label>
            <input
              id={`${id}-reset`}
              className="input"
              value={resetText}
              onChange={(e) => setResetText(e.target.value)}
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
        </form>
        {busyNote}
        <ErrorAlert error={error} />
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={() => go({ kind: 'main' })}>
          Cancel
        </button>
        <button
          type="submit"
          form={formId}
          className="btn btn-danger"
          disabled={!newPass.valid || resetText.trim().toUpperCase() !== 'RESET' || !!busy}
        >
          Delete cloud copy and start over
        </button>
      </>
    );
  } else if (lock === 'checking') {
    body = (
      <div className="ei-panel">
        {status?.state === 'error' ? (
          <div className="alert alert-error" role="alert">
            {status.message}
          </div>
        ) : (
          <p className="ei-lead">Loading this account's encryption settings… This needs an internet connection the first time.</p>
        )}
      </div>
    );
  } else if (lock === 'needs-setup') {
    title = 'Turn on encrypted sync';
    body = (
      <div className="ei-panel">
        <p className="ei-lead">
          Amendra encrypts your medications and dose history on this device before syncing them, so only you can read
          them. Not Google, and not the app's developer. Choose a sync passphrase: you'll enter it once on each new
          device.
        </p>
        <form id={formId} className="ei-form" onSubmit={onSetup} autoComplete="off">
          <PassphraseFields p={newPass} />
        </form>
        <p className="field-hint">
          Until you do this, your data stays on this device only. If you lose both the passphrase and the recovery key
          you'll get next, the cloud copy can't be recovered (data on your devices is kept).
        </p>
        {busyNote}
        <ErrorAlert error={error} />
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={onClose}>
          Not now
        </button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={!newPass.valid || !!busy}>
          Continue
        </button>
      </>
    );
  } else if (lock === 'locked') {
    title = 'Unlock cloud sync';
    body = (
      <div className="ei-panel">
        {status?.warning && (
          <div className="alert alert-warning" role="status">
            {status.warning}
          </div>
        )}
        <p className="ei-lead">
          Your synced data is end-to-end encrypted. Enter your sync passphrase to unlock this device. It stays unlocked
          until you sign out. Until then, changes are kept on this device and upload once it's unlocked.
        </p>
        <form id={formId} className="ei-form" onSubmit={onUnlock} autoComplete="off">
          <div className="field">
            <label htmlFor={`${id}-secret`}>{useRecovery ? 'Recovery key' : 'Sync passphrase'}</label>
            <div className="ei-input-row">
              <input
                id={`${id}-secret`}
                className="input"
                type={secretShow || useRecovery ? 'text' : 'password'}
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
                autoComplete={useRecovery ? 'off' : 'current-password'}
                autoCapitalize={useRecovery ? 'characters' : 'none'}
                autoCorrect="off"
                spellCheck={false}
                placeholder={useRecovery ? 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX' : undefined}
                autoFocus
              />
              {!useRecovery && (
                <button type="button" className="btn" onClick={() => setSecretShow((s) => !s)} aria-pressed={secretShow}>
                  {secretShow ? 'Hide' : 'Show'}
                </button>
              )}
            </div>
          </div>
        </form>
        <div className="enc-actions">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              setUseRecovery((r) => !r);
              setSecret('');
              setError(null);
            }}
          >
            {useRecovery ? 'Use my passphrase instead' : 'Forgot it? Use your recovery key'}
          </button>
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => go({ kind: 'reset' })}>
            Lost both? Start over
          </button>
        </div>
        {busyNote}
        <ErrorAlert error={error} />
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={onClose}>
          Not now
        </button>
        <button type="submit" form={formId} className="btn btn-primary" disabled={!secret || !!busy}>
          Unlock
        </button>
      </>
    );
  } else {
    // unlocked
    body = (
      <div className="ei-panel">
        <div className="alert alert-success" role="status">
          🔒 End-to-end encryption is on. This device is unlocked, and only ciphertext is stored in the cloud.
        </div>
        {status?.warning && (
          <div className="alert alert-warning" role="status">
            {status.warning}
          </div>
        )}
        {notice && (
          <div className="alert alert-success" role="status">
            {notice}
          </div>
        )}

        <section className="enc-section">
          <h3>Recovery key</h3>
          <p className="field-hint">Unlocks your data if you forget the passphrase.</p>
          <div className="enc-actions">
            <button type="button" className="btn btn-sm" onClick={onShowKey} disabled={!!busy}>
              Show recovery key
            </button>
            <button type="button" className="btn btn-sm" onClick={onNewKey} disabled={!!busy}>
              Create a new one
            </button>
          </div>
        </section>

        <section className="enc-section">
          <h3>Change sync passphrase</h3>
          <form id={formId} className="ei-form" onSubmit={onChangePass} autoComplete="off">
            <PassphraseFields p={newPass} label="New sync passphrase" />
            <div>
              <button type="submit" className="btn btn-primary btn-sm" disabled={!newPass.valid || !!busy}>
                Change passphrase
              </button>
            </div>
          </form>
        </section>

        <section className="enc-section">
          <h3>This device</h3>
          <p className="field-hint">
            Forgetting the key pauses sync here until you unlock again. Your data on this device is kept. Signing out
            also forgets it.
          </p>
          {confirmForget ? (
            <div className="enc-actions">
              <button type="button" className="btn btn-sm" onClick={() => setConfirmForget(false)}>
                Cancel
              </button>
              <button type="button" className="btn btn-danger btn-sm" onClick={onForget} disabled={!!busy}>
                Yes, forget the key
              </button>
            </div>
          ) : (
            <div>
              <button type="button" className="btn btn-sm" onClick={() => setConfirmForget(true)}>
                Forget key on this device
              </button>
            </div>
          )}
        </section>
        {busyNote}
        <ErrorAlert error={error} />
      </div>
    );
  }

  return (
    <Modal title={title} onClose={busy ? () => undefined : onClose} footer={footer} maxWidth={560}>
      {body}
    </Modal>
  );
}
