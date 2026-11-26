import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { createKeyBundle, encryptLog, encryptMed, unlockWithPassphrase, type KeyBundle } from './syncCrypto';
import { logDocId } from './syncOps';

// ---------- minimal DOM shim for React 19 in Node ----------

interface FakeEl {
  nodeType: number;
  tagName: string;
  nodeName: string;
  id: string;
  className: string;
  childNodes: FakeNode[];
  style: Record<string, string> & { setProperty(k: string, v: string): void; removeProperty(k: string): void };
  dataset: Record<string, string>;
  ownerDocument: FakeDoc;
  parentNode: FakeNode | null;
  _attrs: Map<string, string>;
  _listeners: Map<string, Set<(e: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  removeEventListener(t: string, fn: (e: unknown) => void): void;
  dispatchEvent(ev: Record<string, unknown>): boolean;
  appendChild<T extends FakeNode>(c: T): T;
  insertBefore<T extends FakeNode>(c: T, ref: FakeNode | null): T;
  removeChild<T extends FakeNode>(c: T): T;
  readonly firstChild: FakeNode | null;
  textContent: string;
}

type FakeNode =
  | FakeEl
  | { nodeType: 3 | 8; data: string; nodeValue?: string; parentNode: FakeNode | null; ownerDocument: FakeDoc };

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
  createElementNS(ns: string, tag: string): FakeEl;
  createTextNode(t: string): FakeNode;
  createComment(t: string): FakeNode;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  removeEventListener(t: string, fn: (e: unknown) => void): void;
  getElementById(id: string): FakeEl | null;
}

function walkEls(node: FakeNode, pred: (el: FakeEl) => boolean, out: FakeEl[] = []): FakeEl[] {
  if (node.nodeType === 1) {
    const el = node as FakeEl;
    if (pred(el)) out.push(el);
    for (const c of el.childNodes) walkEls(c, pred, out);
  }
  return out;
}

function makeEl(tag: string, doc: FakeDoc): FakeEl {
  const el: FakeEl = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    id: '',
    className: '',
    childNodes: [],
    style: Object.assign({} as Record<string, string>, {
      setProperty(k: string, v: string) {
        el.style[k] = v;
      },
      removeProperty(k: string) {
        delete el.style[k];
      },
    }),
    dataset: {},
    ownerDocument: doc,
    parentNode: null,
    _attrs: new Map(),
    _listeners: new Map(),
    setAttribute(k, v) {
      el._attrs.set(k, String(v));
      if (k === 'id') el.id = String(v);
      if (k === 'class') el.className = String(v);
    },
    getAttribute(k) {
      if (k === 'id') return el.id || null;
      if (k === 'class') return el.className || null;
      return el._attrs.get(k) ?? null;
    },
    removeAttribute(k) {
      el._attrs.delete(k);
      if (k === 'id') el.id = '';
      if (k === 'class') el.className = '';
    },
    addEventListener(t, fn) {
      if (!el._listeners.has(t)) el._listeners.set(t, new Set());
      el._listeners.get(t)!.add(fn);
    },
    removeEventListener(t, fn) {
      el._listeners.get(t)?.delete(fn);
    },
    dispatchEvent(ev) {
      ev.target ??= el;
      return true;
    },
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
    get firstChild() {
      return el.childNodes[0] ?? null;
    },
    get textContent() {
      return el.childNodes
        .map((c) =>
          c.nodeType === 3
            ? ((c as { nodeType: 3; data: string; nodeValue?: string }).nodeValue ?? (c as { nodeType: 3; data: string }).data)
            : c.nodeType === 1
              ? (c as FakeEl).textContent
              : '',
        )
        .join('');
    },
    set textContent(v) {
      el.childNodes = v ? [{ nodeType: 3, data: String(v), parentNode: el, ownerDocument: doc }] : [];
    },
  };
  return el;
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
    getElementById(id) {
      return walkEls(doc.documentElement, (el) => el.id === id)[0] ?? null;
    },
  };
  doc.documentElement = makeEl('html', doc);
  doc.head = makeEl('head', doc);
  doc.body = makeEl('body', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

const state = vi.hoisted(() => ({
  accounts: new Map<string, AppData>(),
  sealed: new Map<string, unknown>(),
  sealedMarks: new Set<string>(),
  decrypted: new Map<string, Map<string, unknown>>(),
  deviceKeys: new Map<string, { key: CryptoKey; keyId: string }>(),
  storage: new Map<string, string>(),
  metaDocs: new Map<string, Record<string, unknown>>(),
  medDocs: new Map<string, Map<string, Record<string, unknown>>>(),
  logDocs: new Map<string, Map<string, Record<string, unknown>>>(),
  metaListeners: new Set<(s: unknown) => void>(),
  medListeners: new Map<string, Set<(s: unknown) => void>>(),
  logListeners: new Map<string, Set<(s: unknown) => void>>(),
}));

vi.mock('./localDb', async (importOriginal) => {
  const real = await importOriginal<typeof import('./localDb')>();
  const clone = <T,>(v: T): T => structuredClone(v);
  const empty = (): AppData => ({ version: 1, medications: [], doseLogs: [] });
  return {
    ...real,
    localDbAvailable: vi.fn(async () => true),
    loadAccount: vi.fn(async (userId: string): Promise<AppData> => clone(state.accounts.get(userId) ?? empty())),
    writeChanges: vi.fn(async (userId: string, c: import('./localDb').Changes) => {
      if (!real.hasChanges(c)) return;
      if (state.sealedMarks.has(userId)) throw new real.LocalCopyLockedError();
      state.accounts.set(userId, clone(real.applyChanges(state.accounts.get(userId) ?? empty(), c)));
    }),
    replaceAccount: vi.fn(async (userId: string, data: AppData) => {
      if (state.sealedMarks.has(userId)) throw new real.LocalCopyLockedError();
      state.accounts.set(userId, clone(data));
    }),
    deleteAccount: vi.fn(async (userId: string) => {
      state.accounts.delete(userId);
    }),
    clearSealedMark: vi.fn(async (userId: string) => void state.sealedMarks.delete(userId)),
    isSealed: vi.fn(async (userId: string) => state.sealedMarks.has(userId)),
    loadSealed: vi.fn(async (userId: string, keyId: string) => clone(state.sealed.get(`${userId}|${keyId}`))),
    storeSealed: vi.fn(async (userId: string, keyId: string, sealed: unknown, encrypted: AppData) => {
      if (JSON.stringify(state.accounts.get(userId) ?? empty()) !== JSON.stringify(encrypted)) return false;
      if (sealed !== null) state.sealed.set(`${userId}|${keyId}`, clone(sealed));
      state.sealedMarks.add(userId);
      state.accounts.delete(userId);
      return true;
    }),
    restoreSealed: vi.fn(async (userId: string, keyId: string, data: AppData) => {
      state.accounts.set(userId, clone(data));
      state.sealed.delete(`${userId}|${keyId}`);
      state.sealedMarks.delete(userId);
    }),
    loadDecrypted: vi.fn(async (uid: string) => new Map(state.decrypted.get(uid) ?? [])),
    saveDecrypted: vi.fn(async (uid: string, put: [string, unknown][], del: string[]) => {
      const m = state.decrypted.get(uid) ?? new Map<string, unknown>();
      for (const [k, v] of put) m.set(k, v);
      for (const k of del) m.delete(k);
      state.decrypted.set(uid, m);
    }),
    clearDecrypted: vi.fn(async (uid?: string) => {
      if (uid) state.decrypted.delete(uid);
      else state.decrypted.clear();
    }),
  };
});

vi.mock('./keyStore', () => ({
  loadDeviceKey: vi.fn(async (uid: string) => state.deviceKeys.get(uid) ?? null),
  saveDeviceKey: vi.fn(async (uid: string, value: { key: CryptoKey; keyId: string }) => void state.deviceKeys.set(uid, value)),
  forgetDeviceKey: vi.fn(async (uid: string) => void state.deviceKeys.delete(uid)),
  forgetAllDeviceKeys: vi.fn(async () => state.deviceKeys.clear()),
  forgetDeviceKeyIf: vi.fn(async (uid: string, keyId: string) => {
    if (state.deviceKeys.get(uid)?.keyId === keyId) state.deviceKeys.delete(uid);
  }),
}));

vi.mock('firebase/firestore', () => {
  class FieldPath {
    segments: string[];
    constructor(...segments: string[]) {
      this.segments = segments;
    }
  }
  return {
    FieldPath,
    initializeFirestore: vi.fn(() => ({ __mockDb: true })),
    getFirestore: vi.fn(() => ({ __mockDb: true })),
    persistentLocalCache: vi.fn(() => ({})),
    persistentMultipleTabManager: vi.fn(() => ({})),
    terminate: vi.fn(async () => {}),
    clearIndexedDbPersistence: vi.fn(async () => {}),
    doc: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
    collection: vi.fn((_db: unknown, ...segments: string[]) => ({ path: segments.join('/') })),
    deleteField: vi.fn(() => ({ __deleteField: true })),
    onSnapshot: vi.fn((ref: { path: string }, _opts: unknown, onNext: (s: unknown) => void) => {
      const parts = ref.path.split('/');
      const uid = parts[1]!;
      if (parts.length === 4 && parts[2] === 'meta' && parts[3] === 'crypto') {
        const data = state.metaDocs.get(uid);
        queueMicrotask(() =>
          onNext({ exists: () => data !== undefined, data: () => data, metadata: { fromCache: false, hasPendingWrites: false } }),
        );
        state.metaListeners.add(onNext);
        return () => state.metaListeners.delete(onNext);
      }
      if (parts.length === 3 && (parts[2] === 'meds' || parts[2] === 'logs')) {
        const col = parts[2] === 'meds' ? state.medDocs.get(uid) : state.logDocs.get(uid);
        const changes = [...(col ?? new Map()).entries()].map(([id, data]) => ({ type: 'added', doc: { id, data: () => data } }));
        queueMicrotask(() => onNext({ docChanges: () => changes, metadata: { fromCache: false, hasPendingWrites: false } }));
        const listenerMap = parts[2] === 'meds' ? state.medListeners : state.logListeners;
        let set = listenerMap.get(uid);
        if (!set) listenerMap.set(uid, (set = new Set()));
        set.add(onNext);
        return () => set.delete(onNext);
      }
      return () => {};
    }),
    writeBatch: vi.fn(),
    waitForPendingWrites: vi.fn(async () => {}),
    runTransaction: vi.fn(),
    setDoc: vi.fn(async () => {}),
    getDocFromServer: vi.fn(),
    deleteDoc: vi.fn(async () => {}),
    getDocsFromServer: vi.fn(),
  };
});

vi.mock('./auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('./auth')>();
  return {
    ...real,
    FIREBASE_CONFIGURED: true,
    getFirebaseApp: vi.fn(async () => ({ app: {}, auth: {} })),
  };
});

vi.mock('./push', () => ({
  claimPendingTakes: vi.fn(async () => []),
  getPushState: vi.fn(async () => 'granted'),
  onPendingTakesChange: vi.fn(() => () => {}),
  onServiceWorkerMessage: vi.fn(() => () => {}),
  pendingTakeCount: vi.fn(() => 0),
  queuePendingTake: vi.fn(async () => {}),
  registerServiceWorker: vi.fn(),
  stopLocalReminders: vi.fn(),
  syncReminders: vi.fn(async () => ({ count: 0, mode: 'off' as const })),
  disablePush: vi.fn(async () => {}),
  forgetReminderState: vi.fn(),
}));

const UID = 'u1';
const USER_ID = `firebase:${UID}`;
const OLD_PASS = 'correct horse battery staple';
const NEW_PASS = 'zebra quartz ninja velvet tomato';

let fakeDoc: FakeDoc;
let root: Root | null = null;
let bundle: KeyBundle;

const sampleMed = (over: Partial<Medication> = {}): Medication => ({
  id: 'm1',
  name: 'Lisinopril',
  dosage: '10 mg',
  form: 'Tablet',
  quantityPerDose: 1,
  supplyRemaining: 30,
  color: '#0f766e',
  schedule: makeSchedule('daily', '2026-01-01'),
  notificationsEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

function captureOutcome<T>(p: Promise<T>) {
  return p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

async function settle(rounds = 6) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await settle(1);
  if (!cond()) throw new Error('until() timed out');
  await settle(2);
}

async function encryptedAccount(meds: Medication[] = [sampleMed()], logs: DoseLog[] = []) {
  state.metaDocs.set(UID, bundle.meta as unknown as Record<string, unknown>);
  const medDocs = new Map<string, Record<string, unknown>>();
  for (const m of meds) medDocs.set(m.id, (await encryptMed(bundle.dek, UID, m, bundle.meta.keyId)) as unknown as Record<string, unknown>);
  state.medDocs.set(UID, medDocs);
  const logDocs = new Map<string, Record<string, unknown>>();
  for (const l of logs) {
    const doc = logDocId(l);
    const entry = logDocs.get(doc) ?? { logs: {} as Record<string, unknown> };
    (entry.logs as Record<string, unknown>)[l.id] = await encryptLog(bundle.dek, UID, doc, l, bundle.meta.keyId);
    logDocs.set(doc, entry);
  }
  state.logDocs.set(UID, logDocs);
}

async function rememberKey() {
  state.deviceKeys.set(UID, { key: await unlockWithPassphrase(bundle.meta, UID, OLD_PASS), keyId: bundle.meta.keyId });
}

function defaultWriteBatch() {
  const ops: (() => void)[] = [];
  return {
    set: vi.fn(),
    delete: vi.fn((ref: { path: string }) => {
      ops.push(() => {
        const [, uid, colName, id] = ref.path.split('/');
        const store = colName === 'meds' ? state.medDocs : colName === 'logs' ? state.logDocs : null;
        if (store && uid && id) store.get(uid)?.delete(id);
      });
    }),
    update: vi.fn(),
    commit: vi.fn(() => {
      for (const op of ops) op();
      return Promise.resolve();
    }),
  };
}

function defaultRunTransaction(_db: unknown, fn: (tx: unknown) => Promise<unknown>) {
  const uidOf = (ref: { path: string }) => ref.path.split('/')[1]!;
  return fn({
    get: async (ref: { path: string }) => {
      const d = state.metaDocs.get(uidOf(ref));
      return { exists: () => d !== undefined, data: () => d };
    },
    set: (ref: { path: string }, data: Record<string, unknown>) => void state.metaDocs.set(uidOf(ref), data),
  });
}

function defaultGetDocsFromServer(colRef: { path: string }) {
  const [, uid, colName] = colRef.path.split('/');
  const col = colName === 'meds' ? state.medDocs.get(uid!) : colName === 'logs' ? state.logDocs.get(uid!) : undefined;
  return Promise.resolve({
    docs: [...(col ?? new Map()).entries()].map(([id, data]) => ({
      id,
      ref: { path: `${colRef.path}/${id}` },
      data: () => data,
    })),
  });
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  {
    const fs = await import('firebase/firestore');
    vi.mocked(fs.writeBatch).mockImplementation(defaultWriteBatch as never);
    vi.mocked(fs.runTransaction).mockImplementation(defaultRunTransaction as never);
    vi.mocked(fs.getDocsFromServer).mockImplementation(defaultGetDocsFromServer as never);
  }
  bundle ??= await createKeyBundle(UID, OLD_PASS, 100_000);
  state.accounts.clear();
  state.sealed.clear();
  state.sealedMarks.clear();
  state.decrypted.clear();
  state.deviceKeys.clear();
  state.storage.clear();
  state.metaDocs.clear();
  state.medDocs.clear();
  state.logDocs.clear();
  state.metaListeners.clear();
  state.medListeners.clear();
  state.logListeners.clear();

  fakeDoc = createFakeDoc();
  const rootDiv = fakeDoc.createElement('div');
  rootDiv.setAttribute('id', 'root');
  fakeDoc.body.appendChild(rootDiv);

  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('document', fakeDoc);
  vi.stubGlobal('addEventListener', () => {});
  vi.stubGlobal('removeEventListener', () => {});
  vi.stubGlobal('dispatchEvent', () => true);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('HTMLElement', function () {});
  vi.stubGlobal('HTMLIFrameElement', function () {});
  vi.stubGlobal('Element', function () {});
  vi.stubGlobal('Node', function () {});
  vi.stubGlobal('location', { search: '', pathname: '/', hostname: 'localhost', protocol: 'http:', reload: vi.fn() });
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'node', platform: 'Win32', maxTouchPoints: 0 });
  vi.stubGlobal('localStorage', {
    get length() {
      return state.storage.size;
    },
    key: (i: number) => [...state.storage.keys()][i] ?? null,
    getItem: (k: string) => state.storage.get(k) ?? null,
    setItem: (k: string, v: string) => void state.storage.set(k, String(v)),
    removeItem: (k: string) => void state.storage.delete(k),
  });
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Issue #11: failed final meta transaction in prepareReset().finish() keeps key consistent with unlocked status', () => {
  it('directly on startSync: restores dek/dekKeyId so dataKey() stays non-null with old keyId and forgetKey() calls sealLocal', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await encryptedAccount([sampleMed()], []);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');

    const fs = await import('firebase/firestore');
    let txCall = 0;
    vi.mocked(fs.runTransaction).mockImplementation((db, fn) => {
      txCall++;
      // Only the final meta transaction (2nd call) rejects; the 1st writes resetting: true without
      // delivering a server meta snapshot to onMeta, so lock remains 'unlocked'.
      if (txCall === 2) {
        return Promise.reject(Object.assign(new Error('network error'), { code: 'unavailable' }));
      }
      return defaultRunTransaction(db, fn as (tx: unknown) => Promise<unknown>) as ReturnType<typeof fs.runTransaction>;
    });

    const { startSync } = await import('./sync');
    let local: AppData = { version: 1, medications: [sampleMed()], doseLogs: [] };
    let latestStatus: import('./sync').SyncStatus | null = null;
    const status = (): import('./sync').SyncStatus | null => latestStatus;
    const sealLocal = vi.fn(async (_k: CryptoKey, _keyId: string, opts?: { onSealed?: () => Promise<void> }) => {
      await opts?.onSealed?.();
    });

    const handle = startSync({
      uid: UID,
      getLocal: () => local,
      applyRemote: (d) => {
        local = d;
      },
      onStatus: (s) => {
        latestStatus = s;
      },
      sealLocal,
    });

    try {
      await until(() => status()?.lock === 'unlocked' && status()?.cloudLoaded === true);

      const prepared = await handle.prepareReset(NEW_PASS);
      const finishOutcome = captureOutcome(prepared.finish());

      await until(() => state.metaDocs.get(UID)?.resetting === true);
      await vi.advanceTimersByTimeAsync(2100);

      const outcome = await finishOutcome;
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) expect((outcome.error as Error).message).toContain('network error');

      expect(status()?.lock).toBe('unlocked');
      expect(handle.dataKey()).not.toBeNull();
      expect(handle.dataKey()?.keyId).toBe(bundle.meta.keyId);

      await handle.forgetKey();
      expect(sealLocal).toHaveBeenCalledTimes(1);
      expect(sealLocal.mock.calls[0]?.[1]).toBe(bundle.meta.keyId);
    } finally {
      handle.stop();
    }
  });

  it('through useAppData: after finish() rejects, lock stays unlocked, dataKey() keeps old keyId, and forgetKey() seals local copy', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await encryptedAccount([sampleMed()], []);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });

    const { useAppData } = await import('./store');
    const ref: { api: ReturnType<typeof useAppData> | null } = { api: null };
    function Probe() {
      ref.api = useAppData(USER_ID, UID);
      return null;
    }
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(React.createElement(Probe)));
    await until(() => !!ref.api?.loaded && ref.api?.syncStatus?.lock === 'unlocked' && ref.api?.syncStatus?.cloudLoaded === true);

    const fs = await import('firebase/firestore');
    const localDb = await import('./localDb');
    let txCall = 0;
    vi.mocked(fs.runTransaction).mockImplementation((db, fn) => {
      txCall++;
      if (txCall === 2) {
        return Promise.reject(Object.assign(new Error('network error'), { code: 'unavailable' }));
      }
      return defaultRunTransaction(db, fn as (tx: unknown) => Promise<unknown>) as ReturnType<typeof fs.runTransaction>;
    });

    const prepared = await ref.api!.syncControls!.prepareReset(NEW_PASS);
    const finishOutcome = captureOutcome(prepared.finish());

    await until(() => state.metaDocs.get(UID)?.resetting === true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2100);
    });

    const outcome = await finishOutcome;
    expect(outcome.ok).toBe(false);

    expect(ref.api!.syncStatus?.lock).toBe('unlocked');
    expect(ref.api!.syncControls!.dataKey()?.keyId).toBe(bundle.meta.keyId);

    await act(async () => {
      await ref.api!.syncControls!.forgetKey();
    });
    expect(vi.mocked(localDb.storeSealed)).toHaveBeenCalled();
    expect(vi.mocked(localDb.storeSealed).mock.calls[0]?.[1]).toBe(bundle.meta.keyId);
    expect(state.sealedMarks.has(USER_ID)).toBe(true);
  });
});
