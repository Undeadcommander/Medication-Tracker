/// <reference types="vitest/config" />
import { configDefaults } from 'vitest/config';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // Firebase/Firestore is a lazily loaded chunk (~580 kB, signed-in users only), and so is the passphrase
  // strength checker (zxcvbn and its dictionaries, ~1.7 MB, fetched only when a passphrase is chosen).
  build: { chunkSizeWarningLimit: 1800 },
  server: {
    port: 5173,
    proxy: { '/api': 'http://localhost:8787' },
  },
  // worker/ (the Cloudflare reminder server) has its own package, runtime and tests.
  test: { exclude: [...configDefaults.exclude, 'worker/**'] },
});
