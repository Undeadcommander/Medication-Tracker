// Crypto tests in plain Node, checked against independent implementations (http_ece, jose).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/**/*.node.test.ts'], environment: 'node' },
});
