/**
 * Migrationen: die SQL-Dateien unter `drizzle/`, in Dateireihenfolge, jede
 * genau einmal (Tabelle `migrations`). Alles darin ist idempotent geschrieben
 * (`CREATE TABLE IF NOT EXISTS`), damit ein halb gelaufener Start beim
 * nächsten Mal nicht an sich selbst scheitert.
 */
import fs from 'node:fs';
import path from 'node:path';
import { sqlite } from './index';

function migrationsDir(): string {
  // src/db → ../../drizzle; dist/db → ../../drizzle. Der Ordner liegt neben `src` und `dist`.
  const kandidaten = [path.resolve(__dirname, '../../drizzle'), path.resolve(process.cwd(), 'drizzle')];
  for (const d of kandidaten) if (fs.existsSync(d)) return d;
  throw new Error(`Migrationsordner nicht gefunden (gesucht: ${kandidaten.join(', ')})`);
}

export function runMigrations(): string[] {
  sqlite.exec('CREATE TABLE IF NOT EXISTS migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const dir = migrationsDir();
  const dateien = fs.readdirSync(dir).filter(f => /^\d{4}_.*\.sql$/.test(f)).sort();
  const erledigt = new Set((sqlite.prepare('SELECT name FROM migrations').all() as { name: string }[]).map(r => r.name));
  const neu: string[] = [];
  for (const datei of dateien) {
    if (erledigt.has(datei)) continue;
    const sql = fs.readFileSync(path.join(dir, datei), 'utf8');
    const lauf = sqlite.transaction(() => {
      sqlite.exec(sql);
      sqlite.prepare('INSERT INTO migrations (name, applied_at) VALUES (?, ?)').run(datei, new Date().toISOString());
    });
    lauf();
    neu.push(datei);
  }
  return neu;
}
