// Sign-out whose device wipe fails after the session ended: resolves signed-out with a problem,
// leaves the account noted for cleanup, and retries before reuse or at next startup (#2).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from './auth';
import type { SyncHandle } from './sync';

const storage = new Map<string, string>();
const heldLockNames = new Set<string>();
const origNavigator = globalThis.navigator;

function installGlobals() {
  vi.stubGlobal('localStorage', {
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
    clear: () => void storage.clear(),
  });

  const locksState = new Map<string, { exclusive: boolean; shared: number; queue: Array<() => void> }>();
  const getLock = (name: string) => {
    let s = locksState.get(name);
    if (!s) locksState.set(name, (s = { exclusive: false, shared: 0, queue: [] }));
    return s;
  };
  vi.stubGlobal('navigator', {
    onLine: true,
    locks: {
      request<T>(name: string, a: LockOptions | ((lock: unknown) => Promise<T> | T), b?: (lock: unknown) => Promise<T> | T): Promise<T> {
        const opts = typeof a === 'function' ? {} : a;
        const fn = (typeof a === 'function' ? a : b)!;
        const mode = opts.mode === 'shared' ? 'shared' : 'exclusive';
        const s = getLock(name);
        const busy = mode === 'exclusive' ? s.exclusive || s.shared > 0 : s.exclusive;
        if (opts.ifAvailable && busy) return Promise.resolve().then(() => fn(null));
        return new Promise<T>((resolve, reject) => {
          const run = () => {
            if (mode === 'exclusive') s.exclusive = true;
            else s.shared += 1;
            Promise.resolve()
              .then(() => fn({ name, mode }))
              .then(
                (v) => {
                  if (mode === 'exclusive') s.exclusive = false;
                  else s.shared = Math.max(0, s.shared - 1);
                  s.queue.shift()?.();
                  resolve(v);
                },
                (e) => {
                  if (mode === 'exclusive') s.exclusive = false;
                  else s.shared = Math.max(0, s.shared - 1);
                  s.queue.shift()?.();
                  reject(e);
                },
              );
          };
          if (!busy) run();
          else s.queue.push(run);
        });
      },
      query: async () => ({
        held: [...heldLockNames].map((name) => ({ name })),
        pending: [],
      }),
    },
  });
}

installGlobals();

vi.mock('./auth', () => ({
  clearSession: vi.fn(),
  loadSession: vi.fn(() => null as User | null),
  signOut: vi.fn(async () => {}),
  deleteFirebaseUser: vi.fn(async () => {}),
  reauthenticateForDeletion: vi.fn(async () => true),
}));
vi.mock('./push', () => ({
  disablePush: vi.fn(async () => {}),
  forgetReminderState: vi.fn(),
}));
vi.mock('./store', () => ({
  deleteLocalData: vi.fn(async () => {}),
}));
vi.mock('./sync', () => ({
  clearSyncCache: vi.fn(async () => true),
  forgetSyncState: vi.fn(async () => {}),
  releaseSyncClient: vi.fn(async () => {}),
  secureLocalCopy: vi.fn(async () => {}),
}));
vi.mock('./drugLookup', () => ({
  clearDrugInfoCache: vi.fn(),
}));

const sessionMod = await import('./session');
const {
  signOutAndClear,
  finishDeletionBeforeReuse,
  finishInterruptedDeletions,
  needsCleanupBeforeReuse,
  SIGN_OUT_DEVICE_PROBLEM,
} = await import('./account');
const authMod = await import('./auth');
const storeMod = await import('./store');
const syncMod = await import('./sync');
const drugMod = await import('./drugLookup');

const user: User = { id: 'firebase:u1', name: 'Ada', provider: 'google' };
const fakeSync = () =>
  ({
    flushAll: vi.fn(async () => ({ ok: true as const })),
    deleteCloudData: vi.fn(async () => {}),
  }) as unknown as SyncHandle;
const noTakes = async () => ({ applied: 0, waiting: 0 });

beforeEach(() => {
  storage.clear();
  heldLockNames.clear();
  sessionMod.finishSignOut();
  vi.clearAllMocks();
  vi.mocked(authMod.loadSession).mockImplementation(() => null);
  vi.mocked(storeMod.deleteLocalData).mockImplementation(async () => {});
  vi.mocked(syncMod.clearSyncCache).mockImplementation(async () => true);
});

afterAll(() => {
  sessionMod.finishSignOut();
  vi.stubGlobal('navigator', origNavigator);
});

describe('sign-out device wipe failure and recovery (#2)', () => {
  it('signOutAndClear resolves signed-out with problem when deleteLocalData rejects, signs out, finishes sign-out, and leaves id noted', async () => {
    vi.mocked(storeMod.deleteLocalData).mockRejectedValueOnce(new Error('disk full'));

    const result = await signOutAndClear(user, fakeSync(), { applyPendingTakes: noTakes });

    expect(result).toEqual({ status: 'signed-out', problem: SIGN_OUT_DEVICE_PROBLEM });
    expect(authMod.signOut).toHaveBeenCalledWith(user);
    expect(sessionMod.isSigningOut(user.id)).toBe(false);
    expect(sessionMod.isLeavingHere(user.id)).toBe(false);
    expect(sessionMod.pendingWipes()).toEqual([user.id]);
    expect(needsCleanupBeforeReuse(user.id)).toBe(true);
  });

  it('finishDeletionBeforeReuse retries deleteLocalData, clears sync state, and removes the note', async () => {
    vi.mocked(storeMod.deleteLocalData).mockRejectedValueOnce(new Error('disk full'));
    await signOutAndClear(user, fakeSync(), { applyPendingTakes: noTakes });
    expect(needsCleanupBeforeReuse(user.id)).toBe(true);

    vi.clearAllMocks();
    vi.mocked(storeMod.deleteLocalData).mockRejectedValueOnce(new Error('still failing'));
    await expect(finishDeletionBeforeReuse(user.id)).resolves.toBe(false);
    expect(needsCleanupBeforeReuse(user.id)).toBe(true);
    expect(sessionMod.pendingWipes()).toEqual([user.id]);

    vi.clearAllMocks();
    await expect(finishDeletionBeforeReuse(user.id)).resolves.toBe(true);
    expect(storeMod.deleteLocalData).toHaveBeenCalledWith(user.id);
    expect(syncMod.forgetSyncState).toHaveBeenCalledWith('u1');
    expect(drugMod.clearDrugInfoCache).toHaveBeenCalledTimes(1);
    expect(syncMod.clearSyncCache).toHaveBeenCalledWith({
      openFirst: true,
      firestoreOnly: true,
      unlessSyncing: true,
    });
    expect(sessionMod.pendingWipes()).toEqual([]);
    expect(needsCleanupBeforeReuse(user.id)).toBe(false);
  });

  it('finishInterruptedDeletions retries noted sign-out wipes and clears their notes', async () => {
    sessionMod.noteWipePending(user.id, true);
    expect(needsCleanupBeforeReuse(user.id)).toBe(true);

    await finishInterruptedDeletions();

    expect(storeMod.deleteLocalData).toHaveBeenCalledWith(user.id);
    expect(syncMod.forgetSyncState).toHaveBeenCalledWith('u1');
    expect(drugMod.clearDrugInfoCache).toHaveBeenCalledTimes(1);
    expect(syncMod.clearSyncCache).toHaveBeenCalledWith({
      openFirst: true,
      firestoreOnly: true,
      unlessSyncing: true,
    });
    expect(sessionMod.pendingWipes()).toEqual([]);
    expect(needsCleanupBeforeReuse(user.id)).toBe(false);
  });

  it('un-notes an in-use account without deleting its data', async () => {
    sessionMod.noteWipePending(user.id, true);
    heldLockNames.add(`medtracker-session-${user.id}`);

    await finishInterruptedDeletions();

    expect(storeMod.deleteLocalData).not.toHaveBeenCalled();
    expect(syncMod.forgetSyncState).not.toHaveBeenCalled();
    expect(drugMod.clearDrugInfoCache).not.toHaveBeenCalled();
    expect(syncMod.clearSyncCache).not.toHaveBeenCalled();
    expect(sessionMod.pendingWipes()).toEqual([]);
    expect(needsCleanupBeforeReuse(user.id)).toBe(false);

    // Same guard applies in finishDeletionBeforeReuse.
    sessionMod.noteWipePending(user.id, true);
    await expect(finishDeletionBeforeReuse(user.id)).resolves.toBe(true);
    expect(storeMod.deleteLocalData).not.toHaveBeenCalled();
    expect(sessionMod.pendingWipes()).toEqual([]);
  });
});
