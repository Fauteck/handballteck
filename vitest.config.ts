import { defineConfig } from 'vitest/config';

/**
 * `--no-file-parallelism` steht im npm-Skript: Mehrere Testdateien legen je
 * eine eigene SQLite-Datei an, teilen sich aber den Prozess-Zustand der
 * Module (Token-Cache, Bot-Zustand) — nacheinander ist sicher, nebeneinander
 * nicht.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      all: true,
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
