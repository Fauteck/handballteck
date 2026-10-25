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
 *
 * Eine Sitzung endet nach 8 Stunden oder nach einer Stunde ohne Zutun. Was
 * die Seite im Hintergrund nachlädt (Kopf `X-Hintergrund: 1`), verlängert sie
 * nicht.
 */
import crypto from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import qrcode from 'qrcode-generator';
import { adminUser, adminPassword, adminPort, publicUrl, siteUrl, sitePreviewToken, botToken, apiToken, configOverride, teamIds } from '../config';
import { EINSTELLUNGEN, GRUPPEN, STATUS_GEHEIMNISSE, findeEinstellung } from '../lib/settingsRegistry';
import { speichere, protokoll, protokollAnzahl, alsEnvBlock, quelleVon, wirksamerText, syncJetzt, type Aenderung } from '../lib/settingsStore';
import { settingsHtml, SETTINGS_JS, SETTINGS_SW } from '../lib/settingsPage';
import { getBackoffSnapshot } from '../lib/pollerBackoff';
import { getHandballNetStats, fetchActiveSeason, fetchTeamMatches, HandballEmptyError } from '../lib/handballNetClient';
import { getHandballHealth } from '../lib/handballTeam';
import { automatischeBereiche, HANDBALL_GROUPS } from '../lib/handballSicht';
import { isHandballBotEnabled, getHandballBotUsername, getHandballWebhookState, listSubscribers, handballBotLink, adminChatIds } from '../lib/handballBotBasis';
import { sendMessage } from '../lib/telegramClient';
import { countSiteSubscribers } from '../lib/handballSitePush';
import { getVapidPublicKey, sendPush, SETTING_PRIVATE_KEY } from '../lib/webPush';
import { getSetting } from '../lib/settings';
import { serviceLog } from '../lib/serviceLogger';

const COOKIE = 'hb_admin';
const SITZUNG_MS = 8 * 3_600_000;
const LEERLAUF_MS = 3_600_000;

interface Sitzung { csrf: string; bis: number; leerlaufBis: number }
const sitzungen = new Map<string, Sitzung>();
let zuletztAufgeraeumt = 0;

/** Nur für Tests. */
export function __resetSettingsSessionsForTests(): void { sitzungen.clear(); zuletztAufgeraeumt = 0; fehlversuche = []; gesperrtBis = 0; }

/**
 * SEC-3-005: Das Limit je Adresse (5/min) hält einen Angreifer mit vielen
 * Adressen nicht auf. Nach 20 Fehlversuchen in 10 Minuten — gleich von wo —
 * nimmt die Anmeldung 15 Minuten lang nichts an, auch das richtige Passwort
 * nicht. Das kann den Betreiber aussperren; in Betrieb hängt die Seite aber
 * nur im LAN (`ADMIN_PORT`), und 15 Minuten Warten ist der kleinere Schaden.
 */
const SPERRE_NACH = 20;
const SPERRE_FENSTER_MS = 10 * 60 * 1000;
const SPERRE_MS = 15 * 60 * 1000;
let fehlversuche: number[] = [];
let gesperrtBis = 0;

function fehlversuchMerken(jetzt: number): void {
  fehlversuche = fehlversuche.filter(t => jetzt - t < SPERRE_FENSTER_MS);
  fehlversuche.push(jetzt);
  if (fehlversuche.length >= SPERRE_NACH) {
    gesperrtBis = jetzt + SPERRE_MS;
    fehlversuche = [];
    serviceLog.warn({ minuten: SPERRE_MS / 60_000 }, '[settings] Zu viele Fehlversuche — Anmeldung gesperrt');
  }
}

/** Nur für Tests: die Uhr einer Sitzung vorstellen. */
export function __alterSitzungenForTests(ms: number): void {
  for (const s of sitzungen.values()) { s.bis -= ms; s.leerlaufBis -= ms; }
}

/** Nur für Tests. */
export function __anzahlSitzungenForTests(): number { return sitzungen.size; }

/** Abgelaufene Sitzungen höchstens einmal je Minute wegräumen, damit die Map nicht wächst. */
function aufraeumen(now = Date.now()): void {
  if (now - zuletztAufgeraeumt < 60_000) return;
  zuletztAufgeraeumt = now;
  for (const [id, s] of sitzungen) if (s.bis < now || s.leerlaufBis < now) sitzungen.delete(id);
}

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
  const now = Date.now();
  aufraeumen(now);
  const id = cookieWert(request);
  if (!id) return null;
  const s = sitzungen.get(id);
  if (!s) return null;
  if (s.bis < now || s.leerlaufBis < now) { sitzungen.delete(id); return null; }
  if (request.headers['x-hintergrund'] !== '1') s.leerlaufBis = Math.min(s.bis, now + LEERLAUF_MS);
  return { id, s };
}

/** Woher der VAPID-Schlüssel kommt — die Umgebung gewinnt, sonst der selbst erzeugte in der Datenbank. */
function vapidHerkunft(): string | null {
  if (process.env.VAPID_PUBLIC_KEY?.trim() && process.env.VAPID_PRIVATE_KEY?.trim()) return 'aus der Umgebung';
  try { return getSetting(SETTING_PRIVATE_KEY) ? 'selbst erzeugt, in der Datenbank' : null; } catch { return null; }
}

interface TeamAuskunft { ok: boolean; name?: string; liga?: string; klasse?: string | null; message?: string }
const teamCache = new Map<string, { bis: number; antwort: TeamAuskunft }>();

/** Nur für Tests. */
export function __resetTeamCacheForTests(): void { teamCache.clear(); }

/**
 * Name und Liga einer Team-ID von handball.net — für die Mannschaftszeile, damit
 * ein Tippfehler auffällt, bevor er gespeichert ist. Eine Stunde zwischengespeichert,
 * damit Tippen keine Abrufserie auslöst.
 */
async function teamAuskunft(id: string): Promise<TeamAuskunft> {
  const treffer = teamCache.get(id);
  if (treffer && treffer.bis > Date.now()) return treffer.antwort;
  let antwort: TeamAuskunft;
  try {
    const saison = await fetchActiveSeason();
    const spiele = await fetchTeamMatches(id, saison.id);
    const s = spiele[0];
    const name = s.homeId === id ? s.homeName : s.awayId === id ? s.awayName : '';
    antwort = { ok: true, name, liga: s.competitionName, klasse: s.championshipName };
  } catch (err) {
    if (!(err instanceof HandballEmptyError)) throw err;
    antwort = { ok: false, message: 'Keine Spiele in der laufenden Saison — Team-ID prüfen.' };
  }
  teamCache.set(id, { bis: Date.now() + (antwort.ok ? 3_600_000 : 600_000), antwort });
  if (teamCache.size > 500) teamCache.delete(teamCache.keys().next().value as string);
  return antwort;
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
const PROTOKOLL_SEITE = 30;

/** Prüft die übermittelten Änderungen wie beim Speichern; gemeinsam für Speichern und Live-Prüfung. */
function pruefeAenderungen(roh: unknown): { aenderungen: Aenderung[]; fehler: Record<string, string> } | null {
  if (!Array.isArray(roh) || roh.length === 0 || roh.length > 50) return null;
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
  return { aenderungen, fehler };
}

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
  // Nur für den Test-Push an diesen Browser: zeigt eine Nachricht, sonst nichts.
  fastify.get('/settings/sw.js', limit(60), async (_request, reply) => {
    return reply.header('Content-Type', 'application/javascript; charset=utf-8').send(SETTINGS_SW);
  });

  fastify.post<{ Body: { user?: unknown; password?: unknown } }>('/settings/api/login', limit(5), async (request, reply) => {
    const soll = adminPassword();
    const user = typeof request.body?.user === 'string' ? request.body.user : '';
    const pw = typeof request.body?.password === 'string' ? request.body.password : '';
    if (!herkunftPasst(request)) return sendeNein(reply, 403, 'csrf', 'Anfrage abgelehnt.');
    if (Date.now() < gesperrtBis) return sendeNein(reply, 429, 'locked', 'Zu viele Fehlversuche — die Anmeldung ist für eine Viertelstunde gesperrt.');
    // Beide Teile immer prüfen (kein früher Abbruch), danach eine kleine Pause gegen Durchprobieren.
    const userOk = gleich(user, adminUser());
    const pwOk = soll !== null && gleich(pw, soll);
    if (!(userOk && pwOk)) {
      fehlversuchMerken(Date.now());
      await new Promise(r => setTimeout(r, 400));
      serviceLog.warn({ ip: request.ip }, '[settings] Anmeldung fehlgeschlagen');
      return sendeNein(reply, 401, 'unauthorized', 'Name oder Passwort stimmt nicht.');
    }
    const id = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(24).toString('base64url');
    const jetzt = Date.now();
    sitzungen.set(id, { csrf, bis: jetzt + SITZUNG_MS, leerlaufBis: jetzt + LEERLAUF_MS });
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

  fastify.post('/settings/api/logout-all', limit(10), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const anzahl = sitzungen.size;
    sitzungen.clear();
    cookieSetzen(reply, request, '', 0);
    serviceLog.info({ anzahl }, '[settings] Überall abgemeldet');
    return reply.send({ ok: true, anzahl });
  });

  fastify.get('/settings/api/state', limit(60), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const snapshot = getBackoffSnapshot('handball', 'team');
    const webhook = getHandballWebhookState();
    return reply.send({
      csrf: s.csrf,
      user: adminUser(),
      sitzung: { bis: new Date(s.bis).toISOString(), leerlaufBis: new Date(s.leerlaufBis).toISOString(), leerlaufMin: LEERLAUF_MS / 60_000 },
      teams: teamIds(),
      eigenerAnschluss: adminPort() !== null,
      vorschau: sitePreviewToken() !== null && teamIds().length > 0,
      gruppen: GRUPPEN,
      // Für die Mannschaftszeilen: die Bereiche der Seite und je Mannschaft der automatisch gelesene.
      bereiche: HANDBALL_GROUPS,
      bereichAutomatisch: automatischeBereiche(),
      felder: EINSTELLUNGEN.map(e => {
        const geheim = e.art === 'geheim';
        const wert = wirksamerText(e.key);
        return {
          key: e.key, gruppe: e.gruppe, art: e.art, label: e.label, hinweis: e.hinweis, standard: e.standard,
          wirkung: e.wirkung, lang: e.lang ?? false, zeilen: e.zeilen ?? null, versteckt: e.versteckt ?? false, faktor: e.faktor ?? null, einheit: e.einheit ?? null,
          min: e.min ?? null, max: e.max ?? null, nullErlaubt: e.nullErlaubt ?? false,
          quelle: quelleVon(e.key),
          umgebungWert: geheim ? null : (process.env[e.key]?.trim() ?? ''),
          // Geheimnisse gehen nie zurück an den Browser, nur ob eines gesetzt ist.
          wert: geheim ? '' : wert,
          gesetzt: wert !== '',
          ueberschrieben: configOverride(e.key) !== undefined,
        };
      }),
      geheimnisse: STATUS_GEHEIMNISSE.map(g => {
        const herkunft = g.key === 'TELEGRAM_BOT_TOKEN' ? (botToken() !== null ? 'aus der Umgebung' : null)
          : g.key === 'API_TOKEN' ? (apiToken() !== null ? 'aus der Umgebung' : null)
          : vapidHerkunft();
        return { key: g.key, label: g.label, hinweis: g.hinweis, gesetzt: herkunft !== null, herkunft };
      }),
      status: {
        mannschaften: teamIds().length,
        letzterErfolg: snapshot?.lastSuccessAt ? new Date(snapshot.lastSuccessAt).toISOString() : null,
        fehlerInFolge: snapshot?.consecutiveFailures ?? 0,
        letzterFehler: getHandballHealth().lastError,
        quelle: getHandballNetStats(),
        bot: { an: isHandballBotEnabled(), name: getHandballBotUsername(), abonnenten: isHandballBotEnabled() ? listSubscribers().length : 0, webhook, link: handballBotLink() },
        push: countSiteSubscribers(),
      },
      // Zur Auswahl der Admin-Chats: wer den Bot abonniert hat.
      chats: isHandballBotEnabled() ? listSubscribers().map(a => ({ id: a.chatId, name: a.name })) : [],
      vapidKey: getVapidPublicKey(),
      protokoll: protokoll(PROTOKOLL_SEITE),
      protokollAnzahl: protokollAnzahl(),
    });
  });

  fastify.put<{ Body: { aenderungen?: unknown } }>('/settings/api/values', limit(30), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const geprueft = pruefeAenderungen(request.body?.aenderungen);
    if (!geprueft) return sendeNein(reply, 400, 'bad_request', 'Keine Änderungen übermittelt.');
    const { aenderungen, fehler } = geprueft;
    // Alles oder nichts: ein Fehler hält alle Änderungen zurück.
    if (Object.keys(fehler).length > 0) return reply.code(422).header('Cache-Control', 'no-store').send({ error: 'invalid', message: 'Bitte die markierten Felder prüfen.', fehler });
    const geaendert = speichere(aenderungen, adminUser());
    serviceLog.info({ keys: geaendert }, '[settings] Gespeichert');
    return reply.send({ ok: true, geaendert });
  });

  // Live-Prüfung beim Tippen: dieselben Prüfer wie beim Speichern, gespeichert wird nichts.
  fastify.post<{ Body: { aenderungen?: unknown } }>('/settings/api/check', limit(120), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const geprueft = pruefeAenderungen(request.body?.aenderungen);
    if (!geprueft) return sendeNein(reply, 400, 'bad_request', 'Keine Änderungen übermittelt.');
    return reply.send({ ok: Object.keys(geprueft.fehler).length === 0, fehler: geprueft.fehler });
  });

  fastify.get<{ Querystring: { key?: string; offset?: string } }>('/settings/api/protokoll', limit(60), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const key = typeof request.query.key === 'string' && findeEinstellung(request.query.key) ? request.query.key : undefined;
    const offset = Math.min(Math.max(Number.parseInt(String(request.query.offset ?? '0'), 10) || 0, 0), 100_000);
    return reply.send({ zeilen: protokoll(PROTOKOLL_SEITE, offset, key), anzahl: protokollAnzahl(key), offset, seite: PROTOKOLL_SEITE });
  });

  // Name und Liga einer Team-ID — eine Anfrage an handball.net je ID und Stunde (siehe teamAuskunft).
  fastify.get<{ Params: { id: string } }>('/settings/api/team/:id', limit(20), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const id = request.params.id;
    if (!/^\d{1,12}$/.test(id)) return sendeNein(reply, 400, 'bad_request', 'Die Team-ID besteht nur aus Ziffern.');
    try {
      return reply.send(await teamAuskunft(id));
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[settings] Team-Auskunft gescheitert');
      return sendeNein(reply, 502, 'upstream', 'handball.net ist gerade nicht erreichbar.');
    }
  });

  // Der Einladungslink des Bots als QR-Code — zum Ausdrucken für die Halle.
  fastify.get('/settings/api/qr.svg', limit(30), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const link = handballBotLink();
    if (!link) return sendeNein(reply, 404, 'not_found', 'Der Bot ist nicht angemeldet.');
    const qr = qrcode(0, 'M');
    qr.addData(link);
    qr.make();
    return reply.header('Content-Type', 'image/svg+xml; charset=utf-8').send(qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true }));
  });

  fastify.post('/settings/api/test/telegram', limit(6), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const token = botToken();
    if (!token) return sendeNein(reply, 409, 'no_bot', 'Kein Bot-Token gesetzt.');
    const chats = [...adminChatIds()];
    if (chats.length === 0) return sendeNein(reply, 409, 'no_admin', 'Keine Admin-Chats eingetragen (und gespeichert).');
    let ok = 0;
    const fehler: string[] = [];
    for (const chatId of chats) {
      try {
        await sendMessage(token, { chatId, text: '✅ Testnachricht von der Einstellungsseite: Token und Admin-Chat funktionieren.', parseMode: null });
        ok++;
      } catch (err) {
        fehler.push(`${chatId}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    serviceLog.info({ ok, fehler: fehler.length }, '[settings] Testnachricht verschickt');
    return reply.send({ ok, fehler });
  });

  fastify.post<{ Body: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } }>('/settings/api/test/push', limit(6), async (request, reply) => {
    const s = await geschuetzt(request, reply);
    if (!s) return reply;
    const endpoint = request.body?.endpoint;
    const p256dh = request.body?.keys?.p256dh;
    const auth = request.body?.keys?.auth;
    if (typeof endpoint !== 'string' || endpoint.length > 1000 || typeof p256dh !== 'string' || p256dh.length > 200 || typeof auth !== 'string' || auth.length > 200) {
      return sendeNein(reply, 400, 'bad_request', 'Ungültige Anmeldung des Browsers.');
    }
    // Nur an diesen Browser; gespeichert wird die Anmeldung nicht.
    const r = await sendPush({ endpoint, p256dh, auth }, { title: 'Handballteck', body: 'Test-Push von der Einstellungsseite: Web-Push funktioniert.', tag: 'settings-test' });
    if (r.status === 'sent') return reply.send({ ok: true });
    return sendeNein(reply, 502, 'push_failed', `Push nicht zugestellt (${r.reason}).`);
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
