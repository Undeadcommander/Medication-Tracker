import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { deleteAccount, type DeleteStep } from '../lib/account';
import type { User } from '../lib/auth';
import { describeKeyError, type SyncHandle } from '../lib/sync';
import { SyncCryptoError } from '../lib/syncCrypto';
import { Modal } from './Modal';

interface Props {
  user: User;
  sync: SyncHandle | null;
  medicationCount: number;
  doseLogCount: number;
  /** Open the export dialog instead, to keep a backup. */
  onExport: () => void;
  /**
   * The account's data was deleted, and this tab's session has ended. `problem`: what didn't work
   * after that (worded for the user), to show instead of the usual message.
   */
  onDeleted: (problem?: string) => void;
  onClose: () => void;
}

const CONFIRM_WORD = 'DELETE';

const STEP_TEXT: Record<DeleteStep, string> = {
  confirming: 'Confirm with Google in the pop-up…',
  cloud: 'Deleting your cloud data…',
  device: 'Removing data from this device…',
  account: 'Deleting your sign-in account…',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function describe(e: unknown): string {
  // Firestore and sync errors carry a code; auth errors are already worded for people.
  if (e instanceof SyncCryptoError || typeof (e as { code?: unknown })?.code === 'string') return describeKeyError(e);
  return e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.';
}

export function DeleteAccountDialog({ user, sync, medicationCount, doseLogCount, onExport, onDeleted, onClose }: Props) {
  const id = useId();
  const google = user.provider === 'google';
  const [typed, setTyped] = useState('');
  const [step, setStep] = useState<DeleteStep | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = step !== null;
  const confirmed = typed.trim().toUpperCase() === CONFIRM_WORD;
  // Closed (e.g. the account was deleted in another tab and this tab signed out) before a deletion
  // started here finished (a Google pop-up still open): its result is for a session that's over.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const onDeletedRef = useRef(onDeleted);
  onDeletedRef.current = onDeleted;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!confirmed || busy) return;
    setError(null);
    setStep(google ? 'confirming' : 'device');
    // No await before deleteAccount: Google's confirmation pop-up has to open within this tap.
    deleteAccount(user, sync, (s) => mounted.current && setStep(s))
      .then((result) => {
        if (!mounted.current) return;
        setStep(null);
        // (Deleted, even if something after that failed: the session has ended, so this tab signs out.)
        if (result.deleted) onDeletedRef.current(result.problem);
      })
      .catch((err) => {
        if (!mounted.current) return;
        setStep(null);
        setError(describe(err));
      });
  };

  const what = medicationCount || doseLogCount
    ? `${plural(medicationCount, 'medication')} and ${plural(doseLogCount, 'dose record')}`
    : 'Your medications and dose history';

  return (
    <Modal
      title={google ? 'Delete account' : 'Delete all data'}
      onClose={busy ? () => {} : onClose}
      maxWidth={480}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" form={`${id}-form`} className="btn btn-danger" disabled={!confirmed || busy} aria-busy={busy}>
            {busy ? 'Deleting…' : google ? 'Delete account' : 'Delete all data'}
          </button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        {google ? (
          <>
            <p>This permanently deletes your Amendra account and everything stored for it:</p>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
              <li>{what}, on this device and in the cloud</li>
              <li>Your encrypted cloud copy and its encryption settings</li>
              <li>Your Amendra sign-in and the reminders on this device</li>
            </ul>
            <p className="muted" style={{ fontSize: '0.9rem' }}>
              Your Google account itself isn't affected. Other devices signed in to this account remove their copies
              the next time they're online with Amendra open.
            </p>
          </>
        ) : (
          <p>
            This permanently deletes {what.charAt(0).toLowerCase() + what.slice(1)} from this device, and cancels its
            reminders.
          </p>
        )}

        <div className="alert alert-warning" role="note">
          This can't be undone.{' '}
          {medicationCount > 0 && (
            <>
              Want a copy first?{' '}
              <button type="button" className="btn-link" onClick={onExport} disabled={busy}>
                Export a backup
              </button>
              .
            </>
          )}
        </div>

        <div className="field">
          <label htmlFor={`${id}-confirm`}>
            Type <strong>{CONFIRM_WORD}</strong> to confirm
          </label>
          <input
            id={`${id}-confirm`}
            className="input"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
            disabled={busy}
          />
          {google && <span className="field-hint">Google will ask you to confirm your account before anything is deleted.</span>}
        </div>

        {step && (
          <div className="muted" role="status">
            {STEP_TEXT[step]}
          </div>
        )}
        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}
      </form>
    </Modal>
  );
}
