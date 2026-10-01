/**
 * Einstieg: Migrationen, Server, Bot-Registrierung, der Takt des Abrufs.
 *
 * Der Takt ist ein einfacher Zeitgeber statt Todotecks Sync-Kern: ein Job,
 * keine Laufhistorie in einer Tabelle — was der Lauf tat, steht im Log und
 * in `/api/health`. Ein Lauf, der noch läuft, wird nicht überholt.
 */
import { runMigrations } from './db/migrate';
import { buildServer } from './server';
import { port, teamIds, publicUrl, importTodoteckDb, apiToken } from './config';
import { importTodoteck } from './import/todoteck';
import { syncHandballTeams, naechsterAbstandMs, handballOverview } from './lib/handballTeam';
import { clubdeskHolen } from './lib/clubdesk';
import { pushHandballBot, registerHandballBotAtBoot, pflegeHandballBotBeschreibung, refreshHandballWebhookInfo } from './lib/handballBot';
import { pushHandballSite } from './lib/handballSitePush';
import { serviceLog } from './lib/serviceLogger';

/** Wie lange nach dem Start der erste Lauf wartet — der Server soll erst antworten. */
const STARTUP_DELAY_MS = 20_000;

let laeuft = false;

export async function einTakt(): Promise<void> {
  if (laeuft) return;
  laeuft = true;
  try {
    const result = await syncHandballTeams();
    if (result.status === 'not_configured') { serviceLog.warn('[sync] Keine Mannschaft eingetragen (TEAM_IDS)'); return; }
    if (result.status !== 'ok') return;
    const bot = await pushHandballBot();
    const site = await pushHandballSite();
    try { await pflegeHandballBotBeschreibung(); } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[bot] Beschreibung nicht gesetzt');
    }
    await refreshHandballWebhookInfo();
    // Fotos der Vereinsseite — einmal am Tag, nach bestem Bemühen; ohne CLUBDESK_URL nichts.
    try {
      const sicht = handballOverview();
      const fotos = await clubdeskHolen(new Map(sicht.teams.map(t => [t.team_id, t.label])));
      if (fotos.status === 'ok') serviceLog.info({ geladen: fotos.geladen }, '[clubdesk] Fotos abgeglichen');
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[clubdesk] Abruf gescheitert');
    }
    serviceLog.info({ teams: result.teams, fetched: result.fetched + bot.fetches, bot: bot.recipients, site: site.recipients }, '[sync] Lauf beendet');
  } catch (err) {
    serviceLog.error({ err: err instanceof Error ? err.message : String(err) }, '[sync] Lauf gescheitert');
  } finally {
    laeuft = false;
  }
}

async function main(): Promise<void> {
  const neu = runMigrations();
  const fastify = await buildServer();
  if (neu.length > 0) fastify.log.info(`Migrationen angewendet: ${neu.join(', ')}`);

  // Übernahme aus Todoteck — einmalig, nur mit IMPORT_TODOTECK_DB, vor dem
  // ersten Takt (sonst schickte der Bot womöglich, was dort schon raus war).
  const importQuelle = importTodoteckDb();
  if (importQuelle) {
    try {
      const r = importTodoteck(importQuelle);
      if (r.status === 'schon_erledigt') fastify.log.info('Übernahme aus Todoteck lief schon — übersprungen. IMPORT_TODOTECK_DB kann aus dem Stack.');
      else if (r.status === 'quelle_fehlt') fastify.log.error(`Übernahme aus Todoteck: ${importQuelle} nicht gefunden — nichts übernommen`);
      else {
        for (const t of r.tabellen) fastify.log.info(`Übernahme ${t.tabelle}: ${t.gelesen} gelesen, ${t.uebernommen} übernommen`);
        for (const h of r.hinweise) fastify.log.warn(`Übernahme: ${h}`);
        fastify.log.info(`Übernahme aus Todoteck fertig: ${r.zeilen} Zeilen, VAPID ${r.vapid}`);
      }
    } catch (err) {
      fastify.log.error({ err: err instanceof Error ? err.message : String(err) }, 'Übernahme aus Todoteck gescheitert');
    }
  }
  // SEC-3-003: Der Token ist das einzige Schloss vor /api/* — ein kurzer lässt sich durchprobieren.
  const token = apiToken();
  if (token && token.length < 32) fastify.log.warn(`API_TOKEN hat nur ${token.length} Zeichen — mindestens 32 nehmen (openssl rand -hex 32).`);
  await fastify.listen({ port: port(), host: '0.0.0.0' });
  fastify.log.info(`Handballteck läuft — ${teamIds().length} Mannschaft(en), erreichbar unter ${publicUrl()}`);

  void registerHandballBotAtBoot()
    .then(r => {
      if (r.status === 'registered') fastify.log.info(`Telegram-Bot registriert (${new URL(r.url).host}${r.username ? `, @${r.username}` : ''})`);
      else fastify.log.info(`Telegram-Bot nicht registriert: ${r.reason}`);
    })
    .catch(err => fastify.log.error({ err: err instanceof Error ? err.message : String(err) }, 'Telegram-Bot konnte nicht registriert werden'));

  let shuttingDown = false;
  let taktTimer: NodeJS.Timeout | null = null;
  const planen = () => {
    taktTimer = setTimeout(() => { void einTakt().finally(() => { if (!shuttingDown) planen(); }); }, naechsterAbstandMs());
  };
  const start = setTimeout(() => { void einTakt().finally(() => { if (!shuttingDown) planen(); }); }, STARTUP_DELAY_MS);

  const stop = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    fastify.log.info(`${signal} — fahre herunter`);
    if (taktTimer) clearTimeout(taktTimer);
    clearTimeout(start);
    await fastify.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => { void stop('SIGTERM'); });
  process.on('SIGINT', () => { void stop('SIGINT'); });
}

main().catch(err => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exit(1);
});
