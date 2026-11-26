import { useEffect, useRef, useState } from 'react';
import {
  BUILD_ID,
  currentGoogleUser,
  FIREBASE_CONFIGURED,
  GUEST_USER,
  isStandaloneIOS,
  lastSignInAttempt,
  noteSignInStalled,
  preloadFirebaseAuth,
  signInWithGoogle,
  type User,
} from '../lib/auth';
import { preloadSync } from '../lib/sync';

/** Back in the app with no result after this long: the result probably isn't coming. */
const STALL_AFTER_RETURN_MS = 8_000;
/** Or this long after the tap, whatever the app was told (time to type a password, 2FA, …). */
const STALL_AFTER_START_MS = 60_000;

function describeAttempt(): string | null {
  const a = lastSignInAttempt();
  if (!a) return null;
  const when = new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${a.method}${a.standalone ? ' · home-screen app' : ''} · ${a.result}${a.code ? ` (${a.code})` : ''} · ${when}`;
}

interface Props {
  onSignIn: (user: User) => void;
  /**
   * An error from signing in (e.g. a redirect sign-in's, or one the app found afterwards). A new
   * object each time, so the same message given again is shown again.
   */
  initialError?: { message: string } | null;
  /** Informational message, e.g. after deleting an account. */
  notice?: string | null;
  /**
   * The chosen account was deleted on this device and its old data is still being removed (perhaps
   * by another tab, which can take up to a minute): the choice takes effect once that's done.
   */
  waiting?: User | null;
  /** Give up waiting (and on that choice), to choose again. */
  onCancelWaiting?: () => void;
}

function GoogleLogo() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden>
      <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z" />
      <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z" />
      <path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z" />
      <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z" />
    </svg>
  );
}

export function SignInScreen({ onSignIn, initialError = null, notice = null, waiting = null, onCancelWaiting }: Props) {
  const [error, setError] = useState<string | null>(initialError?.message ?? null);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [stalled, setStalled] = useState(false);
  const [attempt, setAttempt] = useState(describeAttempt);
  /** Only the latest tap's sign-in may change the screen (an abandoned one can settle late). */
  const attemptSeq = useRef(0);
  const onSignInRef = useRef(onSignIn);
  onSignInRef.current = onSignIn;
  const googleBtn = useRef<HTMLButtonElement>(null);
  const guestBtn = useRef<HTMLButtonElement>(null);
  const waitingCancel = useRef<HTMLButtonElement>(null);
  /** The button the latest choice was made with: focus goes back to it if that choice is given up. */
  const origin = useRef<'google' | 'guest'>('google');

  /**
   * The Google sign-in of attempt `seq` has an account: hand it over, once (the popup's result and
   * the account found on coming back can both arrive, and the screen may stay up, e.g. while an
   * old copy of the account is removed). Later results of the same attempt are ignored.
   */
  const deliver = (seq: number, user: User) => {
    if (seq !== attemptSeq.current) return;
    attemptSeq.current++;
    setBusy(false);
    setAttempt(describeAttempt());
    onSignInRef.current(user);
  };

  // Waiting for the chosen account's old data to be removed: the button used is disabled meanwhile,
  // so focus moves to the waiting box's Cancel; once it's over (given up, or failed) and this
  // screen is still up, back to that button.
  const wasWaiting = useRef(false);
  useEffect(() => {
    if (waiting) {
      wasWaiting.current = true;
      waitingCancel.current?.focus();
    } else if (wasWaiting.current) {
      wasWaiting.current = false;
      (origin.current === 'guest' || !googleBtn.current ? guestBtn.current : googleBtn.current)?.focus();
    }
  }, [waiting]);

  // A redirect sign-in's error (or the app's) arrives after this screen has mounted.
  useEffect(() => {
    if (initialError) setError(initialError.message);
    setAttempt(describeAttempt());
  }, [initialError]);

  // Load Firebase before the tap so the popup opens straight from it (Safari blocks it otherwise).
  useEffect(() => {
    if (!FIREBASE_CONFIGURED) return;
    let alive = true;
    preloadFirebaseAuth()
      .then(() => alive && setReady(true))
      .catch(() => alive && setReady(true)); // signInWithGoogle retries the load and reports errors
    return () => {
      alive = false;
    };
  }, []);

  // While Google's page is open in an iPhone/iPad Home Screen app: when the user comes back to the
  // app, a finished sign-in should follow within a second or two. Sometimes it never does (and
  // Firebase can't tell the page was closed), which used to leave "Signing in…" up forever.
  // Elsewhere Firebase sees the popup close by itself, and the app window can regain focus while
  // the popup is still open, so only the long timeout applies.
  useEffect(() => {
    if (!busy) return setStalled(false);
    const seq = attemptSeq.current;
    const watchReturns = isStandaloneIOS();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stallIn = (ms: number) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        setStalled(true);
        noteSignInStalled();
        setAttempt(describeAttempt());
      }, ms);
    };
    const onReturn = () => {
      if (document.visibilityState !== 'visible') return;
      // Firebase may have the account already even though the popup call hasn't heard.
      void currentGoogleUser()
        .then((u) => u && deliver(seq, u))
        .catch(() => {});
      stallIn(STALL_AFTER_RETURN_MS);
    };
    stallIn(STALL_AFTER_START_MS);
    if (!watchReturns) return () => clearTimeout(timer);
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('focus', onReturn);
    window.addEventListener('pageshow', onReturn);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('focus', onReturn);
      window.removeEventListener('pageshow', onReturn);
    };
  }, [busy]);

  const signIn = async () => {
    const seq = ++attemptSeq.current;
    origin.current = 'google';
    setBusy(true);
    setStalled(false);
    setError(null);
    // Opens the popup before anything else is awaited (Safari needs it inside the tap).
    const pending = signInWithGoogle();
    preloadSync(); // fetch the sync code while the user is on Google's page
    try {
      const user = await pending;
      if (user) deliver(seq, user);
    } catch (e) {
      if (seq === attemptSeq.current) setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      if (seq === attemptSeq.current) {
        setBusy(false);
        setAttempt(describeAttempt());
      }
    }
  };

  /** Give up on the pending sign-in (it can't be cancelled, but its result is ignored). */
  const cancelSignIn = () => {
    attemptSeq.current++;
    setBusy(false);
    setAttempt(describeAttempt());
  };

  return (
    <main className="signin">
      <div className="signin-card card">
        <img src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" width={64} height={64} className="signin-logo" />
        <h1>Amendra</h1>
        <p className="muted">Keep track of your medications, schedules and reminders, all in one place.</p>

        {notice && (
          <div className="alert alert-success" role="status">
            {notice}
          </div>
        )}

        {FIREBASE_CONFIGURED ? (
          <button
            ref={googleBtn}
            type="button"
            className="btn google-btn"
            onClick={signIn}
            disabled={busy || !ready || Boolean(waiting)}
            aria-busy={busy || !ready}
          >
            {busy || !ready ? <span className="spinner" aria-hidden /> : <GoogleLogo />}
            {busy ? (stalled ? 'Still signing in…' : 'Signing in…') : ready ? 'Sign in with Google' : 'Loading…'}
          </button>
        ) : (
          <div className="alert alert-warning" role="note">
            Google sign-in isn't configured yet. Add your Firebase settings to <code>.env</code> (see README).
          </div>
        )}

        {busy && stalled && !waiting && (
          <div className="alert alert-warning signin-stalled" role="status">
            <p>
              This is taking longer than it should. If you've finished signing in with Google, reload Amendra to pick up
              your account.
            </p>
            <div className="signin-stalled-actions">
              <button type="button" className="btn btn-sm btn-primary" onClick={() => location.reload()}>
                Reload
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={cancelSignIn}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {waiting && (
          <div className="alert alert-warning signin-stalled" role="status">
            <p>
              <span className="spinner" aria-hidden /> Removing this account's old data from this device before{' '}
              {waiting.provider === 'guest' ? 'starting over' : 'signing in'}… If it's still being deleted in another tab, this
              can take up to a minute.
            </p>
            <div className="signin-stalled-actions">
              <button ref={waitingCancel} type="button" className="btn btn-sm btn-ghost" onClick={onCancelWaiting}>
                Cancel
              </button>
            </div>
          </div>
        )}

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}

        <div className="signin-divider">
          <span>or</span>
        </div>
        <button
          ref={guestBtn}
          type="button"
          className="btn btn-ghost"
          disabled={Boolean(waiting)}
          onClick={() => {
            attemptSeq.current++; // a Google sign-in still pending mustn't replace this choice
            origin.current = 'guest';
            setBusy(false);
            setError(null);
            onSignIn(GUEST_USER);
          }}
        >
          Continue without an account
        </button>
        <p className="signin-privacy muted">
          Sign in with Google to sync your medications across your devices. Only your account can read them.
          Without an account, everything stays on this device.
        </p>
        <p className="signin-diag muted" aria-label="Diagnostics">
          Build {BUILD_ID}
          {attempt && <> · Last sign-in: {attempt}</>}
        </p>
      </div>
    </main>
  );
}
