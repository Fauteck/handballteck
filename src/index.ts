/**
 * Einstieg: Migrationen, Server, Bot-Registrierung, der Takt des Abrufs.
 *
 * Der Takt ist ein einfacher Zeitgeber statt Todotecks Sync-Kern: ein Job,
 * keine Laufhistorie in einer Tabelle — was der Lauf tat, steht im Log und
 * auf der Einstellungsseite unter „Zustand“. Ein Lauf, der noch läuft, wird nicht überholt.
 */
import { runMigrations } from './db/migrate';
import { buildServer } from './server';
import { port, teamIds, publicUrl, adminPort, adminPassword, ADMIN_PASSWORD_MIN, logLevel, siteFrameAncestors, botToken } from './config';
import { beiAenderung, setzeSyncAktion } from './lib/settingsStore';
import { syncHandballTeams, naechsterAbstandMs } from './lib/handballTeam';
import { handballOverview } from './lib/handballSicht';
import { clubdeskHolen, clubdeskFaelligMachen } from './lib/clubdesk';
import { registerHandballBotAtBoot, refreshHandballWebhookInfo, activateHandballBot, refreshHandballAdminMenu } from './lib/handballBotBasis';
import { pflegeHandballBotBeschreibung } from './lib/handballBotBeschreibung';
import { pushHandballBot } from './lib/handballBotPush';
import { pushHandballSite } from './lib/handballSitePush';
import { serviceLog } from './lib/serviceLogger';

/** Wie lange nach dem Start der erste Lauf wartet — der Server soll erst antworten. */
const STARTUP_DELAY_MS = 20_000;

let laeuft = false;

/** `vonHand`: der Knopf der Einstellungsseite — er fragt auch im Backoff nach (PRF-2-006). */
export async function einTakt(vonHand = false): Promise<void> {
  if (laeuft) return;
  laeuft = true;
  try {
    const result = await syncHandballTeams(vonHand);
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

  // Einstellungsseite: ein Lauf auf Knopfdruck, und nach Änderungen an Mannschaften oder Quellen sofort.
  setzeSyncAktion(() => einTakt(true));
  beiAenderung(keys => {
    // Eine geänderte Foto-Freigabe soll nicht bis zum nächsten Tagesabruf der Vereinsseite warten.
    const fotos = keys.some(k => ['CLUBDESK_URL', 'CLUBDESK_TEAMS', 'SITE_PHOTOS'].includes(k));
    if (fotos) clubdeskFaelligMachen();
    if (fotos || keys.some(k => ['TEAM_IDS', 'CLUB_TEAM_IDS', 'CLUB_NAME'].includes(k))) void einTakt();
    // Das Log-Level gilt ohne Neustart.
    if (keys.includes('LOG_LEVEL')) { fastify.log.level = logLevel(); fastify.log.info(`Log-Level jetzt ${logLevel()}`); }
    if (keys.includes('SITE_FRAME_ANCESTORS') && siteFrameAncestors()[0] === '*') fastify.log.warn('SITE_FRAME_ANCESTORS=* — jede fremde Seite darf die Microsite einbetten. Nur zum Testen.');
    // Ein neuer Bot-Token: Webhook, Befehle und Menü beim (womöglich anderen) Bot anmelden.
    if (keys.includes('TELEGRAM_BOT_TOKEN')) {
      if (!botToken()) fastify.log.info('Bot-Token entfernt — der Bot ist aus.');
      else void activateHandballBot()
        .then(r => { if (r) fastify.log.info(`Telegram-Bot angemeldet (${new URL(r.url).host}${r.username ? `, @${r.username}` : ''})`); })
        .catch(err => fastify.log.error({ err: err instanceof Error ? err.message : String(err) }, 'Telegram-Bot konnte nicht angemeldet werden'));
    } else if (keys.includes('TELEGRAM_ADMIN_CHAT_IDS')) {
      void refreshHandballAdminMenu().catch(err => fastify.log.warn({ err: err instanceof Error ? err.message : String(err) }, 'Admin-Menü des Bots nicht aktualisiert'));
    }
  });
  if (!adminPassword()) {
    if (process.env.ADMIN_PASSWORD) fastify.log.warn(`ADMIN_PASSWORD hat weniger als ${ADMIN_PASSWORD_MIN} Zeichen — die Einstellungsseite bleibt aus.`);
  }
  await fastify.listen({ port: port(), host: '0.0.0.0' });
  const adminAnschluss = adminPort();
  let adminServer: Awaited<ReturnType<typeof buildServer>> | null = null;
  if (adminAnschluss !== null && adminPassword()) {
    adminServer = await buildServer({ adminOnly: true });
    await adminServer.listen({ port: adminAnschluss, host: '0.0.0.0' });
    fastify.log.info(`Einstellungsseite auf Anschluss ${adminAnschluss} (nicht öffentlich)`);
  } else if (adminPassword()) {
    fastify.log.info('Einstellungsseite unter /settings');
  }
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
    if (adminServer) await adminServer.close();
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
