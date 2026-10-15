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
 * **Themen statt Modus.** Wer sich anmeldet, wählt einzeln, was er bekommt
 * (`TOPICS`): Ankündigung, Halbzeit, Endstand, Verlegungen und — nur bei der
 * Vereinsanmeldung — die Wochenvorschau am Donnerstag. Die Anmeldung auf der
 * Startseite gilt dem Verein (`team_id = '*'`) und betrifft nur Heimspiele
 * aller Mannschaften. Ohne Themenliste (alte Zeilen) gilt der Modus.
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
import { handballOverview, changesFor, vereinsName, type HandballTeamView, type HandballMatchView } from './handballTeam';
import {
  textAnkuendigung, textEndstand, textAenderung, textHalbzeit, alsKlartext, ankuendigungFaelligAb, tabellenBewegung,
  LEADS, type Lead, type Mode,
} from './handballBot';
import { siteConfig, naechstesWochenende } from './handballSite';
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

/** Was man abonnieren kann. `preview` gibt es nur für die Vereinsanmeldung. */
export const TOPICS = ['upcoming', 'halftime', 'result', 'change', 'preview'] as const;
export type Topic = typeof TOPICS[number];
/** Die Anmeldung für den ganzen Verein — nur Heimspiele. */
export const CLUB = '*';

export function istTopic(v: unknown): v is Topic {
  return typeof v === 'string' && (TOPICS as readonly string[]).includes(v);
}

/** Aus dem alten Modus die Themen, die er bedeutete. */
export function themenAusModus(mode: Mode): Topic[] {
  return mode === 'results' ? ['result', 'change'] : ['upcoming', 'halftime', 'result', 'change'];
}

/** Eine Themenliste aus der Anfrage: nur bekannte Themen, ohne Doppelte; `preview` nur im Verein. */
export function bereinigeThemen(v: unknown, club: boolean): Topic[] | null {
  if (!Array.isArray(v)) return null;
  const out = [...new Set(v.filter(istTopic))].filter(t => club || t !== 'preview');
  return out;
}

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
  topics: Topic[];
}

function alsAbonnent(r: typeof handball_site_subscription.$inferSelect): SiteSubscriber {
  return {
    id: r.id, team_id: r.team_id, endpoint: r.endpoint, p256dh: r.p256dh, auth: r.auth,
    lead: istLead(r.lead) ? r.lead : '1h',
    mode: istMode(r.mode) ? r.mode : 'all',
    topics: r.topics !== null
      ? r.topics.split(',').filter(istTopic)
      : themenAusModus(istMode(r.mode) ? r.mode : 'all'),
  };
}

export function listSiteSubscribers(teamId: string): SiteSubscriber[] {
  return db.select().from(handball_site_subscription).where(eq(handball_site_subscription.team_id, teamId)).all().map(alsAbonnent);
}

export function listClubSubscribers(): SiteSubscriber[] {
  return listSiteSubscribers(CLUB);
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
  /** Gewählte Themen; ohne Angabe gilt der Modus. */
  topics?: Topic[] | null;
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
    lead: input.lead, mode: input.mode, topics: input.topics ? input.topics.join(',') : null,
    user_agent: input.userAgent?.slice(0, 200) ?? null,
    failures: 0, created_at: now, last_seen_at: now,
  }).onConflictDoUpdate({
    target: handball_site_subscription.endpoint,
    set: {
      team_id: teamId, p256dh: input.p256dh, auth: input.auth, lead: input.lead, mode: input.mode,
      topics: input.topics ? input.topics.join(',') : null,
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

/** Der Push für eine Anmeldung: mit der Vereinsanmeldung (Worker an der Wurzel) liegen Ziel und Bild eine Ebene tiefer. */
type PushBau = (club: boolean) => SitePushPayload;

async function anAlle(abos: SiteSubscriber[], bau: PushBau, deps: SitePushDeps): Promise<number> {
  let n = 0;
  const fertig = new Map<boolean, SitePushPayload>();
  for (const abo of abos) {
    const club = abo.team_id === CLUB;
    let payload = fertig.get(club);
    if (!payload) { payload = bau(club); fertig.set(club, payload); }
    try {
      if (await zustellen(abo, payload, deps)) n++;
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-site] Push fehlgeschlagen');
    }
  }
  return n;
}

/** Die gewählten Themen als Satzteil, so wie man sie im Push zu sehen bekommt. */
export function themenText(abo: Pick<SiteSubscriber, 'topics' | 'lead'>): string {
  const namen: string[] = [];
  if (abo.topics.includes('upcoming') && abo.lead !== 'aus') {
    namen.push(abo.lead === 'abend' ? 'Ankündigung am Vorabend' : `Ankündigung ${abo.lead === '3h' ? '3 Stunden' : '1 Stunde'} vorher`);
  }
  if (abo.topics.includes('halftime')) namen.push('Halbzeitstand');
  if (abo.topics.includes('result')) namen.push('Endstand');
  if (abo.topics.includes('change')) namen.push('Verlegungen und Absagen');
  if (abo.topics.includes('preview')) namen.push('Wochenvorschau am Donnerstag');
  return namen.length === 0 ? 'nichts' : namen.length === 1 ? namen[0]! : `${namen.slice(0, -1).join(', ')} und ${namen[namen.length - 1]}`;
}

/** Nach dem Einschalten eine Bestätigung — damit man sieht, dass es ankommt. */
export async function sendSiteWelcome(abo: SiteSubscriber, team: HandballTeamView | null, deps: SitePushDeps = DEFAULT_DEPS): Promise<boolean> {
  const club = abo.team_id === CLUB;
  return zustellen(abo, {
    title: `${club ? 'Wölfe im Revier' : team ? vereinsName(team.name) : 'Handball'}: Benachrichtigungen an`,
    body: `Du bekommst ${club ? 'zu allen Heimspielen' : 'ab jetzt'}: ${themenText(abo)}.`,
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

  const verein = listClubSubscribers();
  /** Wer zu diesem Thema (und diesem Spiel) Bescheid bekommt: Verein nur bei Heimspielen. */
  const fuer = (abos: SiteSubscriber[], thema: Topic, m: HandballMatchView) =>
    abos.filter(a => a.topics.includes(thema) && (a.team_id !== CLUB || m.is_home));

  for (const quelle of sicht.teams) {
    // Eine abgeschaltete Seite schickt auch nichts mehr: Die Glocke war ihr einziger Eingang.
    if (!siteConfig(quelle.team_id).enabled) continue;
    // Im Push heißt die Mannschaft wie oben auf der Seite: mit dem eingestellten Vereinsnamen.
    const team: HandballTeamView = { ...quelle, name: vereinsName(quelle.name) };
    const abos = [...listSiteSubscribers(team.team_id), ...verein];
    if (abos.length === 0) continue;
    const schluessel = (m: HandballMatchView, art: string) => `${team.team_id}:${m.match_id}:${art}`;

    // --- Verlegungen und Absagen ---
    for (const c of changesFor(team.team_id)) {
      const key = `${team.team_id}:${c.match_id}:change:${c.change_id}`;
      if (schonGeschickt(key)) continue;
      merke(key);
      if (jetzt - Date.parse(c.detected_at) > CHANGE_MAX_AGE_MS) continue;
      const m = team.matches.find(x => x.match_id === c.match_id);
      if (!m) continue;
      const text = textAenderung(team, m, c);
      const n = await anAlle(fuer(abos, 'change', m), club => alsPush(text, { tag: `handball-${m.match_id}`, renotify: true, url: ziel(team, club) || './' }), deps);
      out.messages++; out.recipients += n;
    }

    for (const m of team.matches) {
      const start = Date.parse(m.starts_at);

      // --- Ankündigung — je Abonnent zu seiner Zeit ---
      if (m.status === 'scheduled' && start > jetzt) {
        const fertig = new Map<boolean, SitePushPayload>();
        let n = 0;
        for (const abo of fuer(abos, 'upcoming', m)) {
          const ab = ankuendigungFaelligAb(m.starts_at, abo.lead);
          if (ab === null || jetzt < ab) continue;
          const key = schluessel(m, `upcoming:${abo.id}`);
          if (schonGeschickt(key)) continue;
          merke(key);
          const club = abo.team_id === CLUB;
          let payload = fertig.get(club);
          if (!payload) {
            payload = alsPush(textAnkuendigung(team, m, now, null), { tag: `handball-${m.match_id}`, url: ziel(team, club) || './', image: ziel(team, club) + 'bild/spiel.png' });
            fertig.set(club, payload);
          }
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
        const text = textHalbzeit(team, m, { home: m.halftime_home, away: m.halftime_away });
        const n = await anAlle(fuer(abos, 'halftime', m), club => alsPush(text, { tag: `handball-${m.match_id}`, renotify: true, url: ziel(team, club) || './' }), deps);
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
        const bau: PushBau = club => alsPush(text, {
          tag: `handball-${m.match_id}`, renotify: true, url: ziel(team, club) || './',
          // Ein Sieg vibriert wie ein Torjubel, eine Niederlage einmal lang.
          vibrate: m.won === true ? [200, 100, 200, 100, 400] : m.won === false ? [400] : [150, 80, 150],
          image: mitStand ? `${ziel(team, club)}bild/endstand.png?match=${encodeURIComponent(m.match_id)}` : undefined,
        });
        const n = await anAlle(fuer(abos, 'result', m), bau, deps);
        out.messages++; out.recipients += n;
      }
    }
  }

  await wochenvorschau(sicht.teams, verein, now, deps, out);
  return out;
}

/** Wohin ein Tipp auf den Push führt, vom Worker aus gesehen: der Worker der Mannschaft liegt in ihrem Ordner, der des Vereins an der Wurzel. */
function ziel(team: HandballTeamView, club: boolean): string {
  return club ? `${encodeURIComponent(team.team_id)}/` : '';
}

const BERLIN_TAG = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin', year: 'numeric', month: '2-digit', day: '2-digit' });
const BERLIN_WOCHENTAG = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Berlin', weekday: 'short' });
const BERLIN_STUNDE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Berlin', hour: '2-digit', hour12: false });

/** Donnerstag ab 17 Uhr bis Freitag 12 Uhr (Berliner Zeit) — dann ist die Vorschau fällig. */
export function istVorschauFenster(now: Date): boolean {
  const tag = BERLIN_WOCHENTAG.format(now);
  const stunde = Number(BERLIN_STUNDE.format(now)) % 24;
  return (tag === 'Thu' && stunde >= 17) || (tag === 'Fri' && stunde < 12);
}

/**
 * „Dieses Wochenende: 4 Heimspiele“ — eine Zahl, bewusst ohne Halle, denn der
 * Verein spielt an mehreren Orten. Nur an die Vereinsanmeldungen mit dem Thema
 * `preview`, einmal je Wochenende und Abonnent; ohne Heimspiel kein Push.
 */
async function wochenvorschau(teams: HandballTeamView[], verein: SiteSubscriber[], now: Date, deps: SitePushDeps, out: SitePushResult): Promise<void> {
  if (!istVorschauFenster(now)) return;
  const empfaenger = verein.filter(a => a.topics.includes('preview'));
  if (empfaenger.length === 0) return;
  const we = naechstesWochenende(now);
  const tage = [we.fr, we.sa, we.so];
  const proTag = [0, 0, 0];
  const sehen = new Set<string>();
  for (const t of teams) {
    if (!siteConfig(t.team_id).enabled) continue;
    for (const m of t.matches) {
      if (!m.is_home || m.status === 'cancelled' || m.status === 'postponed') continue;
      const i = tage.indexOf(BERLIN_TAG.format(new Date(m.starts_at)));
      if (i < 0 || sehen.has(`${t.team_id}:${m.match_id}`)) continue;
      sehen.add(`${t.team_id}:${m.match_id}`);
      proTag[i]!++;
    }
  }
  const summe = proTag[0]! + proTag[1]! + proTag[2]!;
  if (summe === 0) return;
  const tagesteile = [['Freitag', proTag[0]!], ['Samstag', proTag[1]!], ['Sonntag', proTag[2]!]]
    .filter(([, n]) => (n as number) > 0).map(([name, n]) => `${name} ${n}`).join(' · ');
  const payload: SitePushPayload = {
    title: `Dieses Wochenende: ${summe} ${summe === 1 ? 'Heimspiel' : 'Heimspiele'}`,
    body: tagesteile, tag: 'handball-wochenende', url: './',
  };
  let n = 0;
  for (const abo of empfaenger) {
    const key = `preview:${we.fr}:${abo.id}`;
    if (schonGeschickt(key)) continue;
    merke(key);
    try {
      if (await zustellen(abo, payload, deps)) n++;
    } catch (err) {
      serviceLog.warn({ err: err instanceof Error ? err.message : String(err) }, '[handball-site] Wochenvorschau nicht zustellbar');
    }
  }
  if (n > 0) { out.messages++; out.recipients += n; }
}

/** Was die Seite zum Anmelden braucht — der öffentliche VAPID-Schlüssel, oder dass es keinen gibt. */
export function sitePushConfig(): { enabled: boolean; public_key: string | null } {
  const key = getVapidPublicKey();
  return { enabled: key !== null, public_key: key };
}
