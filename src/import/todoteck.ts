/**
 * Übernahme aus Todoteck — einmalig, beim Start, gesteuert über
 * `IMPORT_TODOTECK_DB`.
 *
 * Bis zum 28.09.2026 lag die Handball-Verfolgung in Todoteck; die dreizehn
 * Tabellen dort heißen seit dessen Migration 0105 `legacy_handball_*` (oder
 * noch `handball_*`, wenn die Migration nicht lief). Übernommen werden ihre
 * Zeilen — vor allem die **Telegram-Abonnenten** und die
 * **Browser-Anmeldungen der Microsite**, die sich nicht neu holen lassen,
 * dazu die Merker (sonst ginge nach dem Umzug jede Meldung der Saison noch
 * einmal raus), der Verlauf und die Logos — und das **VAPID-Schlüsselpaar**
 * aus `app_settings`: Ohne es wären alle Browser-Anmeldungen ungültig (der
 * Push-Dienst antwortet 403 auf einen fremden Schlüssel), und niemand merkte
 * es vor der ersten fälligen Meldung.
 *
 * **Warum beim Start und nicht als Befehl:** Der Betrieb läuft über
 * Portainer-Git-Stacks, und ein `docker exec` in einen laufenden Container
 * ist dort ausdrücklich nicht der Weg. Also: Variable im Stack setzen,
 * redeployen, Log lesen, Variable wieder entfernen.
 *
 * **Warum nur einmal:** `INSERT OR IGNORE` wäre auch beim zweiten Lauf
 * harmlos für die Daten — aber nicht für die Abonnenten. Wer nach dem Umzug
 * `/stop` schickt, stünde beim nächsten Neustart wieder in der Liste, solange
 * die Variable gesetzt bleibt. Deshalb merkt sich der Dienst in `settings`,
 * dass der Import lief, und überspringt ihn danach mit einer Logzeile.
 *
 * **Warum eine Kopie der Quelle:** Die Todoteck-Datenbank läuft im WAL-Modus;
 * schreibgeschützt eingehängt lässt sie sich nicht öffnen, weil SQLite die
 * `-shm`-Datei anlegen will. Gelesen wird deshalb eine Kopie unter
 * `DATA_DIR`, die danach wieder verschwindet. Als Quelle taugt am besten ein
 * Backup-Snapshot von Todoteck (in sich geschlossen, ohne `-wal`); die laufende
 * Datei ginge auch, nur fehlte dann, was noch im WAL steht.
 */
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { sqlite } from '../db';
import { dataDir } from '../config';

export const IMPORT_MARKER = 'todoteck_import_done_at';

const TABELLEN = [
  'handball_team_match', 'handball_standings', 'handball_bot_instance', 'handball_bot_subscriber', 'handball_bot_sent',
  'handball_roster', 'handball_match_player', 'handball_match_change', 'handball_team_logo', 'handball_bot_feedback',
  'handball_bot_delivery', 'handball_site_subscription', 'handball_opponent_form',
];

export interface ImportErgebnis {
  status: 'importiert' | 'schon_erledigt' | 'quelle_fehlt';
  zeilen: number;
  tabellen: Array<{ tabelle: string; gelesen: number; uebernommen: number }>;
  vapid: 'uebernommen' | 'vorhanden' | 'abweichend' | 'keiner';
  hinweise: string[];
}

function setting(key: string): string | null {
  return (sqlite.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined)?.value ?? null;
}

function setzeSetting(key: string, value: string): void {
  sqlite.prepare('INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at')
    .run(key, value, new Date().toISOString());
}

/**
 * Übernimmt aus der Todoteck-Datenbank unter `quelle`. `force` überspringt
 * den Merker (nur für Tests und den lokalen Aufruf über `npm run import:todoteck`).
 */
export function importTodoteck(quelle: string, opts: { force?: boolean } = {}): ImportErgebnis {
  const ergebnis: ImportErgebnis = { status: 'importiert', zeilen: 0, tabellen: [], vapid: 'keiner', hinweise: [] };
  if (!opts.force && setting(IMPORT_MARKER)) return { ...ergebnis, status: 'schon_erledigt' };
  if (!fs.existsSync(quelle)) return { ...ergebnis, status: 'quelle_fehlt' };

  const kopie = path.join(dataDir(), `.todoteck-import-${process.pid}.db`);
  fs.mkdirSync(path.dirname(kopie), { recursive: true });
  fs.copyFileSync(quelle, kopie);
  const alt = new Database(kopie, { fileMustExist: true });
  try {
    const tabellenAlt = new Set((alt.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]).map(r => r.name));
    const spaltenNeu = (tabelle: string) => (sqlite.prepare(`PRAGMA table_info(${tabelle})`).all() as { name: string }[]).map(c => c.name);

    for (const tabelle of TABELLEN) {
      const quellName = tabellenAlt.has(`legacy_${tabelle}`) ? `legacy_${tabelle}` : tabellenAlt.has(tabelle) ? tabelle : null;
      if (!quellName) { ergebnis.hinweise.push(`${tabelle}: nicht in der Quelle`); continue; }
      const spaltenAlt = (alt.prepare(`PRAGMA table_info(${quellName})`).all() as { name: string }[]).map(c => c.name);
      const gemeinsam = spaltenNeu(tabelle).filter(c => spaltenAlt.includes(c));
      const zeilen = alt.prepare(`SELECT ${gemeinsam.map(c => `"${c}"`).join(', ')} FROM ${quellName}`).all() as Record<string, unknown>[];
      const einfuegen = sqlite.prepare(`INSERT OR IGNORE INTO ${tabelle} (${gemeinsam.map(c => `"${c}"`).join(', ')}) VALUES (${gemeinsam.map(() => '?').join(', ')})`);
      let neu = 0;
      sqlite.transaction(() => {
        for (const z of zeilen) neu += einfuegen.run(gemeinsam.map(c => z[c] ?? null)).changes;
      })();
      ergebnis.tabellen.push({ tabelle, gelesen: zeilen.length, uebernommen: neu });
      ergebnis.zeilen += neu;
    }

    if (tabellenAlt.has('app_settings')) {
      const lese = (key: string) => (alt.prepare('SELECT value FROM app_settings WHERE key = ?').get(key) as { value: string } | undefined)?.value;
      const pub = lese('vapid_public_key');
      const priv = lese('vapid_private_key');
      const hier = setting('vapid_public_key');
      if (pub && priv && !hier) {
        setzeSetting('vapid_public_key', pub);
        setzeSetting('vapid_private_key', priv);
        ergebnis.vapid = 'uebernommen';
      } else if (pub && hier && hier !== pub) {
        ergebnis.vapid = 'abweichend';
        ergebnis.hinweise.push('VAPID: hier liegt schon ein anderer Schlüssel — die übernommenen Browser-Anmeldungen sind damit nicht zustellbar. VAPID_PUBLIC_KEY und VAPID_PRIVATE_KEY aus Todoteck in den Stack setzen.');
      } else if (pub) {
        ergebnis.vapid = 'vorhanden';
      }
    }
  } finally {
    alt.close();
    fs.rmSync(kopie, { force: true });
  }
  setzeSetting(IMPORT_MARKER, new Date().toISOString());
  return ergebnis;
}
