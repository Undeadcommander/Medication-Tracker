#!/usr/bin/env node
// Generates a VAPID key pair for the Worker, in the same format as `web-push generate-vapid-keys`
// (base64url: 65-byte uncompressed public point, 32-byte private scalar). Prints them; writes nothing.
//
//   node scripts/gen-vapid.mjs
//   npx wrangler secret put VAPID_PUBLIC_KEY    (paste the public key)
//   npx wrangler secret put VAPID_PRIVATE_KEY   (paste the private key)
//
// Changing the keys later makes every device turn notifications on again.
import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;
const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const jwk = await subtle.exportKey('jwk', pair.privateKey);
const raw = new Uint8Array(await subtle.exportKey('raw', pair.publicKey));
/** @param {Uint8Array} u8 */
const b64url = (u8) => Buffer.from(u8).toString('base64url');

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ publicKey: b64url(raw), privateKey: jwk.d }));
} else {
  console.log(`VAPID_PUBLIC_KEY=${b64url(raw)}`);
  console.log(`VAPID_PRIVATE_KEY=${jwk.d}`);
  console.error('\nKeep the private key secret. Set both with `npx wrangler secret put <NAME>`.');
}
