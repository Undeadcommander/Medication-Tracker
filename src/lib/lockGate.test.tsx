// Regression tests: an account with end-to-end encrypted sync shows (and lets anything use) its
// medications only once it's unlocked on this device, and a locked device keeps its copy encrypted.
// Drives the real App and store against in-memory stand-ins for IndexedDB, the device key store,
// Firestore, Firebase Auth and the reminder service.
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


// ---------- hoisted in-memory backends for localDb, keyStore, Firestore, Auth, push ----------

const state = vi.hoisted(() => ({
  accounts: new Map<string, AppData>(),
  /** Encrypted copies of locked accounts, by `${userId}|${keyId}`. */
  sealed: new Map<string, unknown>(),
  /** Accounts whose local copy is marked sealed (readable writes refused, see localDb storeSealed). */
  sealedMarks: new Set<string>(),
  /** Errors the next `meta/crypto` listeners fail with (one per listener), instead of a snapshot. */
  metaErrors: [] as { code?: string; message?: string }[],
  decrypted: new Map<string, Map<string, unknown>>(),
  deviceKeys: new Map<string, { key: CryptoKey; keyId: string }>(),
  storage: new Map<string, string>(),
  metaDocs: new Map<string, Record<string, unknown>>(),
  /** How `meta/crypto` arrives: from the server, from the offline cache, or not at all (offline, not cached). */
  metaMode: 'server' as 'server' | 'cache' | 'cache-miss',
  medDocs: new Map<string, Map<string, Record<string, unknown>>>(),
  logDocs: new Map<string, Map<string, Record<string, unknown>>>(),
  /** Uploads never get an answer (offline): queued changes stay queued. */
  commitHangs: false,
  /** Listeners on `meta/crypto`, to send later snapshots (see pushMeta). */
  metaListeners: new Set<(s: unknown) => void>(),
  /** Error callbacks of the live `meta/crypto` listeners (see failMeta). */
  metaErrorListeners: new Set<(e: unknown) => void>(),
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
      // Like the real one: only if the readable copy is still what was encrypted.
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
    onSnapshot: vi.fn((ref: { path: string }, _opts: unknown, onNext: (s: unknown) => void, onError?: (e: unknown) => void) => {
      const parts = ref.path.split('/');
      const uid = parts[1]!;
      if (parts.length === 4 && parts[2] === 'meta' && parts[3] === 'crypto') {
        const failure = state.metaErrors.shift();
        if (failure) {
          queueMicrotask(() => onError?.(Object.assign(new Error(failure.message ?? 'failed'), failure)));
          return () => {};
        }
        const data = state.metaMode === 'cache-miss' ? undefined : state.metaDocs.get(uid);
        const fromCache = state.metaMode !== 'server';
        queueMicrotask(() =>
          onNext({ exists: () => data !== undefined, data: () => data, metadata: { fromCache, hasPendingWrites: false } }),
        );
        state.metaListeners.add(onNext);
        if (onError) state.metaErrorListeners.add(onError);
        return () => {
          state.metaListeners.delete(onNext);
          if (onError) state.metaErrorListeners.delete(onError);
        };
      }
      if (parts.length === 3 && (parts[2] === 'meds' || parts[2] === 'logs')) {
        const col = parts[2] === 'meds' ? state.medDocs.get(uid) : state.logDocs.get(uid);
        const changes = [...(col ?? new Map()).entries()].map(([id, data]) => ({ type: 'added', doc: { id, data: () => data } }));
        const fromCache = state.metaMode !== 'server';
        queueMicrotask(() => onNext({ docChanges: () => changes, metadata: { fromCache, hasPendingWrites: false } }));
        return () => {};
      }
      return () => {};
    }),
    writeBatch: vi.fn(() => ({
      set: vi.fn(),
      delete: vi.fn(),
      commit: vi.fn(() => (state.commitHangs ? new Promise(() => {}) : Promise.resolve())),
    })),
    waitForPendingWrites: vi.fn(async () => {}),
    // Writes of the encryption settings (setup, reset): kept in metaDocs, which later listeners read.
    runTransaction: vi.fn(async (_db: unknown, fn: (tx: unknown) => Promise<unknown>) => {
      const uidOf = (ref: { path: string }) => ref.path.split('/')[1]!;
      return fn({
        get: async (ref: { path: string }) => {
          const d = state.metaDocs.get(uidOf(ref));
          return { exists: () => d !== undefined, data: () => d };
        },
        set: (ref: { path: string }, data: Record<string, unknown>) => void state.metaDocs.set(uidOf(ref), data),
      });
    }),
    setDoc: vi.fn(async (ref: { path: string }, data: Record<string, unknown>) => {
      const parts = ref.path.split('/');
      if (parts[2] === 'meta') state.metaDocs.set(parts[1]!, data);
    }),
    getDocFromServer: vi.fn(async (ref: { path: string }) => {
      const parts = ref.path.split('/');
      const d = parts[2] === 'meta' ? state.metaDocs.get(parts[1]!) : undefined;
      return { exists: () => d !== undefined, data: () => d };
    }),
    deleteDoc: vi.fn(async (ref: { path: string }) => {
      const parts = ref.path.split('/');
      if (parts[2] === 'meta') state.metaDocs.delete(parts[1]!);
    }),
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
    completeRedirectSignIn: vi.fn(async () => {}),
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

const push = vi.hoisted(() => ({
  claimPendingTakes: vi.fn(async (_match: (t: { medId: string }) => boolean) => [] as { medId: string; scheduledFor: string; at: number }[]),
  syncReminders: vi.fn(async (_meds: Medication[], _logs: DoseLog[], _opts?: unknown) => ({ count: 0, mode: 'off' as const })),
  stopLocalReminders: vi.fn(),
  forgetReminderState: vi.fn(),
  disablePush: vi.fn(async () => {}),
}));

vi.mock('./push', () => ({
  claimPendingTakes: push.claimPendingTakes,
  getPushState: vi.fn(async () => 'granted'),
  onPendingTakesChange: vi.fn(() => () => {}),
  onServiceWorkerMessage: vi.fn(() => () => {}),
  pendingTakeCount: vi.fn(() => 0),
  queuePendingTake: vi.fn(async () => {}),
  registerServiceWorker: vi.fn(),
  stopLocalReminders: push.stopLocalReminders,
  syncReminders: push.syncReminders,
  disablePush: push.disablePush,
  forgetReminderState: push.forgetReminderState,
}));

const drug = vi.hoisted(() => ({ clearDrugInfoCache: vi.fn() }));
vi.mock('./drugLookup', () => ({ clearDrugInfoCache: drug.clearDrugInfoCache }));

// The passphrase strength check can be made to fail to load (see "sync refuses passphrases it could not rate").
const strengthCtl = vi.hoisted(() => ({ unavailable: false }));
vi.mock('./vault', async (importOriginal) => {
  const real = await importOriginal<typeof import('./vault')>();
  return {
    ...real,
    estimatePassphraseStrength: (p: string) =>
      strengthCtl.unavailable ? Promise.reject(new Error('Failed to fetch dynamically imported module')) : real.estimatePassphraseStrength(p),
  };
});

// ---------- test helpers ----------

const UID = 'u1';
const USER_ID = `firebase:${UID}`;
const PASS = 'correct horse battery staple';
const GOOGLE_USER = { id: USER_ID, name: 'Ada Lovelace', email: 'ada@example.com', provider: 'google' as const };
const GUEST = { id: 'guest', name: 'Guest', provider: 'guest' as const };

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

const recentLog = (over: Partial<DoseLog> = {}): DoseLog => {
  const at = new Date(Date.now() - 3_600_000).toISOString();
  return { id: 'l1', medId: 'm1', scheduledFor: at, status: 'taken', loggedAt: at, ...over };
};

let fakeDoc: FakeDoc;
let root: Root | null = null;

async function settle(rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 15));
    });
  }
}

/** Wait (up to a few seconds, for slow machines) until `cond` holds, then let things settle. */
async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await settle(1);
  await settle(2);
}

const text = () => fakeDoc.body.textContent;
const buttons = (label: string) => walkEls(fakeDoc.documentElement, (el) => el.tagName === 'BUTTON' && el.textContent.trim() === label);
const buttonsContaining = (part: string) => walkEls(fakeDoc.documentElement, (el) => el.tagName === 'BUTTON' && el.textContent.includes(part));

/** React's props for a rendered element (to fire onChange/onSubmit, which the shim's events don't reach). */
function reactProps(el: FakeEl): Record<string, (e: unknown) => void> {
  const k = Object.keys(el).find((key) => key.startsWith('__reactProps$'));
  if (!k) throw new Error(`no React props on ${el.tagName}`);
  return (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[k]!;
}

async function click(el: FakeEl | undefined) {
  expect(el).toBeDefined();
  await act(async () => el!.click());
  await settle(2);
}

/** Type the sync passphrase into the unlock screen and submit it. */
async function unlockWith(passphrase: string) {
  const input = walkEls(fakeDoc.documentElement, (el) => el.tagName === 'INPUT')[0]; // the only field: the passphrase
  expect(input).toBeDefined();
  await act(async () => reactProps(input!).onChange({ target: { value: passphrase } }));
  const form = walkEls(fakeDoc.documentElement, (el) => el.tagName === 'FORM')[0]!;
  await act(async () => reactProps(form).onSubmit({ preventDefault() {} }));
  await until(() => !text().includes('Unlock cloud sync'));
  await settle(4);
}

async function openEncryptionSettings() {
  await click(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('aria-label') === `Account: ${GOOGLE_USER.name}`)[0]);
  await click(buttonsContaining('Cloud encryption')[0]);
}

const queued = () => JSON.parse(state.storage.get(`medtracker.syncq.${UID}`) ?? '[]') as { ref: { kind: string; id: string } }[];
const loadedAccounts = async () => {
  const { loadAccount } = await import('./localDb');
  return vi.mocked(loadAccount).mock.calls.map(([id]) => id);
};
const remindedMeds = () => push.syncReminders.mock.calls.flatMap(([meds]) => meds.map((m) => m.name));

let bundle: KeyBundle;

/** An account with encrypted sync set up, whose cloud copy has `meds` (and `logs`). */
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

/** This device remembers the account's key (it was unlocked here before). */
async function rememberKey() {
  state.deviceKeys.set(UID, { key: await unlockWithPassphrase(bundle.meta, UID, PASS), keyId: bundle.meta.keyId });
}

function signedIn(user: { id: string } = GOOGLE_USER) {
  state.storage.set('medtracker.session', JSON.stringify(user));
}

async function mountApp() {
  const { default: App } = await import('../App');
  root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
  await act(async () => root!.render(React.createElement(App)));
  await settle();
}

/** The in-memory storeSealed, put back before each test (some tests make it fail or wait). */
let originalStoreSealed: ((...args: never[]) => unknown) | undefined;

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  {
    const { storeSealed } = await import('./localDb');
    originalStoreSealed ??= vi.mocked(storeSealed).getMockImplementation() as typeof originalStoreSealed;
    vi.mocked(storeSealed).mockImplementation(originalStoreSealed as never);
  }
  bundle ??= await createKeyBundle(UID, PASS, 100_000);
  state.accounts.clear();
  state.sealed.clear();
  state.sealedMarks.clear();
  state.metaErrors = [];
  state.decrypted.clear();
  state.deviceKeys.clear();
  state.storage.clear();
  state.metaDocs.clear();
  state.metaMode = 'server';
  state.medDocs.clear();
  state.logDocs.clear();
  state.commitHangs = false;
  state.authListeners.clear();
  state.metaListeners.clear();
  state.metaErrorListeners.clear();

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

describe('a locked encrypted account', () => {
  beforeEach(async () => {
    await encryptedAccount();
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog()] });
    signedIn();
  });

  it('shows only the unlock screen: no medications, and it cannot be dismissed', async () => {
    await mountApp();
    expect(text()).toContain('Unlock cloud sync');
    expect(text()).not.toContain('Lisinopril');
    expect(text()).not.toContain('Today');
    expect(text()).not.toContain('Your medications');
    expect(buttons('Not now')).toHaveLength(0);
    expect(buttons('Take')).toHaveLength(0);
    expect(buttons('Add medication')).toHaveLength(0);
    // Its data isn't even read from this device's storage.
    expect(await loadedAccounts()).not.toContain(USER_ID);
    // Signing out is still possible.
    expect(buttonsContaining('Sign out').length).toBeGreaterThan(0);
  });

  it("doesn't arm reminders, and stops any left from before", async () => {
    await mountApp();
    await settle(70); // past the reminder debounce
    expect(remindedMeds()).toEqual([]);
    expect(push.syncReminders).toHaveBeenCalledWith([], []); // server reminders cleared
    expect(push.stopLocalReminders).toHaveBeenCalled();
    expect(drug.clearDrugInfoCache).toHaveBeenCalled();
    // "Mark as taken" taps stay queued for once it's unlocked.
    expect(push.claimPendingTakes).not.toHaveBeenCalled();
  });

  it('offers no export or import of the data', async () => {
    await mountApp();
    const menuItems = () => walkEls(fakeDoc.documentElement, (el) => el.getAttribute('role') === 'menuitem');
    expect(menuItems()).toHaveLength(0);
    await click(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('aria-label') === `Account: ${GOOGLE_USER.name}`)[0]);
    // The menu really is open (its items are there), and it has no export, import or settings of the data.
    const labels = menuItems().map((el) => el.textContent);
    expect(labels.some((l) => l.includes('Sign out'))).toBe(true);
    expect(labels.some((l) => l.includes('Delete account'))).toBe(true);
    expect(labels.some((l) => l.includes('Export'))).toBe(false);
    expect(labels.some((l) => l.includes('Cloud encryption'))).toBe(false);
    expect(buttonsContaining('Export / import')).toHaveLength(0);
  });

  it('opens once unlocked with the passphrase', async () => {
    await mountApp();
    expect(text()).not.toContain('Lisinopril');
    await unlockWith(PASS);
    expect(text()).not.toContain('Unlock cloud sync');
    expect(text()).toContain('Lisinopril');
    expect(text()).toContain('Your medications (1)');
    await until(() => remindedMeds().includes('Lisinopril'));
    expect(remindedMeds()).toContain('Lisinopril');
  });

  it("removes this device's readable copy when it's all in the cloud (no key to encrypt it with)", async () => {
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.storage.set(`medtracker.e2ee.${UID}`, '1');
    await mountApp();
    expect(state.accounts.has(USER_ID)).toBe(false);
    // Unlocking brings it back from the cloud.
    await unlockWith(PASS);
    expect(text()).toContain('Lisinopril');
  });

  it("keeps a copy that isn't all in the cloud yet (unshown) until unlocked", async () => {
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed(), sampleMed({ id: 'm2', name: 'Atorvastatin' })], doseLogs: [] });
    await mountApp();
    expect(state.accounts.get(USER_ID)?.medications).toHaveLength(2);
    expect(text()).not.toContain('Atorvastatin');
    await unlockWith(PASS);
    expect(text()).toContain('Atorvastatin');
  });
});

describe('the store while locked', () => {
  it('rejects edits and imports, and keeps nothing in memory', async () => {
    await encryptedAccount();
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const { useAppData } = await import('./store');
    let api: ReturnType<typeof useAppData> | null = null;
    function Probe() {
      api = useAppData(USER_ID, UID);
      return null;
    }
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(React.createElement(Probe)));
    await settle();
    expect(api!.access).toBe('locked');
    expect(api!.loaded).toBe(false);
    expect(api!.data.medications).toEqual([]);
    expect(api!.getData().medications).toEqual([]);

    const before = structuredClone(state.accounts.get(USER_ID));
    await act(async () => {
      api!.replaceData({ version: 1, medications: [sampleMed({ id: 'm9', name: 'Injected' })], doseLogs: [] });
      api!.saveMedication(sampleMed({ id: 'm8', name: 'Added' }));
      api!.logDose('m1', recentLog().scheduledFor, 'taken');
      api!.deleteMedication('m1');
    });
    await settle(2);
    expect(state.accounts.get(USER_ID)).toEqual(before);
    expect(queued()).toEqual([]);
    expect(api!.data.medications).toEqual([]);
  });
});

describe('while checking whether the account is encrypted', () => {
  it('shows nothing of the data (offline, settings not cached here)', async () => {
    await encryptedAccount();
    state.metaMode = 'cache-miss';
    vi.stubGlobal('navigator', { onLine: false, userAgent: 'node', platform: 'Win32', maxTouchPoints: 0 });
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    expect(text()).toContain('Checking cloud sync');
    expect(text()).not.toContain('Lisinopril');
    expect(await loadedAccounts()).not.toContain(USER_ID);
  });

  it('stays closed offline for an account seen to be encrypted, though its settings are not cached', async () => {
    state.metaMode = 'cache-miss';
    state.storage.set(`medtracker.e2ee.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    expect(text()).toContain('Checking cloud sync');
    expect(text()).not.toContain('Lisinopril');
    expect(await loadedAccounts()).not.toContain(USER_ID);
  });

  it("an account seen to be encrypted whose settings the cloud says are gone: set up again first (needs-setup + marker on)", async () => {
    state.metaMode = 'server'; // the server confirms there's no meta/crypto
    state.storage.set(`medtracker.e2ee.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    expect(text()).toContain('Turn on encrypted sync');
    expect(text()).toContain('its encryption settings are missing from the cloud');
    expect(buttons('Not now')).toHaveLength(0);
    expect(text()).not.toContain('Lisinopril');
    expect(await loadedAccounts()).not.toContain(USER_ID);
    expect(state.storage.get(`medtracker.e2ee.${UID}`)).toBe('1'); // not turned off by the missing settings
  });
});

describe('accounts that can be opened', () => {
  it('guest: works as before, without any check', async () => {
    state.accounts.set('guest', { version: 1, medications: [sampleMed({ name: 'Metformin' })], doseLogs: [] });
    signedIn(GUEST);
    await mountApp();
    expect(text()).toContain('Metformin');
    expect(text()).not.toContain('Checking cloud sync');
    expect(buttons('Take').length).toBeGreaterThan(0);
  });

  it('encryption never set up (confirmed by the cloud): usable, and remembered for offline', async () => {
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    expect(text()).toContain('Lisinopril');
    expect(state.storage.get(`medtracker.e2ee.${UID}`)).toBe('0');
    // The setup suggestion can still be dismissed.
    await click(buttons('Not now')[0]);
    expect(text()).toContain('Lisinopril');
    expect(buttons('Take').length).toBeGreaterThan(0);

    // Offline next time, before the cloud can answer: still opens.
    await act(async () => root!.unmount());
    root = null;
    vi.resetModules();
    state.metaMode = 'cache-miss';
    vi.stubGlobal('navigator', { onLine: false, userAgent: 'node', platform: 'Win32', maxTouchPoints: 0 });
    fakeDoc.getElementById('root')!.childNodes = [];
    await mountApp();
    expect(text()).toContain('Lisinopril');
  });

  it("unlocks with this device's stored key, offline too", async () => {
    await encryptedAccount();
    await rememberKey();
    state.metaMode = 'cache-miss';
    vi.stubGlobal('navigator', { onLine: false, userAgent: 'node', platform: 'Win32', maxTouchPoints: 0 });
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    expect(text()).toContain('Lisinopril');
    expect(text()).not.toContain('Unlock cloud sync');
    expect(state.storage.get(`medtracker.e2ee.${UID}`)).toBe('1');
  });
});

describe('locking an unlocked device', () => {
  beforeEach(async () => {
    await encryptedAccount([sampleMed()], [recentLog()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog()] });
    signedIn();
  });

  it('forgetting the key encrypts the local copy and stops reminders; unlocking brings it back', async () => {
    await mountApp();
    expect(text()).toContain('Lisinopril');
    await settle(70);
    push.syncReminders.mockClear();

    await openEncryptionSettings();
    await click(buttons('Forget key on this device')[0]);
    await click(buttons('Yes, forget the key')[0]);
    await until(() => text().includes('Unlock cloud sync'));

    expect(state.deviceKeys.has(UID)).toBe(false);
    expect(text()).toContain('Unlock cloud sync');
    expect(text()).not.toContain('Lisinopril');
    // Nothing readable is left on this device: only the encrypted copy.
    expect(state.accounts.get(USER_ID)?.medications ?? []).toEqual([]);
    expect(state.sealed.has(`${USER_ID}|${bundle.meta.keyId}`)).toBe(true);
    expect(JSON.stringify([...state.sealed.values()].map((v) => ({ ...(v as object), ct: undefined, iv: undefined })))).not.toContain('Lisinopril');
    expect(state.decrypted.has(UID)).toBe(false);
    expect(push.syncReminders).toHaveBeenCalledWith([], []);
    expect(remindedMeds()).toEqual([]);
    expect(drug.clearDrugInfoCache).toHaveBeenCalled();

    await unlockWith(PASS);
    expect(text()).toContain('Lisinopril');
    expect(state.accounts.get(USER_ID)?.medications.map((m) => m.name)).toEqual(['Lisinopril']);
    expect(state.sealed.size).toBe(0);
  });

  it('keeps edits not uploaded yet through the lock, still queued for upload after unlocking', async () => {
    state.commitHangs = true; // offline-ish: nothing gets confirmed
    const extra = recentLog({ id: 'l2', scheduledFor: new Date(Date.now() - 7_200_000).toISOString() });
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog(), extra] });
    state.storage.set(`medtracker.syncq.${UID}`, JSON.stringify([{ id: 'q1', ref: { kind: 'log', id: 'l2', doc: logDocId(extra) } }]));
    await mountApp();

    await openEncryptionSettings();
    await click(buttons('Forget key on this device')[0]);
    await click(buttons('Yes, forget the key')[0]);
    await until(() => text().includes('Unlock cloud sync'));
    expect(state.accounts.get(USER_ID)?.doseLogs ?? []).toEqual([]);
    expect(queued().map((q) => q.ref.id)).toContain('l2');

    await unlockWith(PASS);
    expect(state.accounts.get(USER_ID)?.doseLogs.map((l) => l.id).sort()).toEqual(['l1', 'l2']);
    expect(queued().map((q) => q.ref.id)).toContain('l2');
  });

  it("signed out outside the app: the local copy is encrypted, the key forgotten, reminders stopped", async () => {
    state.commitHangs = true;
    state.storage.set(`medtracker.syncq.${UID}`, JSON.stringify([{ id: 'q1', ref: { kind: 'log', id: 'l1', doc: logDocId(recentLog()) } }]));
    await mountApp();
    expect(text()).toContain('Lisinopril');
    push.syncReminders.mockClear();

    for (const cb of [...state.authListeners]) await act(async () => cb(null));
    await until(() => state.sealed.size > 0 && !state.deviceKeys.has(UID));

    expect(text()).toContain('Sign in with Google');
    expect(state.accounts.get(USER_ID)?.medications ?? []).toEqual([]);
    expect(state.sealed.has(`${USER_ID}|${bundle.meta.keyId}`)).toBe(true);
    expect(state.deviceKeys.has(UID)).toBe(false);
    expect(push.syncReminders).toHaveBeenCalledWith([], []);
    expect(queued().map((q) => q.ref.id)).toContain('l1'); // still waiting to upload

    // Signing back in asks for the passphrase, then everything is back.
    for (const cb of [...state.authListeners]) await act(async () => cb(GOOGLE_USER));
    await until(() => text().includes('Unlock cloud sync'));
    expect(text()).toContain('Unlock cloud sync');
    expect(text()).not.toContain('Lisinopril');
    await unlockWith(PASS);
    expect(text()).toContain('Lisinopril');
    expect(state.accounts.get(USER_ID)?.doseLogs.map((l) => l.id)).toEqual(['l1']);
  });
});

describe('guest data on a device signed in to a locked account', () => {
  it('is kept as it is until the account is unlocked, then taken over', async () => {
    await encryptedAccount([]);
    state.accounts.set('guest', { version: 1, medications: [sampleMed({ id: 'g1', name: 'Metformin' })], doseLogs: [] });
    signedIn();
    await mountApp();
    expect(text()).not.toContain('Metformin');
    expect(state.accounts.get('guest')?.medications.map((m) => m.name)).toEqual(['Metformin']);
    expect(state.accounts.has(USER_ID)).toBe(false);

    await unlockWith(PASS);
    expect(text()).toContain('Metformin');
    expect(state.accounts.get(USER_ID)?.medications.map((m) => m.name)).toEqual(['Metformin']);
    expect(state.accounts.has('guest')).toBe(false);
  });
});

// ---------- regression tests for the second review ----------

/** Another tab of this browser, on the device-key channel. */
async function fromOtherTab(msg: { uid: string; forgot?: string }) {
  const ch = new BroadcastChannel('medtracker-keys');
  ch.postMessage(msg);
  await settle(4);
  ch.close();
}

/** Medication tombstones uploaded so far (by medication id). */
async function uploadedTombstones(): Promise<string[]> {
  const fs = await import('firebase/firestore');
  const out: string[] = [];
  for (const r of vi.mocked(fs.writeBatch).mock.results) {
    const batch = r.value as { set: ReturnType<typeof vi.fn> };
    for (const [ref, value] of batch.set.mock.calls as [{ path: string }, Record<string, unknown>][]) {
      const m = /^users\/[^/]+\/meds\/(.+)$/.exec(ref.path);
      if (m && value?.deleted === true) out.push(m[1]!);
    }
  }
  return out;
}

function deferredVoid() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

async function forgetKeyHere() {
  await openEncryptionSettings();
  await click(buttons('Forget key on this device')[0]);
  await click(buttons('Yes, forget the key')[0]);
}

/** Make the mocked storeSealed wait for `gate` before doing its work. */
async function holdSealing(gate: Promise<void>) {
  const { storeSealed } = await import('./localDb');
  const real = vi.mocked(storeSealed).getMockImplementation()!;
  vi.mocked(storeSealed).mockImplementation(async (...args) => {
    await gate;
    return real(...args);
  });
}

describe('locking while other tabs keep going', () => {
  beforeEach(async () => {
    await encryptedAccount([sampleMed()], [recentLog()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog()] });
    signedIn();
  });

  // Finding 1: an edit another tab saves while this one encrypts the copy isn't lost (and isn't
  // uploaded as a deletion once unlocked again).
  it('keeps an edit saved by another tab while the copy is being encrypted', async () => {
    await mountApp();
    expect(text()).toContain('Lisinopril');
    const { writeChanges, NO_CHANGES } = await import('./localDb');
    const other = sampleMed({ id: 'm2', name: 'Atorvastatin' });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    let armed = false;
    let injected = false;
    const spy = vi.spyOn(crypto.subtle, 'encrypt').mockImplementation(async (...args: Parameters<SubtleCrypto['encrypt']>) => {
      if (armed && !injected) {
        injected = true;
        await writeChanges(USER_ID, { ...NO_CHANGES, putMeds: [other] }); // the other tab's save
      }
      return encrypt(...args);
    });
    await openEncryptionSettings();
    await click(buttons('Forget key on this device')[0]);
    armed = true;
    await click(buttons('Yes, forget the key')[0]);
    await until(() => text().includes('Unlock cloud sync'));
    spy.mockRestore();
    expect(injected).toBe(true);
    expect(state.accounts.get(USER_ID)?.medications ?? []).toEqual([]);

    await unlockWith(PASS);
    await until(() => text().includes('Atorvastatin'));
    expect(state.accounts.get(USER_ID)?.medications.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
    expect(await uploadedTombstones()).not.toContain('m2');
  });

  // Finding 1 (defense in depth): a queued edit of a medication that's missing locally is never
  // uploaded as a permanent deletion.
  it("doesn't turn a queued edit of a medication missing here into a cloud tombstone", async () => {
    state.storage.set(`medtracker.syncq.${UID}`, JSON.stringify([{ id: 'q1', ref: { kind: 'med', id: 'm2', upsert: true } }]));
    await mountApp();
    await until(() => queued().length === 0);
    expect(queued()).toEqual([]);
    expect(await uploadedTombstones()).toEqual([]);
  });

  // Finding 1 (other tabs): a tab still unlocked when the key is forgotten elsewhere encrypts what
  // it saved since, before locking, instead of leaving it readable.
  it('another tab forgetting the key: this tab encrypts its copy too, then locks', async () => {
    await mountApp();
    expect(text()).toContain('Lisinopril');
    state.deviceKeys.delete(UID); // forgotten by the other tab
    await fromOtherTab({ uid: UID, forgot: bundle.meta.keyId });
    await until(() => text().includes('Unlock cloud sync'));
    expect(text()).not.toContain('Lisinopril');
    expect(state.accounts.get(USER_ID)?.medications ?? []).toEqual([]);
    expect(state.sealed.has(`${USER_ID}|${bundle.meta.keyId}`)).toBe(true);
    await unlockWith(PASS);
    expect(text()).toContain('Lisinopril');
  });

  // Finding 4: if this device's copy can't be encrypted, the key isn't forgotten and it stays unlocked.
  it("forgetting the key fails safely if the copy can't be encrypted", async () => {
    const { storeSealed } = await import('./localDb');
    vi.mocked(storeSealed).mockRejectedValue(new Error('QuotaExceededError'));
    await mountApp();
    await forgetKeyHere();
    await until(() => text().includes("couldn't encrypt this device's copy"));
    expect(state.deviceKeys.has(UID)).toBe(true);
    expect(text()).toContain("couldn't encrypt this device's copy");
    expect(text()).toContain('Lisinopril'); // still unlocked, and shown again
    expect(text()).not.toContain('Unlock cloud sync');
    expect(state.accounts.get(USER_ID)?.medications.map((m) => m.name)).toEqual(['Lisinopril']);
    expect(state.sealed.size).toBe(0);
  });

  // Finding 8: while encrypting, a neutral "Locking…" screen, not the unlocked settings.
  it('shows "Locking…" while the copy is being encrypted', async () => {
    const gate = deferredVoid();
    await holdSealing(gate.promise);
    await mountApp();
    await forgetKeyHere();
    await settle(4);
    expect(text()).toContain('Locking…');
    expect(text()).not.toContain('This device is unlocked');
    expect(buttons('Show recovery key')).toHaveLength(0);
    expect(text()).not.toContain('Lisinopril');
    gate.resolve();
    await until(() => text().includes('Unlock cloud sync'));
    expect(text()).not.toContain('Locking…');
  });

  // Finding 3: a key reset started on another device makes this device forget its (stale) stored
  // key, so a reload can't open the data with it, offline either.
  it('a key reset elsewhere forgets the stored key; a reload stays locked', async () => {
    await mountApp();
    expect(text()).toContain('Lisinopril');
    const resetting = { ...(bundle.meta as unknown as Record<string, unknown>), resetting: true, resetAt: Date.now() };
    state.metaDocs.set(UID, resetting);
    for (const l of [...state.metaListeners]) {
      await act(async () => l({ exists: () => true, data: () => resetting, metadata: { fromCache: false, hasPendingWrites: false } }));
    }
    await until(() => !state.deviceKeys.has(UID));
    expect(state.deviceKeys.has(UID)).toBe(false);
    expect(text()).not.toContain('Lisinopril');
    // This device's copy stays (unshown), to be merged into the new cloud copy.
    expect(state.accounts.get(USER_ID)?.medications.map((m) => m.name)).toEqual(['Lisinopril']);

    await act(async () => root!.unmount());
    root = null;
    vi.resetModules();
    state.metaMode = 'cache-miss';
    vi.stubGlobal('navigator', { onLine: false, userAgent: 'node', platform: 'Win32', maxTouchPoints: 0 });
    fakeDoc.getElementById('root')!.childNodes = [];
    await mountApp();
    expect(text()).not.toContain('Lisinopril');
  });

  // Finding 5: signing straight back in while the copy is still being locked after a sign-out
  // elsewhere doesn't open it with the key being forgotten.
  it('signing back in during the lock after a sign-out elsewhere stays locked', async () => {
    await mountApp();
    expect(text()).toContain('Lisinopril');
    const gate = deferredVoid();
    await holdSealing(gate.promise);
    for (const cb of [...state.authListeners]) await act(async () => cb(null));
    for (const cb of [...state.authListeners]) await act(async () => cb(GOOGLE_USER));
    await settle(8);
    expect(text()).not.toContain('Lisinopril');
    gate.resolve();
    await until(() => state.sealed.size > 0);
    await settle(8);
    expect(text()).toContain('Unlock cloud sync');
    expect(text()).not.toContain('Lisinopril');
    expect(state.deviceKeys.has(UID)).toBe(false);
    await unlockWith(PASS);
    expect(text()).toContain('Lisinopril');
  });

  // Finding 6: open → checking (key forgotten in another tab before the settings arrived) stops
  // reminders too, not only open → locked.
  it('stops reminders when it goes from open back to checking', async () => {
    state.metaMode = 'cache-miss';
    vi.stubGlobal('navigator', { onLine: false, userAgent: 'node', platform: 'Win32', maxTouchPoints: 0 });
    await mountApp();
    expect(text()).toContain('Lisinopril');
    await settle(70);
    push.syncReminders.mockClear();
    push.stopLocalReminders.mockClear();
    drug.clearDrugInfoCache.mockClear();
    state.deviceKeys.delete(UID);
    await fromOtherTab({ uid: UID });
    await until(() => text().includes('Checking cloud sync'));
    expect(text()).not.toContain('Lisinopril');
    expect(push.stopLocalReminders).toHaveBeenCalled();
    expect(push.syncReminders).toHaveBeenCalledWith([], []);
    expect(drug.clearDrugInfoCache).toHaveBeenCalled();
    await settle(70);
    expect(remindedMeds()).toEqual([]);
  });
});

describe('settings this version cannot read', () => {
  // Finding 2: an account remembered as unencrypted whose cloud settings can't be parsed (newer
  // schema) is closed, and remembered as encrypted.
  it('closes an account marked unencrypted once settings it cannot read appear', async () => {
    state.storage.set(`medtracker.e2ee.${UID}`, '0');
    state.metaDocs.set(UID, { v: 2, keyId: 'k2' });
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    expect(text()).not.toContain('Lisinopril');
    expect(text()).toContain("Cloud sync can't be opened");
    expect(text()).toContain('newer version of Amendra');
    expect(state.storage.get(`medtracker.e2ee.${UID}`)).toBe('1');
  });
});

describe('drug lookups cached while checking', () => {
  // Finding 7: still being checked at launch: the cached drug lookups (medication names) go, but
  // the push server's reminders are left alone (nothing was armed here).
  it('clears them while checking, without touching the push server', async () => {
    state.metaMode = 'cache-miss';
    vi.stubGlobal('navigator', { onLine: false, userAgent: 'node', platform: 'Win32', maxTouchPoints: 0 });
    signedIn();
    await mountApp();
    expect(text()).toContain('Checking cloud sync');
    expect(drug.clearDrugInfoCache).toHaveBeenCalled();
    expect(push.syncReminders).not.toHaveBeenCalledWith([], []);
  });

  it('keeps them for a guest and for an account known to be unencrypted', async () => {
    signedIn(GUEST);
    await mountApp();
    expect(drug.clearDrugInfoCache).not.toHaveBeenCalled();
    await act(async () => root!.unmount());
    root = null;
    vi.resetModules();
    fakeDoc.getElementById('root')!.childNodes = [];
    state.storage.set(`medtracker.e2ee.${UID}`, '0');
    signedIn();
    await mountApp();
    expect(text()).not.toContain('Checking cloud sync');
    expect(drug.clearDrugInfoCache).not.toHaveBeenCalled();
  });
});

describe('the sign-out dialog when the account locks', () => {
  // Finding 9: names of unsynced medications shown in the dialog go once it's locked.
  it('stops naming medications once locked', async () => {
    const { SignOutDialog } = await import('../components/SignOutDialog');
    const sync = {
      flushAll: vi.fn(async () => ({
        ok: false as const,
        reason: 'offline' as const,
        pending: { medications: ['Lisinopril'], deletedMedications: 0, doseLogs: 2, refused: 0 },
      })),
    } as unknown as import('./sync').SyncHandle;
    const render = (locked: boolean) =>
      React.createElement(SignOutDialog, {
        user: GOOGLE_USER,
        sync,
        locked,
        applyPendingTakes: async () => ({ applied: 0, waiting: 0 }),
        onUnlock: () => {},
        onSignedOut: () => {},
        onClose: () => {},
      });
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(render(false)));
    await until(() => text().includes('Lisinopril'));
    expect(text()).toContain('Lisinopril');
    await act(async () => root!.render(render(true)));
    await settle(2);
    expect(text()).not.toContain('Lisinopril');
    expect(text()).toContain('unlock cloud sync to see them');
  });
});

// ---------- regression tests for the third review ----------

/** Send a `meta/crypto` snapshot to the listeners (as if it had changed in the cloud). */
async function pushMeta(data: Record<string, unknown> | undefined, fromCache = false) {
  if (data) state.metaDocs.set(UID, data);
  else state.metaDocs.delete(UID);
  for (const l of [...state.metaListeners]) {
    await act(async () => l({ exists: () => data !== undefined, data: () => data, metadata: { fromCache, hasPendingWrites: false } }));
  }
  await settle(4);
}

/** The live `meta/crypto` listeners stop with this error (as Firestore's do, for good). */
async function failMeta(failure: { code?: string; message?: string }) {
  for (const l of [...state.metaErrorListeners]) {
    await act(async () => l(Object.assign(new Error(failure.message ?? 'failed'), failure)));
  }
  await settle(4);
}

const dialogs = () => walkEls(fakeDoc.documentElement, (el) => el.getAttribute('role') === 'dialog');

/** The account menu's item `label`. */
async function fromAccountMenu(label: string) {
  await click(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('aria-label') === `Account: ${GOOGLE_USER.name}`)[0]);
  await click(walkEls(fakeDoc.documentElement, (el) => el.getAttribute('role') === 'menuitem' && el.textContent.includes(label))[0]);
}

/** Mount just the store (no App), for what it does with edits. */
async function mountStore() {
  const { useAppData } = await import('./store');
  const ref: { api: ReturnType<typeof useAppData> | null } = { api: null };
  function Probe() {
    ref.api = useAppData(USER_ID, UID);
    return null;
  }
  root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
  await act(async () => root!.render(React.createElement(Probe)));
  await until(() => !!ref.api?.loaded);
  return ref;
}

/** Another tab locks this device: it encrypts the copy and forgets the key (this tab hasn't heard yet). */
async function lockedInAnotherTab() {
  const stored = state.deviceKeys.get(UID)!;
  const { sealLocal } = await import('./localSeal');
  expect(await sealLocal(USER_ID, UID, stored.key, stored.keyId)).toBe(true);
  state.deviceKeys.delete(UID);
}

describe('edits in a tab that has not heard the device was locked (A1)', () => {
  const l1 = recentLog();
  beforeEach(async () => {
    await encryptedAccount([sampleMed()], [l1]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [l1] });
    state.commitHangs = true; // offline-ish
  });

  type Api = NonNullable<Awaited<ReturnType<typeof mountStore>>['api']>;
  for (const [what, edit] of [
    ['deleting a medication', (api: Api) => api.deleteMedication('m1')],
    ['undoing a dose', (api: Api) => api.undoDose('m1', l1.scheduledFor)],
  ] as const) {
    it(`${what} is refused (not queued, nothing readable written), the tab locks and says so, and unlocking brings it all back`, async () => {
      const ref = await mountStore();
      expect(ref.api!.data.medications.map((m) => m.id)).toEqual(['m1']);
      await settle(4);
      expect(queued()).toEqual([]); // (nothing else waiting)
      await lockedInAnotherTab();

      await act(async () => edit(ref.api!));
      await until(() => ref.api!.access === 'locked');
      expect(ref.api!.access).toBe('locked');
      expect(ref.api!.lockError).toContain('locked in another tab');
      expect(queued()).toEqual([]); // the refused edit isn't queued for upload
      expect(state.accounts.get(USER_ID)?.medications ?? []).toEqual([]); // nothing readable
      expect(state.sealed.has(`${USER_ID}|${bundle.meta.keyId}`)).toBe(true);

      state.commitHangs = false;
      await act(async () => ref.api!.syncControls!.unlock(PASS, 'passphrase'));
      await until(() => !!ref.api!.loaded);
      expect(ref.api!.data.medications.map((m) => m.id)).toEqual(['m1']);
      expect(ref.api!.data.doseLogs.map((l) => l.id)).toEqual(['l1']);
      expect(ref.api!.lockError).toBeNull(); // unlocked again: no longer applies
      await settle(8);
      expect(await uploadedTombstones()).toEqual([]);
    });
  }
});

describe('locking after a sign-out elsewhere tells the other tabs which key (A2)', () => {
  it('broadcasts `forgot` with the key, after encrypting the copy', async () => {
    await encryptedAccount([sampleMed()], [recentLog()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog()] });
    signedIn();
    const heard: { msg: { uid: string; forgot?: string }; sealed: boolean }[] = [];
    const ch = new BroadcastChannel('medtracker-keys');
    ch.onmessage = (e) => heard.push({ msg: e.data, sealed: state.sealed.size > 0 });
    try {
      await mountApp();
      expect(text()).toContain('Lisinopril');
      for (const cb of [...state.authListeners]) await act(async () => cb(null));
      await until(() => heard.some((h) => h.msg.forgot));
      const forgot = heard.find((h) => h.msg.uid === UID && h.msg.forgot);
      expect(forgot?.msg.forgot).toBe(bundle.meta.keyId);
      expect(forgot?.sealed).toBe(true); // sent once the copy was encrypted
    } finally {
      ch.close();
    }
  });
});

describe('another tab forgetting the key, then unlocking again at once (A3)', () => {
  it("doesn't encrypt the copy now in use (the key is stored again), and stays unlocked", async () => {
    await encryptedAccount([sampleMed()], [recentLog()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog()] });
    signedIn();
    await mountApp();
    expect(text()).toContain('Lisinopril');
    // This tab looks for the key when it hears `forgot` (gone), and by the time it would encrypt the
    // copy, the other tab has unlocked again (stored the key, and is using the readable copy).
    const { loadDeviceKey } = await import('./keyStore');
    vi.mocked(loadDeviceKey).mockResolvedValueOnce(null);
    await fromOtherTab({ uid: UID, forgot: bundle.meta.keyId });
    await settle(8);
    expect(state.sealed.size).toBe(0);
    expect(state.accounts.get(USER_ID)?.medications.map((m) => m.name)).toEqual(['Lisinopril']);
    expect(text()).toContain('Lisinopril');
    expect(text()).not.toContain('Unlock cloud sync');
  });
});

describe('cloud sync that cannot be reached or read (B)', () => {
  it('locked, then the settings connection drops: explains it above the unlock form, and Retry reconnects', async () => {
    await encryptedAccount();
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    expect(text()).toContain('Unlock cloud sync');
    await failMeta({ code: 'unavailable' });
    expect(text()).toContain("Can't reach cloud sync.");
    expect(text()).toContain('if it was changed on another device');
    expect(text()).toContain('Unlock cloud sync'); // can still try
    expect(text()).not.toContain('Lisinopril');
    expect(state.metaListeners.size).toBe(0);
    await click(buttons('Retry')[0]);
    await until(() => !text().includes("Can't reach cloud sync"));
    expect(text()).not.toContain("Can't reach cloud sync");
    expect(text()).toContain('Unlock cloud sync');
    expect(state.metaListeners.size).toBe(1);
  });

  it('unlocked, then the cloud refuses the settings: explains it on the page, and Retry watches them again', async () => {
    await encryptedAccount();
    await rememberKey();
    signedIn();
    await mountApp();
    await until(() => text().includes('Lisinopril'));
    expect(text()).toContain('Lisinopril');
    await failMeta({ code: 'permission-denied' });
    expect(text()).toContain("Cloud sync can't check this account's encryption settings.");
    expect(text()).toContain('security rules');
    expect(text()).toContain('syncing with your other devices may be paused');
    expect(text()).toContain('Lisinopril'); // still open
    expect(state.metaListeners.size).toBe(0);
    await click(buttons('Retry')[0]);
    await until(() => !text().includes("can't check this account's encryption settings"));
    expect(text()).not.toContain("can't check this account's encryption settings");
    expect(text()).toContain('Lisinopril');
    expect(state.metaListeners.size).toBe(1);
  });

  it("can't reach the cloud: says so (not \"can't be opened\"), stays locked, and Retry tries again", async () => {
    await encryptedAccount();
    state.storage.set(`medtracker.e2ee.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    state.metaErrors.push({ code: 'unavailable' });
    signedIn();
    await mountApp();
    expect(text()).toContain("Can't reach cloud sync");
    expect(text()).toContain('Check your connection and try again.');
    expect(text()).not.toContain("Cloud sync can't be opened");
    expect(text()).not.toContain('Lisinopril');
    await click(buttons('Retry')[0]);
    await until(() => text().includes('Unlock cloud sync'));
    expect(text()).toContain('Unlock cloud sync');
    expect(text()).not.toContain("Can't reach cloud sync");
  });

  it('first sign-in here, settings refused: shows the problem (not an endless "Checking…"), and Retry works', async () => {
    await encryptedAccount();
    state.metaErrors.push({ code: 'permission-denied' });
    signedIn();
    await mountApp();
    expect(text()).toContain("Cloud sync can't be opened");
    expect(text()).toContain('security rules');
    expect(text()).not.toContain('Checking cloud sync');
    await click(buttons('Retry')[0]);
    await until(() => text().includes('Unlock cloud sync'));
    expect(text()).toContain('Unlock cloud sync');
  });

  it('first sign-in here, Firebase fails to load: "can\'t reach", and Retry loads it again', async () => {
    await encryptedAccount();
    const auth = await import('./auth');
    vi.mocked(auth.getFirebaseApp).mockRejectedValueOnce(new TypeError('Failed to fetch dynamically imported module'));
    signedIn();
    await mountApp();
    expect(text()).toContain("Can't reach cloud sync");
    expect(text()).not.toContain('Checking cloud sync');
    await click(buttons('Retry')[0]);
    await until(() => text().includes('Unlock cloud sync'));
    expect(text()).toContain('Unlock cloud sync');
  });

  it('locked, then settings this version cannot read arrive: closed, and it can no longer be unlocked with the old ones', async () => {
    await encryptedAccount();
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    expect(text()).toContain('Unlock cloud sync');
    await pushMeta({ v: 2, keyId: 'k2' });
    expect(text()).toContain("Cloud sync can't be opened");
    expect(text()).toContain('newer version of Amendra');
    expect(text()).not.toContain('Unlock cloud sync');
    expect(walkEls(fakeDoc.documentElement, (el) => el.tagName === 'INPUT')).toHaveLength(0);
  });

  it('the unlock itself is refused once the settings it went by are no longer readable', async () => {
    await encryptedAccount();
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await (async () => {
      const { useAppData } = await import('./store');
      const r: { api: ReturnType<typeof useAppData> | null } = { api: null };
      function Probe() {
        r.api = useAppData(USER_ID, UID);
        return null;
      }
      root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
      await act(async () => root!.render(React.createElement(Probe)));
      await until(() => r.api?.syncStatus?.lock === 'locked');
      return r;
    })();
    await pushMeta({ v: 2, keyId: 'k2' });
    expect(ref.api!.syncStatus?.lock).toBe('checking');
    await expect(ref.api!.syncControls!.unlock(PASS, 'passphrase')).rejects.toThrow();
    await settle(4);
    expect(ref.api!.access).not.toBe('open');
    expect(state.deviceKeys.has(UID)).toBe(false);
  });

  it('not set up, then settings this version cannot read arrive: closed, not asking to set up', async () => {
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    expect(text()).toContain('Turn on encrypted sync');
    await pushMeta({ v: 2, keyId: 'k2' });
    expect(text()).toContain("Cloud sync can't be opened");
    expect(text()).not.toContain('Turn on encrypted sync');
    expect(text()).not.toContain('Lisinopril');
  });
});

describe('queued edits of items missing here (C)', () => {
  beforeEach(async () => {
    await rememberKey();
    signedIn();
  });

  it("first sync on this device: a queued edit of a medication missing here doesn't delete it in the cloud", async () => {
    await encryptedAccount([sampleMed(), sampleMed({ id: 'm2', name: 'Atorvastatin' })]);
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    state.storage.set(`medtracker.syncq.${UID}`, JSON.stringify([{ id: 'q1', ref: { kind: 'med', id: 'm2', upsert: true } }]));
    await mountApp();
    await until(() => text().includes('Atorvastatin'));
    await settle(8);
    expect(text()).toContain('Atorvastatin');
    expect(await uploadedTombstones()).toEqual([]);
    expect(state.accounts.get(USER_ID)?.medications.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('a dropped queued edit (nothing to upload) is followed by another look at the cloud copy (tidy-ups run)', async () => {
    const expired = recentLog({ id: 'old', scheduledFor: new Date(Date.now() - 400 * 86_400_000).toISOString() });
    await encryptedAccount([sampleMed()], [expired]);
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    state.storage.set(`medtracker.syncq.${UID}`, JSON.stringify([{ id: 'q1', ref: { kind: 'med', id: 'm2', upsert: true } }]));
    await mountApp();
    await until(() => queued().length === 0);
    await settle(10);
    const fs = await import('firebase/firestore');
    const removed: string[] = [];
    for (const r of vi.mocked(fs.writeBatch).mock.results) {
      const batch = r.value as { set: ReturnType<typeof vi.fn> };
      for (const [ref, value] of batch.set.mock.calls as [{ path: string }, { logs?: Record<string, unknown> }][]) {
        if (!ref.path.includes('/logs/')) continue;
        for (const [id, v] of Object.entries(value?.logs ?? {})) if ((v as { __deleteField?: boolean })?.__deleteField) removed.push(id);
      }
    }
    expect(removed).toContain('old');
  });

  it('a key reset in another tab: once the new settings arrive, the new key it stored is used (C3)', async () => {
    await encryptedAccount([sampleMed()], [recentLog()]);
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog()] });
    await mountApp();
    expect(text()).toContain('Lisinopril');
    // The other tab starts a reset: this one stops and forgets the (old) key.
    await pushMeta({ ...(bundle.meta as unknown as Record<string, unknown>), resetting: true, resetAt: Date.now() });
    await until(() => !state.deviceKeys.has(UID));
    expect(text()).not.toContain('Lisinopril');
    // It finishes: new key stored and announced (ignored here: the settings this tab has are still the old ones).
    const fresh = await createKeyBundle(UID, PASS, 100_000);
    state.medDocs.set(UID, new Map());
    state.logDocs.set(UID, new Map());
    state.deviceKeys.set(UID, { key: fresh.dek, keyId: fresh.meta.keyId });
    await fromOtherTab({ uid: UID });
    expect(text()).toContain('Unlock cloud sync');
    // Then its new settings arrive.
    await pushMeta(fresh.meta as unknown as Record<string, unknown>);
    await until(() => text().includes('Lisinopril'));
    expect(text()).not.toContain('Unlock cloud sync');
    expect(text()).toContain('Lisinopril');
  });
});

describe('dialogs when the account locks or opens (D)', () => {
  beforeEach(async () => {
    await encryptedAccount([sampleMed()], [recentLog()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog()] });
    signedIn();
  });

  /** Another tab forgets the key (encrypting the copy): this one locks. */
  async function lockFromOtherTab() {
    state.deviceKeys.delete(UID);
    await fromOtherTab({ uid: UID, forgot: bundle.meta.keyId });
    await until(() => text().includes('Unlock cloud sync'));
  }

  it('the account deletion dialog stays as it was (what was typed) through a lock', async () => {
    await mountApp();
    await fromAccountMenu('Delete account');
    const dialog = dialogs()[0];
    expect(dialog).toBeDefined();
    const input = walkEls(dialog!, (el) => el.tagName === 'INPUT')[0]!;
    await act(async () => reactProps(input).onChange({ target: { value: 'DELETE' } }));
    const submit = () => walkEls(dialogs()[0]!, (el) => el.tagName === 'BUTTON' && el.textContent.trim() === 'Delete account')[0]!;
    expect(reactProps(submit()).disabled).toBe(false);
    await lockFromOtherTab();
    expect(dialogs()[0]).toBe(dialog); // the same dialog, not a new one
    expect(reactProps(submit()).disabled).toBe(false);
  });

  it('the sign-out dialog stays as it was through a lock (its saving keeps going, not restarted)', async () => {
    state.commitHangs = true;
    const extra = recentLog({ id: 'l2', scheduledFor: new Date(Date.now() - 7_200_000).toISOString() });
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog(), extra] });
    state.storage.set(`medtracker.syncq.${UID}`, JSON.stringify([{ id: 'q1', ref: { kind: 'log', id: 'l2', doc: logDocId(extra) } }]));
    await mountApp();
    await fromAccountMenu('Sign out');
    const dialog = dialogs()[0];
    expect(dialog).toBeDefined();
    await lockFromOtherTab();
    expect(dialogs()[0]).toBe(dialog);
    await until(() => text().includes('Cloud sync is locked on this device'));
    expect(text()).toContain('Cloud sync is locked on this device');
  });

  it("forgetting the key fails: the settings dialog closes and the failure shows on the page, until dismissed", async () => {
    const { storeSealed } = await import('./localDb');
    vi.mocked(storeSealed).mockRejectedValue(new Error('QuotaExceededError'));
    await mountApp();
    await forgetKeyHere();
    await until(() => text().includes("couldn't encrypt this device's copy"));
    expect(text()).toContain('Lisinopril');
    expect(dialogs()).toHaveLength(0); // not behind a dialog
    expect(buttons('Forget key on this device')).toHaveLength(0);
    await click(buttons('Dismiss')[0]);
    expect(text()).not.toContain("couldn't encrypt this device's copy");
  });

  it("the encryption settings don't open again by themselves when another tab unlocks", async () => {
    await mountApp();
    await openEncryptionSettings();
    expect(dialogs()).toHaveLength(1);
    const stored = state.deviceKeys.get(UID)!;
    await lockFromOtherTab();
    // The other tab unlocks again.
    state.deviceKeys.set(UID, stored);
    await fromOtherTab({ uid: UID });
    await until(() => text().includes('Lisinopril'));
    expect(text()).toContain('Lisinopril');
    expect(dialogs()).toHaveLength(0);
  });
});

describe('an edit still being saved when sync stops (review)', () => {
  it('is queued for upload once saved, even though this tab stopped meanwhile', async () => {
    await encryptedAccount([sampleMed()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    state.commitHangs = true;
    const ref = await mountStore();
    await settle(4);
    expect(queued()).toEqual([]);
    const { writeChanges } = await import('./localDb');
    const real = vi.mocked(writeChanges).getMockImplementation()!;
    const gate = deferredVoid();
    vi.mocked(writeChanges).mockImplementation(async (...args) => {
      await gate.promise;
      return real(...args);
    });
    await act(async () => ref.api!.saveMedication(sampleMed({ id: 'm2', name: 'Atorvastatin' })));
    // The tracker goes away (e.g. signed out in another tab) before the save finishes.
    await act(async () => root!.unmount());
    root = null;
    gate.resolve();
    await settle(4);
    expect(state.accounts.get(USER_ID)?.medications.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
    expect(queued().map((q) => q.ref.id)).toContain('m2');
  });
});

// ---------- regression tests for the fourth review ----------

/**
 * Web Locks for loading, locking and unlocking this device's copy (one at a time per account, in
 * order, as in a browser). Other locks are granted at once.
 */
function stubLoadLocks() {
  const tails = new Map<string, Promise<unknown>>();
  const locks = {
    request(name: string, a: unknown, b?: unknown) {
      const fn = (typeof a === 'function' ? a : b) as () => unknown;
      if (!name.startsWith('medtracker-load-')) return Promise.resolve().then(fn);
      const run = (tails.get(name) ?? Promise.resolve()).then(() => fn());
      tails.set(
        name,
        run.catch(() => {}),
      );
      return run;
    },
  };
  vi.stubGlobal('navigator', { ...(globalThis.navigator as object), locks });
}

/** Mount just the store, without waiting for it to load. */
async function mountStoreNow() {
  const { useAppData } = await import('./store');
  const ref: { api: ReturnType<typeof useAppData> | null } = { api: null };
  function Probe() {
    ref.api = useAppData(USER_ID, UID);
    return null;
  }
  root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
  await act(async () => root!.render(React.createElement(Probe)));
  return ref;
}

describe('a load waiting its turn while another tab locks the copy (A1)', () => {
  beforeEach(async () => {
    await encryptedAccount([sampleMed()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    // An edit still waiting to upload: the readable copy isn't removed as "all in the cloud" either.
    state.storage.set(`medtracker.syncq.${UID}`, JSON.stringify([{ id: 'q1', ref: { kind: 'med', id: 'm1', upsert: true }, owner: 'gone' }]));
    state.commitHangs = true;
    stubLoadLocks();
  });

  /** Another tab locks the copy after a sign-out (key forgotten, then the copy encrypted), held at storing it. */
  async function otherTabLocking() {
    const gate = deferredVoid();
    await holdSealing(gate.promise);
    const stored = state.deviceKeys.get(UID)!;
    const { sealLocal } = await import('./localSeal');
    const done = sealLocal(USER_ID, UID, stored.key, stored.keyId);
    await settle(1);
    return { done, release: gate.resolve };
  }

  const stillEncrypted = () => {
    expect(state.sealedMarks.has(USER_ID)).toBe(true);
    expect(state.sealed.has(`${USER_ID}|${bundle.meta.keyId}`)).toBe(true);
    expect(state.accounts.get(USER_ID)?.medications ?? []).toEqual([]);
  };

  it('this tab closes meanwhile: its load, once its turn comes, leaves the copy encrypted', async () => {
    const other = await otherTabLocking();
    const ref = await mountStoreNow();
    await until(() => ref.api?.access === 'open'); // unlocked with the stored key: loading (waits its turn)
    expect(ref.api!.loaded).toBe(false);
    state.deviceKeys.delete(UID); // forgotten by the other tab
    await act(async () => root!.unmount());
    root = null;
    other.release();
    expect(await other.done).toBe(true);
    await settle(8);
    stillEncrypted();
  });

  it('this tab stays: its load finds the copy locked, leaves it encrypted, and this tab locks too', async () => {
    const other = await otherTabLocking();
    const ref = await mountStoreNow();
    await until(() => ref.api?.access === 'open');
    state.deviceKeys.delete(UID);
    other.release();
    expect(await other.done).toBe(true);
    await until(() => ref.api!.access === 'locked');
    expect(ref.api!.access).toBe('locked');
    expect(ref.api!.data.medications).toEqual([]);
    expect(ref.api!.lockError).toContain('locked in another tab');
    stillEncrypted();
  });

  it('forgetting the key here: it is forgotten before a load waiting meanwhile gets its turn', async () => {
    state.storage.delete(`medtracker.syncq.${UID}`);
    state.commitHangs = false;
    const ref = await mountStore();
    expect(ref.api!.data.medications.map((m) => m.name)).toEqual(['Lisinopril']);
    // Another tab's load queues behind the encrypting, and looks at the stored key when it runs.
    const gate = deferredVoid();
    await holdSealing(gate.promise);
    const forgetting = act(async () => ref.api!.syncControls!.forgetKey());
    await settle(1);
    let keyWhenLoading: boolean | undefined;
    const { withLoadLock } = await import('./localSeal');
    const load = withLoadLock(USER_ID, async () => void (keyWhenLoading = state.deviceKeys.has(UID)));
    gate.resolve();
    await forgetting;
    await load;
    expect(keyWhenLoading).toBe(false);
    stillEncrypted();
  });
});

describe('unlocked again in another tab while this one is still encrypting the copy (A2)', () => {
  it('this tab puts the copy back and stays unlocked (the key is stored again)', async () => {
    await encryptedAccount([sampleMed()], [recentLog()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog()] });
    const ref = await mountStore();
    expect(ref.api!.data.medications.map((m) => m.name)).toEqual(['Lisinopril']);
    const gate = deferredVoid();
    await holdSealing(gate.promise);
    const stored = state.deviceKeys.get(UID)!;
    state.deviceKeys.delete(UID);
    await fromOtherTab({ uid: UID, forgot: bundle.meta.keyId }); // this tab starts encrypting (held)
    // The other tab unlocks again meanwhile: key stored, and announced (while this tab still has it).
    state.deviceKeys.set(UID, stored);
    await fromOtherTab({ uid: UID });
    gate.resolve();
    await until(() => !!ref.api!.loaded);
    await settle(8);
    expect(ref.api!.access).toBe('open');
    expect(ref.api!.syncStatus?.lock).toBe('unlocked');
    expect(ref.api!.data.medications.map((m) => m.name)).toEqual(['Lisinopril']);
    expect(state.sealedMarks.has(USER_ID)).toBe(false);
    expect(state.accounts.get(USER_ID)?.medications.map((m) => m.name)).toEqual(['Lisinopril']);
  });
});

describe('the settings alert and Retry (B)', () => {
  it('an upload refused while the settings listener has stopped: the settings alert and Retry still show (B1)', async () => {
    await encryptedAccount();
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    state.storage.set(`medtracker.syncq.${UID}`, JSON.stringify([{ id: 'q1', ref: { kind: 'med', id: 'm1', upsert: true } }]));
    const fs = await import('firebase/firestore');
    const refused = Object.assign(new Error('denied'), { code: 'permission-denied' });
    vi.mocked(fs.writeBatch).mockImplementation(
      () => ({ set: vi.fn(), delete: vi.fn(), update: vi.fn(), commit: vi.fn(() => Promise.reject(refused)) }) as never,
    );
    signedIn();
    await mountApp();
    await until(() => text().includes('Lisinopril') && queued().length === 0);
    await settle(4);
    await failMeta({ code: 'permission-denied' });
    expect(text()).toContain("Cloud sync can't check this account's encryption settings.");
    expect(text()).toContain('security rules'); // what's wrong with the settings, not the upload's error
    expect(buttons('Retry')).toHaveLength(1);
    await click(buttons('Retry')[0]);
    await until(() => !text().includes("can't check this account's encryption settings"));
    expect(state.metaListeners.size).toBe(1);
  });

  it('setting up while the settings listener had stopped: they are watched again, and no alert stays (B2)', async () => {
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await mountStore();
    expect(ref.api!.syncStatus?.lock).toBe('needs-setup');
    await failMeta({ code: 'unavailable' });
    expect(state.metaListeners.size).toBe(0);
    await act(async () => {
      const prepared = await ref.api!.syncControls!.prepareSetup(PASS);
      await prepared.finish();
    });
    await until(() => state.metaListeners.size === 1);
    expect(state.metaListeners.size).toBe(1);
    expect(ref.api!.syncStatus?.lock).toBe('unlocked');
    expect(ref.api!.syncStatus?.problem).toBeUndefined();
    expect(ref.api!.syncStatus?.state).not.toBe('error');
  }, 15_000);

  it('starting over while the settings listener had stopped: they are watched again, and no alert stays (B2)', async () => {
    await encryptedAccount();
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await mountStoreNow();
    await until(() => ref.api?.syncStatus?.lock === 'locked');
    await failMeta({ code: 'unavailable' });
    expect(ref.api!.syncStatus?.problem).toBe('connection');
    expect(state.metaListeners.size).toBe(0);
    await act(async () => {
      const prepared = await ref.api!.syncControls!.prepareReset(PASS);
      await prepared.finish();
    });
    await until(() => state.metaListeners.size === 1 && ref.api!.syncStatus?.lock === 'unlocked');
    expect(state.metaListeners.size).toBe(1);
    expect(ref.api!.syncStatus?.lock).toBe('unlocked');
    expect(ref.api!.syncStatus?.problem).toBeUndefined();
  }, 15_000);

  async function unlockWhileSavingKey(meanwhile: () => Promise<void>, opts: { saveFails?: boolean } = {}) {
    await encryptedAccount();
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await mountStoreNow();
    await until(() => ref.api?.syncStatus?.lock === 'locked');
    const { saveDeviceKey } = await import('./keyStore');
    const gate = deferredVoid();
    let saving = false;
    vi.mocked(saveDeviceKey).mockImplementationOnce(async (uid, value) => {
      saving = true;
      await gate.promise;
      if (opts.saveFails) throw new Error('QuotaExceededError');
      state.deviceKeys.set(uid, value);
    });
    let outcome: unknown = 'pending';
    const unlocking = ref.api!.syncControls!.unlock(PASS, 'passphrase').then(
      () => (outcome = 'unlocked'),
      (e: unknown) => (outcome = e),
    );
    await until(() => saving);
    await meanwhile();
    gate.resolve();
    await act(async () => void (await unlocking));
    await settle(4);
    return { ref, outcome };
  }

  it('the account starts being deleted while the key is being saved: not unlocked, and the key not kept (B3)', async () => {
    const { ref, outcome } = await unlockWhileSavingKey(() => pushMeta({ deleted: true, phase: 'deleting', at: Date.now() }));
    expect(outcome).toBeInstanceOf(Error);
    expect(ref.api!.syncStatus?.lock).not.toBe('unlocked');
    expect(ref.api!.access).not.toBe('open');
    expect(state.deviceKeys.has(UID)).toBe(false);
  });

  it('settings this version cannot read arrive while the key is being saved: not unlocked, and the key not kept (B3)', async () => {
    const { ref, outcome } = await unlockWhileSavingKey(() => pushMeta({ v: 2, keyId: 'k2' }));
    expect(outcome).toBeInstanceOf(Error);
    expect(ref.api!.syncStatus?.lock).not.toBe('unlocked');
    expect(ref.api!.access).not.toBe('open');
    expect(state.deviceKeys.has(UID)).toBe(false);
  });

  it("the key can't be saved and the unlock is abandoned meanwhile: no warning about remembering it stays (B3)", async () => {
    const { ref, outcome } = await unlockWhileSavingKey(() => pushMeta({ deleted: true, phase: 'deleting', at: Date.now() }), {
      saveFails: true,
    });
    expect(outcome).toBeInstanceOf(Error);
    expect(ref.api!.syncStatus?.lock).not.toBe('unlocked');
    // (Next time the status is reported, too: here, after forgetting the key, which isn't stored anyway.)
    await act(async () => ref.api!.syncControls!.forgetKey());
    await settle(4);
    expect(ref.api!.syncStatus?.warning ?? '').not.toContain("couldn't remember the key");
  });

  it("a snapshot that isn't applied (from the cache, pending) doesn't clear a problem with the settings (B4)", async () => {
    await encryptedAccount();
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await mountStoreNow();
    await until(() => ref.api?.syncStatus?.lock === 'locked');
    await pushMeta({ v: 2, keyId: 'k2' });
    expect(ref.api!.syncStatus).toMatchObject({ state: 'error', problem: 'settings' });
    // A deletion marker seen only in the cache (not confirmed by the server): ignored for now.
    await pushMeta({ deleted: true, phase: 'deleting', at: Date.now() }, true);
    expect(ref.api!.syncStatus).toMatchObject({ state: 'error', problem: 'settings' });
    // Still so the next time the status is reported (here: after forgetting the key, which this
    // device doesn't have anyway).
    await act(async () => ref.api!.syncControls!.forgetKey());
    await settle(4);
    expect(ref.api!.syncStatus).toMatchObject({ state: 'error', problem: 'settings' });
  });
});

describe('the first sync on this device with uploads already queued (C2)', () => {
  it('uploads them once the cloud copy is merged in, without waiting for another change in the cloud', async () => {
    // Nothing new to upload from the merge itself (both sides empty), only what was queued before:
    // a removal of a dose log, made here offline.
    await encryptedAccount([]);
    await rememberKey();
    const gone = recentLog({ id: 'gone' });
    state.storage.set(
      `medtracker.syncq.${UID}`,
      JSON.stringify([{ id: 'q1', ref: { kind: 'log', id: 'gone', doc: logDocId(gone), del: true } }]),
    );
    signedIn();
    await mountApp();
    await until(() => queued().length === 0);
    expect(queued()).toEqual([]);
    expect(state.storage.get(`medtracker.synced.${UID}`)).toBe('1'); // done once they're uploaded
  });
});

describe('an unlock finishing while a sign-out or deletion dialog is open (B1)', () => {
  beforeEach(async () => {
    await encryptedAccount();
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog()] });
    signedIn();
  });

  /** Start unlocking with `secret`; the unlock stays "Unlocking…" until the returned gate opens. */
  async function startSlowUnlock(secret: string) {
    const { saveDeviceKey } = await import('./keyStore');
    const gate = deferredVoid();
    vi.mocked(saveDeviceKey).mockImplementationOnce(async (uid, value) => {
      await gate.promise;
      state.deviceKeys.set(uid, value);
    });
    await mountApp();
    const input = walkEls(fakeDoc.documentElement, (el) => el.tagName === 'INPUT')[0]!;
    await act(async () => reactProps(input).onChange({ target: { value: secret } }));
    const form = walkEls(fakeDoc.documentElement, (el) => el.tagName === 'FORM')[0]!;
    await act(async () => void reactProps(form).onSubmit({ preventDefault() {} }));
    await until(() => text().includes('Unlocking…'));
    return gate;
  }

  for (const which of ['Sign out', 'Delete account']) {
    it(`a ${which} dialog opened meanwhile is still the same dialog once the unlock has finished`, async () => {
      const gate = await startSlowUnlock(PASS);
      await fromAccountMenu(which);
      const dialog = dialogs()[0];
      expect(dialog).toBeDefined();
      gate.resolve();
      await until(() => text().includes('Lisinopril'));
      expect(dialogs()).toHaveLength(1);
      expect(dialogs()[0]).toBe(dialog);
    });

    it(`unlocked with the recovery key meanwhile, the "new passphrase" step waits for the ${which} dialog to close`, async () => {
      const gate = await startSlowUnlock(bundle.recoveryKey);
      await fromAccountMenu(which);
      const dialog = dialogs()[0];
      expect(dialog).toBeDefined();
      gate.resolve();
      await until(() => text().includes('Lisinopril'));
      expect(dialogs()[0]).toBe(dialog);
      expect(text()).not.toContain('Unlocked with your recovery key');
      // Closed: now the step that was waiting shows.
      await click(walkEls(dialog!, (el) => el.tagName === 'BUTTON' && ['Cancel', 'Stay signed in'].includes(el.textContent.trim()))[0]);
      await until(() => text().includes('Unlocked with your recovery key'));
      expect(text()).toContain('Unlocked with your recovery key');
    });
  }

  it('with no such dialog open, unlocking with the recovery key still goes straight to the new-passphrase step', async () => {
    const gate = await startSlowUnlock(bundle.recoveryKey);
    gate.resolve();
    await until(() => text().includes('Unlocked with your recovery key'));
    expect(text()).toContain('Unlocked with your recovery key');
  });
});

describe('the locked, checking and error screens have a page heading (B3)', () => {
  const h1s = () => walkEls(fakeDoc.documentElement, (el) => el.tagName === 'H1');

  it('the unlock screen has one h1', async () => {
    await encryptedAccount();
    signedIn();
    await mountApp();
    await until(() => text().includes('Unlock cloud sync'));
    expect(h1s()).toHaveLength(1);
  });

  it('the screen for settings this version cannot read has one h1', async () => {
    await encryptedAccount();
    signedIn();
    await mountApp();
    await until(() => text().includes('Unlock cloud sync'));
    await pushMeta({ v: 99, keyId: 'x' });
    expect(text()).toContain("Cloud sync can't be opened");
    expect(h1s()).toHaveLength(1);
  });

  it('once open there is still exactly one h1 (the greeting)', async () => {
    await encryptedAccount();
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    await until(() => text().includes('Lisinopril'));
    expect(h1s()).toHaveLength(1);
  });
});

describe('locking a device whose account settings are unreadable (D1)', () => {
  const UNREADABLE = { v: 2, keyId: 'k2' }; // written by a newer version

  it('first snapshot unreadable, unlocked from a stored key, then locked: the problem shows, not an endless "checking"', async () => {
    await encryptedAccount();
    await rememberKey();
    state.metaDocs.set(UID, UNREADABLE);
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await mountStoreNow();
    await until(() => ref.api?.syncStatus?.lock === 'unlocked');
    await act(async () => void (await ref.api!.syncControls!.forgetKey()));
    await settle(4);
    const status = ref.api!.syncStatus!;
    expect(status.lock).toBe('checking');
    expect(status.state).toBe('error');
    expect(status.problem).toBe('settings');
    expect(status.message).toContain('newer version of Amendra');
    await expect(ref.api!.syncControls!.unlock(PASS, 'passphrase')).rejects.toThrow();
  });

  it('first snapshot unreadable, locked from another tab (the app): the screen explains instead of spinning', async () => {
    await encryptedAccount();
    await rememberKey();
    state.metaDocs.set(UID, UNREADABLE);
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    await until(() => text().includes('Lisinopril'));
    state.deviceKeys.delete(UID);
    await fromOtherTab({ uid: UID, forgot: bundle.meta.keyId });
    await until(() => !text().includes('Lisinopril'));
    expect(text()).toContain("Cloud sync can't be opened");
    expect(text()).not.toContain('Checking cloud sync…');
  });

  it('settings readable, then unreadable, then locked: the old settings are not used to unlock', async () => {
    await encryptedAccount();
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await mountStoreNow();
    await until(() => ref.api?.syncStatus?.lock === 'unlocked');
    await pushMeta(UNREADABLE);
    expect(ref.api!.syncStatus?.lock).toBe('unlocked'); // (the key is still held, with a warning)
    await act(async () => void (await ref.api!.syncControls!.forgetKey()));
    await settle(4);
    expect(ref.api!.syncStatus?.lock).toBe('checking');
    expect(ref.api!.syncStatus?.problem).toBe('settings');
    await expect(ref.api!.syncControls!.unlock(PASS, 'passphrase')).rejects.toThrow();
    await settle(4);
    expect(state.deviceKeys.has(UID)).toBe(false);
    expect(ref.api!.access).not.toBe('open');
  });
});

describe('a refused dose-log upload (D2)', () => {
  it('the log stays on this device (also after a reload), and signing out still says it was not uploaded', async () => {
    await encryptedAccount([sampleMed()], []);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await mountStore();
    await until(() => ref.api?.syncStatus?.lock === 'unlocked' && !!ref.api?.syncStatus?.cloudLoaded);
    const fs = await import('firebase/firestore');
    const refused = Object.assign(new Error('denied'), { code: 'permission-denied' });
    vi.mocked(fs.writeBatch).mockImplementation(
      () => ({ set: vi.fn(), delete: vi.fn(), update: vi.fn(), commit: vi.fn(() => Promise.reject(refused)) }) as never,
    );
    const taken = recentLog({ id: 'refused-log' });
    await act(async () => ref.api!.logDose('m1', taken.scheduledFor, 'taken'));
    await until(() => queued().length === 0);
    await settle(10); // the next look at the cloud copy
    expect(ref.api!.data.doseLogs).toHaveLength(1);
    expect(JSON.parse(state.storage.get(`medtracker.kept.${UID}`) ?? '[]')).toHaveLength(1);
    const flushed = await ref.api!.syncControls!.flushAll();
    expect(flushed.ok).toBe(false);
    expect(flushed.ok === false && flushed.pending?.refused).toBeGreaterThan(0);
  });
});

describe('a stalled settings listener on an account known not to be encrypted (D3)', () => {
  it('the settings alert with Retry shows, worded for an unencrypted account', async () => {
    state.storage.set(`medtracker.e2ee.${UID}`, '0'); // the cloud said earlier it doesn't use encryption
    state.metaMode = 'cache-miss'; // and the settings haven't been confirmed since
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();
    await mountApp();
    await until(() => text().includes('Lisinopril'));
    await failMeta({ code: 'permission-denied' });
    expect(text()).toContain("Cloud sync can't check this account's encryption settings.");
    expect(text()).toContain('turning on encryption on one of them');
    expect(buttons('Retry')).toHaveLength(1);
    await click(buttons('Retry')[0]);
    await until(() => state.metaListeners.size === 1);
    expect(state.metaListeners.size).toBe(1);
  });
});

describe('sync refuses passphrases it could not rate (A)', () => {
  const STRONG = 'zebra quartz ninja velvet tomato';
  afterEach(() => {
    strengthCtl.unavailable = false;
  });

  it('setting up: a weak passphrase is refused, one that cannot be rated is refused, a strong one goes through', async () => {
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await mountStoreNow();
    await until(() => ref.api?.syncStatus?.lock === 'needs-setup');
    const controls = () => ref.api!.syncControls!;
    await expect(controls().prepareSetup('password123')).rejects.toMatchObject({ code: 'weak-passphrase' });
    strengthCtl.unavailable = true;
    await expect(controls().prepareSetup(STRONG)).rejects.toMatchObject({ code: 'strength-unavailable' });
    strengthCtl.unavailable = false;
    expect((await controls().prepareSetup(STRONG)).recoveryKey).toBeTruthy();
  });

  it('changing the passphrase and starting over: the same', async () => {
    await encryptedAccount();
    await rememberKey();
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await mountStoreNow();
    await until(() => ref.api?.syncStatus?.lock === 'unlocked');
    const controls = () => ref.api!.syncControls!;
    await expect(controls().changePassphrase('password123')).rejects.toMatchObject({ code: 'weak-passphrase' });
    await expect(controls().prepareReset('password123')).rejects.toMatchObject({ code: 'weak-passphrase' });
    strengthCtl.unavailable = true;
    await expect(controls().changePassphrase(STRONG)).rejects.toMatchObject({ code: 'strength-unavailable' });
    await expect(controls().prepareReset(STRONG)).rejects.toMatchObject({ code: 'strength-unavailable' });
    strengthCtl.unavailable = false;
    await controls().changePassphrase(STRONG); // goes through once it can be rated
  });
});

describe('cross-tab deletion in the app (round 3)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('Issue 1: Delete account dialog ends on the sign-in screen with the problem notice if deleteFirebaseUser rejects', async () => {
    await encryptedAccount([sampleMed()], [recentLog()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [recentLog()] });
    signedIn();

    const auth = await import('./auth');
    vi.mocked(auth.reauthenticateForDeletion).mockResolvedValueOnce(true);
    vi.mocked(auth.deleteFirebaseUser).mockRejectedValueOnce(
      new Error('For your security, Google needs you to confirm your account again.'),
    );

    await mountApp();
    expect(text()).toContain('Lisinopril');

    await fromAccountMenu('Delete account');
    const dialog = dialogs()[0];
    expect(dialog).toBeDefined();
    const input = walkEls(dialog!, (el) => el.tagName === 'INPUT')[0]!;
    await act(async () => reactProps(input).onChange({ target: { value: 'DELETE' } }));
    const form = walkEls(dialog!, (el) => el.tagName === 'FORM')[0]!;
    await act(async () => reactProps(form).onSubmit({ preventDefault() {} }));

    await until(() => text().includes("couldn't be removed yet"));
    expect(text()).toContain('Sign in with Google');
    expect(text()).toContain("couldn't be removed yet");
    expect(text()).toContain("To finish, sign in with Google again: it's removed then.");
    expect(text()).not.toContain('Lisinopril');
    expect(text()).not.toContain('Your medications');
    expect(dialogs()).toHaveLength(0);
    expect(state.accounts.has(USER_ID)).toBe(false);
  });

  for (const who of ['guest', 'google'] as const) {
    it(`Issue 5: ${who} mark written between App's first render and its effects ends on the sign-in screen with the deleted notice`, async () => {
      const userId = who === 'guest' ? GUEST.id : GOOGLE_USER.id;
      if (who === 'google') {
        await encryptedAccount([sampleMed()]);
        await rememberKey();
        state.storage.set(`medtracker.synced.${UID}`, '1');
        state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
        signedIn(GOOGLE_USER);
      } else {
        state.accounts.set('guest', { version: 1, medications: [sampleMed()], doseLogs: [] });
        signedIn(GUEST);
      }

      // Write the deletion mark right after App's initial render checks isAccountDeleted (before effects run).
      const session = await import('./session');
      const realIsAccountDeleted = session.isAccountDeleted;
      vi.spyOn(session, 'isAccountDeleted').mockImplementationOnce((id) => {
        const res = realIsAccountDeleted(id);
        state.storage.set(
          'medtracker.deletedAccounts',
          JSON.stringify({ [userId]: { mark: 'm-race', at: Date.now(), wiped: true } }),
        );
        return res;
      });

      await mountApp();
      await until(() => text().includes('Sign in with Google'));
      expect(text()).toContain('This account was deleted, so it was signed out in this tab too.');
      expect(text()).not.toContain('Loading…');
      expect(text()).not.toContain('Lisinopril');
      expect(push.stopLocalReminders).toHaveBeenCalled();
    });
  }

  it('Issue 6: watchAuth seeing an account deleted on this device signs out with the deleted notice', async () => {
    await encryptedAccount([sampleMed()]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    signedIn();

    await mountApp();
    expect(text()).toContain('Lisinopril');
    push.stopLocalReminders.mockClear();

    state.storage.set(
      'medtracker.deletedAccounts',
      JSON.stringify({ [USER_ID]: { mark: 'del-other-tab', at: Date.now(), wiped: true } }),
    );
    for (const cb of [...state.authListeners]) await act(async () => cb(GOOGLE_USER));

    await until(() => text().includes('Sign in with Google'));
    expect(text()).toContain('This account was deleted, so it was signed out in this tab too.');
    expect(text()).not.toContain('Lisinopril');
    expect(push.stopLocalReminders).toHaveBeenCalled();
  });

  it('Issue 3(a): tab opened while deletion is in flight reloads on a cancelled broadcast', async () => {
    signedIn();
    state.storage.set('medtracker.signingOut', JSON.stringify({ userId: USER_ID, at: Date.now(), tab: 'other' }));

    await mountApp();
    expect(text()).toContain('Sign in with Google');
    expect(location.reload).not.toHaveBeenCalled();

    const ch = new BroadcastChannel('medtracker-session');
    try {
      ch.postMessage({ type: 'cancelled', userId: USER_ID });
      await until(() => vi.mocked(location.reload).mock.calls.length > 0);
    } finally {
      ch.close();
    }
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it('Issue 3(b): tab opened while deletion is in flight reloads once the marker becomes stale', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    state.storage.set('medtracker.signingOut', JSON.stringify({ userId: USER_ID, at: Date.now(), tab: 'other' }));

    await mountApp();
    expect(text()).toContain('Sign in with Google');
    expect(location.reload).not.toHaveBeenCalled();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(location.reload).toHaveBeenCalledTimes(1);
  });

  it('Issue 3(b): tab opened while deletion is in flight does not reload if marked deleted before marker goes stale', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    signedIn();
    state.storage.set('medtracker.signingOut', JSON.stringify({ userId: USER_ID, at: Date.now(), tab: 'other' }));

    await mountApp();
    expect(text()).toContain('Sign in with Google');

    state.storage.set(
      'medtracker.deletedAccounts',
      JSON.stringify({ [USER_ID]: { mark: 'del-1', at: Date.now(), wiped: true } }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    expect(location.reload).not.toHaveBeenCalled();
  });

  it('Issue 7: signing in as guest after an interrupted guest deletion waits out the stale marker and wipes pre-deletion medications', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    state.accounts.set('guest', {
      version: 1,
      medications: [sampleMed({ id: 'g-old', name: 'Metformin' })],
      doseLogs: [recentLog({ medId: 'g-old' })],
    });
    state.storage.set(
      'medtracker.deletedAccounts',
      JSON.stringify({ guest: { mark: 'del-guest', at: Date.now() - 10_000 } }),
    );
    state.storage.set('medtracker.signingOut', JSON.stringify({ userId: 'guest', at: Date.now(), tab: 'dead-tab' }));

    await mountApp();
    expect(text()).toContain('Continue without an account');

    await act(async () => buttons('Continue without an account')[0]!.click());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(61_000);
    });
    await until(() => text().includes('Add your first medication'));

    expect(text()).not.toContain('Metformin');
    expect(text()).toContain('Add your first medication');
    expect(state.accounts.get('guest')?.medications ?? []).toEqual([]);
    const deleted = JSON.parse(state.storage.get('medtracker.deletedAccounts')!) as Record<string, { wiped?: boolean; resumed?: boolean }>;
    expect(deleted.guest?.wiped).toBe(true);
    expect(deleted.guest?.resumed).toBe(true);
  });

  it('Issue 8: deliberately signing back in as guest after deletion in another tab stays signed in on focus and checkDeletedElsewhere', async () => {
    const winListeners = new Map<string, Set<(e: unknown) => void>>();
    vi.stubGlobal('addEventListener', (t: string, fn: (e: unknown) => void) => {
      if (!winListeners.has(t)) winListeners.set(t, new Set());
      winListeners.get(t)!.add(fn);
    });
    vi.stubGlobal('removeEventListener', (t: string, fn: (e: unknown) => void) => {
      winListeners.get(t)?.delete(fn);
    });
    vi.stubGlobal('dispatchEvent', (ev: { type: string }) => {
      for (const fn of [...(winListeners.get(ev.type) ?? [])]) fn(ev);
      return true;
    });

    await mountApp();
    expect(text()).toContain('Continue without an account');

    // Another tab deleted guest while this tab was on the sign-in screen (not yet in session's known map).
    state.storage.set(
      'medtracker.deletedAccounts',
      JSON.stringify({ guest: { mark: 'del-guest', at: Date.now(), wiped: true } }),
    );

    await click(buttons('Continue without an account')[0]);
    await until(() => text().includes('Add your first medication'));

    await act(async () => void window.dispatchEvent({ type: 'focus' } as Event));
    const session = await import('./session');
    await act(async () => session.checkDeletedElsewhere());
    await settle(4);

    expect(text()).toContain('Add your first medication');
    expect(text()).not.toContain('This account was deleted');
    expect(text()).not.toContain('Sign in with Google');
  });

  it('Issue 10: cloud snapshot arriving after a deletion mark is written does not enqueue, keep, or write to Firestore', async () => {
    const l1 = recentLog();
    await encryptedAccount([sampleMed()], [l1]);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [l1] });

    const fs = await import('firebase/firestore');
    const origOnSnapshot = vi.mocked(fs.onSnapshot).getMockImplementation()!;
    let logsNext: ((s: unknown) => void) | undefined;
    vi.mocked(fs.onSnapshot).mockImplementation(((
      ref: { path: string },
      opts: unknown,
      onNext: (s: unknown) => void,
      onError?: (e: unknown) => void,
    ) => {
      if (ref.path === `users/${UID}/logs`) logsNext = onNext;
      return origOnSnapshot(ref as never, opts as never, onNext as never, onError as never);
    }) as never);

    signedIn();
    await mountApp();
    await until(() => text().includes('Lisinopril') && !!logsNext);
    await settle(6);

    const batchCallsBefore = vi.mocked(fs.writeBatch).mock.calls.length;
    expect(state.storage.get(`medtracker.syncq.${UID}`)).toBeUndefined();
    expect(state.storage.get(`medtracker.kept.${UID}`)).toBeUndefined();

    // If sync attempted to flush anyway, Firestore would refuse it (causing kept to be written).
    const refused = Object.assign(new Error('denied'), { code: 'permission-denied' });
    vi.mocked(fs.writeBatch).mockImplementation(
      () => ({ set: vi.fn(), delete: vi.fn(), update: vi.fn(), commit: vi.fn(() => Promise.reject(refused)) }) as never,
    );

    // Another tab silently marks the account deleted (no broadcast).
    state.storage.set(
      'medtracker.deletedAccounts',
      JSON.stringify({ [USER_ID]: { mark: 'del-silent', at: Date.now(), wiped: true } }),
    );

    const setItemSpy = vi.spyOn(localStorage, 'setItem');
    // Deliver a cloud snapshot with an orphan plaintext log in its own doc (local m1 and l1 are
    // untouched so reconcile keeps the exact same object references and skips applyRemote, while
    // tidy-ups + enqueueRefs + flush + keepRefusedLogs would run without sync's isEnded guard).
    const orphan = recentLog({ id: 'l-orphan', medId: 'm-gone' });
    await act(async () =>
      logsNext!({
        docChanges: () => [{ type: 'added', doc: { id: logDocId(orphan), data: () => ({ logs: { [orphan.id]: orphan } }) } }],
        metadata: { fromCache: false, hasPendingWrites: false },
      }),
    );
    await settle(10);

    const enqueued = setItemSpy.mock.calls.some(([k]) => k === `medtracker.syncq.${UID}`);
    expect(enqueued).toBe(false);
    expect(state.storage.get(`medtracker.syncq.${UID}`)).toBeUndefined();
    expect(state.storage.get(`medtracker.kept.${UID}`)).toBeUndefined();
    expect(vi.mocked(fs.writeBatch).mock.calls.length).toBe(batchCallsBefore);
  });

  it('Issue 11: prepareSetup stopped between transaction and key storage rejects and does not keep the device key', async () => {
    const STRONG = 'zebra quartz ninja velvet tomato';
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await mountStoreNow();
    await until(() => ref.api?.syncStatus?.lock === 'needs-setup');

    const prepared = await ref.api!.syncControls!.prepareSetup(STRONG);
    const { saveDeviceKey } = await import('./keyStore');
    const gate = deferredVoid();
    let saving = false;
    vi.mocked(saveDeviceKey).mockImplementationOnce(async (uid, value) => {
      saving = true;
      await gate.promise;
      state.deviceKeys.set(uid, value);
    });

    const finishPromise = prepared.finish();
    await until(() => saving);

    await act(async () => root!.unmount());
    root = null;
    gate.resolve();

    await expect(finishPromise).rejects.toMatchObject({ code: 'not-ready' });
    expect(state.deviceKeys.has(UID)).toBe(false);
  });

  it('Issue 11: prepareSetup stopped before finish is called rejects and does not keep the device key', async () => {
    const STRONG = 'zebra quartz ninja velvet tomato';
    state.accounts.set(USER_ID, { version: 1, medications: [sampleMed()], doseLogs: [] });
    const ref = await mountStoreNow();
    await until(() => ref.api?.syncStatus?.lock === 'needs-setup');

    const prepared = await ref.api!.syncControls!.prepareSetup(STRONG);
    await act(async () => root!.unmount());
    root = null;

    await expect(prepared.finish()).rejects.toMatchObject({ code: 'not-ready' });
    expect(state.deviceKeys.has(UID)).toBe(false);
  });
});
