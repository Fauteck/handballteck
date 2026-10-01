/**
 * Der HTTP-Server — ohne Anmeldung, ohne Sitzungen, ohne Cookies. Drei
 * öffentliche Flächen (Microsite, Telegram-Webhook, Inline-Bilder) und eine
 * mit Token (`/api/*` für das Todoteck-Cockpit), dazu `/healthz` für den
 * Container-Healthcheck.
 *
 * Die CSP ist die der Microsite: Skripte nur von hier (kein Inline-JS —
 * `app.js` ist eine eigene Route), Stile dürfen inline stehen, Bilder als
 * Data-URI (die Logos sind eingebettet). Ein Fremdziel hat die Seite nicht.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import { trustProxy, version } from './config';
import { siteRoutes } from './routes/site';
import { telegramRoutes } from './routes/telegram';
import { apiRoutes } from './routes/api';
import { setServiceLogger } from './lib/serviceLogger';

/**
 * Die URL, wie sie ins Log geht: ohne das Pfadgeheimnis des Webhooks und
 * ohne die Signatur der Inline-Bilder. Beides wäre sonst im Klartext in jedem
 * Container-Log — und wer das Log liest, könnte den Webhook ansprechen.
 */
export function logUrl(url: string): string {
  return url
    .replace(/^\/telegram\/webhook\/[^/?#]+/, '/telegram/webhook/***')
    .replace(/([?&]t=)[^&#]*/g, '$1***');
}

export async function buildServer(opts: { logger?: boolean | object } = {}): Promise<FastifyInstance> {
  const fastify = Fastify({
    logger: opts.logger ?? {
      level: process.env.LOG_LEVEL || 'info',
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

  await fastify.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        manifestSrc: ["'self'"],
        workerSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
    // Die Microsite wird per Link in WhatsApp und Telegram geteilt; deren
    // Vorschau holt `og:image` über denselben Host — kein Cross-Origin-Zwang.
    crossOriginResourcePolicy: { policy: 'same-site' },
  });
  await fastify.register(rateLimit, { global: true, max: 300, timeWindow: '1 minute' });

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

  // Der Healthcheck kommt alle 30 Sekunden; mit `warn` schreibt er keine
  // Zeile pro Abruf, ein Fehler landet trotzdem im Log.
  fastify.get('/healthz', { logLevel: 'warn', config: { rateLimit: false } }, async (_request, reply) => {
    return reply.header('Cache-Control', 'no-store').send({ ok: true, ...version() });
  });
  fastify.get('/robots.txt', async (_request, reply) => {
    return reply.header('Content-Type', 'text/plain; charset=utf-8').send('User-agent: *\nDisallow: /\n');
  });

  await fastify.register(apiRoutes);
  await fastify.register(telegramRoutes);
  await fastify.register(siteRoutes);
  return fastify;
}
