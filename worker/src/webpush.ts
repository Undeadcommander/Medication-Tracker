// Web Push for Workers using only WebCrypto (no Node `web-push`):
//  - RFC 8291 message encryption with the RFC 8188 "aes128gcm" content coding (one record).
//  - RFC 8292 VAPID: an ES256 JWT in `Authorization: vapid t=<jwt>, k=<public key>`.

const encoder = new TextEncoder();
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(encoder.encode(s));

export function b64urlDecode(s: string): Uint8Array<ArrayBuffer> {
  const clean = s.replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  if (!/^[A-Za-z0-9_-]*$/.test(clean)) throw new Error('invalid base64url');
  const bin = atob(clean.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (clean.length % 4)) % 4));
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function b64urlEncode(bytes: Uint8Array | ArrayBuffer): string {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (let i = 0; i < u.length; i++) bin += String.fromCharCode(u[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(parts.reduce((n, p) => n + p.length, 0)));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

async function hkdf(salt: Uint8Array<ArrayBuffer>, ikm: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, bytes: number) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, bytes * 8));
}

/** Record size advertised in the header. The whole message is one record, so it bounds the payload. */
export const RECORD_SIZE = 4096;
/** Header: salt(16) + rs(4) + idlen(1) + keyid(65). */
const HEADER_LEN = 86;
/** Push services accept at least 4096 bytes of body; leave room for the header, delimiter and tag. */
export const MAX_PLAINTEXT = 4096 - HEADER_LEN - 1 - 16;

export interface SubscriptionKeys {
  /** Subscriber's P-256 public key, base64url (65-byte uncompressed point). */
  p256dh: string;
  /** Subscriber's 16-byte auth secret, base64url. */
  auth: string;
}

/** Test hook: fixed sender key pair and salt instead of random ones. */
export interface EncryptOverrides {
  senderKeys?: CryptoKeyPair;
  salt?: Uint8Array<ArrayBuffer>;
}

/** Encrypts `plaintext` for a subscription (RFC 8291) and returns the aes128gcm request body. */
export async function encryptPayload(
  keys: SubscriptionKeys,
  plaintext: Uint8Array<ArrayBuffer>,
  overrides: EncryptOverrides = {},
): Promise<Uint8Array<ArrayBuffer>> {
  if (plaintext.length > MAX_PLAINTEXT) throw new Error(`payload too large (${plaintext.length} > ${MAX_PLAINTEXT})`);
  const uaPublic = b64urlDecode(keys.p256dh);
  const authSecret = b64urlDecode(keys.auth);
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error('invalid p256dh key');
  if (authSecret.length < 16) throw new Error('invalid auth secret');

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  // A fresh sender key pair per message (RFC 8291 §2).
  const sender =
    overrides.senderKeys ??
    ((await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey('raw', sender.publicKey)) as ArrayBuffer);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey } as unknown as Parameters<SubtleCrypto['deriveBits']>[0], sender.privateKey, 256),
  );

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const keyInfo = concat(utf8('WebPush: info\0'), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);

  const salt = overrides.salt ?? crypto.getRandomValues(new Uint8Array(new ArrayBuffer(16)));
  const cek = await hkdf(salt, ikm, utf8('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, utf8('Content-Encoding: nonce\0'), 12);

  // Single (last) record: plaintext followed by the 0x02 delimiter, no padding.
  const record = concat(plaintext, new Uint8Array([2]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, record));

  const header = new Uint8Array(new ArrayBuffer(HEADER_LEN));
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

// ---------- VAPID ----------

export interface VapidConfig {
  /** base64url, 65-byte uncompressed P-256 point (the format `web-push generate-vapid-keys` prints). */
  publicKey: string;
  /** base64url, 32-byte private scalar. */
  privateKey: string;
  /** mailto: or https: contact URL. */
  subject: string;
}

const SUBJECT_RE = /^(mailto:[^\s@]+@[^\s@]+|https:\/\/\S+)$/;
export const DEFAULT_SUBJECT = 'mailto:admin@example.com';

export function normaliseSubject(subject: string | undefined): string {
  const s = subject?.trim() ?? '';
  return SUBJECT_RE.test(s) ? s : DEFAULT_SUBJECT;
}

export async function importVapidPrivateKey(publicKey: string, privateKey: string): Promise<CryptoKey> {
  const pub = b64urlDecode(publicKey);
  const d = b64urlDecode(privateKey);
  if (pub.length !== 65 || pub[0] !== 4 || d.length !== 32) throw new Error('invalid VAPID key pair');
  return crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33, 65)), d: b64urlEncode(d) },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
}

/** Builds and signs a VAPID JWT (ES256; WebCrypto already returns the raw r||s that JWS needs). */
export async function signVapidJwt(key: CryptoKey, audience: string, subject: string, expSeconds: number): Promise<string> {
  const header = b64urlEncode(utf8(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = b64urlEncode(utf8(JSON.stringify({ aud: audience, exp: expSeconds, sub: subject })));
  const input = `${header}.${claims}`;
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, utf8(input));
  return `${input}.${b64urlEncode(sig)}`;
}

/** JWT lifetime. RFC 8292 caps it at 24 h; 12 h is what web-push uses. */
const JWT_TTL_S = 12 * 3600;
/** Re-sign when a cached token has less than this left. */
const JWT_MIN_LEFT_S = 3600;

/** Signs VAPID tokens, caching one per push-service origin to save CPU. */
export class VapidSigner {
  private key: Promise<CryptoKey> | null = null;
  private cache = new Map<string, { token: string; exp: number }>();

  constructor(readonly config: VapidConfig) {}

  async authorization(endpoint: string, nowMs = Date.now()): Promise<string> {
    const aud = new URL(endpoint).origin;
    const now = Math.floor(nowMs / 1000);
    let hit = this.cache.get(aud);
    if (!hit || hit.exp - now < JWT_MIN_LEFT_S) {
      this.key ??= importVapidPrivateKey(this.config.publicKey, this.config.privateKey);
      const exp = now + JWT_TTL_S;
      hit = { token: await signVapidJwt(await this.key, aud, this.config.subject, exp), exp };
      this.cache.set(aud, hit);
    }
    return `vapid t=${hit.token}, k=${this.config.publicKey}`;
  }
}

export interface PushTarget {
  endpoint: string;
  keys: SubscriptionKeys;
}

export interface PushOptions {
  ttl?: number;
  urgency?: 'very-low' | 'low' | 'normal' | 'high';
  timeoutMs?: number;
}

/** Builds the push-service request for one message (no network). */
export async function buildPushRequest(
  signer: VapidSigner,
  target: PushTarget,
  payload: string,
  opts: PushOptions = {},
): Promise<Request> {
  const body = await encryptPayload(target.keys, utf8(payload));
  return new Request(target.endpoint, {
    method: 'POST',
    headers: {
      Authorization: await signer.authorization(target.endpoint),
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: String(opts.ttl ?? 3600),
      Urgency: opts.urgency ?? 'high',
    },
    body,
  });
}

export type SendResult = 'ok' | 'gone' | 'error';

/**
 * Sends one message. 404/410 mean the subscription expired; 401/403 mean it was made for a
 * different VAPID key (same rule as server/index.ts). Anything else is retried later.
 */
export async function sendPush(
  signer: VapidSigner,
  target: PushTarget,
  payload: string,
  opts: PushOptions = {},
): Promise<{ result: SendResult; status: number }> {
  let req: Request;
  try {
    req = await buildPushRequest(signer, target, payload, opts);
  } catch (err) {
    console.warn('[push] could not build push request:', (err as Error).message);
    return { result: 'error', status: 0 };
  }
  try {
    const res = await fetch(req, { signal: AbortSignal.timeout(opts.timeoutMs ?? 10_000) });
    // Drain the body so the connection is released.
    await res.body?.cancel().catch(() => {});
    const s = res.status;
    if (s >= 200 && s < 300) return { result: 'ok', status: s };
    if (s === 404 || s === 410 || s === 401 || s === 403) return { result: 'gone', status: s };
    return { result: 'error', status: s };
  } catch (err) {
    console.warn('[push] network error:', (err as Error).message);
    return { result: 'error', status: 0 };
  }
}
