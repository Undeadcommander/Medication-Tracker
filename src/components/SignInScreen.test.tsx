// Regression tests for SignInScreen (#3 iOS standalone return/stall handling, #7 waiting-box focus).
import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authCtl = vi.hoisted(() => ({
  standaloneIOS: true,
}));

vi.mock('../lib/auth', () => ({
  BUILD_ID: 'test-build',
  FIREBASE_CONFIGURED: true,
  GUEST_USER: { id: 'guest', name: 'Guest', provider: 'guest' as const },
  isStandaloneIOS: vi.fn(() => authCtl.standaloneIOS),
  preloadFirebaseAuth: vi.fn(async () => {}),
  signInWithGoogle: vi.fn(async () => null),
  currentGoogleUser: vi.fn(async () => null),
  lastSignInAttempt: vi.fn(() => null),
  noteSignInStalled: vi.fn(),
}));

vi.mock('../lib/sync', () => ({
  preloadSync: vi.fn(),
}));

import { SignInScreen } from './SignInScreen';
import * as auth from '../lib/auth';

// ---------- minimal DOM + window/document event shim ----------

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
  dispatchEvent(ev: Record<string, unknown>): boolean;
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
    dispatchEvent(ev) {
      ev.target ??= doc;
      ev.currentTarget = doc;
      for (const fn of [...(doc._listeners.get(ev.type as string) ?? [])]) fn.call(doc, ev);
      return true;
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

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const GOOGLE_USER: auth.User = {
  id: 'firebase:u1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  provider: 'google',
};

let fakeDoc: FakeDoc;
let winListeners: Map<string, Set<(e: unknown) => void>>;
let root: Root | null = null;

const buttonsContaining = (part: string) =>
  walkEls(fakeDoc.documentElement, (el) => el.tagName === 'BUTTON' && el.textContent.includes(part));
const buttons = (label: string) =>
  walkEls(fakeDoc.documentElement, (el) => el.tagName === 'BUTTON' && el.textContent.trim() === label);
const text = () => fakeDoc.body.textContent;

async function flushMicrotasks(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

function fireWindowEvent(type: string) {
  const ev = { type };
  for (const fn of [...(winListeners.get(type) ?? [])]) fn.call(globalThis, ev);
}

beforeEach(() => {
  vi.clearAllMocks();
  authCtl.standaloneIOS = true;
  vi.mocked(auth.isStandaloneIOS).mockImplementation(() => authCtl.standaloneIOS);
  vi.mocked(auth.preloadFirebaseAuth).mockResolvedValue(undefined);
  vi.mocked(auth.signInWithGoogle).mockResolvedValue(null);
  vi.mocked(auth.currentGoogleUser).mockResolvedValue(null);
  vi.mocked(auth.lastSignInAttempt).mockReturnValue(null);

  fakeDoc = createFakeDoc();
  const rootDiv = fakeDoc.createElement('div');
  rootDiv.setAttribute('id', 'root');
  fakeDoc.body.appendChild(rootDiv);

  winListeners = new Map();
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('document', fakeDoc);
  vi.stubGlobal('addEventListener', (t: string, fn: (e: unknown) => void) => {
    if (!winListeners.has(t)) winListeners.set(t, new Set());
    winListeners.get(t)!.add(fn);
  });
  vi.stubGlobal('removeEventListener', (t: string, fn: (e: unknown) => void) => {
    winListeners.get(t)?.delete(fn);
  });
  vi.stubGlobal('dispatchEvent', (ev: { type: string }) => {
    fireWindowEvent(ev.type);
    return true;
  });
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('HTMLElement', function () {});
  vi.stubGlobal('HTMLIFrameElement', function () {});
  vi.stubGlobal('Element', function () {});
  vi.stubGlobal('Node', function () {});
  vi.stubGlobal('location', { reload: vi.fn() });
});

afterEach(async () => {
  vi.useRealTimers();
  try {
    if (root) {
      await act(async () => root!.unmount());
    }
  } finally {
    root = null;
    vi.unstubAllGlobals();
  }
});

async function mountScreen(props: React.ComponentProps<typeof SignInScreen>) {
  root ??= createRoot(fakeDoc.getElementById('root') as unknown as Element);
  await act(async () => root!.render(React.createElement(SignInScreen, props)));
  await flushMicrotasks();
}

describe('#3 SignInScreen iOS standalone return & stall handling', () => {
  it('delivers at most once across repeated return events, clears busy state, and ignores late signInWithGoogle resolution', async () => {
    const signInDeferred = deferred<auth.User | null>();
    vi.mocked(auth.signInWithGoogle).mockReturnValueOnce(signInDeferred.promise);
    vi.mocked(auth.currentGoogleUser).mockResolvedValue(GOOGLE_USER);
    const onSignIn = vi.fn();

    await mountScreen({ onSignIn });
    const googleBtn = buttonsContaining('Sign in with Google')[0]!;
    expect(googleBtn).toBeDefined();

    await act(async () => googleBtn.click());
    expect(googleBtn.hasAttribute('disabled')).toBe(true);
    expect(googleBtn.textContent).toContain('Signing in…');

    // Simulate returning to the iOS home-screen app multiple times (visibilitychange, focus, pageshow).
    await act(async () => {
      fakeDoc.dispatchEvent({ type: 'visibilitychange' });
      fireWindowEvent('focus');
      fireWindowEvent('pageshow');
      fakeDoc.dispatchEvent({ type: 'visibilitychange' });
      fireWindowEvent('focus');
    });
    await flushMicrotasks(6);

    expect(onSignIn).toHaveBeenCalledTimes(1);
    expect(onSignIn).toHaveBeenCalledWith(GOOGLE_USER);

    // Button is no longer stuck busy / "Signing in…".
    expect(googleBtn.hasAttribute('disabled')).toBe(false);
    expect(googleBtn.getAttribute('aria-busy')).toBe('false');
    expect(googleBtn.textContent).toContain('Sign in with Google');
    expect(googleBtn.textContent).not.toContain('Signing in…');

    // A late resolution of the original signInWithGoogle() call must not deliver a second time.
    await act(async () => signInDeferred.resolve(GOOGLE_USER));
    await flushMicrotasks(4);
    expect(onSignIn).toHaveBeenCalledTimes(1);
  });

  it('hides the "taking longer" stall alert while waiting is set even past 8s and 60s', async () => {
    vi.useFakeTimers();
    const signInDeferred = deferred<auth.User | null>();
    vi.mocked(auth.signInWithGoogle).mockReturnValueOnce(signInDeferred.promise);
    vi.mocked(auth.currentGoogleUser).mockResolvedValue(null);
    const onSignIn = vi.fn();

    await mountScreen({ onSignIn, waiting: null });
    const googleBtn = buttonsContaining('Sign in with Google')[0]!;
    await act(async () => googleBtn.click());

    // Waiting box becomes active while the Google attempt is still busy.
    await mountScreen({ onSignIn, waiting: GOOGLE_USER });
    expect(text()).toContain("Removing this account's old data");

    // Advance past 8s return stall timer and past 60s start stall timer.
    await act(async () => {
      fakeDoc.dispatchEvent({ type: 'visibilitychange' });
      await vi.advanceTimersByTimeAsync(9_000);
      await vi.advanceTimersByTimeAsync(61_000);
    });

    expect(text()).toContain("Removing this account's old data");
    expect(text()).not.toContain('This is taking longer than it should');
  });
});

describe('#7 Focus management around the waiting box', () => {
  it('moves focus to the waiting Cancel button and returns it to the Google button when waiting clears', async () => {
    const signInDeferred = deferred<auth.User | null>();
    vi.mocked(auth.signInWithGoogle).mockReturnValueOnce(signInDeferred.promise);
    const onSignIn = vi.fn();

    await mountScreen({ onSignIn, waiting: null });
    const googleBtn = buttonsContaining('Sign in with Google')[0]!;
    await act(async () => googleBtn.click());
    await act(async () => signInDeferred.resolve(GOOGLE_USER));
    await flushMicrotasks();

    await mountScreen({ onSignIn, waiting: GOOGLE_USER });
    const cancelBtn = buttons('Cancel')[0]!;
    expect(cancelBtn).toBeDefined();
    expect(fakeDoc.activeElement).toBe(cancelBtn);

    await mountScreen({ onSignIn, waiting: null });
    expect(fakeDoc.activeElement).toBe(googleBtn);
  });

  it('moves focus to the waiting Cancel button and returns it to the guest button when a guest wait clears', async () => {
    const onSignIn = vi.fn();

    await mountScreen({ onSignIn, waiting: null });
    const guestBtn = buttons('Continue without an account')[0]!;
    await act(async () => guestBtn.click());

    await mountScreen({ onSignIn, waiting: auth.GUEST_USER });
    const cancelBtn = buttons('Cancel')[0]!;
    expect(cancelBtn).toBeDefined();
    expect(fakeDoc.activeElement).toBe(cancelBtn);

    await mountScreen({ onSignIn, waiting: null });
    expect(fakeDoc.activeElement).toBe(guestBtn);
  });
});
