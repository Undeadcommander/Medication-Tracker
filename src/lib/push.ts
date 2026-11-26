// Browser-side push-notification client.
//
// Two delivery modes:
//  - 'push':  the browser is subscribed to Web Push and the reminder list is mirrored to the server,
//             which delivers notifications even when the app is closed.
//  - 'local': permission is granted but there is no push subscription (or the server is down);
//             the page schedules notifications itself with setTimeout. Only works while the app
//             is open / not suspended.
import type { DoseLog, Medication, PushDose, PushReminder } from '../../shared/types';
import { occurrencesBetween } from '../../shared/schedule';
import { GROUP_WINDOW_MS, MAX_GROUP_DOSES, doseId, reminderText } from '../../shared/reminderText';

export type PushState = 'unsupported' | 'ios-needs-install' | 'denied' | 'default' | 'granted' | 'subscribed';

export interface PlatformInfo {
  isIOS: boolean;
  isStandalone: boolean;
  supportsNotifications: boolean;
  supportsPush: boolean;
}

/** Reminder text is always discreet (shared/reminderText.ts): it never names a medication. */
export interface SyncOptions {
  horizonDays?: number;
}

export type SwMessage = { type: 'dose-taken'; medId: string; scheduledFor: string };

/** Site base path: '/' locally, '/Medication-Tracker/' on GitHub Pages. */
const BASE = import.meta.env.BASE_URL;
const ICON = `${BASE}icons/icon-192.png`;

/**
 * Reminder server API root, or null when this build has no server.
 *  - VITE_API_BASE unset: same origin (`npm run dev`, or `npm start` serving dist/).
 *  - VITE_API_BASE=https://host/api: a separately hosted server.
 *  - VITE_API_BASE=none: static hosting only; reminders work while the app is open.
 */
const API_BASE: string | null = (() => {
  const configured = (import.meta.env.VITE_API_BASE ?? '').trim().replace(/\/+$/, '');
  if (configured.toLowerCase() === 'none') return null;
  return configured || `${BASE}api`;
})();

/** True when this build can talk to a reminder server (push works with the app closed). */
export const PUSH_SERVER_CONFIGURED = API_BASE !== null;

function api(path: string): string | null {
  return API_BASE && `${API_BASE}/${path}`;
}

// The service worker learns the API root from its own URL, since it can't read Vite env vars.
const SW_URL = `${BASE}sw.js${
  API_BASE ? `?api=${encodeURIComponent(new URL(API_BASE, location.href).href)}` : ''
}`;

const DEVICE_KEY = 'medtracker.deviceId';
const MAX_SERVER_REMINDERS = 3000;
const LOCAL_WINDOW_MS = 24 * 3_600_000;
const LOCAL_REARM_MS = 3_600_000;
/**
 * Local mode only: a dose that came due less than this long ago and is still unlogged is shown when
 * the app starts or resumes (the OS may have suspended or killed it when the reminder was due).
 */
const LOCAL_CATCHUP_MS = 2 * 3_600_000;
/** Resume events (visibility, pageshow, focus) often arrive together: handle them once. */
const RESUME_COALESCE_MS = 1000;
const NOTIFICATION_ACTIONS = [
  { action: 'take', title: 'Mark as taken' },
  { action: 'snooze', title: 'Snooze 10 min' },
];
/** Grouped reminders: no "Mark as taken" (which doses?); snooze applies to the whole group. */
const GROUP_ACTIONS = [{ action: 'snooze', title: 'Snooze 10 min' }];

// ---------- platform ----------

export function getPlatformInfo(): PlatformInfo {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return { isIOS: false, isStandalone: false, supportsNotifications: false, supportsPush: false };
  }
  const ua = navigator.userAgent || '';
  const isIOS =
    /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && (navigator.maxTouchPoints ?? 0) > 1);
  let isStandalone = false;
  try {
    isStandalone =
      window.matchMedia?.('(display-mode: standalone)').matches === true ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
  } catch {
    /* ignore */
  }
  return {
    isIOS,
    isStandalone,
    supportsNotifications: 'Notification' in window,
    supportsPush: 'serviceWorker' in navigator && 'PushManager' in window,
  };
}

// ---------- device id ----------

let memoryDeviceId: string | null = null;

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** The device id, if one has been made (doesn't make one). */
function storedDeviceId(): string | null {
  try {
    return localStorage.getItem(DEVICE_KEY) ?? memoryDeviceId;
  } catch {
    return memoryDeviceId;
  }
}

/** Random per-device secret; doubles as the bearer credential for the push server. */
export function getDeviceId(): string {
  try {
    const existing = localStorage.getItem(DEVICE_KEY);
    if (existing && /^[A-Za-z0-9_-]{22,128}$/.test(existing)) return existing;
    const fresh = randomId();
    localStorage.setItem(DEVICE_KEY, fresh);
    return fresh;
  } catch {
    return (memoryDeviceId ??= randomId());
  }
}

// ---------- helpers ----------

async function fetchJson(
  url: string | null,
  init?: { method?: string; body?: unknown },
  timeoutMs = 10_000,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  // No reminder server in this build: behave like an unreachable server (local mode).
  if (!url) return { ok: false, status: 0, data: null };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: init?.method ?? 'GET',
      headers: init?.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
      signal: ctrl.signal,
      cache: 'no-store',
    });
    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* not JSON */
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(t);
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function sameKey(a: ArrayBuffer | null | undefined, b: Uint8Array): boolean {
  if (!a) return false;
  const x = new Uint8Array(a);
  if (x.length !== b.length) return false;
  for (let i = 0; i < x.length; i++) if (x[i] !== b[i]) return false;
  return true;
}

// ---------- server VAPID key ----------

let serverKeyCache: { key: Uint8Array<ArrayBuffer>; at: number } | null = null;
const SERVER_KEY_TTL_MS = 10 * 60_000;

async function getServerKey(force = false): Promise<Uint8Array<ArrayBuffer> | null> {
  if (!force && serverKeyCache && Date.now() - serverKeyCache.at < SERVER_KEY_TTL_MS) return serverKeyCache.key;
  try {
    const res = await fetchJson(api('push/public-key'), undefined, 8_000);
    const publicKey = (res.data as { publicKey?: unknown } | null)?.publicKey;
    if (!res.ok || typeof publicKey !== 'string') return null;
    serverKeyCache = { key: urlBase64ToUint8Array(publicKey), at: Date.now() };
    return serverKeyCache.key;
  } catch {
    return null;
  }
}

/**
 * Make sure the browser's push subscription was created for the server's current VAPID key
 * (it changes if server/data is wiped). Re-subscribes and re-registers when it doesn't match.
 * Returns the usable subscription, or null if there isn't one.
 */
async function ensureCurrentSubscription(reg: ServiceWorkerRegistration, forceKey = false): Promise<PushSubscription | null> {
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return null;
  const key = await getServerKey(forceKey);
  if (!key || sameKey(sub.options.applicationServerKey, key)) return sub;
  await sub.unsubscribe().catch(() => {});
  let fresh: PushSubscription;
  try {
    fresh = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  } catch (err) {
    // Some browsers only allow subscribing from a user gesture; the settings screen offers a retry.
    console.warn('Could not re-subscribe after a server key change:', err);
    return null;
  }
  const res = await fetchJson(api('push/subscribe'), {
    method: 'POST',
    body: { deviceId: getDeviceId(), subscription: fresh.toJSON() },
  });
  lastPostSig = '';
  return res.ok ? fresh : null;
}

// ---------- service worker ----------

let registrationPromise: Promise<ServiceWorkerRegistration | null> | null = null;

export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return null;
  listenForLocalSnooze();
  registrationPromise ??= navigator.serviceWorker.register(SW_URL, { scope: BASE }).catch((err) => {
    console.warn('Service worker registration failed:', err);
    registrationPromise = null;
    return null;
  });
  return registrationPromise;
}

/** Registration with an active worker (needed for pushManager / showNotification). */
async function activeRegistration(): Promise<ServiceWorkerRegistration | null> {
  const reg = await registerServiceWorker();
  if (!reg) return null;
  if (reg.active) return reg;
  return Promise.race([
    navigator.serviceWorker.ready,
    new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
  ]);
}

// ---------- state ----------

export async function getPushState(): Promise<PushState> {
  const info = getPlatformInfo();
  // iOS Safari tabs expose neither PushManager nor a usable Notification; it must be a Home Screen app.
  if (info.isIOS && !info.isStandalone) return 'ios-needs-install';
  if (!info.supportsNotifications || !('serviceWorker' in navigator)) return 'unsupported';
  const permission = Notification.permission;
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'default';
  if (info.supportsPush) {
    try {
      const reg = await activeRegistration();
      if (reg && (await reg.pushManager.getSubscription())) return 'subscribed';
    } catch {
      /* fall through */
    }
  }
  return 'granted';
}

/** Must be called from a user gesture (permission prompt; required on iOS). */
export async function enablePush(): Promise<PushState> {
  const info = getPlatformInfo();
  if (info.isIOS && !info.isStandalone) return 'ios-needs-install';
  if (!info.supportsNotifications || !('serviceWorker' in navigator)) return 'unsupported';

  let permission = Notification.permission;
  if (permission === 'default') {
    // Kick off registration in parallel without delaying the prompt (keeps the user-gesture alive).
    void registerServiceWorker();
    permission = await Notification.requestPermission();
  }
  if (permission === 'denied') return 'denied';
  if (permission !== 'granted') return 'default';
  if (!info.supportsPush) return 'granted';

  try {
    const reg = await activeRegistration();
    if (!reg) return 'granted';

    const serverKey = await getServerKey(true);
    if (!serverKey) return 'granted';

    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, serverKey)) {
      // Server VAPID key changed (e.g. server/data was wiped): the old subscription is useless.
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    sub ??= await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: serverKey });

    const res = await fetchJson(api('push/subscribe'), {
      method: 'POST',
      body: { deviceId: getDeviceId(), subscription: sub.toJSON() },
    });
    return res.ok ? 'subscribed' : 'granted';
  } catch (err) {
    console.warn('Push subscription failed, using local reminders:', err);
    return 'granted';
  }
}

/** Stop the reminders this tab shows by itself (local mode and snoozes), e.g. signed out in another tab. */
export function stopLocalReminders(): void {
  clearLocalTimers();
  for (const t of snoozeTimers) clearTimeout(t);
  snoozeTimers = [];
  lastReminders = [];
  lastMissed = [];
}

export async function disablePush(): Promise<void> {
  // A reminder update under way would land after this and bring them back: let it finish first.
  await syncChain;
  stopLocalReminders();
  lastPostSig = '';
  try {
    const reg = await activeRegistration();
    const sub = await reg?.pushManager.getSubscription();
    await sub?.unsubscribe();
  } catch {
    /* ignore */
  }
  try {
    await fetchJson(api('push/unsubscribe'), { method: 'POST', body: { deviceId: getDeviceId() } });
  } catch {
    /* server may be down; the 404/410 path cleans up later */
  }
}

// ---------- building reminders ----------

/** The doses a reminder covers: its group, or just itself. */
function dosesOf(r: PushReminder): PushDose[] {
  return r.doses?.length ? r.doses : [{ medId: r.medId, at: r.at }];
}

/**
 * A reminder for `doses` (sorted, non-empty): one dose keeps the plain `${medId}@${at}` shape;
 * two or more become a group anchored at the earliest. Text is always discreet.
 */
function reminderFor(doses: PushDose[]): PushReminder {
  const [first] = doses;
  const r: PushReminder = { id: doseId(first.medId, first.at), medId: first.medId, at: first.at, ...reminderText(doses.length) };
  if (doses.length > 1) r.doses = doses.map((d) => ({ medId: d.medId, at: d.at }));
  return r;
}

const byTime = (a: PushDose, b: PushDose) => a.at - b.at || (a.medId < b.medId ? -1 : a.medId > b.medId ? 1 : 0);

/**
 * Groups doses into notifications: a group starts at the earliest dose not yet grouped and takes
 * every dose due up to GROUP_WINDOW_MS after it (anchored, not chained), at most MAX_GROUP_DOSES.
 * It fires at its earliest dose. Exported for tests.
 */
export function groupDoses(doses: PushDose[]): PushReminder[] {
  const sorted = [...doses].sort(byTime);
  const out: PushReminder[] = [];
  for (let i = 0; i < sorted.length; ) {
    const anchor = sorted[i];
    let j = i + 1;
    while (j < sorted.length && j - i < MAX_GROUP_DOSES && sorted[j].at - anchor.at <= GROUP_WINDOW_MS) j++;
    out.push(reminderFor(sorted.slice(i, j)));
    i = j;
  }
  return out;
}

function buildReminders(
  meds: Medication[],
  doseLogs: DoseLog[],
  opts: SyncOptions,
): { reminders: PushReminder[]; missed: PushDose[]; dismissed: string[]; logged: Set<string> } {
  const now = Date.now();
  const horizon = Math.max(1, Math.min(opts.horizonDays ?? 30, 365));
  const from = new Date(now);
  const to = new Date(now + horizon * 86_400_000);

  // Only logs near or after now can matter (a reminder is for a future dose; "dismissed" looks back
  // 12h). With a year of history that is most of the array, so skip old ones by comparing the ISO
  // strings (cheap) before parsing/allocating anything for them.
  const cutoffIso = new Date(now - 12 * 3_600_000 - 60_000).toISOString();
  const logged = new Set<string>();
  const dismissed: string[] = [];
  for (const log of doseLogs) {
    const iso = log.scheduledFor;
    if (iso.length === 24 && iso.charCodeAt(23) === 90 /* 'Z' */ && iso < cutoffIso) continue;
    const ms = Date.parse(log.scheduledFor);
    if (Number.isNaN(ms)) continue;
    const id = doseId(log.medId, ms);
    logged.add(id);
    // Handled recently: lets the server cancel any pending snooze for it (or drop it from a group).
    if (now - ms < 12 * 3_600_000 && ms < now + 3_600_000) dismissed.push(id);
  }

  // A dose this device already showed (e.g. in a group, before one of its doses was logged and the
  // groups were worked out again) is never scheduled again, here or on the push server.
  const shown = shownKeys();
  const upcoming: PushDose[] = [];
  // Recently due, still unlogged: local mode only (the push server never gets past reminders).
  // At most one per medication, the most recent, so reopening after several misses doesn't spam.
  const missed: PushDose[] = [];
  const catchupStart = now - LOCAL_CATCHUP_MS;
  for (const med of meds) {
    if (!med.notificationsEnabled) continue;
    let latestMissed: PushDose | null = null;
    // Don't catch up on doses due before the med was added, its schedule changed, or its reminders
    // were turned on: the user may already have taken them, and an alert then is just noise.
    let catchupFrom = catchupStart;
    for (const iso of [med.createdAt, med.fieldTimes?.schedule, med.fieldTimes?.notificationsEnabled]) {
      const t = iso ? Date.parse(iso) : NaN;
      if (t > catchupFrom) catchupFrom = t;
    }
    for (const occ of occurrencesBetween(med.schedule, new Date(Math.min(catchupFrom, now)), to)) {
      const at = occ.getTime();
      const id = doseId(med.id, at);
      if (logged.has(id)) continue;
      if (at < from.getTime()) {
        if (!latestMissed || at > latestMissed.at) latestMissed = { medId: med.id, at };
      } else if (!shown.has(id)) upcoming.push({ medId: med.id, at });
    }
    if (latestMissed) missed.push(latestMissed);
  }
  missed.sort(byTime);
  return { reminders: groupDoses(upcoming), missed, dismissed: dismissed.slice(-500), logged };
}

// ---------- local fallback scheduler ----------

let localTimers: ReturnType<typeof setTimeout>[] = [];
/** Upcoming reminders (grouped), and recently missed doses to catch up on (local mode). */
let lastReminders: PushReminder[] = [];
let lastMissed: PushDose[] = [];
/** Doses logged as of the last sync: a snoozed reminder re-shows only the ones still open. */
let lastLogged = new Set<string>();
let localActive = false;
let rearmInterval: ReturnType<typeof setInterval> | null = null;
/** Keys this tab has shown (dose ids, or a snooze's own key), with when (pruned). */
const shownLocally = new Map<string, number>();
/** Shared by all open tabs: each one arms its own local timers, but only one should alert. */
const SHOWN_KEY = 'medtracker.shownReminders';
const SHOWN_TTL_MS = 2 * 86_400_000;
const SHOWN_LOCK = 'medtracker-local-reminder';

function readSharedShown(now: number): Record<string, number> {
  const raw = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? '{}') as Record<string, unknown>;
  const shared: Record<string, number> = {};
  for (const [k, t] of Object.entries(raw ?? {})) if (typeof t === 'number' && now - t <= SHOWN_TTL_MS) shared[k] = t;
  return shared;
}

/** Everything shown recently, by this tab or another (read only). */
function shownKeys(): Set<string> {
  const now = Date.now();
  const keys = new Set<string>();
  for (const [k, t] of shownLocally) if (now - t <= SHOWN_TTL_MS) keys.add(k);
  try {
    for (const k of Object.keys(readSharedShown(now))) keys.add(k);
  } catch {
    /* storage unavailable */
  }
  return keys;
}

/**
 * Claims `keys` for this tab and returns the ones nobody (this tab or another open tab) had
 * claimed yet. A group notification claims each of its doses, so no dose is shown twice.
 */
function claimShown(keys: string[]): string[] {
  const now = Date.now();
  for (const [k, t] of shownLocally) if (now - t > SHOWN_TTL_MS) shownLocally.delete(k);
  let fresh = keys.filter((k) => !shownLocally.has(k));
  try {
    const shared = readSharedShown(now);
    fresh = fresh.filter((k) => !(k in shared));
    for (const k of fresh) shared[k] = now;
    if (fresh.length) localStorage.setItem(SHOWN_KEY, JSON.stringify(shared));
  } catch {
    /* storage unavailable: dedupe within this tab only */
  }
  for (const k of fresh) shownLocally.set(k, now);
  return fresh;
}

/** Undo claims whose notification could not be shown. */
function releaseShownNow(keys: string[]): void {
  for (const k of keys) shownLocally.delete(k);
  try {
    const raw = JSON.parse(localStorage.getItem(SHOWN_KEY) ?? '{}') as Record<string, unknown>;
    if (raw && typeof raw === 'object' && keys.some((k) => k in raw)) {
      for (const k of keys) delete raw[k];
      localStorage.setItem(SHOWN_KEY, JSON.stringify(raw));
    }
  } catch {
    /* storage unavailable */
  }
}

/** Same lock as claiming, so a release can't race another tab's read-modify-write of SHOWN_KEY. */
async function releaseShown(keys: string[]): Promise<void> {
  const release = async () => releaseShownNow(keys);
  try {
    if (typeof navigator !== 'undefined' && navigator.locks) await navigator.locks.request(SHOWN_LOCK, release);
    else releaseShownNow(keys);
  } catch {
    releaseShownNow(keys);
  }
}

async function claimShownAcrossTabs(keys: string[]): Promise<string[]> {
  const claim = async () => claimShown(keys);
  try {
    // Serialise the read-check-write across tabs whose timers fire at the same moment.
    return typeof navigator !== 'undefined' && navigator.locks ? await navigator.locks.request(SHOWN_LOCK, claim) : claim();
  } catch {
    return claim();
  }
}

function clearLocalTimers(): void {
  for (const t of localTimers) clearTimeout(t);
  localTimers = [];
  localActive = false;
}

/** Same `data` shape as the push server's payload (public/sw.js reads it). */
function notificationData(r: PushReminder) {
  const data: Record<string, unknown> = {
    medId: r.medId,
    scheduledFor: new Date(r.at).toISOString(),
    reminderId: r.id,
    deviceId: getDeviceId(),
    reminder: r,
  };
  if (r.doses) data.count = r.doses.length;
  return data;
}

/** Keys with a showLocal still in progress (e.g. waiting on the registration), so repeated re-arms don't pile up. */
const showingLocally = new Set<string>();

/**
 * Shows `r` once. Normally each of its doses is claimed, and only doses not shown before are
 * included (none left: nothing is shown). A snooze passes its own `snoozeKey` instead, so the
 * same doses can be shown again; doses logged since are left out.
 */
async function showLocal(r: PushReminder, snoozeKey?: string): Promise<void> {
  const busyKey = snoozeKey ?? r.id;
  if (showingLocally.has(busyKey)) return;
  showingLocally.add(busyKey);
  let claimed: string[] = [];
  try {
    // Check we can deliver before claiming, so a reminder isn't burned when we can't show it.
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    const reg = await activeRegistration();
    if (!reg) return;
    let doses = dosesOf(r);
    if (snoozeKey) {
      doses = doses.filter((d) => !lastLogged.has(doseId(d.medId, d.at)));
      if (!doses.length) return;
      claimed = await claimShownAcrossTabs([snoozeKey]);
      if (!claimed.length) return;
    } else {
      claimed = await claimShownAcrossTabs(doses.map((d) => doseId(d.medId, d.at)));
      const fresh = new Set(claimed);
      doses = doses.filter((d) => fresh.has(doseId(d.medId, d.at)));
      if (!doses.length) return;
    }
    const shown = reminderFor(doses);
    await reg.showNotification(shown.title, {
      body: shown.body,
      tag: shown.id,
      data: notificationData(shown),
      icon: ICON,
      badge: ICON,
      renotify: true,
      requireInteraction: true,
      // A group can't be marked as taken from the notification: the user should see which doses.
      actions: shown.doses ? GROUP_ACTIONS : NOTIFICATION_ACTIONS,
    } as NotificationOptions);
  } catch (err) {
    console.warn('Local notification failed:', err);
    if (claimed.length) await releaseShown(claimed); // let a later re-arm retry
  } finally {
    showingLocally.delete(busyKey);
  }
}

/** (Re)arm timers for reminders due in the next 24h. Returns how many are pending/armed. */
function armLocalTimers(): number {
  for (const t of localTimers) clearTimeout(t);
  localTimers = [];
  const now = Date.now();
  let armed = 0;
  // Overdue but recent: catch up in one notification, on the latest dose per medication (earlier
  // ones are skipped), leaving out doses already shown.
  const latest = new Map<string, PushDose>();
  // A late group brings all its doses, including ones due a few minutes from now (no timer is
  // armed for them: the group's time has passed).
  const overdue = [
    ...lastMissed.filter((d) => now - d.at <= LOCAL_CATCHUP_MS),
    ...lastReminders.filter((r) => r.at <= now && now - r.at <= LOCAL_CATCHUP_MS).flatMap(dosesOf),
  ];
  for (const d of overdue) {
    const prev = latest.get(d.medId);
    if (!prev || d.at > prev.at) latest.set(d.medId, d);
  }
  const shown = shownKeys();
  const catchup = [...latest.values()].filter((d) => !shown.has(doseId(d.medId, d.at))).sort(byTime);
  if (catchup.length) void showLocal(reminderFor(catchup.slice(0, MAX_GROUP_DOSES)));
  for (const r of lastReminders) {
    const delay = r.at - now;
    if (delay > LOCAL_WINDOW_MS) break; // sorted ascending
    if (delay <= 0) continue;
    armed++;
    localTimers.push(setTimeout(() => void showLocal(r), delay));
  }
  localActive = true;
  return armed;
}

function ensureLocalMaintenance(): void {
  if (rearmInterval || typeof window === 'undefined') return;
  rearmInterval = setInterval(() => {
    if (localActive) armLocalTimers();
  }, LOCAL_REARM_MS);
  // Timers are throttled/frozen (or the app killed) in the background; re-arm and catch up on
  // return. iOS resumes via pageshow/focus as well, and these often fire together.
  let lastResume = 0;
  const onResume = () => {
    if (document.visibilityState !== 'visible' || !localActive) return;
    const now = Date.now();
    if (now - lastResume < RESUME_COALESCE_MS) return;
    lastResume = now;
    armLocalTimers();
  };
  document.addEventListener('visibilitychange', onResume);
  window.addEventListener('pageshow', onResume);
  window.addEventListener('focus', onResume);
}

// Snoozes from notifications the server can't handle (local mode) come back from the service
// worker as a message; schedule them in-page.
let snoozeTimers: ReturnType<typeof setTimeout>[] = [];
let snoozeListening = false;

function listenForLocalSnooze(): void {
  if (snoozeListening || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  snoozeListening = true;
  navigator.serviceWorker.addEventListener('message', (event: MessageEvent) => {
    const d = event.data as { type?: string; reminder?: PushReminder; minutes?: number } | null;
    if (d?.type !== 'snooze-local' || !d.reminder || typeof d.reminder.id !== 'string') return;
    const r = d.reminder;
    if (typeof r.medId !== 'string' || typeof r.at !== 'number') return;
    // Only the dose fields matter (the text is rebuilt); ignore anything malformed in `doses`.
    const doses = (Array.isArray(r.doses) ? r.doses : []).filter(
      (x): x is PushDose => !!x && typeof x.medId === 'string' && typeof x.at === 'number',
    );
    const snoozed = reminderFor(doses.length ? doses.sort(byTime) : [{ medId: r.medId, at: r.at }]);
    const minutes = Math.min(120, Math.max(1, Number(d.minutes) || 10));
    const key = `${snoozed.id}#snooze@${Date.now()}`;
    const timer = setTimeout(() => {
      snoozeTimers = snoozeTimers.filter((t) => t !== timer);
      void showLocal(snoozed, key);
    }, minutes * 60_000);
    snoozeTimers.push(timer);
  });
}

// ---------- sync ----------

let syncChain: Promise<unknown> = Promise.resolve();
let lastPostSig = '';
let lastPostAt = 0;

async function postReminders(reminders: PushReminder[], dismissed: string[]): Promise<boolean> {
  const capped = reminders.slice(0, MAX_SERVER_REMINDERS);
  const sig = `${capped.length}:${capped.map((r) => `${r.id}|${dosesOf(r).map((d) => doseId(d.medId, d.at)).join('+')}`).join(';')}:${dismissed.join(',')}`;
  if (sig === lastPostSig && Date.now() - lastPostAt < 30_000) return true;
  // Nothing to remind about, and the server can't know this device (its id was forgotten on
  // signing out): don't register it again just to send it an empty list.
  if (!capped.length && !storedDeviceId()) return true;

  const deviceId = getDeviceId();
  const send = () =>
    fetchJson(api('push/reminders'), { method: 'POST', body: { deviceId, reminders: capped, dismissed } }, 20_000);
  let res = await send();
  if (res.status === 404 && !capped.length) return true; // the server has nothing for it already
  if (res.status === 404) {
    // Server doesn't know this device (e.g. its db was reset): re-register the subscription and retry.
    // The server also drops devices whose subscription was rejected (expired or wrong VAPID key).
    const reg = await activeRegistration();
    const sub = reg ? await ensureCurrentSubscription(reg, true) : null;
    if (!sub) return false;
    const re = await fetchJson(api('push/subscribe'), { method: 'POST', body: { deviceId, subscription: sub.toJSON() } });
    if (!re.ok) return false;
    res = await send();
  }
  if (res.ok) {
    lastPostSig = sig;
    lastPostAt = Date.now();
  }
  return res.ok;
}

async function doSync(
  meds: Medication[],
  doseLogs: DoseLog[],
  opts: SyncOptions,
): Promise<{ count: number; mode: 'push' | 'local' | 'off' }> {
  let state: PushState;
  try {
    state = await getPushState();
  } catch {
    state = 'unsupported';
  }
  if (state !== 'subscribed' && state !== 'granted') {
    clearLocalTimers();
    lastReminders = [];
    lastMissed = [];
    return { count: 0, mode: 'off' };
  }

  const { reminders, missed, dismissed, logged } = buildReminders(meds, doseLogs, opts);
  lastLogged = logged;

  if (state === 'subscribed') {
    try {
      const reg = await activeRegistration();
      const sub = reg ? await ensureCurrentSubscription(reg) : null;
      if (sub && (await postReminders(reminders, dismissed))) {
        clearLocalTimers();
        lastReminders = [];
        lastMissed = [];
        return { count: Math.min(reminders.length, MAX_SERVER_REMINDERS), mode: 'push' };
      }
    } catch (err) {
      console.warn('Could not sync reminders to the push server, using local reminders:', err);
    }
  }

  // Local fallback (permission granted, but no subscription or the server is unreachable).
  lastReminders = reminders;
  lastMissed = missed;
  if (!lastReminders.length && !lastMissed.length) {
    clearLocalTimers(); // nothing to show (e.g. signed out): no need to keep re-arming
    return { count: 0, mode: 'local' };
  }
  ensureLocalMaintenance();
  return { count: armLocalTimers(), mode: 'local' };
}

/** Mirrors the current schedule to the server (push) or arms in-page timers (local). Safe to call often. */
export function syncReminders(
  meds: Medication[],
  doseLogs: DoseLog[],
  opts: SyncOptions = {},
): Promise<{ count: number; mode: 'push' | 'local' | 'off' }> {
  // Serialise calls so out-of-order completions can't leave stale state behind.
  const run = syncChain.then(() => doSync(meds, doseLogs, opts));
  syncChain = run.catch(() => undefined);
  return run;
}

// ---------- test notification ----------

export async function sendTestNotification(): Promise<void> {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') {
    throw new Error('Notifications are not enabled for this device.');
  }
  if ((await getPushState()) === 'subscribed') {
    try {
      const res = await fetchJson(api('push/test'), { method: 'POST', body: { deviceId: getDeviceId() } });
      if (res.ok) return;
      if (res.status === 429) throw new Error('Please wait a few seconds before sending another test.');
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Please wait')) throw err;
      /* server unreachable: fall back to a local notification */
    }
  }
  const reg = await activeRegistration();
  if (!reg) throw new Error('Notifications are not available in this browser.');
  await reg.showNotification('Dosely test', {
    body: 'Notifications are working on this device.',
    tag: 'medtracker-test',
    icon: ICON,
    badge: ICON,
  });
}

// ---------- pending "Mark as taken" from notifications ----------
//
// The service worker hands a "taken" tap to one open window (or opens the app with ?take=&at=). That
// window may be on the sign-in screen, still loading its data, or not yet have received the
// medication from the cloud, so takes are queued durably (shared by all tabs) and applied once a
// tracker that has the medication loaded claims them.

export interface PendingTake {
  medId: string;
  scheduledFor: string;
  /** When it was queued (ms). */
  at: number;
}

const PENDING_KEY = 'medtracker.pendingTakes';
const PENDING_TTL_MS = 2 * 86_400_000;
const PENDING_LOCK = 'medtracker-pending-takes';
const PENDING_EVENT = 'medtracker:pending-takes';
/** Fallback when localStorage is unavailable (dedupes within this tab only). */
let memoryPending: PendingTake[] = [];

function readPending(): PendingTake[] {
  let parsed: unknown;
  try {
    const raw = localStorage.getItem(PENDING_KEY);
    if (!raw) return [];
    parsed = JSON.parse(raw);
  } catch {
    parsed = memoryPending;
  }
  if (!Array.isArray(parsed)) return [];
  const now = Date.now();
  return parsed.filter(
    (t): t is PendingTake =>
      !!t &&
      typeof t.medId === 'string' &&
      typeof t.scheduledFor === 'string' &&
      typeof t.at === 'number' &&
      now - t.at <= PENDING_TTL_MS,
  );
}

function writePending(list: PendingTake[]): void {
  try {
    if (list.length) localStorage.setItem(PENDING_KEY, JSON.stringify(list));
    else localStorage.removeItem(PENDING_KEY);
  } catch {
    memoryPending = list;
  }
}

/** Serialises read-modify-write across tabs. */
async function withPendingLock<T>(fn: () => T): Promise<T> {
  try {
    if (typeof navigator !== 'undefined' && navigator.locks) return await navigator.locks.request(PENDING_LOCK, async () => fn());
  } catch {
    /* fall through */
  }
  return fn();
}

/** Remember a "mark as taken" until a loaded tracker with this medication applies it. */
export async function queuePendingTake(medId: string, scheduledFor: string): Promise<void> {
  if (!medId || medId.length > 200 || Number.isNaN(Date.parse(scheduledFor))) return;
  await withPendingLock(() => {
    const list = readPending();
    if (!list.some((t) => t.medId === medId && t.scheduledFor === scheduledFor)) list.push({ medId, scheduledFor, at: Date.now() });
    writePending(list);
  });
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(PENDING_EVENT));
}

/**
 * Removes and returns the queued takes that `match`. Atomic across tabs, so each take is handed
 * to exactly one caller (who must apply it).
 */
export async function claimPendingTakes(match: (t: PendingTake) => boolean): Promise<PendingTake[]> {
  if (!readPending().some(match)) return []; // common case: nothing queued, no lock needed
  return withPendingLock(() => {
    const list = readPending();
    const mine = list.filter(match);
    if (mine.length) writePending(list.filter((t) => !match(t)));
    return mine;
  });
}

/** Takes still waiting for a tracker to apply them. */
export function pendingTakeCount(): number {
  return readPending().length;
}

/**
 * Signing out: forget what this device kept about the account's reminders (taps not applied yet,
 * which reminders were shown) and the device id the push server knew it by. Call after disablePush().
 */
export function forgetReminderState(): void {
  memoryPending = [];
  shownLocally.clear();
  lastLogged = new Set();
  memoryDeviceId = null;
  try {
    localStorage.removeItem(PENDING_KEY);
    localStorage.removeItem(SHOWN_KEY);
    localStorage.removeItem(DEVICE_KEY);
  } catch {
    /* storage unavailable */
  }
}

/** Called when takes are queued, from this tab or another one. */
export function onPendingTakesChange(handler: () => void): () => void {
  if (typeof window === 'undefined') return () => {};
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === PENDING_KEY) handler();
  };
  window.addEventListener(PENDING_EVENT, handler);
  window.addEventListener('storage', onStorage);
  return () => {
    window.removeEventListener(PENDING_EVENT, handler);
    window.removeEventListener('storage', onStorage);
  };
}

// ---------- messages from the service worker ----------

export function onServiceWorkerMessage(handler: (msg: SwMessage) => void): () => void {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return () => {};
  const listener = (event: MessageEvent) => {
    const d = event.data as Partial<SwMessage> | null;
    if (d && d.type === 'dose-taken' && typeof d.medId === 'string' && typeof d.scheduledFor === 'string') {
      handler({ type: 'dose-taken', medId: d.medId, scheduledFor: d.scheduledFor });
    }
  };
  navigator.serviceWorker.addEventListener('message', listener);
  return () => navigator.serviceWorker.removeEventListener('message', listener);
}
