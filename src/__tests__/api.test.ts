import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { unlinkSync } from 'fs';

/**
 * Die API für das Todoteck-Cockpit (`/api/*`): Token statt Anmeldung, ein
 * Bild als PNG, die Auskunft statt Bild, wo es nichts zu zeichnen gibt, die
 * Details mit Zeilen, Spielern und der Bilder-Liste, die Gesundheit — und
 * die Inline-Bilder des Bots, die ohne Token, aber mit Signatur kommen.
 */

const DB_FILE = `/tmp/handball-routes-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;
process.env.PUBLIC_URL = 'https://todo.test.local';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.TELEGRAM_INVITE_CODE;
delete process.env.TELEGRAM_ADMIN_CHAT_IDS;
delete process.env.TEAM_IDS;
delete process.env.PRIMARY_COLOR; delete process.env.SECONDARY_COLOR; delete process.env.ACCENT_COLOR;
delete process.env.SITE_URL; delete process.env.SITE_PLAYERS; delete process.env.SITE_ENABLED;
delete process.env.SITE_OPERATOR; delete process.env.SITE_FEEDBACK_MAIL;
process.env.TEAM_IDS = '96254';
process.env.API_TOKEN = 'geheim-geheim-geheim';

const TEAM = '96254';

describe('API für das Cockpit: Bilder und Details', () => {
  let fastify: FastifyInstance;
  const token = 'geheim-geheim-geheim';

  beforeAll(async () => {
    const { db } = await import('../db/index');
    const schema = await import('../db/schema');
    const { runMigrations } = await import('../db/migrate');
    const { buildServer } = await import('../server');
    runMigrations();

    const now = new Date().toISOString();
    const spiel = (id: string, startsAt: string, status: string, home: number | null, away: number | null) => ({
      id: `${TEAM}:${id}`, team_id: TEAM, match_id: id, season_id: 2627, starts_at: startsAt, status, status_name: status, round: 3, phase_id: 12800,
      competition_name: 'Kreisoberliga mB', championship_name: 'B-Jugend',
      home_id: TEAM, home_name: 'HSG Wölfe Voreifel', away_id: '96300', away_name: 'HV Erftstadt',
      score_home: home, score_away: away, venue_name: 'Sporthalle Heimerzheim', venue_address: null,
      notified_upcoming: false, notified_result: false, updated_at: now,
    });
    db.insert(schema.handball_team_match).values([
      spiel('m1', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString(), 'finished', 30, 22),
      spiel('m2', new Date(Date.now() + 7 * 24 * 3600 * 1000).toISOString(), 'scheduled', null, null),
    ] as never).run();
    db.insert(schema.handball_standings).values({
      phase_id: 12800, season_id: 2627, competition_name: 'Kreisoberliga mB', fetched_at: now,
      payload: JSON.stringify([
        { round: 1, position: 1, teamId: TEAM, teamName: 'HSG Wölfe Voreifel', played: 1, won: 1, drawn: 0, lost: 0, goalsFor: 30, goalsAgainst: 22, goalsDiff: 8, points: 2 },
        { round: 1, position: 2, teamId: '96300', teamName: 'HV Erftstadt', played: 1, won: 0, drawn: 0, lost: 1, goalsFor: 22, goalsAgainst: 30, goalsDiff: -8, points: 0 },
      ]),
    }).run();

    fastify = await buildServer({ logger: false });
    await fastify.ready();
  });

  afterAll(async () => {
    await fastify.close();
    try { unlinkSync(DB_FILE); } catch { /* egal */ }
  });

  const get = (url: string) => fastify.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  it('verlangt das Token — und ohne API_TOKEN antwortet alles 401', async () => {
    expect((await fastify.inject({ method: 'GET', url: `/api/teams/${TEAM}/bild/tabelle` })).statusCode).toBe(401);
    expect((await fastify.inject({ method: 'GET', url: `/api/teams/${TEAM}/details`, headers: { authorization: 'Bearer falsch' } })).statusCode).toBe(401);
    delete process.env.API_TOKEN;
    try {
      const res = await get(`/api/overview`);
      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('API_TOKEN');
    } finally {
      process.env.API_TOKEN = token;
    }
    expect((await fastify.inject({ method: 'GET', url: '/healthz' })).statusCode).toBe(200);
  });

  it('liefert Übersicht und Gesundheit', async () => {
    const overview = await get('/api/overview');
    expect(overview.statusCode).toBe(200);
    expect(overview.json()).toMatchObject({ configured: true, bot: { enabled: false, subscribers: 0 } });
    expect(overview.json().teams[0]).toMatchObject({ team_id: TEAM, name: 'HSG Wölfe Voreifel', label: 'B-Jugend' });
    expect(overview.json().site[0]).toMatchObject({ team_id: TEAM, enabled: true, url: `https://todo.test.local/${TEAM}/`, players: false, subscribers: 0 });
    const health = await get('/api/health');
    expect(health.statusCode).toBe(200);
    expect(health.json()).toMatchObject({ ok: true, teams: 1, sync: { last_error: null, consecutive_failures: 0 }, bot: { enabled: false }, site: { enabled: true } });
  });

  it('liefert Tabelle, Endstand und nächstes Spiel als PNG', async () => {
    for (const art of ['tabelle', 'endstand', 'spiel', 'saison']) {
      const res = await get(`/api/teams/${TEAM}/bild/${art}`);
      expect(res.statusCode, art).toBe(200);
      expect(res.headers['content-type']).toBe('image/png');
      expect(res.rawPayload.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }
  }, 30_000);

  it('antwortet mit einer Auskunft, wo es noch nichts zu zeichnen gibt', async () => {
    const kader = await get(`/api/teams/${TEAM}/bild/kader`);
    expect(kader.statusCode).toBe(404);
    expect(kader.json()).toMatchObject({ error: 'no_image' });
    expect(kader.json().message).toContain('Kader');
    expect((await get(`/api/teams/${TEAM}/bild/verlauf`)).json().message).toContain('zwei gespielte Spieltage');
    expect((await get(`/api/teams/${TEAM}/bild/torjaeger`)).statusCode).toBe(404);
    expect((await get(`/api/teams/${TEAM}/bild/unsinn`)).statusCode).toBe(404);
    expect((await get(`/api/teams/99999/bild/tabelle`)).json()).toMatchObject({ error: 'not_found' });
    expect((await get(`/api/teams/${TEAM}/bild/spieler/p-nix`)).statusCode).toBe(404);
  });

  it('liefert Saison, Rekorde, Spieler und die Bilder-Liste als Klartext-JSON', async () => {
    const res = await get(`/api/teams/${TEAM}/details`);
    expect(res.statusCode).toBe(200);
    const d = res.json();
    expect(d.saison[0]).toBe('HSG Wölfe Voreifel — Saison B-Jugend');
    expect(d.saison.join('\n')).toContain('1 Spiel: 1 Siege, 0 Unentschieden, 0 Niederlagen');
    expect(d.saison.join('\n')).not.toContain('<b>');
    expect(d.rekorde[0]).toContain('Rekorde der Saison');
    expect(d.rekorde.join('\n')).toContain('Höchster Sieg: 30:22 gegen HV Erftstadt');
    expect(d.spieler).toEqual([]);
    expect(d.bilder).toEqual({ tabelle: true, kader: false, spiel: true, endstand: true, verlauf: false, torjaeger: false, saison: true });
  });

  it('liefert Inline-Bilder nur mit gültiger Signatur und Bot-Token — ohne Anmeldung, als JPEG', async () => {
    const { inlineBildUrl } = await import('../lib/handballBot');
    const pfad = (u: string) => u.replace('https://todo.test.local', '');
    const url = pfad(inlineBildUrl('tabelle', TEAM));
    // Ohne Bot-Token: 403, auch mit gültiger Signatur.
    expect((await fastify.inject({ method: 'GET', url })).statusCode).toBe(403);
    process.env.TELEGRAM_BOT_TOKEN = '123:env-token';
    try {
      const res = await fastify.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toBe('image/jpeg');
      expect(res.rawPayload.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
      const vorschau = await fastify.inject({ method: 'GET', url: pfad(inlineBildUrl('tabelle', TEAM, new Date(), true)) });
      expect(vorschau.statusCode).toBe(200);
      expect(vorschau.rawPayload.length).toBeLessThan(res.rawPayload.length);
      // Signatur für eine andere Art oder Mannschaft, oder abgelaufen: 403.
      expect((await fastify.inject({ method: 'GET', url: url.replace('tabelle.jpg', 'kader.jpg') })).statusCode).toBe(403);
      expect((await fastify.inject({ method: 'GET', url: url.replace(`team=${TEAM}`, 'team=96300') })).statusCode).toBe(403);
      expect((await fastify.inject({ method: 'GET', url: pfad(inlineBildUrl('tabelle', TEAM, new Date(Date.now() - 26 * 3600 * 1000))) })).statusCode).toBe(403);
      expect((await fastify.inject({ method: 'GET', url: url.replace(/t=[^&]+/, 't=falsch') })).statusCode).toBe(403);
      // Gültig, aber nichts zu zeichnen: 404.
      expect((await fastify.inject({ method: 'GET', url: pfad(inlineBildUrl('kader', TEAM)) })).statusCode).toBe(404);
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
    }
  }, 30_000);
});
