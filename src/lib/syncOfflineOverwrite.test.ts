import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { createKeyBundle, decryptMed, encryptLog, encryptMed, unlockWithPassphrase, type KeyBundle } from './syncCrypto';
import { stampEdit } from './supply';
import { logDocId } from './syncOps';

const state = vi.hoisted(() => ({
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
  return {
    ...real,
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
    getFirebaseApp: vi.fn(async () => ({ app: {}, auth: {} })),
  };
});

const UID = 'u1';
const PASS = 'correct horse battery staple';
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

async function flushAsync(rounds = 4) {
  for (let i = 0; i < rounds; i++) {
    await new Promise((r) => setTimeout(r, 10));
  }
}

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await flushAsync(1);
  if (!cond()) throw new Error('until() timed out');
}

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  bundle ??= await createKeyBundle(UID, PASS, 100_000);
  state.decrypted.clear();
  state.deviceKeys.clear();
  state.storage.clear();
  state.metaDocs.clear();
  state.medDocs.clear();
  state.logDocs.clear();
  state.metaListeners.clear();
  state.medListeners.clear();
  state.logListeners.clear();
  vi.stubGlobal('navigator', { onLine: true });
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

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

// An open tab that has synced keeps queuing edits while offline. Uploading them then would write
// the whole medication over one changed on another device meanwhile (Firestore sends the queued
// write first on reconnecting), so uploads wait until the server's copy has been merged in.
type Commit = { path: string; data: Record<string, unknown> };

async function recordCommits(): Promise<Commit[]> {
  const fs = await import('firebase/firestore');
  const commits: Commit[] = [];
  vi.mocked(fs.writeBatch).mockImplementation((() => {
    const ops: Commit[] = [];
    return {
      set: (ref: { path: string }, data: Record<string, unknown>) => void ops.push({ path: ref.path, data }),
      update: (ref: { path: string }, data: Record<string, unknown>) => void ops.push({ path: ref.path, data }),
      delete: (ref: { path: string }) => void ops.push({ path: ref.path, data: {} }),
      commit: async () => void commits.push(...ops),
    };
  }) as never);
  return commits;
}

function deliver(kind: 'meds' | 'logs', fromCache: boolean, changes: unknown[] = []) {
  const listeners = (kind === 'meds' ? state.medListeners : state.logListeners).get(UID) ?? new Set();
  for (const l of listeners) l({ docChanges: () => changes, metadata: { fromCache, hasPendingWrites: false } });
}

describe('offline edits in an open tab wait for the server copy before uploading', () => {
  it('keeps a field changed on another device instead of overwriting it on reconnect', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const base = sampleMed({ notes: 'old notes' });
    await encryptedAccount([base], []);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    const commits = await recordCommits();

    const { startSync } = await import('./sync');
    let local: AppData = { version: 1, medications: [base], doseLogs: [] };
    let latest: import('./sync').SyncStatus | null = null;
    const handle = startSync({
      uid: UID,
      getLocal: () => local,
      applyRemote: (d) => {
        local = d;
      },
      onStatus: (s) => {
        latest = s;
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      await until(() => latest?.cloudLoaded === true);
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync(4);
      commits.length = 0;

      // Offline: Firestore reports its cached copy.
      deliver('meds', true);
      deliver('logs', true);
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync(4);

      // This device edits the notes while offline.
      const prev = local;
      const edited = stampEdit(base, { ...base, notes: 'take with food' }, '2026-02-01T00:00:00.000Z');
      local = { ...prev, medications: [edited] };
      handle.push(prev, local);
      await vi.advanceTimersByTimeAsync(200);
      await flushAsync(6);
      expect(commits).toHaveLength(0);

      // Another device changed the dosage meanwhile; back online, the server's copy arrives.
      const remote = stampEdit(base, { ...base, dosage: '20 mg' }, '2026-02-02T00:00:00.000Z');
      const env = (await encryptMed(bundle.dek, UID, remote, bundle.meta.keyId)) as unknown as Record<string, unknown>;
      state.medDocs.get(UID)!.set('m1', env);
      deliver('meds', false, [{ type: 'modified', doc: { id: 'm1', data: () => env } }]);
      deliver('logs', false);
      await vi.advanceTimersByTimeAsync(200);
      await until(() => commits.some((c) => c.path.endsWith('meds/m1')));

      const up = commits.filter((c) => c.path.endsWith('meds/m1'));
      for (const c of up) {
        const med = (await decryptMed(bundle.dek, UID, 'm1', c.data)) as Medication;
        expect(med.dosage).toBe('20 mg');
        expect(med.notes).toBe('take with food');
      }
      expect(local.medications[0]).toMatchObject({ dosage: '20 mg', notes: 'take with food' });
    } finally {
      handle.stop();
    }
  });

  it('holds uploads while the browser reports offline, before Firestore notices', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const base = sampleMed();
    await encryptedAccount([base], []);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');
    const commits = await recordCommits();
    const nav = { onLine: true };
    vi.stubGlobal('navigator', nav);
    const win = new EventTarget();
    vi.stubGlobal('window', win);

    const { startSync } = await import('./sync');
    let local: AppData = { version: 1, medications: [base], doseLogs: [] };
    let latest: import('./sync').SyncStatus | null = null;
    const handle = startSync({
      uid: UID,
      getLocal: () => local,
      applyRemote: (d) => {
        local = d;
      },
      onStatus: (s) => {
        latest = s;
      },
    });
    try {
      await vi.advanceTimersByTimeAsync(100);
      await until(() => latest?.cloudLoaded === true);
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync(4);
      commits.length = 0;

      nav.onLine = false;
      const prev = local;
      local = { ...prev, medications: [stampEdit(base, { ...base, notes: 'offline edit' }, '2026-02-01T00:00:00.000Z')] };
      handle.push(prev, local);
      await vi.advanceTimersByTimeAsync(200);
      await flushAsync(6);
      expect(commits).toHaveLength(0);

      // Back online, the server's copy unchanged (Firestore never noticed): the queued edit goes up.
      nav.onLine = true;
      win.dispatchEvent(new Event('online'));
      await vi.advanceTimersByTimeAsync(200);
      await until(() => commits.some((c) => c.path.endsWith('meds/m1')));
      const c = commits.find((x) => x.path.endsWith('meds/m1'))!;
      expect(((await decryptMed(bundle.dek, UID, 'm1', c.data)) as Medication).notes).toBe('offline edit');
    } finally {
      handle.stop();
    }
  });
});
