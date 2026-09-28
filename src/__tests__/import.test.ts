/**
 * Die einmalige Übernahme aus Todoteck (src/import/todoteck.ts): liest die
 * umbenannten `legacy_handball_*`-Tabellen und das VAPID-Paar, übernimmt nur
 * gemeinsame Spalten, läuft genau einmal — und ein Chat, der danach `/stop`
 * schickt, kommt beim nächsten Start nicht wieder.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import Database from 'better-sqlite3';

const DIR = `/tmp/handballteck-import-${process.pid}`;
process.env.DATABASE_PATH = `${DIR}/handballteck.db`;
process.env.DATA_DIR = DIR;

const QUELLE = `${DIR}/familytodo.db`;

function legeTodoteckAn(): void {
  const alt = new Database(QUELLE);
  alt.pragma('journal_mode = WAL');
  alt.exec(`
    CREATE TABLE legacy_handball_bot_subscriber (chat_id TEXT PRIMARY KEY, name TEXT, subscribed_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, lead TEXT, mode TEXT);
    INSERT INTO legacy_handball_bot_subscriber VALUES ('4711', 'Kumpel', '2026-09-26T10:00:00Z', '2026-09-27T10:00:00Z', '3h', 'results');
    INSERT INTO legacy_handball_bot_subscriber VALUES ('-100555', 'Gruppe: Eltern', '2026-09-26T10:00:00Z', '2026-09-27T10:00:00Z', NULL, NULL);
    CREATE TABLE legacy_handball_bot_sent (id TEXT PRIMARY KEY, sent_at TEXT NOT NULL);
    INSERT INTO legacy_handball_bot_sent VALUES ('96254:m1:result', '2026-09-27T16:00:00Z');
    CREATE TABLE legacy_handball_site_subscription (id INTEGER PRIMARY KEY AUTOINCREMENT, team_id TEXT NOT NULL, endpoint TEXT NOT NULL UNIQUE, p256dh TEXT NOT NULL, auth TEXT NOT NULL, lead TEXT NOT NULL DEFAULT '1h', mode TEXT NOT NULL DEFAULT 'all', user_agent TEXT, failures INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, last_sent_at TEXT, nur_in_todoteck TEXT);
    INSERT INTO legacy_handball_site_subscription (team_id, endpoint, p256dh, auth, created_at, last_seen_at, nur_in_todoteck) VALUES ('96254', 'https://push.example/abc', 'p', 'a', '2026-09-28T10:00:00Z', '2026-09-28T10:00:00Z', 'x');
    CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    INSERT INTO app_settings VALUES ('vapid_public_key', 'BTodoteckPublic'), ('vapid_private_key', 'todoteck-private');
  `);
  alt.close();
}

describe('Übernahme aus Todoteck', () => {
  let sqlite: typeof import('../db')['sqlite'];
  let mod: typeof import('../import/todoteck');

  beforeAll(async () => {
    fs.rmSync(DIR, { recursive: true, force: true });
    fs.mkdirSync(DIR, { recursive: true });
    legeTodoteckAn();
    ({ sqlite } = await import('../db'));
    const { runMigrations } = await import('../db/migrate');
    runMigrations();
    mod = await import('../import/todoteck');
  });

  afterAll(() => {
    fs.rmSync(DIR, { recursive: true, force: true });
  });

  it('meldet eine fehlende Quelle, ohne sich den Import zu merken', () => {
    expect(mod.importTodoteck(`${DIR}/gibtsnicht.db`).status).toBe('quelle_fehlt');
    expect(sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(mod.IMPORT_MARKER)).toBeUndefined();
  });

  it('übernimmt Abonnenten, Merker, Browser-Anmeldungen und das VAPID-Paar — nur gemeinsame Spalten', () => {
    const r = mod.importTodoteck(QUELLE);
    expect(r.status).toBe('importiert');
    expect(r.vapid).toBe('uebernommen');
    expect(r.zeilen).toBe(4);
    expect(r.hinweise.some(h => h.startsWith('handball_roster: nicht in der Quelle'))).toBe(true);
    const abos = sqlite.prepare('SELECT chat_id, lead, mode, team_ids FROM handball_bot_subscriber ORDER BY chat_id').all();
    expect(abos).toEqual([
      { chat_id: '-100555', lead: null, mode: null, team_ids: null },
      { chat_id: '4711', lead: '3h', mode: 'results', team_ids: null },
    ]);
    expect(sqlite.prepare('SELECT endpoint FROM handball_site_subscription').all()).toEqual([{ endpoint: 'https://push.example/abc' }]);
    expect(sqlite.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get()).toEqual({ value: 'BTodoteckPublic' });
    // Die Arbeitskopie ist wieder weg, die Quelle unberührt.
    expect(fs.readdirSync(DIR).filter(f => f.startsWith('.todoteck-import'))).toEqual([]);
    expect(fs.existsSync(QUELLE)).toBe(true);
  });

  it('läuft nur einmal: ein Chat, der danach /stop schickt, kommt nicht wieder', () => {
    sqlite.prepare("DELETE FROM handball_bot_subscriber WHERE chat_id = '4711'").run();
    expect(mod.importTodoteck(QUELLE).status).toBe('schon_erledigt');
    expect(sqlite.prepare("SELECT chat_id FROM handball_bot_subscriber WHERE chat_id = '4711'").get()).toBeUndefined();
  });

  it('meldet einen abweichenden VAPID-Schlüssel statt ihn zu überschreiben', () => {
    sqlite.prepare("UPDATE settings SET value = 'BAnderer' WHERE key = 'vapid_public_key'").run();
    const r = mod.importTodoteck(QUELLE, { force: true });
    expect(r.vapid).toBe('abweichend');
    expect(r.hinweise.join(' ')).toContain('VAPID_PUBLIC_KEY');
    expect(sqlite.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get()).toEqual({ value: 'BAnderer' });
  });
});
