/* Dosely service worker: push notifications only (no offline caching). */

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Paths are resolved against this worker's scope, so the app works under a sub-path
// (e.g. https://user.github.io/Medication-Tracker/).
const SCOPE = self.registration.scope;
const ICON = new URL('icons/icon-192.png', SCOPE).href;
// API root is passed as ?api=… when the page registers the worker; absent = no reminder server.
const API = new URL(self.location.href).searchParams.get('api');

/** A notification for several doses (data.reminder.doses): it can be snoozed, not marked as taken. */
function isGroup(data) {
  const doses = data && data.reminder && data.reminder.doses;
  return Array.isArray(doses) && doses.length > 1;
}

function notificationOptions({ body, tag, data }) {
  return {
    body,
    tag,
    data,
    icon: ICON,
    badge: ICON,
    renotify: true,
    requireInteraction: true,
    // Grouped: no "Mark as taken" (the user should see which doses first); snooze covers the group.
    actions: isGroup(data)
      ? [{ action: 'snooze', title: 'Snooze 10 min' }]
      : [
          { action: 'take', title: 'Mark as taken' },
          { action: 'snooze', title: 'Snooze 10 min' },
        ],
  };
}

self.addEventListener('push', (event) => {
  let payload = {};
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: 'Dosely', body: event.data.text() };
    }
  }
  const title = payload.title || 'Time for your medication';
  // `tag` must be a non-empty string for renotify to be valid.
  const tag = payload.tag || 'medtracker';
  event.waitUntil(self.registration.showNotification(title, notificationOptions({ ...payload, tag })));
});

// The page can ask the SW to show a notification (local fallback mode).
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'show-local') return;
  const title = msg.title || 'Time for your medication';
  const tag = msg.tag || 'medtracker';
  event.waitUntil(self.registration.showNotification(title, notificationOptions({ ...msg, tag })));
});

/**
 * This app's open windows. matchAll returns every same-origin window, and on GitHub Pages the
 * origin (user.github.io) is shared with the owner's other sites, so keep only ones in our scope.
 */
async function appWindows() {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return all.filter((client) => client.url.startsWith(SCOPE));
}

async function focusOrOpen(url) {
  const all = await appWindows();
  for (const client of all) {
    if ('focus' in client) {
      await client.focus();
      return client;
    }
  }
  if (self.clients.openWindow) return self.clients.openWindow(url);
  return null;
}

async function handleClick(event) {
  const data = event.notification.data || {};
  const action = event.action;

  if (action === 'snooze') {
    // data.reminder carries the group's doses, so the whole group comes back.
    if (!data.reminder) return;
    let snoozed = false;
    if (data.deviceId && API) {
      try {
        const res = await fetch(`${API}/push/snooze`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ deviceId: data.deviceId, reminder: data.reminder, minutes: 10 }),
        });
        snoozed = res.ok;
      } catch (err) {
        // Offline or server down: fall through to the in-page snooze.
      }
    }
    if (!snoozed) {
      // Local mode (no push subscription, or server unreachable): let an open app window
      // re-show it in 10 minutes. Local reminders only run while the app is open anyway.
      const all = await appWindows();
      // One window only, so several open tabs don't each re-show it.
      if (all.length) {
        all[0].postMessage({ type: 'snooze-local', reminder: data.reminder, minutes: 10 });
      } else {
        await self.registration.showNotification("Couldn't snooze", {
          body: 'Open Dosely to get your reminder again.',
          tag: 'medtracker-snooze-failed',
          icon: ICON,
        });
      }
    }
    return;
  }

  if (action === 'take' && data.medId && data.scheduledFor && !isGroup(data)) {
    const all = await appWindows();
    if (all.length) {
      const client = all[0];
      client.postMessage({ type: 'dose-taken', medId: data.medId, scheduledFor: data.scheduledFor });
      if ('focus' in client) await client.focus();
      return;
    }
    const url = `${SCOPE}?take=${encodeURIComponent(data.medId)}&at=${encodeURIComponent(data.scheduledFor)}`;
    if (self.clients.openWindow) await self.clients.openWindow(url);
    return;
  }

  await focusOrOpen(SCOPE);
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(handleClick(event));
});

const IDB_NAME = 'dosely-sw';
const IDB_STORE = 'kv';
const DEVICE_ID_KEY = 'deviceId';

function readDeviceId() {
  const idb = typeof indexedDB !== 'undefined' ? indexedDB : self.indexedDB;
  if (!idb) return Promise.resolve(null);
  return new Promise((resolve) => {
    try {
      const req = idb.open(IDB_NAME, 1);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames || !db.objectStoreNames.contains(IDB_STORE)) {
          db.createObjectStore(IDB_STORE);
        }
      };
      req.onerror = () => resolve(null);
      req.onsuccess = () => {
        const db = req.result;
        const closeDb = () => {
          if (db && typeof db.close === 'function') db.close();
        };
        try {
          if (db.objectStoreNames && !db.objectStoreNames.contains(IDB_STORE)) {
            closeDb();
            resolve(null);
            return;
          }
          const tx = db.transaction(IDB_STORE, 'readonly');
          const getReq = tx.objectStore(IDB_STORE).get(DEVICE_ID_KEY);
          getReq.onsuccess = () => {
            closeDb();
            resolve(typeof getReq.result === 'string' && getReq.result ? getReq.result : null);
          };
          getReq.onerror = () => {
            closeDb();
            resolve(null);
          };
        } catch {
          closeDb();
          resolve(null);
        }
      };
    } catch {
      resolve(null);
    }
  });
}

// Re-register when the browser rotates the push subscription in the background; otherwise the
// reminder server would keep pushing to the dead endpoint and drop the device.
async function onSubscriptionChange(event) {
  if (!API) return;
  try {
    const deviceId = await readDeviceId();
    if (!deviceId) return;

    const pm = self.registration.pushManager;
    let sub = (event && event.newSubscription) || (pm ? await pm.getSubscription() : null);
    if (!sub) {
      if (!pm) return;
      const keyRes = await fetch(`${API}/push/public-key`);
      if (!keyRes.ok) return;
      const data = await keyRes.json();
      const publicKey = data && data.publicKey;
      if (typeof publicKey !== 'string' || !publicKey) return;
      sub = await pm.subscribe({ userVisibleOnly: true, applicationServerKey: publicKey });
    }
    if (!sub) return;

    await fetch(`${API}/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deviceId, subscription: sub.toJSON() }),
    });
  } catch (err) {
    if (typeof console !== 'undefined' && console.warn) {
      console.warn('pushsubscriptionchange failed', err);
    }
  }
}

self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil(onSubscriptionChange(event));
});
