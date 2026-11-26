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

/** The subscription's keys can never work (bad length, not a P-256 point): the device is unusable. */
export class SubscriptionKeyError extends Error {}

/** The message is too big to encrypt into one record (retrying can't help). */
export class PayloadTooLargeError extends Error {
  constructor(size: number) {
    super(`payload too large (${size} > ${MAX_PLAINTEXT})`);
  }
}

async function importSubscriptionKeys(keys: SubscriptionKeys) {
  let uaPublic: Uint8Array<ArrayBuffer>;
  let authSecret: Uint8Array<ArrayBuffer>;
  try {
    uaPublic = b64urlDecode(keys.p256dh);
    authSecret = b64urlDecode(keys.auth);
  } catch {
    throw new SubscriptionKeyError('subscription keys are not base64url');
  }
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new SubscriptionKeyError('invalid p256dh key');
  if (authSecret.length !== 16) throw new SubscriptionKeyError('invalid auth secret');
  let uaKey: CryptoKey;
  try {
    uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  } catch {
    throw new SubscriptionKeyError('p256dh is not a P-256 point');
  }
  return { uaPublic, authSecret, uaKey };
}

/**
 * Checks a subscription's keys the way encryption will use them (65-byte uncompressed P-256
 * point, 16-byte auth secret) and returns them as unpadded base64url, or null if they can't work.
 */
export async function normaliseSubscriptionKeys(keys: SubscriptionKeys): Promise<SubscriptionKeys | null> {
  try {
    const { uaPublic, authSecret } = await importSubscriptionKeys(keys);
    return { p256dh: b64urlEncode(uaPublic), auth: b64urlEncode(authSecret) };
  } catch {
    return null;
  }
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
  if (plaintext.length > MAX_PLAINTEXT) throw new PayloadTooLargeError(plaintext.length);
  const { uaPublic, authSecret, uaKey } = await importSubscriptionKeys(keys);
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

/** A real domain name: dotted, letters/digits/hyphens, alphabetic TLD (so no IP literals or localhost). */
const DOTTED_HOST_RE = /^(?=.{4,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * The VAPID `sub` claim: a `mailto:` address or an `https:` URL on a real (dotted) domain.
 * Returns it normalised (lower-case scheme and host), or null if it isn't usable. There is no
 * fallback: push services (Apple in particular) reject tokens without a valid contact.
 */
export function normaliseSubject(subject: string | undefined): string | null {
  const s = subject?.trim() ?? '';
  const m = /^([A-Za-z][A-Za-z0-9+.-]*):(.*)$/s.exec(s);
  if (!m || /\s/.test(s)) return null;
  const scheme = m[1].toLowerCase();
  if (scheme === 'mailto') {
    const addr = /^([^@?#/,]+)@([^@?#/,]+)$/.exec(m[2]);
    if (!addr) return null;
    const host = addr[2].toLowerCase();
    return DOTTED_HOST_RE.test(host) ? `mailto:${addr[1]}@${host}` : null;
  }
  if (scheme === 'https') {
    let url: URL;
    try {
      url = new URL(`https:${m[2]}`);
    } catch {
      return null;
    }
    if (url.username || url.password || !DOTTED_HOST_RE.test(url.hostname)) return null;
    return url.href;
  }
  return null;
}

/** A VAPID public key as unpadded base64url, if it is a 65-byte uncompressed point (0x04 prefix). */
export function normalisePublicKey(publicKey: string | undefined): string | null {
  try {
    const pub = b64urlDecode(publicKey?.trim() ?? '');
    return pub.length === 65 && pub[0] === 4 ? b64urlEncode(pub) : null;
  } catch {
    return null;
  }
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

export type VapidLoad = { ok: true; signer: VapidSigner } | { ok: false; problem: string };

/**
 * Validates the VAPID settings once: subject, public key (a P-256 point), private key, and that
 * they are one key pair (one sign + verify, well under 1 ms). `problem` names the setting at
 * fault, never its value.
 */
export async function loadVapid(raw: { publicKey?: string; privateKey?: string; subject?: string }): Promise<VapidLoad> {
  const privateKey = raw.privateKey?.trim() ?? '';
  if (!raw.publicKey?.trim() || !privateKey) return { ok: false, problem: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY must be set' };
  const subject = normaliseSubject(raw.subject);
  if (!subject) return { ok: false, problem: 'VAPID_SUBJECT must be a mailto: address or an https: URL on a real domain' };
  const publicKey = normalisePublicKey(raw.publicKey);
  if (!publicKey) return { ok: false, problem: 'VAPID_PUBLIC_KEY is not a base64url P-256 public key' };
  let pub: CryptoKey;
  try {
    pub = await crypto.subtle.importKey('raw', b64urlDecode(publicKey), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  } catch {
    return { ok: false, problem: 'VAPID_PUBLIC_KEY is not a point on the P-256 curve' };
  }
  let d: Uint8Array;
  try {
    d = b64urlDecode(privateKey);
  } catch {
    d = new Uint8Array(0);
  }
  if (d.length !== 32) return { ok: false, problem: 'VAPID_PRIVATE_KEY is not a base64url 32-byte P-256 private key' };
  let key: CryptoKey;
  try {
    key = await importVapidPrivateKey(publicKey, privateKey);
  } catch {
    // Some WebCrypto implementations (Node's) check the pair here, others only when signing.
    return { ok: false, problem: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not one key pair' };
  }
  try {
    const probe = utf8('dosely-vapid-key-check');
    const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, probe);
    if (!(await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, sig, probe))) throw new Error('mismatch');
  } catch {
    return { ok: false, problem: 'VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are not one key pair' };
  }
  return { ok: true, signer: new VapidSigner({ publicKey, privateKey, subject }, key) };
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
  private key: Promise<CryptoKey> | null;
  private cache = new Map<string, { token: string; exp: number }>();

  /** `config.publicKey` goes into `k=` verbatim, so pass it normalised (loadVapid does). */
  constructor(
    readonly config: VapidConfig,
    key?: CryptoKey,
  ) {
    this.key = key ? Promise.resolve(key) : null;
  }

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

/**
 * - ok:    delivered.
 * - gone:  the subscription is gone for good (404/410, or keys that can never work): drop the device.
 * - drop:  this message can never be sent (too large): drop the message, keep the device.
 * - error: anything else (401/403, 429, 5xx, 3xx, network, timeout): keep both and retry later.
 *          401/403 usually mean a VAPID problem (e.g. a contact Apple rejects), not a dead
 *          subscription, so they must not delete devices.
 */
export type SendResult = 'ok' | 'gone' | 'drop' | 'error';

/** Per-push timeout: one slow push service must not hold up a whole alarm run for long. */
export const PUSH_TIMEOUT_MS = 6_000;

/** The start of a push service's error body, made safe to log (it never contains our payload). */
async function errorSnippet(res: Response, max = 200): Promise<string> {
  if (!res.body) return '';
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let text = '';
  try {
    while (text.length < max) {
      const { done, value } = await reader.read();
      if (done) break;
      text += dec.decode(value, { stream: true });
    }
  } catch {
    /* ignore */
  } finally {
    await reader.cancel().catch(() => {});
  }
  return text.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, max);
}

/** Sends one message. See SendResult for how outcomes map. */
export async function sendPush(
  signer: VapidSigner,
  target: PushTarget,
  payload: string,
  opts: PushOptions = {},
): Promise<{ result: SendResult; status: number; detail?: string }> {
  let req: Request;
  try {
    req = await buildPushRequest(signer, target, payload, opts);
  } catch (err) {
    const detail = (err as Error).message;
    if (err instanceof SubscriptionKeyError) return { result: 'gone', status: 0, detail };
    if (err instanceof PayloadTooLargeError) return { result: 'drop', status: 0, detail };
    return { result: 'error', status: 0, detail };
  }
  try {
    // Never follow redirects: only the endpoint itself was checked against the allowed push services.
    const res = await fetch(req, { redirect: 'manual', signal: AbortSignal.timeout(opts.timeoutMs ?? PUSH_TIMEOUT_MS) });
    const s = res.status;
    if (s >= 200 && s < 300) {
      // Drain the body so the connection is released.
      await res.body?.cancel().catch(() => {});
      return { result: 'ok', status: s };
    }
    const detail = await errorSnippet(res);
    return { result: s === 404 || s === 410 ? 'gone' : 'error', status: s, detail };
  } catch (err) {
    return { result: 'error', status: 0, detail: `network: ${(err as Error).message}` };
  }
}
