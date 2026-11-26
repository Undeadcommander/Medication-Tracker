// Scheduler/storage tests inside the Workers runtime (Miniflare), with a throwaway VAPID key pair.
import { generateKeyPairSync } from 'node:crypto';
import { cloudflareTest } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

const jwk = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' });
const publicKey = Buffer.concat([
  Buffer.from([4]),
  Buffer.from(jwk.x!, 'base64url'),
  Buffer.from(jwk.y!, 'base64url'),
]).toString('base64url');

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          VAPID_PUBLIC_KEY: publicKey,
          VAPID_PRIVATE_KEY: jwk.d!,
          VAPID_SUBJECT: 'mailto:test@example.org',
          ALLOWED_ORIGINS: 'https://undeadcommander.github.io, http://localhost:5173/',
          EXTRA_PUSH_ORIGINS: '',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.worker.test.ts'] },
});
