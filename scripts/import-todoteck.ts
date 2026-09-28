/**
 * Übernahme aus Todoteck: `npm run import:todoteck -- /pfad/zur/familytodo.db`
 *
 * Bis zum 28.09.2026 lag die Handball-Verfolgung in Todoteck; die dreizehn
 * Tabellen dort heißen seit dessen Migration 0105 `legacy_handball_*` (oder
 * noch `handball_*`, wenn die Migration nicht lief). Dieses Skript kopiert
 * ihre Zeilen in die eigene Datenbank — vor allem die **Telegram-Abonnenten**
 * und die **Browser-Anmeldungen der Microsite**, die sich nicht neu holen
 * lassen, dazu die Merker (damit nach dem Umzug nicht jede Meldung der
 * Saison noch einmal rausgeht), den Verlauf und die Bilder-Bestände.
 *
 * Und das VAPID-Schlüsselpaar aus `app_settings`: Ohne es wären alle
 * Browser-Anmeldungen ungültig (der Push-Dienst antwortet 403 auf einen
 * fremden Schlüssel), und niemand merkte es, bis die erste Meldung fällig ist.
 *
 * Idempotent: `INSERT OR IGNORE`, ein zweiter Lauf ändert nichts. Die
 * Todoteck-Datei wird nur gelesen. Die Konfiguration (Team-IDs, Farben,
 * Bot-Token, Schalter) wandert nicht mit — die steht in der `.env` dieses
 * Dienstes, siehe README.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const TABELLEN = [
  'handball_team_match', 'handball_standings', 'handball_bot_instance', 'handball_bot_subscriber', 'handball_bot_sent',
  'handball_roster', 'handball_match_player', 'handball_match_change', 'handball_team_logo', 'handball_bot_feedback',
  'handball_bot_delivery', 'handball_site_subscription', 'handball_opponent_form',
];

function main(): void {
  const quelle = process.argv[2];
  if (!quelle || !fs.existsSync(quelle)) {
    console.error('Aufruf: npm run import:todoteck -- /pfad/zur/familytodo.db');
    process.exit(2);
  }
  process.env.DATABASE_PATH ??= `${(process.env.DATA_DIR ?? './data').replace(/\/+$/, '')}/handballteck.db`;
  fs.mkdirSync(path.dirname(path.resolve(process.env.DATABASE_PATH)), { recursive: true });

  // Erst die eigenen Migrationen, dann die Übernahme — beide über dieselbe Verbindung.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runMigrations } = require('../src/db/migrate') as typeof import('../src/db/migrate');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sqlite } = require('../src/db') as typeof import('../src/db');
  runMigrations();

  const alt = new Database(quelle, { readonly: true, fileMustExist: true });
  const tabellenAlt = new Set((alt.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
  const spaltenNeu = (tabelle: string) => (sqlite.prepare(`PRAGMA table_info(${tabelle})`).all() as { name: string }[]).map(c => c.name);

  let gesamt = 0;
  for (const tabelle of TABELLEN) {
    const quellName = tabellenAlt.has(`legacy_${tabelle}`) ? `legacy_${tabelle}` : tabellenAlt.has(tabelle) ? tabelle : null;
    if (!quellName) { console.log(`- ${tabelle}: nicht in der Quelle`); continue; }
    const spaltenAlt = (alt.prepare(`PRAGMA table_info(${quellName})`).all() as { name: string }[]).map(c => c.name);
    const gemeinsam = spaltenNeu(tabelle).filter(c => spaltenAlt.includes(c));
    const zeilen = alt.prepare(`SELECT ${gemeinsam.map(c => `"${c}"`).join(', ')} FROM ${quellName}`).all() as Record<string, unknown>[];
    const einfuegen = sqlite.prepare(`INSERT OR IGNORE INTO ${tabelle} (${gemeinsam.map(c => `"${c}"`).join(', ')}) VALUES (${gemeinsam.map(() => '?').join(', ')})`);
    let neu = 0;
    const lauf = sqlite.transaction(() => {
      for (const z of zeilen) neu += einfuegen.run(gemeinsam.map(c => z[c] ?? null)).changes;
    });
    lauf();
    gesamt += neu;
    console.log(`- ${tabelle}: ${zeilen.length} Zeilen gelesen, ${neu} übernommen`);
  }

  // Das VAPID-Schlüsselpaar — nur, wenn hier noch keins liegt.
  if (tabellenAlt.has('app_settings')) {
    const lese = (key: string) => (alt.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
    const pub = lese('vapid_public_key');
    const priv = lese('vapid_private_key');
    const hier = (sqlite.prepare("SELECT value FROM settings WHERE key = 'vapid_public_key'").get() as { value: string } | undefined)?.value;
    if (pub && priv && !hier) {
      const now = new Date().toISOString();
      sqlite.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('vapid_public_key', pub, now);
      sqlite.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)').run('vapid_private_key', priv, now);
      console.log('- VAPID-Schlüsselpaar übernommen (Browser-Anmeldungen bleiben gültig)');
    } else if (pub && hier && hier !== pub) {
      console.warn('! VAPID: hier liegt schon ein anderer Schlüssel — die übernommenen Browser-Anmeldungen werden mit ihm nicht zustellbar sein. Datenbank leeren und neu importieren, oder VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY aus Todoteck in die .env setzen.');
    }
  }
  console.log(`Fertig: ${gesamt} Zeilen übernommen nach ${process.env.DATABASE_PATH}`);
}

main();
