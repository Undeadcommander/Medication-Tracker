// Tabs of one browser stopping before a sign-out clears the device (see session.ts).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountDeletedSince,
  accountsInUse,
  cancelSignOut,
  checkDeletedElsewhere,
  claimSignOut,
  deletionMark,
  endSessionHere,
  endSessionInOtherTabs,
  finishSignOut,
  holdSession,
  isAccountDeleted,
  isLeavingHere,
  isSigningOut,
  markAccountDeleted,
  markDeviceWiped,
  onDeletedElsewhere,
  onSignOutElsewhere,
  releaseSignOutClaim,
  resumeAccount,
  unfinishedDeletions,
} from './session';

const store = new Map<string, string>();
let onSetItem: ((key: string, value: string) => void) | null = null;
const origNavigator = globalThis.navigator;
beforeAll(() => {
  vi.stubGlobal('localStorage', {
    get length() {
      return store.size;
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      const s = String(v);
      store.set(k, s);
      onSetItem?.(k, s);
    },
    removeItem: (k: string) => void store.delete(k),
  });
});
beforeEach(() => {
  store.clear();
  onSetItem = null;
});
afterAll(() => vi.unstubAllGlobals());

/** Another tab's end of the channel. */
function otherTab() {
  const ch = new BroadcastChannel('medtracker-session');
  const got: unknown[] = [];
  ch.onmessage = (e) => got.push(e.data);
  return { ch, got };
}
const tick = () => new Promise((r) => setTimeout(r, 20));

describe('session', () => {
  it('stops this tab only when asked, and waits for it to finish', async () => {
    let finished = false;
    const onEnd = vi.fn(async (elsewhere: boolean) => {
      expect(elsewhere).toBe(false);
      await tick();
      finished = true;
    });
    const release = holdSession('firebase:a', onEnd);
    await endSessionInOtherTabs('firebase:a');
    expect(onEnd).not.toHaveBeenCalled(); // this tab carries on for its last upload
    expect(isSigningOut('firebase:a')).toBe(true);
    const ending = endSessionHere('firebase:a');
    release(); // the tracker unmounting meanwhile doesn't cut it short
    await ending;
    expect(finished).toBe(true);
    finishSignOut();
    expect(isSigningOut('firebase:a')).toBe(false);
  });

  it('tells other tabs, which stop', async () => {
    const other = otherTab();
    const onEnd = vi.fn();
    holdSession('firebase:b', onEnd);
    await endSessionInOtherTabs('firebase:b');
    await tick();
    expect(other.got).toContainEqual({ type: 'signing-out', userId: 'firebase:b', reason: 'signing-out' });
    // A message from another tab that's signing this account out:
    other.ch.postMessage({ type: 'signing-out', userId: 'firebase:b' });
    await tick();
    expect(onEnd).toHaveBeenCalledWith(true);
    cancelSignOut('firebase:b');
    await tick();
    expect(other.got).toContainEqual({ type: 'cancelled', userId: 'firebase:b' });
    expect(isSigningOut('firebase:b')).toBe(false);
    other.ch.close();
  });

  it('ignores other accounts', async () => {
    const other = otherTab();
    const onEnd = vi.fn();
    const release = holdSession('firebase:c', onEnd);
    other.ch.postMessage({ type: 'signing-out', userId: 'firebase:someone-else' });
    await endSessionHere('firebase:someone-else');
    await tick();
    expect(onEnd).not.toHaveBeenCalled();
    release();
    other.ch.close();
  });

  it('tells other tabs when deleting, and reports reason "deleting" to onSignOutElsewhere', async () => {
    const other = otherTab();
    const onEnd = vi.fn();
    const release = holdSession('firebase:del-msg', onEnd);
    const events: unknown[] = [];
    const off = onSignOutElsewhere((userId, event, reason) => events.push({ userId, event, reason }));

    other.ch.postMessage({ type: 'signing-out', userId: 'firebase:del-msg', reason: 'deleting' });
    await tick();
    expect(onEnd).toHaveBeenCalledWith(true);
    expect(events).toContainEqual({ userId: 'firebase:del-msg', event: 'signing-out', reason: 'deleting' });

    await endSessionInOtherTabs('firebase:del-send', undefined, 'deleting');
    await tick();
    expect(other.got).toContainEqual({ type: 'signing-out', userId: 'firebase:del-send', reason: 'deleting' });
    finishSignOut();

    off();
    release();
    other.ch.close();
  });

  it('missed-message fallback: checkDeletedElsewhere ends stale holders and notifies once, while new sessions survive', async () => {
    const id = 'firebase:missed';
    const onEnd = vi.fn();
    const releaseStale = holdSession(id, onEnd);
    const notified: string[] = [];
    const off = onDeletedElsewhere((uid) => notified.push(uid));

    // Another tab wrote the deletion mark directly without broadcasting.
    store.set('medtracker.deletedAccounts', JSON.stringify({ [id]: { mark: 'm1', at: Date.now() } }));
    expect(accountDeletedSince(id, null)).toBe(true);

    checkDeletedElsewhere();
    await tick();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(true);
    expect(notified).toEqual([id]);

    // A second check does not notify again for the same mark.
    checkDeletedElsewhere();
    await tick();
    expect(notified).toEqual([id]);

    // A new session started after the deletion takes the current mark and is not ended.
    const onNewEnd = vi.fn();
    const releaseNew = holdSession(id, onNewEnd);
    expect(deletionMark(id)).toBe('m1');
    checkDeletedElsewhere();
    await tick();
    expect(onNewEnd).not.toHaveBeenCalled();

    off();
    releaseStale();
    releaseNew();
  });

  it('tracks deleted accounts across resumeAccount, markDeviceWiped, and in-flight sign-out', async () => {
    const id = 'firebase:after';
    markAccountDeleted(id);
    expect(isAccountDeleted(id)).toBe(true);
    expect(unfinishedDeletions()).toContain(id);

    // Resuming makes isAccountDeleted false while accountDeletedSince(id, null) stays true.
    resumeAccount(id);
    expect(isAccountDeleted(id)).toBe(false);
    expect(accountDeletedSince(id, null)).toBe(true);
    expect(unfinishedDeletions()).not.toContain(id);

    // Mark deleted again and finish wiping -> excluded from unfinishedDeletions while isAccountDeleted stays true.
    markAccountDeleted(id);
    expect(unfinishedDeletions()).toContain(id);
    markDeviceWiped(id);
    expect(unfinishedDeletions()).not.toContain(id);
    expect(isAccountDeleted(id)).toBe(true);

    // While isSigningOut(id) is active, unfinishedDeletions excludes it until finishSignOut clears the marker.
    const inFlightId = 'firebase:inflight';
    await endSessionInOtherTabs(inFlightId, undefined, 'deleting');
    expect(isSigningOut(inFlightId)).toBe(true);
    markAccountDeleted(inFlightId);
    expect(unfinishedDeletions()).not.toContain(inFlightId);
    finishSignOut();
    expect(unfinishedDeletions()).toContain(inFlightId);
  });

  it('claimSignOut grants one exclusive claim at a time until finishSignOut releases it', async () => {
    const id = 'firebase:claim-excl';
    expect(await claimSignOut(id)).toBe(true);
    expect(await claimSignOut(id)).toBe(false);

    finishSignOut(id);
    await tick();
    expect(await claimSignOut(id)).toBe(true);
    finishSignOut(id);
    await tick();
  });

  it('ignores signing-out broadcasts for a claimed account until the claim is released', async () => {
    const id = 'firebase:claim-hold';
    const other = otherTab();
    const onEnd = vi.fn();
    const release = holdSession(id, onEnd);

    expect(await claimSignOut(id)).toBe(true);
    other.ch.postMessage({ type: 'signing-out', userId: id, reason: 'deleting' });
    await tick();
    expect(onEnd).not.toHaveBeenCalled();

    releaseSignOutClaim(id);
    other.ch.postMessage({ type: 'signing-out', userId: id, reason: 'deleting' });
    await tick();
    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(true);

    release();
    other.ch.close();
  });

  it('resumeAccount records the deletion mark so checkDeletedElsewhere does not notify for it', () => {
    const id = 'firebase:resume-known';
    const notified: string[] = [];
    const off = onDeletedElsewhere((uid) => notified.push(uid));

    // Simulate another tab marking the account deleted without this tab's `known` map seeing it.
    store.set('medtracker.deletedAccounts', JSON.stringify({ [id]: { mark: 'm-other', at: Date.now() } }));
    resumeAccount(id);
    checkDeletedElsewhere();

    expect(notified).toEqual([]);
    expect(isAccountDeleted(id)).toBe(false);
    off();
  });

  it('finishSignOut does not remove a signing-out marker written by another tab', () => {
    store.set('medtracker.signingOut', JSON.stringify({ userId: 'x', at: Date.now(), tab: 'other-tab' }));

    finishSignOut();

    expect(isSigningOut('x')).toBe(true);
    expect(store.get('medtracker.signingOut')).toBeDefined();
  });

  it('keeps per-account signing-out markers independent across concurrent accounts and tabs', async () => {
    try {
      await endSessionInOtherTabs('guest');
      // Another tab marks a different account as signing out via its per-account key.
      store.set('medtracker.signingOut.firebase:x', JSON.stringify({ userId: 'firebase:x', at: Date.now(), tab: 'other-tab' }));

      expect(isSigningOut('guest')).toBe(true);
      expect(isSigningOut('firebase:x')).toBe(true);

      finishSignOut('guest');
      expect(isSigningOut('guest')).toBe(false);
      expect(store.get('medtracker.signingOut.guest')).toBeUndefined();
      expect(isSigningOut('firebase:x')).toBe(true);
      expect(store.get('medtracker.signingOut.firebase:x')).toBeDefined();

      // Two accounts signing out concurrently in this tab also do not overwrite each other.
      await endSessionInOtherTabs('guest');
      await endSessionInOtherTabs('firebase:y');
      expect(isSigningOut('guest')).toBe(true);
      expect(isSigningOut('firebase:y')).toBe(true);

      finishSignOut('guest');
      expect(isSigningOut('guest')).toBe(false);
      expect(isSigningOut('firebase:y')).toBe(true);

      finishSignOut('firebase:y');
      expect(isSigningOut('firebase:y')).toBe(false);
    } finally {
      finishSignOut();
    }
  });

  it('honours legacy medtracker.signingOut marker from an old tab in isSigningOut and fallback claimSignOut', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    try {
      const legacyId = 'firebase:legacy-old-tab';
      store.set('medtracker.signingOut', JSON.stringify({ userId: legacyId, at: Date.now(), tab: 'old-tab' }));

      expect(isSigningOut(legacyId)).toBe(true);
      expect(await claimSignOut(legacyId)).toBe(false);
      expect(isLeavingHere(legacyId)).toBe(false);

      // Signing out another account in this tab must not clobber the legacy marker held by the old tab.
      await endSessionInOtherTabs('guest');
      expect(isSigningOut('guest')).toBe(true);
      expect(isSigningOut(legacyId)).toBe(true);

      finishSignOut('guest');
      expect(isSigningOut('guest')).toBe(false);
      expect(isSigningOut(legacyId)).toBe(true);
      expect(JSON.parse(store.get('medtracker.signingOut')!).tab).toBe('old-tab');
    } finally {
      finishSignOut();
      vi.stubGlobal('navigator', origNavigator);
    }
  });

  it('keeps per-account heartbeats fresh past 60s and finishSignOut(id) stops only that account', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('navigator', { locks: undefined });
    try {
      const a = 'guest';
      const b = 'firebase:hb-b';
      const startA = endSessionInOtherTabs(a);
      const startB = endSessionInOtherTabs(b);
      await vi.advanceTimersByTimeAsync(500);
      await Promise.all([startA, startB]);

      await vi.advanceTimersByTimeAsync(65_000);
      expect(isSigningOut(a)).toBe(true);
      expect(isSigningOut(b)).toBe(true);

      finishSignOut(a);
      expect(isSigningOut(a)).toBe(false);
      expect(store.get(`medtracker.signingOut.${a}`)).toBeUndefined();
      expect(isSigningOut(b)).toBe(true);

      await vi.advanceTimersByTimeAsync(65_000);
      expect(isSigningOut(a)).toBe(false);
      expect(store.get(`medtracker.signingOut.${a}`)).toBeUndefined();
      expect(isSigningOut(b)).toBe(true);

      finishSignOut(b);
      expect(isSigningOut(b)).toBe(false);
    } finally {
      finishSignOut();
      vi.stubGlobal('navigator', origNavigator);
      vi.useRealTimers();
    }
  });

  it('without Web Locks, claimSignOut succeeds when uncontested, writes own marker, and release removes it', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    try {
      const id = 'firebase:nolocks-uncontested';
      expect(await claimSignOut(id)).toBe(true);
      expect(isLeavingHere(id)).toBe(true);
      expect(isSigningOut(id)).toBe(true);

      const raw = store.get(`medtracker.signingOut.${id}`);
      expect(raw).toBeDefined();
      const parsed = JSON.parse(raw!) as { userId: string; tab?: string };
      expect(parsed.userId).toBe(id);
      expect(typeof parsed.tab).toBe('string');
      expect(parsed.tab!.length).toBeGreaterThan(0);

      releaseSignOutClaim(id);
      expect(isLeavingHere(id)).toBe(false);
      expect(store.get(`medtracker.signingOut.${id}`)).toBeUndefined();
      expect(isSigningOut(id)).toBe(false);
    } finally {
      finishSignOut();
      vi.stubGlobal('navigator', origNavigator);
    }
  });

  it('without Web Locks, claimSignOut resolves false and preserves winner when another tab overwrites during settle', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    try {
      const id = 'firebase:nolocks-race';
      const key = `medtracker.signingOut.${id}`;
      onSetItem = (k) => {
        if (k !== key) return;
        onSetItem = null;
        setTimeout(() => {
          store.set(key, JSON.stringify({ userId: id, at: Date.now(), tab: 'other-tab' }));
        }, 10);
      };

      expect(await claimSignOut(id)).toBe(false);
      expect(isLeavingHere(id)).toBe(false);
      expect(JSON.parse(store.get(key)!).tab).toBe('other-tab');
      expect(isSigningOut(id)).toBe(true);
    } finally {
      onSetItem = null;
      finishSignOut();
      vi.stubGlobal('navigator', origNavigator);
    }
  });

  it('without Web Locks, claimSignOut returns false immediately when a fresh other-tab marker already exists', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    try {
      const id = 'firebase:nolocks-preexisting';
      const key = `medtracker.signingOut.${id}`;
      store.set(key, JSON.stringify({ userId: id, at: Date.now(), tab: 'other-tab' }));

      let wrote = false;
      onSetItem = () => {
        wrote = true;
      };

      expect(await claimSignOut(id)).toBe(false);
      expect(wrote).toBe(false);
      expect(isLeavingHere(id)).toBe(false);
      expect(JSON.parse(store.get(key)!).tab).toBe('other-tab');
    } finally {
      onSetItem = null;
      finishSignOut();
      vi.stubGlobal('navigator', origNavigator);
    }
  });

  it('accountsInUse returns null without navigator.locks and lists held/pending session accounts when available', async () => {
    let releaseLocal: (() => void) | null = null;
    try {
      vi.stubGlobal('navigator', { locks: undefined });
      expect(await accountsInUse()).toBeNull();

      vi.stubGlobal('navigator', {
        locks: {
          request: () => new Promise<void>(() => {}),
          query: async () => ({
            held: [
              { name: 'medtracker-session-firebase:a' },
              { name: 'medtracker-leaving-firebase:ignore' },
            ],
            pending: [{ name: 'medtracker-session-guest' }],
          }),
        },
      });

      releaseLocal = holdSession('firebase:local', () => {});
      const inUse = await accountsInUse();
      expect(inUse).not.toBeNull();
      expect(inUse).toContain('firebase:a');
      expect(inUse).toContain('guest');
      expect(inUse).toContain('firebase:local');
      expect(inUse).not.toContain('firebase:ignore');
    } finally {
      releaseLocal?.();
      vi.stubGlobal('navigator', origNavigator);
    }
  });

  it('without Web Locks, claimSignOut loses to a legacy marker written during settle and removes its own marker (#9)', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    try {
      const id = 'firebase:nolocks-legacy-race';
      const ownKey = `medtracker.signingOut.${id}`;
      onSetItem = (k) => {
        if (k !== ownKey) return;
        onSetItem = null;
        setTimeout(() => {
          store.set('medtracker.signingOut', JSON.stringify({ userId: id, at: Date.now(), tab: 'old-tab' }));
        }, 10);
      };

      expect(await claimSignOut(id)).toBe(false);
      expect(isLeavingHere(id)).toBe(false);
      expect(store.get(ownKey)).toBeUndefined();
      expect(JSON.parse(store.get('medtracker.signingOut')!).tab).toBe('old-tab');
    } finally {
      onSetItem = null;
      finishSignOut();
      vi.stubGlobal('navigator', origNavigator);
    }
  });

  it('without Web Locks, claimSignOut is not blocked by a legacy marker for another user or a stale one during settle (#9)', async () => {
    vi.stubGlobal('navigator', { locks: undefined });
    try {
      const idA = 'firebase:nolocks-legacy-other';
      const ownKeyA = `medtracker.signingOut.${idA}`;
      onSetItem = (k) => {
        if (k !== ownKeyA) return;
        onSetItem = null;
        setTimeout(() => {
          store.set('medtracker.signingOut', JSON.stringify({ userId: 'firebase:someone-else', at: Date.now(), tab: 'old-tab' }));
        }, 10);
      };

      expect(await claimSignOut(idA)).toBe(true);
      expect(isLeavingHere(idA)).toBe(true);
      expect(store.get(ownKeyA)).toBeDefined();
      finishSignOut(idA);

      const idB = 'firebase:nolocks-legacy-stale';
      const ownKeyB = `medtracker.signingOut.${idB}`;
      onSetItem = (k) => {
        if (k !== ownKeyB) return;
        onSetItem = null;
        setTimeout(() => {
          store.set('medtracker.signingOut', JSON.stringify({ userId: idB, at: Date.now() - 120_000, tab: 'old-tab' }));
        }, 10);
      };

      expect(await claimSignOut(idB)).toBe(true);
      expect(isLeavingHere(idB)).toBe(true);
      expect(store.get(ownKeyB)).toBeDefined();
      finishSignOut(idB);
    } finally {
      onSetItem = null;
      finishSignOut();
      vi.stubGlobal('navigator', origNavigator);
    }
  });
});
