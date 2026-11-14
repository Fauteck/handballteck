/**
 * Die Microsite im Rahmen der Vereinsseite (Chromium über playwright-core), mit genau dem
 * HTML-Block aus der README („Embedding in the club website“): Der Rahmen wächst mit dem
 * Inhalt (UXA-1), ein Klick im Rahmen springt zu dessen Anfang, Fenster öffnen sich im
 * sichtbaren Teil, Farbschema und Kompaktmodus wandern mit jedem Verweis (UXA-2).
 * Vereinsseite und Microsite laufen auf zwei Ports, also auf zwei Herkünften.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { readFileSync, unlinkSync } from 'fs';
import { chromium, type Browser, type Page, type Frame } from 'playwright-core';

const DB_FILE = `/tmp/handball-einbettung-e2e-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;
process.env.PUBLIC_URL = 'http://127.0.0.1';
process.env.TEAM_IDS = '96254=B-Jugend';
process.env.SITE_ENABLED = 'true';
delete process.env.SITE_URL;
delete process.env.TELEGRAM_BOT_TOKEN;

const TEAM = '96254';
const KOPF = 60;

/** Der Block aus der README, mit der Adresse der Test-Microsite statt der echten. */
function readmeBlock(microsite: string): string {
  const readme = readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const abschnitt = readme.split('### Embedding in the club website')[1] ?? '';
  const block = /```html\n([\s\S]*?)```/.exec(abschnitt)?.[1];
  if (!block) throw new Error('README: HTML-Block zum Einbetten fehlt');
  return block
    .split('https://handball.fauteck.eu/?kompakt=1').join(`${microsite}/${TEAM}/?kompakt=1`)
    .split('https://handball.fauteck.eu').join(microsite);
}

describe('Einbettung in die Vereinsseite im Browser', () => {
  let site: FastifyInstance;
  let verein: FastifyInstance;
  let browser: Browser;
  let page: Page;
  let rahmen: Frame;
  const skriptFehler: string[] = [];

  beforeAll(async () => {
    const { runMigrations } = await import('../db/migrate');
    runMigrations();
    const { db } = await import('../db/index');
    const schema = await import('../db/schema');
    const jetzt = new Date().toISOString();
    const spiel = (id: string, tage: number, status: string, heim: number | null, gast: number | null) => ({
      id: `${TEAM}:${id}`, team_id: TEAM, match_id: id, season_id: 2627, starts_at: new Date(Date.now() + tage * 86_400_000).toISOString(),
      status, status_name: status, round: 3, phase_id: 12800, competition_name: 'Kreisoberliga mB', championship_name: 'B-Jugend',
      home_id: TEAM, home_name: 'HSG Wölfe Voreifel', away_id: '96300', away_name: 'HV Erftstadt', score_home: heim, score_away: gast,
      venue_name: 'Sporthalle Heimerzheim', venue_address: 'Schulstraße 1, 53913 Swisttal', notified_upcoming: false, notified_result: false, updated_at: jetzt,
    });
    db.insert(schema.handball_team_match).values([spiel('m1', -7, 'finished', 30, 22), spiel('m3', 7, 'scheduled', null, null)] as never).run();
    db.insert(schema.handball_standings).values({
      phase_id: 12800, season_id: 2627, competition_name: 'Kreisoberliga mB', fetched_at: jetzt,
      payload: JSON.stringify([
        { round: 2, position: 1, teamId: TEAM, teamName: 'HSG Wölfe Voreifel', played: 2, won: 2, drawn: 0, lost: 0, goalsFor: 55, goalsAgainst: 40, goalsDiff: 15, points: 4 },
        { round: 2, position: 2, teamId: '96300', teamName: 'HV Erftstadt', played: 2, won: 0, drawn: 0, lost: 2, goalsFor: 40, goalsAgainst: 55, goalsDiff: -15, points: 0 },
      ]),
    }).run();

    const { siteRoutes } = await import('../routes/site');
    site = Fastify();
    await site.register(siteRoutes);
    const microsite = await site.listen({ port: 0, host: '127.0.0.1' });

    // Die Vereinsseite: Inhalt davor und danach, der Block aus der README dazwischen.
    const block = readmeBlock(microsite);
    verein = Fastify();
    verein.get('/', async (_req, reply) => reply.type('text/html; charset=utf-8').send(
      `<!doctype html><html><body style="margin:0"><div style="height:${KOPF}px;position:fixed;top:0;left:0;right:0;background:#222;z-index:9"></div>` +
      `<div style="height:900px"></div>${block}<div style="height:2000px"></div></body></html>`));
    const vereinsseite = await verein.listen({ port: 0, host: '127.0.0.1' });

    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 400, height: 700 }, colorScheme: 'light' });
    page.on('pageerror', err => skriptFehler.push(err.message));
    await page.goto(vereinsseite);
    // loading="lazy": erst in die Nähe scrollen, dann lädt der Rahmen.
    await page.evaluate(() => document.getElementById('woelfe-live')!.scrollIntoView());
    const el = await page.waitForSelector('#woelfe-live');
    await page.waitForFunction(() => document.getElementById('woelfe-live')!.style.height !== '1400px', null, { timeout: 15_000 });
    rahmen = (await el.contentFrame())!;
  }, 90_000);

  afterAll(async () => {
    await browser?.close();
    await site?.close();
    await verein?.close();
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { unlinkSync(f); } catch { /* nicht da */ } }
  });

  it('wächst mit dem Inhalt, ohne zweiten Scrollbalken', async () => {
    const inhalt = await rahmen.evaluate(() => Math.ceil(document.body.getBoundingClientRect().height));
    const hoehe = await page.evaluate(() => document.getElementById('woelfe-live')!.getBoundingClientRect().height);
    expect(Math.abs(hoehe - inhalt)).toBeLessThanOrEqual(2);
    expect(await rahmen.evaluate(() => document.documentElement.scrollHeight <= window.innerHeight + 2)).toBe(true);
  });

  it('nimmt das Farbschema der Vereinsseite, auch auf einem hellen Gerät', async () => {
    expect(await rahmen.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
    expect(await rahmen.evaluate(() => document.documentElement.classList.contains('kompakt'))).toBe(true);
    const verweis = await rahmen.evaluate(() => document.querySelector('a[href*="spiel/m1"]')!.getAttribute('href'));
    expect(verweis).toContain('kompakt=1');
    expect(verweis).toContain('farbe=dunkel');
  });

  it('öffnet ein Fenster im sichtbaren Teil des Rahmens', async () => {
    await page.evaluate(() => window.scrollTo(0, 900 + 1500));
    await rahmen.waitForFunction(() => parseInt(getComputedStyle(document.documentElement).getPropertyValue('--sicht-oben'), 10) > 1000);
    await rahmen.evaluate(() => (document.querySelector('[data-sb]') as HTMLElement).click());
    await rahmen.waitForSelector('dialog.steckbrief[open]');
    const oben = await rahmen.evaluate(() => document.querySelector('dialog.steckbrief[open]')!.getBoundingClientRect().top);
    const rahmenOben = await page.evaluate(() => document.getElementById('woelfe-live')!.getBoundingClientRect().top);
    // Das Fenster beginnt unter der Kopfleiste und im Bildschirm.
    expect(rahmenOben + oben).toBeGreaterThanOrEqual(KOPF);
    expect(rahmenOben + oben).toBeLessThan(700 - 100);
    await rahmen.evaluate(() => (document.querySelector('dialog.steckbrief[open]') as HTMLDialogElement).close());
  });

  it('springt nach einem Klick im Rahmen zu dessen Anfang', async () => {
    await page.evaluate(() => window.scrollTo(0, 900 + 1500));
    await rahmen.evaluate(() => (document.querySelector('a[href*="spiel/m1"]') as HTMLElement).click());
    await page.waitForFunction(() => Math.abs(document.getElementById('woelfe-live')!.getBoundingClientRect().top - 60) <= 2, null, { timeout: 10_000 });
    expect(rahmen.url()).toContain('kompakt=1');
    expect(skriptFehler).toEqual([]);
  });
});
