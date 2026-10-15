/**
 * Die Einstellungsseite im echten Browser (Chromium über playwright-core):
 * Anmelden, Ändern, Tab-Wechsel, Zurücksetzen, Dialog, Speichern.
 * Läuft mit `npm run test:e2e`; der Browser kommt aus
 * `npx playwright-core install chromium`.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { unlinkSync } from 'fs';
import { chromium, type Browser, type Page } from 'playwright-core';

const DB_FILE = `/tmp/handball-settings-e2e-${process.pid}.db`;
process.env.DATABASE_PATH = DB_FILE;
process.env.PUBLIC_URL = 'http://127.0.0.1';
process.env.TEAM_IDS = '96254=B-Jugend';
process.env.ADMIN_USER = 'chef';
process.env.ADMIN_PASSWORD = 'ein-langes-passwort-123';
process.env.CLUB_NAME = 'Aus der Umgebung';
delete process.env.ADMIN_PORT;
delete process.env.TELEGRAM_BOT_TOKEN;

describe('Einstellungsseite im Browser', () => {
  let fastify: FastifyInstance;
  let browser: Browser;
  let page: Page;
  let basis: string;
  const skriptFehler: string[] = [];
  let konfig: typeof import('../config');
  let store: typeof import('../lib/settingsStore');

  beforeAll(async () => {
    const { runMigrations } = await import('../db/migrate');
    runMigrations();
    konfig = await import('../config');
    store = await import('../lib/settingsStore');
    store.ladeEinstellungen();
    const { buildServer } = await import('../server');
    // Wie der eigene Anschluss im LAN: http, ohne Hochstufen auf https.
    fastify = await buildServer({ logger: false, adminOnly: true });
    basis = await fastify.listen({ port: 0, host: '127.0.0.1' });
    browser = await chromium.launch();
    page = await browser.newPage();
    page.on('dialog', d => void d.accept());
    page.on('pageerror', err => skriptFehler.push(err.message));
  }, 60_000);

  afterAll(async () => {
    await browser?.close();
    await fastify?.close();
    for (const f of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) { try { unlinkSync(f); } catch { /* nicht da */ } }
  });

  it('meldet an und zeigt die Tabs barrierearm', async () => {
    await page.goto(`${basis}/settings`);
    await page.fill('#u', 'chef');
    await page.fill('#p', 'ein-langes-passwort-123');
    await page.click('button[type=submit]');
    await page.waitForSelector('[role=tablist]');
    expect(await page.getAttribute('#tab_status', 'aria-selected')).toBe('true');
    // Pfeiltaste wechselt den Tab, die Adresse merkt ihn sich.
    await page.focus('#tab_status');
    await page.keyboard.press('ArrowRight');
    expect(await page.getAttribute('#tab_mannschaften', 'aria-selected')).toBe('true');
    expect(await page.isVisible('#panel_mannschaften')).toBe(true);
    expect(await page.isVisible('#panel_status')).toBe(false);
    expect(new URL(page.url()).hash).toBe('#mannschaften');
  });

  it('behält eine Änderung über den Tab-Wechsel und zählt sie', async () => {
    await page.fill('#f_CLUB_NAME', 'Von der Seite');
    expect(await page.textContent('#tab_mannschaften .zahl')).toBe('1');
    expect(await page.isVisible('.leiste')).toBe(true);
    await page.click('#tab_aussehen');
    await page.click('#tab_mannschaften');
    expect(await page.inputValue('#f_CLUB_NAME')).toBe('Von der Seite');
    // Nichts ist gespeichert, bevor der Dialog bestätigt ist.
    expect(konfig.clubName()).toBe('Aus der Umgebung');
  });

  it('zeigt die Änderungen im Dialog und speichert erst dann', async () => {
    await page.keyboard.press('Control+s');
    await page.waitForSelector('dialog[open]');
    expect(await page.textContent('dialog')).toContain('Vereinsname');
    await page.click('dialog button.primary');
    await page.waitForSelector('.meldung.ok:not([hidden])');
    expect(konfig.clubName()).toBe('Von der Seite');
    expect(await page.isVisible('.leiste')).toBe(false);
    // Nach dem Speichern bleibt der Tab.
    expect(await page.getAttribute('#tab_mannschaften', 'aria-selected')).toBe('true');
  });

  it('merkt das Zurücksetzen vor, ohne andere offene Änderungen zu verlieren', async () => {
    await page.click('#tab_aussehen');
    await page.fill('#f_PRIMARY_COLOR', '#112233');
    await page.click('#tab_mannschaften');
    await page.click('.feld[data-key=CLUB_NAME] >> text=Auf die Umgebung zurücksetzen');
    expect(await page.isDisabled('#f_CLUB_NAME')).toBe(true);
    await page.click('#tab_aussehen');
    expect(await page.inputValue('#f_PRIMARY_COLOR')).toBe('#112233');
    expect(await page.textContent('.leiste')).toContain('2 ungespeicherte Änderungen');
    await page.click('.leiste button.primary');
    await page.click('dialog button.primary');
    await page.waitForSelector('.meldung.ok:not([hidden])');
    expect(konfig.clubName()).toBe('Aus der Umgebung');
    expect(konfig.configOverride('PRIMARY_COLOR')).toBe('#112233');
  });

  it('meldet einen falschen Wert am Feld, bevor gespeichert wird', async () => {
    await page.fill('#f_PRIMARY_COLOR', 'rot');
    await page.waitForSelector('#f_PRIMARY_COLOR[aria-invalid=true]');
    expect(await page.textContent('#f_PRIMARY_COLOR_e')).toContain('#003e51');
    await page.click('.leiste button.primary');
    expect(await page.isVisible('dialog[open]')).toBe(false);
    expect(await page.textContent('.meldung')).toContain('markierten Felder');
  });

  it('holt einen alten Wert aus dem Protokoll zurück', async () => {
    await page.click('.leiste >> text=Verwerfen');
    await page.click('#tab_status');
    await page.click('tr:has-text("Hauptfarbe") >> text=Alten Wert');
    expect(await page.getAttribute('#tab_aussehen', 'aria-selected')).toBe('true');
    expect(await page.isVisible('.leiste')).toBe(true);
  });

  it('läuft ohne Skriptfehler (auch nicht durch die CSP)', () => {
    expect(skriptFehler).toEqual([]);
  });
});
