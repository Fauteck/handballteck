import { defineConfig } from 'vitest/config';

/** Der Browser-Test der Einstellungsseite (`npm run test:e2e`) — getrennt, weil er Chromium braucht. */
export default defineConfig({
  test: {
    include: ['src/__tests__/**/*.e2e.ts'],
    testTimeout: 30_000,
  },
});
