import React, { act } from 'react';
import { flushSync } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PreparedKeyChange, SyncHandle, SyncStatus } from '../lib/sync';
import { loadStrengthChecker } from '../lib/vault';

vi.hoisted(() => {
  (globalThis as Record<string, unknown>).location = {
    href: 'http://localhost/',
    search: '',
    pathname: '/',
    hostname: 'localhost',
    protocol: 'http:',
  };
});

// The strength checker (zxcvbn) is loaded lazily from this module: the first test below makes the first
// load fail, then holds the second, to check the dialog accepts nothing meanwhile.
const strengthEngine = vi.hoisted(() => ({ failNext: true, gate: Promise.resolve() as Promise<unknown> }));
vi.mock('../lib/strengthEngine', async (importOriginal) => {
  if (strengthEngine.failNext) {
    strengthEngine.failNext = false;
    throw new Error('Failed to fetch dynamically imported module');
  }
  await strengthEngine.gate;
  return importOriginal<typeof import('../lib/strengthEngine')>();
});

// Decrypting a backup is under the test's control (see the import describe below).
const vaultCtl = vi.hoisted(() => ({ decrypts: [] as { resolve: (d: unknown) => void }[] }));
vi.mock('../lib/vault', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/vault')>();
  return {
    ...real,
    readVaultFile: vi.fn(async (f: { name: string }) => ({ file: f.name })),
    decryptVault: vi.fn(() => new Promise((resolve) => vaultCtl.decrypts.push({ resolve }))),
  };
});

vi.mock('../lib/account', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/account')>();
  return {
    ...real,
    deleteAccount: vi.fn(real.deleteAccount),
    signOutAndClear: vi.fn(real.signOutAndClear),
  };
});

import { deleteAccount, signOutAndClear, type DeleteResult } from '../lib/account';
import { DeleteAccountDialog } from './DeleteAccountDialog';
import { ExportImportDialog } from './ExportImportDialog';
import { SyncEncryptionDialog } from './SyncEncryptionDialog';
import { SignOutDialog } from './SignOutDialog';

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

let fakeDoc: FakeDoc;
let root: Root | null = null;

function reactProps(el: FakeEl): Record<string, (e: unknown) => void> {
  const k = Object.keys(el).find((key) => key.startsWith('__reactProps$'));
  if (!k) throw new Error(`no React props on ${el.tagName}`);
  return (el as unknown as Record<string, Record<string, (e: unknown) => void>>)[k]!;
}

const buttons = (label: string) =>
  walkEls(fakeDoc.documentElement, (el) => el.tagName === 'BUTTON' && el.textContent.trim() === label);

beforeEach(() => {
  fakeDoc = createFakeDoc();
  const rootDiv = fakeDoc.createElement('div');
  rootDiv.setAttribute('id', 'root');
  fakeDoc.body.appendChild(rootDiv);
  (globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
  vi.stubGlobal('document', fakeDoc);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('HTMLElement', function () {});
  vi.stubGlobal('HTMLIFrameElement', function () {});
  vi.stubGlobal('Element', function () {});
  vi.stubGlobal('Node', function () {});
});

afterEach(async () => {
  if (root) {
    await act(async () => root!.unmount());
    root = null;
  }
  vi.unstubAllGlobals();
});

// Keep this describe first in the file: it needs the strength checker not to have loaded yet.
describe('passphrase strength check while loading (A)', () => {
  it('accepts nothing (sync dialog and export dialog) while the checker loads or when it cannot load, and rates once it has', async () => {
    const PHRASE = 'correct horse battery staple';
    const prepareSetup = vi.fn();
    const controls = { prepareSetup } as unknown as SyncHandle;
    const unmount = async () => {
      await act(async () => root!.unmount());
      root = null;
    };
    const render = async (el: React.ReactElement) => {
      root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
      await act(async () => root!.render(el));
    };
    const submit = () => walkEls(fakeDoc.body, (el) => el.tagName === 'BUTTON' && el.getAttribute('type') === 'submit')[0]!;
    const form = () => walkEls(fakeDoc.body, (el) => el.tagName === 'FORM')[0]!;
    /** Type the passphrase into the first two inputs (passphrase, confirm). */
    const type = async (value: string) => {
      const inputs = walkEls(fakeDoc.body, (el) => el.tagName === 'INPUT');
      await act(async () => {
        reactProps(inputs[0]!).onChange({ target: { value } });
        reactProps(inputs[1]!).onChange({ target: { value } });
      });
    };
    const trySubmit = async () => {
      await act(async () => {
        void reactProps(form()).onSubmit({ preventDefault() {} });
      });
    };
    const text = () => fakeDoc.body.textContent;
    const syncDialog = () =>
      React.createElement(SyncEncryptionDialog, {
        inline: true,
        status: { state: 'setup', lock: 'needs-setup', cloudLoaded: false },
        controls,
        onClose: () => {},
      });
    const exportDialog = () =>
      React.createElement(ExportImportDialog, { data: { version: 1, medications: [], doseLogs: [] }, onImport: () => {}, onClose: () => {} });

    // 1. Sync dialog: the first load fails (offline): an error with Retry, and nothing can be submitted.
    await render(syncDialog());
    await type(PHRASE);
    expect(text()).toContain("Couldn't load the passphrase strength check");
    expect(submit().hasAttribute('disabled')).toBe(true);
    await trySubmit();
    expect(prepareSetup).not.toHaveBeenCalled();
    await unmount();

    // 2. Export dialog, loading fails again: the same.
    strengthEngine.failNext = true;
    await render(exportDialog());
    await type(PHRASE);
    expect(text()).toContain("Couldn't load the passphrase strength check");
    expect(submit().hasAttribute('disabled')).toBe(true);

    // 3. Retry, and the load is slow: "Checking strength…", still nothing accepted.
    let release!: () => void;
    strengthEngine.gate = new Promise<void>((r) => (release = r));
    await act(async () => buttons('Retry')[0]!.click());
    expect(text()).toContain('Checking strength…');
    expect(text()).not.toContain("Couldn't load the passphrase strength check");
    expect(submit().hasAttribute('disabled')).toBe(true);
    await unmount();

    // 4. Sync dialog while that load is still going: the same.
    await render(syncDialog());
    await type(PHRASE);
    expect(text()).toContain('Checking strength…');
    expect(submit().hasAttribute('disabled')).toBe(true);
    await trySubmit();
    expect(prepareSetup).not.toHaveBeenCalled();

    // 5. Loaded: rated, and now it can be submitted.
    await act(async () => {
      release();
      await loadStrengthChecker();
    });
    expect(text()).toContain('Strength: Very strong');
    expect(text()).not.toContain('Checking strength…');
    expect(submit().hasAttribute('disabled')).toBe(false);
    await unmount();
    await render(exportDialog());
    await type(PHRASE);
    expect(text()).toContain('Strength: Very strong');
    expect(submit().hasAttribute('disabled')).toBe(false);
  });
});

describe('SyncEncryptionDialog regressions', () => {
  beforeAll(() => loadStrengthChecker());
  const unlockedStatus: SyncStatus = { state: 'synced', lock: 'unlocked', cloudLoaded: true };
  const lockedStatus: SyncStatus = { state: 'locked', lock: 'locked', cloudLoaded: false };
  const setupStatus: SyncStatus = { state: 'setup', lock: 'needs-setup', cloudLoaded: false };

  it('D2: disables Cancel on reset view while prepareReset is running', async () => {
    let resolveReset!: (v: PreparedKeyChange) => void;
    const controls = {
      prepareReset: vi.fn(
        () =>
          new Promise<PreparedKeyChange>((r) => {
            resolveReset = r;
          }),
      ),
    } as unknown as SyncHandle;
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () =>
      root!.render(
        React.createElement(SyncEncryptionDialog, {
          inline: true,
          status: lockedStatus,
          controls,
          onClose: () => {},
        }),
      ),
    );
    await act(async () => buttons('Lost both? Start over')[0]!.click());
    const inputs = walkEls(fakeDoc.body, (el) => el.tagName === 'INPUT');
    await act(async () => {
      reactProps(inputs[0]!).onChange({ target: { value: 'correct-horse-battery-staple' } });
      reactProps(inputs[1]!).onChange({ target: { value: 'correct-horse-battery-staple' } });
      reactProps(inputs[2]!).onChange({ target: { value: 'RESET' } });
    });
    const form = walkEls(fakeDoc.body, (el) => el.tagName === 'FORM')[0]!;
    await act(async () => {
      void reactProps(form).onSubmit({ preventDefault() {} });
    });
    expect(fakeDoc.body.textContent).toContain('Creating new keys…');
    const cancelBtn = buttons('Cancel')[0]!;
    expect(cancelBtn.hasAttribute('disabled')).toBe(true);
    await act(async () => cancelBtn.click());
    expect(fakeDoc.body.textContent).toContain('Start over with new keys');
    expect(fakeDoc.body.textContent).not.toContain('Unlock cloud sync');

    await act(async () => {
      resolveReset({ recoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG', finish: async () => {} });
    });
    expect(fakeDoc.body.textContent).toContain('Save your recovery key');
  });

  it('D2: disables Not now during passphrase change on recovered view and setup', async () => {
    let resolveChange!: () => void;
    const changeControls = {
      changePassphrase: vi.fn(
        () =>
          new Promise<void>((r) => {
            resolveChange = r;
          }),
      ),
    } as unknown as SyncHandle;
    const onCloseRecovered = vi.fn();
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () =>
      root!.render(
        React.createElement(SyncEncryptionDialog, {
          status: unlockedStatus,
          controls: changeControls,
          initialView: 'recovered',
          onClose: onCloseRecovered,
        }),
      ),
    );
    let inputs = walkEls(fakeDoc.body, (el) => el.tagName === 'INPUT');
    await act(async () => {
      reactProps(inputs[0]!).onChange({ target: { value: 'correct-horse-battery-staple' } });
      reactProps(inputs[1]!).onChange({ target: { value: 'correct-horse-battery-staple' } });
    });
    let form = walkEls(fakeDoc.body, (el) => el.tagName === 'FORM')[0]!;
    await act(async () => {
      void reactProps(form).onSubmit({ preventDefault() {} });
    });
    expect(fakeDoc.body.textContent).toContain('Changing passphrase…');
    const recoveredNotNow = buttons('Not now')[0]!;
    expect(recoveredNotNow.hasAttribute('disabled')).toBe(true);
    await act(async () => recoveredNotNow.click());
    expect(onCloseRecovered).not.toHaveBeenCalled();
    await act(async () => resolveChange());
    expect(fakeDoc.body.textContent).toContain('Passphrase changed.');

    let resolveSetup!: (v: PreparedKeyChange) => void;
    const setupControls = {
      prepareSetup: vi.fn(
        () =>
          new Promise<PreparedKeyChange>((r) => {
            resolveSetup = r;
          }),
      ),
    } as unknown as SyncHandle;
    const onCloseSetup = vi.fn();
    await act(async () => root!.unmount());
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () =>
      root!.render(
        React.createElement(SyncEncryptionDialog, {
          status: setupStatus,
          controls: setupControls,
          onClose: onCloseSetup,
        }),
      ),
    );
    inputs = walkEls(fakeDoc.body, (el) => el.tagName === 'INPUT');
    await act(async () => {
      reactProps(inputs[0]!).onChange({ target: { value: 'correct-horse-battery-staple' } });
      reactProps(inputs[1]!).onChange({ target: { value: 'correct-horse-battery-staple' } });
    });
    form = walkEls(fakeDoc.body, (el) => el.tagName === 'FORM')[0]!;
    await act(async () => {
      void reactProps(form).onSubmit({ preventDefault() {} });
    });
    expect(fakeDoc.body.textContent).toContain('Creating your keys…');
    const setupNotNow = buttons('Not now')[0]!;
    expect(setupNotNow.hasAttribute('disabled')).toBe(true);
    await act(async () => setupNotNow.click());
    expect(onCloseSetup).not.toHaveBeenCalled();
    await act(async () => {
      resolveSetup({ recoveryKey: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG', finish: async () => {} });
    });
    expect(fakeDoc.body.textContent).toContain('Save your recovery key');
  });

  it('D2: late result after abandoning an operation does not fire post-await callbacks', async () => {
    let resolveForget!: () => void;
    const controls = {
      forgetKey: vi.fn(
        () =>
          new Promise<void>((r) => {
            resolveForget = r;
          }),
      ),
    } as unknown as SyncHandle;
    const onClose = vi.fn();
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () =>
      root!.render(
        React.createElement(SyncEncryptionDialog, {
          status: unlockedStatus,
          controls,
          onClose,
        }),
      ),
    );
    await act(async () => buttons('Forget key on this device')[0]!.click());
    await act(async () => {
      buttons('Yes, forget the key')[0]!.click();
    });
    expect(fakeDoc.body.textContent).toContain('Forgetting…');

    await act(async () => root!.unmount());
    root = null;

    await act(async () => {
      resolveForget();
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('D2: inline recovery-key unlock calls onUnlocked("recovered") even if unmounted before resolve, and inline passphrase unlock calls onUnlocked(null)', async () => {
    let resolveRecoveryUnlock!: () => void;
    const recoveryControls = {
      unlock: vi.fn(
        () =>
          new Promise<void>((r) => {
            resolveRecoveryUnlock = r;
          }),
      ),
    } as unknown as SyncHandle;
    const onUnlockedRecovery = vi.fn();
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () =>
      root!.render(
        React.createElement(SyncEncryptionDialog, {
          inline: true,
          status: lockedStatus,
          controls: recoveryControls,
          onUnlocked: onUnlockedRecovery,
          onClose: () => {},
        }),
      ),
    );
    await act(async () => buttons('Forgot it? Use your recovery key')[0]!.click());
    const recoveryInput = walkEls(fakeDoc.body, (el) => el.tagName === 'INPUT')[0]!;
    await act(async () => {
      reactProps(recoveryInput).onChange({ target: { value: 'AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG' } });
    });
    const recoveryForm = walkEls(fakeDoc.body, (el) => el.tagName === 'FORM')[0]!;
    await act(async () => {
      void reactProps(recoveryForm).onSubmit({ preventDefault() {} });
    });
    expect(fakeDoc.body.textContent).toContain('Unlocking…');
    expect(recoveryControls.unlock).toHaveBeenCalledWith('AAAA-BBBB-CCCC-DDDD-EEEE-FFFF-GGGG', 'recovery');

    await act(async () => root!.unmount());
    root = null;

    await act(async () => {
      resolveRecoveryUnlock();
    });
    expect(onUnlockedRecovery).toHaveBeenCalledTimes(1);
    expect(onUnlockedRecovery).toHaveBeenCalledWith('recovered');

    let resolvePassphraseUnlock!: () => void;
    const passControls = {
      unlock: vi.fn(
        () =>
          new Promise<void>((r) => {
            resolvePassphraseUnlock = r;
          }),
      ),
    } as unknown as SyncHandle;
    const onUnlockedPass = vi.fn();
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () =>
      root!.render(
        React.createElement(SyncEncryptionDialog, {
          inline: true,
          status: lockedStatus,
          controls: passControls,
          onUnlocked: onUnlockedPass,
          onClose: () => {},
        }),
      ),
    );
    const passInput = walkEls(fakeDoc.body, (el) => el.tagName === 'INPUT')[0]!;
    await act(async () => {
      reactProps(passInput).onChange({ target: { value: 'correct-horse-battery-staple' } });
    });
    const passForm = walkEls(fakeDoc.body, (el) => el.tagName === 'FORM')[0]!;
    await act(async () => {
      void reactProps(passForm).onSubmit({ preventDefault() {} });
    });
    expect(passControls.unlock).toHaveBeenCalledWith('correct-horse-battery-staple', 'passphrase');
    await act(async () => {
      resolvePassphraseUnlock();
    });
    expect(onUnlockedPass).toHaveBeenCalledTimes(1);
    expect(onUnlockedPass).toHaveBeenCalledWith(null);
  });

  it('D3: resets generated passphrase box and Copy button after changing passphrase', async () => {
    const controls = {
      changePassphrase: vi.fn(async () => {}),
    } as unknown as SyncHandle;
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () =>
      root!.render(
        React.createElement(SyncEncryptionDialog, {
          status: unlockedStatus,
          controls,
          onClose: () => {},
        }),
      ),
    );
    await act(async () => buttons('Generate a strong passphrase')[0]!.click());
    expect(fakeDoc.body.textContent).toContain('Save it in a password manager');
    const code = walkEls(fakeDoc.body, (el) => el.tagName === 'CODE' && el.className.includes('ei-generated-text'))[0];
    expect(code).toBeDefined();
    expect(code!.textContent.length).toBeGreaterThan(10);
    expect(buttons('Copy')).toHaveLength(1);

    const form = walkEls(fakeDoc.body, (el) => el.tagName === 'FORM')[0]!;
    await act(async () => reactProps(form).onSubmit({ preventDefault() {} }));
    expect(controls.changePassphrase).toHaveBeenCalledTimes(1);
    expect(fakeDoc.body.textContent).toContain('Passphrase changed.');
    expect(walkEls(fakeDoc.body, (el) => el.tagName === 'CODE' && el.className.includes('ei-generated-text'))).toHaveLength(0);
    expect(buttons('Copy')).toHaveLength(0);
  });
});

describe('SignOutDialog regressions', () => {
  it('D4: hides medication names on the commit where locked flips to true before useEffect runs', async () => {
    const sync = {
      flushAll: vi.fn(async () => ({
        ok: false as const,
        reason: 'offline' as const,
        pending: { medications: ['Lisinopril'], deletedMedications: 0, doseLogs: 2, refused: 0 },
      })),
    } as unknown as SyncHandle;
    const el = (locked: boolean) =>
      React.createElement(SignOutDialog, {
        user: { id: 'firebase:u1', name: 'Ada', provider: 'google' },
        sync,
        locked,
        applyPendingTakes: async () => ({ applied: 0, waiting: 0 }),
        onUnlock: () => {},
        onSignedOut: () => {},
        onClose: () => {},
      });
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () => root!.render(el(false)));
    await act(async () => new Promise((r) => setTimeout(r, 20)));
    expect(fakeDoc.body.textContent).toContain('Lisinopril');

    // flushSync commits synchronously without running passive useEffects yet
    flushSync(() => root!.render(el(true)));
    expect(fakeDoc.body.textContent).not.toContain('Lisinopril');
    expect(fakeDoc.body.textContent).toContain('3 changes made on this device (unlock cloud sync to see them)');

    // Keeping the useEffect ensures names stay stripped even if locked flips back to false
    await act(async () => root!.render(el(false)));
    expect(fakeDoc.body.textContent).not.toContain('Lisinopril');
  });

  it('calls onSignedOut with result.problem and shows no error dialog when signOutAndClear resolves signed-out with a problem (#2)', async () => {
    vi.mocked(signOutAndClear).mockResolvedValueOnce({ status: 'signed-out', problem: 'X' });
    const onSignedOut = vi.fn();
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () =>
      root!.render(
        React.createElement(SignOutDialog, {
          user: { id: 'firebase:u1', name: 'Ada', provider: 'google' },
          sync: {} as SyncHandle,
          applyPendingTakes: async () => ({ applied: 0, waiting: 0 }),
          onUnlock: () => {},
          onSignedOut,
          onClose: () => {},
        }),
      ),
    );
    await act(async () => new Promise((r) => setTimeout(r, 20)));

    expect(onSignedOut).toHaveBeenCalledTimes(1);
    expect(onSignedOut).toHaveBeenCalledWith('X');
    expect(buttons('Close')).toHaveLength(0);
    expect(walkEls(fakeDoc.body, (el) => el.className.includes('alert-error'))).toHaveLength(0);
  });
});

describe('ExportImportDialog import (B2)', () => {
  const backup = (name: string) =>
    ({ version: 1, medications: [{ id: 'm1', name, dosage: '1 mg', color: '#000', schedule: {}, createdAt: '', updatedAt: '' }], doseLogs: [] });

  async function setup() {
    vaultCtl.decrypts.length = 0;
    const onImport = vi.fn();
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () =>
      root!.render(React.createElement(ExportImportDialog, { data: { version: 1, medications: [], doseLogs: [] }, onImport, onClose: () => {} })),
    );
    await act(async () => walkEls(fakeDoc.body, (el) => el.getAttribute('role') === 'tab' && el.textContent.trim() === 'Import')[0]!.click());
    const fileInput = () => walkEls(fakeDoc.body, (el) => el.tagName === 'INPUT' && el.id.endsWith('imp-file'))[0]!;
    const passInput = () => walkEls(fakeDoc.body, (el) => el.tagName === 'INPUT' && el.id.endsWith('imp-pass'))[0]!;
    const pick = async (name: string) =>
      act(async () => reactProps(fileInput()).onChange({ target: { files: [{ name }] } }));
    const type = async (value: string) => act(async () => reactProps(passInput()).onChange({ target: { value } }));
    const submit = async () =>
      act(async () => {
        void reactProps(walkEls(fakeDoc.body, (el) => el.tagName === 'FORM' && el.id.endsWith('import-form'))[0]!).onSubmit({ preventDefault() {} });
      });
    return { onImport, pick, type, submit };
  }

  it('a result for the old passphrase is dropped when the passphrase changes while decrypting', async () => {
    const t = await setup();
    await t.pick('a.medvault');
    await t.type('old passphrase');
    await t.submit();
    expect(fakeDoc.body.textContent).toContain('Decrypting…');
    await t.type('new passphrase'); // changed while decrypting
    await act(async () => vaultCtl.decrypts[0]!.resolve(backup('Stale')));
    expect(fakeDoc.body.textContent).not.toContain('Decrypted successfully');
    expect(fakeDoc.body.textContent).not.toContain('Decrypting…');
    expect(fakeDoc.body.textContent).not.toContain('This backup contains');
  });

  it('a result for the old file is dropped when another file is chosen while decrypting', async () => {
    const t = await setup();
    await t.pick('a.medvault');
    await t.type('pass phrase');
    await t.submit();
    await t.pick('b.medvault'); // another file while decrypting
    await act(async () => vaultCtl.decrypts[0]!.resolve(backup('Stale')));
    expect(fakeDoc.body.textContent).not.toContain('Decrypted successfully');
    expect(fakeDoc.body.textContent).toContain('b.medvault');
    // A fresh decryption of the new file works and shows its own result.
    await t.submit();
    await act(async () => vaultCtl.decrypts[1]!.resolve(backup('Fresh')));
    expect(fakeDoc.body.textContent).toContain('Decrypted successfully');
  });
});

describe('DeleteAccountDialog regressions (#12)', () => {
  it('ignores deleteAccount result and does not call onDeleted after unmount', async () => {
    let resolveDelete!: (r: DeleteResult) => void;
    vi.mocked(deleteAccount).mockImplementationOnce(
      () =>
        new Promise<DeleteResult>((r) => {
          resolveDelete = r;
        }),
    );
    const onDeleted = vi.fn();
    root = createRoot(fakeDoc.getElementById('root') as unknown as Element);
    await act(async () =>
      root!.render(
        React.createElement(DeleteAccountDialog, {
          user: { id: 'firebase:u1', name: 'Ada', email: 'ada@example.com', provider: 'google' },
          sync: {} as SyncHandle,
          medicationCount: 1,
          doseLogCount: 0,
          onExport: () => {},
          onDeleted,
          onClose: () => {},
        }),
      ),
    );

    const input = walkEls(fakeDoc.body, (el) => el.tagName === 'INPUT')[0]!;
    await act(async () => {
      reactProps(input).onChange({ target: { value: 'DELETE' } });
    });
    const form = walkEls(fakeDoc.body, (el) => el.tagName === 'FORM')[0]!;
    await act(async () => {
      void reactProps(form).onSubmit({ preventDefault() {} });
    });
    expect(deleteAccount).toHaveBeenCalledTimes(1);
    expect(fakeDoc.body.textContent).toContain('Confirm with Google in the pop-up…');

    await act(async () => root!.unmount());
    root = null;

    await act(async () => {
      resolveDelete({ deleted: true });
    });
    expect(onDeleted).not.toHaveBeenCalled();
  });
});
