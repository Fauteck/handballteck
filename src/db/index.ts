import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema';
import { databasePath } from '../config';

const DB_PATH = databasePath();
export { DB_PATH };

fs.mkdirSync(path.dirname(path.resolve(DB_PATH)), { recursive: true });

const sqlite = new Database(DB_PATH);

/**
 * WAL + `synchronous=NORMAL` wie in Todoteck: better-sqlite3 blockiert beim
 * Commit den Event-Loop, und WAL fsync't nur beim Checkpoint. Auf einem
 * Netzwerk-Dateisystem (NFS/SMB) ist WAL unzuverlässig — dann
 * `SQLITE_JOURNAL_MODE=delete`.
 */
function resolveJournalMode(): 'WAL' | 'DELETE' {
  const raw = (process.env.SQLITE_JOURNAL_MODE ?? '').trim().toLowerCase();
  return raw === 'delete' ? 'DELETE' : 'WAL';
}

export const JOURNAL_MODE = resolveJournalMode();
sqlite.pragma(`journal_mode = ${JOURNAL_MODE}`);
sqlite.pragma('foreign_keys = ON');
sqlite.pragma(`synchronous = ${JOURNAL_MODE === 'WAL' ? 'NORMAL' : 'FULL'}`);

export const db = drizzle(sqlite, { schema });
export { sqlite };
