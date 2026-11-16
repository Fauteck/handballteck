/**
 * Die öffentliche Microsite im echten Browser (Chromium über playwright-core).
 *
 * Geprüft wird, was sich nur gerendert messen lässt: kein seitliches Scrollen bei
 * 320 und 390 px, jedes Tap-Ziel außerhalb von Fließtext mindestens 44 px hoch,
 * keine Skriptfehler. Mit `SHOTS=vorher` oder `SHOTS=nachher` legt der Lauf
 * zusätzlich ganzseitige Bilder nach `shots/<SHOTS>/` (gitignored), je Seite
 * in 390×844 und 1440×900, hell und dunkel.
 *
 * Läuft mit `npm run test:e2e`; der Browser kommt aus
 * `npx playwright-core install chromium`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { chromium, type Browser, type Page } from 'playwright-core';

const DB_FILE = join(tmpdir(), `handball-site-e2e-${process.pid}.db`);
process.env.DATABASE_PATH = DB_FILE;
process.env.PUBLIC_URL = 'http://127.0.0.1';
process.env.TEAM_IDS = '96254=B-Jugend';
process.env.SITE_ENABLED = 'true';
process.env.CLUB_NAME = 'HSG Wölfe Voreifel';
delete process.env.TELEGRAM_BOT_TOKEN;
delete process.env.SITE_URL;

const TEAM = '96254';
const SHOTS = process.env.SHOTS;
const SEITEN = [
  ['start', '/'],
  ['team', `/${TEAM}/`],
  ['spiel', `/${TEAM}/spiel/m1`],
] as const;

/** Tap-Ziele unter 44 px, ohne Links im Fließtext (display:inline). */
async function zuKleineZiele(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const raus: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('a[href], button, [role=button], summary'))) {
      const st = getComputedStyle(el);
      if (st.display === 'inline' || st.visibility === 'hidden') continue;
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (el.closest('.skip')) continue;
      if (r.height < 43.5) {
        const name = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 30);
        raus.push(`${el.tagName.toLowerCase()}.${el.className || '-'} „${name}“ ${Math.round(r.width)}×${Math.round(r.height)}`);
      }
    }
    return [...new Set(raus)];
  });
}

describe('Microsite im Browser', () => {
  let fastify: FastifyInstance;
  let browser: Browser;
  let basis: string;

  beforeAll(async () => {
    const { db } = await import('../db/index');
    const schema = await import('../db/schema');
    const { runMigrations } = await import('../db/migrate');
    const { siteRoutes } = await import('../routes/site');
    runMigrations();
    const now = new Date().toISOString();
    const tag = 24 * 3600 * 1000;
    const spiel = (id: string, startsAt: string, status: string, home: number | null, away: number | null, heim = true) => ({
      id: `${TEAM}:${id}`, team_id: TEAM, match_id: id, season_id: 2627, starts_at: startsAt, status, status_name: status, round: 3, phase_id: 12800,
      competition_name: 'Kreisoberliga mB', championship_name: 'B-Jugend',
      home_id: heim ? TEAM : '96300', home_name: heim ? 'HSG Wölfe Voreifel' : 'HV Erftstadt', away_id: heim ? '96300' : TEAM, away_name: heim ? 'HV Erftstadt' : 'HSG Wölfe Voreifel',
      score_home: home, score_away: away, venue_name: 'Sporthalle Heimerzheim', venue_address: 'Schulstraße 1, 53913 Swisttal',
      notified_upcoming: true, notified_result: true, updated_at: now,
    });
    db.insert(schema.handball_team_match).values([
      spiel('m1', new Date(Date.now() - 7 * tag).toISOString(), 'finished', 30, 22),
      spiel('m2', new Date(Date.now() - 3 * tag).toISOString(), 'finished', 25, 20, false),
      spiel('m3', new Date(Date.now() + 4 * tag).toISOString(), 'scheduled', null, null),
      spiel('m4', new Date(Date.now() + 11 * tag).toISOString(), 'scheduled', null, null, false),
    ] as never).run();
    db.insert(schema.handball_standings).values({
      phase_id: 12800, season_id: 2627, competition_name: 'Kreisoberliga mB', fetched_at: now,
      payload: JSON.stringify([
        { round: 2, position: 1, teamId: TEAM, teamName: 'HSG Wölfe Voreifel', played: 2, won: 1, drawn: 0, lost: 1, goalsFor: 55, goalsAgainst: 47, goalsDiff: 8, points: 2 },
        { round: 2, position: 2, teamId: '96300', teamName: 'HV Erftstadt', played: 2, won: 1, drawn: 0, lost: 1, goalsFor: 47, goalsAgainst: 55, goalsDiff: -8, points: 2 },
      ]),
    }).run();
    fastify = Fastify();
    await fastify.register(siteRoutes);
    basis = await fastify.listen({ port: 0, host: '127.0.0.1' });
    browser = await chromium.launch();
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await fastify?.close();
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { unlinkSync(f); } catch { /* nicht da */ } }
  });

  it('legt die Bilder ab, wenn SHOTS gesetzt ist', async () => {
    if (!SHOTS) return;
    const ziel = join(process.cwd(), 'shots', SHOTS);
    mkdirSync(ziel, { recursive: true });
    for (const [breite, hoehe] of [[390, 844], [1440, 900]]) {
      for (const schema of ['light', 'dark'] as const) {
        const ctx = await browser.newContext({ viewport: { width: breite, height: hoehe }, colorScheme: schema, reducedMotion: 'reduce', locale: 'de-DE', timezoneId: 'Europe/Berlin' });
        const page = await ctx.newPage();
        for (const [name, pfad] of SEITEN) {
          await page.goto(basis + pfad, { waitUntil: 'networkidle' });
          await page.screenshot({ path: join(ziel, `${name}-${breite}-${schema}.png`), fullPage: true });
        }
        await ctx.close();
      }
    }
  }, 120_000);

  for (const breite of [320, 390]) {
    it(`passt bei ${breite} px ohne seitliches Scrollen, mit 44-px-Zielen und ohne Skriptfehler`, async () => {
      const ctx = await browser.newContext({ viewport: { width: breite, height: 800 }, reducedMotion: 'reduce', locale: 'de-DE' });
      const page = await ctx.newPage();
      const fehler: string[] = [];
      page.on('pageerror', e => fehler.push(e.message));
      const befunde: string[] = [];
      for (const [name, pfad] of SEITEN) {
        const res = await page.goto(basis + pfad, { waitUntil: 'networkidle' });
        expect(res?.status(), pfad).toBe(200);
        const breiter = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (breiter > 0) befunde.push(`${name}: ${breiter} px zu breit`);
        for (const z of await zuKleineZiele(page)) befunde.push(`${name}: ${z}`);
      }
      await ctx.close();
      expect(fehler).toEqual([]);
      expect(befunde).toEqual([]);
    });
  }
});
