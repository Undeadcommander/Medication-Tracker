import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';
import { createKeyBundle, encryptLog, encryptMed, unlockWithPassphrase, type KeyBundle } from './syncCrypto';
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

describe('Issue #10: localShown() re-applies remote snapshots dropped while localHidden() was true', () => {
  it('delivers cloud snapshot received while localHidden() was true after localHidden flips false and localShown() is called', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await encryptedAccount([sampleMed({ id: 'm1', name: 'Lisinopril' })], []);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');

    const { startSync } = await import('./sync');
    let local: AppData = { version: 1, medications: [], doseLogs: [] };
    let hidden = true;
    let latestStatus: import('./sync').SyncStatus | null = null;
    const status = (): import('./sync').SyncStatus | null => latestStatus;
    const applyRemote = vi.fn((d: AppData) => {
      local = d;
    });

    const handle = startSync({
      uid: UID,
      getLocal: () => local,
      applyRemote,
      onStatus: (s) => {
        latestStatus = s;
      },
      localHidden: () => hidden,
    });

    try {
      // Wait for data listeners (meds & logs) to attach and deliver their initial snapshot,
      // then advance past the 40ms debounce so onSnapshots() runs while localHidden() is true.
      await until(() => (state.medListeners.get(UID)?.size ?? 0) > 0 && (state.logListeners.get(UID)?.size ?? 0) > 0);
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync(4);

      expect(applyRemote).not.toHaveBeenCalled();
      expect(status()?.cloudLoaded).toBe(false);

      hidden = false;
      handle.localShown?.();
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync(6);

      expect(status()?.cloudLoaded).toBe(true);
      expect(applyRemote).toHaveBeenCalled();
      expect(local.medications.map((m) => m.name)).toContain('Lisinopril');
    } finally {
      handle.stop();
    }
  });

  it('re-applies an incremental snapshot update that arrived while localHidden() was true', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    await encryptedAccount([sampleMed({ id: 'm1', name: 'Lisinopril' })], []);
    await rememberKey();
    state.storage.set(`medtracker.synced.${UID}`, '1');

    const { startSync } = await import('./sync');
    let local: AppData = { version: 1, medications: [sampleMed({ id: 'm1', name: 'Lisinopril' })], doseLogs: [] };
    let hidden = false;
    let latestStatus: import('./sync').SyncStatus | null = null;
    const applyRemote = vi.fn((d: AppData) => {
      local = d;
    });

    const handle = startSync({
      uid: UID,
      getLocal: () => local,
      applyRemote,
      onStatus: (s) => {
        latestStatus = s;
      },
      localHidden: () => hidden,
    });

    try {
      await vi.advanceTimersByTimeAsync(100);
      await until(() => latestStatus?.cloudLoaded === true);
      applyRemote.mockClear();

      hidden = true;
      const m2 = sampleMed({ id: 'm2', name: 'Metformin' });
      const env2 = (await encryptMed(bundle.dek, UID, m2, bundle.meta.keyId)) as unknown as Record<string, unknown>;
      state.medDocs.get(UID)!.set('m2', env2);
      for (const listener of state.medListeners.get(UID) ?? []) {
        listener({
          docChanges: () => [{ type: 'added', doc: { id: 'm2', data: () => env2 } }],
          metadata: { fromCache: false, hasPendingWrites: false },
        });
      }

      await vi.advanceTimersByTimeAsync(100);
      await flushAsync(4);
      expect(applyRemote).not.toHaveBeenCalled();
      expect(local.medications.some((m) => m.id === 'm2')).toBe(false);

      hidden = false;
      handle.localShown?.();
      await vi.advanceTimersByTimeAsync(100);
      await flushAsync(6);

      expect(applyRemote).toHaveBeenCalled();
      expect(local.medications.map((m) => m.name)).toContain('Metformin');
    } finally {
      handle.stop();
    }
  });
});
