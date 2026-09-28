/**
 * Lokaler Aufruf der Übernahme aus Todoteck, für die Entwicklung:
 * `npm run import:todoteck -- /pfad/zur/familytodo.db`
 *
 * Im Betrieb läuft dieselbe Übernahme beim Start, gesteuert über
 * `IMPORT_TODOTECK_DB` (src/import/todoteck.ts). Hier ohne den Merker, damit
 * man lokal beliebig oft gegen eine frische Datenbank probieren kann.
 */
function main(): void {
  const quelle = process.argv[2];
  if (!quelle) {
    console.error('Aufruf: npm run import:todoteck -- /pfad/zur/familytodo.db');
    process.exit(2);
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { runMigrations } = require('../src/db/migrate') as typeof import('../src/db/migrate');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { importTodoteck } = require('../src/import/todoteck') as typeof import('../src/import/todoteck');
  runMigrations();
  const r = importTodoteck(quelle, { force: true });
  if (r.status === 'quelle_fehlt') { console.error(`Nicht gefunden: ${quelle}`); process.exit(1); }
  for (const t of r.tabellen) console.log(`- ${t.tabelle}: ${t.gelesen} gelesen, ${t.uebernommen} übernommen`);
  for (const h of r.hinweise) console.log(`! ${h}`);
  console.log(`VAPID: ${r.vapid} · ${r.zeilen} Zeilen übernommen`);
}

main();
