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
 * - Die Daten sind die, die handball.net jedem zeigt; Spielernamen aus dem
 *   Kader stehen dort ebenso (Freigabe des Vereins vom 2026-10-23).
 * - Die Bilder kommen aus einem Cache, die Routen sind gedrosselt — sonst
 *   wäre der Bild-Generator eine offene Rechenlast.
 * - Die Push-Anmeldung speichert nur den Endpoint des Browsers; wer ihn
 *   kennt, kann ihn auch wieder austragen. Ein Nutzerbezug entsteht nicht.
 *
 * Alle Verweise in der Seite sind relativ, deshalb liegt sie unter einer
 * Adresse mit Schrägstrich am Ende; die Route ohne leitet dorthin um. Die
 * Wurzel `/` ist die Startseite mit allen Mannschaften und den Heimspielen
 * des nächsten Wochenendes; die Schaltflächen im Kopf führen zu den
 * Mannschaften (`../<Team-ID>/`).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import fs from 'node:fs';
import { z } from 'zod';
import { siteConfig, siteTeam, siteRootUrl, renderSiteHtml, renderStartManifest, renderFeedXml, renderSiteIcs, renderManifest, siteImagePng, wochenendePng, siteLogoPng, siteFontPath, istBildArt, siteCssText, fotoFreigegeben, istLiveFenster, SITE_SW_JS, SITE_APP_JS, SITE_THEME_JS, type SiteTeamLink } from '../lib/handballSite';
import { renderSpielHtml, renderStartHtml } from '../lib/handballSitePages';
import { fotoJpeg } from '../lib/clubdesk';
import { timingSafeEqual } from 'node:crypto';
import { inhaltsHash } from '../lib/handballSiteAssets';
import {
  sitePushConfig, saveSiteSubscription, deleteSiteSubscription, siteSubscriptionExists, countSiteSubscribers, sendSiteWelcome, istLead, istMode, bereinigeThemen, CLUB, type SiteSubscriber,
} from '../lib/handballSitePush';
import { readPalette, readTeamIds } from '../lib/handballTeam';
import { handballOverview, seitenUebersicht } from '../lib/handballSicht';
import { vervollstaendigePalette } from '../lib/handballTableImage';
import { serviceLog } from '../lib/serviceLogger';
import { isPushServiceUrl } from '../lib/ssrf';
import { sitePushMax, sitePreviewToken } from '../config';

const APP_JS_HASH = inhaltsHash(SITE_APP_JS);
const THEME_JS_HASH = inhaltsHash(SITE_THEME_JS);

/**
 * Der Vorschau-Schlüssel aus `?vorab=` — zurückgegeben nur, wenn er zu
 * `SITE_PREVIEW_TOKEN` passt (Vergleich in konstanter Zeit). Sonst null, und
 * die Seite ist die öffentliche.
 */
function vorschauAus(query: unknown): string | null {
  const soll = sitePreviewToken();
  const ist = (query as { vorab?: unknown } | undefined)?.vorab;
  if (!soll || typeof ist !== 'string' || ist.length !== soll.length) return null;
  return timingSafeEqual(Buffer.from(ist), Buffer.from(soll)) ? ist : null;
}

const subscribeSchema = z.object({
  subscription: z.object({
    endpoint: z.string().url().max(1000).refine(isPushServiceUrl, 'kein bekannter Push-Dienst'),
    keys: z.object({ p256dh: z.string().min(16).max(256), auth: z.string().min(8).max(128) }),
  }),
  lead: z.string().optional(),
  mode: z.string().optional(),
  topics: z.array(z.string().max(20)).max(12).optional(),
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

  /**
   * Für Dateien, die nichts von der Mannschaft enthalten (Skript, Stil,
   * Schriften, Service Worker): dieselbe Freigabe, ohne die Übersicht zu
   * bauen (PRF-1-002).
   */
  function freigabeOhneSicht(teamId: string): boolean {
    return TEAM_ID.test(teamId) && siteConfig(teamId).enabled && readTeamIds().includes(teamId);
  }

  /** Ob der Browser diesen Stand schon hat. Ein Proxy, der komprimiert, macht daraus ein schwaches `W/"…"`; mehrere Werte kommen durch Komma getrennt. */
  function schonDa(request: { headers: Record<string, unknown> }, etag: string): boolean {
    return String(request.headers['if-none-match'] ?? '').split(',').map(t => t.trim().replace(/^W\//, '')).includes(etag);
  }

  /**
   * PRF-1-002: Das HTML der Seiten je Übersicht. Die Übersicht ist
   * zwischengespeichert und wird neu, sobald die Datenbank geschrieben wird,
   * die Konfiguration sich ändert oder ihre Frist abläuft — dann ist auch das
   * HTML neu, und das alte fällt mit ihr weg. Mit dem ETag antwortet ein
   * Live-Poll ohne neuen Stand mit 304.
   */
  const seitenCache = new WeakMap<object, Map<string, { html: string; etag: string }>>();
  function seite(sicht: object, schluessel: string, bauen: () => string): { html: string; etag: string } {
    let jeSicht = seitenCache.get(sicht);
    if (!jeSicht) { jeSicht = new Map(); seitenCache.set(sicht, jeSicht); }
    let eintrag = jeSicht.get(schluessel);
    if (!eintrag) {
      const html = bauen();
      eintrag = { html, etag: `"${inhaltsHash(html)}"` };
      jeSicht.set(schluessel, eintrag);
    }
    return eintrag;
  }

  function nichtDa(reply: FastifyReply) {
    return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'not_found', message: 'Diese Seite gibt es nicht.' });
  }

  const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  /**
   * PRF-3-004: Die Seiten selbst. Der Live-Modus fragt alle 30 s nach; in einer
   * Halle stehen viele Zuschauer hinter derselben Adresse (WLAN, NAT), und mit
   * 60/min bekam schon der 31. eine 429 — genau während des Spiels. Seit dem
   * Zwischenspeicher kostet eine Antwort rund 1 ms oder ist ein 304.
   */
  const SEITEN_LIMIT = 300;

  /**
   * Stil und Skript: Der Hash im Namen (`?v=…`) macht sie ein Jahr lang
   * zwischenspeicherbar; ohne oder mit altem Hash gilt eine kurze Frist, und
   * ein ETag erspart die Übertragung, wenn sich nichts geändert hat.
   */
  function festeDatei(request: { query: unknown; headers: Record<string, unknown> }, reply: FastifyReply, text: string, hash: string, contentType: string) {
    const etag = `"${hash}"`;
    const fest = (request.query as { v?: string } | undefined)?.v === hash;
    reply.header('Content-Type', contentType).header('ETag', etag)
      .header('Cache-Control', fest ? 'public, max-age=31536000, immutable' : 'public, max-age=300, must-revalidate');
    if (schonDa(request, etag)) return reply.code(304).send();
    return reply.send(text);
  }

  /** Alle Mannschaften für die Mannschaftswahl im Kopf — relative Ziele, damit die Seite unter jeder Wurzel läuft. */
  function mannschaftswahl(): SiteTeamLink[] {
    const sicht = handballOverview();
    return sicht.configured ? sicht.teams.map(t => ({ id: t.team_id, label: t.label, group: t.group, url: `../${encodeURIComponent(t.team_id)}/` })) : [];
  }

  /**
   * Die Wurzel ist die Startseite: Überblick über alle Mannschaften und die
   * Heimspiele des nächsten Wochenendes samt Halle. Dateien und Mannschaften
   * liegen unter `./<Team-ID>/`, deshalb gilt auch hier die Adresse mit
   * Schrägstrich (die Wurzel hat ihn immer).
   */
  fastify.get('/', limit(SEITEN_LIMIT), async (request, reply) => {
    const sicht = seitenUebersicht();
    const erste = sicht.configured ? sicht.teams[0] : undefined;
    if (!sicht.configured || !erste || !siteConfig(erste.team_id).enabled) return nichtDa(reply);
    const baseUrl = `${siteRootUrl()}/`;
    const pushEnabled = sitePushConfig().enabled;
    const s = seite(sicht, `start|${baseUrl}|${pushEnabled}`, () => renderStartHtml(sicht.teams, { teams: mannschaftswahl(), baseUrl, stand: sicht.updated_at, pushEnabled }));
    const live = sicht.teams.some(t => istLiveFenster(t.next_match));
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', live ? 'public, max-age=15' : 'public, max-age=60')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .header('ETag', s.etag);
    if (schonDa(request, s.etag)) return reply.code(304).send();
    return reply.send(s.html);
  });

  // Das Wochenende als Bild zum Weiterschicken — ein Cache-Eintrag je Wochenende, wie die Bilder der Mannschaften.
  fastify.get('/bild/wochenende.png', limit(30), async (_request, reply) => {
    const sicht = seitenUebersicht();
    const erste = sicht.configured ? sicht.teams[0] : undefined;
    if (!sicht.configured || !erste || !siteConfig(erste.team_id).enabled) return nichtDa(reply);
    const png = await wochenendePng(sicht.teams);
    if (!png) return reply.code(404).header('Cache-Control', 'no-store').send({ error: 'no_image', message: 'Dafür gibt es gerade kein Bild.' });
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=300').send(png);
  });

  // Manifest und Service Worker der Startseite — die Wurzel ist der Scope, die Mannschaften liegen darin.
  fastify.get('/manifest.webmanifest', limit(120), async (_request, reply) => {
    const sicht = handballOverview();
    const erste = sicht.configured ? sicht.teams[0] : undefined;
    if (!erste || !siteConfig(erste.team_id).enabled) return nichtDa(reply);
    return reply.header('Content-Type', 'application/manifest+json; charset=utf-8').header('Cache-Control', 'public, max-age=3600').send(JSON.stringify(renderStartManifest(erste)));
  });

  fastify.get('/sw.js', limit(120), async (_request, reply) => {
    const sicht = handballOverview();
    const erste = sicht.configured ? sicht.teams[0] : undefined;
    if (!erste || !siteConfig(erste.team_id).enabled) return nichtDa(reply);
    return reply.header('Content-Type', 'application/javascript; charset=utf-8').header('Cache-Control', 'no-cache').send(SITE_SW_JS);
  });

  // Ohne Schrägstrich: umleiten, damit `./bild/…` und der Service-Worker-Scope stimmen.
  fastify.get<{ Params: { teamId: string } }>('/:teamId', limit(120), async (request, reply) => {
    if (!freigabeOhneSicht(request.params.teamId)) return nichtDa(reply);
    return reply.redirect(`${encodeURIComponent(request.params.teamId)}/`, 301);
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/', limit(SEITEN_LIMIT), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    const vorschau = vorschauAus(request.query);
    const pushEnabled = sitePushConfig().enabled;
    const bauen = () => renderSiteHtml(t.team, {
      baseUrl: t.cfg.baseUrl, pushEnabled, stand: t.stand, teams: mannschaftswahl(), vorschau,
    });
    // Läuft ein Spiel, darf die Seite nur kurz im Zwischenspeicher liegen — sonst zeigt der Live-Modus Altes.
    const live = istLiveFenster(t.team.next_match);
    reply
      .header('Content-Type', 'text/html; charset=utf-8')
      // Die Vorschau darf in keinem Zwischenspeicher landen, auch nicht in dem eines Proxys — und nicht in unserem.
      .header('Cache-Control', vorschau ? 'private, no-store' : live ? 'public, max-age=15' : 'public, max-age=60')
      .header('X-Robots-Tag', 'noindex, nofollow');
    if (vorschau) return reply.send(bauen());
    const s = seite(seitenUebersicht(), `team|${t.team.team_id}|${t.cfg.baseUrl}|${pushEnabled}`, bauen);
    reply.header('ETag', s.etag);
    if (schonDa(request, s.etag)) return reply.code(304).send();
    return reply.send(s.html);
  });

  /** Die Seite zu einem einzelnen Spiel: Spielstand, Verlauf, Halle; mit Spielernamen auch Torschützen und Bericht. */
  fastify.get<{ Params: { teamId: string; matchId: string } }>('/:teamId/spiel/:matchId', limit(60), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t || !/^[\w-]{1,64}$/.test(request.params.matchId)) return nichtDa(reply);
    const html = renderSpielHtml(t.team, request.params.matchId, {
      baseUrl: t.cfg.baseUrl, pushEnabled: false, stand: t.stand, teams: mannschaftswahl(),
    });
    if (!html) return nichtDa(reply);
    const live = t.team.matches.find(m => m.match_id === request.params.matchId)?.is_live === true;
    return reply
      .header('Content-Type', 'text/html; charset=utf-8')
      .header('Cache-Control', live ? 'public, max-age=15' : 'public, max-age=60')
      .header('X-Robots-Tag', 'noindex, nofollow')
      .send(html);
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/app.js', limit(120), async (request, reply) => {
    if (!freigabeOhneSicht(request.params.teamId)) return nichtDa(reply);
    return festeDatei(request, reply, SITE_APP_JS, APP_JS_HASH, 'application/javascript; charset=utf-8');
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/theme.js', limit(120), async (request, reply) => {
    if (!freigabeOhneSicht(request.params.teamId)) return nichtDa(reply);
    return festeDatei(request, reply, SITE_THEME_JS, THEME_JS_HASH, 'application/javascript; charset=utf-8');
  });

  /**
   * Fotos der Vereinsseite — nur, was die Seite auch zeigt (`fotoFreigegeben`):
   * mit gültigem Vorschau-Schlüssel die Vorschau-Regeln, sonst die Freigabe je
   * Mannschaft von der Einstellungsseite. Sonst 404 wie für Unbekanntes.
   */
  fastify.get<{ Params: { teamId: string; wer: string } }>('/:teamId/foto/:wer', limit(120), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    const wer = /^(gruppe|\d{1,12})\.jpg$/.exec(request.params.wer)?.[1];
    if (!wer) return nichtDa(reply);
    const vorschau = vorschauAus(request.query) !== null;
    if (!fotoFreigegeben(t.team, wer, vorschau)) return nichtDa(reply);
    const jpeg = fotoJpeg(t.team.team_id, wer);
    if (!jpeg) return nichtDa(reply);
    return reply.header('Content-Type', 'image/jpeg').header('Cache-Control', vorschau ? 'private, max-age=3600' : 'public, max-age=3600').header('X-Robots-Tag', 'noindex').send(jpeg);
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/site.css', limit(120), async (request, reply) => {
    if (!freigabeOhneSicht(request.params.teamId)) return nichtDa(reply);
    const css = siteCssText();
    return festeDatei(request, reply, css.text, css.hash, 'text/css; charset=utf-8');
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/sw.js', limit(120), async (request, reply) => {
    if (!freigabeOhneSicht(request.params.teamId)) return nichtDa(reply);
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

  fastify.get<{ Params: { teamId: string } }>('/:teamId/logo-192.png', limit(120), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    const png = await siteLogoPng(t.team, vervollstaendigePalette(readPalette()), 192);
    return reply.header('Content-Type', 'image/png').header('Cache-Control', 'public, max-age=86400').send(png);
  });

  fastify.get<{ Params: { teamId: string; datei: string } }>('/:teamId/fonts/:datei', limit(120), async (request, reply) => {
    if (!freigabeOhneSicht(request.params.teamId)) return nichtDa(reply);
    const pfad = siteFontPath(request.params.datei);
    if (!pfad) return nichtDa(reply);
    return reply.header('Content-Type', 'font/ttf').header('Cache-Control', 'public, max-age=31536000, immutable').send(fs.createReadStream(pfad));
  });

  /** `spiel.png`, `endstand.png?match=…`, `tabelle.png`, `verlauf.png` — mit Spielernamen auch `torjaeger`, `kader`, `saison`. */
  fastify.get<{ Params: { teamId: string; datei: string }; Querystring: { match?: string } }>('/:teamId/bild/:datei', limit(120), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    const art = /^([a-z]+)\.png$/.exec(request.params.datei)?.[1] ?? '';
    if (!istBildArt(art)) return nichtDa(reply);
    const match = typeof request.query.match === 'string' && /^[\w-]{1,64}$/.test(request.query.match) ? request.query.match : null;
    const png = await siteImagePng(t.team, art, art === 'endstand' ? match : null);
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

  /**
   * Anmelden — für eine Mannschaft oder, mit `club`, für den ganzen Verein
   * (nur Heimspiele, plus Wochenvorschau). Subscription samt Vorlauf und
   * Themen eintragen (oder erneuern — der Endpoint ist der Schlüssel, ein
   * Gerät hat also eine Anmeldung) und eine Bestätigung schicken, die die
   * gewählten Themen nennt, damit man sieht, was ankommt.
   */
  async function anmelden(request: { body: unknown; headers: Record<string, unknown> }, reply: FastifyReply, scope: string, team: ReturnType<typeof freigegeben> | null) {
    if (!sitePushConfig().enabled) return reply.code(503).send({ error: 'push_disabled', message: 'Benachrichtigungen sind auf diesem Server nicht eingerichtet.' });
    const parsed = subscribeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', message: 'Die Anmeldung ist unvollständig.' });
    const { subscription, lead, mode, topics } = parsed.data;
    // Eine neue Anmeldung nur, solange Platz ist; wer schon drin ist, darf seine Wahl ändern.
    if (!siteSubscriptionExists(subscription.endpoint) && countSiteSubscribers() >= sitePushMax()) {
      return reply.code(503).header('Retry-After', '3600').send({ error: 'push_full', message: 'Es sind gerade keine weiteren Benachrichtigungen möglich.' });
    }
    const abo: SiteSubscriber = saveSiteSubscription(scope, {
      endpoint: subscription.endpoint, p256dh: subscription.keys.p256dh, auth: subscription.keys.auth,
      lead: istLead(lead) ? lead : '1h', mode: istMode(mode) ? mode : 'all',
      topics: bereinigeThemen(topics, scope === CLUB),
      userAgent: typeof request.headers['user-agent'] === 'string' ? request.headers['user-agent'] : null,
    });
    // Nach bestem Bemühen — die Anmeldung steht, auch wenn die Bestätigung nicht ankommt.
    sendSiteWelcome(abo, team?.team ?? null).catch(err => {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[site] Bestätigung nicht zustellbar');
    });
    return reply.header('Cache-Control', 'no-store').send({ ok: true, lead: abo.lead, mode: abo.mode, topics: abo.topics });
  }

  function abmelden(request: { body: unknown }, reply: FastifyReply) {
    const parsed = unsubscribeSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', message: 'Kein Endpoint angegeben.' });
    const removed = deleteSiteSubscription(parsed.data.endpoint);
    return reply.header('Cache-Control', 'no-store').send({ ok: true, removed });
  }

  /** Die Vereinsanmeldung gibt es, solange die Startseite da ist. */
  function vereinDa(): boolean {
    const sicht = handballOverview();
    const erste = sicht.configured ? sicht.teams[0] : undefined;
    return !!erste && siteConfig(erste.team_id).enabled;
  }

  fastify.get('/push', limit(60), async (_request, reply) => {
    if (!vereinDa()) return nichtDa(reply);
    return reply.header('Cache-Control', 'no-store').send(sitePushConfig());
  });
  fastify.post('/push', limit(20), async (request, reply) => {
    if (!vereinDa()) return nichtDa(reply);
    return anmelden(request, reply, CLUB, null);
  });
  fastify.delete('/push', limit(20), async (request, reply) => {
    if (!vereinDa()) return nichtDa(reply);
    return abmelden(request, reply);
  });

  fastify.get<{ Params: { teamId: string } }>('/:teamId/push', limit(60), async (request, reply) => {
    if (!freigegeben(request.params.teamId)) return nichtDa(reply);
    return reply.header('Cache-Control', 'no-store').send(sitePushConfig());
  });
  fastify.post<{ Params: { teamId: string } }>('/:teamId/push', limit(20), async (request, reply) => {
    const t = freigegeben(request.params.teamId);
    if (!t) return nichtDa(reply);
    return anmelden(request, reply, t.team.team_id, t);
  });
  fastify.delete<{ Params: { teamId: string } }>('/:teamId/push', limit(20), async (request, reply) => {
    if (!freigegeben(request.params.teamId)) return nichtDa(reply);
    return abmelden(request, reply);
  });
}
