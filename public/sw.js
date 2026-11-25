/* MedTracker service worker: push notifications only (no offline caching). */

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

function notificationOptions({ body, tag, data }) {
  return {
    body,
    tag,
    data,
    icon: ICON,
    badge: ICON,
    renotify: true,
    requireInteraction: true,
    actions: [
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
      payload = { title: 'MedTracker', body: event.data.text() };
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

async function focusOrOpen(url) {
  const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
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
      const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      // One window only, so several open tabs don't each re-show it.
      if (all.length) {
        all[0].postMessage({ type: 'snooze-local', reminder: data.reminder, minutes: 10 });
      } else {
        await self.registration.showNotification("Couldn't snooze", {
          body: 'Open MedTracker to get your reminder again.',
          tag: 'medtracker-snooze-failed',
          icon: ICON,
        });
      }
    }
    return;
  }

  if (action === 'take' && data.medId && data.scheduledFor) {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
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
