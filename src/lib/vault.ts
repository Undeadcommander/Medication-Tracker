/**
 * Encrypted export/import ("vault") for the user's medication data.
 *
 * Everything happens on-device with Web Crypto: PBKDF2-SHA-256 derives an AES-GCM key from a
 * passphrase; the (optionally gzip-compressed) JSON is encrypted with a random IV, and the file
 * header is bound to the ciphertext as AES-GCM additional data so any header tampering is detected.
 * No data, passphrase, or key ever leaves the device, and nothing here is logged.
 */
import type { AppData, DoseLog, DrugInfo, Medication, Schedule } from '../../shared/types';

export type VaultErrorCode = 'invalid-file' | 'unsupported-version' | 'wrong-passphrase' | 'invalid-data';

export class VaultError extends Error {
  code: VaultErrorCode;
  constructor(code: VaultErrorCode, message?: string) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'VaultError';
    this.code = code;
  }
}

const DEFAULT_MESSAGES: Record<VaultErrorCode, string> = {
  'invalid-file': 'This does not look like a valid backup file.',
  'unsupported-version': 'This backup was made by a newer or unknown version of the app.',
  'wrong-passphrase': 'Wrong passphrase, or the file was changed.',
  'invalid-data': 'The backup contents are not valid.',
};

export interface VaultFile {
  format: 'medtracker-vault';
  version: 1;
  createdAt: string;
  compressed: boolean;
  kdf: { name: 'PBKDF2'; hash: 'SHA-256'; iterations: number; salt: string };
  cipher: { name: 'AES-GCM'; iv: string };
  ciphertext: string;
}

export const MIN_PASSPHRASE_LENGTH = 10;

const KDF_ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 5_000_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;
const MAX_FILE_BYTES = 20 * 1024 * 1024;
/** Upper bound on decompressed plaintext, to defeat decompression bombs. */
const MAX_PLAINTEXT_BYTES = 64 * 1024 * 1024;

const MAX_MEDICATIONS = 1000;
const MAX_DOSE_LOGS = 100_000;

// ---------------------------------------------------------------------------------------------
// Byte helpers
// ---------------------------------------------------------------------------------------------

type Bytes = Uint8Array<ArrayBuffer>;

function toBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

function fromBase64(b64: string, what: string): Bytes {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64) || b64.length % 4 !== 0) {
    throw new VaultError('invalid-file', `The backup file is damaged (${what} is malformed).`);
  }
  const bin = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomBytes(n: number): Bytes {
  const out = new Uint8Array(new ArrayBuffer(n));
  globalThis.crypto.getRandomValues(out);
  return out;
}

function utf8(s: string): Bytes {
  const enc = new TextEncoder().encode(s);
  const out = new Uint8Array(new ArrayBuffer(enc.length));
  out.set(enc);
  return out;
}

async function streamThrough(
  input: Bytes,
  transform: CompressionStream | DecompressionStream,
  maxBytes: number,
): Promise<Bytes> {
  const writer = transform.writable.getWriter();
  // Don't await write/close before reading: backpressure would deadlock on large inputs.
  const writing = writer.write(input).then(() => writer.close());
  const reader = transform.readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel();
        throw new VaultError('invalid-data', 'The backup is too large to import.');
      }
      chunks.push(value);
    }
    await writing;
  } catch (e) {
    writing.catch(() => undefined);
    if (e instanceof VaultError) throw e;
    throw new VaultError('invalid-data', 'The backup contents could not be decompressed.');
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Crypto
// ---------------------------------------------------------------------------------------------

function normalizePassphrase(passphrase: string): string {
  return passphrase.normalize('NFKC');
}

async function deriveKey(passphrase: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  const subtle = globalThis.crypto.subtle;
  const material = await subtle.importKey('raw', utf8(normalizePassphrase(passphrase)), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** Canonical header bytes (fixed key order) bound to the ciphertext as AES-GCM additional data. */
function headerAad(h: Omit<VaultFile, 'ciphertext'>): Bytes {
  return utf8(
    JSON.stringify({
      format: h.format,
      version: h.version,
      createdAt: h.createdAt,
      compressed: h.compressed,
      kdf: { name: h.kdf.name, hash: h.kdf.hash, iterations: h.kdf.iterations, salt: h.kdf.salt },
      cipher: { name: h.cipher.name, iv: h.cipher.iv },
    }),
  );
}

export async function encryptVault(data: AppData, passphrase: string): Promise<VaultFile> {
  if (passphrase.length < MIN_PASSPHRASE_LENGTH) {
    throw new VaultError('invalid-data', `Passphrase must be at least ${MIN_PASSPHRASE_LENGTH} characters.`);
  }
  // Validate before encrypting so anything that can be exported can also be imported.
  const clean = validateAppData(JSON.parse(JSON.stringify(data)));
  const subtle = globalThis.crypto.subtle;
  let plaintext = utf8(JSON.stringify(clean));
  let compressed = false;
  if (typeof CompressionStream !== 'undefined') {
    plaintext = await streamThrough(plaintext, new CompressionStream('gzip'), MAX_PLAINTEXT_BYTES);
    compressed = true;
  }
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header: Omit<VaultFile, 'ciphertext'> = {
    format: 'medtracker-vault',
    version: 1,
    createdAt: new Date().toISOString(),
    compressed,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: KDF_ITERATIONS, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
  };
  const key = await deriveKey(passphrase, salt, KDF_ITERATIONS);
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: headerAad(header) }, key, plaintext);
  return { ...header, ciphertext: toBase64(new Uint8Array(ct)) };
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** Validates the envelope only (not the decrypted data). */
function parseVaultFile(file: unknown): VaultFile {
  if (!isRecord(file) || file.format !== 'medtracker-vault') {
    throw new VaultError('invalid-file');
  }
  if (typeof file.version !== 'number') throw new VaultError('invalid-file');
  if (file.version !== 1) throw new VaultError('unsupported-version');
  const { createdAt, compressed, kdf, cipher, ciphertext } = file;
  if (typeof createdAt !== 'string' || createdAt.length > 64) throw new VaultError('invalid-file');
  if (typeof compressed !== 'boolean') throw new VaultError('invalid-file');
  if (!isRecord(kdf) || kdf.name !== 'PBKDF2' || kdf.hash !== 'SHA-256') throw new VaultError('invalid-file');
  if (
    typeof kdf.iterations !== 'number' ||
    !Number.isInteger(kdf.iterations) ||
    kdf.iterations < MIN_ITERATIONS ||
    kdf.iterations > MAX_ITERATIONS
  ) {
    throw new VaultError('invalid-file', 'The backup file uses unsupported encryption settings.');
  }
  if (typeof kdf.salt !== 'string' || kdf.salt.length > 256) throw new VaultError('invalid-file');
  if (!isRecord(cipher) || cipher.name !== 'AES-GCM' || typeof cipher.iv !== 'string' || cipher.iv.length > 64) {
    throw new VaultError('invalid-file');
  }
  if (typeof ciphertext !== 'string' || ciphertext.length < 24 || ciphertext.length > MAX_FILE_BYTES * 2) {
    throw new VaultError('invalid-file');
  }
  return {
    format: 'medtracker-vault',
    version: 1,
    createdAt,
    compressed,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: kdf.iterations, salt: kdf.salt },
    cipher: { name: 'AES-GCM', iv: cipher.iv },
    ciphertext,
  };
}

export async function decryptVault(file: unknown, passphrase: string): Promise<AppData> {
  const vault = parseVaultFile(file);
  const salt = fromBase64(vault.kdf.salt, 'salt');
  const iv = fromBase64(vault.cipher.iv, 'IV');
  if (salt.length < 8 || salt.length > 64 || iv.length !== IV_BYTES) {
    throw new VaultError('invalid-file', 'The backup file is damaged (bad salt or IV).');
  }
  const ct = fromBase64(vault.ciphertext, 'ciphertext');
  const { ciphertext: _ignored, ...header } = vault;
  void _ignored;

  const key = await deriveKey(passphrase, salt, vault.kdf.iterations);
  let plain: Bytes;
  try {
    const buf = await globalThis.crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: headerAad(header) },
      key,
      ct,
    );
    plain = new Uint8Array(buf);
  } catch {
    throw new VaultError('wrong-passphrase');
  }
  if (vault.compressed) {
    if (typeof DecompressionStream === 'undefined') {
      throw new VaultError('invalid-data', 'This browser cannot open compressed backups.');
    }
    plain = await streamThrough(plain, new DecompressionStream('gzip'), MAX_PLAINTEXT_BYTES);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
  } catch {
    throw new VaultError('invalid-data', 'The backup contents are not valid JSON.');
  }
  return validateAppData(parsed);
}

// ---------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------

function bad(path: string, problem: string): never {
  throw new VaultError('invalid-data', `Invalid backup data: ${path} ${problem}.`);
}

function obj(x: unknown, path: string): Record<string, unknown> {
  if (!isRecord(x)) bad(path, 'must be an object');
  return x;
}

function str(x: unknown, path: string, max: number, opts: { nonEmpty?: boolean } = {}): string {
  if (typeof x !== 'string') bad(path, 'must be text');
  if (x.length > max) bad(path, `is too long (max ${max} characters)`);
  if (opts.nonEmpty && x.trim().length === 0) bad(path, 'must not be empty');
  return x;
}

function optStr(o: Record<string, unknown>, key: string, path: string, max: number): string | undefined {
  const v = o[key];
  return v === undefined ? undefined : str(v, `${path}.${key}`, max);
}

function num(x: unknown, path: string, min: number, max: number, integer = false): number {
  if (typeof x !== 'number' || !Number.isFinite(x)) bad(path, 'must be a number');
  if (x < min || x > max) bad(path, `must be between ${min} and ${max}`);
  if (integer && !Number.isInteger(x)) bad(path, 'must be a whole number');
  return x;
}

function bool(x: unknown, path: string): boolean {
  if (typeof x !== 'boolean') bad(path, 'must be true or false');
  return x;
}

function arr(x: unknown, path: string, max: number): unknown[] {
  if (!Array.isArray(x)) bad(path, 'must be a list');
  if (x.length > max) bad(path, `has too many entries (max ${max})`);
  return x;
}

function oneOf<T extends string>(x: unknown, path: string, allowed: readonly T[]): T {
  if (typeof x !== 'string' || !(allowed as readonly string[]).includes(x)) {
    bad(path, `must be one of: ${allowed.join(', ')}`);
  }
  return x as T;
}

function isoTimestamp(x: unknown, path: string): string {
  const s = str(x, path, 64, { nonEmpty: true });
  if (Number.isNaN(Date.parse(s))) bad(path, 'must be a valid date and time');
  return s;
}

function dateOnly(x: unknown, path: string): string {
  const s = str(x, path, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) bad(path, 'must be a date like 2025-01-31');
  const d = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!));
  if (d.getUTCFullYear() !== +m[1]! || d.getUTCMonth() !== +m[2]! - 1 || d.getUTCDate() !== +m[3]!) {
    bad(path, 'must be a real calendar date');
  }
  return s;
}

function validateSchedule(x: unknown, path: string): Schedule {
  const o = obj(x, path);
  const preset = oneOf(o.preset, `${path}.preset`, ['daily', 'twice_daily', 'every_other_day', 'custom'] as const);
  const times = arr(o.times, `${path}.times`, 48).map((t, i) => {
    const s = str(t, `${path}.times[${i}]`, 5);
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(s)) bad(`${path}.times[${i}]`, 'must be a time like 08:30');
    return s;
  });
  const schedule: Schedule = {
    preset,
    useSpecificTimes: bool(o.useSpecificTimes, `${path}.useSpecificTimes`),
    times,
    startDate: dateOnly(o.startDate, `${path}.startDate`),
  };
  if (o.interval !== undefined) schedule.interval = num(o.interval, `${path}.interval`, 1, 365, true);
  if (o.unit !== undefined) schedule.unit = oneOf(o.unit, `${path}.unit`, ['day', 'week'] as const);
  if (o.weekdays !== undefined) {
    schedule.weekdays = arr(o.weekdays, `${path}.weekdays`, 7).map((d, i) =>
      num(d, `${path}.weekdays[${i}]`, 0, 6, true),
    );
  }
  if (o.endDate !== undefined) schedule.endDate = dateOnly(o.endDate, `${path}.endDate`);
  return schedule;
}

function strList(x: unknown, path: string, maxItems: number, maxLen: number): string[] {
  return arr(x, path, maxItems).map((s, i) => str(s, `${path}[${i}]`, maxLen));
}

function validateDrugInfo(x: unknown, path: string): DrugInfo {
  const o = obj(x, path);
  const LONG = 50_000;
  const info: DrugInfo = {
    brandNames: strList(o.brandNames ?? [], `${path}.brandNames`, 50, 200),
    drugClasses: strList(o.drugClasses ?? [], `${path}.drugClasses`, 50, 200),
    sources: arr(o.sources ?? [], `${path}.sources`, 50).map((s, i) => {
      const sp = `${path}.sources[${i}]`;
      const so = obj(s, sp);
      const url = str(so.url, `${sp}.url`, 2000, { nonEmpty: true });
      let protocol = '';
      try {
        protocol = new URL(url).protocol;
      } catch {
        bad(`${sp}.url`, 'must be a web address');
      }
      if (protocol !== 'http:' && protocol !== 'https:') bad(`${sp}.url`, 'must start with http:// or https://');
      return { label: str(so.label, `${sp}.label`, 200), url };
    }),
    fetchedAt: o.fetchedAt === undefined ? '' : str(o.fetchedAt, `${path}.fetchedAt`, 64),
  };
  const rxcui = optStr(o, 'rxcui', path, 50);
  if (rxcui !== undefined) info.rxcui = rxcui;
  const genericName = optStr(o, 'genericName', path, 200);
  if (genericName !== undefined) info.genericName = genericName;
  for (const key of [
    'purpose',
    'indications',
    'dosageAndAdministration',
    'warnings',
    'boxedWarning',
    'sideEffects',
    'interactions',
  ] as const) {
    const v = optStr(o, key, path, key === 'purpose' ? 1000 : LONG);
    if (v !== undefined) info[key] = v;
  }
  return info;
}

function validateMedication(x: unknown, path: string): Medication {
  const o = obj(x, path);
  const color = str(o.color, `${path}.color`, 9);
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)) bad(`${path}.color`, 'must be a hex colour like #0f766e');
  const med: Medication = {
    id: str(o.id, `${path}.id`, 100, { nonEmpty: true }),
    name: str(o.name, `${path}.name`, 200, { nonEmpty: true }),
    dosage: str(o.dosage, `${path}.dosage`, 100),
    color,
    schedule: validateSchedule(o.schedule, `${path}.schedule`),
    notificationsEnabled: bool(o.notificationsEnabled, `${path}.notificationsEnabled`),
    createdAt: isoTimestamp(o.createdAt, `${path}.createdAt`),
    updatedAt: isoTimestamp(o.updatedAt, `${path}.updatedAt`),
  };
  const form = optStr(o, 'form', path, 100);
  if (form !== undefined) med.form = form;
  if (o.quantityPerDose !== undefined) med.quantityPerDose = num(o.quantityPerDose, `${path}.quantityPerDose`, 0, 1_000_000);
  const instructions = optStr(o, 'instructions', path, 2000);
  if (instructions !== undefined) med.instructions = instructions;
  const prescriber = optStr(o, 'prescriber', path, 200);
  if (prescriber !== undefined) med.prescriber = prescriber;
  const pharmacy = optStr(o, 'pharmacy', path, 200);
  if (pharmacy !== undefined) med.pharmacy = pharmacy;
  if (o.refillDate !== undefined && o.refillDate !== '') med.refillDate = dateOnly(o.refillDate, `${path}.refillDate`);
  if (o.supplyRemaining !== undefined) med.supplyRemaining = num(o.supplyRemaining, `${path}.supplyRemaining`, 0, 1_000_000_000);
  const notes = optStr(o, 'notes', path, 5000);
  if (notes !== undefined) med.notes = notes;
  if (o.drugInfo !== undefined) med.drugInfo = validateDrugInfo(o.drugInfo, `${path}.drugInfo`);
  return med;
}

function validateDoseLog(x: unknown, path: string): DoseLog {
  const o = obj(x, path);
  const log: DoseLog = {
    id: str(o.id, `${path}.id`, 200, { nonEmpty: true }),
    medId: str(o.medId, `${path}.medId`, 100, { nonEmpty: true }),
    scheduledFor: isoTimestamp(o.scheduledFor, `${path}.scheduledFor`),
    status: oneOf(o.status, `${path}.status`, ['taken', 'skipped'] as const),
    loggedAt: isoTimestamp(o.loggedAt, `${path}.loggedAt`),
  };
  if (o.supplyDeducted !== undefined) log.supplyDeducted = num(o.supplyDeducted, `${path}.supplyDeducted`, 0, 1_000_000);
  return log;
}

function assertUniqueIds(items: { id: string }[], path: string): void {
  const seen = new Set<string>();
  items.forEach((item, i) => {
    if (seen.has(item.id)) bad(`${path}[${i}].id`, 'is a duplicate');
    seen.add(item.id);
  });
}

/** Strict structural validation. Rebuilds every object from known keys (unknown fields dropped). */
export function validateAppData(x: unknown): AppData {
  const o = obj(x, 'backup');
  if (o.version !== 1) bad('backup.version', 'must be 1');
  const medications = arr(o.medications, 'medications', MAX_MEDICATIONS).map((m, i) =>
    validateMedication(m, `medications[${i}]`),
  );
  const doseLogs = arr(o.doseLogs, 'doseLogs', MAX_DOSE_LOGS).map((l, i) => validateDoseLog(l, `doseLogs[${i}]`));
  assertUniqueIds(medications, 'medications');
  assertUniqueIds(doseLogs, 'doseLogs');
  return { version: 1, medications, doseLogs };
}

// ---------------------------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------------------------

/** Medications by id (newer `updatedAt` wins, ties keep current); dose logs unioned by id (incoming wins). */
export function mergeAppData(current: AppData, incoming: AppData): AppData {
  const meds = new Map<string, Medication>();
  for (const m of current.medications) meds.set(m.id, m);
  for (const m of incoming.medications) {
    const existing = meds.get(m.id);
    if (!existing || Date.parse(m.updatedAt) > Date.parse(existing.updatedAt)) meds.set(m.id, m);
  }
  // One log per scheduled dose: the same dose may have been logged separately on each device
  // (different random ids). The more recent action wins; incoming wins a tie.
  const logs = new Map<string, DoseLog>();
  const doseKey = (l: DoseLog) => `${l.medId}|${new Date(l.scheduledFor).toISOString()}`;
  for (const l of current.doseLogs) {
    const prev = logs.get(doseKey(l));
    if (!prev || Date.parse(l.loggedAt) > Date.parse(prev.loggedAt)) logs.set(doseKey(l), l);
  }
  for (const l of incoming.doseLogs) {
    const prev = logs.get(doseKey(l));
    if (!prev || Date.parse(l.loggedAt) >= Date.parse(prev.loggedAt)) logs.set(doseKey(l), l);
  }
  const doseLogs: DoseLog[] = [];
  const ids = new Set<string>();
  for (const l of logs.values()) {
    // Keep ids unique so the merged data still passes validateAppData.
    const id = ids.has(l.id) ? globalThis.crypto.randomUUID() : l.id;
    ids.add(id);
    doseLogs.push(id === l.id ? l : { ...l, id });
  }
  return { version: 1, medications: [...meds.values()], doseLogs };
}

// ---------------------------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------------------------

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function downloadVault(file: VaultFile, filename?: string): void {
  const now = new Date();
  const name = filename ?? `medtracker-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}.medvault`;
  const blob = new Blob([JSON.stringify(file)], { type: 'application/octet-stream' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export async function readVaultFile(file: File): Promise<unknown> {
  if (file.size > MAX_FILE_BYTES) {
    throw new VaultError('invalid-file', 'That file is too large to be a backup (limit 20 MB).');
  }
  let text: string;
  try {
    text = await file.text();
  } catch {
    throw new VaultError('invalid-file', 'The file could not be read.');
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new VaultError('invalid-file');
  }
}

// ---------------------------------------------------------------------------------------------
// Passphrases
// ---------------------------------------------------------------------------------------------

/** Uniform random integer in [0, n) using rejection sampling (no modulo bias). */
function randomInt(n: number): number {
  const limit = Math.floor(0x1_0000_0000 / n) * n;
  const buf = new Uint32Array(1);
  for (;;) {
    globalThis.crypto.getRandomValues(buf);
    if (buf[0]! < limit) return buf[0]! % n;
  }
}

export function generatePassphrase(words = 6): string {
  const count = Math.max(1, Math.min(32, Math.floor(words)));
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(WORDS[randomInt(WORDS.length)]!);
  return out.join('-');
}

export function estimatePassphraseStrength(p: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  const labels = ['Very weak', 'Weak', 'Fair', 'Strong', 'Very strong'] as const;
  let bits = 0;
  const seenWords = new Set<string>();
  for (const token of p.split(/[\s\-_.,]+/).filter(Boolean)) {
    const lower = token.toLowerCase();
    if (WORD_SET.has(lower)) {
      if (!seenWords.has(lower)) bits += Math.log2(WORDS.length);
      seenWords.add(lower);
      continue;
    }
    let pool = 0;
    if (/[a-z]/.test(token)) pool += 26;
    if (/[A-Z]/.test(token)) pool += 26;
    if (/\d/.test(token)) pool += 10;
    if (/[^A-Za-z0-9]/.test(token)) pool += 33;
    const perChar = Math.log2(Math.max(pool, 2));
    const seenChars = new Set<string>();
    let prev = -2;
    for (const ch of token) {
      const code = ch.codePointAt(0)!;
      // Repeats and simple runs (abc, 123, aaa) add almost no entropy.
      const predictable = seenChars.has(ch) || Math.abs(code - prev) <= 1;
      bits += predictable ? 0.5 : perChar;
      seenChars.add(ch);
      prev = code;
    }
  }
  if (/password|passw0rd|qwerty|letmein|123456|iloveyou|admin/i.test(p)) bits = Math.min(bits, 20);
  const score = bits < 28 ? 0 : bits < 45 ? 1 : bits < 60 ? 2 : bits < 75 ? 3 : 4;
  return { score, label: labels[score] };
}

// prettier-ignore
const WORDS: readonly string[] = `
able acid acorn actor adapt adult agent agree ahead aim alarm album alert alive allow alone alpha
amber ample angel anger angle ankle apple april apron arena argue arise armor army arrow ash aside
asset atlas attic audio aunt autumn avoid awake award aware axis baby back bacon badge bagel baker
ball bamboo band bank barn basic basil basin batch beach bean bear beat beauty bed bee beef bell
belt bench berry bike bill bird black blade blank blast bleak blend bless blink bliss block bloom
blue board boat bold bone bonus book boot boss bottle bowl box brain brake brave bread brick bride
brief bright bring broad brook broom brown brush bubble bucket build bulb bunch burn burst bus bush
butter button buy cabin cable cactus cake calm camel camp canal candle candy canoe canvas canyon
cap cape card cargo carpet carrot cart case cash castle cat catch cave cedar ceiling cell cellar
chain chair chalk champ change chart chase cheap check cheek cheese cherry chess chest chick chief
child chill chime chip choir chord circle city civil claim clam clap class clay clean clear clerk
click cliff climb clip clock close cloth cloud clover clown club clue coach coal coast coat cobra
cocoa code coffee coin cold collar color comb comet comic cook cool copper coral cord corn cost
cotton couch cough count court cover cow crab craft crane crash crate crayon cream creek crew crib
crisp crop cross crowd crown crumb crush crystal cube cup curl curve cycle daily daisy dance dare
dark dash date dawn day deal dear deck deep deer delta denim dense desk detail dial diary dice diet
dig dime dinner dirt dish ditch dive dizzy dock doctor dog doll dome donut door dose dot dove down
dozen draft dragon draw dream dress drift drill drink drive drop drum dry duck dune dusk dust duty
dwarf eagle early earth ease east easy echo edge egg eight elbow elder elf elm email ember empty
end enemy energy engine enjoy enter envoy equal error essay even event ever exact exam extra eye
fable face fact fade fair fairy faith fall false fame fan farm fast fat fault feast fed feel fence
fern ferry fever few field fig fight file fill film final find fine finger fire firm first fish
fist five fix flag flame flash flat flavor fleet flint float flock flood floor flour flow flower
fluid flute fly foam fog foil fold folk food foot force forest fork form fort forty fossil four fox
frame free fresh friend frog front frost fruit fudge fuel full fun funny fur future gadget gain
game garden garlic gas gate gear gem ghost giant gift ginger giraffe girl give glad glass glide
globe glove glow glue goal goat gold golf good goose grace grade grain grand grape grass gravel
gray great green greet grid grill grin grip groom group grove grow guard guess guest guide guitar
gum gym habit hair half hall hammer hand happy harbor hard harp hat hawk hay hazel head heal heap
heart heat heavy hedge heel helm help hen herb hero hill hint hip hive hobby hockey hold hole holy
home honey hood hook hope horn horse hose hotel hour house human humble hunt hurry hut ice icon
idea igloo image inch index ink inn insect iron island ivory ivy jacket jade jam jar jazz jelly jet
jewel job join joke jolly joy judge juice jump jungle junior just kayak keen keep kettle key kick
kid kind king kiss kit kite kitten kiwi knee knife knit knob knock knot know label lace ladder lady
lake lamb lamp land lane lap large laser last late laugh lava lawn layer lazy leaf lean leap learn
leash leave left leg lemon lend lens leopard lesson letter level lever lid life lift light lily
limb lime line link lion lip list live lizard load loaf lobby local lock lodge log lone long look
loop lost loud love low luck lunch lung magic maid mail main major maker mall mango maple marble
march mark market mask mast match math maze meadow meal meat medal melon melt memo mend menu mercy
mesh metal meter mice middle mild mile milk mill mind mine mint minus mirror mist mitt mix model
moist mole mom money monk month moon moose moral moss moth motor mount mouse mouth move movie mud
mug mule music nail name nap navy neat neck needle nerve nest net never new news next nice night
nine noble nod noise noon north nose note novel nurse nut oak oar oasis oat ocean offer office
often oil old olive omen once onion open opera orange orbit order organ otter ounce outer oval oven
owl own ox oxygen oyster pace pack paddle page pail paint pair palace palm pan panda panel pants
paper parade park parrot party pasta paste patch path pause paw pea peace peach peak pear pearl
pedal peel pen pencil penny pepper perch pet phone photo piano pick picnic pie piece pig pilot pine
pink pipe pitch pizza place plain plan plane plant plate play plaza plot plug plum plus pocket poem
point polar pole pond pony pool poppy porch port post pot pouch powder power prefer press price
pride print prize pull pulse pump punch pupil puppy pure purple purse puzzle quack quail quake
queen quest quick quiet quilt quiz rabbit race radio raft rail rain raise ranch range rapid rare
raven razor reach read ready real reef relax relay rent rest rib rice rich ride ridge right ring
rinse ripe rise river road roast robe robin robot rock rocket roll roof room root rope rose rough
round route row royal rub ruby rug rule run rust sad saddle safe sage sail salad salt sand sauce
saw scale scarf scene school score scout screen screw sea seal seat seed sell send sense serve
seven shade shadow shake shape share shark sharp shed sheep sheet shelf shell shield shift shine
ship shirt shoe shop shore short show shy side sign silk silver simple sing sink sip sister six
size skate sketch ski skill skin skirt sky slate sleep slice slide slim slope slow small smart
smell smile smoke snack snail snake snow soap sock sofa soft soil solar solid song soon sound soup
south space spare spark speak speed spell spice spider spin spoon sport spot spray spring spy
square squid stable staff stage stair stamp stand star start state steam steel stem step stick
still stone stool store storm story stove straw stream street string strip strong studio study
sugar suit summer sun super swan sweet swim swing sword syrup table tail talk tall tame tank tape
task taste tea teach team tear tent term test thank theme thick thin think three throw thumb
thunder ticket tide tie tiger tile time tiny tip tire title toad toast today toe tomato tone tongue
tool tooth top torch total touch towel tower town toy track trade trail train trap tray tree trend
trial tribe trick trip truck true trunk trust truth tub tulip tuna tune tunnel turn turtle twin
twist uncle under union unit upper urban urge use usual vacuum valley value van vase vault vein
velvet verb verse vest video view villa vine violet violin visit vital voice volume vote wage wagon
waist wait wake walk wall walnut want warm wash wasp watch water wave wax way weak wealth weave web
week weigh well west whale wheat wheel whip white whole wide wife wild willow win wind window wine
wing winter wire wise wish witch wolf woman wonder wood wool word work world worm worth wrap wrist
write yacht yard yarn year yellow yes yoga yogurt young youth zebra zero zest zinc zip zone zoo
`.trim().split(/\s+/);

const WORD_SET: ReadonlySet<string> = new Set(WORDS);
