// Browser-side push-notification client.
//
// Two delivery modes:
//  - 'push':  the browser is subscribed to Web Push and the reminder list is mirrored to the server,
//             which delivers notifications even when the app is closed.
//  - 'local': permission is granted but there is no push subscription (or the server is down);
//             the page schedules notifications itself with setTimeout. Only works while the app
//             is open / not suspended.
import type { DoseLog, Medication, PushReminder } from '../../shared/types';
import { occurrencesBetween } from '../../shared/schedule';

export type PushState = 'unsupported' | 'ios-needs-install' | 'denied' | 'default' | 'granted' | 'subscribed';

export interface PlatformInfo {
  isIOS: boolean;
  isStandalone: boolean;
  supportsNotifications: boolean;
  supportsPush: boolean;
}

export interface SyncOptions {
  /** Generic text ("Time for your medication"), no drug name or dose details. */
  discreet?: boolean;
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
/** A local reminder that is overdue by less than this is still shown (e.g. tab was frozen). */
const LOCAL_GRACE_MS = 5 * 60_000;
const DISCREET_TITLE = 'Time for your medication';
const DISCREET_BODY = 'Open MedTracker to review your dose.';
const NOTIFICATION_ACTIONS = [
  { action: 'take', title: 'Mark as taken' },
  { action: 'snooze', title: 'Snooze 10 min' },
];

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

export async function disablePush(): Promise<void> {
  clearLocalTimers();
  for (const t of snoozeTimers) clearTimeout(t);
  snoozeTimers = [];
  lastReminders = [];
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

function pluralForm(form: string, qty: number): string {
  return qty === 1 || /s$/i.test(form) ? form : `${form}s`;
}

function reminderBody(med: Medication): string {
  const parts: string[] = [];
  if (med.dosage?.trim()) parts.push(med.dosage.trim());
  const form = med.form?.trim();
  const qty = med.quantityPerDose;
  if (qty && form) parts.push(`${qty} ${pluralForm(form, qty)}`);
  else if (qty) parts.push(`${qty} ${qty === 1 ? 'unit' : 'units'}`);
  else if (form) parts.push(form);
  if (med.instructions?.trim()) parts.push(med.instructions.trim());
  const body = parts.join(' · ');
  return body.length > 280 ? `${body.slice(0, 277)}…` : body;
}

function buildReminders(
  meds: Medication[],
  doseLogs: DoseLog[],
  opts: SyncOptions,
): { reminders: PushReminder[]; dismissed: string[] } {
  const now = Date.now();
  const horizon = Math.max(1, Math.min(opts.horizonDays ?? 30, 365));
  const from = new Date(now);
  const to = new Date(now + horizon * 86_400_000);

  const logged = new Set<string>();
  const dismissed: string[] = [];
  for (const log of doseLogs) {
    const ms = Date.parse(log.scheduledFor);
    if (Number.isNaN(ms)) continue;
    const id = `${log.medId}@${ms}`;
    logged.add(id);
    // Handled recently: lets the server cancel any pending snooze for it.
    if (now - ms < 12 * 3_600_000 && ms < now + 3_600_000) dismissed.push(id);
  }

  const reminders: PushReminder[] = [];
  for (const med of meds) {
    if (!med.notificationsEnabled) continue;
    const title = opts.discreet ? DISCREET_TITLE : `Time to take ${med.name}`;
    const body = opts.discreet ? DISCREET_BODY : reminderBody(med);
    for (const occ of occurrencesBetween(med.schedule, from, to)) {
      const at = occ.getTime();
      const id = `${med.id}@${at}`;
      if (logged.has(id)) continue;
      reminders.push({ id, medId: med.id, at, title, body });
    }
  }
  reminders.sort((a, b) => a.at - b.at);
  return { reminders, dismissed: dismissed.slice(-500) };
}

// ---------- local fallback scheduler ----------

let localTimers: ReturnType<typeof setTimeout>[] = [];
let lastReminders: PushReminder[] = [];
let localActive = false;
let rearmInterval: ReturnType<typeof setInterval> | null = null;
const shownLocally = new Set<string>();

function clearLocalTimers(): void {
  for (const t of localTimers) clearTimeout(t);
  localTimers = [];
  localActive = false;
}

function notificationData(r: PushReminder) {
  return {
    medId: r.medId,
    scheduledFor: new Date(r.at).toISOString(),
    reminderId: r.id,
    deviceId: getDeviceId(),
    reminder: r,
  };
}

/** `key` dedupes; the notification itself always describes the original dose `r`. */
async function showLocal(r: PushReminder, key = r.id): Promise<void> {
  if (shownLocally.has(key)) return;
  shownLocally.add(key);
  try {
    const reg = await activeRegistration();
    if (!reg || Notification.permission !== 'granted') return;
    await reg.showNotification(r.title, {
      body: r.body,
      tag: r.id,
      data: notificationData(r),
      icon: ICON,
      badge: ICON,
      renotify: true,
      requireInteraction: true,
      actions: NOTIFICATION_ACTIONS,
    } as NotificationOptions);
  } catch (err) {
    console.warn('Local notification failed:', err);
  }
}

/** (Re)arm timers for reminders due in the next 24h. Returns how many are pending/armed. */
function armLocalTimers(): number {
  for (const t of localTimers) clearTimeout(t);
  localTimers = [];
  const now = Date.now();
  let armed = 0;
  for (const r of lastReminders) {
    const delay = r.at - now;
    if (delay > LOCAL_WINDOW_MS) break; // sorted ascending
    if (delay <= 0) {
      // Missed while the tab/device was suspended: show if only slightly overdue.
      if (-delay <= LOCAL_GRACE_MS) void showLocal(r);
      continue;
    }
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
  // Timers are throttled/frozen in background tabs; re-arm and catch up on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && localActive) armLocalTimers();
  });
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
    const minutes = Math.min(120, Math.max(1, Number(d.minutes) || 10));
    const key = `${r.id}#snooze@${Date.now()}`;
    snoozeTimers.push(setTimeout(() => void showLocal(r, key), minutes * 60_000));
  });
}

// ---------- sync ----------

let syncChain: Promise<unknown> = Promise.resolve();
let lastPostSig = '';
let lastPostAt = 0;

async function postReminders(reminders: PushReminder[], dismissed: string[]): Promise<boolean> {
  const capped = reminders.slice(0, MAX_SERVER_REMINDERS);
  const sig = `${capped.length}:${capped.map((r) => `${r.id}|${r.title}|${r.body}`).join(';')}:${dismissed.join(',')}`;
  if (sig === lastPostSig && Date.now() - lastPostAt < 30_000) return true;

  const deviceId = getDeviceId();
  const send = () =>
    fetchJson(api('push/reminders'), { method: 'POST', body: { deviceId, reminders: capped, dismissed } }, 20_000);
  let res = await send();
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
    return { count: 0, mode: 'off' };
  }

  const { reminders, dismissed } = buildReminders(meds, doseLogs, opts);

  if (state === 'subscribed') {
    try {
      const reg = await activeRegistration();
      const sub = reg ? await ensureCurrentSubscription(reg) : null;
      if (sub && (await postReminders(reminders, dismissed))) {
        clearLocalTimers();
        lastReminders = [];
        return { count: Math.min(reminders.length, MAX_SERVER_REMINDERS), mode: 'push' };
      }
    } catch (err) {
      console.warn('Could not sync reminders to the push server, using local reminders:', err);
    }
  }

  // Local fallback (permission granted, but no subscription or the server is unreachable).
  lastReminders = reminders;
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
  await reg.showNotification('MedTracker test', {
    body: 'Notifications are working on this device.',
    tag: 'medtracker-test',
    icon: ICON,
    badge: ICON,
  });
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
