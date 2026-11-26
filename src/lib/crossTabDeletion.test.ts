// Cross-tab account deletion regressions: BroadcastChannel sign-out, missed-message
// localStorage fallback (storage events & checkDeletedElsewhere), tabs opened after deletion,
// stale useAppData hooks refusing IndexedDB writes, and finishInterruptedDeletions().
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { IDBFactory, IDBKeyRange } from 'fake-indexeddb';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, Medication } from '../../shared/types';
import type { SyncStatus } from './sync';

// ---------- minimal DOM + Web API shim for React 19 + session listeners ----------

interface FakeNode {
  nodeType: number;
  parentNode: FakeNode | null;
  ownerDocument: FakeDoc;
  childNodes?: FakeNode[];
}

interface FakeEl extends FakeNode {
  tagName: string;
  nodeName: string;
  id: string;
  childNodes: FakeNode[];
  style: Record<string, string>;
  _attrs: Map<string, string>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  addEventListener(): void;
  removeEventListener(): void;
  appendChild<T extends FakeNode>(c: T): T;
  insertBefore<T extends FakeNode>(c: T, ref: FakeNode | null): T;
  removeChild<T extends FakeNode>(c: T): T;
}

interface FakeDoc {
  nodeType: 9;
  defaultView: typeof globalThis;
  documentElement: FakeEl;
  head: FakeEl;
  body: FakeEl;
  parentNode: null;
  visibilityState: string;
  _listeners: Map<string, Set<(e: unknown) => void>>;
  createElement(tag: string): FakeEl;
  createElementNS(_ns: string, tag: string): FakeEl;
  createTextNode(t: string): FakeNode & { data: string; nodeValue: string };
  createComment(t: string): FakeNode & { data: string };
  addEventListener(t: string, fn: (e: unknown) => void): void;
  removeEventListener(t: string, fn: (e: unknown) => void): void;
  dispatchEvent(ev: { type: string } & Record<string, unknown>): boolean;
  getElementById(id: string): FakeEl | null;
}

function makeEl(tag: string, doc: FakeDoc): FakeEl {
  const el: FakeEl = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    id: '',
    childNodes: [],
    style: {},
    ownerDocument: doc,
    parentNode: null,
    _attrs: new Map(),
    setAttribute(k, v) {
      el._attrs.set(k, String(v));
      if (k === 'id') el.id = String(v);
    },
    getAttribute(k) {
      return k === 'id' ? el.id || null : (el._attrs.get(k) ?? null);
    },
    removeAttribute(k) {
      el._attrs.delete(k);
      if (k === 'id') el.id = '';
    },
    addEventListener() {},
    removeEventListener() {},
    appendChild(c) {
      if (c.parentNode && c.parentNode.nodeType === 1) (c.parentNode as FakeEl).removeChild(c);
      c.parentNode = el;
      el.childNodes.push(c);
      return c;
    },
    insertBefore(c, ref) {
      if (c.parentNode && c.parentNode.nodeType === 1) (c.parentNode as FakeEl).removeChild(c);
      c.parentNode = el;
      const i = ref ? el.childNodes.indexOf(ref) : -1;
      if (i >= 0) el.childNodes.splice(i, 0, c);
      else el.childNodes.push(c);
      return c;
    },
    removeChild(c) {
      c.parentNode = null;
      el.childNodes = el.childNodes.filter((x) => x !== c);
      return c;
    },
  };
  return el;
}

function findById(node: FakeNode, id: string): FakeEl | null {
  if (node.nodeType !== 1) return null;
  const el = node as FakeEl;
  if (el.id === id) return el;
  for (const c of el.childNodes) {
    const found = findById(c, id);
    if (found) return found;
  }
  return null;
}

function createFakeDoc(): FakeDoc {
  const doc: FakeDoc = {
    nodeType: 9,
    defaultView: globalThis,
    documentElement: null as unknown as FakeEl,
    head: null as unknown as FakeEl,
    body: null as unknown as FakeEl,
    parentNode: null,
    visibilityState: 'visible',
    _listeners: new Map(),
    createElement: (t) => makeEl(t, doc),
    createElementNS: (_ns, t) => makeEl(t, doc),
    createTextNode: (t) => ({ nodeType: 3, data: String(t), nodeValue: String(t), parentNode: null, ownerDocument: doc }),
    createComment: (t) => ({ nodeType: 8, data: t, parentNode: null, ownerDocument: doc }),
    addEventListener(t, fn) {
      if (!doc._listeners.has(t)) doc._listeners.set(t, new Set());
      doc._listeners.get(t)!.add(fn);
    },
    removeEventListener(t, fn) {
      doc._listeners.get(t)?.delete(fn);
    },
    dispatchEvent(ev) {
      for (const fn of [...(doc._listeners.get(ev.type) ?? [])]) fn(ev);
      return true;
    },
    getElementById: (id) => findById(doc.documentElement, id),
  };
  doc.documentElement = makeEl('html', doc);
  doc.head = makeEl('head', doc);
  doc.body = makeEl('body', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

function createLocksStandIn() {
  type GrantedLock = { name: string; mode: 'shared' | 'exclusive' };
  type LockCb<T> = (lock: GrantedLock | null) => Promise<T> | T;
  type Waiter = { mode: 'shared' | 'exclusive'; start: () => void; cancel: () => void };
  const state = new Map<string, { exclusive: boolean; shared: number; queue: Waiter[] }>();
  const get = (name: string) => {
    let s = state.get(name);
    if (!s) state.set(name, (s = { exclusive: false, shared: 0, queue: [] }));
    return s;
  };
  const drain = (name: string) => {
    const s = get(name);
    while (s.queue.length > 0) {
      const head = s.queue[0]!;
      if (head.mode === 'exclusive') {
        if (s.exclusive || s.shared > 0) break;
        s.queue.shift();
        s.exclusive = true;
        head.start();
        break;
      } else {
        if (s.exclusive) break;
        s.queue.shift();
        s.shared += 1;
        head.start();
      }
    }
  };
  return {
    request<T>(name: string, a: LockOptions | LockCb<T>, b?: LockCb<T>): Promise<T> {
      const opts = typeof a === 'function' ? {} : a;
      const fn = (typeof a === 'function' ? a : b)!;
      const mode: 'shared' | 'exclusive' = opts.mode === 'shared' ? 'shared' : 'exclusive';
      const signal = opts.signal;
      if (signal?.aborted) return Promise.reject(new Error('Aborted'));
      const s = get(name);
      if (opts.ifAvailable) {
        const canGrant =
          s.queue.length === 0 && (mode === 'exclusive' ? !s.exclusive && s.shared === 0 : !s.exclusive);
        if (!canGrant) return Promise.resolve().then(() => fn(null));
      }
      return new Promise<T>((resolve, reject) => {
        const waiter: Waiter = {
          mode,
          start: () => {
            signal?.removeEventListener('abort', onAbort);
            Promise.resolve()
              .then(() => fn({ name, mode }))
              .then(
                (v) => {
                  release();
                  resolve(v);
                },
                (e) => {
                  release();
                  reject(e);
                },
              );
          },
          cancel: () => reject(new Error('Aborted')),
        };
        const release = () => {
          const s = get(name);
          if (mode === 'exclusive') s.exclusive = false;
          else s.shared = Math.max(0, s.shared - 1);
          drain(name);
        };
        const onAbort = () => {
          const s = get(name);
          const idx = s.queue.indexOf(waiter);
          if (idx >= 0) {
            s.queue.splice(idx, 1);
            waiter.cancel();
            drain(name);
          }
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        s.queue.push(waiter);
        drain(name);
      });
    },
  };
}

// ---------- hoisted mocks for sync, auth, push, drugLookup ----------

const mocks = vi.hoisted(() => ({
  syncStop: vi.fn(),
  syncPush: vi.fn(),
  forgetSyncState: vi.fn(async (_uid: string) => {}),
  clearSyncCache: vi.fn(async () => true),
  startSyncOpts: null as null | { onStatus: (s: SyncStatus) => void; isEnded?: () => boolean },
}));

vi.mock('./sync', () => ({
  preloadSync: vi.fn(),
  encryptionMarker: vi.fn(() => 'off'),
  localCopySettled: vi.fn(async () => {}),
  discardIfSynced: vi.fn(async () => false),
  releaseSyncClient: vi.fn(async () => {}),
  forgetSyncState: mocks.forgetSyncState,
  clearSyncCache: mocks.clearSyncCache,
  startSync: vi.fn((opts: { onStatus: (s: SyncStatus) => void; isEnded?: () => boolean }) => {
    mocks.startSyncOpts = opts;
    queueMicrotask(() => opts.onStatus({ state: 'synced', lock: 'unlocked', cloudLoaded: true }));
    return {
      push: mocks.syncPush,
      stop: mocks.syncStop,
      retry: vi.fn(),
      lockedElsewhere: vi.fn(),
      prepareSetup: vi.fn(),
      unlock: vi.fn(),
      changePassphrase: vi.fn(),
      getRecoveryKey: vi.fn(),
      prepareNewRecoveryKey: vi.fn(),
      prepareReset: vi.fn(),
      forgetKey: vi.fn(),
      dataKey: () => null,
      deletedInCloud: () => false,
      flushAll: vi.fn(async () => ({ ok: true as const })),
    };
  }),
}));

vi.mock('./auth', () => ({
  clearSession: vi.fn(),
  deleteFirebaseUser: vi.fn(async () => {}),
  reauthenticateForDeletion: vi.fn(async () => true),
  signOut: vi.fn(async () => {}),
}));

vi.mock('./push', () => ({
  disablePush: vi.fn(async () => {}),
  forgetReminderState: vi.fn(),
  stopLocalReminders: vi.fn(),
  syncReminders: vi.fn(async () => ({ count: 0, mode: 'off' as const })),
}));

vi.mock('./drugLookup', () => ({
  clearDrugInfoCache: vi.fn(),
}));

const med = (id: string): Medication => ({
  id,
  name: `Med ${id}`,
  dosage: '10 mg',
  form: 'Tablet',
  quantityPerDose: 1,
  color: '#0f766e',
  schedule: makeSchedule('daily', '2026-01-01'),
  notificationsEnabled: false,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

const appData = (medications: Medication[]): AppData => ({ version: 1, medications, doseLogs: [] });

let storage: Map<string, string>;
let winListeners: Map<string, Set<(e: unknown) => void>>;
let fakeDoc: FakeDoc;
let root: Root | null = null;

function installGlobals(opts: { resetStorage?: boolean } = {}) {
  if (opts.resetStorage) storage = new Map<string, string>();
  winListeners = new Map();
  fakeDoc = createFakeDoc();
  const rootDiv = fakeDoc.createElement('div');
  rootDiv.setAttribute('id', 'root');
  fakeDoc.body.appendChild(rootDiv);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('IDBKeyRange', IDBKeyRange);
  vi.stubGlobal('document', fakeDoc);
  vi.stubGlobal('HTMLElement', function () {});
  vi.stubGlobal('HTMLIFrameElement', function () {});
  vi.stubGlobal('Element', function () {});
  vi.stubGlobal('Node', function () {});
  const win = {
    addEventListener(t: string, fn: (e: unknown) => void) {
      if (!winListeners.has(t)) winListeners.set(t, new Set());
      winListeners.get(t)!.add(fn);
    },
    removeEventListener(t: string, fn: (e: unknown) => void) {
      winListeners.get(t)?.delete(fn);
    },
    dispatchEvent(ev: { type: string } & Record<string, unknown>) {
      for (const fn of [...(winListeners.get(ev.type) ?? [])]) fn(ev);
      return true;
    },
  };
  vi.stubGlobal('window', win);
  vi.stubGlobal('localStorage', {
    get length() {
      return storage.size;
    },
    key: (i: number) => [...storage.keys()][i] ?? null,
    getItem: (k: string) => storage.get(k) ?? null,
    setItem: (k: string, v: string) => void storage.set(k, String(v)),
    removeItem: (k: string) => void storage.delete(k),
  });
  vi.stubGlobal('navigator', {
    onLine: true,
    locks: createLocksStandIn(),
  });
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.syncStop.mockReset();
  mocks.startSyncOpts = null;
  installGlobals({ resetStorage: true });
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  vi.unstubAllGlobals();
});

describe('cross-tab deletion fallback and persistence guards', () => {
  it('ends a session and notifies once when a storage event reports medtracker.deletedAccounts written by another tab', async () => {
    const session = await import('./session');
    const id = 'firebase:storage-evt';
    const onEnd = vi.fn();
    const release = session.holdSession(id, onEnd);
    const notified: string[] = [];
    const off = session.onDeletedElsewhere((uid) => notified.push(uid));

    // Another tab writes the deletion mark directly (no BroadcastChannel message).
    storage.set('medtracker.deletedAccounts', JSON.stringify({ [id]: { mark: 'm-storage', at: Date.now() } }));
    window.dispatchEvent({ type: 'storage', key: 'medtracker.deletedAccounts' } as unknown as Event);
    await settle(2);

    expect(onEnd).toHaveBeenCalledTimes(1);
    expect(onEnd).toHaveBeenCalledWith(true);
    expect(notified).toEqual([id]);

    // Dispatching another storage event or calling checkDeletedElsewhere does not notify again.
    window.dispatchEvent({ type: 'storage', key: 'medtracker.deletedAccounts' } as unknown as Event);
    session.checkDeletedElsewhere();
    await settle(2);
    expect(notified).toEqual([id]);

    off();
    release();
  });

  it('persists deletion mark across module reload (new tab opened after deletion) until resumed', async () => {
    const id = 'firebase:new-tab';
    const session1 = await import('./session');
    session1.markAccountDeleted(id);

    // Simulate a newly opened tab with a fresh module instance sharing the same localStorage.
    vi.resetModules();
    installGlobals({ resetStorage: false });
    const session2 = await import('./session');

    const notified: string[] = [];
    const off = session2.onDeletedElsewhere((uid) => notified.push(uid));
    expect(session2.isAccountDeleted(id)).toBe(true);
    expect(session2.unfinishedDeletions()).toEqual([id]);
    // Already-deleted state on startup is not reported as an elsewhere deletion event.
    session2.checkDeletedElsewhere();
    expect(notified).toEqual([]);

    // Resuming on explicit sign-in allows the account again while keeping accountDeletedSince(id, null) true.
    session2.resumeAccount(id);
    expect(session2.isAccountDeleted(id)).toBe(false);
    expect(session2.accountDeletedSince(id, null)).toBe(true);
    expect(session2.unfinishedDeletions()).toEqual([]);
    off();
  });

  it('stale useAppData hook (Google) refuses to save a medication to IndexedDB after another tab writes the deletion mark', async () => {
    const db = await import('./localDb');
    const { useAppData } = await import('./store');
    const uid = 'u-stale';
    const userId = `firebase:${uid}`;

    let api: ReturnType<typeof useAppData> | null = null;
    function Probe() {
      api = useAppData(userId, uid);
      return null;
    }

    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(React.createElement(Probe)));
    await settle();

    expect(api!.loaded).toBe(true);
    expect((await db.loadAccount(userId)).medications).toEqual([]);

    // Another tab deletes the account (direct localStorage write, no BroadcastChannel or storage event).
    storage.set('medtracker.deletedAccounts', JSON.stringify({ [userId]: { mark: 'm-deleted', at: Date.now() } }));

    await act(async () => {
      api!.saveMedication(med('m1'));
    });
    await settle();

    expect((await db.loadAccount(userId)).medications).toEqual([]);
    expect(mocks.syncPush).not.toHaveBeenCalled();
    expect(mocks.syncStop).toHaveBeenCalled();
    expect(api!.data.medications).toEqual([]);
  });

  it('stale useAppData hook (guest) refuses to save a medication to IndexedDB after another tab writes the deletion mark', async () => {
    const db = await import('./localDb');
    const { useAppData } = await import('./store');

    let api: ReturnType<typeof useAppData> | null = null;
    function Probe() {
      api = useAppData('guest');
      return null;
    }

    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(React.createElement(Probe)));
    await settle();

    expect(api!.loaded).toBe(true);
    expect((await db.loadAccount('guest')).medications).toEqual([]);

    storage.set('medtracker.deletedAccounts', JSON.stringify({ guest: { mark: 'm-guest', at: Date.now() } }));

    await act(async () => {
      api!.saveMedication(med('m-guest'));
    });
    await settle();

    expect((await db.loadAccount('guest')).medications).toEqual([]);
    expect(api!.data.medications).toEqual([]);
  });

  it('finishInterruptedDeletions removes IndexedDB data only for deleted accounts not yet wiped, resumed, or signing out', async () => {
    const db = await import('./localDb');
    const session = await import('./session');
    const account = await import('./account');

    const interrupted = 'firebase:interrupted';
    const guestInterrupted = 'guest';
    const signingOutLive = 'firebase:signing-out';
    const wiped = 'firebase:wiped';
    const resumed = 'firebase:resumed';
    const active = 'firebase:active';

    await db.replaceAccount(interrupted, appData([med('m1')]));
    await db.replaceAccount(guestInterrupted, appData([med('m2')]));
    await db.replaceAccount(signingOutLive, appData([med('m-live')]));
    await db.replaceAccount(wiped, appData([med('m3')]));
    await db.replaceAccount(resumed, appData([med('m4')]));
    await db.replaceAccount(active, appData([med('m5')]));

    session.markAccountDeleted(interrupted);
    // A fresh marker from a gone tab (no claim lock held) must not block wiping.
    storage.set('medtracker.signingOut', JSON.stringify({ userId: interrupted, at: Date.now(), tab: 'dead-tab' }));
    session.markAccountDeleted(guestInterrupted);
    session.markAccountDeleted(signingOutLive);
    expect(await session.claimSignOut(signingOutLive)).toBe(true);
    session.markAccountDeleted(wiped);
    session.markDeviceWiped(wiped);
    session.markAccountDeleted(resumed);
    session.resumeAccount(resumed);

    await account.finishInterruptedDeletions();

    expect((await db.loadAccount(interrupted)).medications).toEqual([]);
    expect((await db.loadAccount(guestInterrupted)).medications).toEqual([]);
    expect((await db.loadAccount(signingOutLive)).medications).toHaveLength(1);
    expect((await db.loadAccount(wiped)).medications).toHaveLength(1);
    expect((await db.loadAccount(resumed)).medications).toHaveLength(1);
    expect((await db.loadAccount(active)).medications).toHaveLength(1);

    expect(mocks.forgetSyncState).toHaveBeenCalledTimes(1);
    expect(mocks.forgetSyncState).toHaveBeenCalledWith('interrupted');
    expect(session.unfinishedDeletions({ evenIfSigningOut: true })).toEqual([signingOutLive]);

    session.releaseSignOutClaim(signingOutLive);
    await settle(1);
    await account.finishInterruptedDeletions();
    expect((await db.loadAccount(signingOutLive)).medications).toEqual([]);
    expect(session.unfinishedDeletions({ evenIfSigningOut: true })).toEqual([]);
  });

  it('useAppData empties in-memory data and stops sync when another tab broadcasts deletion', async () => {
    const db = await import('./localDb');
    const { useAppData } = await import('./store');
    const uid = 'u-bc';
    const userId = `firebase:${uid}`;
    await db.replaceAccount(userId, appData([med('m-existing')]));

    let api: ReturnType<typeof useAppData> | null = null;
    function Probe() {
      api = useAppData(userId, uid);
      return null;
    }

    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(React.createElement(Probe)));
    await settle();

    expect(api!.loaded).toBe(true);
    expect(api!.data.medications.map((m) => m.id)).toEqual(['m-existing']);

    const other = new BroadcastChannel('medtracker-session');
    other.postMessage({ type: 'signing-out', userId, reason: 'deleting' });
    await settle();
    other.close();

    expect(mocks.syncStop).toHaveBeenCalled();
    expect(api!.data.medications).toEqual([]);

    // Attempting an edit after the elsewhere deletion does not write back to IndexedDB.
    await act(async () => {
      api!.saveMedication(med('m-late'));
    });
    await settle();
    expect((await db.loadAccount(userId)).medications.map((m) => m.id)).toEqual(['m-existing']);
    expect(mocks.syncPush).not.toHaveBeenCalled();
  });

  it('does not take over guest data into an account deleted while loadForUser is waiting on the load lock', async () => {
    const db = await import('./localDb');
    const { useAppData } = await import('./store');
    const uid = 'u-take';
    const userId = `firebase:${uid}`;

    await db.replaceAccount('guest', appData([med('g1')]));

    // Hold withLoadLock's exclusive lock (`medtracker-load-${userId}`) before rendering so
    // loadForUser waits on the lock while the deletion mark is written by another tab.
    let releaseLoadLock!: () => void;
    const lockHeld = navigator.locks.request(
      `medtracker-load-${userId}`,
      () =>
        new Promise<void>((resolve) => {
          releaseLoadLock = resolve;
        }),
    );
    await Promise.resolve();

    let api: ReturnType<typeof useAppData> | null = null;
    function Probe() {
      api = useAppData(userId, uid);
      return null;
    }

    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(React.createElement(Probe)));
    await settle(2);

    // Another tab deletes the account while loadForUser is still waiting for the load lock.
    storage.set('medtracker.deletedAccounts', JSON.stringify({ [userId]: { mark: 'm-take', at: Date.now() } }));
    releaseLoadLock();
    await lockHeld;
    await settle();

    expect((await db.loadAccount('guest')).medications.map((m) => m.id)).toEqual(['g1']);
    expect((await db.loadAccount(userId)).medications).toEqual([]);
    expect((await db.loadAccount(userId)).doseLogs).toEqual([]);
    expect(api!.loaded).toBe(false);
    expect(api!.data.medications).toEqual([]);
    expect(mocks.syncStop).toHaveBeenCalled();
  });

  it('stops sync synchronously on detection when saveMedication sees a new deletion mark', async () => {
    const db = await import('./localDb');
    const { useAppData } = await import('./store');
    const uid = 'u-sync-stop';
    const userId = `firebase:${uid}`;

    let api: ReturnType<typeof useAppData> | null = null;
    function Probe() {
      api = useAppData(userId, uid);
      return null;
    }

    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(React.createElement(Probe)));
    await settle();

    expect(api!.loaded).toBe(true);
    mocks.syncStop.mockClear();

    // Another tab writes the deletion mark directly (no BroadcastChannel or storage event).
    storage.set('medtracker.deletedAccounts', JSON.stringify({ [userId]: { mark: 'm-sync-stop', at: Date.now() } }));

    let stoppedSynchronously = false;
    act(() => {
      api!.saveMedication(med('m1'));
      stoppedSynchronously = mocks.syncStop.mock.calls.length === 1;
    });

    // Assert before any settle rounds: ended() must call sync.stop() synchronously.
    expect(stoppedSynchronously).toBe(true);
    expect(mocks.syncStop).toHaveBeenCalledTimes(1);
    expect(mocks.syncPush).not.toHaveBeenCalled();

    await settle();
    expect((await db.loadAccount(userId)).medications).toEqual([]);
    expect(api!.data.medications).toEqual([]);
  });

  it('finishInterruptedDeletions and finishDeletionBeforeReuse wipe an interrupted deletion within the 60s marker TTL when its tab is gone', async () => {
    const db = await import('./localDb');
    const session = await import('./session');
    const account = await import('./account');

    const id1 = 'firebase:dead-ttl-1';
    const id2 = 'firebase:dead-ttl-2';

    await db.replaceAccount(id1, appData([med('m-ttl-1')]));
    session.markAccountDeleted(id1);
    storage.set('medtracker.signingOut', JSON.stringify({ userId: id1, at: Date.now(), tab: 'dead-tab' }));

    await account.finishInterruptedDeletions();

    expect((await db.loadAccount(id1)).medications).toEqual([]);
    expect(mocks.forgetSyncState).toHaveBeenCalledWith('dead-ttl-1');
    expect(session.unfinishedDeletions({ evenIfSigningOut: true })).toEqual([]);

    await db.replaceAccount(id2, appData([med('m-ttl-2')]));
    session.markAccountDeleted(id2);
    storage.set('medtracker.signingOut', JSON.stringify({ userId: id2, at: Date.now(), tab: 'dead-tab' }));

    expect(await account.finishDeletionBeforeReuse(id2)).toBe(true);
    expect((await db.loadAccount(id2)).medications).toEqual([]);
    expect(mocks.forgetSyncState).toHaveBeenCalledWith('dead-ttl-2');
    expect(session.unfinishedDeletions({ evenIfSigningOut: true })).toEqual([]);
  });

  it('does not take over guest data into a Google account when the guest account is deleted and not resumed', async () => {
    const db = await import('./localDb');
    const session = await import('./session');
    const { useAppData } = await import('./store');
    const uid = 'x';
    const userId = `firebase:${uid}`;

    await db.replaceAccount('guest', appData([med('g-deleted')]));
    session.markAccountDeleted('guest');

    let api: ReturnType<typeof useAppData> | null = null;
    function Probe() {
      api = useAppData(userId, uid);
      return null;
    }

    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(React.createElement(Probe)));
    await settle();

    expect(api!.loaded).toBe(true);
    expect(api!.data.medications).toEqual([]);
    expect((await db.loadAccount(userId)).medications).toEqual([]);
    expect((await db.loadAccount('guest')).medications.map((m) => m.id)).toEqual(['g-deleted']);
  });

  it('useAppData ends the session when mounted with a pre-deletion mark after another tab writes a deletion mark', async () => {
    const db = await import('./localDb');
    const session = await import('./session');
    const { useAppData } = await import('./store');
    const id = 'firebase:issue5-mark';
    await db.replaceAccount(id, appData([med('m-existing')]));

    const before = session.deletionMark(id);
    // Another tab writes the deletion mark directly so this tab's `known` map has not seen it.
    storage.set('medtracker.deletedAccounts', JSON.stringify({ [id]: { mark: 'm-new-del', at: Date.now() } }));

    let api: ReturnType<typeof useAppData> | null = null;
    function Probe() {
      api = useAppData(id, undefined, undefined, before);
      return null;
    }

    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(React.createElement(Probe)));
    await settle();

    expect(api!.loaded).toBe(false);
    expect(api!.data.medications).toEqual([]);

    await act(async () => {
      api!.saveMedication(med('m-after'));
    });
    await settle();

    expect(api!.data.medications).toEqual([]);
    expect((await db.loadAccount(id)).medications.map((m) => m.id)).toEqual(['m-existing']);
  });

  it('useAppData onEnd stops sync before pending IndexedDB saves settle', async () => {
    const realDb = await vi.importActual<typeof import('./localDb')>('./localDb');
    let releaseSave!: () => void;
    let saveStarted!: () => void;
    const saveStartedPromise = new Promise<void>((r) => (saveStarted = r));
    const events: string[] = [];

    mocks.syncStop.mockImplementation(() => {
      events.push('syncStop');
    });

    vi.doMock('./localDb', () => ({
      ...realDb,
      writeChanges: vi.fn(async (uid: string, changes: Parameters<typeof realDb.writeChanges>[1]) => {
        if (changes.putMeds.length > 0) {
          saveStarted();
          await new Promise<void>((r) => (releaseSave = r));
          events.push('saveResolved');
        }
        return realDb.writeChanges(uid, changes);
      }),
    }));

    try {
      const { useAppData } = await import('./store');
      const uid = 'u-slow-save';
      const userId = `firebase:${uid}`;

      let api: ReturnType<typeof useAppData> | null = null;
      function Probe() {
        api = useAppData(userId, uid);
        return null;
      }

      root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
      await act(async () => root!.render(React.createElement(Probe)));
      await settle();

      expect(api!.loaded).toBe(true);
      mocks.syncStop.mockClear();
      events.length = 0;

      act(() => {
        api!.saveMedication(med('m-slow'));
      });
      await saveStartedPromise;

      const other = new BroadcastChannel('medtracker-session');
      other.postMessage({ type: 'signing-out', userId, reason: 'signing-out' });
      await settle(2);
      other.close();

      expect(mocks.syncStop).toHaveBeenCalledTimes(1);
      expect(events).toEqual(['syncStop']);

      releaseSave();
      await settle();
      expect(events).toEqual(['syncStop', 'saveResolved']);
    } finally {
      vi.doUnmock('./localDb');
    }
  });

  it('startSync receives isEnded which returns false normally and returns true while stopping sync after a new deletion mark', async () => {
    const { useAppData } = await import('./store');
    const uid = 'u-is-ended';
    const userId = `firebase:${uid}`;

    let api: ReturnType<typeof useAppData> | null = null;
    function Probe() {
      api = useAppData(userId, uid);
      return null;
    }

    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(React.createElement(Probe)));
    await settle();

    expect(api!.loaded).toBe(true);
    expect(mocks.startSyncOpts?.isEnded).toBeTypeOf('function');
    expect(mocks.startSyncOpts!.isEnded!()).toBe(false);

    mocks.syncStop.mockClear();
    storage.set('medtracker.deletedAccounts', JSON.stringify({ [userId]: { mark: 'm-is-ended', at: Date.now() } }));

    let endedNow = false;
    await act(async () => {
      endedNow = mocks.startSyncOpts!.isEnded!();
    });
    expect(endedNow).toBe(true);
    expect(mocks.syncStop).toHaveBeenCalled();
    await settle();
  });

  it('whenSignOutEnds waits while a marker is fresh and calls cb once when stale or removed via storage event', async () => {
    vi.useFakeTimers();
    try {
      const session = await import('./session');
      const id = 'firebase:when-ends';

      // Case 1: dead tab leaves a fresh marker that goes stale after 60s TTL.
      storage.set('medtracker.signingOut', JSON.stringify({ userId: id, at: Date.now(), tab: 'dead-tab' }));
      const cbStale = vi.fn();
      const stopStale = session.whenSignOutEnds(id, cbStale);

      expect(cbStale).not.toHaveBeenCalled();
      vi.advanceTimersByTime(59_000);
      expect(cbStale).not.toHaveBeenCalled();

      vi.advanceTimersByTime(2_000);
      expect(cbStale).toHaveBeenCalledTimes(1);
      stopStale();

      // Case 2: marker is removed and a storage event is dispatched.
      storage.set('medtracker.signingOut', JSON.stringify({ userId: id, at: Date.now(), tab: 'live-tab' }));
      const cbRemoved = vi.fn();
      const stopRemoved = session.whenSignOutEnds(id, cbRemoved);

      expect(cbRemoved).not.toHaveBeenCalled();
      storage.delete('medtracker.signingOut');
      window.dispatchEvent({ type: 'storage', key: 'medtracker.signingOut' } as unknown as Event);

      expect(cbRemoved).toHaveBeenCalledTimes(1);
      vi.advanceTimersByTime(61_000);
      expect(cbRemoved).toHaveBeenCalledTimes(1);
      stopRemoved();
    } finally {
      vi.useRealTimers();
    }
  });

  it('whenSignOutEnds reacts to storage events for per-account marker keys without ending for another account', async () => {
    vi.useFakeTimers();
    try {
      const session = await import('./session');
      const idA = 'firebase:per-acct-a';
      const idB = 'firebase:per-acct-b';

      storage.set(`medtracker.signingOut.${idA}`, JSON.stringify({ userId: idA, at: Date.now(), tab: 'tab-a' }));
      storage.set(`medtracker.signingOut.${idB}`, JSON.stringify({ userId: idB, at: Date.now(), tab: 'tab-b' }));

      const cbA = vi.fn();
      const stopA = session.whenSignOutEnds(idA, cbA);
      expect(cbA).not.toHaveBeenCalled();

      // Another account finishing sign-out must not wake idA's listener.
      storage.delete(`medtracker.signingOut.${idB}`);
      window.dispatchEvent({ type: 'storage', key: `medtracker.signingOut.${idB}` } as unknown as Event);
      expect(cbA).not.toHaveBeenCalled();

      // Removing idA's per-account marker wakes idA's listener once.
      storage.delete(`medtracker.signingOut.${idA}`);
      window.dispatchEvent({ type: 'storage', key: `medtracker.signingOut.${idA}` } as unknown as Event);
      expect(cbA).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(61_000);
      expect(cbA).toHaveBeenCalledTimes(1);
      stopA();
    } finally {
      vi.useRealTimers();
    }
  });
});
