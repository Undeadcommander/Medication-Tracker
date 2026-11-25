/**
 * End-to-end encryption for cloud sync.
 *
 * Keys:
 *  - Each account has one random AES-256-GCM data encryption key (DEK). Every synced medication
 *    and dose log is encrypted with it on the device, so Firestore only ever holds ciphertext.
 *  - The DEK is stored in Firestore (`users/{uid}/meta/crypto`) only in wrapped form, twice:
 *      1. wrapped with a key derived from the user's sync passphrase (PBKDF2-SHA-256, 600k), and
 *      2. wrapped with a key derived from a random 128-bit recovery key (HKDF-SHA-256).
 *    Each wrapping has a key-check value so a wrong passphrase can be told apart from a damaged
 *    document. The recovery key itself is also kept in the meta document, encrypted with the DEK,
 *    so an unlocked device can show it again or re-wrap the DEK without asking for secrets.
 *  - On a device, the unwrapped DEK lives only as a non-extractable CryptoKey in IndexedDB
 *    (see keyStore.ts).
 *
 * Every ciphertext is bound (AES-GCM additional data) to the account uid, the collection and the
 * document / field it belongs to, so ciphertext can't be moved between documents or accounts.
 * Plaintexts are length-padded so sizes reveal little (dose logs all encrypt to the same size).
 *
 * Nothing in this module logs or persists secrets.
 */
import type { DoseLog, Medication } from '../../shared/types';

export type SyncCryptoErrorCode =
  | 'wrong-passphrase'
  | 'wrong-recovery-key'
  | 'invalid-recovery-key'
  | 'corrupt'
  | 'unsupported'
  | 'weak-passphrase'
  | 'already-set-up'
  | 'changed-elsewhere'
  | 'offline'
  | 'not-ready';

const MESSAGES: Record<SyncCryptoErrorCode, string> = {
  'wrong-passphrase': 'Wrong passphrase. Check it and try again.',
  'wrong-recovery-key': "That recovery key doesn't match this account.",
  'invalid-recovery-key': "That doesn't look like a recovery key. Check for typos: it has 7 groups of 4 letters and digits.",
  corrupt: "The account's encryption settings in the cloud are damaged and can't be read.",
  unsupported: 'This account was set up by a newer version of Amendra. Reload the app to update it.',
  'weak-passphrase': 'Choose a longer, harder-to-guess passphrase.',
  'already-set-up': 'Encryption was just set up for this account on another device. Unlock with that passphrase instead.',
  'changed-elsewhere': 'The encryption settings were changed on another device at the same time. Please try again.',
  offline: "You're offline. Connect to the internet and try again.",
  'not-ready': "The account's encryption settings haven't loaded yet. Check your connection and try again.",
};

export class SyncCryptoError extends Error {
  code: SyncCryptoErrorCode;
  constructor(code: SyncCryptoErrorCode) {
    super(MESSAGES[code]);
    this.name = 'SyncCryptoError';
    this.code = code;
  }
}

export const KDF_ITERATIONS = 600_000;
const MIN_ITERATIONS = 100_000;
const MAX_ITERATIONS = 5_000_000;
const IV_BYTES = 12;
const SALT_BYTES = 16;
const RECOVERY_BYTES = 16;
/** Medications pad to a multiple of this many bytes, dose logs to exactly LOG_PAD. */
const MED_PAD = 512;
const LOG_PAD = 256;
const CHECK_TEXT = 'medtracker key check v1';

// ---------------------------------------------------------------------------------------------
// Bytes
// ---------------------------------------------------------------------------------------------

type Bytes = Uint8Array<ArrayBuffer>;
const subtle = () => globalThis.crypto.subtle;

function bytes(n: number): Bytes {
  return new Uint8Array(new ArrayBuffer(n));
}

function randomBytes(n: number): Bytes {
  const out = bytes(n);
  globalThis.crypto.getRandomValues(out);
  return out;
}

function utf8(s: string): Bytes {
  const enc = new TextEncoder().encode(s);
  const out = bytes(enc.length);
  out.set(enc);
  return out;
}

export function toBase64(b: Uint8Array): string {
  let bin = '';
  for (let i = 0; i < b.length; i += 0x8000) bin += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(bin);
}

function fromBase64(s: unknown): Bytes {
  if (typeof s !== 'string' || s.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw new SyncCryptoError('corrupt');
  const bin = atob(s);
  const out = bytes(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(input: Bytes, stream: CompressionStream | DecompressionStream): Promise<Bytes> {
  const buf = await new Response(new Blob([input]).stream().pipeThrough(stream)).arrayBuffer();
  return new Uint8Array(buf);
}

// ---------------------------------------------------------------------------------------------
// Additional authenticated data (what each ciphertext is bound to)
// ---------------------------------------------------------------------------------------------

const aad = (...parts: string[]) => utf8(['medtracker', 'v1', ...parts].join('\u0000'));
const medAad = (uid: string, medId: string) => aad(uid, 'meds', medId);
const logAad = (uid: string, month: string, logId: string) => aad(uid, 'logs', month, logId);
const wrapAad = (uid: string, keyId: string, slot: 'pass' | 'recovery') => aad(uid, 'meta', keyId, slot, 'dek');
const checkAad = (uid: string, keyId: string, slot: 'pass' | 'recovery') => aad(uid, 'meta', keyId, slot, 'check');
const recoveryBoxAad = (uid: string, keyId: string) => aad(uid, 'meta', keyId, 'recovery-box');

// ---------------------------------------------------------------------------------------------
// Recovery key: 128 random bits + 10-bit checksum, Crockford base32, 7 groups of 4
// ---------------------------------------------------------------------------------------------

const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

async function checksum10(b: Bytes): Promise<number> {
  const h = new Uint8Array(await subtle().digest('SHA-256', b));
  return (h[0]! << 2) | (h[1]! >> 6);
}

export async function formatRecoveryKey(raw: Uint8Array): Promise<string> {
  if (raw.length !== RECOVERY_BYTES) throw new Error('bad recovery key length');
  const copy = bytes(raw.length);
  copy.set(raw);
  // 128 data bits + 2 zero bits = 26 chars, then a 10-bit checksum = 2 chars.
  let bits = 0n;
  for (const x of copy) bits = (bits << 8n) | BigInt(x);
  bits <<= 2n;
  let chars = '';
  for (let i = 25; i >= 0; i--) chars += B32[Number((bits >> BigInt(i * 5)) & 31n)];
  const sum = await checksum10(copy);
  chars += B32[sum >> 5]! + B32[sum & 31]!;
  return chars.match(/.{4}/g)!.join('-');
}

export async function parseRecoveryKey(input: string): Promise<Bytes> {
  const s = input
    .toUpperCase()
    .replace(/[\s-]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
  if (s.length !== 28 || [...s].some((c) => !B32.includes(c))) throw new SyncCryptoError('invalid-recovery-key');
  let bits = 0n;
  for (const c of s.slice(0, 26)) bits = (bits << 5n) | BigInt(B32.indexOf(c));
  if ((bits & 3n) !== 0n) throw new SyncCryptoError('invalid-recovery-key');
  bits >>= 2n;
  const raw = bytes(RECOVERY_BYTES);
  for (let i = RECOVERY_BYTES - 1; i >= 0; i--) {
    raw[i] = Number(bits & 0xffn);
    bits >>= 8n;
  }
  const sum = await checksum10(raw);
  if (B32.indexOf(s[26]!) !== sum >> 5 || B32.indexOf(s[27]!) !== (sum & 31)) throw new SyncCryptoError('invalid-recovery-key');
  return raw;
}

/**
 * Quick syntactic check (no checksum) used by the UI to choose which unlock path to try first:
 * the displayed format (7 dash-separated groups of 4) or the same 28 characters run together.
 * A passphrase can match too, so callers fall back to trying it as a passphrase.
 */
export function looksLikeRecoveryKey(input: string): boolean {
  return /^\s*[0-9a-z]{4}(-[0-9a-z]{4}){6}\s*$/i.test(input) || /^\s*[0-9a-z]{28}\s*$/i.test(input);
}

// ---------------------------------------------------------------------------------------------
// The meta/crypto document
// ---------------------------------------------------------------------------------------------

interface Box {
  iv: string;
  ct: string;
}

export interface CryptoMeta {
  v: 1;
  /** Random id of the DEK; devices compare it to notice the key was replaced elsewhere. */
  keyId: string;
  /** Incremented on every change, so concurrent edits from two devices are detected. */
  rev: number;
  pass: {
    kdf: 'PBKDF2-SHA-256';
    iterations: number;
    salt: string;
    /** DEK wrapped with the passphrase key. */
    wrapped: Box;
    /** Constant encrypted with the passphrase key: decrypts only with the right passphrase. */
    check: Box;
  };
  recovery: {
    kdf: 'HKDF-SHA-256';
    salt: string;
    wrapped: Box;
    check: Box;
  };
  /** The recovery key, encrypted with the DEK. */
  recoveryBox: Box;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

function parseBox(x: unknown): Box {
  if (!isRecord(x) || typeof x.iv !== 'string' || typeof x.ct !== 'string' || x.iv.length > 64 || x.ct.length > 4096) {
    throw new SyncCryptoError('corrupt');
  }
  return { iv: x.iv, ct: x.ct };
}

/** Validates a meta document read from Firestore. */
export function parseCryptoMeta(x: unknown): CryptoMeta {
  if (!isRecord(x)) throw new SyncCryptoError('corrupt');
  if (typeof x.v === 'number' && x.v > 1) throw new SyncCryptoError('unsupported');
  if (x.v !== 1) throw new SyncCryptoError('corrupt');
  const { keyId, rev, pass, recovery, recoveryBox } = x;
  if (typeof keyId !== 'string' || !keyId || keyId.length > 64) throw new SyncCryptoError('corrupt');
  if (typeof rev !== 'number' || !Number.isInteger(rev)) throw new SyncCryptoError('corrupt');
  if (!isRecord(pass) || !isRecord(recovery)) throw new SyncCryptoError('corrupt');
  if (pass.kdf !== 'PBKDF2-SHA-256' || recovery.kdf !== 'HKDF-SHA-256') throw new SyncCryptoError('unsupported');
  const it = pass.iterations;
  if (typeof it !== 'number' || !Number.isInteger(it) || it < MIN_ITERATIONS || it > MAX_ITERATIONS) {
    throw new SyncCryptoError('corrupt');
  }
  if (typeof pass.salt !== 'string' || pass.salt.length > 64 || typeof recovery.salt !== 'string' || recovery.salt.length > 64) {
    throw new SyncCryptoError('corrupt');
  }
  return {
    v: 1,
    keyId,
    rev,
    pass: { kdf: 'PBKDF2-SHA-256', iterations: it, salt: pass.salt, wrapped: parseBox(pass.wrapped), check: parseBox(pass.check) },
    recovery: { kdf: 'HKDF-SHA-256', salt: recovery.salt, wrapped: parseBox(recovery.wrapped), check: parseBox(recovery.check) },
    recoveryBox: parseBox(recoveryBox),
  };
}

// ---------------------------------------------------------------------------------------------
// Key derivation and wrapping
// ---------------------------------------------------------------------------------------------

const KEK_USAGES: KeyUsage[] = ['encrypt', 'decrypt', 'wrapKey', 'unwrapKey'];
const DEK_USAGES: KeyUsage[] = ['encrypt', 'decrypt'];

async function passphraseKek(passphrase: string, salt: Bytes, iterations: number): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', utf8(passphrase.normalize('NFKC')), 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    KEK_USAGES,
  );
}

async function recoveryKek(raw: Bytes, salt: Bytes): Promise<CryptoKey> {
  const material = await subtle().importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return subtle().deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: utf8('medtracker recovery kek v1') },
    material,
    { name: 'AES-GCM', length: 256 },
    false,
    KEK_USAGES,
  );
}

async function seal(key: CryptoKey, plain: Bytes, additionalData: Bytes): Promise<Box> {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().encrypt({ name: 'AES-GCM', iv, additionalData }, key, plain);
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

/** Throws on any failure (wrong key, tampering). */
async function open(key: CryptoKey, box: Box, additionalData: Bytes): Promise<Bytes> {
  const iv = fromBase64(box.iv);
  if (iv.length !== IV_BYTES) throw new SyncCryptoError('corrupt');
  return new Uint8Array(await subtle().decrypt({ name: 'AES-GCM', iv, additionalData }, key, fromBase64(box.ct)));
}

async function wrapDek(dek: CryptoKey, kek: CryptoKey, additionalData: Bytes): Promise<Box> {
  const iv = randomBytes(IV_BYTES);
  const ct = await subtle().wrapKey('raw', dek, kek, { name: 'AES-GCM', iv, additionalData });
  return { iv: toBase64(iv), ct: toBase64(new Uint8Array(ct)) };
}

async function unwrapDek(box: Box, kek: CryptoKey, additionalData: Bytes, extractable: boolean): Promise<CryptoKey> {
  const iv = fromBase64(box.iv);
  if (iv.length !== IV_BYTES) throw new SyncCryptoError('corrupt');
  return subtle().unwrapKey(
    'raw',
    fromBase64(box.ct),
    kek,
    { name: 'AES-GCM', iv, additionalData },
    { name: 'AES-GCM', length: 256 },
    extractable,
    DEK_USAGES,
  );
}

/** Check value first (wrong secret), then the wrapped key itself (damaged document). */
async function unwrapSlot(
  kek: CryptoKey,
  uid: string,
  meta: CryptoMeta,
  slot: 'pass' | 'recovery',
  extractable: boolean,
  wrong: SyncCryptoErrorCode,
): Promise<CryptoKey> {
  let check: Bytes;
  try {
    check = await open(kek, meta[slot].check, checkAad(uid, meta.keyId, slot));
  } catch {
    throw new SyncCryptoError(wrong);
  }
  if (new TextDecoder().decode(check) !== CHECK_TEXT) throw new SyncCryptoError(wrong);
  try {
    return await unwrapDek(meta[slot].wrapped, kek, wrapAad(uid, meta.keyId, slot), extractable);
  } catch {
    throw new SyncCryptoError('corrupt');
  }
}

export const MIN_SYNC_PASSPHRASE_LENGTH = 10;

async function passSlot(dek: CryptoKey, uid: string, keyId: string, passphrase: string, iterations: number): Promise<CryptoMeta['pass']> {
  if (passphrase.length < MIN_SYNC_PASSPHRASE_LENGTH) throw new SyncCryptoError('weak-passphrase');
  const salt = randomBytes(SALT_BYTES);
  const kek = await passphraseKek(passphrase, salt, iterations);
  return {
    kdf: 'PBKDF2-SHA-256',
    iterations,
    salt: toBase64(salt),
    wrapped: await wrapDek(dek, kek, wrapAad(uid, keyId, 'pass')),
    check: await seal(kek, utf8(CHECK_TEXT), checkAad(uid, keyId, 'pass')),
  };
}

async function recoverySlot(
  dek: CryptoKey,
  uid: string,
  keyId: string,
): Promise<{ recovery: CryptoMeta['recovery']; recoveryBox: Box; recoveryKey: string }> {
  const raw = randomBytes(RECOVERY_BYTES);
  const salt = randomBytes(SALT_BYTES);
  const kek = await recoveryKek(raw, salt);
  const recoveryKey = await formatRecoveryKey(raw);
  return {
    recovery: {
      kdf: 'HKDF-SHA-256',
      salt: toBase64(salt),
      wrapped: await wrapDek(dek, kek, wrapAad(uid, keyId, 'recovery')),
      check: await seal(kek, utf8(CHECK_TEXT), checkAad(uid, keyId, 'recovery')),
    },
    recoveryBox: await seal(dek, utf8(recoveryKey), recoveryBoxAad(uid, keyId)),
    recoveryKey,
  };
}

/** Non-extractable copy of an extractable key, for storing on the device. */
async function lockDown(dek: CryptoKey): Promise<CryptoKey> {
  if (!dek.extractable) return dek;
  const raw = new Uint8Array(await subtle().exportKey('raw', dek));
  try {
    return await subtle().importKey('raw', raw, { name: 'AES-GCM', length: 256 }, false, DEK_USAGES);
  } finally {
    raw.fill(0);
  }
}

export interface KeyBundle {
  meta: CryptoMeta;
  /** Non-extractable DEK for this device. */
  dek: CryptoKey;
  recoveryKey: string;
}

/** First-time setup: a new DEK, wrapped with the passphrase and a new recovery key. */
export async function createKeyBundle(uid: string, passphrase: string, iterations = KDF_ITERATIONS): Promise<KeyBundle> {
  const dek = await subtle().generateKey({ name: 'AES-GCM', length: 256 }, true, DEK_USAGES);
  const keyId = toBase64(randomBytes(12)).replace(/[+/=]/g, (c) => (c === '+' ? '-' : c === '/' ? '_' : ''));
  const pass = await passSlot(dek, uid, keyId, passphrase, iterations);
  const { recovery, recoveryBox, recoveryKey } = await recoverySlot(dek, uid, keyId);
  return { meta: { v: 1, keyId, rev: 1, pass, recovery, recoveryBox }, dek: await lockDown(dek), recoveryKey };
}

export async function unlockWithPassphrase(meta: CryptoMeta, uid: string, passphrase: string, extractable = false): Promise<CryptoKey> {
  const kek = await passphraseKek(passphrase, fromBase64(meta.pass.salt), meta.pass.iterations);
  return unwrapSlot(kek, uid, meta, 'pass', extractable, 'wrong-passphrase');
}

export async function unlockWithRecoveryKey(meta: CryptoMeta, uid: string, recoveryKey: string, extractable = false): Promise<CryptoKey> {
  const raw = await parseRecoveryKey(recoveryKey);
  const kek = await recoveryKek(raw, fromBase64(meta.recovery.salt));
  return unwrapSlot(kek, uid, meta, 'recovery', extractable, 'wrong-recovery-key');
}

/** The recovery key, readable by any device that holds the DEK. */
export async function readRecoveryKey(meta: CryptoMeta, uid: string, dek: CryptoKey): Promise<string> {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(await open(dek, meta.recoveryBox, recoveryBoxAad(uid, meta.keyId)));
  } catch {
    throw new SyncCryptoError('corrupt');
  }
}

/** A temporary extractable DEK (via the stored recovery key), needed to wrap it again. */
async function extractableDek(meta: CryptoMeta, uid: string, dek: CryptoKey): Promise<CryptoKey> {
  return unlockWithRecoveryKey(meta, uid, await readRecoveryKey(meta, uid, dek), true);
}

/** New passphrase: re-wraps the DEK only. Data stays encrypted with the same key. */
export async function changePassphrase(
  meta: CryptoMeta,
  uid: string,
  dek: CryptoKey,
  newPassphrase: string,
  iterations = KDF_ITERATIONS,
): Promise<CryptoMeta> {
  const full = await extractableDek(meta, uid, dek);
  return { ...meta, rev: meta.rev + 1, pass: await passSlot(full, uid, meta.keyId, newPassphrase, iterations) };
}

/** New recovery key (the old one stops working). Re-wraps the DEK only. */
export async function regenerateRecoveryKey(
  meta: CryptoMeta,
  uid: string,
  dek: CryptoKey,
): Promise<{ meta: CryptoMeta; recoveryKey: string }> {
  const full = await extractableDek(meta, uid, dek);
  const { recovery, recoveryBox, recoveryKey } = await recoverySlot(full, uid, meta.keyId);
  return { meta: { ...meta, rev: meta.rev + 1, recovery, recoveryBox }, recoveryKey };
}

// ---------------------------------------------------------------------------------------------
// Encrypted documents
// ---------------------------------------------------------------------------------------------

/** `meds/{medId}` */
export interface MedEnvelope {
  v: 1;
  iv: string;
  ct: string;
  /** keyId of the data key it's encrypted with (so leftovers from a key reset can be recognised). */
  k?: string;
}
/** One entry of `logs/{docId}.logs` */
export type LogEnvelope = MedEnvelope;

const FLAG_GZIP = 1;

/** [flags:1][length:4][payload][zero padding] */
function frame(payload: Uint8Array, flags: number, padTo: number, fixed: boolean): Bytes {
  const len = 5 + payload.length;
  const size = fixed && len <= padTo ? padTo : Math.ceil(len / padTo) * padTo;
  const out = bytes(size);
  out[0] = flags;
  new DataView(out.buffer).setUint32(1, payload.length);
  out.set(payload, 5);
  return out;
}

function unframe(b: Bytes): { flags: number; payload: Bytes } {
  if (b.length < 5) throw new Error('short');
  const len = new DataView(b.buffer, b.byteOffset).getUint32(1);
  if (5 + len > b.length) throw new Error('bad length');
  return { flags: b[0]!, payload: b.slice(5, 5 + len) };
}

async function encryptJson(dek: CryptoKey, value: unknown, additionalData: Bytes, kind: 'med' | 'log', keyId?: string): Promise<MedEnvelope> {
  let payload = utf8(JSON.stringify(value));
  let flags = 0;
  if (kind === 'med' && typeof CompressionStream !== 'undefined') {
    payload = await pipe(payload, new CompressionStream('gzip'));
    flags |= FLAG_GZIP;
  }
  const plain = frame(payload, flags, kind === 'med' ? MED_PAD : LOG_PAD, kind === 'log');
  const box = await seal(dek, plain, additionalData);
  return keyId ? { v: 1, ...box, k: keyId } : { v: 1, ...box };
}

async function decryptJson(dek: CryptoKey, env: unknown, additionalData: Bytes): Promise<unknown> {
  if (!isEnvelope(env)) throw new SyncCryptoError('corrupt');
  const { flags, payload } = unframe(await open(dek, env, additionalData));
  let data = payload;
  if (flags & FLAG_GZIP) {
    if (typeof DecompressionStream === 'undefined') throw new SyncCryptoError('unsupported');
    data = await pipe(data, new DecompressionStream('gzip'));
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data));
}

export function isEnvelope(x: unknown): x is MedEnvelope {
  return isRecord(x) && typeof x.iv === 'string' && typeof x.ct === 'string';
}

export function encryptMed(dek: CryptoKey, uid: string, med: Medication, keyId?: string): Promise<MedEnvelope> {
  return encryptJson(dek, med, medAad(uid, med.id), 'med', keyId);
}

/** Returns the decrypted (not yet validated) medication. Throws if tampered or wrong key. */
export async function decryptMed(dek: CryptoKey, uid: string, medId: string, env: unknown): Promise<unknown> {
  const med = await decryptJson(dek, env, medAad(uid, medId));
  if (!isRecord(med) || med.id !== medId) throw new SyncCryptoError('corrupt');
  return med;
}

/** `doc` is the log's cloud document id (bound into the ciphertext, so it can't be moved). */
export function encryptLog(dek: CryptoKey, uid: string, doc: string, log: DoseLog, keyId?: string): Promise<LogEnvelope> {
  return encryptJson(dek, log, logAad(uid, doc, log.id), 'log', keyId);
}

export async function decryptLog(dek: CryptoKey, uid: string, month: string, logId: string, env: unknown): Promise<unknown> {
  const log = await decryptJson(dek, env, logAad(uid, month, logId));
  if (!isRecord(log) || log.id !== logId) throw new SyncCryptoError('corrupt');
  return log;
}

// ---------------------------------------------------------------------------------------------
// Decoding a whole snapshot
// ---------------------------------------------------------------------------------------------

export interface RawDoc {
  id: string;
  data: unknown;
}

/** `meds/{id}` of a medication deleted for good (no secrets in it, so the rules can check it). */
export function isMedTombstone(x: unknown): boolean {
  return isRecord(x) && x.deleted === true && !('ct' in x);
}

export interface DecodedRemote {
  /** In the shape syncOps.remoteToAppData expects. */
  meds: { id: string; med: unknown }[];
  tombstones: string[];
  logDocs: { id: string; logs: Record<string, unknown> }[];
  /** Items still stored in plaintext (from before encryption): re-upload encrypted, then they're gone. */
  plaintext: { medIds: string[]; logs: { doc: string; id: string }[] };
  /** Ciphertext that failed to decrypt (tampered, damaged, or another key). Skipped, not deleted. */
  undecryptable: number;
  failedIds: { meds: string[]; logs: string[] };
  /**
   * Failed items that say they were encrypted with a different (older) key than the current one:
   * leftovers from a key reset, safe to delete.
   */
  staleKey: { meds: string[]; logs: { doc: string; id: string }[] };
  /** Decryption cache entries added and removed by this decode (to save between launches). */
  cacheAdded: [string, unknown][];
  cacheRemoved: string[];
}

/** Memo of decrypted items, keyed by location + IV (a fresh IV for every encryption). */
export type DecryptCache = Map<string, unknown>;

interface MedResult {
  med?: unknown;
  tomb?: boolean;
  plaintext?: boolean;
  failed?: boolean;
  stale?: boolean;
  keys: string[];
}
interface LogDocResult {
  logs: Record<string, unknown>;
  plaintext: string[];
  failed: string[];
  stale: string[];
  keys: string[];
}
/**
 * Results per document object. Sync keeps the data object of a document that didn't change, so an
 * unchanged document isn't looked at again. Make a new one whenever the key changes.
 */
export interface DecodeMemo {
  meds: WeakMap<object, MedResult>;
  logs: WeakMap<object, LogDocResult>;
}
export const newDecodeMemo = (): DecodeMemo => ({ meds: new WeakMap(), logs: new WeakMap() });

export async function decodeRemote(
  dek: CryptoKey,
  uid: string,
  meds: RawDoc[],
  logs: RawDoc[],
  cache: DecryptCache = new Map(),
  opts: { keyId?: string; memo?: DecodeMemo } = {},
): Promise<DecodedRemote> {
  const { keyId, memo } = opts;
  const out: DecodedRemote = {
    meds: [],
    tombstones: [],
    logDocs: [],
    plaintext: { medIds: [], logs: [] },
    undecryptable: 0,
    failedIds: { meds: [], logs: [] },
    staleKey: { meds: [], logs: [] },
    cacheAdded: [],
    cacheRemoved: [],
  };
  const seen = new Set<string>();
  const cached = async (key: string, keys: string[], fn: () => Promise<unknown>) => {
    keys.push(key);
    if (cache.has(key)) return cache.get(key);
    const v = await fn();
    cache.set(key, v);
    out.cacheAdded.push([key, v]);
    return v;
  };
  const isStale = (env: MedEnvelope) => typeof env.k === 'string' && !!keyId && env.k !== keyId;

  const medResult = async (id: string, data: unknown): Promise<MedResult> => {
    const keys: string[] = [];
    if (isMedTombstone(data)) return { tomb: true, keys };
    if (isEnvelope(data)) {
      try {
        return { med: await cached(`m|${id}|${data.iv}|${data.ct.length}`, keys, () => decryptMed(dek, uid, id, data)), keys };
      } catch {
        return { failed: true, stale: isStale(data), keys };
      }
    }
    return { plaintext: true, med: isRecord(data) ? data.med : undefined, keys };
  };

  const logResult = async (doc: string, data: unknown): Promise<LogDocResult> => {
    const r: LogDocResult = { logs: {}, plaintext: [], failed: [], stale: [], keys: [] };
    const entries = isRecord(data) && isRecord(data.logs) ? Object.entries(data.logs) : [];
    await Promise.all(
      entries.map(async ([logId, value]) => {
        if (isEnvelope(value)) {
          try {
            r.logs[logId] = await cached(`l|${doc}|${logId}|${value.iv}|${value.ct.length}`, r.keys, () =>
              decryptLog(dek, uid, doc, logId, value),
            );
          } catch {
            r.failed.push(logId);
            if (isStale(value)) r.stale.push(logId);
          }
        } else {
          r.plaintext.push(logId);
          r.logs[logId] = value;
        }
      }),
    );
    return r;
  };

  await Promise.all([
    ...meds.map(async ({ id, data }) => {
      const memoKey = isRecord(data) ? data : null;
      let r = memoKey ? memo?.meds.get(memoKey) : undefined;
      if (!r) {
        r = await medResult(id, data);
        if (memoKey && !r.failed) memo?.meds.set(memoKey, r);
      }
      r.keys.forEach((k) => seen.add(k));
      if (r.tomb) out.tombstones.push(id);
      else if (r.failed) {
        out.undecryptable++;
        out.failedIds.meds.push(id);
        if (r.stale) out.staleKey.meds.push(id);
      } else {
        if (r.plaintext) out.plaintext.medIds.push(id);
        out.meds.push({ id, med: r.med });
      }
    }),
    ...logs.map(async ({ id: doc, data }) => {
      const memoKey = isRecord(data) ? data : null;
      let r = memoKey ? memo?.logs.get(memoKey) : undefined;
      if (!r) {
        r = await logResult(doc, data);
        if (memoKey && !r.failed.length) memo?.logs.set(memoKey, r);
      }
      r.keys.forEach((k) => seen.add(k));
      out.undecryptable += r.failed.length;
      out.failedIds.logs.push(...r.failed);
      for (const id of r.stale) out.staleKey.logs.push({ doc, id });
      for (const id of r.plaintext) out.plaintext.logs.push({ doc, id });
      out.logDocs.push({ id: doc, logs: r.logs });
    }),
  ]);

  // Keep the memo from growing without bound.
  for (const k of cache.keys()) {
    if (!seen.has(k)) {
      cache.delete(k);
      out.cacheRemoved.push(k);
    }
  }
  return out;
}
