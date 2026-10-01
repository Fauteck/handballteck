import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance, RouteOptions } from 'fastify';
import { unlinkSync } from 'fs';

/**
 * Die Sicherheitsvorgaben der CLAUDE.md als Test: Sicherheits-Header an jeder
 * Antwort, und keine öffentliche Route ohne eigenes Rate-Limit — oder ohne
 * ausdrücklich eingetragenen Grund, warum das globale genügt.
 */

const DB_FILE = `/tmp/handball-security-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;
process.env.PUBLIC_URL = 'https://todo.test.local';
delete process.env.TELEGRAM_BOT_TOKEN;
process.env.TEAM_IDS = '96254';

/** Routen ohne eigenes `rateLimit`: es gilt das globale (300/min), und das ist hier der Grund. */
const GLOBAL_GENUEGT: Record<string, string> = {
  'GET /robots.txt': 'eine Zeile Text, nichts zu rechnen',
};
/** Routen mit `rateLimit: false` — nur der Healthcheck des Containers (alle 30 s, ohne Eingabe). */
const OHNE_LIMIT = new Set(['GET /healthz']);

describe('Sicherheit', () => {
  let fastify: FastifyInstance;
  const routen: RouteOptions[] = [];

  beforeAll(async () => {
    const { runMigrations } = await import('../db/migrate');
    const { buildServer } = await import('../server');
    runMigrations();
    fastify = await buildServer({ logger: false, onRoute: r => routen.push(r) });
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { unlinkSync(f); } catch { /* nicht da */ } }
  });

  it('setzt an jeder Antwort die Sicherheits-Header', async () => {
    for (const url of ['/healthz', '/robots.txt', '/96254/', '/gibt-es-nicht']) {
      const res = await fastify.inject({ method: 'GET', url });
      const csp = String(res.headers['content-security-policy']);
      expect(csp, url).toContain("script-src 'self'");
      expect(csp, url).toContain("frame-ancestors 'none'");
      expect(res.headers['x-content-type-options'], url).toBe('nosniff');
      expect(res.headers['referrer-policy'], url).toBe('no-referrer');
      expect(res.headers['strict-transport-security'], url).toContain('max-age=');
      expect(res.headers['cross-origin-opener-policy'], url).toBe('same-origin');
      expect(res.headers['permissions-policy'], url).toContain('geolocation=()');
      expect(res.headers['x-powered-by'], url).toBeUndefined();
    }
  });

  it('erlaubt keine Skripte außer den eigenen', async () => {
    const csp = String((await fastify.inject({ method: 'GET', url: '/healthz' })).headers['content-security-policy']);
    const script = /script-src ([^;]*)/.exec(csp)?.[1] ?? '';
    expect(script).toBe("'self'");
  });

  it('gibt jeder Route ein Rate-Limit — oder einen eingetragenen Grund', () => {
    const ohne: string[] = [];
    for (const r of routen) {
      const methoden = Array.isArray(r.method) ? r.method : [r.method];
      for (const method of methoden) {
        if (method === 'HEAD' || method === 'OPTIONS') continue;
        const schluessel = `${method} ${r.url}`;
        const limit = (r.config as { rateLimit?: unknown } | undefined)?.rateLimit;
        if (limit === false) {
          if (!OHNE_LIMIT.has(schluessel)) ohne.push(`${schluessel} (rateLimit: false ohne Eintrag)`);
        } else if (limit === undefined) {
          // /api/* hängt am Token (401 ohne), das globale Limit gilt zusätzlich.
          if (!r.url.startsWith('/api/') && !(schluessel in GLOBAL_GENUEGT)) ohne.push(schluessel);
        } else {
          const max = (limit as { max?: number }).max;
          if (typeof max !== 'number' || max > 600) ohne.push(`${schluessel} (max ${String(max)})`);
        }
      }
    }
    expect(ohne, `Routen ohne Rate-Limit-Entscheidung: ${ohne.join(', ')}`).toEqual([]);
    // Und die Liste ist nicht leer — sonst prüfte der Test nichts.
    expect(routen.length).toBeGreaterThan(10);
  });

  it('drosselt auch Routen ohne eigenes Limit über das globale', async () => {
    let letzte = 0;
    for (let i = 0; i < 305; i++) letzte = (await fastify.inject({ method: 'GET', url: '/robots.txt', remoteAddress: '203.0.113.7' })).statusCode;
    expect(letzte).toBe(429);
  });
});
