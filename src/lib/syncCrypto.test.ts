import { describe, expect, it } from 'vitest';
import { makeSchedule } from '../../shared/schedule';
import type { DoseLog, Medication } from '../../shared/types';
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
  type CryptoMeta,
} from './syncCrypto';
import { keepLocalForFailed, logMonth, migrationOps, remoteToAppData } from './syncOps';

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
  it('decrypts what it can, skips and counts what it cannot, and finds plaintext stragglers', async () => {
    const { dek } = await bundleP;
    const good = await encryptMed(dek, UID, med('a'));
    const swapped = await encryptMed(dek, UID, med('z')); // stored under the wrong doc id
    const l1 = await encryptLog(dek, UID, '2026-02', log('1'));
    const decoded = await decodeRemote(
      dek,
      UID,
      [
        { id: 'a', data: good },
        { id: 'b', data: swapped },
        { id: 'p', data: { med: med('p'), updatedAt: '2026-01-01T00:00:00.000Z' } },
      ],
      [{ id: '2026-02', data: { logs: { '1': l1, '2': log('2', { medId: 'p', scheduledFor: '2026-02-11T14:00:00.000Z' }), '3': { ...l1, ct: 'AAAA' + l1.ct.slice(4) } } } }],
    );
    expect(decoded.undecryptable).toBe(2);
    expect(decoded.plaintext).toEqual({ medIds: ['p'], logs: [{ month: '2026-02', id: '2' }] });

    const remote = remoteToAppData(decoded.medDocs, decoded.logDocs);
    expect(remote.data.medications.map((m) => m.id).sort()).toEqual(['a', 'p']);
    expect(remote.data.doseLogs.map((l) => l.id).sort()).toEqual(['1', '2']);
  });

  it('migrates plaintext to encrypted documents and is idempotent once done', async () => {
    const { dek } = await bundleP;
    // The cloud as the pre-encryption app left it.
    const meds: Record<string, unknown> = {
      a: { med: med('a'), updatedAt: '2026-01-01T00:00:00.000Z' },
      bad: { med: { id: 'bad' } },
    };
    const months: Record<string, Record<string, unknown>> = {
      '2026-02': {
        '1': log('1'),
        '2': log('2', { scheduledFor: '2026-03-05T14:00:00.000Z' }), // filed under the wrong month
        orphan: log('orphan', { medId: 'gone' }),
      },
    };
    const snapshot = () => ({
      meds: Object.entries(meds).map(([id, data]) => ({ id, data })),
      logs: Object.entries(months).map(([id, logs]) => ({ id, data: { logs } })),
    });

    // Apply ops the way sync.ts writes them (encrypting on the way).
    const apply = async (ops: ReturnType<typeof migrationOps>) => {
      for (const op of ops) {
        if (op.kind === 'setMed') meds[op.med.id] = await encryptMed(dek, UID, op.med);
        else if (op.kind === 'deleteMed') delete meds[op.id];
        else if (op.kind === 'setLog') {
          const m = logMonth(op.log.scheduledFor);
          (months[m] ??= {})[op.log.id] = await encryptLog(dek, UID, m, op.log);
        } else delete months[op.month ?? logMonth(op.log.scheduledFor)]?.[op.log.id];
      }
    };

    const s1 = snapshot();
    const d1 = await decodeRemote(dek, UID, s1.meds, s1.logs);
    const r1 = remoteToAppData(d1.medDocs, d1.logDocs);
    const before = r1.data;
    const ops = migrationOps(r1, d1.plaintext);
    expect(ops.map((o) => o.kind).sort()).toEqual(['deleteLog', 'deleteLog', 'deleteMed', 'setLog', 'setLog', 'setMed']);

    // Interrupted halfway: only the first ops were written. Running again finishes the job.
    await apply(ops.slice(0, 2));
    const s2 = snapshot();
    const d2 = await decodeRemote(dek, UID, s2.meds, s2.logs);
    await apply(migrationOps(remoteToAppData(d2.medDocs, d2.logDocs), d2.plaintext));

    const s3 = snapshot();
    const d3 = await decodeRemote(dek, UID, s3.meds, s3.logs);
    expect(d3.plaintext).toEqual({ medIds: [], logs: [] });
    expect(d3.undecryptable).toBe(0);
    expect(migrationOps(remoteToAppData(d3.medDocs, d3.logDocs), d3.plaintext)).toEqual([]);
    // Everything stored is ciphertext now; invalid and orphaned plaintext was deleted.
    for (const v of Object.values(meds)) expect(Object.keys(v as object).sort()).toEqual(['ct', 'iv', 'v']);
    expect(Object.keys(months['2026-02']!).sort()).toEqual(['1']);
    expect(months['2026-03']!['2']).toHaveProperty('ct');
    // Same data as before the migration.
    const after = remoteToAppData(d3.medDocs, d3.logDocs).data;
    expect(after.medications).toEqual(before.medications);
    expect([...after.doseLogs].sort((a, b) => a.id.localeCompare(b.id))).toEqual(
      [...before.doseLogs].sort((a, b) => a.id.localeCompare(b.id)),
    );
  });
});

describe('keepLocalForFailed', () => {
  it("keeps this device's copy of items whose cloud documents couldn't be decrypted", () => {
    const remote = { version: 1 as const, medications: [med('a')], doseLogs: [log('1')] };
    const local = {
      version: 1 as const,
      medications: [med('a'), med('b'), med('c')],
      doseLogs: [log('1'), log('2', { medId: 'b' }), log('3', { medId: 'c' })],
    };
    const shown = keepLocalForFailed(remote, local, { meds: ['b'], logs: [] });
    expect(shown.medications.map((m) => m.id).sort()).toEqual(['a', 'b']); // c was deleted elsewhere
    expect(shown.doseLogs.map((l) => l.id).sort()).toEqual(['1', '2']);
    expect(keepLocalForFailed(remote, local, { meds: [], logs: [] })).toBe(remote);
  });
});
