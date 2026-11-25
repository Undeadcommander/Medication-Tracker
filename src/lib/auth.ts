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

// Firebase is loaded lazily so guests and unconfigured builds never download it.
let authPromise: Promise<Auth> | null = null;

function getFirebaseAuth(): Promise<Auth> {
  if (!FIREBASE_CONFIGURED) return Promise.reject(new Error('Firebase is not configured'));
  authPromise ??= (async () => {
    const [{ initializeApp }, { getAuth }] = await Promise.all([import('firebase/app'), import('firebase/auth')]);
    const auth = getAuth(initializeApp(firebaseConfig));
    auth.useDeviceLanguage();
    return auth;
  })();
  return authPromise;
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
 * Start Google sign-in. Uses a popup, or a full-page redirect where popups don't work
 * (iOS Home Screen apps, blocked popups). Resolves null if the user cancelled or a redirect started.
 */
export async function signInWithGoogle(): Promise<User | null> {
  const auth = await getFirebaseAuth();
  const { GoogleAuthProvider, signInWithPopup, signInWithRedirect } = await import('firebase/auth');
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  if (isStandaloneIOS()) {
    await signInWithRedirect(auth, provider);
    return null;
  }
  try {
    const cred = await signInWithPopup(auth, provider);
    return toUser(cred.user);
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'auth/popup-closed-by-user' || code === 'auth/cancelled-popup-request') return null;
    if (code === 'auth/popup-blocked' || code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
      return null;
    }
    throw friendlyError(e);
  }
}

/** Surface errors from a redirect sign-in that just returned to the app. */
export async function completeRedirectSignIn(): Promise<void> {
  if (!FIREBASE_CONFIGURED) return;
  const auth = await getFirebaseAuth();
  const { getRedirectResult } = await import('firebase/auth');
  try {
    await getRedirectResult(auth);
  } catch (e) {
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
