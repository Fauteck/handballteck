/**
 * Web-Push von der Handball-Microsite (Wiki „Handball-Verfolgung (handball.net)“ §7): der
 * zweite Weg ohne Todoteck-Konto und ohne Telegram. Wer auf der Seite die
 * Glocke drückt, hinterlässt eine Browser-Subscription — keinen Namen, kein
 * Konto, nur einen Endpoint beim Push-Dienst seines Browsers. Der Versand
 * läuft über dieselben VAPID-Schlüssel wie die Todoteck-App (`lib/webPush.ts`).
 *
 * **Dieselben Anlässe und Texte wie der Bot**, aus derselben Datenbank-Sicht,
 * im selben Takt des Jobs: Ankündigung (Vorlauf je Abonnent), Halbzeitstand
 * (sobald der Bot ihn aus der Torfolge gelesen hat), Endstand mit der Karte
 * als Bild, Verlegungen und Absagen. Nicht dabei: Aufstellung, Spielbericht
 * und Saisonkarte — die nennen Spielernamen oder sind zu lang für eine
 * Systembenachrichtigung; die Seite zeigt sie, wenn der Schalter es erlaubt.
 *
 * **Kein Aufruf nach draußen.** Der Gegner-Steckbrief der Ankündigung kommt
 * ohne „Zuletzt" — dafür holt der Bot den Spielplan des Gegners, hier nicht.
 *
 * Die Merker liegen in derselben Tabelle wie die des Bots
 * (`handball_bot_sent`) mit dem Präfix `site:`, damit ein Endstand, den der
 * Bot schon gemeldet hat, hier trotzdem einmal rausgeht — es sind
 * verschiedene Empfänger.
 */

import { eq, sql } from 'drizzle-orm';
import { db } from '../db';
import { handball_site_subscription, handball_bot_sent } from '../db/schema';
import { sendPush as sendWebPush, isPushConfigured, getVapidPublicKey, type PushPayload, type PushResult, type PushTarget } from './webPush';
import { handballOverview, changesFor, type HandballTeamView, type HandballMatchView } from './handballTeam';
import {
  textAnkuendigung, textEndstand, textAenderung, textHalbzeit, alsKlartext, ankuendigungFaelligAb, tabellenBewegung,
  LEADS, type Lead, type Mode,
} from './handballBot';
import { siteConfig } from './handballSite';
import { serviceLog } from './serviceLogger';

/** Ein Endstand, der älter ist, wird nur gemerkt — beim ersten Lauf nicht die ganze Saison nachliefern. */
const RESULT_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** Eine Wertung kommt Tage später. */
const RATED_MAX_AGE_MS = 14 * 24 * 60 * 60 * 1000;
/** Eine Verlegung, die länger her ist, ist Buchhaltung der Quelle. */
const CHANGE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** Halbzeitstand: ab 20 Minuten nach Anwurf bis 90 danach — was danach kommt, ist der Endstand. */
const HALFTIME_FROM_MS = 20 * 60 * 1000;
const HALFTIME_UNTIL_MS = 90 * 60 * 1000;
/** Nach so vielen vorübergehenden Fehlschlägen in Folge gilt eine Subscription als verwaist. */
const MAX_FAILURES = 12;

export const SITE_MODES = ['all', 'results'] as const;

export function istLead(v: unknown): v is Lead {
  return typeof v === 'string' && (LEADS as readonly string[]).includes(v);
}
export function istMode(v: unknown): v is Mode {
  return typeof v === 'string' && (SITE_MODES as readonly string[]).includes(v);
}

// ---------------------------------------------------------------------------
// Abonnenten
// ---------------------------------------------------------------------------

export interface SiteSubscriber {
  id: number;
  team_id: string;
  endpoint: string;
  p256dh: string;
  auth: string;
  lead: Lead;
  mode: Mode;
}

function alsAbonnent(r: typeof handball_site_subscription.$inferSelect): SiteSubscriber {
  return {
    id: r.id, team_id: r.team_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth,
    lead: istLead(r.lead) ? r.lead : '1h',
    mode: istMode(r.mode) ? r.mode : 'all',
  };
}

export function listSiteSubscribers(teamId: string): SiteSubscriber[] {
  return db.select().from(handball_site_subscription).where(eq(handball_site_subscription.team_id, teamId)).all().map(alsAbonnent);
}

export function countSiteSubscribers(teamId?: string): number {
  const rows = teamId
    ? db.select({ n: sql<number>`count(*)` }).from(handball_site_subscription).where(eq(handball_site_subscription.team_id, teamId)).get()
    : db.select({ n: sql<number>`count(*)` }).from(handball_site_subscription).get();
  return Number(rows?.n ?? 0);
}

export interface SiteSubscriptionInput {
  endpoint: string;
  p256dh: string;
  auth: string;
  lead: Lead;
  mode: Mode;
  userAgent?: string | null;
}

/**
 * Eine Subscription eintragen oder erneuern. Der Endpoint ist der Schlüssel:
 * Wer die Glocke ein zweites Mal drückt oder seinen Vorlauf ändert, bekommt
 * dieselbe Zeile mit neuen Werten, keine zweite.
 */
export function saveSiteSubscription(teamId: string, input: SiteSubscriptionInput): SiteSubscriber {
  const now = new Date().toISOString();
  db.insert(handball_site_subscription).values({
    team_id: teamId, endpoint: input.endpoint, p256dh: input.p256dh, auth: input.auth,
    lead: input.lead, mode: input.mode, user_agent: input.userAgent?.slice(0, 200) ?? null,
    failures: 0, created_at: now, last_seen_at: now,
  }).onConflictDoUpdate({
    target: handball_site_subscription.endpoint,
    set: {
      team_id: teamId, p256dh: input.p256dh, auth: input.auth, lead: input.lead, mode: input.mode,
      user_agent: input.userAgent?.slice(0, 200) ?? null, failures: 0, last_seen_at: now,
    },
  }).run();
  const row = db.select().from(handball_site_subscription).where(eq(handball_site_subscription.endpoint, input.endpoint)).get()!;
  return alsAbonnent(row);
}

export function siteSubscriptionExists(endpoint: string): boolean {
  return !!db.select({ id: handball_site_subscription.id }).from(handball_site_subscription).where(eq(handball_site_subscription.endpoint, endpoint)).get();
}

export function deleteSiteSubscription(endpoint: string): number {
  return db.delete(handball_site_subscription).where(eq(handball_site_subscription.endpoint, endpoint)).run().changes;
}

/** Nur für Tests: alle Merker der Seite vergessen. */
export function resetSiteSent(): void {
  db.delete(handball_bot_sent).where(sql`${handball_bot_sent.id} LIKE 'site:%'`).run();
}

// ---------------------------------------------------------------------------
// Versand
// ---------------------------------------------------------------------------

export interface SitePushDeps {
  send: (target: PushTarget, payload: PushPayload) => Promise<PushResult>;
}

const DEFAULT_DEPS: SitePushDeps = { send: sendWebPush };

export interface SitePushPayload extends PushPayload {
  /** Ein neuer Stand desselben Spiels darf erneut klingeln (Halbzeit → Endstand teilen sich den Tag). */
  renotify?: boolean;
}

/** Aus einem Bot-Text (Telegram-HTML) Titel und Text für die Systembenachrichtigung. */
export function alsPush(html: string, extras: Partial<SitePushPayload> = {}): SitePushPayload {
  const zeilen = alsKlartext(html);
  const [erste = 'Handball', ...rest] = zeilen;
  // Der Gegner-Steckbrief der Ankündigung beginnt nach einer Leerzeile — für den Push zu lang.
  const body = rest.slice(0, 4).join('\n');
  return { title: erste.replace(/\s+—\s*$/, ''), body, ...extras };
}

function schonGeschickt(id: string): boolean {
  return !!db.select().from(handball_bot_sent).where(eq(handball_bot_sent.id, `site:${id}`)).get();
}

function merke(id: string): void {
  db.insert(handball_bot_sent).values({ id: `site:${id}`, sent_at: new Date().toISOString() }).onConflictDoNothing().run();
}

/**
 * An einen Abonnenten — und die Zeile nach dem Ergebnis pflegen: gelungen
 * heißt Zähler zurück, tot heißt löschen, vorübergehend heißt zählen.
 */
async function zustellen(abo: SiteSubscriber, payload: SitePushPayload, deps: SitePushDeps): Promise<boolean> {
  const result = await deps.send({ endpoint: abo.endpoint, p256dh: abo.p256dh, auth: abo.auth }, payload);
  const now = new Date().toISOString();
  if (result.status === 'sent') {
    db.update(handball_site_subscription).set({ failures: 0, last_sent_at: now }).where(eq(handball_site_subscription.id, abo.id)).run();
    return true;
  }
  if (result.status === 'gone') {
    db.delete(handball_site_subscription).where(eq(handball_site_subscription.id, abo.id)).run();
    serviceLog.info({ reason: result.reason }, '[handball-site] Push-Abonnent abgelaufen — Zeile entfernt');
    return false;
  }
  const row = db.select({ failures: handball_site_subscription.failures }).from(handball_site_subscription).where(eq(handball_site_subscription.id, abo.id)).get();
  const failures = (row?.failures ?? 0) + 1;
  if (failures >= MAX_FAILURES) {
    db.delete(handball_site_subscription).where(eq(handball_site_subscription.id, abo.id)).run();
    serviceLog.warn({ reason: result.reason, failures }, '[handball-site] Push-Abonnent nach wiederholten Fehlschlägen entfernt');
  } else {
    db.update(handball_site_subscription).set({ failures }).where(eq(handball_site_subscription.id, abo.id)).run();
  }
  return false;
}

async function anAlle(abos: SiteSubscriber[], payload: SitePushPayload, deps: SitePushDeps): Promise<number> {
  let n = 0;
  for (const abo of abos) {
    try {
      if (await zustellen(abo, payload, deps)) n++;
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-site] Push fehlgeschlagen');
    }
  }
  return n;
}

/** Nach dem Einschalten eine Bestätigung — damit man sieht, dass es ankommt. */
export async function sendSiteWelcome(abo: SiteSubscriber, team: HandballTeamView, deps: SitePushDeps = DEFAULT_DEPS): Promise<boolean> {
  const was = abo.mode === 'results' ? 'Endstände und Verlegungen' : 'Ankündigungen, Halbzeit, Endstände und Verlegungen';
  return zustellen(abo, {
    title: `${team.name}: Benachrichtigungen an`,
    body: `Du bekommst ab jetzt ${was} auf diesem Gerät.`,
    tag: 'handball-welcome',
    url: './',
  }, deps);
}

export interface SitePushResult {
  /** Verschiedene Meldungen (ein Endstand an fünf Browser zählt einmal). */
  messages: number;
  /** Zustellungen insgesamt. */
  recipients: number;
}

/**
 * Was der Abruf Neues gebracht hat, an die Browser-Abonnenten der Microsite —
 * je Mannschaft, je Spiel, je Meldungsart einmal. Läuft im Takt des Jobs
 * nach `syncHandballTeams`, wie `pushHandballBot`. Ohne Abonnenten, ohne
 * VAPID oder mit ausgeschalteter Microsite ein reiner Datenbankblick.
 */
export async function pushHandballSite(now = new Date(), deps: SitePushDeps = DEFAULT_DEPS): Promise<SitePushResult> {
  const out: SitePushResult = { messages: 0, recipients: 0 };
  if (deps === DEFAULT_DEPS && !isPushConfigured()) return out;
  if (countSiteSubscribers() === 0) return out;
  const sicht = handballOverview();
  if (!sicht.configured) return out;
  const jetzt = now.getTime();

  for (const team of sicht.teams) {
    // Eine abgeschaltete Seite schickt auch nichts mehr: Die Glocke war ihr einziger Eingang.
    if (!siteConfig(team.team_id).enabled) continue;
    const abos = listSiteSubscribers(team.team_id);
    if (abos.length === 0) continue;
    const alle = abos;
    const nurAlles = abos.filter(a => a.mode === 'all');
    const schluessel = (m: HandballMatchView, art: string) => `${team.team_id}:${m.match_id}:${art}`;

    // --- Verlegungen und Absagen ---
    for (const c of changesFor(team.team_id)) {
      const key = `${team.team_id}:${c.match_id}:change:${c.change_id}`;
      if (schonGeschickt(key)) continue;
      merke(key);
      if (jetzt - Date.parse(c.detected_at) > CHANGE_MAX_AGE_MS) continue;
      const m = team.matches.find(x => x.match_id === c.match_id);
      if (!m) continue;
      const n = await anAlle(alle, alsPush(textAenderung(team, m, c), { tag: `handball-${m.match_id}`, renotify: true, url: './' }), deps);
      out.messages++; out.recipients += n;
    }

    for (const m of team.matches) {
      const start = Date.parse(m.starts_at);

      // --- Ankündigung — je Abonnent zu seiner Zeit ---
      if (m.status === 'scheduled' && start > jetzt) {
        let payload: SitePushPayload | null = null;
        let n = 0;
        for (const abo of nurAlles) {
          const ab = ankuendigungFaelligAb(m.starts_at, abo.lead);
          if (ab === null || jetzt < ab) continue;
          const key = schluessel(m, `upcoming:${abo.id}`);
          if (schonGeschickt(key)) continue;
          merke(key);
          payload ??= alsPush(textAnkuendigung(team, m, now, null), { tag: `handball-${m.match_id}`, url: './', image: 'bild/spiel.png' });
          try {
            if (await zustellen(abo, payload, deps)) n++;
          } catch (err) {
            serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-site] Ankündigung nicht zustellbar');
          }
        }
        if (n > 0) { out.messages++; out.recipients += n; }
      }

      // --- Halbzeit — wenn der Bot sie aus der Torfolge gelesen hat ---
      const imHalbzeitFenster = jetzt - start >= HALFTIME_FROM_MS && jetzt - start <= HALFTIME_UNTIL_MS;
      if ((m.status === 'scheduled' || m.status === 'live') && imHalbzeitFenster && m.halftime_home !== null && m.halftime_away !== null && !schonGeschickt(schluessel(m, 'halftime'))) {
        merke(schluessel(m, 'halftime'));
        const n = await anAlle(nurAlles, alsPush(textHalbzeit(team, m, { home: m.halftime_home, away: m.halftime_away }), { tag: `handball-${m.match_id}`, renotify: true, url: './' }), deps);
        out.messages++; out.recipients += n;
      } else if (jetzt - start > HALFTIME_UNTIL_MS && !schonGeschickt(schluessel(m, 'halftime'))) {
        merke(schluessel(m, 'halftime'));
      }

      // --- Endstand ---
      const mitStand = m.score_home !== null && m.score_away !== null;
      if (((m.status === 'finished' && mitStand) || m.rated) && !schonGeschickt(schluessel(m, 'result'))) {
        merke(schluessel(m, 'result'));
        if (jetzt - start > (m.rated ? RATED_MAX_AGE_MS : RESULT_MAX_AGE_MS)) continue;
        const text = textEndstand(team, m, null, () => null, { bewegung: tabellenBewegung(team) });
        const payload = alsPush(text, {
          tag: `handball-${m.match_id}`, renotify: true, url: './',
          // Ein Sieg vibriert wie ein Torjubel, eine Niederlage einmal lang.
          vibrate: m.won === true ? [200, 100, 200, 100, 400] : m.won === false ? [400] : [150, 80, 150],
          image: mitStand ? `bild/endstand.png?match=${encodeURIComponent(m.match_id)}` : undefined,
        });
        const n = await anAlle(alle, payload, deps);
        out.messages++; out.recipients += n;
      }
    }
  }
  return out;
}

/** Was die Seite zum Anmelden braucht — der öffentliche VAPID-Schlüssel, oder dass es keinen gibt. */
export function sitePushConfig(): { enabled: boolean; public_key: string | null } {
  const key = getVapidPublicKey();
  return { enabled: key !== null, public_key: key };
}
