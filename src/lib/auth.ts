// Google sign-in through Firebase Authentication. Identity keeps each account's data
// separate on this device and supplies the Google profile picture for the account icon.
import type { Auth, User as FirebaseUser } from 'firebase/auth';
// Public Firebase web config (safe to commit: access is controlled by Firebase's authorized domains).
import committedConfig from '../firebase-config.json';

export interface User {
  id: string;
  name: string;
  email?: string;
  picture?: string;
  provider: 'google' | 'guest';
}

// VITE_FIREBASE_* environment variables override the committed file (e.g. a test project).
const env = import.meta.env;
const pick = (fromEnv: string | undefined, fromFile: string) => (fromEnv ?? '').trim() || fromFile.trim();
/**
 * Self-hosted sign-in helpers (public/__/auth/*, copied from <project>.firebaseapp.com/__/auth/).
 * When enabled, authDomain points at this site, e.g. "undeadcommander.github.io/Medication-Tracker",
 * and the SDK then uses https://<that>/__/auth/handler. Sign-in stays on the app's own origin, which
 * Safari requires for redirect sign-in in iPhone/iPad Home Screen apps (no third-party storage there).
 * The Google OAuth client must list https://<that>/__/auth/handler as an authorized redirect URI.
 */
const SELF_HOSTED_AUTH = env.VITE_FIREBASE_SELF_HOSTED_AUTH === 'true' && location.protocol === 'https:';
const selfHostedAuthDomain = `${location.host}${env.BASE_URL.replace(/\/+$/, '')}`;

const firebaseConfig = {
  apiKey: pick(env.VITE_FIREBASE_API_KEY, committedConfig.apiKey),
  authDomain: SELF_HOSTED_AUTH
    ? selfHostedAuthDomain
    : pick(env.VITE_FIREBASE_AUTH_DOMAIN, committedConfig.authDomain),
  projectId: pick(env.VITE_FIREBASE_PROJECT_ID, committedConfig.projectId),
  appId: pick(env.VITE_FIREBASE_APP_ID, committedConfig.appId),
};

export const FIREBASE_CONFIGURED = Boolean(
  firebaseConfig.apiKey && firebaseConfig.authDomain && firebaseConfig.projectId && firebaseConfig.appId,
);

const SESSION_KEY = 'medtracker.session';

// Firebase is loaded lazily so guests and unconfigured builds never download it. The sign-in
// screen preloads it, so a tap can open Google's popup synchronously (Safari blocks popups that
// open after an await, i.e. outside the tap's user gesture).
type AuthModule = typeof import('firebase/auth');
let loaded: { auth: Auth; mod: AuthModule } | null = null;
let loadPromise: Promise<{ auth: Auth; mod: AuthModule }> | null = null;

function loadFirebase(): Promise<{ auth: Auth; mod: AuthModule }> {
  if (!FIREBASE_CONFIGURED) return Promise.reject(new Error('Firebase is not configured'));
  loadPromise ??= (async () => {
    const [{ initializeApp }, mod] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    const auth = mod.getAuth(initializeApp(firebaseConfig));
    auth.useDeviceLanguage();
    loaded = { auth, mod };
    return loaded;
  })().catch((e) => {
    loadPromise = null;
    throw e;
  });
  return loadPromise;
}

function getFirebaseAuth(): Promise<Auth> {
  return loadFirebase().then((x) => x.auth);
}

/** Start loading Firebase Auth ahead of the sign-in tap. Resolves when it's ready. */
export function preloadFirebaseAuth(): Promise<void> {
  return FIREBASE_CONFIGURED ? loadFirebase().then(() => undefined) : Promise.resolve();
}

// ---------- diagnostics (shown on the sign-in screen to debug device-specific failures) ----------

export const BUILD_ID: string = (import.meta.env.VITE_BUILD_ID ?? '').slice(0, 7) || 'dev';

export interface SignInAttempt {
  at: string;
  method: 'popup' | 'redirect';
  standalone: boolean;
  result: 'started' | 'ok' | 'cancelled' | 'error' | 'redirect-returned-empty';
  code?: string;
}

const ATTEMPT_KEY = 'medtracker.lastSignIn';

function recordAttempt(patch: Partial<SignInAttempt>): void {
  try {
    const prev = lastSignInAttempt();
    const next = { ...(prev ?? {}), ...patch, at: new Date().toISOString() };
    localStorage.setItem(ATTEMPT_KEY, JSON.stringify(next));
  } catch {
    /* storage unavailable */
  }
}

export function lastSignInAttempt(): SignInAttempt | null {
  try {
    const raw = localStorage.getItem(ATTEMPT_KEY);
    return raw ? (JSON.parse(raw) as SignInAttempt) : null;
  } catch {
    return null;
  }
}

/** Google serves 96px avatars by default; ask for a sharper one. */
function sharperPhoto(url: string | null): string | undefined {
  if (!url) return undefined;
  return /googleusercontent\.com/.test(url) ? url.replace(/=s\d+(-c)?$/, '=s256-c') : url;
}

function toUser(fb: FirebaseUser): User {
  const google = fb.providerData.find((p) => p.providerId === 'google.com');
  return {
    id: `firebase:${fb.uid}`,
    name: fb.displayName ?? google?.displayName ?? fb.email ?? 'Google user',
    email: fb.email ?? google?.email ?? undefined,
    picture: sharperPhoto(fb.photoURL ?? google?.photoURL ?? null),
    provider: 'google',
  };
}

function isStandaloneIOS(): boolean {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone =
    window.matchMedia('(display-mode: standalone)').matches || (navigator as { standalone?: boolean }).standalone === true;
  return ios && standalone;
}

function friendlyError(e: unknown): Error {
  const code = (e as { code?: string })?.code ?? '';
  const messages: Record<string, string> = {
    'auth/unauthorized-domain': `This site (${location.hostname}) isn't an authorized domain in Firebase. Add it under Authentication → Settings → Authorized domains.`,
    'auth/operation-not-allowed': 'Google sign-in is not enabled. Turn on the Google provider in Firebase → Authentication → Sign-in method.',
    'auth/network-request-failed': "Couldn't reach Google. Check your connection and try again.",
    'auth/too-many-requests': 'Too many attempts. Wait a moment and try again.',
    'auth/invalid-api-key': 'The Firebase API key is invalid. Check VITE_FIREBASE_API_KEY in .env.',
  };
  return new Error(messages[code] ?? (e instanceof Error ? e.message : 'Sign-in failed'));
}

/**
 * Start Google sign-in with a popup, everywhere (including iPhone/iPad Home Screen apps, where
 * redirect sign-in loses its result). Falls back to a full-page redirect only if the popup is
 * blocked. Resolves null if the user cancelled or a redirect started.
 */
export async function signInWithGoogle(): Promise<User | null> {
  // No await before the popup opens when Firebase is preloaded: keeps Safari's user gesture.
  const { auth, mod } = loaded ?? (await loadFirebase());
  const provider = new mod.GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  const standalone = isStandaloneIOS();
  recordAttempt({ method: 'popup', standalone, result: 'started', code: undefined });
  try {
    const cred = await mod.signInWithPopup(auth, provider);
    recordAttempt({ result: 'ok' });
    return toUser(cred.user);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') {
      recordAttempt({ result: 'cancelled', code });
      return null;
    }
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      recordAttempt({ method: 'redirect', result: 'started', code });
      await mod.signInWithRedirect(auth, provider);
      return null;
    }
    recordAttempt({ result: 'error', code: code ?? (e instanceof Error ? e.message.slice(0, 80) : 'unknown') });
    throw friendlyError(e);
  }
}

/** Finish a redirect sign-in that just returned to the app, surfacing its errors. */
export async function completeRedirectSignIn(): Promise<void> {
  if (!FIREBASE_CONFIGURED) return;
  const { auth, mod } = await loadFirebase();
  const pending = lastSignInAttempt();
  try {
    const cred = await mod.getRedirectResult(auth);
    if (pending?.method === 'redirect' && pending.result === 'started') {
      recordAttempt({ result: cred || auth.currentUser ? 'ok' : 'redirect-returned-empty' });
    }
  } catch (e) {
    recordAttempt({ result: 'error', code: (e as { code?: string })?.code ?? 'unknown' });
    throw friendlyError(e);
  }
}

/**
 * Follow Firebase's auth state. Calls back with the signed-in user, or null once Firebase
 * has confirmed there's no session. Never called when Firebase isn't configured.
 */
export function watchAuth(cb: (user: User | null) => void): () => void {
  if (!FIREBASE_CONFIGURED) return () => {};
  let unsub: (() => void) | null = null;
  let cancelled = false;
  getFirebaseAuth()
    .then(async (auth) => {
      const { onAuthStateChanged } = await import('firebase/auth');
      if (!cancelled) unsub = onAuthStateChanged(auth, (fb) => cb(fb ? toUser(fb) : null));
    })
    .catch(() => {
      /* offline or misconfigured: keep the cached session */
    });
  return () => {
    cancelled = true;
    unsub?.();
  };
}

export const GUEST_USER: User = { id: 'guest', name: 'Guest', provider: 'guest' };

/** Cached session, so the app opens instantly (and offline) before Firebase confirms it. */
export function loadSession(): User | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const u = JSON.parse(raw) as User;
    return u && typeof u.id === 'string' && typeof u.name === 'string' ? u : null;
  } catch {
    return null;
  }
}

export function saveSession(user: User): void {
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify(user));
  } catch {
    /* storage unavailable */
  }
}

export function clearSession(): void {
  try {
    localStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

export async function signOut(user: User): Promise<void> {
  clearSession();
  if (user.provider === 'google' && FIREBASE_CONFIGURED) {
    const [auth, { signOut: fbSignOut }] = await Promise.all([getFirebaseAuth(), import('firebase/auth')]);
    await fbSignOut(auth);
  }
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}
