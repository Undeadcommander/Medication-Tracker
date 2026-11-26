// Guest wipe and releaseGuestSync must never touch Google accounts' sync state (#1).
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from './auth';

const { calls, record } = vi.hoisted(() => {
  const calls: string[] = [];
  return { calls, record: (name: string) => vi.fn(async () => void calls.push(name)) };
});

vi.mock('./auth', () => ({
  clearSession: vi.fn(() => void calls.push('clearSession')),
  loadSession: vi.fn(() => null as User | null),
  signOut: vi.fn(async () => void calls.push('signOut')),
  deleteFirebaseUser: vi.fn(async () => void calls.push('deleteFirebaseUser')),
  reauthenticateForDeletion: vi.fn(),
}));
vi.mock('./push', () => ({
  disablePush: record('disablePush'),
  forgetReminderState: vi.fn(() => void calls.push('forgetReminderState')),
}));
vi.mock('./store', () => ({ deleteLocalData: record('deleteLocalData') }));
vi.mock('./sync', () => ({
  clearSyncCache: vi.fn(async () => {
    calls.push('clearSyncCache');
    return true;
  }),
  forgetSyncState: record('forgetSyncState'),
  releaseSyncClient: record('releaseSyncClient'),
  secureLocalCopy: record('secureLocalCopy'),
}));
vi.mock('./session', () => ({
  accountsInUse: vi.fn(async () => [] as string[] | null),
  claimSignOut: vi.fn(async () => true),
  releaseSignOutClaim: vi.fn(() => void calls.push('releaseClaim')),
  endSessionInOtherTabs: record('endOtherTabs'),
  endSessionHere: record('endHere'),
  cancelSignOut: vi.fn(() => void calls.push('cancelSignOut')),
  finishSignOut: vi.fn(() => void calls.push('finishSignOut')),
  isAccountDeleted: vi.fn(() => false),
  markAccountDeleted: vi.fn(() => void calls.push('markDeleted')),
  markDeviceWiped: vi.fn(() => void calls.push('markWiped')),
  noteWipePending: vi.fn(),
  pendingWipes: vi.fn(() => [] as string[]),
  unfinishedDeletions: vi.fn(() => [] as string[]),
  whileNotSigningOut: vi.fn(async (_id: string, fn: () => Promise<void>) => {
    await fn();
    return true;
  }),
}));
vi.mock('./drugLookup', () => ({ clearDrugInfoCache: vi.fn(() => void calls.push('clearDrugInfoCache')) }));

const storage = new Map<string, string>();
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

const { wipeDevice, deleteAccount, releaseGuestSync } = await import('./account');
const authMod = await import('./auth');
const sessionMod = await import('./session');
const syncMod = await import('./sync');

const guest: User = { id: 'guest', name: 'Guest', provider: 'guest' };
const googleUser: User = { id: 'firebase:u1', name: 'Ada', provider: 'google' };

beforeEach(() => {
  calls.length = 0;
  storage.clear();
  vi.clearAllMocks();
  vi.mocked(authMod.loadSession).mockImplementation(() => null);
  vi.mocked(sessionMod.accountsInUse).mockImplementation(async () => []);
  vi.mocked(sessionMod.isAccountDeleted).mockImplementation(() => false);
  vi.mocked(syncMod.clearSyncCache).mockImplementation(async () => {
    calls.push('clearSyncCache');
    return true;
  });
  vi.mocked(syncMod.releaseSyncClient).mockImplementation(async () => void calls.push('releaseSyncClient'));
});

describe('guest sync isolation (#1)', () => {
  it('guest wipeDevice never calls clearSyncCache and calls releaseSyncClient', async () => {
    await wipeDevice(guest);

    expect(syncMod.clearSyncCache).not.toHaveBeenCalled();
    expect(syncMod.forgetSyncState).not.toHaveBeenCalled();
    expect(syncMod.releaseSyncClient).toHaveBeenCalledTimes(1);
    expect(calls).toContain('deleteLocalData');
    expect(calls).toContain('clearSession');
  });

  it('guest deleteAccount never calls clearSyncCache and calls releaseSyncClient', async () => {
    const result = await deleteAccount(guest, null);

    expect(result).toEqual({ deleted: true });
    expect(syncMod.clearSyncCache).not.toHaveBeenCalled();
    expect(syncMod.forgetSyncState).not.toHaveBeenCalled();
    expect(syncMod.releaseSyncClient).toHaveBeenCalledTimes(1);
  });

  it('releaseGuestSync with stale flag set and a firebase account in use does not clear sync cache', async () => {
    storage.set('medtracker.syncCacheStale', '1');
    vi.mocked(sessionMod.accountsInUse).mockResolvedValueOnce(['firebase:u1']);

    await releaseGuestSync();

    expect(syncMod.releaseSyncClient).toHaveBeenCalledTimes(1);
    expect(syncMod.clearSyncCache).not.toHaveBeenCalled();
    expect(storage.get('medtracker.syncCacheStale')).toBe('1');

    // Also skips clearing if saved session is an active Google account.
    vi.mocked(sessionMod.accountsInUse).mockResolvedValueOnce([]);
    vi.mocked(authMod.loadSession).mockReturnValueOnce(googleUser);

    await releaseGuestSync();

    expect(syncMod.clearSyncCache).not.toHaveBeenCalled();
    expect(storage.get('medtracker.syncCacheStale')).toBe('1');
  });

  it('releaseGuestSync with stale flag set and no firebase account in use clears with firestoreOnly', async () => {
    storage.set('medtracker.syncCacheStale', '1');
    vi.mocked(sessionMod.accountsInUse).mockResolvedValueOnce([]);
    vi.mocked(authMod.loadSession).mockReturnValueOnce(null);

    await releaseGuestSync();

    expect(syncMod.releaseSyncClient).toHaveBeenCalledTimes(1);
    expect(syncMod.clearSyncCache).toHaveBeenCalledTimes(1);
    expect(syncMod.clearSyncCache).toHaveBeenCalledWith({
      openFirst: true,
      firestoreOnly: true,
      unlessSyncing: true,
    });
    expect(storage.get('medtracker.syncCacheStale')).toBeUndefined();
  });
});
