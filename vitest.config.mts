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
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts', 'src/index.ts'],
      reporter: ['text-summary', 'json-summary'],
      // Untergrenzen knapp unter dem Stand vom 2026-11-12 (vitest 5, Node 26:
      // Zeilen 90 %, Anweisungen 86 %, Funktionen 89 %, Zweige 74 %). Sie
      // fangen einen Einbruch ab, kein Ziel: Wer Code ohne Tests ergänzt,
      // merkt es im `quality`-Job.
      thresholds: { lines: 88, statements: 85, functions: 87, branches: 73 },
    },
  },
});
