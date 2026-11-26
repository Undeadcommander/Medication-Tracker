// Signing out: the cloud is brought up to date before anything on this device is removed.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from './auth';
import type { FlushResult, SyncHandle } from './sync';

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
  noteWipePending: vi.fn((id: string, on: boolean) => void calls.push(`noteWipePending:${id}:${on}`)),
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

const {
  signOutAndClear,
  wipeAfterAccountDeleted,
  deleteAccount,
  finishInterruptedDeletions,
  finishDeletionBeforeReuse,
  DELETE_BUSY_MESSAGE,
  SIGN_OUT_DEVICE_PROBLEM,
} = await import('./account');

const user: User = { id: 'firebase:u1', name: 'Ada', provider: 'google' };
const userB: User = { id: 'firebase:u2', name: 'Grace', provider: 'google' };
const WIPE = ['deleteLocalData', 'forgetSyncState', 'clearSyncCache', 'clearDrugInfoCache', 'disablePush', 'forgetReminderState', 'clearSession'];
const offline: FlushResult = {
  ok: false,
  reason: 'offline',
  pending: { medications: ['Lisinopril'], deletedMedications: 0, doseLogs: 3, refused: 0 },
};

function fakeSync(...results: FlushResult[]) {
  const flushAll = vi.fn(async (opts?: { needCloud?: boolean }) => {
    calls.push(`flush${opts?.needCloud ? ':needCloud' : ''}`);
    return results.shift() ?? { ok: true };
  });
  const deleteCloudData = vi.fn(async () => void calls.push('deleteCloudData'));
  return { sync: { flushAll, deleteCloudData } as unknown as SyncHandle, flushAll, deleteCloudData };
}
const noTakes = async () => ({ applied: 0, waiting: 0 });
const nothingWiped = () => WIPE.forEach((c) => expect(calls).not.toContain(c));

const authMod = await import('./auth');
const storeMod = await import('./store');
const sessionMod = await import('./session');
const syncMod = await import('./sync');

beforeEach(() => {
  calls.length = 0;
  storage.clear();
  vi.clearAllMocks();
  vi.mocked(authMod.loadSession).mockImplementation(() => null);
  vi.mocked(authMod.deleteFirebaseUser).mockImplementation(async () => void calls.push('deleteFirebaseUser'));
  vi.mocked(storeMod.deleteLocalData).mockImplementation(async () => void calls.push('deleteLocalData'));
  vi.mocked(syncMod.clearSyncCache).mockImplementation(async () => {
    calls.push('clearSyncCache');
    return true;
  });
  vi.mocked(syncMod.forgetSyncState).mockImplementation(async () => void calls.push('forgetSyncState'));
  vi.mocked(syncMod.releaseSyncClient).mockImplementation(async () => void calls.push('releaseSyncClient'));
  vi.mocked(sessionMod.accountsInUse).mockImplementation(async () => []);
  vi.mocked(sessionMod.claimSignOut).mockImplementation(async () => true);
  vi.mocked(sessionMod.cancelSignOut).mockImplementation(() => void calls.push('cancelSignOut'));
  vi.mocked(sessionMod.finishSignOut).mockImplementation(() => void calls.push('finishSignOut'));
  vi.mocked(sessionMod.endSessionInOtherTabs).mockImplementation(async () => void calls.push('endOtherTabs'));
  vi.mocked(sessionMod.isAccountDeleted).mockImplementation(() => false);
  vi.mocked(sessionMod.noteWipePending).mockImplementation((id: string, on: boolean) =>
    void calls.push(`noteWipePending:${id}:${on}`),
  );
  vi.mocked(sessionMod.pendingWipes).mockImplementation(() => []);
  vi.mocked(sessionMod.unfinishedDeletions).mockImplementation(() => []);
});

describe('signOutAndClear', () => {
  it('saves, stops the other tabs, saves what they added, then clears this device and signs out', async () => {
    const { sync } = fakeSync({ ok: true }, { ok: true });
    const steps: string[] = [];
    const result = await signOutAndClear(user, sync, { applyPendingTakes: noTakes, onStep: (s) => steps.push(s) });
    expect(result).toEqual({ status: 'signed-out' });
    expect(steps).toEqual(['saving', 'device']);
    expect(calls.slice(0, 4)).toEqual(['flush', 'endOtherTabs', 'flush', 'endHere']);
    for (const c of WIPE) expect(calls).toContain(c);
    // Firebase sign-out only once the device is clear (so the app stays on the dialog meanwhile).
    expect(calls.indexOf('signOut')).toBeGreaterThan(calls.indexOf('clearSyncCache'));
    expect(calls[calls.length - 1]).toBe('finishSignOut');
  });

  it("removes nothing (and leaves other tabs alone) when the cloud can't be brought up to date", async () => {
    const { sync } = fakeSync(offline);
    const result = await signOutAndClear(user, sync, { applyPendingTakes: async () => ({ applied: 0, waiting: 2 }) });
    expect(result).toEqual({
      status: 'blocked',
      problem: { reason: 'offline', message: undefined, pending: offline.pending, waitingTakes: 2 },
    });
    expect(calls).toEqual(['flush:needCloud']);
  });

  it('brings the other tabs back when what they added at the last moment can’t be saved', async () => {
    const { sync } = fakeSync({ ok: true }, offline);
    const result = await signOutAndClear(user, sync, { applyPendingTakes: noTakes });
    expect(result.status).toBe('blocked');
    expect(calls).toEqual(['flush', 'endOtherTabs', 'flush', 'cancelSignOut']);
    nothingWiped();
  });

  it("removes nothing when sync hasn't started", async () => {
    const result = await signOutAndClear(user, null, { applyPendingTakes: noTakes });
    expect(result).toEqual({ status: 'blocked', problem: { reason: 'not-ready', waitingTakes: 0 } });
    expect(calls).toEqual([]);
  });

  it('clears this device without saving once the user agrees to lose unsynced changes', async () => {
    const { sync, flushAll } = fakeSync(offline);
    const applyPendingTakes = vi.fn(noTakes);
    const result = await signOutAndClear(user, sync, { applyPendingTakes, discardUnsynced: true });
    expect(result).toEqual({ status: 'signed-out' });
    expect(flushAll).not.toHaveBeenCalled();
    expect(applyPendingTakes).not.toHaveBeenCalled();
    expect(calls.slice(0, 2)).toEqual(['endOtherTabs', 'endHere']);
    for (const c of WIPE) expect(calls).toContain(c);
  });

  it('waits for the cloud copy when notification taps are waiting, and records them before the last upload', async () => {
    const { sync } = fakeSync({ ok: true }, { ok: true });
    const applyPendingTakes = vi
      .fn<() => Promise<{ applied: number; waiting: number }>>()
      .mockResolvedValueOnce({ applied: 0, waiting: 1 })
      .mockResolvedValueOnce({ applied: 1, waiting: 0 });
    const result = await signOutAndClear(user, sync, { applyPendingTakes });
    expect(result).toEqual({ status: 'signed-out' });
    expect(applyPendingTakes).toHaveBeenCalledTimes(2);
    expect(calls.slice(0, 3)).toEqual(['flush:needCloud', 'endOtherTabs', 'flush']);
  });

  it('stops without removing anything when cancelled', async () => {
    const ctrl = new AbortController();
    const { sync } = fakeSync();
    sync.flushAll = vi.fn(async () => {
      ctrl.abort();
      return { ok: false, reason: 'cancelled', pending: offline.pending } as FlushResult;
    });
    const result = await signOutAndClear(user, sync, { applyPendingTakes: noTakes, signal: ctrl.signal });
    expect(result).toEqual({ status: 'cancelled' });
    expect(calls).toEqual([]);
  });

  it('brings the other tabs back when cancelled during the last upload', async () => {
    const ctrl = new AbortController();
    let n = 0;
    const { sync } = fakeSync();
    sync.flushAll = vi.fn(async () => {
      if (++n === 2) ctrl.abort();
      return n === 2 ? ({ ok: false, reason: 'cancelled', pending: offline.pending } as FlushResult) : ({ ok: true } as FlushResult);
    });
    const result = await signOutAndClear(user, sync, { applyPendingTakes: noTakes, signal: ctrl.signal });
    expect(result).toEqual({ status: 'cancelled' });
    expect(calls).toEqual(['endOtherTabs', 'cancelSignOut']);
  });

  it("doesn't record notification taps once cancelled while the other tabs stop", async () => {
    const ctrl = new AbortController();
    const { endSessionInOtherTabs } = await import('./session');
    vi.mocked(endSessionInOtherTabs).mockImplementationOnce(async () => void ctrl.abort());
    const { sync } = fakeSync({ ok: true });
    const applyPendingTakes = vi.fn(noTakes);
    const result = await signOutAndClear(user, sync, { applyPendingTakes, signal: ctrl.signal });
    expect(result).toEqual({ status: 'cancelled' });
    expect(applyPendingTakes).toHaveBeenCalledTimes(1); // only before the first upload
    expect(calls).toContain('cancelSignOut');
    nothingWiped();
  });

  it('a cancelled sign-out for one account still cancels its own other tabs while another account signs out', async () => {
    const { cancelSignOut, endSessionInOtherTabs, finishSignOut } = await import('./session');
    let letGo!: () => void;
    vi.mocked(endSessionInOtherTabs).mockImplementationOnce(() => new Promise<void>((r) => (letGo = r)));
    const first = new AbortController();
    const older = signOutAndClear(user, fakeSync({ ok: true }).sync, { applyPendingTakes: noTakes, signal: first.signal });
    await vi.waitFor(() => expect(letGo).toBeTypeOf('function'));
    first.abort();
    const newer = signOutAndClear(userB, fakeSync({ ok: true }, { ok: true }).sync, { applyPendingTakes: noTakes });
    await expect(newer).resolves.toEqual({ status: 'signed-out' });
    expect(finishSignOut).toHaveBeenCalledWith(userB.id);
    letGo();
    await expect(older).resolves.toEqual({ status: 'cancelled' });
    expect(cancelSignOut).toHaveBeenCalledWith(user.id);
    expect(cancelSignOut).not.toHaveBeenCalledWith(userB.id);
  });

  it('still signs out, notes the pending wipe, and clears the sign-out marker if clearing the device fails', async () => {
    const { deleteLocalData } = await import('./store');
    const { finishSignOut, noteWipePending } = await import('./session');
    vi.mocked(deleteLocalData).mockRejectedValueOnce(new Error('disk'));
    const { sync } = fakeSync({ ok: true }, { ok: true });
    await expect(signOutAndClear(user, sync, { applyPendingTakes: noTakes })).resolves.toEqual({
      status: 'signed-out',
      problem: SIGN_OUT_DEVICE_PROBLEM,
    });
    expect(noteWipePending).toHaveBeenCalledWith(user.id, true);
    expect(noteWipePending).not.toHaveBeenCalledWith(user.id, false);
    expect(calls).toContain('signOut');
    expect(calls[calls.length - 1]).toBe('finishSignOut');
    expect(finishSignOut).toHaveBeenCalledWith(user.id);
  });

  it('blocks as busy without stopping other tabs or cancelling when another tab holds the sign-out claim', async () => {
    const { claimSignOut } = await import('./session');
    vi.mocked(claimSignOut).mockResolvedValueOnce(false);
    const { sync } = fakeSync({ ok: true });

    const result = await signOutAndClear(user, sync, {
      applyPendingTakes: async () => ({ applied: 0, waiting: 1 }),
    });

    expect(result).toEqual({ status: 'blocked', problem: { reason: 'busy', waitingTakes: 1 } });
    expect(calls).toEqual(['flush:needCloud']);
    expect(calls).not.toContain('endOtherTabs');
    expect(calls).not.toContain('cancelSignOut');
    expect(calls).not.toContain('finishSignOut');
  });

  it('overlapping signOutAndClear runs for different accounts each call finishSignOut with their own id', async () => {
    const { endSessionInOtherTabs, finishSignOut, releaseSignOutClaim } = await import('./session');
    let letGo1!: () => void;
    let letGo2!: () => void;
    vi.mocked(endSessionInOtherTabs)
      .mockImplementationOnce(() => new Promise<void>((r) => (letGo1 = r)))
      .mockImplementationOnce(() => new Promise<void>((r) => (letGo2 = r)));

    const run1 = signOutAndClear(user, fakeSync({ ok: true }, { ok: true }).sync, { applyPendingTakes: noTakes });
    await vi.waitFor(() => expect(letGo1).toBeTypeOf('function'));

    const run2 = signOutAndClear(userB, fakeSync({ ok: true }, { ok: true }).sync, { applyPendingTakes: noTakes });
    await vi.waitFor(() => expect(letGo2).toBeTypeOf('function'));

    letGo1();
    await expect(run1).resolves.toEqual({ status: 'signed-out' });
    expect(finishSignOut).toHaveBeenCalledWith(user.id);
    expect(releaseSignOutClaim).not.toHaveBeenCalled();

    letGo2();
    await expect(run2).resolves.toEqual({ status: 'signed-out' });
    expect(finishSignOut).toHaveBeenCalledTimes(2);
    expect(finishSignOut).toHaveBeenCalledWith(userB.id);
  });

  it('releases the claim via cancelSignOut when the second applyPendingTakes rejects so a retry can claim again', async () => {
    const { cancelSignOut, claimSignOut } = await import('./session');
    let claimed = false;
    vi.mocked(claimSignOut).mockImplementation(async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    });
    vi.mocked(cancelSignOut).mockImplementation(() => {
      calls.push('cancelSignOut');
      claimed = false;
    });
    const applyPendingTakes = vi
      .fn<() => Promise<{ applied: number; waiting: number }>>()
      .mockResolvedValueOnce({ applied: 0, waiting: 0 })
      .mockRejectedValueOnce(new Error('takes boom'))
      .mockResolvedValue({ applied: 0, waiting: 0 });
    const { sync } = fakeSync({ ok: true }, { ok: true }, { ok: true });

    await expect(signOutAndClear(user, sync, { applyPendingTakes })).rejects.toThrow('takes boom');
    expect(cancelSignOut).toHaveBeenCalledWith(user.id);
    nothingWiped();

    await expect(signOutAndClear(user, sync, { applyPendingTakes })).resolves.toEqual({ status: 'signed-out' });
  });

  it('releases the claim via cancelSignOut when the second flushAll rejects so a retry can claim again', async () => {
    const { cancelSignOut, claimSignOut } = await import('./session');
    let claimed = false;
    vi.mocked(claimSignOut).mockImplementation(async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    });
    vi.mocked(cancelSignOut).mockImplementation(() => {
      calls.push('cancelSignOut');
      claimed = false;
    });
    const { sync, flushAll } = fakeSync();
    flushAll
      .mockImplementationOnce(async () => {
        calls.push('flush');
        return { ok: true };
      })
      .mockImplementationOnce(async () => {
        calls.push('flush');
        throw new Error('flush boom');
      })
      .mockImplementation(async () => {
        calls.push('flush');
        return { ok: true };
      });

    await expect(signOutAndClear(user, sync, { applyPendingTakes: noTakes })).rejects.toThrow('flush boom');
    expect(cancelSignOut).toHaveBeenCalledWith(user.id);
    nothingWiped();

    await expect(signOutAndClear(user, sync, { applyPendingTakes: noTakes })).resolves.toEqual({ status: 'signed-out' });
  });
});

describe('wipeAfterAccountDeleted (the account was deleted elsewhere)', () => {
  it('stops this tab, then the other tabs, before anything is removed, and clears the marker last', async () => {
    const result = await wipeAfterAccountDeleted(user);
    expect(result).toEqual({});
    expect(calls.slice(0, 3)).toEqual(['endHere', 'endOtherTabs', 'markDeleted']);
    for (const c of WIPE) expect(calls.indexOf(c), c).toBeGreaterThan(calls.indexOf('markDeleted'));
    expect(calls.indexOf('markWiped')).toBeGreaterThan(calls.indexOf('clearSyncCache'));
    expect(calls.indexOf('deleteFirebaseUser')).toBeGreaterThan(calls.indexOf('markWiped'));
    expect(calls[calls.length - 1]).toBe('finishSignOut');
  });

  it('still clears the marker if clearing the device fails', async () => {
    const { deleteLocalData } = await import('./store');
    vi.mocked(deleteLocalData).mockRejectedValueOnce(new Error('disk'));
    await expect(wipeAfterAccountDeleted(user)).rejects.toThrow('disk');
    expect(calls).toContain('endHere');
    expect(calls).toContain('markDeleted');
    expect(calls).not.toContain('markWiped');
    expect(calls[calls.length - 1]).toBe('finishSignOut');
  });

  it('resolves with a problem when deleteFirebaseUser rejects, and still signs out and finishes sign-out', async () => {
    const { deleteFirebaseUser } = await import('./auth');
    const { finishSignOut } = await import('./session');
    vi.mocked(deleteFirebaseUser).mockRejectedValueOnce(new Error('Network down.'));

    const result = await wipeAfterAccountDeleted(user);

    expect(result.problem).toContain("sign-in account couldn't be removed yet");
    expect(result.problem).toContain('(Network down)');
    expect(calls).toContain('markWiped');
    expect(calls).toContain('signOut');
    expect(calls[calls.length - 1]).toBe('finishSignOut');
    expect(finishSignOut).toHaveBeenCalledWith(user.id);
  });

  it('combines device and account problems when both deleteLocalData and deleteFirebaseUser reject', async () => {
    const { deleteFirebaseUser } = await import('./auth');
    const { deleteLocalData } = await import('./store');
    vi.mocked(deleteLocalData).mockRejectedValueOnce(new Error('disk'));
    vi.mocked(deleteFirebaseUser).mockRejectedValueOnce(new Error('Network down.'));

    const result = await wipeAfterAccountDeleted(user);

    expect(result.problem).toContain("sign-in account couldn't be removed yet (Network down)");
    expect(result.problem).toContain("couldn't be removed from this device yet");
    expect(calls).not.toContain('markWiped');
    expect(calls[calls.length - 1]).toBe('finishSignOut');
  });

  it('resolves {} without touching other tabs or wiping when claimSignOut is not granted', async () => {
    const { claimSignOut } = await import('./session');
    vi.mocked(claimSignOut).mockResolvedValueOnce(false);

    const result = await wipeAfterAccountDeleted(user);

    expect(result).toEqual({});
    expect(calls).toEqual(['endHere']);
    nothingWiped();
  });
});

describe('deleteAccount', () => {
  it('deletes a Google account in order: other tabs -> cloud -> this tab -> mark deleted -> wipe -> mark wiped -> Firebase user -> finish', async () => {
    const { reauthenticateForDeletion } = await import('./auth');
    const { endSessionInOtherTabs, finishSignOut } = await import('./session');
    vi.mocked(reauthenticateForDeletion).mockResolvedValueOnce(true);
    const { sync } = fakeSync();
    const steps: string[] = [];

    const result = await deleteAccount(user, sync, (s) => steps.push(s));

    expect(result).toEqual({ deleted: true });
    expect(steps).toEqual(['confirming', 'cloud', 'device', 'account']);
    expect(endSessionInOtherTabs).toHaveBeenCalledWith(user.id, undefined, 'deleting');
    expect(calls.slice(0, 4)).toEqual(['endOtherTabs', 'deleteCloudData', 'endHere', 'markDeleted']);
    for (const c of WIPE) expect(calls.indexOf(c), c).toBeGreaterThan(calls.indexOf('markDeleted'));
    expect(calls.indexOf('markWiped')).toBeGreaterThan(calls.indexOf('clearSyncCache'));
    expect(calls.indexOf('deleteFirebaseUser')).toBeGreaterThan(calls.indexOf('markWiped'));
    expect(calls.indexOf('finishSignOut')).toBeGreaterThan(calls.indexOf('deleteFirebaseUser'));
    expect(calls[calls.length - 1]).toBe('finishSignOut');
    expect(finishSignOut).toHaveBeenCalledWith(user.id);
    expect(calls).not.toContain('signOut');
  });

  it('cancels sign-out, leaves nothing marked or wiped, and rethrows when deleting cloud data fails', async () => {
    const { reauthenticateForDeletion } = await import('./auth');
    const { cancelSignOut, finishSignOut } = await import('./session');
    vi.mocked(reauthenticateForDeletion).mockResolvedValueOnce(true);
    const { sync, deleteCloudData } = fakeSync();
    deleteCloudData.mockRejectedValueOnce(new Error('cloud fail'));

    await expect(deleteAccount(user, sync)).rejects.toThrow('cloud fail');

    expect(cancelSignOut).toHaveBeenCalledWith(user.id);
    expect(finishSignOut).toHaveBeenCalledWith(user.id);
    expect(calls).toContain('endOtherTabs');
    expect(calls).toContain('cancelSignOut');
    expect(calls).toContain('finishSignOut');
    expect(calls).not.toContain('endHere');
    expect(calls).not.toContain('markDeleted');
    expect(calls).not.toContain('markWiped');
    expect(calls).not.toContain('deleteFirebaseUser');
    nothingWiped();
  });

  it('deletes a guest account: ends other tabs, marks deleted, wipes device, marks wiped, finishes', async () => {
    const { reauthenticateForDeletion } = await import('./auth');
    const { endSessionInOtherTabs, finishSignOut } = await import('./session');
    vi.mocked(reauthenticateForDeletion).mockClear();
    const guest: User = { id: 'guest', name: 'Guest', provider: 'guest' };
    const steps: string[] = [];

    const result = await deleteAccount(guest, null, (s) => steps.push(s));

    expect(result).toEqual({ deleted: true });
    expect(steps).toEqual(['device']);
    expect(reauthenticateForDeletion).not.toHaveBeenCalled();
    expect(endSessionInOtherTabs).toHaveBeenCalledWith('guest', undefined, 'deleting');
    expect(calls.slice(0, 3)).toEqual(['endOtherTabs', 'endHere', 'markDeleted']);
    expect(calls).toContain('deleteLocalData');
    expect(calls).toContain('releaseSyncClient');
    expect(calls).not.toContain('clearSyncCache');
    expect(calls).toContain('signOut');
    expect(calls.indexOf('markWiped')).toBeGreaterThan(calls.indexOf('signOut'));
    expect(calls[calls.length - 1]).toBe('finishSignOut');
    expect(finishSignOut).toHaveBeenCalledWith(guest.id);
    expect(calls).not.toContain('deleteFirebaseUser');
  });

  it('returns { deleted: false } and does nothing when reauthentication is cancelled', async () => {
    const { reauthenticateForDeletion } = await import('./auth');
    vi.mocked(reauthenticateForDeletion).mockResolvedValueOnce(false);
    const { sync, deleteCloudData } = fakeSync();

    await expect(deleteAccount(user, sync)).resolves.toEqual({ deleted: false });

    expect(deleteCloudData).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('resolves deleted with a problem, signs out, and finishes sign-out last when removing the Firebase user fails', async () => {
    const { reauthenticateForDeletion, deleteFirebaseUser } = await import('./auth');
    const { finishSignOut } = await import('./session');
    vi.mocked(reauthenticateForDeletion).mockResolvedValueOnce(true);
    vi.mocked(deleteFirebaseUser).mockRejectedValueOnce(new Error('requires-recent-login'));
    const { sync } = fakeSync();

    const result = await deleteAccount(user, sync);

    expect(result.deleted).toBe(true);
    if (!result.deleted) throw new Error('expected deleted');
    expect(result.problem).toContain("sign-in account couldn't be removed");
    expect(result.problem).toContain('requires-recent-login');
    expect(calls).toContain('markDeleted');
    expect(calls).toContain('markWiped');
    expect(calls).toContain('signOut');
    expect(calls.indexOf('finishSignOut')).toBeGreaterThan(calls.indexOf('signOut'));
    expect(calls[calls.length - 1]).toBe('finishSignOut');
    expect(finishSignOut).toHaveBeenCalledWith(user.id);
  });

  it('resolves deleted with a problem, still runs the rest of the wipe and removes the Firebase user, and skips markWiped when deleteLocalData rejects', async () => {
    const { reauthenticateForDeletion } = await import('./auth');
    const { deleteLocalData } = await import('./store');
    const { finishSignOut } = await import('./session');
    vi.mocked(reauthenticateForDeletion).mockResolvedValueOnce(true);
    vi.mocked(deleteLocalData).mockRejectedValueOnce(new Error('disk'));
    const { sync } = fakeSync();

    const result = await deleteAccount(user, sync);

    expect(result.deleted).toBe(true);
    if (!result.deleted) throw new Error('expected deleted');
    expect(result.problem).toContain("couldn't be removed from this device yet");
    expect(calls).toContain('markDeleted');
    expect(calls).not.toContain('markWiped');
    for (const c of ['forgetSyncState', 'clearSyncCache', 'clearDrugInfoCache', 'clearSession']) {
      expect(calls).toContain(c);
    }
    expect(calls).toContain('deleteFirebaseUser');
    expect(calls).toContain('signOut');
    expect(calls.indexOf('deleteFirebaseUser')).toBeGreaterThan(calls.indexOf('markDeleted'));
    expect(calls[calls.length - 1]).toBe('finishSignOut');
    expect(finishSignOut).toHaveBeenCalledWith(user.id);
  });

  it('rejects as busy without touching tabs, cloud, or local data when another tab holds the sign-out claim', async () => {
    const { reauthenticateForDeletion } = await import('./auth');
    const { claimSignOut } = await import('./session');
    vi.mocked(reauthenticateForDeletion).mockResolvedValueOnce(true);
    vi.mocked(claimSignOut).mockResolvedValueOnce(false);
    const { sync, deleteCloudData } = fakeSync();

    await expect(deleteAccount(user, sync)).rejects.toThrow(DELETE_BUSY_MESSAGE);

    expect(deleteCloudData).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it('overlapping deleteAccount runs for different accounts each call finishSignOut with their own id', async () => {
    const { reauthenticateForDeletion } = await import('./auth');
    const { finishSignOut, releaseSignOutClaim } = await import('./session');
    vi.mocked(reauthenticateForDeletion).mockResolvedValueOnce(true).mockResolvedValueOnce(true);

    let resolveCloud1!: () => void;
    let resolveCloud2!: () => void;
    const sync1 = fakeSync();
    sync1.deleteCloudData.mockImplementationOnce(
      () =>
        new Promise<undefined>((r) => {
          calls.push('deleteCloudData:1');
          resolveCloud1 = () => r(undefined);
        }),
    );
    const sync2 = fakeSync();
    sync2.deleteCloudData.mockImplementationOnce(
      () =>
        new Promise<undefined>((r) => {
          calls.push('deleteCloudData:2');
          resolveCloud2 = () => r(undefined);
        }),
    );

    const run1 = deleteAccount(user, sync1.sync);
    await vi.waitFor(() => expect(resolveCloud1).toBeTypeOf('function'));

    const run2 = deleteAccount(userB, sync2.sync);
    await vi.waitFor(() => expect(resolveCloud2).toBeTypeOf('function'));

    resolveCloud1();
    await expect(run1).resolves.toEqual({ deleted: true });

    expect(finishSignOut).toHaveBeenCalledWith(user.id);
    expect(releaseSignOutClaim).not.toHaveBeenCalled();

    resolveCloud2();
    await expect(run2).resolves.toEqual({ deleted: true });

    expect(finishSignOut).toHaveBeenCalledTimes(2);
    expect(finishSignOut).toHaveBeenCalledWith(userB.id);
    expect(calls[calls.length - 1]).toBe('finishSignOut');
  });
});

describe('finishInterruptedDeletions and finishDeletionBeforeReuse', () => {
  it('finishDeletionBeforeReuse resolves false and skips markWiped when deleteLocalData rejects (#1)', async () => {
    const { unfinishedDeletions } = await import('./session');
    const { deleteLocalData } = await import('./store');
    vi.mocked(unfinishedDeletions).mockReturnValue([user.id]);
    vi.mocked(deleteLocalData).mockRejectedValueOnce(new Error('disk'));

    await expect(finishDeletionBeforeReuse(user.id)).resolves.toBe(false);
    expect(calls).not.toContain('markWiped');
  });

  it('finishInterruptedDeletions skips markWiped when deleteLocalData rejects (#1)', async () => {
    const { unfinishedDeletions } = await import('./session');
    const { deleteLocalData } = await import('./store');
    vi.mocked(unfinishedDeletions).mockReturnValue([user.id]);
    vi.mocked(deleteLocalData).mockRejectedValueOnce(new Error('disk'));

    await expect(finishInterruptedDeletions()).resolves.toBeUndefined();
    expect(calls).not.toContain('markWiped');
    expect(calls).not.toContain('clearSyncCache');
  });

  it('clears drug info cache and sync cache for a firebase account when no synced account is in use (#10)', async () => {
    const { loadSession } = await import('./auth');
    const { accountsInUse, unfinishedDeletions } = await import('./session');
    const { clearSyncCache, forgetSyncState } = await import('./sync');
    vi.mocked(unfinishedDeletions).mockReturnValue([user.id]);
    vi.mocked(accountsInUse).mockResolvedValue([]);
    vi.mocked(loadSession).mockReturnValue(null);

    await finishInterruptedDeletions();

    expect(forgetSyncState).toHaveBeenCalledWith('u1');
    expect(calls).toContain('clearDrugInfoCache');
    expect(clearSyncCache).toHaveBeenCalledWith({ openFirst: true, firestoreOnly: true, unlessSyncing: true });
    expect(calls).toContain('markWiped');
    expect(localStorage.getItem('medtracker.syncCacheStale')).toBeNull();
  });

  it('defers clearing sync cache while another synced account is in use or unknown, then clears it later (#10)', async () => {
    const { loadSession } = await import('./auth');
    const { accountsInUse, unfinishedDeletions } = await import('./session');
    const { clearSyncCache } = await import('./sync');
    vi.mocked(loadSession).mockReturnValue(null);

    // Another non-deleted firebase account is in use -> flag kept, clearSyncCache skipped
    vi.mocked(unfinishedDeletions).mockReturnValue([user.id]);
    vi.mocked(accountsInUse).mockResolvedValue(['firebase:other']);
    await finishInterruptedDeletions();

    expect(calls).toContain('clearDrugInfoCache');
    expect(calls).toContain('markWiped');
    expect(clearSyncCache).not.toHaveBeenCalled();
    expect(localStorage.getItem('medtracker.syncCacheStale')).toBe('1');

    // accountsInUse returns null (cannot tell) -> flag still kept, clearSyncCache skipped
    vi.mocked(unfinishedDeletions).mockReturnValue([]);
    vi.mocked(accountsInUse).mockResolvedValue(null);
    await finishInterruptedDeletions();

    expect(clearSyncCache).not.toHaveBeenCalled();
    expect(localStorage.getItem('medtracker.syncCacheStale')).toBe('1');

    // Later run with no unfinished deletions and nothing in use -> clears cache and removes flag
    vi.mocked(accountsInUse).mockResolvedValue([]);
    await finishInterruptedDeletions();

    expect(clearSyncCache).toHaveBeenCalledWith({ openFirst: true, firestoreOnly: true, unlessSyncing: true });
    expect(localStorage.getItem('medtracker.syncCacheStale')).toBeNull();
  });
});
