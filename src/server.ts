/**
 * Der HTTP-Server — für Besucher ohne Anmeldung, ohne Sitzungen, ohne Cookies. Drei
 * öffentliche Flächen (Microsite, Telegram-Webhook, Inline-Bilder), dazu
 * `/healthz` für den Container-Healthcheck. Die Token-API für das
 * Todoteck-Cockpit (`/api/*`) ist seit dem 16.11.2026 entfernt.
 *
 * Dazu kommt die Einstellungsseite `/settings` (Konto aus der Umgebung, siehe
 * `routes/settings.ts`) — aus, solange `ADMIN_PASSWORD` fehlt.
 *
 * Die CSP ist die der Microsite: Skripte nur von hier (kein Inline-JS —
 * `app.js` ist eine eigene Route), Stile dürfen inline stehen, Bilder als
 * Data-URI (die Logos sind eingebettet). Ein Fremdziel hat die Seite nicht.
 */
import Fastify, { type FastifyInstance, type RouteOptions } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { trustProxy, version, adminPort, siteFrameAncestors, logLevel } from './config';
import { siteRoutes } from './routes/site';
import { telegramRoutes } from './routes/telegram';
import { settingsRoutes } from './routes/settings';
import { ladeEinstellungen } from './lib/settingsStore';
import { setServiceLogger } from './lib/serviceLogger';
import { getBackoffSnapshot } from './lib/pollerBackoff';
import { getHandballNetStats } from './lib/handballNetClient';
import { rateLimitSchluessel } from './lib/rateLimitKey';

/**
 * Die URL, wie sie ins Log geht: ohne das Pfadgeheimnis des Webhooks und
 * ohne die Signatur der Inline-Bilder. Beides wäre sonst im Klartext in jedem
 * Container-Log — und wer das Log liest, könnte den Webhook ansprechen.
 * Ebenso der Schlüssel der Vorschau der Seite (`vorab=`).
 */
export function logUrl(url: string): string {
  return url
    .replace(/^\/telegram\/webhook\/[^/?#]+/, '/telegram/webhook/***')
    .replace(/([?&]t=)[^&#]*/g, '$1***')
    .replace(/([?&]vorab=)[^&#]*/g, '$1***');
}

/**
 * Was der Browser auf dieser Seite nie braucht — Kamera, Standort, Zahlung
 * und die Werbe-Kohorten von Chrome. Helmet setzt diesen Kopf nicht.
 */
export const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()';

/** Was sich auch mit `SITE_FRAME_ANCESTORS` nie einbetten lässt: Einstellungsseite und Webhook. */
const NIE_IM_RAHMEN = /^\/(settings|telegram)(\/|\?|$)/;

/**
 * `frame-ancestors` je Anfrage: Die Liste kommt von der Einstellungsseite und
 * gilt ohne Neustart. Ohne Liste niemand; mit Liste die eigene Herkunft und
 * die Vereinsseite; ein Stern jede Seite. Einstellungsseite und Webhook nie.
 */
export function frameAncestorsFuer(url: string, adminOnly: boolean): string {
  const einbetter = adminOnly ? [] : siteFrameAncestors();
  if (einbetter.length === 0 || NIE_IM_RAHMEN.test(url)) return "'none'";
  if (einbetter[0] === '*') return '*';
  return ["'self'", ...einbetter].join(' ');
}

export async function buildServer(opts: { logger?: boolean | object; onRoute?: (route: RouteOptions) => void; adminOnly?: boolean } = {}): Promise<FastifyInstance> {
  // Die auf der Einstellungsseite gespeicherten Werte gehen der Umgebung vor.
  if (!opts.adminOnly) ladeEinstellungen();
  const fastify = Fastify({
    logger: opts.logger ?? {
      level: logLevel(),
      serializers: {
        req: (request: { method: string; url: string; host?: string; ip?: string; socket?: { remotePort?: number } }) => ({
          method: request.method,
          url: logUrl(request.url),
          host: request.host,
          remoteAddress: request.ip,
          remotePort: request.socket?.remotePort,
        }),
      },
    },
    trustProxy: trustProxy(),
    bodyLimit: 256 * 1024,
  });
  setServiceLogger(fastify.log);
  // Für den Rate-Limit-Audit der Tests: jede Route zeigen, die registriert wird.
  if (opts.onRoute) fastify.addHook('onRoute', opts.onRoute);

  // Der eigene Anschluss der Einstellungsseite läuft im LAN meist über http. Helmet setzt
  // `upgrade-insecure-requests` und HSTS von sich aus: Der Browser machte dann aus
  // http://<NAS>:3411/settings/settings.js ein https-Ziel, das es dort nicht gibt, und die
  // Seite bliebe bei „Lädt …“. Am öffentlichen Anschluss (https über den Proxy) bleibt beides.
  // Einbetten darf man nur die Microsite — nie den eigenen Anschluss der Einstellungsseite.
  if (!opts.adminOnly && siteFrameAncestors()[0] === '*') fastify.log.warn('SITE_FRAME_ANCESTORS=* — jede fremde Seite darf die Microsite einbetten. Nur zum Testen; danach die Herkünfte der Vereinsseite eintragen.');
  const adminOnly = opts.adminOnly === true;
  await fastify.register(helmet, {
    strictTransportSecurity: opts.adminOnly ? false : undefined,
    contentSecurityPolicy: {
      directives: {
        ...(opts.adminOnly ? { upgradeInsecureRequests: null } : {}),
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        // Die Vereinsseite darf die Microsite einbetten (SITE_FRAME_ANCESTORS); sonst niemand.
        frameAncestors: [(req: { url?: string }) => frameAncestorsFuer(req.url ?? '/', adminOnly)],
      },
    },
    // X-Frame-Options setzt der onSend-Haken je Anfrage — er kennt keine Liste erlaubter
    // Herkünfte, und die Liste kann sich auf der Einstellungsseite ändern.
    xFrameOptions: false,
    // Die Microsite wird per Link in WhatsApp und Telegram geteilt; deren
    // Vorschau holt `og:image` über denselben Host — kein Cross-Origin-Zwang.
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  fastify.addHook('onSend', async (request, reply) => {
    reply.header('Permissions-Policy', PERMISSIONS_POLICY);
    // Ohne Liste SAMEORIGIN wie bisher. Mit Liste fällt der Kopf weg (SAMEORIGIN sperrte die
    // Vereinsseite in Browsern aus, die ihn neben `frame-ancestors` noch auswerten) —
    // außer für Einstellungsseite und Webhook: die bleiben ohne Rahmen (Clickjacking).
    const einbetter = adminOnly ? [] : siteFrameAncestors();
    if (einbetter.length === 0) reply.header('X-Frame-Options', 'SAMEORIGIN');
    else if (NIE_IM_RAHMEN.test(request.url)) reply.header('X-Frame-Options', 'DENY');
  });
  // SEC-3-005: IPv6 zählt je /64 — sonst wählt, wer ein Präfix hat, für jede Anfrage eine neue Adresse.
  await fastify.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute', keyGenerator: request => rateLimitSchluessel(request.ip) });

  // SEC-1-002: Ohne TRUST_PROXY sieht der Dienst hinter einem Reverse Proxy
  // nur dessen Adresse — dann teilen sich alle Besucher jedes Rate-Limit,
  // und ein einzelner Aufrufer sperrt die Seite für alle. Kommt ein
  // X-Forwarded-For an, obwohl kein Proxy eingetragen ist, einmal warnen.
  if (!trustProxy()) {
    let gewarnt = false;
    fastify.addHook('onRequest', async (request) => {
      if (gewarnt || request.headers['x-forwarded-for'] === undefined) return;
      gewarnt = true;
      request.log.warn({ proxy: request.ip }, 'X-Forwarded-For ohne TRUST_PROXY — alle Besucher teilen sich ein Rate-Limit. TRUST_PROXY auf die Adresse des Reverse Proxys setzen.');
    });
  }

  // Der eigene Anschluss der Einstellungsseite (ADMIN_PORT) bietet nur sie an.
  if (opts.adminOnly) {
    fastify.get('/', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (_request, reply) => reply.redirect('/settings'));
    await fastify.register(settingsRoutes);
    return fastify;
  }

  // Der Healthcheck kommt alle 30 Sekunden; mit `warn` schreibt er keine
  // Zeile pro Abruf, ein Fehler landet trotzdem im Log.
  fastify.get('/healthz', { logLevel: 'warn', config: { rateLimit: false } }, async (_request, reply) => {
    // `ok` bleibt wahr, solange der Prozess antwortet — ein Ausfall der Quelle ist
    // kein Grund, den Container neu zu starten. Wer ihn überwachen will, liest
    // `sync` (ohne Fehlertext; der steht auf der Einstellungsseite unter „Zustand“).
    const snapshot = getBackoffSnapshot('handball', 'team');
    const letzter = snapshot?.lastSuccessAt ?? null;
    return reply.header('Cache-Control', 'no-store').send({
      ok: true,
      ...version(),
      sync: {
        last_success_at: letzter ? new Date(letzter).toISOString() : null,
        last_success_age_s: letzter ? Math.round((Date.now() - letzter) / 1000) : null,
        consecutive_failures: snapshot?.consecutiveFailures ?? 0,
        source: getHandballNetStats(),
      },
    });
  });
  fastify.get('/robots.txt', async (_request, reply) => {
    return reply.header('Content-Type', 'text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n');
  });

  await fastify.register(telegramRoutes);
  // Mit ADMIN_PORT hängt die Einstellungsseite nur am eigenen Anschluss.
  if (adminPort() === null) await fastify.register(settingsRoutes);
  await fastify.register(siteRoutes);
  return fastify;
}
