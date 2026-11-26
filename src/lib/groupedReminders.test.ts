import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GROUP_WINDOW_MS, MAX_GROUP_DOSES } from '../../shared/reminderText';
import { makeSchedule } from '../../shared/schedule';
import type { Medication, PushDose } from '../../shared/types';

// 2026-06-10 09:00 local
const NOW = new Date(2026, 5, 10, 9, 0, 0).getTime();

function med(id: string, times: string[], extra: Partial<Medication> = {}): Medication {
  return {
    id,
    name: `Med ${id}`,
    dosage: '10 mg',
    color: '#000',
    schedule: { ...makeSchedule('daily', '2026-06-01'), useSpecificTimes: true, times },
    notificationsEnabled: true,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    ...extra,
  };
}

function at(h: number, m: number, s = 0, ms = 0): number {
  return new Date(2026, 5, 10, h, m, s, ms).getTime();
}

interface NotificationOpts {
  body: string;
  tag: string;
  actions: { action: string; title: string }[];
  data: {
    medId: string;
    scheduledFor: string;
    reminderId: string;
    deviceId: string;
    count?: number;
    reminder: {
      id: string;
      medId: string;
      at: number;
      title: string;
      body: string;
      doses?: PushDose[];
    };
  };
}

let showNotification: ReturnType<typeof vi.fn<(...a: unknown[]) => Promise<void>>>;
let store: Map<string, string>;
let swListeners: Record<string, ((event: MessageEvent) => void)[]>;

async function load() {
  vi.resetModules();
  return import('./push');
}

function log(medId: string, ms: number) {
  return {
    id: `${medId}-${ms}`,
    medId,
    scheduledFor: new Date(ms).toISOString(),
    status: 'taken' as const,
    loggedAt: new Date(NOW).toISOString(),
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  showNotification = vi.fn(async (..._a: unknown[]) => {});
  store = new Map();
  swListeners = {};
  const reg = {
    active: {},
    showNotification: (...a: unknown[]) => showNotification(...a),
    pushManager: { getSubscription: async () => null },
  };
  vi.stubEnv('VITE_API_BASE', 'none');
  vi.stubGlobal('window', {
    Notification: {},
    addEventListener: () => {},
    matchMedia: () => ({ matches: true }),
    dispatchEvent: () => true,
  });
  vi.stubGlobal('document', { visibilityState: 'visible', addEventListener: () => {} });
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
      register: async () => reg,
      ready: new Promise(() => {}),
      addEventListener: (type: string, fn: (event: MessageEvent) => void) => {
        (swListeners[type] ??= []).push(fn);
      },
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('groupDoses', () => {
  it('returns an empty list for empty input', async () => {
    const { groupDoses } = await load();
    expect(groupDoses([])).toEqual([]);
  });

  it('keeps single-dose reminders without a doses field and uses discreet text', async () => {
    const { groupDoses } = await load();
    const res = groupDoses([{ medId: 'a', at: at(9, 30) }]);
    expect(res).toHaveLength(1);
    expect(res[0]).toEqual({
      id: `a@${at(9, 30)}`,
      medId: 'a',
      at: at(9, 30),
      title: 'Time for your medication',
      body: 'Open Dosely to review your dose.',
    });
    expect('doses' in res[0]).toBe(false);
  });

  it('groups doses within the 10-minute anchored window (including exact boundary, excluding +1ms)', async () => {
    const { groupDoses } = await load();
    expect(GROUP_WINDOW_MS).toBe(10 * 60_000);
    const t0 = at(9, 0);
    const t10 = t0 + 10 * 60_000;
    const t10plus1 = t10 + 1;

    const res = groupDoses([
      { medId: 'b', at: t10 },
      { medId: 'c', at: t10plus1 },
      { medId: 'a', at: t0 },
    ]);

    expect(res).toHaveLength(2);
    expect(res[0]).toEqual({
      id: `a@${t0}`,
      medId: 'a',
      at: t0,
      title: 'Time for your medications',
      body: '2 medications are due. Open Dosely to review them.',
      doses: [
        { medId: 'a', at: t0 },
        { medId: 'b', at: t10 },
      ],
    });
    expect(res[1]).toEqual({
      id: `c@${t10plus1}`,
      medId: 'c',
      at: t10plus1,
      title: 'Time for your medication',
      body: 'Open Dosely to review your dose.',
    });
    expect('doses' in res[1]).toBe(false);
  });

  it('anchors the 10-minute window on the first ungrouped dose rather than chaining', async () => {
    const { groupDoses } = await load();
    const res = groupDoses([
      { medId: 'a', at: at(9, 0) },
      { medId: 'b', at: at(9, 6) },
      { medId: 'c', at: at(9, 12) },
    ]);

    expect(res).toHaveLength(2);
    expect(res[0].id).toBe(`a@${at(9, 0)}`);
    expect(res[0].doses).toEqual([
      { medId: 'a', at: at(9, 0) },
      { medId: 'b', at: at(9, 6) },
    ]);
    expect(res[1].id).toBe(`c@${at(9, 12)}`);
    expect('doses' in res[1]).toBe(false);
  });

  it('caps a group at MAX_GROUP_DOSES (20) and starts another group for overflow', async () => {
    const { groupDoses } = await load();
    expect(MAX_GROUP_DOSES).toBe(20);
    const t = at(9, 0);
    const doses: PushDose[] = Array.from({ length: 21 }, (_, i) => ({
      medId: `m${String(i).padStart(2, '0')}`,
      at: t + i * 1000,
    }));

    const res = groupDoses(doses);
    expect(res).toHaveLength(2);
    expect(res[0].doses).toHaveLength(20);
    expect(res[0].body).toBe('20 medications are due. Open Dosely to review them.');
    expect(res[1].medId).toBe('m20');
    expect('doses' in res[1]).toBe(false);
  });

  it('sorts simultaneous doses by medId ascending when choosing group id and member order', async () => {
    const { groupDoses } = await load();
    const t = at(9, 15);
    const res = groupDoses([
      { medId: 'z', at: t },
      { medId: 'a', at: t },
      { medId: 'm', at: t },
    ]);

    expect(res).toHaveLength(1);
    expect(res[0].id).toBe(`a@${t}`);
    expect(res[0].medId).toBe('a');
    expect(res[0].doses).toEqual([
      { medId: 'a', at: t },
      { medId: 'm', at: t },
      { medId: 'z', at: t },
    ]);
  });
});

describe('local grouped notifications: discreet text and actions', () => {
  it('shows discreet text and [take, snooze] actions for a single dose without leaking med details', async () => {
    const { syncReminders } = await load();
    await syncReminders([med('a', ['09:30'], { instructions: 'Take with food' })], []);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(1);

    const [title, opts] = showNotification.mock.calls[0] as [string, NotificationOpts];
    expect(title).toBe('Time for your medication');
    expect(opts.body).toBe('Open Dosely to review your dose.');
    expect(opts.actions).toEqual([
      { action: 'take', title: 'Mark as taken' },
      { action: 'snooze', title: 'Snooze 10 min' },
    ]);
    expect(opts.data.count).toBeUndefined();
    expect(opts.data.reminder.doses).toBeUndefined();
    expect(opts.data.medId).toBe('a');
    expect(opts.data.reminderId).toBe(`a@${at(9, 30)}`);

    const serialized = JSON.stringify({ title, opts });
    expect(serialized).not.toContain('Med a');
    expect(serialized).not.toContain('10 mg');
    expect(serialized).not.toContain('Take with food');
  });

  it('groups doses within 10 minutes in syncReminders with discreet plural text, snooze-only action, and group data', async () => {
    const { syncReminders } = await load();
    const meds = [
      med('a', ['09:30'], { instructions: 'Take with food' }),
      med('b', ['09:35'], { instructions: 'Before bed' }),
      med('c', ['09:42']),
    ];
    const res = await syncReminders(meds, []);

    expect(res.mode).toBe('local');
    expect(res.count).toBe(2); // {a@09:30, b@09:35} and {c@09:42}

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(1);

    const [title1, opts1] = showNotification.mock.calls[0] as [string, NotificationOpts];
    expect(title1).toBe('Time for your medications');
    expect(opts1.body).toBe('2 medications are due. Open Dosely to review them.');
    expect(opts1.tag).toBe(`a@${at(9, 30)}`);
    expect(opts1.actions).toEqual([{ action: 'snooze', title: 'Snooze 10 min' }]);
    expect(opts1.data.count).toBe(2);
    expect(opts1.data.reminderId).toBe(`a@${at(9, 30)}`);
    expect(opts1.data.reminder.doses).toEqual([
      { medId: 'a', at: at(9, 30) },
      { medId: 'b', at: at(9, 35) },
    ]);

    const serialized1 = JSON.stringify({ title1, opts1 });
    expect(serialized1).not.toContain('Med a');
    expect(serialized1).not.toContain('Med b');
    expect(serialized1).not.toContain('10 mg');
    expect(serialized1).not.toContain('Take with food');
    expect(serialized1).not.toContain('Before bed');

    // Advancing to 09:35 and re-syncing must not re-show the group's already-claimed doses.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await syncReminders(meds, []);
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).toHaveBeenCalledTimes(1);

    // Passing 09:42 triggers the second (single-dose) notification.
    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(2);
    const [title2, opts2] = showNotification.mock.calls[1] as [string, NotificationOpts];
    expect(title2).toBe('Time for your medication');
    expect(opts2.tag).toBe(`c@${at(9, 42)}`);
    expect(opts2.actions).toEqual([
      { action: 'take', title: 'Mark as taken' },
      { action: 'snooze', title: 'Snooze 10 min' },
    ]);
  });
});

describe('member-level dedupe (local mode)', () => {
  it('claims both dose ids in localStorage and does not re-show b@09:35 after logging a@09:30', async () => {
    const { syncReminders } = await load();
    const meds = [med('a', ['09:30']), med('b', ['09:35'])];
    await syncReminders(meds, []);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(1);

    const shown = JSON.parse(store.get('medtracker.shownReminders') ?? '{}') as Record<string, number>;
    expect(Object.keys(shown).sort()).toEqual([`a@${at(9, 30)}`, `b@${at(9, 35)}`].sort());

    // User logs a@09:30 at 09:31 and syncReminders recomputes upcoming reminders (b@09:35 alone).
    await vi.advanceTimersByTimeAsync(60_000);
    await syncReminders(meds, [log('a', at(9, 30))]);

    // Advance past 09:35 (and re-sync at 09:36): b@09:35 must not be shown again.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await syncReminders(meds, [log('a', at(9, 30))]);
    await vi.advanceTimersByTimeAsync(0);
    expect(showNotification).toHaveBeenCalledTimes(1);
  });
});

describe('local snooze of a group', () => {
  function dispatchSwMessage(data: unknown) {
    for (const fn of swListeners.message ?? []) fn({ data } as MessageEvent);
  }

  it('re-shows the whole group 10 minutes after snooze-local even though its doses were claimed', async () => {
    const { syncReminders } = await load();
    const meds = [med('a', ['09:30']), med('b', ['09:35'])];
    await syncReminders(meds, []);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [, firstOpts] = showNotification.mock.calls[0] as [string, NotificationOpts];

    dispatchSwMessage({ type: 'snooze-local', reminder: firstOpts.data.reminder, minutes: 10 });

    await vi.advanceTimersByTimeAsync(9 * 60_000 + 59_000);
    expect(showNotification).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1000);
    expect(showNotification).toHaveBeenCalledTimes(2);
    const [title2, opts2] = showNotification.mock.calls[1] as [string, NotificationOpts];
    expect(title2).toBe('Time for your medications');
    expect(opts2.body).toBe('2 medications are due. Open Dosely to review them.');
    expect(opts2.actions).toEqual([{ action: 'snooze', title: 'Snooze 10 min' }]);
    expect(opts2.data.count).toBe(2);
    expect(opts2.data.reminder.doses).toEqual([
      { medId: 'a', at: at(9, 30) },
      { medId: 'b', at: at(9, 35) },
    ]);
  });

  it('drops doses logged during the snooze and switches to single-dose text/actions when 1 remains', async () => {
    const { syncReminders } = await load();
    const meds = [med('a', ['09:30']), med('b', ['09:35'])];
    await syncReminders(meds, []);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [, firstOpts] = showNotification.mock.calls[0] as [string, NotificationOpts];

    dispatchSwMessage({ type: 'snooze-local', reminder: firstOpts.data.reminder, minutes: 10 });

    await vi.advanceTimersByTimeAsync(3 * 60_000);
    await syncReminders(meds, [log('a', at(9, 30))]);

    await vi.advanceTimersByTimeAsync(7 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(2);
    const [title2, opts2] = showNotification.mock.calls[1] as [string, NotificationOpts];
    expect(title2).toBe('Time for your medication');
    expect(opts2.body).toBe('Open Dosely to review your dose.');
    expect(opts2.tag).toBe(`b@${at(9, 35)}`);
    expect(opts2.actions).toEqual([
      { action: 'take', title: 'Mark as taken' },
      { action: 'snooze', title: 'Snooze 10 min' },
    ]);
    expect(opts2.data.count).toBeUndefined();
    expect(opts2.data.reminder.doses).toBeUndefined();
  });

  it('shows nothing when all doses in the snoozed group are logged before snooze fires', async () => {
    const { syncReminders } = await load();
    const meds = [med('a', ['09:30']), med('b', ['09:35'])];
    await syncReminders(meds, []);

    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(1);
    const [, firstOpts] = showNotification.mock.calls[0] as [string, NotificationOpts];

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    dispatchSwMessage({ type: 'snooze-local', reminder: firstOpts.data.reminder, minutes: 10 });
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 10 * 60_000);

    await vi.advanceTimersByTimeAsync(4 * 60_000);
    await syncReminders(meds, [log('a', at(9, 30)), log('b', at(9, 35))]);

    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(showNotification).toHaveBeenCalledTimes(1);
    const shownKeys = Object.keys(JSON.parse(store.get('medtracker.shownReminders') ?? '{}') as Record<string, number>);
    expect(shownKeys.some((k) => k.includes('#snooze@'))).toBe(false);
  });
});

describe('push path payload', () => {
  it('posts discreet grouped reminders (with doses) to push/reminders when subscribed', async () => {
    const vapidBytes = new Uint8Array([1, 2, 3]);
    const subscription = {
      options: { applicationServerKey: vapidBytes.buffer },
      toJSON: () => ({ endpoint: 'https://push.example/sub' }),
      unsubscribe: async () => true,
    };
    const reg = {
      active: {},
      showNotification: (...a: unknown[]) => showNotification(...a),
      pushManager: { getSubscription: async () => subscription },
    };
    vi.stubEnv('VITE_API_BASE', 'https://srv.example/api');
    vi.stubGlobal('location', { href: 'https://app.example/' });
    vi.stubGlobal('window', {
      Notification: {},
      PushManager: {},
      addEventListener: () => {},
      matchMedia: () => ({ matches: true }),
      dispatchEvent: () => true,
    });
    vi.stubGlobal('navigator', {
      userAgent: 'test',
      platform: 'x',
      serviceWorker: {
        register: async () => reg,
        ready: new Promise(() => {}),
        addEventListener: (type: string, fn: (event: MessageEvent) => void) => {
          (swListeners[type] ??= []).push(fn);
        },
      },
    });

    const posted: { url: string; body: { deviceId: string; reminders: NotificationOpts['data']['reminder'][] } }[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (url === 'https://srv.example/api/push/public-key') {
          return { ok: true, status: 200, json: async () => ({ publicKey: 'AQID' }) };
        }
        if (url === 'https://srv.example/api/push/reminders' && init?.method === 'POST') {
          posted.push({ url, body: JSON.parse(init.body ?? '{}') });
          return { ok: true, status: 200, json: async () => ({ ok: true }) };
        }
        return { ok: false, status: 404, json: async () => ({}) };
      }),
    );

    const { syncReminders } = await load();
    const res = await syncReminders(
      [
        med('a', ['09:30'], { instructions: 'Take with food' }),
        med('b', ['09:35']),
        med('c', ['10:00']),
      ],
      [],
      { horizonDays: 1 },
    );

    expect(res.mode).toBe('push');
    expect(showNotification).not.toHaveBeenCalled();
    expect(posted).toHaveLength(1);
    const { reminders } = posted[0].body;
    expect(reminders).toHaveLength(2);
    expect(reminders[0]).toEqual({
      id: `a@${at(9, 30)}`,
      medId: 'a',
      at: at(9, 30),
      title: 'Time for your medications',
      body: '2 medications are due. Open Dosely to review them.',
      doses: [
        { medId: 'a', at: at(9, 30) },
        { medId: 'b', at: at(9, 35) },
      ],
    });
    expect(reminders[1]).toEqual({
      id: `c@${at(10, 0)}`,
      medId: 'c',
      at: at(10, 0),
      title: 'Time for your medication',
      body: 'Open Dosely to review your dose.',
    });
    expect('doses' in reminders[1]).toBe(false);

    const serialized = JSON.stringify(reminders);
    expect(serialized).not.toContain('Med a');
    expect(serialized).not.toContain('Med b');
    expect(serialized).not.toContain('Med c');
    expect(serialized).not.toContain('10 mg');
    expect(serialized).not.toContain('Take with food');
  });
});
