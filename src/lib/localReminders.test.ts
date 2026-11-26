import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { DoseLog, Medication } from '../../shared/types';

// 2026-06-10 09:00 local
const NOW = new Date(2026, 5, 10, 9, 0, 0).getTime();

function med(id: string, times: string[]): Medication {
  return {
    id,
    name: `Med ${id}`,
    dosage: '10 mg',
    color: '#000',
    schedule: { ...makeSchedule('daily', '2026-06-01'), useSpecificTimes: true, times },
    notificationsEnabled: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
  };
}

function at(h: number, m: number): number {
  return new Date(2026, 5, 10, h, m, 0).getTime();
}

function log(medId: string, ms: number): DoseLog {
  return { id: `${medId}-${ms}`, medId, scheduledFor: new Date(ms).toISOString(), status: 'taken', loggedAt: new Date(NOW).toISOString() };
}

let showNotification: ReturnType<typeof vi.fn<(...a: unknown[]) => Promise<void>>>;
let registrationAvailable: boolean;
let listeners: Record<string, (() => void)[]>;
let store: Map<string, string>;

async function load() {
  vi.resetModules();
  return import('./push');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  showNotification = vi.fn(async (..._a: unknown[]) => {});
  registrationAvailable = true;
  listeners = {};
  store = new Map();
  const add = (type: string, fn: () => void) => void (listeners[type] ??= []).push(fn);
  const reg = {
    active: {},
    showNotification: (...a: unknown[]) => showNotification(...a),
    pushManager: { getSubscription: async () => null },
  };
  vi.stubEnv('VITE_API_BASE', 'none');
  vi.stubGlobal('window', { Notification: {}, addEventListener: add, matchMedia: () => ({ matches: true }), dispatchEvent: () => true });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: add });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  });
  vi.stubGlobal('Notification', { permission: 'granted' });
  vi.stubGlobal('navigator', {
    userAgent: 'test',
    platform: 'x',
    serviceWorker: {
      register: async () => {
        if (!registrationAvailable) throw new Error('no sw');
        return reg;
      },
      ready: new Promise(() => {}),
      addEventListener: () => {},
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('local reminder catch-up', () => {
  it('shows a dose missed 30 minutes ago once on cold start, with normal tag/data', async () => {
    const { syncReminders } = await load();
    await syncReminders([med('a', ['08:30'])], []);
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [, opts] = showNotification.mock.calls[0] as [string, { tag: string; data: { reminderId: string; medId: string } }];
    expect(opts.tag).toBe(`a@${at(8, 30)}`);
    expect(opts.data.reminderId).toBe(opts.tag);
    expect(opts.data.medId).toBe('a');

    // A second sync / resume does not show it again.
    await syncReminders([med('a', ['08:30'])], []);
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('does not show a dose missed 3 hours ago', async () => {
    const { syncReminders } = await load();
    await syncReminders([med('a', ['06:00'])], []);
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('does not show a dose that is already logged', async () => {
    const { syncReminders } = await load();
    await syncReminders([med('a', ['08:30'])], [log('a', at(8, 30))]);
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).not.toHaveBeenCalled();
  });

  it('shows one grouped catch-up notification for the most recent missed dose per medication', async () => {
    const { syncReminders } = await load();
    await syncReminders([med('a', ['07:30', '08:00', '08:45']), med('b', ['08:15'])], []);
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = showNotification.mock.calls[0] as [
      string,
      {
        body: string;
        tag: string;
        actions: { action: string; title: string }[];
        data: { count?: number; reminder: { doses?: { medId: string; at: number }[] } };
      },
    ];
    expect(title).toBe('Time for your medications');
    expect(opts.body).toBe('2 medications are due. Open Dosely to review them.');
    expect(opts.tag).toBe(`b@${at(8, 15)}`);
    expect(opts.actions).toEqual([{ action: 'snooze', title: 'Snooze 10 min' }]);
    expect(opts.data.count).toBe(2);
    expect(opts.data.reminder.doses).toEqual([
      { medId: 'b', at: at(8, 15) },
      { medId: 'a', at: at(8, 45) },
    ]);
  });

  it('skips missed doses already shown and uses single-dose actions when only one med is missed', async () => {
    store.set('medtracker.shownReminders', JSON.stringify({ [`a@${at(8, 45)}`]: NOW - 60_000 }));
    const { syncReminders } = await load();
    await syncReminders([med('a', ['08:45']), med('b', ['08:15'])], []);
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [title, opts] = showNotification.mock.calls[0] as [
      string,
      {
        body: string;
        tag: string;
        actions: { action: string; title: string }[];
        data: { count?: number; reminder: { doses?: unknown[] } };
      },
    ];
    expect(title).toBe('Time for your medication');
    expect(opts.body).toBe('Open Dosely to review your dose.');
    expect(opts.tag).toBe(`b@${at(8, 15)}`);
    expect(opts.actions).toEqual([
      { action: 'take', title: 'Mark as taken' },
      { action: 'snooze', title: 'Snooze 10 min' },
    ]);
    expect(opts.data.count).toBeUndefined();
    expect(opts.data.reminder.doses).toBeUndefined();

    // Cold-start reload with both already shown does not show anything.
    const mod2 = await load();
    await mod2.syncReminders([med('a', ['08:45']), med('b', ['08:15'])], []);
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('does not catch up on doses due before the med was added or its reminders were turned on', async () => {
    const { syncReminders } = await load();
    const added = { ...med('a', ['08:30']), createdAt: new Date(at(8, 45)).toISOString() };
    const enabled = { ...med('b', ['08:30']), fieldTimes: { notificationsEnabled: new Date(at(8, 40)).toISOString() } };
    const edited = { ...med('c', ['08:30', '08:50']), fieldTimes: { schedule: new Date(at(8, 40)).toISOString() } };
    await syncReminders([added, enabled, edited], []);
    await vi.advanceTimersByTimeAsync(0);
    const tags = showNotification.mock.calls.map((c) => (c[1] as { tag: string }).tag);
    expect(tags).toEqual([`c@${at(8, 50)}`]);
  });

  it('keeps past reminders out of the count and still arms future ones', async () => {
    const { syncReminders } = await load();
    const res = await syncReminders([med('a', ['08:30', '09:30'])], []);
    expect(res.mode).toBe('local');
    expect(res.count).toBe(2); // 09:30 today and 08:30 tomorrow
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).toHaveBeenCalledTimes(1); // the catch-up
    await vi.advanceTimersByTimeAsync(31 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(2);
    expect((showNotification.mock.calls[1][1] as { tag: string }).tag).toBe(`a@${at(9, 30)}`);
  });

  it('does not burn the claim when the registration is unavailable; a later re-arm retries', async () => {
    registrationAvailable = false;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { syncReminders } = await load();
    await syncReminders([med('a', ['08:30'])], []);
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).not.toHaveBeenCalled();
    expect(store.get('medtracker.shownReminders')).toBeUndefined();

    registrationAvailable = true;
    await vi.advanceTimersByTimeAsync(2000);
    for (const fn of listeners.pageshow ?? []) fn(); // resume
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });

  it('releases the claim when showNotification throws', async () => {
    showNotification.mockRejectedValueOnce(new Error('boom'));
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { syncReminders } = await load();
    await syncReminders([med('a', ['08:30'])], []);
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).toHaveBeenCalledTimes(1);
    expect(JSON.parse(store.get('medtracker.shownReminders') ?? '{}')).toEqual({});

    await vi.advanceTimersByTimeAsync(2000);
    for (const fn of listeners.focus ?? []) fn();
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).toHaveBeenCalledTimes(2);
  });

  it('adds resume listeners once and coalesces triggers within a second', async () => {
    const { syncReminders } = await load();
    await syncReminders([med('a', ['08:30'])], []);
    await syncReminders([med('a', ['08:30'])], []);
    expect(listeners.pageshow?.length).toBe(1);
    expect(listeners.focus?.length).toBe(1);
    expect(listeners.visibilitychange?.length).toBe(1);
  });
});
