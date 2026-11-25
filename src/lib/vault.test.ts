import { describe, expect, it } from 'vitest';
import type { AppData, Medication } from '../../shared/types';
import {
  MIN_PASSPHRASE_LENGTH,
  VaultError,
  decryptVault,
  encryptVault,
  estimatePassphraseStrength,
  generatePassphrase,
  mergeAppData,
  validateAppData,
  type VaultFile,
} from './vault';

const PASS = 'correct-horse-battery-staple';

function med(id: string, over: Partial<Medication> = {}): Medication {
  return {
    id,
    name: `Med ${id}`,
    dosage: '10 mg',
    color: '#0f766e',
    schedule: { preset: 'daily', useSpecificTimes: false, times: ['08:00'], startDate: '2025-01-01' },
    notificationsEnabled: true,
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    ...over,
  };
}

function sample(): AppData {
  return {
    version: 1,
    medications: [
      med('a', {
        form: 'Tablet',
        quantityPerDose: 1,
        supplyRemaining: 30,
        refillDate: '2025-06-01',
        drugInfo: {
          brandNames: ['Brand'],
          drugClasses: ['Class'],
          sources: [{ label: 'FDA', url: 'https://example.com/x' }],
          fetchedAt: '2025-01-01T00:00:00.000Z',
          purpose: 'Treats things',
        },
      }),
      med('b', { name: 'Ünïcode 薬 ✓' }),
    ],
    doseLogs: [
      { id: 'l1', medId: 'a', scheduledFor: '2025-01-02T08:00:00.000Z', status: 'taken', loggedAt: '2025-01-02T08:05:00.000Z' },
      { id: 'l2', medId: 'b', scheduledFor: '2025-01-02T09:00:00.000Z', status: 'skipped', loggedAt: '2025-01-02T09:05:00.000Z' },
    ],
  };
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof VaultError) return e.code;
    throw e;
  }
  return 'no-error';
}

function flipBase64(b64: string, index = 10): string {
  const chars = [...b64];
  chars[index] = chars[index] === 'A' ? 'B' : 'A';
  return chars.join('');
}

describe('encrypt/decrypt', () => {
  let file: VaultFile;

  it('round-trips data', async () => {
    const data = sample();
    file = await encryptVault(data, PASS);
    expect(file.format).toBe('medtracker-vault');
    expect(file.version).toBe(1);
    expect(file.kdf.iterations).toBe(600_000);
    expect(file.compressed).toBe(true);
    expect(JSON.stringify(file)).not.toContain('Ünïcode');
    // survives JSON serialisation like a real file
    const restored = await decryptVault(JSON.parse(JSON.stringify(file)), PASS);
    expect(restored).toEqual(data);
  });

  it('uses fresh salt and IV each time', async () => {
    const other = await encryptVault(sample(), PASS);
    expect(other.kdf.salt).not.toBe(file.kdf.salt);
    expect(other.cipher.iv).not.toBe(file.cipher.iv);
    expect(other.ciphertext).not.toBe(file.ciphertext);
  });

  it('rejects a wrong passphrase', async () => {
    expect(await codeOf(decryptVault(file, PASS + 'x'))).toBe('wrong-passphrase');
  });

  it('rejects tampered ciphertext', async () => {
    expect(await codeOf(decryptVault({ ...file, ciphertext: flipBase64(file.ciphertext) }, PASS))).toBe(
      'wrong-passphrase',
    );
  });

  it('rejects a tampered createdAt (header bound as AAD)', async () => {
    expect(await codeOf(decryptVault({ ...file, createdAt: '2020-01-01T00:00:00.000Z' }, PASS))).toBe(
      'wrong-passphrase',
    );
  });

  it('rejects a tampered compressed flag', async () => {
    expect(await codeOf(decryptVault({ ...file, compressed: false }, PASS))).toBe('wrong-passphrase');
  });

  it('rejects tampered iterations (in range, so it fails to decrypt)', async () => {
    const tampered = { ...file, kdf: { ...file.kdf, iterations: 100_000 } };
    expect(await codeOf(decryptVault(tampered, PASS))).toBe('wrong-passphrase');
  });

  it('rejects a tampered salt', async () => {
    const tampered = { ...file, kdf: { ...file.kdf, salt: flipBase64(file.kdf.salt, 2) } };
    expect(await codeOf(decryptVault(tampered, PASS))).toBe('wrong-passphrase');
  });

  it('rejects out-of-range iterations before doing any work', async () => {
    for (const iterations of [99_999, 5_000_001, 0, -1, 1.5, Infinity, '600000']) {
      const tampered = { ...file, kdf: { ...file.kdf, iterations } };
      expect(await codeOf(decryptVault(tampered, PASS))).toBe('invalid-file');
    }
  });

  it('rejects an unknown version', async () => {
    expect(await codeOf(decryptVault({ ...file, version: 2 }, PASS))).toBe('unsupported-version');
  });

  it('rejects malformed files', async () => {
    const bads: unknown[] = [
      null,
      undefined,
      'text',
      42,
      [],
      {},
      { ...file, format: 'other' },
      { ...file, version: 'x' },
      { ...file, compressed: 'yes' },
      { ...file, kdf: null },
      { ...file, kdf: { ...file.kdf, name: 'scrypt' } },
      { ...file, cipher: { name: 'AES-CBC', iv: file.cipher.iv } },
      { ...file, ciphertext: 5 },
      { ...file, ciphertext: '' },
      { ...file, ciphertext: '!!!notbase64!!!notbase64!!!' },
      { ...file, cipher: { ...file.cipher, iv: 'AAAA' } },
    ];
    for (const b of bads) {
      expect(await codeOf(decryptVault(b, PASS))).toBe('invalid-file');
    }
  });

  it('enforces a minimum passphrase length when encrypting', async () => {
    expect(await codeOf(encryptVault(sample(), 'x'.repeat(MIN_PASSPHRASE_LENGTH - 1)))).toBe('invalid-data');
  });
});

describe('validateAppData', () => {
  it('strips unknown fields at every level', () => {
    const dirty = JSON.parse(JSON.stringify(sample()));
    dirty.extra = 1;
    dirty.medications[0].evil = '<script>';
    dirty.medications[0].schedule.junk = true;
    dirty.medications[0].drugInfo.bogus = 'x';
    dirty.medications[0].drugInfo.sources[0].tracker = 'y';
    dirty.doseLogs[0].note = 'z';
    const clean = validateAppData(dirty);
    expect(clean).toEqual(sample());
    expect(JSON.stringify(clean)).not.toMatch(/evil|junk|bogus|tracker|"note"|extra/);
  });

  it('rejects bad types and values', () => {
    const mutate = (fn: (d: any) => void) => {
      const d = JSON.parse(JSON.stringify(sample()));
      fn(d);
      return () => validateAppData(d);
    };
    const cases: Array<() => unknown> = [
      () => validateAppData(null),
      () => validateAppData([]),
      () => validateAppData({ version: 2, medications: [], doseLogs: [] }),
      () => validateAppData({ version: 1, medications: {}, doseLogs: [] }),
      mutate((d) => (d.medications[0].name = 5)),
      mutate((d) => (d.medications[0].name = '  ')),
      mutate((d) => (d.medications[0].name = 'x'.repeat(201))),
      mutate((d) => (d.medications[0].color = 'red')),
      mutate((d) => (d.medications[0].notificationsEnabled = 'true')),
      mutate((d) => (d.medications[0].quantityPerDose = '1')),
      mutate((d) => (d.medications[0].supplyRemaining = -1)),
      mutate((d) => (d.medications[0].supplyRemaining = null)),
      mutate((d) => (d.medications[0].updatedAt = 'yesterday')),
      mutate((d) => (d.medications[0].refillDate = '2025-02-31')),
      mutate((d) => (d.medications[0].schedule.preset = 'hourly')),
      mutate((d) => (d.medications[0].schedule.times = ['25:00'])),
      mutate((d) => (d.medications[0].schedule.weekdays = [7])),
      mutate((d) => (d.medications[0].schedule.interval = 0)),
      mutate((d) => (d.medications[0].drugInfo.sources[0].url = 'javascript:alert(1)')),
      mutate((d) => (d.medications[0].drugInfo.sources[0].url = 'not a url')),
      mutate((d) => (d.medications[0].drugInfo.brandNames = [1])),
      mutate((d) => (d.medications[1].id = 'a')),
      mutate((d) => (d.doseLogs[0].status = 'late')),
      mutate((d) => (d.doseLogs[0].scheduledFor = 'nope')),
      mutate((d) => (d.doseLogs[1].id = 'l1')),
      mutate((d) => delete d.doseLogs[0].medId),
    ];
    for (const c of cases) {
      let err: unknown;
      try {
        c();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(VaultError);
      expect((err as VaultError).code).toBe('invalid-data');
      expect((err as VaultError).message.length).toBeGreaterThan(10);
    }
  });

  it('caps array sizes', () => {
    const many = Array.from({ length: 10_001 }, (_, i) => med(`m${i}`));
    expect(() => validateAppData({ version: 1, medications: many, doseLogs: [] })).toThrow(VaultError);
  });

  it('accepts minimal and empty data', () => {
    expect(validateAppData({ version: 1, medications: [], doseLogs: [] })).toEqual({
      version: 1,
      medications: [],
      doseLogs: [],
    });
    expect(validateAppData({ version: 1, medications: [med('z')], doseLogs: [] }).medications[0]).toEqual(med('z'));
  });

  it('refuses to export data that would fail validation on import', async () => {
    const f = await encryptVault({ version: 1, medications: [], doseLogs: [] }, PASS);
    expect(await decryptVault(f, PASS)).toEqual({ version: 1, medications: [], doseLogs: [] });
    const bad = encryptVault({ version: 1, medications: [{ id: 1 }], doseLogs: [] } as unknown as AppData, PASS);
    expect(await codeOf(bad)).toBe('invalid-data');
  });
});

describe('mergeAppData', () => {
  it('newer updatedAt wins; ties pick the same side either way; new meds are added', () => {
    const current: AppData = {
      version: 1,
      medications: [
        med('a', { name: 'cur-a', updatedAt: '2025-03-01T00:00:00.000Z' }),
        med('b', { name: 'cur-b', updatedAt: '2025-03-01T00:00:00.000Z' }),
        med('c', { name: 'cur-c', updatedAt: '2025-03-01T00:00:00.000Z' }),
      ],
      doseLogs: [],
    };
    const incoming: AppData = {
      version: 1,
      medications: [
        med('a', { name: 'inc-a', updatedAt: '2025-04-01T00:00:00.000Z' }),
        med('b', { name: 'inc-b', updatedAt: '2025-02-01T00:00:00.000Z' }),
        med('c', { name: 'inc-c', updatedAt: '2025-03-01T00:00:00.000Z' }),
        med('d', { name: 'inc-d' }),
      ],
      doseLogs: [],
    };
    const merged = mergeAppData(current, incoming);
    expect(merged.medications.map((m) => m.name)).toEqual(['inc-a', 'cur-b', 'inc-c', 'inc-d']);
    // A tie resolves the same whichever copy is merged into which (so devices agree).
    expect(mergeAppData(incoming, current).medications.find((m) => m.id === 'c')?.name).toBe('inc-c');
  });

  it('unions dose logs per scheduled dose with incoming winning ties', () => {
    const log = (id: string, status: 'taken' | 'skipped', hour: number) => ({
      id,
      medId: 'a',
      scheduledFor: `2025-01-01T${String(hour).padStart(2, '0')}:00:00.000Z`,
      status,
      loggedAt: '2025-01-01T23:00:00.000Z',
    });
    const merged = mergeAppData(
      { version: 1, medications: [], doseLogs: [log('1', 'taken', 8), log('2', 'taken', 12)] },
      { version: 1, medications: [], doseLogs: [log('2', 'skipped', 12), log('3', 'taken', 20)] },
    );
    expect(merged.doseLogs.map((l) => `${l.id}:${l.status}`)).toEqual(['1:taken', '2:skipped', '3:taken']);
  });

  it('does not mutate its inputs', () => {
    const a = sample();
    const b = sample();
    const snapshot = JSON.stringify([a, b]);
    mergeAppData(a, b);
    expect(JSON.stringify([a, b])).toBe(snapshot);
  });
});

describe('generatePassphrase', () => {
  it('produces 6 lowercase words joined by "-" by default and honours the count', () => {
    expect(generatePassphrase()).toMatch(/^[a-z]+(-[a-z]+){5}$/);
    expect(generatePassphrase(4).split('-')).toHaveLength(4);
  });

  it('is unique across calls', () => {
    const set = new Set(Array.from({ length: 200 }, () => generatePassphrase()));
    expect(set.size).toBe(200);
  });

  it('draws from the whole list roughly uniformly', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) generatePassphrase(6).split('-').forEach((w) => seen.add(w));
    expect(seen.size).toBeGreaterThan(900);
  });
});

describe('estimatePassphraseStrength', () => {
  it('ranks obvious cases sensibly', () => {
    expect(estimatePassphraseStrength('password123').score).toBe(0);
    expect(estimatePassphraseStrength('aaaaaaaaaa').score).toBe(0);
    expect(estimatePassphraseStrength('').score).toBe(0);
    expect(estimatePassphraseStrength(generatePassphrase(6)).score).toBeGreaterThanOrEqual(3);
    expect(estimatePassphraseStrength('Tr0ub4dor&3-xylophone!').score).toBeGreaterThanOrEqual(3);
    const weak = estimatePassphraseStrength('abcdefghij');
    expect(weak.score).toBeLessThanOrEqual(1);
    expect(weak.label).toBeTruthy();
  });
});
