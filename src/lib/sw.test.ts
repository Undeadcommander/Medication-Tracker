import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

interface SwHarness {
  listeners: Record<string, (event: unknown) => void>;
  showNotification: ReturnType<typeof vi.fn>;
  openWindow: ReturnType<typeof vi.fn>;
  clientFocus: ReturnType<typeof vi.fn>;
  clientPostMessage: ReturnType<typeof vi.fn>;
  clients: { url: string; focus: () => Promise<void>; postMessage: (msg: unknown) => void }[];
}

function loadSw(opts?: { hasClients?: boolean }): SwHarness {
  const listeners: Record<string, (event: unknown) => void> = {};
  const showNotification = vi.fn(async () => {});
  const openWindow = vi.fn(async () => null);
  const clientFocus = vi.fn(async () => {});
  const clientPostMessage = vi.fn();
  const scope = 'https://app.example/';
  const clients =
    opts?.hasClients === false
      ? []
      : [{ url: `${scope}index.html`, focus: clientFocus, postMessage: clientPostMessage }];

  const selfMock = {
    location: { href: `${scope}sw.js` },
    registration: { scope, showNotification },
    skipWaiting: vi.fn(),
    clients: {
      claim: vi.fn(),
      matchAll: vi.fn(async () => clients),
      openWindow,
    },
    addEventListener: (type: string, fn: (event: unknown) => void) => {
      listeners[type] = fn;
    },
  };

  const swSource = readFileSync(resolve(__dirname, '../../public/sw.js'), 'utf8');
  runInNewContext(swSource, { self: selfMock, fetch: vi.fn(), URL, Promise });

  return { listeners, showNotification, openWindow, clientFocus, clientPostMessage, clients };
}

async function fireWaitUntil(handler: (event: unknown) => void, event: Record<string, unknown>) {
  let pending: Promise<unknown> | undefined;
  handler({
    ...event,
    waitUntil: (p: Promise<unknown>) => {
      pending = p;
    },
  });
  await pending;
}

describe('public/sw.js grouped notification handling', () => {
  it('gives group push payloads only the snooze action and single payloads [take, snooze]', async () => {
    const sw = loadSw();

    await fireWaitUntil(sw.listeners.push, {
      data: {
        json: () => ({
          title: 'Time for your medications',
          body: '2 medications are due. Open Dosely to review them.',
          tag: 'a@1000',
          data: {
            medId: 'a',
            scheduledFor: '2026-06-10T09:30:00.000Z',
            reminder: {
              id: 'a@1000',
              medId: 'a',
              at: 1000,
              doses: [
                { medId: 'a', at: 1000 },
                { medId: 'b', at: 2000 },
              ],
            },
          },
        }),
      },
    });

    expect(sw.showNotification).toHaveBeenCalledTimes(1);
    const [, groupOpts] = sw.showNotification.mock.calls[0] as [string, { actions: unknown[] }];
    expect(groupOpts.actions).toEqual([{ action: 'snooze', title: 'Snooze 10 min' }]);

    await fireWaitUntil(sw.listeners.push, {
      data: {
        json: () => ({
          title: 'Time for your medication',
          body: 'Open Dosely to review your dose.',
          tag: 'c@3000',
          data: {
            medId: 'c',
            scheduledFor: '2026-06-10T10:00:00.000Z',
            reminder: { id: 'c@3000', medId: 'c', at: 3000 },
          },
        }),
      },
    });

    expect(sw.showNotification).toHaveBeenCalledTimes(2);
    const [, singleOpts] = sw.showNotification.mock.calls[1] as [string, { actions: unknown[] }];
    expect(singleOpts.actions).toEqual([
      { action: 'take', title: 'Mark as taken' },
      { action: 'snooze', title: 'Snooze 10 min' },
    ]);
  });

  it('opens/focuses the app instead of posting dose-taken when take is clicked on a group', async () => {
    const sw = loadSw({ hasClients: true });
    await fireWaitUntil(sw.listeners.notificationclick, {
      action: 'take',
      notification: {
        close: vi.fn(),
        data: {
          medId: 'a',
          scheduledFor: '2026-06-10T09:30:00.000Z',
          reminder: {
            id: 'a@1000',
            medId: 'a',
            at: 1000,
            doses: [
              { medId: 'a', at: 1000 },
              { medId: 'b', at: 2000 },
            ],
          },
        },
      },
    });

    expect(sw.clientPostMessage).not.toHaveBeenCalled();
    expect(sw.clientFocus).toHaveBeenCalledTimes(1);
  });

  it('posts dose-taken for a single-dose take click and snooze-local for a group snooze click', async () => {
    const sw = loadSw({ hasClients: true });

    await fireWaitUntil(sw.listeners.notificationclick, {
      action: 'take',
      notification: {
        close: vi.fn(),
        data: {
          medId: 'c',
          scheduledFor: '2026-06-10T10:00:00.000Z',
          reminder: { id: 'c@3000', medId: 'c', at: 3000 },
        },
      },
    });
    expect(sw.clientPostMessage).toHaveBeenCalledWith({
      type: 'dose-taken',
      medId: 'c',
      scheduledFor: '2026-06-10T10:00:00.000Z',
    });

    const groupReminder = {
      id: 'a@1000',
      medId: 'a',
      at: 1000,
      doses: [
        { medId: 'a', at: 1000 },
        { medId: 'b', at: 2000 },
      ],
    };
    await fireWaitUntil(sw.listeners.notificationclick, {
      action: 'snooze',
      notification: {
        close: vi.fn(),
        data: { reminder: groupReminder },
      },
    });
    expect(sw.clientPostMessage).toHaveBeenLastCalledWith({
      type: 'snooze-local',
      reminder: groupReminder,
      minutes: 10,
    });
  });
});
