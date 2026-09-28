/**
 * Die Microsite — die öffentliche Mannschaftsseite im Vereins-CD samt allem,
 * was sie zum Leben braucht: Skript, Service Worker, Manifest, Logo,
 * Schriften, Bilder, Kalender, Feed und die Web-Push-Anmeldung. Alles unter
 * `/<Team-ID>/…`, alles **ohne Anmeldung** — es ist die Seite für Leute ohne
 * Todoteck-Konto und ohne Telegram.
 *
 * Was den offenen Zugang vertretbar macht:
 * - Die Seite antwortet nur mit `SITE_ENABLED`; sonst 404 für alles, ohne zu
 *   unterscheiden, ob es die Mannschaft gibt.
 * - Die Daten sind die, die handball.net jedem zeigt; Spielernamen nur mit
 *   `SITE_PLAYERS`.
 * - Die Bilder kommen aus einem Cache, die Routen sind gedrosselt — sonst
 *   wäre der Bild-Generator eine offene Rechenlast.
 * - Die Push-Anmeldung speichert nur den Endpoint des Browsers; wer ihn
 *   kennt, kann ihn auch wieder austragen. Ein Nutzerbezug entsteht nicht.
 *
 * Alle Verweise in der Seite sind relativ, deshalb liegt sie unter einer
 * Adresse mit Schrägstrich am Ende; die Route ohne leitet dorthin um. Die
 * Wurzel `/` führt zur ersten Mannschaft; das Dropdown im Kopf zu den
 * anderen (`../<Team-ID>/`).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import {
  siteConfig, siteTeam, renderSiteHtml, renderFeedXml, renderSiteIcs, renderManifest,
  siteImagePng, siteLogoPng, siteFontPath, istBildArt, SITE_SW_JS, SITE_APP_JS,
} from '../lib/handballSite';
import {
  sitePushConfig, saveSiteSubscription, deleteSiteSubscription, sendSiteWelcome, istLead, istMode,
} from '../lib/handballSitePush';
import { readPalette, handballOverview } from '../lib/handballTeam';
import { vervollstaendigePalette } from '../lib/handballTableImage';
import { serviceLog } from '../lib/serviceLogger';

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(1000).refine(u => u.startsWith('https://'), 'https only'),
    keys: z.object({ p256dh: z.string().min(16).max(256), auth: z.string().min(8).max(128) }),
  }),
  lead: z.string().optional(),
  mode: z.string().optional(),
});

const unsubscribeSchema = z.object({ endpoint: z.string().url().max(1000) });

const TEAM_ID = /^\d{1,12}$/;

export async function siteRoutes(fastify: FastifyInstance) {
  /** Die freigegebene Mannschaft — oder null, und dann für alles 404. */
  function freigegeben(teamId: string) {
    if (!TEAM_ID.test(teamId)) return null;
    const cfg = siteConfig(teamId);
    if (!cfg.enabled) return null;
    const t = siteTeam(teamId);
    return t ? { ...t, cfg } : null;
  }

  function nichtDa(reply: FastifyReply) {
    return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'not_found', message: 'Diese Seite gibt es nicht.' });
  }

  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  /** Alle Mannschaften für das Dropdown — relative Ziele, damit die Seite unter jeder Wurzel läuft. */
  function dropdown(): Array<{ id: string; label: string; url: string }> {
    const sicht = handballOverview();
    return sicht.configured ? sicht.teams.map(t => ({ id: t.team_id, label: t.label, url: `../${encodeURIComponent(t.team_id)}/` })) : [];
  }

  // Die Wurzel: zur ersten Mannschaft, damit eine eigene Domain ohne Pfad ankommt.
  fastify.get('/', limit(120), async (_request, reply) => {
    const sicht = handballOverview();
    const erste = sicht.configured ? sicht.teams[0] : undefined;
    if (!erste || !siteConfig(erste.team_id).enabled) return nichtDa(reply);
    return reply.redirect(`${encodeURIComponent(erste.team_id)}/`, 302);
  });

  // Ohne Schrägstrich: umleiten, damit `./bild/…` und der Service-Worker-Scope stimmen.
  fastify.get<{ Params: { teamId: string } }>('/:teamId', limit(120), async (request, reply) => {
    if (!freigegeben(request.params.teamId)) return nichtDa(reply);
    return reply.redirect(`${encodeURIComponent(request.params.teamId)}/`, 301);
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/', limit(60), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    const html = renderSiteHtml(t.team, {
      players: t.cfg.players, baseUrl: t.cfg.baseUrl, pushEnabled: sitePushConfig().enabled, stand: t.stand, teams: dropdown(),
    });
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', 'public, max-age=60')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .send(html);
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/app.js', limit(120), async (request, reply) => {
    if (!freigegeben(request.params.teamId)) return nichtDa(reply);
    return reply.header('Content-Type', 'application/javascript; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(SITE_APP_JS);
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/sw.js', limit(120), async (request, reply) => {
    if (!freigegeben(request.params.teamId)) return nichtDa(reply);
    return reply.header('Content-Type', 'application/javascript; charset=utf-8').header('Cache-Control', 'no-cache').send(SITE_SW_JS);
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/manifest.webmanifest', limit(120), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    return reply.header('Content-Type', 'application/manifest+json; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(JSON.stringify(renderManifest(t.team)));
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/logo.png', limit(120), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    const png = await siteLogoPng(t.team, vervollstaendigePalette(readPalette()));
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=86400').send(png);
  });

  fastify.get<{ Params: { teamId: string; datei: string } }>('/:teamId/fonts/:datei', limit(120), async (request, reply) => {
    if (!freigegeben(request.params.teamId)) return nichtDa(reply);
    const pfad = siteFontPath(request.params.datei);
    if (!pfad) return nichtDa(reply);
    return reply.header('Content-Type', 'font/ttf').header('Cache-Control', 'public, max-age=31536000, immutable').send(fs.createReadStream(pfad));
  });

  /** `spiel.png`, `endstand.png?match=…`, `tabelle.png`, `verlauf.png` — mit Spielernamen auch `torjaeger`, `kader`, `saison`. */
  fastify.get<{ Params: { teamId: string; datei: string }; Querystring: { match?: string } }>('/:teamId/bild/:datei', limit(120), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    const art = /^([a-z]+)\.png$/.exec(request.params.datei)?.[1] ?? '';
    if (!istBildArt(art, t.cfg.players)) return nichtDa(reply);
    const match = typeof request.query.match === 'string' && /^[\w-]{1,64}$/.test(request.query.match) ? request.query.match : null;
    const png = await siteImagePng(t.team, art, art === 'endstand' ? match : null, t.stand);
    if (!png) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'no_image', message: 'Dafür gibt es gerade kein Bild.' });
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=300').send(png);
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/feed.xml', limit(60), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    return reply.header('Content-Type', 'application/rss+xml; charset=utf-8').header('Cache-Control', 'public, max-age=300').send(renderFeedXml(t.team, t.cfg.baseUrl));
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/kalender.ics', limit(60), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    return reply.header('Content-Type', 'text/calendar; charset=utf-8').header('Cache-Control', 'public, max-age=900').send(renderSiteIcs(t.team));
  });

  // --- Web-Push ---

  fastify.get<{ Params: { teamId: string } }>('/:teamId/push', limit(60), async (request, reply) => {
    if (!freigegeben(request.params.teamId)) return nichtDa(reply);
    return reply.header('Cache-Control', 'no-store').send(sitePushConfig());
  });

  /**
   * Die Glocke: Subscription samt Vorlauf und Modus eintragen (oder
   * erneuern — der Endpoint ist der Schlüssel) und eine Bestätigung
   * schicken, damit man sieht, dass es ankommt.
   */
  fastify.post<{ Params: { teamId: string } }>('/:teamId/push', limit(20), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    if (!sitePushConfig().enabled) return reply.code(503).send({ error: 'push_disabled', message: 'Benachrichtigungen sind auf diesem Server nicht eingerichtet.' });
    const parsed = subscribeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', message: 'Die Anmeldung ist unvollständig.' });
    const { subscription, lead, mode } = parsed.data;
    const abo = saveSiteSubscription(t.team.team_id, {
      endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth,
      lead: istLead(lead) ? lead : '1h', mode: istMode(mode) ? mode : 'all',
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });
    // Nach bestem Bemühen — die Anmeldung steht, auch wenn die Bestätigung nicht ankommt.
    sendSiteWelcome(abo, t.team).catch(err => {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[site] Bestätigung nicht zustellbar');
    });
    return reply.header('Cache-Control', 'no-store').send({ ok: true, lead: abo.lead, mode: abo.mode });
  });

  fastify.delete<{ Params: { teamId: string } }>('/:teamId/push', limit(20), async (request, reply) => {
    if (!freigegeben(request.params.teamId)) return nichtDa(reply);
    const parsed = unsubscribeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', message: 'Kein Endpoint angegeben.' });
    const removed = deleteSiteSubscription(parsed.data.endpoint);
    return reply.header('Cache-Control', 'no-store').send({ ok: true, removed });
  });
}
