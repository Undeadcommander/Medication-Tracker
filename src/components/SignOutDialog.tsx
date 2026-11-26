import { useEffect, useRef, useState } from 'react';
import { signOutAndClear, type SignOutProblem } from '../lib/account';
import type { User } from '../lib/auth';
import type { SyncHandle } from '../lib/sync';
import { Modal } from './Modal';

interface Props {
  user: User;
  sync: SyncHandle | null;
  /** Record "Mark as taken" taps from notifications that are still waiting. */
  applyPendingTakes: () => Promise<{ applied: number; waiting: number }>;
  /** The account's data isn't open here (locked, possibly from another tab while this is open). */
  locked?: boolean;
  /** Open the cloud encryption dialog instead (to unlock or set up sync). */
  onUnlock: () => void;
  /** Open the export dialog instead, to keep a backup (not while locked: the data isn't shown then). */
  onExport?: () => void;
  /** Signed out, and this device's copy removed. */
  onSignedOut: (message: string) => void;
  onClose: () => void;
}

type Phase =
  | { kind: 'saving'; remaining?: number }
  | { kind: 'problem'; problem: SignOutProblem }
  /** "Sign out anyway" chosen: confirm losing what isn't in the cloud. */
  | { kind: 'confirm'; problem: SignOutProblem }
  | { kind: 'device' }
  /** Failed; `wiping`: while removing this device's data (after the cloud was brought up to date, or the user agreed). */
  | { kind: 'error'; message: string; wiping: boolean };

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

const REASON_TEXT: Record<SignOutProblem['reason'], string> = {
  offline: "You're offline, so your latest changes can't be saved to the cloud.",
  locked: "Cloud sync is locked on this device, so its changes can't be uploaded until you unlock it.",
  setup: "Encrypted cloud sync isn't set up for this account, so nothing on this device has been saved to the cloud.",
  refused: 'The cloud refused some changes, so they were only saved on this device.',
  deleting: 'This account is being deleted on another device.',
  error: "Your changes couldn't be saved to the cloud.",
  timeout: "The cloud didn't confirm your changes in time.",
  'not-ready': "Cloud sync is still starting, so Amendra can't tell yet whether everything is saved in the cloud.",
  busy: 'This account is already being signed out or deleted in another tab.',
};

function names(list: string[]): string {
  const shown = list.slice(0, 3);
  const more = list.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${plural(more, 'other')}`;
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
}

/** What isn't in the cloud, one line per kind. */
function unsyncedLines({ pending: p, waitingTakes }: SignOutProblem): string[] {
  const lines: string[] = [];
  if (p?.hidden) {
    // Locked: what it is can't be shown, only that it's there.
    if (p.hidden.unmerged) lines.push('Everything on this device (unlock cloud sync to see it)');
    else if (p.hidden.changes) lines.push(plural(p.hidden.changes, 'change') + ' made on this device (unlock cloud sync to see them)');
  } else if (p?.unmerged) {
    lines.push(`Everything on this device: ${plural(p.unmerged.medications, 'medication')} and ${plural(p.unmerged.doseLogs, 'dose record')}`);
  } else if (p) {
    if (p.medications.length) lines.push(`Changes to ${names(p.medications)}`);
    if (p.deletedMedications) lines.push(plural(p.deletedMedications, 'deleted medication'));
    if (p.doseLogs) lines.push(`${plural(p.doseLogs, 'dose record')} logged, changed or removed`);
  }
  if (p?.refused) lines.push(`${plural(p.refused, 'change')} the cloud refused`);
  if (waitingTakes) lines.push(`${plural(waitingTakes, 'dose', 'doses')} marked as taken from a notification`);
  return lines;
}

/** What's waiting, without anything of the data itself (names), for once it's locked. */
export function withoutDetails(problem: SignOutProblem): SignOutProblem {
  const p = problem.pending;
  if (!p || p.hidden) return problem;
  const changes = p.medications.length + p.deletedMedications + p.doseLogs;
  return {
    ...problem,
    pending: { medications: [], deletedMedications: 0, doseLogs: 0, refused: p.refused, hidden: { changes, unmerged: !!p.unmerged } },
  };
}

/**
 * Sign out of a synced account: save everything to the cloud, then remove it from this device.
 * Nothing is removed if the cloud can't be brought up to date, unless the user confirms losing it.
 */
export function SignOutDialog({ user, sync, applyPendingTakes, locked = false, onUnlock, onExport, onSignedOut, onClose }: Props) {
  const [phase, setPhase] = useState<Phase>({ kind: 'saving' });
  const lockedRef = useRef(locked);
  lockedRef.current = locked;
  // Locked while this is open (e.g. in another tab): stop showing what the data is.
  useEffect(() => {
    if (!locked) return;
    setPhase((ph) => (ph.kind === 'problem' || ph.kind === 'confirm' ? { ...ph, problem: withoutDetails(ph.problem) } : ph));
  }, [locked]);
  const abortRef = useRef<AbortController | null>(null);
  // The latest of each (sync may finish starting while this is open).
  const latest = useRef({ sync, applyPendingTakes, onSignedOut });
  latest.current = { sync, applyPendingTakes, onSignedOut };

  const run = async (discardUnsynced: boolean) => {
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    const live = () => !ctrl.signal.aborted;
    let wiping = discardUnsynced;
    setPhase(discardUnsynced ? { kind: 'device' } : { kind: 'saving' });
    try {
      const result = await signOutAndClear(user, latest.current.sync, {
        applyPendingTakes: () => latest.current.applyPendingTakes(),
        discardUnsynced,
        signal: ctrl.signal,
        onStep: (step) => {
          if (step !== 'device') return;
          wiping = true;
          if (live()) setPhase({ kind: 'device' });
        },
        onProgress: (remaining) => live() && setPhase({ kind: 'saving', remaining }),
      });
      if (result.status === 'signed-out') {
        // (Its session here has ended: never back to the tracker, even if part of the wipe failed.)
        latest.current.onSignedOut(
          result.problem ??
          (discardUnsynced
            ? "You signed out and your data was removed from this device. Changes that weren't saved to the cloud were deleted."
            : 'You signed out. Your data is saved in the cloud and was removed from this device.'),
        );
      } else if (result.status === 'blocked' && live()) {
        setPhase({ kind: 'problem', problem: lockedRef.current ? withoutDetails(result.problem) : result.problem });
      }
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : 'Something went wrong. Please try again.';
      if (live()) setPhase({ kind: 'error', message, wiping });
    }
  };

  // Start saving as soon as this opens (the user just chose "Sign out").
  useEffect(() => {
    void run(false);
    return () => abortRef.current?.abort();
  }, []);

  const removing = phase.kind === 'device';
  const cancel = () => {
    if (removing) return; // can't be stopped halfway
    abortRef.current?.abort();
    onClose();
  };

  let body;
  let footer;
  if (phase.kind === 'saving' || phase.kind === 'device') {
    body = (
      <>
        <p>Before you're signed out, everything on this device is saved to the cloud. Then it's removed from this device.</p>
        <div className="sync-note" role="status">
          <span className="spinner" aria-hidden />
          {phase.kind === 'device'
            ? 'Removing your data from this device…'
            : `Saving your data to the cloud…${phase.remaining ? ` ${plural(phase.remaining, 'change')} left.` : ''}`}
        </div>
      </>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={cancel} disabled={removing}>
          Cancel
        </button>
        <button type="button" className="btn btn-primary" disabled aria-busy>
          Signing out…
        </button>
      </>
    );
  } else if (phase.kind === 'problem') {
    const problem = locked ? withoutDetails(phase.problem) : phase.problem;
    const lines = unsyncedLines(problem);
    body = (
      <>
        <div className="alert alert-warning" role="alert">
          <strong>You haven't been signed out.</strong> {REASON_TEXT[problem.reason]}
          {problem.message && problem.message !== REASON_TEXT[problem.reason] && <> ({problem.message})</>}
        </div>
        {lines.length > 0 ? (
          <>
            <p>Not in the cloud yet:</p>
            <ul style={{ margin: 0, paddingLeft: 20, display: 'grid', gap: 4 }}>
              {lines.map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
          </>
        ) : (
          <p>Some changes on this device may not be in the cloud yet.</p>
        )}
        <p className="muted" style={{ fontSize: '0.9rem' }}>
          Signing out removes everything from this device, so stay signed in until it's saved
          {problem.reason === 'offline' ? ' (try again once you are online)' : ''}
          {onExport ? ', or export a backup to keep a copy.' : '.'}
        </p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          {(problem.reason === 'locked' || problem.reason === 'setup') && (
            <button type="button" className="btn btn-sm" onClick={onUnlock}>
              {problem.reason === 'locked' ? '🔑 Unlock cloud sync' : '🔑 Set up encrypted sync'}
            </button>
          )}
          {onExport && (
            <button type="button" className="btn btn-sm" onClick={onExport}>
              🔐 Export a backup
            </button>
          )}
          <button type="button" className="btn btn-sm btn-ghost account-item-danger" onClick={() => setPhase({ kind: 'confirm', problem })}>
            Sign out anyway…
          </button>
        </div>
      </>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={cancel}>
          Stay signed in
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void run(false)}>
          Try again
        </button>
      </>
    );
  } else if (phase.kind === 'confirm') {
    const problem = locked ? withoutDetails(phase.problem) : phase.problem;
    const lines = unsyncedLines(problem);
    body = (
      <div className="alert alert-error" role="alert">
        <p>
          <strong>Delete unsaved changes?</strong>
        </p>
        <p>
          {lines.length
            ? `${lines.join('; ')}. These aren't in the cloud and will be permanently deleted along with everything else on this device.`
            : "Anything on this device that isn't in the cloud will be permanently deleted along with everything else on it."}{' '}
          This can't be undone.
        </p>
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={() => setPhase({ kind: 'problem', problem })}>
          Back
        </button>
        <button type="button" className="btn btn-danger" onClick={() => void run(true)}>
          Delete unsaved changes and sign out
        </button>
      </>
    );
  } else {
    body = (
      <div className="alert alert-error" role="alert">
        {phase.message}
      </div>
    );
    footer = (
      <>
        <button type="button" className="btn" onClick={cancel}>
          Close
        </button>
        <button type="button" className="btn btn-primary" onClick={() => void run(phase.wiping)}>
          Try again
        </button>
      </>
    );
  }

  return (
    <Modal title="Sign out" onClose={cancel} maxWidth={480} footer={footer}>
      <div style={{ display: 'grid', gap: 14 }}>{body}</div>
    </Modal>
  );
}
