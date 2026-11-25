import { describe, expect, it } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { AppData, DoseLog, Medication } from '../../shared/types';
import {
  SyncCryptoError,
  changePassphrase,
  createKeyBundle,
  decodeRemote,
  decryptLog,
  decryptMed,
  encryptLog,
  encryptMed,
  formatRecoveryKey,
  looksLikeRecoveryKey,
  parseCryptoMeta,
  parseRecoveryKey,
  readRecoveryKey,
  regenerateRecoveryKey,
  unlockWithPassphrase,
  unlockWithRecoveryKey,
  newDecodeMemo,
  type CryptoMeta,
} from './syncCrypto';
import { logDocId, logMonth, migrationRefs, reconcile, remoteToAppData, resolveRefs, type SyncOp } from './syncOps';

// Fewer PBKDF2 iterations than production so the suite stays quick; the code path is the same.
const IT = 100_000;
const UID = 'user-123';
const PASS = 'correct horse battery staple';

const med = (id: string, over: Partial<Medication> = {}): Medication => ({
  id,
  name: `Med ${id}`,
  dosage: '10 mg',
  color: '#0f766e',
  schedule: makeSchedule('daily', '2026-01-01'),
  notificationsEnabled: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  ...over,
});

const log = (id: string, over: Partial<DoseLog> = {}): DoseLog => ({
  id,
  medId: 'a',
  scheduledFor: '2026-02-10T14:00:00.000Z',
  status: 'taken',
  loggedAt: '2026-02-10T14:01:00.000Z',
  ...over,
});

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return e instanceof SyncCryptoError ? e.code : `other:${String(e)}`;
  }
  return 'no error';
}

const bundleP = createKeyBundle(UID, PASS, IT);

describe('key wrapping', () => {
  it('stores only wrapped keys, and the device key is non-extractable', async () => {
    const { meta, dek, recoveryKey } = await bundleP;
    expect(dek.extractable).toBe(false);
    expect(meta.pass.iterations).toBe(IT);
    expect(recoveryKey).toMatch(/^([0-9A-Z]{4}-){6}[0-9A-Z]{4}$/);
    const json = JSON.stringify(meta);
    expect(json).not.toContain(PASS);
    expect(json).not.toContain(recoveryKey);
    expect(parseCryptoMeta(JSON.parse(json))).toEqual(meta);
  });

  it('unwraps with the passphrase and with the recovery key to the same key', async () => {
    const { meta, dek, recoveryKey } = await bundleP;
    const m = med('a');
    const env = await encryptMed(dek, UID, m);
    const viaPass = await unlockWithPassphrase(meta, UID, PASS);
    const viaRecovery = await unlockWithRecoveryKey(meta, UID, recoveryKey.toLowerCase().replace(/-/g, ' '));
    expect(viaPass.extractable).toBe(false);
    expect(await decryptMed(viaPass, UID, 'a', env)).toEqual(m);
    expect(await decryptMed(viaRecovery, UID, 'a', env)).toEqual(m);
  });

  it('detects a wrong passphrase or recovery key (not reported as damage)', async () => {
    const { meta, recoveryKey } = await bundleP;
    expect(await errorCode(unlockWithPassphrase(meta, UID, 'wrong passphrase here'))).toBe('wrong-passphrase');
    const other = await formatRecoveryKey(new Uint8Array(16).fill(7));
    expect(await errorCode(unlockWithRecoveryKey(meta, UID, other))).toBe('wrong-recovery-key');
    // A typo fails the checksum before any decryption is tried.
    const typo = (recoveryKey[0] === 'A' ? 'B' : 'A') + recoveryKey.slice(1);
    expect(await errorCode(unlockWithRecoveryKey(meta, UID, typo))).toBe('invalid-recovery-key');
    // Bound to the account: the same meta doesn't unlock under another uid.
    expect(await errorCode(unlockWithPassphrase(meta, 'someone-else', PASS))).toBe('wrong-passphrase');
  });

  it('reports a damaged wrapped key as corrupt, not as a wrong passphrase', async () => {
    const { meta } = await bundleP;
    const ct = meta.pass.wrapped.ct;
    const damaged: CryptoMeta = {
      ...meta,
      pass: { ...meta.pass, wrapped: { ...meta.pass.wrapped, ct: (ct[0] === 'A' ? 'B' : 'A') + ct.slice(1) } },
    };
    expect(await errorCode(unlockWithPassphrase(damaged, UID, PASS))).toBe('corrupt');
    expect(() => parseCryptoMeta({ ...meta, v: 2 })).toThrow(SyncCryptoError);
    expect(() => parseCryptoMeta({ ...meta, pass: { ...meta.pass, iterations: 10 } })).toThrow(SyncCryptoError);
  });

  it('only the recovery-key format is auto-detected, not a 28-character passphrase with spaces', async () => {
    const { recoveryKey } = await bundleP;
    expect(looksLikeRecoveryKey(recoveryKey)).toBe(true);
    expect(looksLikeRecoveryKey(recoveryKey.replace(/-/g, ''))).toBe(true);
    expect(looksLikeRecoveryKey('e2e test violet harbor quilt 4821')).toBe(false);
  });

  it('recovery key round-trips through formatting with typo-tolerant parsing', async () => {
    const raw = new Uint8Array(16).map((_, i) => i * 17);
    const key = await formatRecoveryKey(raw);
    expect(await parseRecoveryKey(key)).toEqual(raw);
    expect(await parseRecoveryKey(key.replace(/0/g, 'o').replace(/1/g, 'l'))).toEqual(raw);
  });
});

describe('changing the passphrase / recovery key', () => {
  it('re-wraps only the key: old data still decrypts, the old passphrase stops working', async () => {
    const { meta, dek, recoveryKey } = await bundleP;
    const env = await encryptLog(dek, UID, '2026-02', log('1'));
    const next = await changePassphrase(meta, UID, dek, 'a brand new sync passphrase', IT);

    expect(next.keyId).toBe(meta.keyId);
    expect(next.rev).toBe(meta.rev + 1);
    expect(next.recovery).toEqual(meta.recovery);
    expect(next.recoveryBox).toEqual(meta.recoveryBox);
    expect(next.pass.salt).not.toBe(meta.pass.salt);

    expect(await errorCode(unlockWithPassphrase(next, UID, PASS))).toBe('wrong-passphrase');
    const k = await unlockWithPassphrase(next, UID, 'a brand new sync passphrase');
    expect(await decryptLog(k, UID, '2026-02', '1', env)).toEqual(log('1'));
    expect(await readRecoveryKey(next, UID, k)).toBe(recoveryKey);
  });

  it('rejects a too-short new passphrase', async () => {
    const { meta, dek } = await bundleP;
    expect(await errorCode(changePassphrase(meta, UID, dek, 'short', IT))).toBe('weak-passphrase');
  });

  it('a new recovery key replaces the old one', async () => {
    const { meta, dek, recoveryKey } = await bundleP;
    const { meta: next, recoveryKey: fresh } = await regenerateRecoveryKey(meta, UID, dek);
    expect(fresh).not.toBe(recoveryKey);
    expect(next.pass).toEqual(meta.pass);
    expect(await errorCode(unlockWithRecoveryKey(next, UID, recoveryKey))).toBe('wrong-recovery-key');
    const k = await unlockWithRecoveryKey(next, UID, fresh);
    const env = await encryptMed(dek, UID, med('a'));
    expect(await decryptMed(k, UID, 'a', env)).toEqual(med('a'));
  });
});

describe('document encryption', () => {
  it('round-trips a medication and a dose log', async () => {
    const { dek } = await bundleP;
    const m = med('a', { notes: 'x'.repeat(3000), drugInfo: { brandNames: ['B'], drugClasses: [], sources: [], fetchedAt: '' } });
    const env = await encryptMed(dek, UID, m);
    expect(Object.keys(env).sort()).toEqual(['ct', 'iv', 'v']);
    expect(JSON.stringify(env)).not.toContain('Med a');
    expect(await decryptMed(dek, UID, 'a', env)).toEqual(m);

    const l = log('1', { supplyDeducted: 1 });
    const lenv = await encryptLog(dek, UID, logMonth(l.scheduledFor), l);
    expect(await decryptLog(dek, UID, '2026-02', '1', lenv)).toEqual(l);
  });

  it('pads dose logs to one size, so status and supply fields do not show in the length', async () => {
    const { dek } = await bundleP;
    const a = await encryptLog(dek, UID, '2026-02', log('1', { status: 'taken', supplyDeducted: 2 }));
    const b = await encryptLog(dek, UID, '2026-02', log('2', { status: 'skipped' }));
    expect(a.ct.length).toBe(b.ct.length);
  });

  it('fails on tampered ciphertext', async () => {
    const { dek } = await bundleP;
    const env = await encryptMed(dek, UID, med('a'));
    const bytes = Uint8Array.from(atob(env.ct), (c) => c.charCodeAt(0));
    bytes[5] ^= 1;
    const tampered = { ...env, ct: btoa(String.fromCharCode(...bytes)) };
    await expect(decryptMed(dek, UID, 'a', tampered)).rejects.toThrow();
  });

  it('fails when ciphertext is moved to another document, month, log id or account', async () => {
    const { dek } = await bundleP;
    const menv = await encryptMed(dek, UID, med('a'));
    await expect(decryptMed(dek, UID, 'b', menv)).rejects.toThrow();
    await expect(decryptMed(dek, 'other-user', 'a', menv)).rejects.toThrow();

    const lenv = await encryptLog(dek, UID, '2026-02', log('1'));
    await expect(decryptLog(dek, UID, '2026-03', '1', lenv)).rejects.toThrow();
    await expect(decryptLog(dek, UID, '2026-02', '2', lenv)).rejects.toThrow();
    // A medication's ciphertext isn't accepted as a log either.
    await expect(decryptLog(dek, UID, '2026-02', 'a', menv)).rejects.toThrow();
  });

  it('fails with a different account key', async () => {
    const { dek } = await bundleP;
    const other = await createKeyBundle(UID, PASS, IT);
    const env = await encryptMed(dek, UID, med('a'));
    await expect(decryptMed(other.dek, UID, 'a', env)).rejects.toThrow();
  });
});

describe('decodeRemote + migration', () => {
  it('decrypts what it can, skips and counts what it cannot, and finds plaintext stragglers and tombstones', async () => {
    const { dek, meta } = await bundleP;
    const good = await encryptMed(dek, UID, med('a'), meta.keyId);
    const swapped = await encryptMed(dek, UID, med('z')); // stored under the wrong doc id
    const l1 = await encryptLog(dek, UID, '2026-02', log('1'));
    const decoded = await decodeRemote(
      dek,
      UID,
      [
        { id: 'a', data: good },
        { id: 'b', data: swapped },
        { id: 'p', data: { med: med('p'), updatedAt: '2026-01-01T00:00:00.000Z' } },
        { id: 'gone', data: { v: 1, deleted: true } },
      ],
      [{ id: '2026-02', data: { logs: { '1': l1, '2': log('2', { medId: 'p', scheduledFor: '2026-02-11T14:00:00.000Z' }), '3': { ...l1, ct: 'AAAA' + l1.ct.slice(4) } } } }],
      new Map(),
      { keyId: meta.keyId },
    );
    expect(good.k).toBe(meta.keyId);
    expect(decoded.undecryptable).toBe(2);
    expect(decoded.tombstones).toEqual(['gone']);
    expect(decoded.plaintext).toEqual({ medIds: ['p'], logs: [{ doc: '2026-02', id: '2' }] });

    const remote = remoteToAppData(decoded);
    expect(remote.data.medications.map((m) => m.id).sort()).toEqual(['a', 'p']);
    expect(remote.data.doseLogs.map((l) => l.id).sort()).toEqual(['1', '2']);
  });

  it('recognises leftovers encrypted with an older key', async () => {
    const { dek, meta } = await bundleP;
    const other = await createKeyBundle(UID, PASS, IT);
    const old = await encryptMed(other.dek, UID, med('a'), other.meta.keyId);
    const decoded = await decodeRemote(dek, UID, [{ id: 'a', data: old }], [], new Map(), { keyId: meta.keyId });
    expect(decoded.staleKey.meds).toEqual(['a']);
  });

  it('skips unchanged documents using the memo', async () => {
    const { dek } = await bundleP;
    const data = await encryptMed(dek, UID, med('a'));
    const memo = newDecodeMemo();
    const cache = new Map();
    const first = await decodeRemote(dek, UID, [{ id: 'a', data }], [], cache, { memo });
    expect(first.cacheAdded).toHaveLength(1);
    const second = await decodeRemote(dek, UID, [{ id: 'a', data }], [], cache, { memo });
    expect(second.cacheAdded).toHaveLength(0);
    expect(second.meds[0]!.med).toBe(first.meds[0]!.med);
  });

  it('moves plaintext and monthly documents into encrypted shard documents, and is idempotent once done', async () => {
    const { dek } = await bundleP;
    // The cloud as older versions left it: plaintext, and one document per month.
    const meds: Record<string, unknown> = {
      a: { med: med('a'), updatedAt: '2026-01-01T00:00:00.000Z' },
      bad: { med: { id: 'bad' } },
    };
    const docs: Record<string, Record<string, unknown>> = {
      '2026-02': {
        '1': log('1'),
        '2': log('2', { scheduledFor: '2026-03-05T14:00:00.000Z' }), // filed under the wrong month
        orphan: log('orphan', { medId: 'gone' }),
        enc: await encryptLog(dek, UID, '2026-02', log('enc', { scheduledFor: '2026-02-12T14:00:00.000Z' })),
      },
    };
    const snapshot = () => ({
      meds: Object.entries(meds).map(([id, data]) => ({ id, data })),
      logs: Object.entries(docs).map(([id, logs]) => ({ id, data: { logs } })),
    });
    // Apply ops the way sync.ts writes them (encrypting on the way).
    const apply = async (ops: SyncOp[]) => {
      for (const op of ops) {
        if (op.kind === 'setMed') meds[op.med.id] = await encryptMed(dek, UID, op.med);
        else if (op.kind === 'deleteMed') meds[op.id] = { v: 1, deleted: true };
        else if (op.kind === 'setLog') {
          const d = logDocId(op.log);
          (docs[d] ??= {})[op.log.id] = await encryptLog(dek, UID, d, op.log);
        } else delete docs[op.doc]?.[op.id];
      }
    };
    /** One sync round: what sync.ts uploads and tidies after a settled server snapshot. */
    let local: AppData = { version: 1, medications: [], doseLogs: [] };
    const round = async () => {
      const s = snapshot();
      const decoded = await decodeRemote(dek, UID, s.meds, s.logs);
      const remote = remoteToAppData(decoded);
      const r = reconcile({ remote, local, queued: [], failed: decoded.failedIds, cutoff: 0 });
      local = r.shown;
      const refs = [...migrationRefs(remote, decoded.plaintext), ...r.uploads, ...r.removals];
      await apply(resolveRefs(refs, local));
      return { decoded, refs };
    };

    const first = await round();
    const before = remoteToAppData(first.decoded).data;
    for (let i = 0; i < 3; i++) await round();
    const last = await round();
    expect(last.refs).toEqual([]);
    expect(last.decoded.plaintext).toEqual({ medIds: [], logs: [] });
    expect(last.decoded.undecryptable).toBe(0);
    // Everything stored is ciphertext (or a deletion marker); all logs are in shard documents.
    expect(Object.keys(meds.a as object).sort()).toEqual(['ct', 'iv', 'v']);
    expect(meds.bad).toEqual({ v: 1, deleted: true });
    expect(Object.keys(docs['2026-02']!)).toEqual([]);
    for (const [id, entries] of Object.entries(docs)) {
      if (id === '2026-02') continue;
      expect(id).toMatch(/^\d{4}-\d{2}~[0-9a-z]+$/);
      for (const v of Object.values(entries)) expect(v).toHaveProperty('ct');
    }
    // Same data as before (the orphan went).
    const after = remoteToAppData(last.decoded).data;
    expect(after.medications.map((m) => m.id)).toEqual(['a']);
    expect(after.doseLogs.map((l) => l.id).sort()).toEqual(before.doseLogs.map((l) => l.id).sort());
    expect(after.doseLogs.map((l) => l.id).sort()).toEqual(['1', '2', 'enc']);
  });
});
