import { useEffect, useState } from 'react';
import {
  BUILD_ID,
  FIREBASE_CONFIGURED,
  GUEST_USER,
  lastSignInAttempt,
  preloadFirebaseAuth,
  signInWithGoogle,
  type User,
} from '../lib/auth';

function describeAttempt(): string | null {
  const a = lastSignInAttempt();
  if (!a) return null;
  const when = new Date(a.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  return `${a.method}${a.standalone ? ' · home-screen app' : ''} · ${a.result}${a.code ? ` (${a.code})` : ''} · ${when}`;
}

interface Props {
  onSignIn: (user: User) => void;
  /** Error carried over from a redirect sign-in. */
  initialError?: string | null;
  /** Informational message, e.g. after deleting an account. */
  notice?: string | null;
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

export function SignInScreen({ onSignIn, initialError = null, notice = null }: Props) {
  const [error, setError] = useState<string | null>(initialError);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [attempt, setAttempt] = useState(describeAttempt);

  // A redirect sign-in's error arrives after this screen has mounted.
  useEffect(() => {
    if (initialError) setError(initialError);
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

  const signIn = async () => {
    setBusy(true);
    setError(null);
    try {
      const user = await signInWithGoogle();
      if (user) onSignIn(user);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed');
    } finally {
      setBusy(false);
      setAttempt(describeAttempt());
    }
  };

  return (
    <main className="signin">
      <div className="signin-card card">
        <img src={`${import.meta.env.BASE_URL}icons/icon.svg`} alt="" width={64} height={64} className="signin-logo" />
        <h1>MedTracker</h1>
        <p className="muted">Keep track of your medications, schedules and reminders, all in one place.</p>

        {notice && (
          <div className="alert alert-success" role="status">
            {notice}
          </div>
        )}

        {FIREBASE_CONFIGURED ? (
          <button type="button" className="btn google-btn" onClick={signIn} disabled={busy || !ready} aria-busy={busy || !ready}>
            <GoogleLogo />
            {busy ? 'Signing in…' : ready ? 'Sign in with Google' : 'Loading…'}
          </button>
        ) : (
          <div className="alert alert-warning" role="note">
            Google sign-in isn't configured yet. Add your Firebase settings to <code>.env</code> (see README).
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
        <button type="button" className="btn btn-ghost" onClick={() => onSignIn(GUEST_USER)}>
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
