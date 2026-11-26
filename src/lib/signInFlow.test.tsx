// Regression tests for sign-in, redirect, error, cross-tab sign-out, and account-deleted flows
// in App + SignInScreen (#4, #5, #6, #7, #12, #13).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { createKeyBundle, encryptLog, encryptMed, unlockWithPassphrase, type KeyBundle } from './syncCrypto';
import { logDocId } from './syncOps';

// ---------- minimal DOM + Web API shim for React 19 in Node ----------

interface FakeEl {
  nodeType: number;
  tagName: string;
  nodeName: string;
  id: string;
  className: string;
  childNodes: FakeNode[];
  children: FakeEl[];
  style: Record<string, string> & { setProperty(k: string, v: string): void; removeProperty(k: string): void };
  dataset: Record<string, string>;
  ownerDocument: FakeDoc;
  parentNode: FakeNode | null;
  offsetParent: object | null;
  _attrs: Map<string, string>;
  _listeners: Map<string, Set<(e: unknown) => void>>;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | null;
  removeAttribute(k: string): void;
  hasAttribute(k: string): boolean;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  removeEventListener(t: string, fn: (e: unknown) => void): void;
  dispatchEvent(ev: Record<string, unknown>): boolean;
  click(): void;
  focus(): void;
  contains(other: FakeNode | null): boolean;
  querySelectorAll(sel: string): FakeEl[];
  querySelector(sel: string): FakeEl | null;
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
  activeElement: FakeEl | null;
  _listeners: Map<string, Set<(e: unknown) => void>>;
  createElement(tag: string): FakeEl;
  createElementNS(ns: string, tag: string): FakeEl;
  createTextNode(t: string): FakeNode;
  createComment(t: string): FakeNode;
  addEventListener(t: string, fn: (e: unknown) => void): void;
  removeEventListener(t: string, fn: (e: unknown) => void): void;
  getElementById(id: string): FakeEl | null;
  querySelectorAll(sel: string): FakeEl[];
  querySelector(sel: string): FakeEl | null;
}

function walkEls(node: FakeNode, pred: (el: FakeEl) => boolean, out: FakeEl[] = []): FakeEl[] {
  if (node.nodeType === 1) {
    const el = node as FakeEl;
    if (pred(el)) out.push(el);
    for (const c of el.childNodes) walkEls(c, pred, out);
  }
  return out;
}

function matchesSimple(el: FakeEl, sel: string): boolean {
  if (sel.startsWith('.')) return el.className.split(/\s+/).includes(sel.slice(1));
  if (sel.startsWith('#')) return el.id === sel.slice(1);
  return el.tagName.toLowerCase() === sel.toLowerCase();
}

function makeEl(tag: string, doc: FakeDoc): FakeEl {
  const el: FakeEl = {
    nodeType: 1,
    tagName: tag.toUpperCase(),
    nodeName: tag.toUpperCase(),
    id: '',
    className: '',
    childNodes: [],
    get children() {
      return el.childNodes.filter((c): c is FakeEl => c.nodeType === 1);
    },
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
    offsetParent: {},
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
    hasAttribute(k) {
      return el._attrs.has(k);
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
      let cur: FakeNode | null = el;
      while (cur) {
        ev.currentTarget = cur;
        const map = (cur as FakeEl)._listeners;
        if (map) {
          for (const fn of [...(map.get(ev.type as string) ?? [])]) fn.call(cur, ev);
        }
        cur = cur.parentNode;
      }
      if (ev.bubbles) {
        ev.currentTarget = doc;
        for (const fn of [...(doc._listeners.get(ev.type as string) ?? [])]) fn.call(doc, ev);
      }
      return true;
    },
    click() {
      el.dispatchEvent({
        type: 'click',
        bubbles: true,
        cancelable: true,
        preventDefault() {},
        stopPropagation() {},
      });
    },
    focus() {
      doc.activeElement = el;
    },
    contains(other) {
      let c = other;
      while (c) {
        if (c === el) return true;
        c = c.parentNode;
      }
      return false;
    },
    querySelectorAll(sel) {
      const parts = sel.split(',').map((s) => s.trim());
      return walkEls(el, (n) => parts.some((p) => matchesSimple(n, p))).filter((n) => n !== el);
    },
    querySelector(sel) {
      return el.querySelectorAll(sel)[0] ?? null;
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
    activeElement: null,
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
    querySelectorAll(sel) {
      const parts = sel.split(',').map((s) => s.trim());
      return walkEls(doc.documentElement, (el) => parts.some((p) => matchesSimple(el, p)));
    },
    querySelector(sel) {
      return doc.querySelectorAll(sel)[0] ?? null;
    },
  };
  doc.documentElement = makeEl('html', doc);
  doc.head = makeEl('head', doc);
  doc.body = makeEl('body', doc);
  doc.documentElement.appendChild(doc.head);
  doc.documentElement.appendChild(doc.body);
  return doc;
}

// ---------- hoisted in-memory backends ----------

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
  authListeners: new Set<(user: { id: string; name: string; email?: string; provider: 'google' | 'guest' } | null) => void>(),
}));

vi.mock('./localDb', async (importOriginal) => {
  const real = await importOriginal<typeof import('./localDb')>();
  const clone = <T,>(v: T): T => structuredClone(v);
  const empty = (): AppData => ({ version: 1, medications: [], doseLogs: [] });
  const dropSealed = (userId: string) => {
    for (const k of [...state.sealed.keys()]) if (k.startsWith(`${userId}|`)) state.sealed.delete(k);
  };
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
    deleteAccount: vi.fn(async (userId: string, opts: { keepSealed?: boolean } = {}) => {
      state.accounts.delete(userId);
      if (!opts.keepSealed) {
        dropSealed(userId);
        state.sealedMarks.delete(userId);
      }
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
        return () => {};
      }
      return () => {};
    }),
    writeBatch: vi.fn(() => ({ set: vi.fn(), delete: vi.fn(), commit: vi.fn(async () => {}) })),
    waitForPendingWrites: vi.fn(async () => {}),
    runTransaction: vi.fn(async () => {}),
    setDoc: vi.fn(async () => {}),
    getDocFromServer: vi.fn(async () => ({ exists: () => false, data: () => undefined })),
    deleteDoc: vi.fn(async () => {}),
    getDocsFromServer: vi.fn(async () => ({ docs: [] })),
  };
});

vi.mock('./auth', async (importOriginal) => {
  const real = await importOriginal<typeof import('./auth')>();
  return {
    ...real,
    FIREBASE_CONFIGURED: true,
    getFirebaseApp: vi.fn(async () => ({ app: {}, auth: {} })),
    preloadFirebaseAuth: vi.fn(async () => {}),
    completeRedirectSignIn: vi.fn(async () => null),
    signInWithGoogle: vi.fn(async () => null),
    currentGoogleUser: vi.fn(async () => null),
    reauthenticateForDeletion: vi.fn(real.reauthenticateForDeletion),
    deleteFirebaseUser: vi.fn(real.deleteFirebaseUser),
    watchAuth: vi.fn((cb: (user: import('./auth').User | null) => void) => {
      state.authListeners.add(cb);
      return () => state.authListeners.delete(cb);
    }),
    signOut: vi.fn(async (user: import('./auth').User) => {
      real.clearSession();
      if (user.provider === 'google') for (const cb of [...state.authListeners]) cb(null);
    }),
  };
});

vi.mock('./account', async (importOriginal) => {
  const real = await importOriginal<typeof import('./account')>();
  return {
    ...real,
    finishDeletionBeforeReuse: vi.fn(real.finishDeletionBeforeReuse),
    wipeAfterAccountDeleted: vi.fn(real.wipeAfterAccountDeleted),
    finishInterruptedDeletions: vi.fn(real.finishInterruptedDeletions),
    deleteAccount: vi.fn(real.deleteAccount),
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

vi.mock('./drugLookup', () => ({ clearDrugInfoCache: vi.fn() }));

// ---------- test helpers ----------

const UID = 'u1';
const USER_ID = `firebase:${UID}`;
const PASS = 'correct horse battery staple';
const GOOGLE_USER = { id: USER_ID, name: 'Ada Lovelace', email: 'ada@example.com', provider: 'google' as const };

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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

let fakeDoc: FakeDoc;
let root: Root | null = null;
let bundle: KeyBundle;

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await settle(1);
  await settle(2);
}

const text = () => fakeDoc.body.textContent;
const buttons = (label: string) => walkEls(fakeDoc.documentElement, (el) => el.tagName === 'BUTTON' && el.textContent.trim() === label);
const buttonsContaining = (part: string) => walkEls(fakeDoc.documentElement, (el) => el.tagName === 'BUTTON' && el.textContent.includes(part));

async function click(el: FakeEl | undefined) {
  expect(el).toBeDefined();
  await act(async () => el!.click());
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
  state.deviceKeys.set(UID, { key: await unlockWithPassphrase(bundle.meta, UID, PASS), keyId: bundle.meta.keyId });
}

function signedIn(user: { id: string } = GOOGLE_USER) {
  state.storage.set('medtracker.session', JSON.stringify(user));
}

function markDeleted(userId: string) {
  const cur = JSON.parse(state.storage.get('medtracker.deletedAccounts') ?? '{}') as Record<string, unknown>;
  cur[userId] = { mark: `del-${userId}`, at: Date.now(), wiped: true };
  state.storage.set('medtracker.deletedAccounts', JSON.stringify(cur));
}

async function pushMeta(data: Record<string, unknown> | undefined, fromCache = false) {
  if (data) state.metaDocs.set(UID, data);
  else state.metaDocs.delete(UID);
  const snap = { exists: () => data !== undefined, data: () => data, metadata: { fromCache, hasPendingWrites: false } };
  for (const cb of [...state.metaListeners]) await act(async () => cb(snap));
  await settle(4);
}

async function mountApp() {
  const { default: App } = await import('../App');
  root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
  await act(async () => root!.render(React.createElement(App)));
  await settle();
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  bundle ??= await createKeyBundle(UID, PASS, 100_000);
  state.accounts.clear();
  state.sealed.clear();
  state.sealedMarks.clear();
  state.decrypted.clear();
  state.deviceKeys.clear();
  state.storage.clear();
  state.metaDocs.clear();
  state.medDocs.clear();
  state.logDocs.clear();
  state.authListeners.clear();
  state.metaListeners.clear();

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
  vi.stubGlobal('history', { replaceState: vi.fn() });
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
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
  vi.unstubAllGlobals();
});

// ---------- tests ----------

describe('#4 deleted-account reuse wait, cancel, and stale signInSeq', () => {
  it('4(a): shows waiting status + Cancel and disables buttons while finishDeletionBeforeReuse is pending, then shows guest tracker on resolve(true)', async () => {
    markDeleted('guest');
    const account = await import('./account');
    const wait = deferred<boolean>();
    vi.mocked(account.finishDeletionBeforeReuse).mockReturnValueOnce(wait.promise);

    await mountApp();
    await click(buttons('Continue without an account')[0]);

    expect(account.finishDeletionBeforeReuse).toHaveBeenCalledWith('guest');
    const statusEls = walkEls(fakeDoc.documentElement, (el) => el.getAttribute('role') === 'status');
    expect(statusEls.some((el) => el.textContent.includes("Removing this account's old data from this device before starting over…"))).toBe(true);
    expect(buttons('Cancel')).toHaveLength(1);
    expect(buttons('Continue without an account')[0]!.hasAttribute('disabled')).toBe(true);
    expect(buttonsContaining('Sign in with Google')[0]!.hasAttribute('disabled')).toBe(true);

    await act(async () => wait.resolve(true));
    await until(() => text().includes('Add your first medication'));
    expect(text()).toContain('Add your first medication');
    expect(text()).not.toContain('Continue without an account');
  });

  it('4(b): cancelling while waiting stays on sign-in screen even after finishDeletionBeforeReuse resolves true', async () => {
    markDeleted('guest');
    const account = await import('./account');
    const wait = deferred<boolean>();
    vi.mocked(account.finishDeletionBeforeReuse).mockReturnValueOnce(wait.promise);

    await mountApp();
    await click(buttons('Continue without an account')[0]);
    expect(buttons('Cancel')).toHaveLength(1);

    await click(buttons('Cancel')[0]);
    expect(text()).not.toContain("Removing this account's old data");
    expect(buttons('Continue without an account')[0]!.hasAttribute('disabled')).toBe(false);
    expect(buttonsContaining('Sign in with Google')[0]!.hasAttribute('disabled')).toBe(false);

    await act(async () => wait.resolve(true));
    await settle(6);

    expect(text()).toContain('Continue without an account');
    expect(text()).toContain('Sign in with Google');
    expect(text()).not.toContain('Add your first medication');
    expect(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('role') === 'alert')).toHaveLength(0);
  });

  it('4(c): a second sign-in choice (Google) shown after cancelling is not replaced when the first deleted-guest wait resolves later', async () => {
    markDeleted('guest');
    const account = await import('./account');
    const auth = await import('./auth');
    const guestWait = deferred<boolean>();
    vi.mocked(account.finishDeletionBeforeReuse).mockReturnValueOnce(guestWait.promise);
    vi.mocked(auth.signInWithGoogle).mockResolvedValueOnce(GOOGLE_USER);

    await encryptedAccount([sampleMed()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });

    await mountApp();
    await click(buttons('Continue without an account')[0]);
    await click(buttons('Cancel')[0]);
    await click(buttonsContaining('Sign in with Google')[0]);

    await until(() => text().includes('Lisinopril'));
    expect(text()).toContain('Lisinopril');
    expect(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('aria-label') === `Account: ${GOOGLE_USER.name}`)).toHaveLength(1);

    await act(async () => guestWait.resolve(true));
    await settle(6);

    expect(text()).toContain('Lisinopril');
    expect(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('aria-label') === `Account: ${GOOGLE_USER.name}`)).toHaveLength(1);
    expect(text()).not.toContain('Account: Guest');
  });
});

describe('#5 redirect sign-in for deleted account with signing-out marker and choice race', () => {
  it('5(a): deleted account + fresh signing-out marker from another tab calls finishDeletionBeforeReuse and shows the account once it resolves true', async () => {
    markDeleted(USER_ID);
    state.storage.set(`medtracker.signingOut.${USER_ID}`, JSON.stringify({ userId: USER_ID, at: Date.now(), tab: 'other-tab' }));

    const account = await import('./account');
    const auth = await import('./auth');
    const wait = deferred<boolean>();
    vi.mocked(account.finishDeletionBeforeReuse).mockReturnValueOnce(wait.promise);
    vi.mocked(auth.completeRedirectSignIn).mockResolvedValueOnce(GOOGLE_USER);

    await mountApp();
    await until(() => vi.mocked(account.finishDeletionBeforeReuse).mock.calls.length > 0);
    expect(account.finishDeletionBeforeReuse).toHaveBeenCalledWith(USER_ID);
    expect(text()).toContain("Removing this account's old data from this device before signing in…");

    await act(async () => wait.resolve(true));
    await until(() => text().includes('Add your first medication'));
    expect(text()).toContain('Add your first medication');
    expect(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('aria-label') === `Account: ${GOOGLE_USER.name}`)).toHaveLength(1);
  });

  it('5(b): clicking Continue without an account before completeRedirectSignIn resolves with a deleted Google user keeps guest shown', async () => {
    markDeleted(USER_ID);
    const account = await import('./account');
    const auth = await import('./auth');
    const redirect = deferred<typeof GOOGLE_USER | null>();
    vi.mocked(auth.completeRedirectSignIn).mockReturnValueOnce(redirect.promise);

    await mountApp();
    await click(buttons('Continue without an account')[0]);
    await until(() => text().includes('Add your first medication'));

    await act(async () => redirect.resolve(GOOGLE_USER));
    await settle(6);

    expect(account.finishDeletionBeforeReuse).not.toHaveBeenCalled();
    expect(text()).toContain('Add your first medication');
    expect(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('aria-label') === 'Account: Guest')).toHaveLength(1);
    expect(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('aria-label') === `Account: ${GOOGLE_USER.name}`)).toHaveLength(0);
  });
});

describe('#6 authError object identity and clearing on sign-in', () => {
  it('6(a): re-shows identical error text after the screen error is cleared in between', async () => {
    markDeleted('guest');
    const account = await import('./account');
    const auth = await import('./auth');
    vi.mocked(account.finishDeletionBeforeReuse).mockResolvedValueOnce(false).mockResolvedValueOnce(false);
    vi.mocked(auth.signInWithGoogle).mockResolvedValueOnce(null);

    await mountApp();
    await click(buttons('Continue without an account')[0]);
    const expectedMsg = "Amendra couldn't finish removing this account's old data from this device.";
    expect(text()).toContain(expectedMsg);

    // Tapping Sign in with Google clears SignInScreen's local error state and returns null (cancelled).
    await click(buttonsContaining('Sign in with Google')[0]);
    expect(text()).not.toContain(expectedMsg);
    expect(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('role') === 'alert')).toHaveLength(0);

    // Second identical failure delivers a fresh { message } object, so the error is shown again.
    await click(buttons('Continue without an account')[0]);
    expect(text()).toContain(expectedMsg);
    expect(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('role') === 'alert').some((el) => el.textContent.includes(expectedMsg))).toBe(true);
  });

  it('6(b): clears authError when a subsequent sign-in succeeds, so signing out back to SignInScreen does not show the old error', async () => {
    markDeleted('guest');
    const account = await import('./account');
    vi.mocked(account.finishDeletionBeforeReuse).mockResolvedValueOnce(false).mockResolvedValueOnce(true);

    await mountApp();
    await click(buttons('Continue without an account')[0]);
    const expectedMsg = "Amendra couldn't finish removing this account's old data from this device.";
    expect(text()).toContain(expectedMsg);

    await click(buttons('Continue without an account')[0]);
    await until(() => text().includes('Add your first medication'));

    await click(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('aria-label') === 'Account: Guest')[0]);
    await click(buttonsContaining('Sign in with Google')[0]);
    await until(() => text().includes('Continue without an account'));

    expect(text()).not.toContain(expectedMsg);
    expect(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('role') === 'alert')).toHaveLength(0);
  });
});

describe('#7 leaveFor synchronous whenSignOutEnds callback', () => {
  it('reloads when another tab posts signing-out with no marker present in localStorage', async () => {
    await encryptedAccount([sampleMed()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn(GOOGLE_USER);

    await mountApp();
    await until(() => text().includes('Lisinopril'));
    expect(location.reload).not.toHaveBeenCalled();

    const ch = new BroadcastChannel('medtracker-session');
    try {
      ch.postMessage({ type: 'signing-out', userId: USER_ID });
      await until(() => vi.mocked(location.reload).mock.calls.length > 0);
    } finally {
      ch.close();
    }

    expect(location.reload).toHaveBeenCalledTimes(1);
  });
});

describe('#12 App Tracker onEnded session guard and #13 wipeAfterAccountDeleted notice', () => {
  it('12: ignores late onEnded from a previous session after a different account (guest) is shown', async () => {
    await encryptedAccount([sampleMed()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn(GOOGLE_USER);

    const account = await import('./account');
    const wipe = deferred<{ problem?: string }>();
    vi.mocked(account.wipeAfterAccountDeleted).mockReturnValueOnce(wipe.promise);

    await mountApp();
    await until(() => text().includes('Lisinopril') && state.metaListeners.size === 1);

    // Trigger Tracker's onAccountDeleted -> wipeAfterAccountDeleted(GOOGLE_USER) is now pending.
    await pushMeta({ v: 1, deleted: true, phase: 'done', done: true, at: Date.now() });
    expect(account.wipeAfterAccountDeleted).toHaveBeenCalledWith(GOOGLE_USER);

    // Meanwhile another tab marks the Google account deleted, returning this tab to SignInScreen.
    markDeleted(USER_ID);
    const session = await import('./session');
    await act(async () => session.checkDeletedElsewhere());
    await until(() => text().includes('Continue without an account'));

    // User starts a guest session.
    await click(buttons('Continue without an account')[0]);
    await until(() => text().includes('Add your first medication'));

    // Late wipe result from the previous Google session resolves: must not end the guest session.
    await act(async () => wipe.resolve({ problem: 'Stale problem from previous session' }));
    await settle(6);

    expect(text()).toContain('Add your first medication');
    expect(text()).not.toContain('Stale problem from previous session');
    expect(text()).not.toContain('Continue without an account');
  });

  it('13(a): shows wipeAfterAccountDeleted {problem} as the notice on SignInScreen when onAccountDeleted fires', async () => {
    await encryptedAccount([sampleMed()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn(GOOGLE_USER);

    const account = await import('./account');
    const problem =
      "Your data was deleted, but your sign-in account couldn't be removed yet (requires-recent-login). To finish, sign in with Google again: it's removed then.";
    vi.mocked(account.wipeAfterAccountDeleted).mockResolvedValueOnce({ problem });

    await mountApp();
    await until(() => text().includes('Lisinopril') && state.metaListeners.size === 1);

    await pushMeta({ v: 1, deleted: true, phase: 'done', done: true, at: Date.now() });
    await until(() => text().includes('Sign in with Google'));

    expect(text()).toContain("sign-in account couldn't be removed yet");
    expect(text()).toContain(problem);
  });

  it('13(b): shows fallback device-removal notice when wipeAfterAccountDeleted rejects', async () => {
    await encryptedAccount([sampleMed()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn(GOOGLE_USER);

    const account = await import('./account');
    vi.mocked(account.wipeAfterAccountDeleted).mockRejectedValueOnce(new Error('IndexedDB failed'));

    await mountApp();
    await until(() => text().includes('Lisinopril') && state.metaListeners.size === 1);

    await pushMeta({ v: 1, deleted: true, phase: 'done', done: true, at: Date.now() });
    await until(() => text().includes('Sign in with Google'));

    expect(text()).toContain("Some of its data couldn't be removed from this device yet.");
  });
});
