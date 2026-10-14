/**
 * Die Einstellungsseite `/settings` — ein Konto aus der Umgebung
 * (`ADMIN_USER`, `ADMIN_PASSWORD`), eine Sitzung im Speicher, ein Cookie.
 *
 * Aus ohne `ADMIN_PASSWORD` (mindestens 12 Zeichen): dann antwortet jede
 * Adresse darunter 404, als gäbe es sie nicht. Mit `ADMIN_PORT` hängt die
 * Seite nur an dem eigenen Anschluss und nicht am öffentlichen.
 *
 * Schutz der schreibenden Aufrufe: JSON (kein einfaches Formular), Cookie
 * `SameSite=Strict`, Origin-Prüfung und ein Token im Kopf `X-CSRF-Token`.
 * Kein Inline-JavaScript: die Seite lädt `settings.js` von hier.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { adminUser, adminPassword, adminPort, publicUrl, siteUrl, sitePreviewToken, botToken, apiToken, configOverride, teamIds } from '../config';
import { EINSTELLUNGEN, GRUPPEN, STATUS_GEHEIMNISSE, findeEinstellung } from '../lib/settingsRegistry';
import { speichere, protokoll, alsEnvBlock, quelleVon, wirksamerText, syncJetzt, type Aenderung } from '../lib/settingsStore';
import { settingsHtml, SETTINGS_JS } from '../lib/settingsPage';
import { getBackoffSnapshot } from '../lib/pollerBackoff';
import { getHandballNetStats } from '../lib/handballNetClient';
import { getHandballHealth } from '../lib/handballTeam';
import { isHandballBotEnabled, getHandballBotUsername, getHandballWebhookState, listSubscribers } from '../lib/handballBot';
import { countSiteSubscribers } from '../lib/handballSitePush';
import { serviceLog } from '../lib/serviceLogger';

const COOKIE = 'hb_admin';
const SITZUNG_MS = 8 * 3_600_000;

interface Sitzung { csrf: string; bis: number }
const sitzungen = new Map<string, Sitzung>();

/** Nur für Tests. */
export function __resetSettingsSessionsForTests(): void { sitzungen.clear(); }

function gleich(a: string, b: string): boolean {
  // Über einen Hash vergleichen, damit weder Länge noch Inhalt durch die Laufzeit verraten werden.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

function cookieWert(request: FastifyRequest): string | null {
  const roh = request.headers.cookie;
  if (typeof roh !== 'string') return null;
  for (const teil of roh.split(';')) {
    const i = teil.indexOf('=');
    if (i > 0 && teil.slice(0, i).trim() === COOKIE) return teil.slice(i + 1).trim();
  }
  return null;
}

function sitzungVon(request: FastifyRequest): { id: string; s: Sitzung } | null {
  const id = cookieWert(request);
  if (!id) return null;
  const s = sitzungen.get(id);
  if (!s) return null;
  if (s.bis < Date.now()) { sitzungen.delete(id); return null; }
  return { id, s };
}

function cookieSetzen(reply: FastifyReply, request: FastifyRequest, wert: string, maxAgeS: number): void {
  const secure = (adminPort() === null && publicUrl().startsWith('https://')) || request.protocol === 'https';
  reply.header('Set-Cookie', `${COOKIE}=${wert}; Path=/settings; HttpOnly; SameSite=Strict; Max-Age=${maxAgeS}${secure ? '; Secure' : ''}`);
}

function sendeNein(reply: FastifyReply, code: number, error: string, message: string) {
  return reply.code(code).header('Cache-Control', 'no-store').send({ error, message });
}

/** Origin (falls gesendet) muss zum Host passen — der Browser sendet ihn bei jedem schreibenden fetch. */
function herkunftPasst(request: FastifyRequest): boolean {
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try { return new URL(origin).host === request.headers.host; } catch { return false; }
}

const limit = (max: number) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

export async function settingsRoutes(fastify: FastifyInstance): Promise<void> {
  // Ohne Konto gibt es die Seite nicht.
  fastify.addHook('onRequest', async (_request, reply) => {
    if (adminPassword() === null) return sendeNein(reply, 404, 'not_found', 'Diese Seite gibt es nicht.');
    reply.header('Cache-Control', 'no-store').header('X-Robots-Tag', 'noindex, nofollow');
  });

  /** Anmeldung und — bei schreibenden Aufrufen — CSRF-Schutz. */
  const geschuetzt = async (request: FastifyRequest, reply: FastifyReply): Promise<Sitzung | null> => {
    const treffer = sitzungVon(request);
    if (!treffer) { await sendeNein(reply, 401, 'unauthorized', 'Bitte anmelden.'); return null; }
    if (request.method !== 'GET') {
      const token = request.headers['x-csrf-token'];
      if (!herkunftPasst(request) || typeof token !== 'string' || !gleich(token, treffer.s.csrf)) {
        await sendeNein(reply, 403, 'csrf', 'Anfrage abgelehnt.');
        return null;
      }
    }
    return treffer.s;
  };

  fastify.get('/settings', limit(60), async (_request, reply) => {
    return reply.header('Content-Type', 'text/html; charset=utf-8').send(settingsHtml());
  });
  fastify.get('/settings/', limit(60), async (_request, reply) => reply.redirect('/settings'));
  fastify.get('/settings/settings.js', limit(60), async (_request, reply) => {
    return reply.header('Content-Type', 'application/javascript; charset=utf-8').send(SETTINGS_JS);
  });

  fastify.post<{ Body: { user?: unknown; password?: unknown } }>('/settings/api/login', limit(5), async (request, reply) => {
    const soll = adminPassword();
    const user = typeof request.body?.user === 'string' ? request.body.user : '';
    const pw = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!herkunftPasst(request)) return sendeNein(reply, 403, 'csrf', 'Anfrage abgelehnt.');
    // Beide Teile immer prüfen (kein früher Abbruch), danach eine kleine Pause gegen Durchprobieren.
    const userOk = gleich(user, adminUser());
    const pwOk = soll !== null && gleich(pw, soll);
    if (!(userOk && pwOk)) {
      await new Promise(r => setTimeout(r, 400));
      serviceLog.warn({ ip: request.ip }, '[settings] Anmeldung fehlgeschlagen');
      return sendeNein(reply, 401, 'unauthorized', 'Name oder Passwort stimmt nicht.');
    }
    const id = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    sitzungen.set(id, { csrf, bis: Date.now() + SITZUNG_MS });
    cookieSetzen(reply, request, id, SITZUNG_MS / 1000);
    serviceLog.info({ ip: request.ip }, '[settings] Angemeldet');
    return reply.send({ ok: true, csrf });
  });

  fastify.post('/settings/api/logout', limit(30), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const id = cookieWert(request);
    if (id) sitzungen.delete(id);
    cookieSetzen(reply, request, '', 0);
    return reply.send({ ok: true });
  });

  fastify.get('/settings/api/state', limit(60), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const snapshot = getBackoffSnapshot('handball', 'team');
    const webhook = getHandballWebhookState();
    return reply.send({
      csrf: s.csrf,
      user: adminUser(),
      eigenerAnschluss: adminPort() !== null,
      vorschau: sitePreviewToken() !== null && teamIds().length > 0,
      gruppen: GRUPPEN,
      felder: EINSTELLUNGEN.map(e => {
        const geheim = e.art === 'geheim';
        const wert = wirksamerText(e.key);
        return {
          key: e.key, gruppe: e.gruppe, art: e.art, label: e.label, hinweis: e.hinweis, standard: e.standard,
          wirkung: e.wirkung, lang: e.lang ?? false, zeilen: e.zeilen ?? null, faktor: e.faktor ?? null, einheit: e.einheit ?? null,
          quelle: quelleVon(e.key),
          umgebungWert: geheim ? null : (process.env[e.key]?.trim() ?? ''),
          // Geheimnisse gehen nie zurück an den Browser, nur ob eines gesetzt ist.
          wert: geheim ? '' : wert,
          gesetzt: wert !== '',
          ueberschrieben: configOverride(e.key) !== undefined,
        };
      }),
      geheimnisse: STATUS_GEHEIMNISSE.map(g => ({
        key: g.key, label: g.label, hinweis: g.hinweis,
        gesetzt: g.key === 'TELEGRAM_BOT_TOKEN' ? botToken() !== null
          : g.key === 'API_TOKEN' ? apiToken() !== null
          : Boolean(process.env.VAPID_PRIVATE_KEY?.trim()) || 'in der Datenbank',
      })),
      status: {
        mannschaften: teamIds().length,
        letzterErfolg: snapshot?.lastSuccessAt ? new Date(snapshot.lastSuccessAt).toISOString() : null,
        fehlerInFolge: snapshot?.consecutiveFailures ?? 0,
        letzterFehler: getHandballHealth().lastError,
        quelle: getHandballNetStats(),
        bot: { an: isHandballBotEnabled(), name: getHandballBotUsername(), abonnenten: isHandballBotEnabled() ? listSubscribers().length : 0, webhook },
        push: countSiteSubscribers(),
      },
      protokoll: protokoll(30),
    });
  });

  fastify.put<{ Body: { aenderungen?: unknown } }>('/settings/api/values', limit(30), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const roh = request.body?.aenderungen;
    if (!Array.isArray(roh) || roh.length === 0 || roh.length > 50) return sendeNein(reply, 400, 'bad_request', 'Keine Änderungen übermittelt.');
    const fehler: Record<string, string> = {};
    const aenderungen: Aenderung[] = [];
    for (const a of roh as { key?: unknown; wert?: unknown }[]) {
      const key = typeof a?.key === 'string' ? a.key : '';
      const e = findeEinstellung(key);
      if (!e) { fehler[key || '?'] = 'Unbekannte Einstellung.'; continue; }
      if (a.wert === null) { aenderungen.push({ key, wert: null }); continue; }
      if (typeof a.wert !== 'string' || a.wert.length > 2000) { fehler[key] = 'Ungültiger Wert.'; continue; }
      const p = e.pruefe(a.wert);
      if (p.ok) aenderungen.push({ key, wert: p.wert }); else fehler[key] = p.fehler;
    }
    // Alles oder nichts: ein Fehler hält alle Änderungen zurück.
    if (Object.keys(fehler).length > 0) return reply.code(422).header('Cache-Control', 'no-store').send({ error: 'invalid', message: 'Bitte die markierten Felder prüfen.', fehler });
    const geaendert = speichere(aenderungen, adminUser());
    serviceLog.info({ keys: geaendert }, '[settings] Gespeichert');
    return reply.send({ ok: true, geaendert });
  });

  fastify.post('/settings/api/sync', limit(6), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    return reply.send({ ok: true, angestossen: syncJetzt() });
  });

  // Die geheime Vorschau: Der Schlüssel geht nie an den Browser der Seite, die
  // Weiterleitung setzt ihn erst hier in die Adresse — nur für Angemeldete.
  fastify.get<{ Querystring: { team?: string } }>('/settings/vorschau', limit(20), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const token = sitePreviewToken();
    const ids = teamIds();
    if (!token || ids.length === 0) return sendeNein(reply, 404, 'not_found', 'Keine Vorschau eingerichtet (Vorschau-Schlüssel und eine Mannschaft nötig).');
    const team = typeof request.query.team === 'string' && ids.includes(request.query.team) ? request.query.team : ids[0];
    const basis = siteUrl() ?? publicUrl();
    return reply.header('Cache-Control', 'no-store').redirect(`${basis}/${team}/?vorab=${encodeURIComponent(token)}`);
  });

  fastify.get('/settings/api/export', limit(20), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    return reply.header('Content-Type', 'text/plain; charset=utf-8').header('Content-Disposition', 'attachment; filename="handballteck.env"').send(alsEnvBlock());
  });

}
