import { afterEach, describe, expect, it, vi } from 'vitest';
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

describe('estimatePassphraseStrength (zxcvbn, loaded on demand)', () => {
  const score = async (p: string) => (await estimatePassphraseStrength(p)).score;

  it("uses the Very weak .. Very strong labels on zxcvbn's 0-4 scale", async () => {
    expect(await estimatePassphraseStrength('')).toEqual({ score: 0, label: 'Very weak' });
    expect(await estimatePassphraseStrength('password123')).toEqual({ score: 0, label: 'Very weak' });
    expect(await estimatePassphraseStrength('able:acid:acorn:actor')).toEqual({ score: 1, label: 'Weak' });
    expect(await estimatePassphraseStrength('Tr0ub4dor&3')).toEqual({ score: 2, label: 'Fair' });
    expect(await estimatePassphraseStrength('correct horse battery staple')).toEqual({ score: 4, label: 'Very strong' });
  });

  it('ranks obvious cases sensibly', async () => {
    expect(await score('password123')).toBe(0);
    expect(await score('aaaaaaaaaa')).toBe(0);
    expect(await score('')).toBe(0);
    expect(await score('abcdefghij')).toBe(0);
    expect(await score('13579')).toBe(0);
    expect(await score(generatePassphrase(6))).toBeGreaterThanOrEqual(3);
    expect(await score('Tr0ub4dor&3-xylophone!')).toBeGreaterThanOrEqual(3);
  });

  it('rates decorated, patterned and listed phrases at most Fair, most of them Weak or below', async () => {
    const atMostFair = [
      'P@ssw0rd!2024',
      'Th1sIsMyP4ssw0rd',
      'p4ssw0rd-p4$$w0rd-pa55word-p@ssword',
      'Tr0ub4dor&3',
      'dog1 dog2 dog3 dog4 dog5 dog6',
      'test1 test2 test3 test4',
      'welcome1 welcome2 welcome3 welcome4',
      'tiger1-tiger2-tiger3-tiger4',
      'apple apples applez applesauce',
      'able:acid:acorn:actor',
      'apple:banana:cherry:grape:lemon',
      'apple—banana—cherry—grape',
      'qwe asd zxc rty fgh vbn',
      "asdfghjkl;'zxcvbnm",
      '1q2w3e4r5t6y',
      '1qaz2wsx3edc4rfv',
      'a1b2c3d4e5f6g7h8',
      'aAbBcCdDeEfF',
      'the-the-the-the-the',
      'pill-pill-pill-pill-pill',
      'hello hello hello hello',
      '13579-13579-13579-13579-13579',
      'password123',
    ];
    let weakOrWorse = 0;
    for (const p of atMostFair) {
      const s = await score(p);
      expect(s, p).toBeLessThanOrEqual(2);
      if (s <= 1) weakOrWorse++;
    }
    expect(weakOrWorse).toBeGreaterThanOrEqual(Math.ceil(atMostFair.length * 0.8));
  });

  it('counts a token once however it is cased, leeted, counted or ended (the structure rules)', async () => {
    // Without the rules zxcvbn rates each of these Very strong: it sees every piece as a fresh pick.
    expect(await score('dog1 dog2 dog3 dog4 dog5 dog6')).toBe(0);
    expect(await score('apple apples applez applesauce')).toBe(0);
    expect(await score('p4ssw0rd-p4$$w0rd-pa55word-p@ssword')).toBe(0);
    expect(await score('monkey-monkey-monkey-monkey-monkey-monkey')).toBe(await score('monkey'));
    // Words in alphabetical order are a list. The same words not in order are fine.
    expect(await score('able:acid:acorn:actor')).toBeLessThanOrEqual(1);
    expect(await score('acorn:able:actor:acid')).toBeGreaterThanOrEqual(3);
    // Two interleaved runs.
    expect(await score('a1b2c3d4e5f6g7h8')).toBeLessThanOrEqual(1);
  });

  it('does not let a short unexplained string look strong (zxcvbn charges any such 10 characters like a secret)', async () => {
    expect(await score('Tr0ub4dor&3')).toBeLessThanOrEqual(2);
    expect(await score('xK9#mQ2$vL7!')).toBeGreaterThanOrEqual(3);
  });

  it('rates random 20-digit strings Fair or better, nearly always', async () => {
    let atLeastFair = 0;
    const N = 60;
    for (let i = 0; i < N; i++) {
      const digits = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(20)), (b) => b % 10).join('');
      if ((await score(digits)) >= 2) atLeastFair++;
    }
    expect(atLeastFair / N).toBeGreaterThanOrEqual(0.95);
  }, 60_000);

  it('rates generated 6-word passphrases Strong or better, every time (large sample)', async () => {
    for (let i = 0; i < 3_000; i++) {
      const g = generatePassphrase(6);
      expect(await score(g), g).toBeGreaterThanOrEqual(3);
    }
  }, 60_000);

  it('rates a generated-shaped passphrase on zxcvbn alone, whatever chance did with it (the narrow exception)', async () => {
    // Alphabetical order, a shared beginning, a repeated word: all possible by chance in a generated one.
    for (const g of [
      'able-acid-acorn-actor-adapt-adult',
      'sun-sunny-star-start-stare-stone',
      'night-win-win-giant-verse-throw',
      'check-winter-jolly-brook-jolly-jolly',
    ]) {
      expect(await score(g), g).toBeGreaterThanOrEqual(3);
    }
    // Typed by hand with other separators, or with too few different words, it's an ordinary phrase.
    expect(await score('able:acid:acorn:actor:adapt:adult')).toBeLessThanOrEqual(1);
    expect(await score('able-able-able-able-able-able')).toBe(0);
    expect(await score('able-acid-able-acid-able-acid')).toBeLessThanOrEqual(1);
    // A generated passphrase always has at least 4 different words, even when few are asked for.
    for (let i = 0; i < 500; i++) expect(new Set(generatePassphrase(4).split('-')).size).toBe(4);
  });

  it('still rates reasonable passphrases strong', async () => {
    for (const p of [
      'correct horse battery staple',
      'zebra quartz ninja velvet tomato',
      'purple-elephant-dances-quietly-1987',
      'My cat Felix eats 3 tins of tuna daily!',
      'Blue7!Kettle#Moss',
      'xK9#mQ2$vL7!',
    ]) {
      expect(await score(p), p).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('the strength checker loads on demand and never guesses', () => {
  afterEach(() => {
    vi.doUnmock('./strengthEngine');
    vi.resetModules();
  });

  it('rates nothing before it has loaded, then rates', async () => {
    vi.resetModules();
    const v = await import('./vault');
    expect(v.isStrengthCheckerLoaded()).toBe(false);
    expect(v.rateLoadedPassphrase('correct horse battery staple')).toBeNull();
    await v.loadStrengthChecker();
    expect(v.isStrengthCheckerLoaded()).toBe(true);
    expect(v.rateLoadedPassphrase('correct horse battery staple')!.score).toBeGreaterThanOrEqual(3);
    expect(v.rateLoadedPassphrase('password123')!.score).toBe(0);
  });

  it('rejects (never resolves "fine") when the checker cannot be loaded, and loads on a later try', async () => {
    vi.resetModules();
    vi.doMock('./strengthEngine', () => {
      throw new Error('Failed to fetch dynamically imported module');
    });
    const v = await import('./vault');
    await expect(v.estimatePassphraseStrength('correct horse battery staple')).rejects.toThrow();
    await expect(v.loadStrengthChecker()).rejects.toThrow();
    expect(v.isStrengthCheckerLoaded()).toBe(false);
    expect(v.rateLoadedPassphrase('correct horse battery staple')).toBeNull();
    // Back online.
    vi.doUnmock('./strengthEngine');
    await v.loadStrengthChecker();
    expect(v.rateLoadedPassphrase('correct horse battery staple')!.score).toBeGreaterThanOrEqual(3);
  });
});
