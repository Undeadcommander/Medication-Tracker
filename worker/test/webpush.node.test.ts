import { createECDH, createPublicKey, randomBytes, verify } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error http_ece ships no types
import ece from 'http_ece';
import { decodeProtectedHeader, importJWK, jwtVerify } from 'jose';
import { describe, expect, it } from 'vitest';
import {
  MAX_PLAINTEXT,
  RECORD_SIZE,
  VapidSigner,
  b64urlDecode,
  b64urlEncode,
  buildPushRequest,
  encryptPayload,
  importVapidPrivateKey,
  normaliseSubject,
  signVapidJwt,
} from '../src/webpush';

function subscriber() {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    ecdh,
    auth,
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') },
  };
}

const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));

function decrypt(body: Uint8Array, s: ReturnType<typeof subscriber>): string {
  const out: Buffer = ece.decrypt(Buffer.from(body), { version: 'aes128gcm', privateKey: s.ecdh, authSecret: s.auth });
  return out.toString('utf8');
}

function vapidKeys(): { publicKey: string; privateKey: string } {
  const script = path.join(path.dirname(fileURLToPath(import.meta.url)), '../scripts/gen-vapid.mjs');
  return JSON.parse(execFileSync(process.execPath, [script, '--json'], { encoding: 'utf8' }));
}

function publicJwk(publicKey: string) {
  const pub = b64urlDecode(publicKey);
  return { kty: 'EC', crv: 'P-256', x: b64urlEncode(pub.slice(1, 33)), y: b64urlEncode(pub.slice(33)) };
}

describe('base64url', () => {
  it('round-trips and accepts padded / standard alphabets', () => {
    const raw = new Uint8Array(randomBytes(37));
    const s = b64urlEncode(raw);
    expect(s).not.toMatch(/[+/=]/);
    expect(b64urlDecode(s)).toEqual(raw);
    expect(b64urlDecode(Buffer.from(raw).toString('base64'))).toEqual(raw);
    expect(() => b64urlDecode('not*valid')).toThrow();
  });
});

describe('RFC 8291 aes128gcm encryption', () => {
  it('is decrypted by http_ece (the library web-push uses)', async () => {
    const s = subscriber();
    const msg = JSON.stringify({ title: 'Take Aspirin', body: '100 mg · ✓ ünïcödé 💊', tag: 'm@1' });
    const body = await encryptPayload(s.keys, bytes(msg));
    expect(decrypt(body, s)).toBe(msg);
  });

  it('writes the RFC 8188 header: salt, rs=4096, 65-byte sender key id', async () => {
    const s = subscriber();
    const body = await encryptPayload(s.keys, bytes('hi'));
    const view = new DataView(body.buffer, body.byteOffset);
    expect(view.getUint32(16)).toBe(RECORD_SIZE);
    expect(body[20]).toBe(65);
    expect(body[21]).toBe(4); // uncompressed point
    expect(body.length).toBe(86 + 2 + 1 + 16);
  });

  it('uses a fresh sender key and salt for every message', async () => {
    const s = subscriber();
    const a = await encryptPayload(s.keys, bytes('x'));
    const b = await encryptPayload(s.keys, bytes('x'));
    expect(Buffer.from(a.slice(0, 16)).equals(Buffer.from(b.slice(0, 16)))).toBe(false);
    expect(Buffer.from(a.slice(21, 86)).equals(Buffer.from(b.slice(21, 86)))).toBe(false);
  });

  it('fits the largest allowed payload in one 4096-byte record and rejects bigger ones', async () => {
    const s = subscriber();
    const max = 'a'.repeat(MAX_PLAINTEXT);
    const body = await encryptPayload(s.keys, bytes(max));
    expect(body.length).toBe(4096);
    expect(decrypt(body, s)).toBe(max);
    await expect(encryptPayload(s.keys, bytes(max + 'a'))).rejects.toThrow(/too large/);
  });

  it('rejects malformed subscriber keys', async () => {
    const s = subscriber();
    const pt = new Uint8Array([1]);
    await expect(encryptPayload({ ...s.keys, p256dh: b64urlEncode(new Uint8Array(10)) }, pt)).rejects.toThrow();
    await expect(encryptPayload({ ...s.keys, auth: b64urlEncode(new Uint8Array(4)) }, pt)).rejects.toThrow();
  });
});

describe('RFC 8292 VAPID', () => {
  it('signs an ES256 JWT that jose and Node verify with the public key', async () => {
    const vapid = vapidKeys();
    const key = await importVapidPrivateKey(vapid.publicKey, vapid.privateKey);
    const exp = Math.floor(Date.now() / 1000) + 3600;
    const jwt = await signVapidJwt(key, 'https://web.push.apple.com', 'mailto:me@example.org', exp);
    const jwk = publicJwk(vapid.publicKey);
    const { payload } = await jwtVerify(jwt, await importJWK(jwk, 'ES256'), { audience: 'https://web.push.apple.com' });
    expect(payload).toEqual({ aud: 'https://web.push.apple.com', exp, sub: 'mailto:me@example.org' });
    expect(decodeProtectedHeader(jwt)).toEqual({ typ: 'JWT', alg: 'ES256' });

    // Node's own verifier, with the raw r||s signature encoding JWS requires.
    const [h, p, sig] = jwt.split('.');
    const nodeKey = createPublicKey({ key: jwk, format: 'jwk' });
    const ok = verify('sha256', Buffer.from(`${h}.${p}`), { key: nodeKey, dsaEncoding: 'ieee-p1363' }, Buffer.from(sig, 'base64url'));
    expect(ok).toBe(true);
  });

  it('builds the push request (aud = push service origin, exp <= 24 h, k = public key, TTL, Urgency)', async () => {
    const vapid = vapidKeys();
    const signer = new VapidSigner({ ...vapid, subject: 'mailto:me@example.org' });
    const s = subscriber();
    const endpoint = 'https://fcm.googleapis.com/fcm/send/abc123:def';
    const req = await buildPushRequest(signer, { endpoint, keys: s.keys }, '{"title":"x"}', { ttl: 3600, urgency: 'high' });
    expect(req.method).toBe('POST');
    expect(req.url).toBe(endpoint);
    expect(req.headers.get('Content-Encoding')).toBe('aes128gcm');
    expect(req.headers.get('Content-Type')).toBe('application/octet-stream');
    expect(req.headers.get('TTL')).toBe('3600');
    expect(req.headers.get('Urgency')).toBe('high');
    const m = /^vapid t=([^,]+), k=(.+)$/.exec(req.headers.get('Authorization') ?? '');
    expect(m).not.toBeNull();
    expect(m![2]).toBe(vapid.publicKey);
    const { payload } = await jwtVerify(m![1], await importJWK(publicJwk(vapid.publicKey), 'ES256'));
    expect(payload.aud).toBe('https://fcm.googleapis.com');
    expect(payload.sub).toBe('mailto:me@example.org');
    const now = Date.now() / 1000;
    expect(payload.exp!).toBeGreaterThan(now + 11 * 3600);
    expect(payload.exp!).toBeLessThanOrEqual(now + 24 * 3600);
    expect(decrypt(new Uint8Array(await req.arrayBuffer()), s)).toBe('{"title":"x"}');
  });

  it('caches one token per push-service origin and re-signs before expiry', async () => {
    const signer = new VapidSigner({ ...vapidKeys(), subject: 'mailto:me@example.org' });
    const a = await signer.authorization('https://web.push.apple.com/QWxs');
    const b = await signer.authorization('https://web.push.apple.com/other');
    const c = await signer.authorization('https://fcm.googleapis.com/fcm/send/x');
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    const later = await signer.authorization('https://web.push.apple.com/QWxs', Date.now() + 11.5 * 3600_000);
    expect(later).not.toBe(a);
  });

  it('rejects malformed keys and falls back to a valid subject', async () => {
    await expect(importVapidPrivateKey('abc', 'def')).rejects.toThrow();
    expect(normaliseSubject('mailto:a@b.co')).toBe('mailto:a@b.co');
    expect(normaliseSubject('https://example.org/contact')).toBe('https://example.org/contact');
    expect(normaliseSubject('nonsense')).toBe('mailto:admin@example.com');
    expect(normaliseSubject(undefined)).toBe('mailto:admin@example.com');
  });
});
